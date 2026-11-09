import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DshHost } from '../src/dsh.js'

function fakeHost({ toolGuard = true, reason = 'completed' } = {}) {
  const events = new EventEmitter()
  const calls = []
  const agentId = 'session-unique'
  const handle = {
    agent: {
      id: agentId,
      session: { id: agentId },
      followup(message) {
        calls.push(['prompt', message.content[0].text])
        const emit = (id, type, data) => events.emit('session/event', { id }, { type, data })
        const content = (text, turn = 2) => ({ turn, message: { content: [{ type: 'text', text }] } })
        events.emit('agent/inbox/claimed', { agent: this, message: { id: 'different' }, turn: 1 })
        emit(agentId, 'assistant/message', content('unrelated', 1))
        events.emit('agent/inbox/claimed', { agent: this, message, turn: 2 })
        emit('different-session', 'assistant/message', content('do not leak'))
        emit(agentId, 'assistant/message', content('final answer'))
        emit(agentId, 'turn/end', { turn: 2, reason: { kind: reason } })
      },
    },
    async dispose() { calls.push('dispose') },
  }
  const tools = {
    restrict(restriction) { calls.push(['restrict', restriction]) },
    ...(toolGuard && { guard(fn) { calls.push(['guard', fn()]) } }),
  }
  const ctx = {
    on(name, listener) { events.on(name, listener); return () => events.off(name, listener) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agentPresets: { async mount(_scoped, preset) { calls.push(['mount', preset]) } },
    agents: Object.fromEntries(['create', 'resume'].map(operation => [operation, async (options) => {
      calls.push([operation, options.sessionId ?? options.resumeSessionId])
      await options.setup({ get: name => name === 'tools' ? tools : null })
      return handle
    }])),
    sessions: { async flush() { calls.push('flush') } },
  }
  return { ctx, calls, events, agentId }
}

test('DSH scopes tools and only forwards the result of the claimed turn', async () => {
  const { ctx, calls, events, agentId } = fakeHost()
  const host = new DshHost(ctx, '/fixture', 1000)
  const signal = new AbortController().signal
  const session = { session_id: agentId, created: 0 }
  assert.equal(await host.run(session, 'hello', () => calls.push('session stored'), signal), 'final answer')
  assert.deepEqual(calls, [
    ['create', agentId], ['mount', 'octo-text'], ['restrict', { allow: [] }],
    ['guard', 'Octo IM sessions cannot execute tools'], 'flush', 'session stored',
    ['prompt', 'hello'], 'flush', 'dispose',
  ])
  assert.equal(events.eventNames().length, 0)
  calls.length = 0
  await host.run({ ...session, created: 1 }, 'hello again', () => assert.fail('should resume'), signal)
  assert.deepEqual(calls[0], ['resume', agentId])
})

test('DSH fails closed when the tool guard is missing or the turn fails', async () => {
  for (const [options, reason] of [
    [{ toolGuard: false }, /missing_scoped_tool_controls/],
    [{ reason: 'aborted' }, /no_confirmed_final_text/],
  ]) {
    const { ctx, calls, agentId, events } = fakeHost(options)
    await assert.rejects(new DshHost(ctx, '/fixture', 1000).run(
      { session_id: agentId, created: 1 }, 'hello', () => {}, new AbortController().signal,
    ), reason)
    assert.equal(events.eventNames().length, 0)
    if (options.toolGuard === false) assert.equal(calls.some(call => call[0] === 'prompt'), false)
  }
})
