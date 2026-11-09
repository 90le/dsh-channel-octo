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
      await options.setup({ get: name => name === 'tools' ? tools : null }, handle.agent)
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

test('only a confirmed missing native session permits recovery without replaying a turn', async () => {
  const { ctx, agentId } = fakeHost()
  const host = new DshHost(ctx, '/fixture', 1000)
  const session = { session_id: agentId, created: 1 }
  for (const [name, expected] of [['SessionPersistenceNotFoundError', 'session_missing'],
    ['SessionPersistenceCorruptionError', 'session_open_failed'], ['Error', 'session_open_failed']]) {
    ctx.agents.resume = async () => { throw Object.assign(new Error('fixture'), { name, sessionId: agentId }) }
    await assert.rejects(host.run(session, 'hello', () => assert.fail('must not create'),
      new AbortController().signal), { message: expected })
  }
  ctx.agents.resume = async () => { throw Object.assign(new Error('fixture'),
    { name: 'SessionPersistenceNotFoundError', sessionId: 'unrelated' }) }
  await assert.rejects(host.run(session, 'hello', () => assert.fail('must not create'),
    new AbortController().signal), { message: 'session_open_failed' })
})

test('deferred continuation verifies both followed defaults and the loaded session model before prompting', async () => {
  const { ctx, agentId, calls } = fakeHost()
  const host = new DshHost(ctx, '/fixture', 1000), policy = host.modelProfile()
  const session = { session_id: agentId, created: 1 }, signal = new AbortController().signal
  const extras = { expectedModel: { policy, effective: policy } }
  ctx.agentDefaultModel.currentSelection = () => ({ provider: 'fixture', model: 'changed-default' })
  await assert.rejects(host.run(session, 'answer', () => {}, signal, null, () => {}, 1000, false, extras),
    { message: 'deferred_configuration_changed' })
  assert.equal(calls.length, 0)
  ctx.agentDefaultModel.currentSelection = () => ({ provider: 'fixture', model: 'fixture' })
  const resume = ctx.agents.resume
  ctx.agents.resume = async options => {
    const handle = await resume(options)
    handle.agent.model = { current: () => ({ provider: 'fixture', model: 'changed-session-model' }) }
    return handle
  }
  await assert.rejects(host.run(session, 'answer', () => {}, signal, null, () => {}, 1000, false, extras),
    { message: 'deferred_configuration_changed' })
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'prompt'), false)
  assert.ok(calls.includes('dispose'))
})

test('account model, reasoning and preset are applied, and group turns remain tool-free', async () => {
  const { ctx, calls, agentId } = fakeHost()
  const optionsSeen = []
  const create = ctx.agents.create
  ctx.agents.create = options => { optionsSeen.push(options.agentOptions); return create(options) }
  ctx.get = name => name === 'permissionPresets' ? { set: (_, mode) => calls.push(['permission', mode]) } : null
  const host = new DshHost(ctx, '/fixture', 1000, {
    provider: 'chosen-provider', model: 'chosen-model', reasoningEffort: 'high',
    agentPreset: 'standard', permission: 'workspace-write',
  })
  const signal = new AbortController().signal
  const run = allow => host.run({ session_id: agentId, created: 0 }, 'hello', () => {}, signal,
    undefined, undefined, 1000, allow)
  await run(true)
  assert.deepEqual(optionsSeen[0], { provider: 'chosen-provider', model: 'chosen-model', reasoningEffort: 'high' })
  assert.ok(calls.some(call => call[0] === 'mount' && call[1] === 'standard'))
  assert.ok(calls.some(call => call[0] === 'permission' && call[1] === 'workspace-write'))
  assert.ok(!calls.some(call => call[0] === 'restrict'))
  calls.length = 0
  await run(false)
  assert.ok(calls.some(call => call[0] === 'guard'))
  assert.ok(!calls.some(call => call[0] === 'permission'))
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

test('reuses a Web-owned Octo session with scoped safety and suppresses mixed-turn answers', async () => {
  const { ctx, calls, events, agentId } = fakeHost()
  const agent = {
    id: agentId, session: { id: agentId, header: { cwd: '/fixture' } }, status: 'idle',
    ctx: { get: () => ({
      restrict() { calls.push('restrict'); return () => calls.push('release restriction') },
      guard() { calls.push('guard'); return () => calls.push('release guard') },
    }) },
    async whenIdle() {},
    followup(message) {
      events.emit('agent/inbox/claimed', { agent: this, message, turn: 1 })
      if (message.content[0].text === 'mixed') {
        events.emit('agent/inbox/claimed', { agent: this, message: { id: 'web-prompt' }, turn: 1 })
      }
      events.emit('session/event', this.session, { type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text: 'reply' }] } } })
      events.emit('session/event', this.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    },
  }
  ctx.agents.get = () => agent
  ctx.agentPresets.composedPreset = () => 'octo-text'
  const host = new DshHost(ctx, '/fixture', 1000)
  const run = text => host.run({ session_id: agentId, created: 1 }, text,
    () => assert.fail('must reuse'), new AbortController().signal)
  assert.equal(await run('safe'), 'reply')
  await assert.rejects(run('mixed'), /shared_turn_not_forwarded/)
  assert.deepEqual(calls.slice(0, 5), ['restrict', 'guard', 'flush', 'release guard', 'release restriction'])
  assert.ok(!calls.includes('dispose'))
  ctx.agentPresets.composedPreset = () => 'default'
  await assert.rejects(run('safe'), /session_preset_conflict/)
})

