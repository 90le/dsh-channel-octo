import { AsyncLocalStorage } from 'node:async_hooks'

// Observe only work registered by this Octo request. Native job.wait() must not
// be used here: it suppresses the host's completion notification to the model.
export class RunContinuations {
  constructor(ctx, agent, active, owned, calls) {
    this.ctx = ctx; this.agent = agent; this.active = active
    this.children = new Set(); this.directChildren = new Set(); this.jobs = new Map(); this.waiters = new Set()
    this.owned = owned; this.calls = calls
    this.execution = new AsyncLocalStorage()
    this.admissions = new Map()
    // In 0.2.2rc1 tools/execute surrounds the actual body; pre-execute only
    // surrounds permission checks. Team send_message returns {sent:true}, so
    // capture the native inbox identity synchronously at admission instead.
    this.toolOff = ctx.on?.('tools/execute', (exec, next) => {
      const sender = exec?.agent
      const rootCall = sender === agent && (calls.has(exec.callId) || calls.has(exec.rootCallId))
      const childCall = this.children.has(sender?.id) && ctx.agents?.get?.(sender.id) === sender
      const admission = active() && (rootCall || childCall)
        ? { sender, name: exec.name, callId: exec.callId, rootCallId: exec.rootCallId, token: exec.token, open: true } : undefined
      // Even an unrelated nested execution must mask an inherited sender.
      return this.execution.run(admission, async () => {
        try { return await next() }
        finally { if (admission) admission.open = false }
      })
    }, { global: true })
    const jobs = ctx.get?.('jobs')
    this.foreignJobs = (jobs?.list?.(agent.id) ?? []).some(job => job.owner === agent.id && ['running', 'stopping'].includes(job.status))
    this.childOff = agent.ctx?.on?.('subagent/start', info => {
      if (this.currentExecution() && typeof info?.id === 'string') {
        this.children.add(info.id); this.directChildren.add(info.id)
      }
    })
    this.off = jobs?.events?.subscribe?.({ owner: agent.id }, event => {
      if (event.job?.owner !== agent.id) return
      if (event.type === 'registered' && !this.jobs.has(event.job.id)) {
        if (this.currentExecution()?.sender === agent) this.jobs.set(event.job.id, true)
        else this.foreignJobs = true
      }
      if (this.jobs.has(event.job.id) && ['settled', 'removed'].includes(event.type)) {
        this.jobs.set(event.job.id, false)
        // Native reporters queue their follow-up in this same event dispatch.
        queueMicrotask(() => { for (const done of [...this.waiters]) done() })
      }
    })
  }
  observe(session, event) {
    if (!this.active()) return
    if (this.currentExecution() && (session?.id === this.agent.id || this.children.has(session?.id))
      && event?.type === 'subagent/catalog' && typeof event.data?.childId === 'string') {
      this.children.add(event.data.childId)
      if (session.id === this.agent.id) this.directChildren.add(event.data.childId)
    }
    if (session?.id === this.agent.id && event?.type === 'job/registered' && event.data?.owner === this.agent.id) {
      const call = event.data.toolCall
      if (this.calls.has(call?.callId) || this.calls.has(call?.rootCallId)
        || this.currentExecution()?.sender === this.agent) {
        this.jobs.set(event.data.jobId, true)
      }
    }
  }
  currentExecution() {
    const execution = this.execution.getStore()
    return this.active() && execution?.open ? execution : undefined
  }
  inserted({ agent, message } = {}) {
    const source = message?.source
    const admission = this.currentExecution()
    // Reusing an already-resident teammate does not publish another catalog or
    // start event. Time/sender alone cannot distinguish concurrent Web sends.
    if (admission?.name !== 'send_message' || source?.kind !== 'agent-message'
      || source.senderSessionId !== admission.sender.id || typeof message?.id !== 'string'
      || !message.id || typeof agent?.id !== 'string' || agent === this.agent
      || this.ctx.agents?.get?.(agent.id) !== agent) return
    const parent = agent.session?.header?.parentSession
    if (parent !== this.agent.id && !this.children.has(parent)) return
    this.admissions.set(message.id, { sender: admission.sender.id, receiver: agent.id,
      callId: admission.callId, rootCallId: admission.rootCallId, token: admission.token })
    this.children.add(agent.id)
    if (parent === this.agent.id) this.directChildren.add(agent.id)
  }
  accepts(message) {
    const source = message?.source
    if (source?.kind === 'tool-jobs') return this.jobs.size > 0 && !this.foreignJobs
    return ['agent-message', 'subagent-settled'].includes(source?.kind) && this.children.has(source.senderSessionId)
  }
  get pendingJobs() { return [...this.jobs.values()].some(Boolean) }
  waitForJobs(signal) {
    if (!this.pendingJobs) return Promise.resolve(false)
    return new Promise((resolve, reject) => {
      const finish = () => { this.waiters.delete(check); signal.removeEventListener('abort', abort) }
      const check = () => { if (!this.pendingJobs) { finish(); resolve(true) } }
      const abort = () => { finish(); reject(signal.reason) }
      this.waiters.add(check); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort(); else check()
    })
  }
  hasParkedReply() {
    if (this.agent.status !== 'idle') return false
    const pending = [...this.agent.inbox?.nextTurn ?? [], ...this.agent.inbox?.nextStep ?? []]
    // Respect native quiet-delivery and wake budgets. A parked reply is not a
    // completed request; do not force-followup it or forward the earlier preamble.
    return pending.some(message => this.accepts(message))
  }
  stop() {
    const registry = this.ctx.get?.('jobs')
    for (const [id, active] of this.jobs) if (active) {
      try { registry?.kill?.(id, this.agent.id, 'Octo task stopped') } catch {}
    }
  }
  dispose() {
    this.off?.(); this.childOff?.(); this.toolOff?.()
    this.execution.disable(); this.admissions.clear(); this.waiters.clear()
  }
}
