import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DshHost } from '../src/dsh.js'
import { OCTO_STOP } from '../src/im-controls.js'
import { setImmediate as tick } from 'node:timers/promises'

function fakeHost({ toolGuard = true, reason = 'completed', onPrompt } = {}) {
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
        if (onPrompt) return onPrompt({ agent: this, message, emit, events })
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

// Mirror native dispatch: publish the call before tools/execute, then publish
// its result after the awaited body (and its lifecycle events) has completed.
async function dispatchTool({ agent, emit, events }, name, callId, body) {
  emit(agent.id, 'tool/call', { turn: 1, callId, name, arguments: '{}' })
  const exec = { agent, name, callId, rootCallId: callId, token: Symbol(callId) }
  const next = events.listeners('tools/execute').reduceRight((next, hook) => () => hook(exec, next), async () => body())
  await next()
  emit(agent.id, 'tool/result', { turn: 1, message: { toolCallId: callId } })
}

for (const api of ['waitForChildren', 'waitForTreeWork']) {
  test(`joins ${api}, two child callbacks and the final parent turn before delivery`, { timeout: 2000 }, async () => {
    let current, joined, release
    const gate = new Promise(resolve => { release = resolve })
    const trace = [], stages = []
    const f = fakeHost({ async onPrompt(args) {
      current = args
      args.agent.status = 'idle'; args.agent.whenIdle = async () => {}
      args.agent.session.seq = 1
      args.events.emit('agent/inbox/claimed', { agent: args.agent, message: args.message, turn: 1 })
      await dispatchTool(args, 'subagent', 'delegate', () => {
        for (const childId of ['child-a', 'child-b']) args.emit(args.agent.id, 'subagent/catalog', { childId })
      })
      args.emit(args.agent.id, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Waiting for children, not final' }] } })
      args.emit(args.agent.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    } })
    f.ctx.get = name => name === 'subagents' ? { [api]: async root => {
      assert.equal(root, current.agent)
      if (joined) return false
      joined = true; await gate; return true
    } } : undefined
    let resolved = false
    const result = new DshHost(f.ctx, '/fixture', 1500).run({ session_id: f.agentId, created: 0 }, 'delegate', () => {},
      new AbortController().signal, undefined, x => stages.push(x), 1500, false, { onTrace: x => trace.push(x) })
      .then(value => { resolved = true; return value })
    await tick()
    assert.equal(joined, true); assert.equal(resolved, false); assert.ok(!f.calls.includes('dispose'))
    const { agent, events, emit } = current
    for (const [turn, child] of [[2, 'child-b'], [3, 'child-a']]) {
      events.emit('agent/inbox/claimed', { agent, turn, message: { id: 'notice-' + turn,
        source: { kind: turn === 2 ? 'agent-message' : 'subagent-settled', senderSessionId: child } } })
      emit(agent.id, 'tool/call', { turn, callId: 'call-' + turn, name: 'read', arguments: '{}' })
      emit(agent.id, 'tool/result', { turn, message: { toolCallId: 'call-' + turn } })
      emit(agent.id, 'assistant/message', { turn, message: { content: [{ type: 'text', text: turn === 3 ? 'Final combined result' : 'First child received' }] } })
      agent.session.seq++
      emit(agent.id, 'turn/end', { turn, reason: { kind: 'completed' } })
      await tick(); assert.equal(resolved, false)
    }
    release()
    assert.equal(await result, 'Final combined result')
    assert.equal(trace.filter(x => x.kind === 'tool-start').length, 3)
    assert.ok(stages.includes('background'))
    assert.equal(f.calls.filter(x => x === 'dispose').length, 1)
    assert.equal(f.events.eventNames().length, 0)
  })
}

test('an unrelated agent notice cannot become an Octo continuation', { timeout: 2000 }, async () => {
  let current, release
  const gate = new Promise(resolve => { release = resolve })
  const f = fakeHost({ async onPrompt(args) {
    current = args
    args.events.emit('agent/inbox/claimed', { agent: args.agent, message: args.message, turn: 1 })
    await dispatchTool(args, 'subagent', 'delegate', () => args.emit(args.agent.id, 'subagent/catalog', { childId: 'owned-child' }))
    args.emit(args.agent.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  } })
  let once = false
  f.ctx.get = () => ({ waitForChildren: async () => { if (once) return false; once = true; await gate; return true } })
  const result = new DshHost(f.ctx, '/fixture', 1000).run({ session_id: f.agentId, created: 0 }, 'delegate', () => {}, new AbortController().signal)
  const rejected = assert.rejects(result, /shared_turn_not_forwarded/)
  await tick()
  const { agent, events, emit } = current
  events.emit('agent/inbox/claimed', { agent, turn: 2, message: { id: 'foreign', source: { kind: 'agent-message', senderSessionId: 'other-agent' } } })
  emit(agent.id, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'PRIVATE OTHER TASK' }] } })
  emit(agent.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  release(); await rejected
  assert.equal(f.events.eventNames().length, 0)
})

test('stop while children run cancels the managed tree and never delivers a late answer', { timeout: 2000 }, async () => {
  let release, drained = 0, cancelled = 0
  const gate = new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const f = fakeHost({ async onPrompt(args) {
    const { agent, events, message, emit } = args
    agent.cancel = () => { cancelled++ }
    events.emit('agent/inbox/claimed', { agent, message, turn: 1 })
    await dispatchTool(args, 'subagent', 'delegate', () => emit(agent.id, 'subagent/catalog', { childId: 'child' }))
    emit(agent.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  } })
  f.ctx.get = () => ({ waitForChildren: () => gate, drainDescendants: async () => { drained++; release(false) } })
  const result = new DshHost(f.ctx, '/fixture', 1000).run({ session_id: f.agentId, created: 0 }, 'delegate', () => {}, controller.signal)
  const rejected = assert.rejects(result, error => error === OCTO_STOP)
  await tick(); controller.abort(OCTO_STOP); await rejected
  assert.equal(drained, 1); assert.equal(cancelled, 1)
  assert.equal(f.events.eventNames().length, 0)
})

test('background job completion is observed passively and its native wakeup supplies the final reply', { timeout: 2000 }, async () => {
  const jobs = new EventEmitter()
  let current
  const f = fakeHost({ async onPrompt(args) {
    current = args
    const { agent, emit, events, message } = args
    events.emit('agent/inbox/claimed', { agent, message, turn: 1 })
    await dispatchTool(args, 'bash', 'call', () => {
      emit(agent.id, 'job/registered', { jobId: 'job', owner: agent.id, toolCall: { callId: 'call' } })
      jobs.emit('event', { type: 'registered', job: { id: 'job', owner: agent.id } })
    })
    emit(agent.id, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Background started' }] } })
    emit(agent.id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  } })
  f.ctx.get = name => name === 'jobs' ? { list: () => [],
    events: { subscribe(_filter, fn) { jobs.on('event', fn); return () => jobs.off('event', fn) } },
    wait() { assert.fail('do not consume native job wakeup') }, read() { assert.fail('do not consume job output') } } : undefined
  let done = false
  const reply = new DshHost(f.ctx, '/fixture', 1000).run({ session_id: f.agentId, created: 0 }, 'job', () => {}, new AbortController().signal)
    .then(value => { done = true; return value })
  await tick(); assert.equal(done, false)
  const { agent, emit, events } = current
  jobs.emit('event', { type: 'settled', job: { id: 'job', owner: agent.id } })
  events.emit('agent/inbox/claimed', { agent, turn: 2, message: { id: 'job-notice', source: { kind: 'tool-jobs' } } })
  emit(agent.id, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Actual background result' }] } })
  emit(agent.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(await reply, 'Actual background result')
  assert.equal(jobs.eventNames().length, 0)
})

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

test('progress is scoped to the claimed turn, preserves final text and clears call metadata between runs', async () => {
  let runNumber = 0
  const trace = []
  const final = 'Final **answer** [link](https://example.test)'
  const { ctx, agentId, events } = fakeHost({ onPrompt({ agent, message, emit, events }) {
    runNumber++
    const send = (type, data = {}, turn = 2, id = agent.id) => emit(id, type, { turn, step: 7, ...data })
    const tool = { callId: 'same-id', name: 'bash', arguments: JSON.stringify({ description: 'Check files', command: 'PRIVATE COMMAND' }) }
    const output = { message: { toolCallId: 'same-id', content: [{ type: 'text', text: 'PRIVATE OUTPUT\n[exit code: 17]' }] } }
    send('tool/call', tool) // Unclaimed.
    events.emit('agent/inbox/claimed', { agent, message, turn: 2 })
    send('tool/call', tool, 1)
    send('tool/call', tool, 2, 'other-session')
    send('tool/result', output) // Foreign/unclaimed calls must not populate the map.
    if (runNumber === 1) {
      send('step/start')
      send('assistant/message', { message: { content: [
        { type: 'text', text: 'Checking now.' }, { type: 'reasoning', text: 'PRIVATE REASONING' },
        { type: 'tool-call', arguments: 'PRIVATE ARGS' },
      ] } })
      send('assistant/message', { interrupted: true, message: { content: [{ type: 'text', text: 'PRIVATE INTERRUPTED' }] } })
      send('tool/call', tool)
      send('tool/result', output, 1)
      send('tool/result', output, 2, 'other-session')
      send('tool/result', output)
      send('step/end')
    }
    send('assistant/message', { message: { content: [{ type: 'text', text: final }] } })
    send('turn/end', { reason: { kind: 'completed' } })
    send('tool/call', { ...tool, callId: 'after-end' })
    send('assistant/message', { message: { content: [{ type: 'text', text: 'PRIVATE LATE' }] } })
  } })
  const host = new DshHost(ctx, '/fixture', 1000)
  const run = () => host.run({ session_id: agentId, created: runNumber > 0 }, 'hello', () => {}, new AbortController().signal,
    undefined, undefined, 1000, false, { onTrace: item => trace.push(item) })
  assert.equal(await run(), final)
  assert.deepEqual(trace.slice(0, 5), [
    { kind: 'step', step: 7 }, { kind: 'note', text: 'Checking now.' },
    { kind: 'tool-start', id: 'same-id', name: 'bash', title: 'Check files' },
    { kind: 'tool-end', id: 'same-id', failed: true, summary: '退出码：17' }, { kind: 'step-end', step: 7 },
  ])
  assert.equal(trace.length, 6)
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/)
  trace.length = 0
  assert.equal(await run(), final)
  assert.equal(trace.length, 1)
  assert.equal(trace[0].kind, 'note')
  assert.equal(events.eventNames().length, 0)
})

test('mixed turns suppress progress, and a throwing presentation observer cannot alter the final answer', async () => {
  for (const mixed of [true, false]) {
    const trace = []
    const { ctx, agentId } = fakeHost({ onPrompt({ agent, message, emit, events }) {
      events.emit('agent/inbox/claimed', { agent, message, turn: 2 })
      if (mixed) events.emit('agent/inbox/claimed', { agent, message: { id: 'foreign' }, turn: 2 })
      emit(agent.id, 'step/start', { turn: 2, step: 1 })
      emit(agent.id, 'tool/call', { turn: 2, callId: 'mixed', name: 'read', arguments: '{}' })
      emit(agent.id, 'tool/result', { turn: 2, message: { toolCallId: 'mixed' } })
      emit(agent.id, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'answer' }] } })
      emit(agent.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    } })
    const response = new DshHost(ctx, '/fixture', 1000).run({ session_id: agentId, created: 0 }, 'hello', () => {},
      new AbortController().signal, undefined, undefined, 1000, false,
      { onTrace(item) { trace.push(item); throw new Error('renderer failed') } })
    if (mixed) { await assert.rejects(response, /shared_turn_not_forwarded/); assert.deepEqual(trace, []) }
    else { assert.equal(await response, 'answer'); assert.equal(trace.length, 4) }
  }
})

test('aborted turns suppress late progress and cannot lend call metadata to a later run', async () => {
  const controller = new AbortController(), trace = []
  let first = true
  const { ctx, agentId, events } = fakeHost({ onPrompt({ agent, message, emit, events }) {
    events.emit('agent/inbox/claimed', { agent, message, turn: 2 })
    if (first) {
      emit(agent.id, 'tool/call', { turn: 2, callId: 'unfinished', name: 'bash', arguments: '{}' })
      controller.abort(OCTO_STOP)
      first = false
    }
    emit(agent.id, 'tool/result', { turn: 2, message: { toolCallId: 'unfinished',
      content: [{ type: 'text', text: 'PRIVATE\n[exit code: 13]' }] } })
    emit(agent.id, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'answer' }] } })
    emit(agent.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  } })
  const host = new DshHost(ctx, '/fixture', 1000)
  const run = signal => host.run({ session_id: agentId, created: 0 }, 'hello', () => {}, signal,
    undefined, undefined, 1000, false, { onTrace: item => trace.push(item) })
  await assert.rejects(run(controller.signal), error => error === OCTO_STOP)
  assert.deepEqual(trace, [{ kind: 'tool-start', id: 'unfinished', name: 'bash' }])
  trace.length = 0
  assert.equal(await run(new AbortController().signal), 'answer')
  assert.deepEqual(trace, [{ kind: 'note', text: 'answer' }])
  assert.equal(events.eventNames().length, 0)
})

