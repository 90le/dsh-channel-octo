import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshHost } from '../src/dsh.js'
import { Worker } from '../src/worker.js'
import { formToolSpec } from '../src/form-tool.js'
import { APPROVAL_CHOICES } from '../src/approval.js'

const turn = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate, description = 'expected host state') {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await turn() }
  assert.fail(description)
}
const form = { title: '本轮表单', inputs: [{ id: 'note', kind: 'text', label: '说明', required: true }],
  actions: [{ id: 'submit', label: '提交' }] }
const ordinary = [{ id: 'ordinary', question: '请选择语言', options: [{ label: '中文' }, { label: 'English' }] }]

// Synthetic event transport models scoped/prepend waterfall dispatch and scope
// disposal. Actual DshHost, ApprovalAdapter, QuestionBridge and worker access /
// reconfiguration methods run unchanged. The callback binds the original job as
// worker.process does; this suite does not replace the production worker smoke.
// All card/profile responses and outbound messages are in memory, never sockets.
function fixture(t, { borrowed = false, autoClaim = true, timeoutMs = 10_000, forms = false, textOnly = false } = {}) {
  const listeners = [], guards = new Set(), definitions = new Map(), effects = new Set()
  const f = { borrowed, turn: 12, messages: [], stages: [], controls: [], questions: [], pending: [],
    metrics: { create: 0, resume: 0, dispose: 0, permission: 0, created: 0, timedReturn: 0 },
    access: true, calls: new Set(), lifetime: new AbortController(), ready: Promise.withResolvers() }
  const own = callback => {
    let live = true
    const off = () => { if (!live) return; live = false; effects.delete(off); callback() }
    effects.add(off); return off
  }
  const on = (owner, name, fn, options = {}) => {
    const row = { owner, name, fn, options }
    if (options.prepend) listeners.unshift(row); else listeners.push(row)
    const remove = () => { const i = listeners.indexOf(row); if (i >= 0) listeners.splice(i, 1) }
    return owner ? own(remove) : remove
  }
  const tools = {
    guard(fn) { guards.add(fn); return own(() => guards.delete(fn)) },
    restrict() { return own(() => {}) }, presentAs() { return own(() => {}) },
    register(definition) { definitions.set(definition.name, definition); return own(() => definitions.delete(definition.name)) },
  }
  f.scope = {
    on: (name, fn, options) => on(f.scope, name, fn, options),
    get: name => name === 'tools' ? tools : name === 'systemPrompt' ? { context: () => own(() => {}) } : undefined,
    effect(factory) { const cleanup = [...factory()]; return own(() => { for (const off of cleanup.reverse()) off() }) },
    dispose() {
      for (const row of [...listeners]) if (row.owner === f.scope && row.name === 'dispose') row.fn()
      for (const off of [...effects].reverse()) off()
    },
  }
  f.session = { id: 'approval-host-session', header: { cwd: '/fixture' } }
  f.idle = Promise.withResolvers()
  f.agent = { id: f.session.id, session: f.session, ctx: f.scope, status: 'idle', inbox: {},
    whenIdle: () => f.agent.status === 'idle' ? Promise.resolve() : f.idle.promise,
    followup(message) {
      f.agent.status = 'running'; f.idle = Promise.withResolvers(); f.prompt = message
      if (autoClaim) f.claim(message)
      f.ready.resolve()
    },
    steer(message) { f.claim(message) },
  }
  f.emit = (name, ...args) => {
    for (const row of [...listeners]) {
      if (row.name !== name || row.name === 'dispose') continue
      if (!row.owner || row.options.global || args[0]?.agent === f.agent) row.fn(...args)
    }
  }
  f.event = (type, data, session = f.session) => f.emit('session/event', session, { type, data })
  f.claim = (message = f.prompt, claimedTurn = f.turn, agent = f.agent) =>
    f.emit('agent/inbox/claimed', { agent, message, turn: claimedTurn })
  f.waterfall = async (name, request, fallback = () => 'not-octo') => {
    const chain = listeners.filter(row => row.name === name && (!row.owner || row.options.global || request.agent === f.agent))
    const invoke = index => index < chain.length ? chain[index].fn(request, () => invoke(index + 1)) : fallback()
    return invoke(0)
  }
  f.track = promise => { f.pending.push(promise); void promise.catch(() => {}); return promise }
  f.call = (id = 'call', args = { command: 'echo 本轮命令' }, name = 'shell', session = f.session, nativeTurn = f.turn) => {
    f.calls.add(id)
    f.event('tool/call', { turn: nativeTurn, step: 1, callId: id, name, arguments: JSON.stringify(args) }, session)
  }
  f.result = id => { f.event('tool/result', { turn: f.turn, message: { toolCallId: id } }); f.calls.delete(id) }
  f.approval = (id = 'call', extra = {}) => f.track(f.waterfall('approval/request', {
    agent: f.agent, toolName: 'shell', callId: id, signal: f.lifetime.signal, ...extra,
  }))
  f.nativeQuestion = (extra = {}) => f.track(f.waterfall('user-questions/request', {
    agent: f.agent, questions: ordinary, signal: f.lifetime.signal, ...extra,
  }))
  f.guard = () => [...guards].map(fn => fn({ name: 'shell', agent: f.agent })).find(value => value !== undefined)
  f.listenerCount = name => listeners.filter(row => !name || row.name === name).length
  f.guardCount = () => guards.size
  f.idleNow = () => { f.agent.status = 'idle'; f.idle.resolve() }
  f.finish = ({ keepBusy = false } = {}) => {
    for (const id of [...f.calls]) f.result(id)
    f.event('assistant/message', { turn: f.turn, message: { content: [{ type: 'text', text: '本轮完成' }] } })
    f.event('turn/end', { turn: f.turn, reason: { kind: 'completed' } })
    if (!keepBusy) f.idleNow()
  }
  const permissions = { current: () => 'workspace-write', set: () => { f.metrics.permission++ } }
  const handle = { agent: f.agent, async dispose() { f.metrics.dispose++; f.scope.dispose() } }
  const open = operation => async options => {
    f.metrics[operation]++
    await options.setup(f.scope, f.agent)
    return handle
  }
  f.ctx = {
    on: (name, fn, options) => on(null, name, fn, options),
    get: name => name === 'permissionPresets' ? permissions : name === 'userQuestions' ? {
      attachWait: () => ({ async *[Symbol.asyncIterator]() { try { yield {} } finally { f.metrics.timedReturn++ } } }),
    } : undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'synthetic' }) },
    agentPresets: { async mount() {}, composedPreset: () => 'standard' },
    agents: { create: open('create'), resume: open('resume'), get: () => borrowed ? f.agent : undefined },
    sessions: { async flush() {} },
  }
  f.host = new DshHost(f.ctx, '/fixture', timeoutMs, { agentPreset: 'standard', permission: textOnly ? 'text-only' : 'workspace-write' })
  f.config = { apiBase: 'https://approval-host.invalid/api', token: 'bf_fixture', botUid: 'bot', spaceId: 'space',
    ownerUid: 'alice', senderPolicy: 'allowlist', allowed: new Set(['alice']), toolScope: 'owner', toolPermission: 'workspace-write',
    fetchImpl: async () => Response.json({ enabled: false }),
  }
  f.job = { seq: 9, sender: 'alice', channel_type: 1, channel_id: 'alice', session_id: f.session.id }
  const api = { async send(...args) { f.messages.push(args) }, async allowsMessage(_config, _job, signal) { signal.throwIfAborted(); return f.access } }
  f.worker = new Worker({ api, store: {}, host: f.host, config: f.config, log() {} })
  f.bridge = f.worker.questions
  f.extras = {
    approval: { runId: String(f.job.seq), requester: f.job.sender },
    authorizeTools: () => f.worker.liveToolAllowed(f.job, f.config),
    onApprovalControl: revoke => { f.controls.push(revoke); f.worker.revokeApproval = revoke },
    onQuestion: async (questions, signal, scope) => {
      f.questions.push({ questions, signal, scope })
      const current = await f.worker.liveToolAccess(f.job, signal)
      const answer = await f.bridge.ask(questions, f.job, current, signal, () => {}, () => f.worker.liveToolAllowed(f.job, current))
      await f.worker.liveToolAccess(f.job, signal)
      return answer
    },
    ...(forms && { channelTools: { specs: [formToolSpec], waitNames: ['octo_form'], guidance: 'Synthetic form',
      execute: async (_name, args, signal) => {
        const current = await f.worker.liveToolAccess(f.job, signal)
        return f.bridge.form(args, f.job, current, signal, () => {}, () => f.worker.liveToolAllowed(f.job, current))
      },
    } }),
  }
  f.start = async (extras = {}) => {
    f.ready = Promise.withResolvers()
    f.run = f.track(f.host.run({ session_id: f.session.id, created: borrowed ? 1 : 0 }, 'Synthetic task',
      () => { f.metrics.created++ }, f.lifetime.signal, undefined, stage => f.stages.push(stage), timeoutMs, true, { ...f.extras, ...extras }))
    await f.ready.promise
    return f
  }
  f.form = () => f.track(definitions.get('octo_form').execute(structuredClone(form), { signal: f.lifetime.signal }))
  f.visible = () => until(() => f.bridge.current?.ready, 'QuestionBridge should expose the pending question')
  f.answer = text => {
    const current = f.bridge.match({ sender: 'alice', channelId: 'alice', channelType: 1 })
    assert.ok(current, 'only the original requester and route can answer')
    return f.bridge.text(current, text)
  }
  f.reconfigure = () => f.worker.reconfigure({ ...f.worker.config, allowed: new Set(['bob']) }, f.host)
  t.after(async () => {
    f.lifetime.abort(new Error('fixture cleanup'))
    f.idleNow(); f.scope.dispose()
    await Promise.allSettled(f.pending)
  })
  return f
}

