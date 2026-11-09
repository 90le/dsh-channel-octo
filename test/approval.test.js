import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ApprovalAdapter, APPROVAL_CHOICES as choices, APPROVAL_LIMITS as limits, mountApprovalAdapter } from '../src/approval.js'
import { QuestionBridge } from '../src/questions.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick() }
  assert.fail('Expected local approval state was not reached')
}
const selected = (question, value = choices.allow) => ({ answers: [{ id: question.id, selected: [value] }] })
const next = () => assert.fail('An owned request must not fall through to another answerer')

function fixture(t, options = {}) {
  const f = { turn: 7, allowed: true, shown: [], holds: [], lifetime: new AbortController() }
  f.session = { id: 'native-session', header: { cwd: '/workspace/项目' } }
  f.agent = { id: f.session.id, session: f.session }
  f.options = { agent: f.agent, runId: 'job-42', requester: 'alice', signal: f.lifetime.signal,
    getTurn: () => f.turn, authorize: scope => { assert.equal(scope.requester, 'alice'); return f.allowed },
    onWaiting: value => f.holds.push(value), onQuestion: (questions, signal, scope) => {
      const response = Promise.withResolvers()
      f.shown.push({ question: questions[0], signal, scope, response })
      return response.promise
    }, ...options }
  f.adapter = new ApprovalAdapter(f.options)
  t.after(() => f.adapter.dispose())
  f.event = (type, data, session = f.session) => f.adapter.observe(session, { type, data })
  f.call = (id = 'a', args = { command: 'echo 你好' }, name = 'shell') =>
    f.event('tool/call', { turn: f.turn, step: 2, callId: id, name, arguments: JSON.stringify(args) })
  f.request = (id = 'a', extra = {}) => f.adapter.handle({ agent: f.agent, callId: id, toolName: 'shell', ...extra }, next)
  f.answer = (index, value = choices.allow) => f.shown[index].response.resolve(selected(f.shown[index].question, value))
  return f
}

test('parallel tools of the same name get separate FIFO cards and one-shot answers', async t => {
  const f = fixture(t)
  f.call('a', { command: 'echo 第一项' }); f.call('b', { command: 'echo 第二项' })
  const a = f.request('a'), b = f.request('b')
  assert.equal(f.shown.length, 1)
  assert.match(f.shown[0].question.detail, /第一项/u)
  assert.doesNotMatch(f.shown[0].question.detail, /第二项/u)
  assert.deepEqual(f.shown[0].scope, { runId: 'job-42', requester: 'alice', sessionId: f.session.id })
  assert.ok(Object.isFrozen(f.shown[0].scope))
  f.answer(0)
  assert.equal(await a, 'allowed-once')
  await until(() => f.shown.length === 2)
  assert.match(f.shown[1].question.detail, /第二项/u)
  assert.notEqual(f.shown[0].question.id, f.shown[1].question.id)
  f.answer(1, choices.reject)
  assert.equal(await b, 'rejected')
  assert.deepEqual(f.holds, [true, true, false, false])
  // A second approval stage of the same native call requires a new decision.
  const again = f.request('a')
  await until(() => f.shown.length === 3)
  f.shown[2].response.resolve(selected(f.shown[0].question))
  assert.equal(await again, 'rejected', 'an earlier question ID never approves a later request')
})

