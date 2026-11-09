import { randomUUID } from 'node:crypto'
import { ruleContext } from './rules.js'

const preset = 'octo-text'
const denial = 'Octo IM sessions cannot execute tools'
const classified = new Set(['session_preset_conflict', 'session_busy', 'prompt_discarded',
  'missing_scoped_tool_controls', 'missing_scoped_rule_context', 'shared_turn_not_forwarded', 'no_confirmed_final_text'])

function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export class DshHost {
  #borrowed = new WeakMap()
  constructor(ctx, cwd, timeoutMs) {
    Object.assign(this, { ctx, cwd, timeoutMs })
  }

  async run(session, text, onCreated, lifetime, rules, onStage = () => {}, timeoutMs = this.timeoutMs) {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)])
    signal.throwIfAborted()
    const ctx = this.ctx
    const selected = ctx.agentDefaultModel.currentSelection()
    if (!selected?.provider || !selected?.model) throw new Error('missing_host_model')
    const agentOptions = { provider: selected.provider, model: selected.model }
    const controls = (scoped, cleanup) => {
      const tools = scoped.get('tools')
      if (!tools?.restrict || !tools?.guard) throw new Error('missing_scoped_tool_controls')
      cleanup.push(tools.restrict({ allow: [] }))
      cleanup.push(tools.guard(() => denial))
      if (rules) {
        const prompt = scoped.get('systemPrompt')
        if (typeof prompt?.context !== 'function') throw new Error('missing_scoped_rule_context')
        // DSH projects runtime facts into a user-role snapshot, not the system role.
        cleanup.push(prompt.context({
          name: 'dsh-channel-octo.channel-rules',
          order: 50, required: true, interpolate: false, text: ruleContext(rules),
        }))
      }
    }
    const setup = async (scoped) => {
      await ctx.agentPresets.mount(scoped, preset)
      controls(scoped, []) // Automatically released with the owned agent scope.
    }
    const find = () => ctx.agents.get?.(session.session_id)
    let agent = session.created ? find() : undefined
    let handle, borrowed
    let failure = 'session_open_failed'
    const cleanup = []
    const release = () => { for (const off of cleanup.reverse()) if (typeof off === 'function') off() }
    try {
      if (!agent) {
        try {
          handle = session.created
            ? await ctx.agents.resume({ resumeSessionId: session.session_id, setup, agentOptions, signal })
            : await ctx.agents.create({
              sessionId: session.session_id, meta: { cwd: this.cwd, agentPreset: preset }, setup, agentOptions, signal,
            })
          agent = handle.agent
        } catch (error) {
          // Web can acquire the same writer between get() and resume().
          if (!session.created || error?.name !== 'SessionAlreadyOwnedError' || !(agent = find())) throw error
        }
      }
      if (!handle) {
        if (agent.session?.header?.cwd !== this.cwd || ctx.agentPresets.composedPreset?.(agent.ctx) !== preset) {
          throw new Error('session_preset_conflict')
        }
        borrowed = agent
        const previous = this.#borrowed.get(agent)
        if (previous) await wait(previous, signal)
        await wait(agent.whenIdle(), signal)
        if (find() !== agent || agent.status !== 'idle' || agent.inbox?.hasPending) throw new Error('session_busy')
        controls(agent.ctx, cleanup)
        onStage('reused')
      }
      if (!session.created) {
        failure = 'session_flush_failed'
        await ctx.sessions.flush(agent.session)
        await onCreated()
      }
      signal.throwIfAborted()
      failure = 'session_turn_failed'
      const reply = await this.#turn(agent, text, signal, onStage)
      failure = 'session_flush_failed'
      await ctx.sessions.flush(agent.session)
      return reply
    } catch (error) {
      if (signal.aborted && !lifetime.aborted) throw new Error('session_timeout')
      if (classified.has(error?.message) || error?.name === 'SessionAlreadyOwnedError') throw error
      throw new Error(failure, { cause: error })
    } finally {
      if (handle) await handle.dispose()
      else if (borrowed && cleanup.length) {
        // A timed out request can still be in DSH's inbox. Keep its safety
        // controls until the Web-owned driver has settled; never cancel Web work.
        const settled = Promise.resolve().then(() => borrowed.whenIdle()).catch(() => {}).then(release)
        this.#borrowed.set(borrowed, settled)
        void settled.finally(() => {
          if (this.#borrowed.get(borrowed) === settled) this.#borrowed.delete(borrowed)
        }).catch(() => {})
      }
    }
  }

  async #turn(agent, text, signal, onStage) {
    const requestId = randomUUID()
    let claimedTurn, finalText = ''
    const otherTurns = new Set()
    const dispose = []
    try {
      return await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        dispose.push(() => signal.removeEventListener('abort', aborted))
        const matches = (payload) => payload?.agent?.id === agent.id && payload?.message?.id === requestId
        dispose.push(this.ctx.on('agent/inbox/claimed', (payload) => {
          if (payload?.agent?.id !== agent.id || !Number.isSafeInteger(payload.turn)) return
          if (matches(payload)) { claimedTurn = payload.turn; onStage('answering') }
          else if (payload?.message?.source?.kind !== 'runtime-context') otherTurns.add(payload.turn)
        }, { global: true }))
        dispose.push(this.ctx.on('agent/inbox/discarded', (payload) => {
          if (matches(payload)) reject(new Error('prompt_discarded'))
        }, { global: true }))
        dispose.push(this.ctx.on('session/event', (session, event) => {
          if (session?.id !== agent.id || claimedTurn === undefined || event?.data?.turn !== claimedTurn) return
          if (event.type === 'assistant/message' && !event.data.interrupted) {
            const parts = event.data.message?.content
            const text = Array.isArray(parts)
              ? parts.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('')
              : ''
            if (text.trim()) finalText = text
          } else if (event.type === 'turn/end') {
            if (otherTurns.has(claimedTurn)) reject(new Error('shared_turn_not_forwarded'))
            else if (event.data.reason?.kind === 'completed' && finalText.trim()) resolve(finalText)
            else reject(new Error('no_confirmed_final_text'))
          }
        }, { global: true }))
        signal.throwIfAborted()
        agent.followup({
          id: requestId, role: 'user', content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: requestId },
        })
      })
    } finally {
      for (const cleanup of dispose.reverse()) cleanup()
    }
  }
}