for (const borrowed of [false, true]) for (const allow of [false, true]) {
  test(`${borrowed ? 'borrowed' : 'owned'} DshHost routes exact-session approval and ${allow ? 'allows once' : 'rejects'}`, { timeout: 3000 }, async t => {
    const f = await fixture(t, { borrowed }).start()
    assert.equal(f.guard(), undefined)
    f.call()
    const pending = f.approval()
    await f.visible()
    assert.match(f.bridge.current.question.detail, /echo 本轮命令/u)
    assert.deepEqual(f.questions[0].scope, { runId: '9', requester: 'alice', sessionId: f.session.id })
    assert.equal(f.bridge.match({ sender: 'bob', channelId: 'alice', channelType: 1 }), undefined)
    f.answer(allow ? '1' : '2')
    assert.equal(await pending, allow ? 'allowed-once' : 'rejected')
    assert.equal(f.bridge.current, undefined)
    f.finish(); assert.equal(await f.run, '本轮完成')
    await until(() => f.listenerCount() === 0)
    assert.equal(f.guardCount(), 0)
    assert.equal(f.worker.revokeApproval, undefined)
    assert.ok(f.stages.includes('approval'))
    assert.equal(f.metrics.dispose, borrowed ? 0 : 1)
    assert.equal(f.metrics.permission, borrowed ? 0 : 1)
    assert.equal(f.metrics.create, borrowed ? 0 : 1)
  })
}