test('PTC uses exact subCallId and logged JSON value with the same live root/parent chain', async t => {
  const f = fixture(t)
  f.call('root', { code: 'tools.shell(...)' }, 'run_code')
  f.event('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'middle', name: 'run_code', arguments: { code: 'nested' } })
  f.event('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'middle', subCallId: 'leaf', name: 'shell', arguments: { command: 'echo 子调用' } })
  f.call('other', { command: 'echo unrelated' })
  const pending = f.request('leaf')
  assert.match(f.shown[0].question.detail, /echo 子调用/u)
  assert.doesNotMatch(f.shown[0].question.detail, /unrelated|nested/u)
  f.answer(0)
  assert.equal(await pending, 'allowed-once')
})

const unavailableCases = {
  'no native record': f => {},
  'model supplied arguments only': f => {},
  'missing arguments': f => f.event('tool/call', { turn: 7, callId: 'a', name: 'shell' }),
  'empty arguments': f => f.event('tool/call', { turn: 7, callId: 'a', name: 'shell', arguments: '' }),
  'malformed JSON': f => f.event('tool/call', { turn: 7, callId: 'a', name: 'shell', arguments: '{' }),
  'wrong tool name': f => f.call('a', {}, 'delete_file'),
  'different callId': f => f.call('other'),
  'previous turn': f => f.event('tool/call', { turn: 6, callId: 'a', name: 'shell', arguments: '{}' }),
  'foreign session with same id': f => f.event('tool/call', { turn: 7, callId: 'a', name: 'shell', arguments: '{}' }, { ...f.session }),
  'duplicate call identity': f => { f.call(); f.call('a', { command: 'different action' }) },
  'already completed call': f => { f.call(); f.event('tool/result', { turn: 7, message: { toolCallId: 'a' } }) },
  'orphan PTC subcall': f => f.event('tool/ptc-dispatch-start', { rootCallId: 'missing', parentCallId: 'missing', subCallId: 'a', name: 'shell', arguments: {} }),
  'different PTC root': f => { f.call('root', {}, 'run_code'); f.event('tool/ptc-dispatch-start', { rootCallId: 'other', parentCallId: 'root', subCallId: 'a', name: 'shell', arguments: {} }) },
  'retired code-dispatch event': f => f.event('tool/code-dispatch-start', { parentCallId: 'root', subCallId: 'a', name: 'shell', arguments: {} }),
}
for (const [name, prepare] of Object.entries(unavailableCases)) test('unavailable arguments deny: ' + name, async t => {
  const f = fixture(t); prepare(f)
  const pending = f.request('a', { arguments: { command: 'echo fabricated safe argument' } })
  const q = f.shown[0].question
  assert.deepEqual(q.options.map(o => o.label), [choices.reject, choices.cancel])
  assert.match(q.question, /不能批准/u)
  // Even a fabricated callback naming the hidden allow option cannot grant.
  f.answer(0)
  assert.equal(await pending, 'unavailable')
})

test('no callId cannot borrow the newest tool or an approval reason as action', async t => {
  const f = fixture(t); f.call()
  const pending = f.request(undefined, { callId: undefined, reason: 'Safe command: echo okay' })
  assert.doesNotMatch(f.shown[0].question.detail, /echo 你好/u)
  f.answer(0, choices.reject)
  assert.equal(await pending, 'rejected')
})

test('foreign agents delegate without questions, including an object reusing the same session id', async t => {
  const f = fixture(t); let delegated = 0
  for (const agent of [{ id: 'foreign', session: { id: 'foreign' } }, { ...f.agent }]) {
    assert.equal(await f.adapter.handle({ agent }, () => { delegated++; return 'foreign-answer' }), 'foreign-answer')
  }
  assert.equal(delegated, 2); assert.equal(f.shown.length, 0)
})

for (const kind of ['custom', 'wrong-id', 'multi', 'skip', 'reject', 'session-allow']) test('answer validation: ' + kind, async t => {
  const f = fixture(t); f.call()
  const pending = f.request(), question = f.shown[0].question
  const answer = { id: question.id, selected: [choices.allow] }
  if (kind === 'custom') answer.custom = '批准'
  if (kind === 'wrong-id') answer.id = 'old-question'
  if (kind === 'multi') answer.selected.push(choices.reject)
  if (kind === 'skip') answer.selected = []
  if (kind === 'reject') answer.selected = [choices.reject]
  if (kind === 'session-allow') answer.selected = ['始终允许']
  f.shown[0].response.resolve({ answers: [answer] })
  const result = await pending
  assert.notEqual(result, 'allowed-once')
  if (kind === 'skip') assert.equal(result, 'cancelled')
  if (kind === 'reject') assert.equal(result, 'rejected')
})

for (const kind of ['request', 'run', 'revoke', 'dispose', 'turn-end', 'result']) test('pending and late approval fail closed on ' + kind, async t => {
  const f = fixture(t), controller = new AbortController(); f.call()
  const pending = f.request('a', { signal: controller.signal })
  if (kind === 'request') controller.abort()
  if (kind === 'run') f.lifetime.abort()
  if (kind === 'revoke') f.adapter.revoke()
  if (kind === 'dispose') f.adapter.dispose()
  if (kind === 'turn-end') { f.turn = undefined; f.event('turn/end', { turn: 7 }) }
  if (kind === 'result') f.event('tool/result', { turn: 7, message: { toolCallId: 'a' } })
  assert.equal(await pending, kind === 'revoke' ? 'rejected' : 'cancelled')
  assert.equal(f.shown[0].signal.aborted, true)
  f.answer(0)
  await tick()
  assert.deepEqual(f.holds, [true, false])
})

test('authorization and exclusive turn ownership are checked again after the answer', async t => {
  for (const change of [f => { f.allowed = false }, f => { f.turn = undefined }, f => { f.turn = 8 },
    f => { f.agent.session = { ...f.session } }]) {
    const f = fixture(t); f.call()
    const pending = f.request(); change(f); f.answer(0)
    assert.equal(await pending, 'rejected')
  }
})

test('pre-aborted and unauthorized requests send no question', async t => {
  const f = fixture(t); f.call(); f.allowed = false
  assert.equal(await f.request(), 'rejected')
  f.allowed = true
  assert.equal(await f.request('a', { signal: AbortSignal.abort() }), 'cancelled')
  assert.equal(f.shown.length, 0)
})

test('queue capacity, cancellation in queue and duplicate requests are bounded', async t => {
  const f = fixture(t), controller = new AbortController(), results = []
  for (let i = 0; i < limits.pending + 1; i++) f.call(String(i))
  results.push(f.request('0'))
  assert.equal(await f.request('0'), 'unavailable')
  results.push(f.request('1', { signal: controller.signal }))
  for (let i = 2; i < limits.pending; i++) results.push(f.request(String(i)))
  assert.equal(await f.request(String(limits.pending)), 'unavailable')
  controller.abort()
  assert.equal(await results[1], 'cancelled')
  assert.equal(f.shown.length, 1)
  f.adapter.revoke()
  const outcomes = await Promise.all(results)
  assert.ok(outcomes.every(value => value === 'rejected' || value === 'cancelled'))
  assert.equal(f.holds.filter(Boolean).length, f.holds.filter(value => !value).length)
  f.answer(0); await tick()
  assert.equal(f.shown.length, 1)
})

test('timeout includes queue time; an uncooperative old callback never overlaps a new card', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { timeoutMs: 50 }); f.call('a'); f.call('b')
  const a = f.request('a'), b = f.request('b')
  t.mock.timers.tick(50)
  assert.deepEqual(await Promise.all([a, b]), ['cancelled', 'cancelled'])
  const c = f.request('b')
  assert.equal(f.shown.length, 1, 'callback cleanup retains the UI lane')
  f.answer(0)
  await until(() => f.shown.length === 2)
  f.answer(1, choices.reject)
  assert.equal(await c, 'rejected')
  assert.deepEqual(f.holds, [true, true, false, false, true, false])
})

