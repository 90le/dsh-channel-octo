import { AsyncLocalStorage } from 'node:async_hooks'

// Observe only work registered by this Octo request. Native job.wait() must not
// be used here: it suppresses the host's completion notification to the model.
export class RunContinuations {
  constructor(ctx, agent, active, owned, calls) {
    this.ctx = ctx; this.agent = agent; this.active = active
    this.children = new Set(); this.directChildren = new Set(); this.jobs = new Map(); this.waiters = new Set()
    this.jobOwners = new Map(); this.foreignJobOwners = new Set()
    this.owned = owned; this.calls = calls
    this.execution = new AsyncLocalStorage()
    this.admissions = new Map()
    this.reawakened = new Set()
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
    this.off = jobs?.events?.subscribe?.({}, event => {
      const owner = event.job?.owner
      if (owner !== agent.id && !this.children.has(owner)) return
      if (event.type === 'registered' && !this.jobs.has(event.job.id)) {
        if (this.currentExecution()?.sender?.id === owner) {
          this.jobs.set(event.job.id, true); this.jobOwners.set(event.job.id, owner)
        } else { this.foreignJobOwners.add(owner); if (owner === agent.id) this.foreignJobs = true }
      }
      if (this.jobs.has(event.job.id) && ['settled', 'removed'].includes(event.type)) {
        this.jobs.set(event.job.id, false)
        // Native reporters queue their follow-up in this same event dispatch.
        queueMicrotask(() => { for (const done of [...this.waiters]) done() })
      }
    })
    this.statusOff = ctx.on?.('agent/status', ({ agent: child, status } = {}) => {
      if (!active() || status !== 'idle' || !this.children.has(child?.id)
        || !this.pendingFor(child.id) || typeof child.runMaintenance !== 'function') return
      // Keep a child alive while its own background jobs finish. Otherwise
      // native child settlement disposes its scope (and job notifications)
      // before a quiet completion can be consumed.
      try { void child.runMaintenance(signal => this.waitForJobs(signal, child.id)).catch(() => {}) } catch {}
    }, { global: true })
  }
  observe(session, event) {
    if (!this.active()) return
    if (this.currentExecution() && (session?.id === this.agent.id || this.children.has(session?.id))
      && event?.type === 'subagent/catalog' && typeof event.data?.childId === 'string') {
      this.children.add(event.data.childId)
      if (session.id === this.agent.id) this.directChildren.add(event.data.childId)
    }
    if ((session?.id === this.agent.id || this.children.has(session?.id))
      && event?.type === 'job/registered' && event.data?.owner === session.id) {
      const call = event.data.toolCall
      if (this.calls.has(call?.callId) || this.calls.has(call?.rootCallId)
        || this.currentExecution()?.sender?.id === session.id) {
        this.jobs.set(event.data.jobId, true)
        this.jobOwners.set(event.data.jobId, session.id)
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
    if (this.ctx.agents.isOwnedBy && !this.ctx.agents.isOwnedBy(agent.id, this.ctx.agents.get(parent))) return
    this.admissions.set(message.id, { sender: admission.sender.id, receiver: agent.id,
      callId: admission.callId, rootCallId: admission.rootCallId, token: admission.token })
    this.children.add(agent.id)
    if (parent === this.agent.id) this.directChildren.add(agent.id)
  }
  accepts(message, receiver = this.agent) {
    const source = message?.source
    if (source?.kind === 'tool-jobs') return !this.foreignJobOwners.has(receiver.id)
      && !(receiver === this.agent && this.foreignJobs)
      && [...this.jobs.keys()].some(id => (this.jobOwners.get(id) ?? this.agent.id) === receiver.id)
    return ['agent-message', 'subagent-settled'].includes(source?.kind) && this.children.has(source.senderSessionId)
  }
  get pendingJobs() { return [...this.jobs.values()].some(Boolean) }
  pendingFor(owner) { return [...this.jobs].some(([id, running]) => running && (this.jobOwners.get(id) ?? this.agent.id) === owner) }
  waitForJobs(signal, owner) {
    const pending = () => owner ? this.pendingFor(owner) : this.pendingJobs
    if (!pending()) return Promise.resolve(false)
    return new Promise((resolve, reject) => {
      const finish = () => { this.waiters.delete(check); signal.removeEventListener('abort', abort) }
      const check = () => { if (!pending()) { finish(); resolve(true) } }
      const abort = () => { finish(); reject(signal.reason) }
      this.waiters.add(check); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort(); else check()
    })
  }
  hasParkedReply() {
    if (this.agent.status !== 'idle') return false
    const pending = [...this.agent.inbox?.nextTurn ?? [], ...this.agent.inbox?.nextStep ?? []]
    return pending.some(message => this.accepts(message))
  }
  resumeParked() {
    if (!this.active()) return false
    let resumed = false
    for (const receiver of [this.agent, ...[...this.children].map(id => this.ctx.agents.get?.(id)).filter(Boolean)]) {
      if (receiver.status !== 'idle' || typeof receiver.wakeDriver !== 'function') continue
      const messages = [...receiver.inbox?.nextTurn ?? [], ...receiver.inbox?.nextStep ?? []]
        .filter(message => this.accepts(message, receiver))
      if (!messages.length || messages.every(message => this.reawakened.has(receiver.id + '\0' + message.id))) continue
      for (const message of messages) this.reawakened.add(receiver.id + '\0' + message.id)
      // Wake the existing durable notification, never the original tool call.
      receiver.wakeDriver(); resumed = true
    }
    return resumed
  }
  stop() {
    const registry = this.ctx.get?.('jobs')
    for (const [id, active] of this.jobs) if (active) {
      try { registry?.kill?.(id, this.jobOwners.get(id) ?? this.agent.id, 'Octo task stopped') } catch {}
    }
  }
  dispose() {
    this.off?.(); this.childOff?.(); this.toolOff?.(); this.statusOff?.()
    this.execution.disable(); this.admissions.clear(); this.waiters.clear()
    this.reawakened.clear()
  }
}