for (const borrowed of [false, true]) test(`${borrowed ? 'borrowed' : 'owned'} approval cannot use same-id foreign-session events or another native agent`, { timeout: 3000 }, async t => {
  const f = await fixture(t, { borrowed }).start()
  f.call('call', { command: 'wrong session' }, 'shell', { ...f.session })
  const pending = f.approval()
  await f.visible()
  assert.equal(f.bridge.current.question.options.some(o => o.label === APPROVAL_CHOICES.allow), false)
  assert.doesNotMatch(f.bridge.current.question.detail, /wrong session/u)
  f.answer('1'); assert.equal(await pending, 'rejected')
  const before = f.questions.length
  assert.equal(await f.approval('foreign', { agent: { id: 'other', session: { id: 'other' } } }), 'not-octo')
  assert.equal(f.questions.length, before)
  f.result('call')
  f.call('correct', { command: 'right session' })
  const correct = f.approval('correct')
  await f.visible(); assert.match(f.bridge.current.question.detail, /right session/u)
  f.answer('1'); assert.equal(await correct, 'allowed-once')
  f.finish(); await f.run
})

test('approval refuses before the original claim and stale-turn records never become approvable', { timeout: 3000 }, async t => {
  const f = await fixture(t, { autoClaim: false }).start()
  f.call('preclaim')
  assert.equal(await f.approval('preclaim'), 'rejected')
  assert.equal(f.questions.length, 0)
  f.claim()
  f.call('old', { command: 'previous turn' }, 'shell', f.session, f.turn - 1)
  const old = f.approval('old')
  await f.visible(); assert.equal(f.bridge.current.question.options.some(o => o.label === APPROVAL_CHOICES.allow), false)
  f.answer('1'); assert.equal(await old, 'rejected')
  f.finish(); await f.run
})