test('call cache overflow never substitutes another call; completed entries free capacity', async t => {
  const f = fixture(t)
  for (let i = 0; i <= limits.calls; i++) f.call(String(i))
  const missing = f.request(String(limits.calls)); f.answer(0)
  assert.equal(await missing, 'unavailable')
  f.event('tool/result', { turn: 7, message: { toolCallId: '0' } })
  f.call('new')
  const available = f.request('new'); f.answer(1)
  assert.equal(await available, 'allowed-once')
})

test('Chinese context/reasons and exact JSON escapes survive presentation without silent clipping', async t => {
  const f = fixture(t); f.call('a', { command: 'echo 中文\n第二行\u202e' })
  const pending = f.request('a', { reason: 'English reason', displayReason: { en: 'English', zh: '需要访问项目目录' } })
  const q = f.shown[0].question
  assert.match(q.detail, /需要访问项目目录/u)
  assert.match(q.detail, /项目/u)
  assert.match(q.detail, /\\n第二行\\u202e/u)
  assert.doesNotMatch(q.detail, /English|\u202e/u)
  assert.match(q.question, /不授权后续调用或整个会话/u)
  f.answer(0); assert.equal(await pending, 'allowed-once')
})

const secrets = [
  { value: { token: 'SYNTHETIC_PRIVATE_VALUE' } },
  { value: { env: { API_KEY: 'SYNTHETIC_PRIVATE_VALUE' } } },
  { value: { command: 'curl -H "Authorization: Bearer SYNTHETIC_PRIVATE_VALUE"' } },
  { value: { command: 'program --password SYNTHETIC_PRIVATE_VALUE' } },
  { value: { url: 'https://user:SYNTHETIC_PRIVATE_VALUE@example.invalid/path' } },
  { value: { url: 'https://example.invalid/path?X-Amz-Signature=SYNTHETIC_PRIVATE_VALUE' } },
  { value: { command: 'echo okay' }, reason: 'token=SYNTHETIC_PRIVATE_VALUE' },
]
for (const [i, row] of secrets.entries()) test('redaction cannot authorize hidden original values: ' + i, async t => {
  const f = fixture(t); f.call('a', row.value)
  const pending = f.request('a', { reason: row.reason })
  const q = f.shown[0].question
  assert.doesNotMatch(JSON.stringify(q), /SYNTHETIC_PRIVATE_VALUE/u)
  assert.match(q.detail, /已隐藏敏感内容/u)
  assert.equal(q.options.some(o => o.label === choices.allow), false)
  f.answer(0); assert.equal(await pending, 'unavailable')
})