test('host traces native step zero, redacts Octo tokens and emits Chinese failure diagnoses', async () => {
  const trace = []
  const { ctx, agentId } = fakeHost({ onPrompt({ agent, message, emit, events }) {
    events.emit('agent/inbox/claimed', { agent, message, turn: 0 })
    const send = (type, data = {}) => emit(agent.id, type, { turn: 0, step: 0, ...data })
    send('step/start')
    send('tool/call', { callId: 'read-1', name: 'read', arguments: JSON.stringify({ path: '/root/private/a.md' }) })
    send('tool/result', { message: { toolCallId: 'read-1', content: [{ type: 'text', text: 'PRIVATE CONTENT' }] },
      error: { code: 'permission_denied', reason: 'PRIVATE REASON bf_secret app_secret' } })
    send('tool/call', { callId: 'exec-1', name: 'exec', arguments: JSON.stringify({ description: '检查 bf_secret app_secret', command: 'PRIVATE COMMAND' }) })
    send('tool/result', { message: { toolCallId: 'exec-1' }, error: {} })
    send('assistant/message', { message: { content: [{ type: 'text', text: '公开说明 bf_secret app_secret' }] } })
    send('step/end')
    send('turn/end', { reason: { kind: 'completed' } })
  } })
  const final = await new DshHost(ctx, '/fixture', 1000).run({ session_id: agentId, created: 0 }, 'hello', () => {},
    new AbortController().signal, undefined, undefined, 1000, false, { onTrace: item => trace.push(item) })
  // Progress filtering must not rewrite the existing final-forwarding path.
  assert.equal(final, '公开说明 bf_secret app_secret')
  assert.deepEqual(trace[0], { kind: 'step', step: 0 })
  assert.equal(trace[1].title, '读取文件 · a.md')
  assert.deepEqual(trace[2], { kind: 'tool-end', id: 'read-1', failed: true, summary: '权限不足' })
  assert.deepEqual(trace[4], { kind: 'tool-end', id: 'exec-1', failed: true, summary: '未提供可识别的错误原因' })
  assert.equal(trace[5].kind, 'note')
  assert.deepEqual(trace[6], { kind: 'step-end', step: 0 })
  assert.doesNotMatch(JSON.stringify(trace), /bf_secret|app_secret|PRIVATE|\/root/)
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

test('native stop cancels an exclusive turn without clearing unrelated Web input', async t => {
  for (const mode of ['owned', 'exclusive borrowed', 'mixed borrowed', 'unclaimed borrowed']) await t.test(mode, async () => {
    const { ctx, events, agentId, calls } = fakeHost()
    const controller = new AbortController(), ready = Promise.withResolvers()
    const pending = new Set(['web-prompt']), cancellations = []
    const agent = {
      id: agentId, status: 'idle', session: { id: agentId, header: { cwd: '/fixture' } },
      ctx: { get: name => name === 'tools' ? { restrict() { return () => {} }, guard() { return () => {} } } : null },
      inbox: { remove(id) { pending.delete(id) } },
      async whenIdle() {},
      followup(message) {
        this.status = 'running'
        if (mode === 'unclaimed borrowed') pending.add(message.id)
        else {
          events.emit('agent/inbox/claimed', { agent, message, turn: 1 })
          if (mode === 'mixed borrowed') events.emit('agent/inbox/claimed', { agent, message: { id: 'web-claimed' }, turn: 1 })
        }
        ready.resolve()
      },
      cancel(...args) { cancellations.push(args) },
    }
    if (mode === 'owned') ctx.agents.create = async ({ setup }) => {
      await setup(agent.ctx, agent)
      return { agent, async dispose() { calls.push('dispose') } }
    }
    else {
      ctx.agents.get = () => agent
      ctx.agentPresets.composedPreset = () => 'octo-text'
    }
    const run = new DshHost(ctx, '/fixture', 1000).run({ session_id: agentId, created: mode !== 'owned' },
      'stop target', () => {}, controller.signal)
    await ready.promise
    controller.abort(OCTO_STOP)
    await assert.rejects(run, error => error === OCTO_STOP)
    assert.deepEqual(cancellations, ['owned', 'exclusive borrowed'].includes(mode)
      ? [[{ kind: 'user' }, { keepInbox: true }]] : [])
    assert.deepEqual([...pending], ['web-prompt'])
    assert.equal(calls.includes('dispose'), mode === 'owned')
  })
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