for (const borrowed of [false, true]) test(`${borrowed ? 'borrowed' : 'owned'} reconfiguration revokes a pending approval and dynamically denies tools`, { timeout: 3000 }, async t => {
  const f = await fixture(t, { borrowed }).start()
  f.call(); const pending = f.approval(); await f.visible()
  const old = f.bridge.current
  f.reconfigure()
  assert.equal(await pending, 'rejected')
  await until(() => !f.bridge.current)
  assert.equal(f.questions[0].signal.aborted, true)
  assert.equal(f.bridge.text(old, '1'), false)
  assert.match(f.guard(), /cannot execute tools/u)
  assert.equal(await f.approval(), 'rejected')
  assert.equal(f.questions.length, 1)
  f.finish(); await f.run
})

for (const beforeClaim of [false, true]) test(`mixed ownership ${beforeClaim ? 'before original claim' : 'while awaiting approval'} rejects approval and final forwarding`, { timeout: 3000 }, async t => {
  const f = await fixture(t, { autoClaim: !beforeClaim }).start()
  let pending
  if (!beforeClaim) { f.call(); pending = f.approval(); await f.visible() }
  f.claim({ id: 'web-inbox', source: { kind: 'user' } })
  if (beforeClaim) { f.claim(); f.call(); pending = f.approval() }
  assert.equal(await pending, 'rejected')
  await until(() => !f.bridge.current)
  assert.match(f.guard(), /cannot execute tools/u)
  f.finish()
  await assert.rejects(f.run, /shared_turn_not_forwarded/u)
})

test('runtime-context claims and trusted steering do not revoke the original approval', { timeout: 3000 }, async t => {
  let steer
  const f = await fixture(t).start({ onSteer: value => { steer = value } })
  f.call(); const pending = f.approval(); await f.visible()
  f.claim({ id: 'context', source: { kind: 'runtime-context' } })
  assert.equal(steer('same requester clarification', () => {}), true)
  assert.equal(f.questions[0].signal.aborted, false)
  f.answer('1'); assert.equal(await pending, 'allowed-once')
  f.finish(); await f.run
  assert.equal(steer, undefined)
})

test('borrowed cancellation keeps the denying guard and listener until its native writer is idle', { timeout: 3000 }, async t => {
  const f = await fixture(t, { borrowed: true }).start()
  f.call(); const pending = f.approval(); await f.visible()
  f.lifetime.abort(new Error('stop run'))
  assert.equal(await pending, 'cancelled')
  await assert.rejects(f.run, /session_turn_failed/u)
  assert.equal(f.metrics.dispose, 0)
  assert.equal(f.worker.revokeApproval, undefined)
  assert.match(f.guard(), /cannot execute tools/u)
  assert.equal(f.listenerCount('approval/request'), 1, 'the borrowed scope remains controlled while running')
  assert.equal(await f.approval('late', { signal: new AbortController().signal }), 'cancelled')
  f.idleNow()
  await until(() => f.listenerCount() === 0)
  assert.equal(f.guardCount(), 0)
  assert.equal(await f.approval('after-idle', { signal: new AbortController().signal }), 'not-octo')
})