for (const [label, value] of [['ASCII', 'x'.repeat(2000)], ['Chinese', '汉字🙂'.repeat(500)],
  ['over read limit', 'x'.repeat(limits.argumentBytes + 1)]]) test('bounded incomplete display denies: ' + label, async t => {
  const f = fixture(t); f.call('a', { command: value })
  const pending = f.request()
  const q = f.shown[0].question
  assert.ok(Array.from(q.detail).length <= limits.detailChars)
  assert.ok(Buffer.byteLength(q.detail) <= limits.detailBytes)
  assert.equal(q.options.some(o => o.label === choices.allow), false)
  assert.match(q.question, /未完整展示/u)
  f.answer(0); assert.equal(await pending, 'unavailable')
})

test('exact boundary can approve, one character beyond cannot', async t => {
  const f = fixture(t)
  // Establish a fixed wrapper, then fill the current QuestionBridge character limit.
  f.call('base', { command: '' })
  const base = f.request('base'); const overhead = Array.from(f.shown[0].question.detail).length
  f.answer(0, choices.reject); await base
  for (const extra of [0, 1]) {
    f.call(String(extra), { command: 'a'.repeat(limits.detailChars - overhead + extra) })
    const pending = f.request(String(extra)), q = f.shown[extra + 1].question
    assert.equal(q.options.some(o => o.label === choices.allow), extra === 0)
    f.answer(extra + 1)
    assert.equal(await pending, extra === 0 ? 'allowed-once' : 'unavailable')
  }
})

test('transport failure and busy QuestionBridge fail closed without delegation', async t => {
  for (const message of ['card_send_unconfirmed', 'octo_question_invalid']) {
    const f = fixture(t, { onQuestion: async () => { throw new Error(message) } }); f.call()
    assert.equal(await f.request(), 'unavailable')
    assert.deepEqual(f.holds, [true, false])
  }
})