test('steering joins only the claimed Octo-owned turn and replaces the earlier answer', async () => {
  const { ctx, events, agentId } = fakeHost()
  let started
  const ready = new Promise(resolve => { started = resolve })
  let offer, first, steered
  const agent = {
    id: agentId, status: 'running', session: { id: agentId },
    followup(message) {
      first = message
      events.emit('agent/inbox/claimed', { agent, message, turn: 2 })
      events.emit('session/event', agent.session, { type: 'assistant/message', data: {
        turn: 2, message: { content: [{ type: 'text', text: 'earlier answer' }] },
      } })
      started()
    },
    steer(message) { steered = message },
  }
  ctx.agents.create = async ({ setup }) => {
    await setup({ get: () => ({ restrict() {}, guard() {} }) }, agent)
    return { agent, async dispose() {} }
  }
  const host = new DshHost(ctx, '/fixture', 1000)
  const response = host.run({ session_id: agentId, created: 0 }, 'one', () => {}, new AbortController().signal,
    undefined, undefined, 1000, false, { onSteer(value) { offer = value } })
  await ready
  let reserved = false
  assert.equal(offer('two', () => { reserved = true }), true)
  assert.equal(reserved, true)
  assert.notEqual(steered.id, first.id)
  assert.equal(steered.content[0].text, 'two')
  events.emit('agent/inbox/claimed', { agent, message: steered, turn: 2 })
  events.emit('session/event', agent.session, { type: 'assistant/message', data: {
    turn: 2, message: { content: [{ type: 'text', text: 'new answer' }] },
  } })
  events.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(await response, 'new answer')
  assert.equal(offer, undefined)
})

test('a completed marker never forwards the last tool preamble without a final assistant answer', async () => {
  const { ctx, events, agentId } = fakeHost()
  const agent = {
    id: agentId, session: { id: agentId },
    followup(message) {
      events.emit('agent/inbox/claimed', { agent, message, turn: 3 })
      const event = (type, data = {}) => events.emit('session/event', agent.session, { type, data: { turn: 3, ...data } })
      event('assistant/message', { message: { content: [
        { type: 'text', text: 'I will write the file.' }, { type: 'tool-call', id: 'call-1' },
      ] } })
      event('tool/call', { callId: 'call-1', name: 'write' })
      event('tool/result', { message: { toolCallId: 'call-1', isError: true } })
      event('step/start')
      event('assistant/message', { message: { content: [{ type: 'reasoning' }] } })
      event('turn/end', { reason: { kind: 'completed' } })
    },
  }
  ctx.agents.create = async ({ setup }) => {
    await setup({ get: () => ({ restrict() {}, guard() {} }) }, agent)
    return { agent, async dispose() {} }
  }
  await assert.rejects(new DshHost(ctx, '/fixture', 1000).run(
    { session_id: agentId, created: 0 }, 'file', () => {}, new AbortController().signal,
  ), /no_confirmed_final_text/)
})