test('two borrowed runs do not retain approvals, old callbacks or scoped listeners', { timeout: 3000 }, async t => {
  const f = fixture(t, { borrowed: true })
  await f.start(); f.call('first')
  const first = f.approval('first'); await f.visible()
  const old = f.bridge.current, oldControl = f.worker.revokeApproval
  f.answer('1'); assert.equal(await first, 'allowed-once')
  f.finish(); await f.run; await until(() => f.listenerCount() === 0)
  f.turn++; await f.start(); f.call('second')
  const second = f.approval('second'); await f.visible()
  oldControl()
  assert.equal(f.bridge.text(old, '1'), false)
  assert.equal(f.bridge.current.signal.aborted, false)
  assert.notEqual(f.bridge.current.question.id, old.question.id)
  f.answer('2'); assert.equal(await second, 'rejected')
  f.finish(); await f.run; await until(() => f.listenerCount() === 0)
  assert.equal(f.metrics.dispose, 0)
})

test('native question and mounted form still work before and after an approval', { timeout: 3000 }, async t => {
  const f = await fixture(t, { forms: true }).start()
  const question = f.nativeQuestion({ wait: { timed: true, callId: 'native-wait' } })
  await f.visible(); f.answer('1')
  assert.deepEqual(await question, { answers: [{ id: 'ordinary', selected: ['中文'] }] })
  assert.equal(f.metrics.timedReturn, 1)
  f.call(); const approval = f.approval(); await f.visible(); f.answer('2')
  assert.equal(await approval, 'rejected')
  const response = f.form()
  await f.visible(); assert.equal(f.bridge.current.form.title, form.title)
  f.answer('{"action":"submit","values":{"note":"表单不是审批"}}')
  assert.deepEqual(await response, { action: 'submit', values: { note: '表单不是审批' } })
  assert.equal(f.guard(), undefined)
  f.finish(); await f.run
})

for (const first of ['question', 'form', 'approval']) test(`busy ${first} cannot be overwritten or mistaken for an approval answer`, { timeout: 3000 }, async t => {
  const f = await fixture(t, { forms: true }).start()
  f.call()
  const initial = first === 'question' ? f.nativeQuestion() : first === 'form' ? f.form() : f.approval()
  await f.visible()
  const active = f.bridge.current, sent = f.messages.length
  if (first === 'approval') {
    await assert.rejects(f.nativeQuestion(), /octo_question_invalid/u)
    await assert.rejects(f.form(), /octo_question_busy/u)
  } else assert.equal(await f.approval(), 'unavailable')
  assert.equal(f.bridge.current, active)
  assert.equal(f.messages.length, sent)
  f.answer(first === 'form' ? '{"action":"submit","values":{"note":"ok"}}' : '1')
  const answer = await initial
  if (first === 'approval') assert.equal(answer, 'allowed-once')
  else assert.notEqual(answer, 'allowed-once')
  f.finish(); await f.run
})

test('membership loss during native question answer is checked by the bound worker callback', { timeout: 3000 }, async t => {
  const f = await fixture(t).start()
  const pending = f.nativeQuestion(); await f.visible()
  f.access = false
  f.answer('1')
  await assert.rejects(pending, /octo_access_denied/u)
  f.finish(); await f.run
})

test('approval pauses the execution deadline but run cancellation still ends its wait', { timeout: 3000 }, async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t, { timeoutMs: 50 }).start()
  f.call(); const pending = f.approval(); await f.visible()
  now = 500; t.mock.timers.tick(500)
  assert.equal(f.questions[0].signal.aborted, false)
  assert.equal(f.guard(), undefined)
  f.lifetime.abort()
  assert.equal(await pending, 'cancelled')
  await assert.rejects(f.run, /session_turn_failed/u)
})

test('text-only runs never mount the approval answerer or permission preset', { timeout: 3000 }, async t => {
  const f = await fixture(t, { textOnly: true }).start()
  assert.equal(f.listenerCount('approval/request'), 0)
  assert.equal(f.metrics.permission, 0)
  assert.equal(await f.approval(), 'not-octo')
  assert.match(f.guard(), /cannot execute tools/u)
  f.finish(); await f.run
})
