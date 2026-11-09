import { randomUUID } from 'node:crypto'

const preset = 'octo-text'
const denial = 'Octo direct messages cannot execute tools'

export class DshHost {
  constructor(ctx, cwd, timeoutMs) {
    Object.assign(this, { ctx, cwd, timeoutMs })
  }

  async run(session, text, onCreated, lifetime) {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.timeoutMs)])
    signal.throwIfAborted()
    const ctx = this.ctx
    const selected = ctx.agentDefaultModel.currentSelection()
    if (!selected?.provider || !selected?.model) throw new Error('missing_host_model')
    const agentOptions = { provider: selected.provider, model: selected.model }
    const setup = async (scoped) => {
      await ctx.agentPresets.mount(scoped, preset)
      const tools = scoped.get('tools')
      if (!tools?.restrict || !tools?.guard) throw new Error('missing_scoped_tool_controls')
      tools.restrict({ allow: [] })
      tools.guard(() => denial)
    }
    const handle = session.created
      ? await ctx.agents.resume({ resumeSessionId: session.session_id, setup, agentOptions, signal })
      : await ctx.agents.create({
        sessionId: session.session_id, meta: { cwd: this.cwd, agentPreset: preset }, setup, agentOptions, signal,
      })
    try {
      const agent = handle.agent
      if (!session.created) {
        await ctx.sessions.flush(agent.session)
        onCreated()
      }
      signal.throwIfAborted()
      const reply = await this.#turn(agent, text, signal)
      await ctx.sessions.flush(agent.session)
      return reply
    } finally {
      await handle.dispose()
    }
  }

  async #turn(agent, text, signal) {
    const requestId = randomUUID()
    let claimedTurn, finalText = ''
    const dispose = []
    try {
      return await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        dispose.push(() => signal.removeEventListener('abort', aborted))
        const matches = (payload) => payload?.agent?.id === agent.id && payload?.message?.id === requestId
        dispose.push(this.ctx.on('agent/inbox/claimed', (payload) => {
          if (matches(payload) && Number.isSafeInteger(payload.turn)) claimedTurn = payload.turn
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
            if (event.data.reason?.kind === 'completed' && finalText.trim()) resolve(finalText)
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