test('real QuestionBridge callback scopes original sender/route and displays all approval text', async t => {
  const sent = [], bridge = new QuestionBridge({ api: { async send(...args) { sent.push(args) } }, store: {}, log() {} })
  const config = { apiBase: 'https://fixture.invalid/api', botUid: 'fixture-bot', spaceId: 'fixture-space', token: 'bf_fixture',
    fetchImpl: async () => Response.json({ enabled: false }) }
  let f
  f = fixture(t, { onQuestion: (questions, signal, scope) => bridge.ask(questions,
    { sender: scope.requester, session_id: scope.sessionId, channel_id: 'group', channel_type: 2 }, config, signal, () => {}, () => f.allowed) })
  f.call()
  const pending = f.request()
  await until(() => bridge.current?.ready)
  assert.equal(sent.length, 1)
  assert.match(sent[0][1], /echo 你好/u)
  assert.match(sent[0][1], /仅批准这一次/u)
  assert.ok(Buffer.byteLength(sent[0][1]) <= 2048)
  assert.equal(bridge.match({ sender: 'bob', channelId: 'group', channelType: 2 }), undefined)
  assert.equal(bridge.match({ sender: 'alice', channelId: 'other', channelType: 2 }), undefined)
  const current = bridge.match({ sender: 'alice', channelId: 'group', channelType: 2 })
  assert.ok(current)
  assert.equal(bridge.card(current, 'stale-card', 'q1'), false)
  assert.equal(bridge.text(current, '1'), true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(bridge.current, undefined)
  assert.equal(bridge.text(current, '1'), false)
})

test('mount uses native scoped waterfall and releases all listeners and pending work', async t => {
  const f = fixture(t), listeners = new Map(), registrations = []
  const scoped = { on(name, fn, options) { listeners.set(name, fn); registrations.push({ name, options }); return () => listeners.delete(name) } }
  const binding = mountApprovalAdapter(scoped, f.options)
  assert.deepEqual(registrations, [
    { name: 'session/event', options: { global: true } },
    { name: 'approval/request', options: { prepend: true } }, { name: 'dispose', options: undefined },
  ])
  listeners.get('session/event')(f.session, { type: 'tool/call', data: { turn: 7, callId: 'a', name: 'shell', arguments: '{}' } })
  const pending = listeners.get('approval/request')({ agent: f.agent, toolName: 'shell', callId: 'a' }, next)
  binding.dispose(); binding.dispose()
  assert.equal(await pending, 'cancelled')
  assert.equal(listeners.size, 0)
  f.answer(0); await tick()
})

// Optional, entirely local verification against installed official rc5 modules.
// DSH_APPROVAL_RC5_ROOT points to an existing package root containing node_modules.
// No install, process launch, credentials, model calls, or network are involved.
test('official rc5 ApprovalService + Session + Cordis enforce one-shot, never policy and audit',
  { skip: !process.env.DSH_APPROVAL_RC5_ROOT }, async t => {
    const require = createRequire(resolve(process.env.DSH_APPROVAL_RC5_ROOT, 'package.json'))
    const imported = name => import(pathToFileURL(require.resolve(name)).href)
    for (const name of ['dsh-session', 'dsh-user-approval']) {
      assert.equal(JSON.parse(readFileSync(require.resolve('@deepseek-ai/' + name + '/package.json'), 'utf8')).version, '0.2.1-rc.5')
    }
    const [{ Context }, { default: SessionStore }, { default: ApprovalService, setApprovalPolicy }, { createScope },
      { default: SystemPrompt }, { default: ToolRuntime, defineTool }] = await Promise.all([
      imported('@deepseek-ai/cordis'), imported('@deepseek-ai/dsh-session'), imported('@deepseek-ai/dsh-user-approval'), imported('@deepseek-ai/dsh-scope'),
      imported('@deepseek-ai/dsh-system-prompt'), imported('@deepseek-ai/dsh-tools'),
    ])
    const ctx = new Context(), fibers = []
    t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
    fibers.push(await ctx.plugin(SessionStore)); fibers.push(await ctx.plugin(ApprovalService))
    const session = ctx.sessions.create('approval-native-test'), agent = { id: session.id, session }
    const signal = new AbortController(), shown = []
    let decision = choices.allow, executions = 0
    let binding, scope
    fibers.push(await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent) }, { inject: ['approval'] })))
    binding = mountApprovalAdapter(scope.ctx, { agent, runId: 'native-run', requester: 'alice', signal: signal.signal,
      getTurn: () => 1, authorize: () => true,
      onQuestion: async questions => { shown.push(questions[0]); return selected(questions[0], decision) },
    })
    t.after(() => binding.dispose())
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'native-call', name: 'shell', arguments: '{"command":"echo native"}' })
    const req = { agent, toolName: 'shell', callId: 'native-call', signal: signal.signal }
    assert.equal(await ctx.approval.request(req), 'allowed-once')
    assert.equal(await ctx.approval.request(req), 'allowed-once')
    assert.equal(shown.length, 2, 'no session-wide permission is remembered')
    assert.notEqual(shown[0].id, shown[1].id)
    setApprovalPolicy(session, 'never')
    assert.equal(await ctx.approval.request(req), 'rejected')
    assert.equal(shown.length, 2, 'native never policy wins before any prepend listener')
    setApprovalPolicy(session, 'ask')
    assert.equal(await ctx.approval.request({ ...req, callId: 'unobserved-call' }), 'unavailable')
    assert.equal(await ctx.approval.request({ ...req, signal: AbortSignal.abort() }), 'cancelled')
    const events = session.snapshotEvents() // Official host permits this reader in tests only.
    const asked = events.filter(e => e.type === 'approval/asked'), decided = events.filter(e => e.type === 'approval/decided')
    assert.equal(asked.length, 5); assert.equal(decided.length, 5)
    assert.deepEqual(asked.map(e => e.data.id), decided.map(e => e.data.id))
    assert.deepEqual(decided.map(e => e.data.outcome), ['allowed-once', 'allowed-once', 'rejected', 'unavailable', 'cancelled'])
    // Exercise the real tool pipeline as well: approval must decide dispatch,
    // not merely produce a plausible card or approval-service return value.
    fibers.push(await ctx.plugin(SystemPrompt)); fibers.push(await ctx.plugin(ToolRuntime))
    const offTool = ctx.tools.register(defineTool({ name: 'approval_probe', description: 'Local counter only', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { executions++; return 'executed' },
    }))
    const offAsk = ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: '本地审批验证' }))
    t.after(() => { offAsk(); offTool() })
    for (const [i, choice] of [choices.allow, choices.reject, choices.cancel].entries()) {
      decision = choice
      const callId = 'pipeline-' + i
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'approval_probe', arguments: '{}' })
      const result = await ctx.tools.execute({ agent, callId, name: 'approval_probe', arguments: {}, signal: signal.signal })
      assert.equal(result.isError, choice !== choices.allow)
    }
    assert.equal(executions, 1, 'only allowed-once enters the native tool body')
    binding.dispose()
    assert.equal(await ctx.approval.request(req), 'unavailable', 'disposal removes the approval listener')
  })
