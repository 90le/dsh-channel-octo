import { AsyncLocalStorage } from 'node:async_hooks'

// DSH has one driver per session. Keep other producers' messages in its
// durable inbox, but do not let this Octo request claim or steer with them.
// Restoring the native inbox makes those messages available to Web unchanged.
export class RunInbox {
  constructor(ctx, root, accepts) {
    this.ctx = ctx; this.root = root; this.accepts = accepts
    this.entries = new Map(); this.allowed = new Map(); this.seen = new Map(); this.released = false
    this.execution = new AsyncLocalStorage()
    try {
      this.attach(root)
      for (const agent of ctx.agents.list?.() ?? []) if (this.belongs(agent)) this.attach(agent)
      this.off = ctx.on('agent/created', ({ agent }) => {
        if (this.belongs(agent)) this.attach(agent)
      }, { global: true })
    } catch (error) { this.release(false); throw error }
  }
  belongs(agent) {
    const visited = new Set()
    for (let current = agent; current && !visited.has(current.id);) {
      if (current === this.root) return true
      visited.add(current.id)
      const parent = this.ctx.agents.get(current.session?.header?.parentSession)
      if (this.ctx.agents.isOwnedBy && (!parent || !this.ctx.agents.isOwnedBy(current.id, parent))) return false
      current = parent
    }
    return false
  }
  admit(agent, message) {
    if (!this.entries.has(agent)) return
    const key = agent.id + '\0' + message.id
    const version = JSON.stringify(message)
    if (!this.seen.has(key) && this.accepts(agent, message)) this.allowed.set(key, version)
    this.seen.set(key, version)
  }
  admitted(agent, message) { return this.allowed.get(agent.id + '\0' + message.id) === JSON.stringify(message) }
  attach(agent) {
    if (this.entries.has(agent)) return
    const inbox = agent.inbox, wake = agent.wakeDriver, send = agent.send, kick = agent.kick
    // Unknown host implementations retain the existing conservative
    // mixed-turn detector instead of installing a partial interception.
    if (typeof inbox?.mutate !== 'function' || typeof agent.dispatch?.emit !== 'function'
      || typeof wake !== 'function' || typeof kick !== 'function') return
    if (agent !== this.root && inbox.hasPending) throw new Error('session_busy')
    const allowed = message => this.admitted(agent, message)
    const pending = target => inbox[target].filter(allowed)
    const proxy = new Proxy(inbox, { get: (target, name) => {
      // API/UI readers must see the actual queue (including RPC retry IDs and
      // editable pending messages). Only this agent's driver sees the filter.
      if (name === 'nextStep' || name === 'nextTurn') return this.execution.getStore() === agent ? pending(name) : inbox[name]
      if (name === 'hasPending') return this.execution.getStore() === agent
        ? pending('nextStep').length > 0 || pending('nextTurn').length > 0 : inbox.hasPending
      if (name === 'claim') return (target, turn) => {
        const chosen = [...pending('nextStep'), ...(target === 'next-turn' ? pending('nextTurn').slice(0, 1) : [])]
        for (const message of chosen) {
          const location = inbox.locate(message.id)
          if (location) inbox.mutate(location.target, location.index, 1, [], false)
        }
        for (const message of chosen) agent.dispatch.emit('agent/inbox/claimed', { message, turn })
        return chosen
      }
      const value = Reflect.get(target, name, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const execution = this.execution
    const guardedKick = function (...args) { return execution.run(agent, () => kick.apply(this, args)) }
    const guardedWake = function (...args) {
      if (pending('nextStep').length || pending('nextTurn').length) return wake.apply(this, args)
    }
    const guardedSend = function (message, ...args) {
      // Managed children can be disposed by their native parent as soon as
      // their task settles. Never acknowledge an external prompt into a hidden
      // child queue that the host could subsequently clear during disposal.
      if (agent !== thisGate.root && !thisGate.accepts(agent, message)) {
        throw new Error('此子智能体正在执行 Octo 任务。请在主对话发送消息，或等待子任务结束后重试。')
      }
      return send.call(this, message, ...args)
    }
    const thisGate = this
    this.entries.set(agent, { inbox, proxy, wake, guardedWake, send, guardedSend, kick, guardedKick })
    agent.inbox = proxy; agent.wakeDriver = guardedWake
    agent.kick = guardedKick
    if (typeof send === 'function') agent.send = guardedSend
  }
  get deferred() {
    return [...this.entries].some(([agent, { inbox }]) =>
      [...inbox.nextStep, ...inbox.nextTurn].some(message => !this.admitted(agent, message)))
  }
  release(wake = true) {
    if (this.released) return
    this.released = true; this.off?.()
    // Restore the whole family before waking any member: a child can send
    // its parent a result synchronously during startup.
    for (const [agent, entry] of this.entries) {
      if (agent.inbox === entry.proxy) agent.inbox = entry.inbox
      if (agent.wakeDriver === entry.guardedWake) agent.wakeDriver = entry.wake
      if (agent.send === entry.guardedSend) agent.send = entry.send
      if (agent.kick === entry.guardedKick) agent.kick = entry.kick
    }
    for (const [agent, { inbox }] of this.entries) {
      if (wake && inbox.hasPending && this.ctx.agents.get?.(agent.id) === agent) agent.wakeDriver()
    }
    this.execution.disable(); this.entries.clear(); this.allowed.clear(); this.seen.clear()
  }
}
