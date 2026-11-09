import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { OctoClient, OctoError } from '../src/octo.js'
import { Progress } from '../src/progress.js'

const job = { message_id: '123', sender: 'member', channel_id: 'thread', channel_type: 5 }
const ref = { id: 'ai.reasoning-process', version: '0.4.1' }
const display = {
  enabled: 1, card_version: '1.5', profiles: ['octo/v1'],
  config: { card_enabled: true, display_enabled: true },
}
const template = {
  ...display,
  config: { ...display.config, reasoning_enabled: true, reasoning_template_ref: ref },
  templating: { supported: true, templates: [
    { ...ref, views: [{ states: ['reasoning', 'answering', 'completed', 'stopped', 'error'] }] },
  ] },
}
const labels = {
  queued: '已收到，等待 DSH 开始处理', running: 'DSH 正在处理', responding: '正在生成回复',
  completed: '回复已发送', error: '本次回复未完成，请稍后重发', stopped: '回复发送待确认',
}

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  return async ms => {
    t.mock.timers.tick(ms)
    await setImmediate()
  }
}

function fixture({ profile = () => template, create = () => '456', edit = () => {} } = {}) {
  const calls = [], logs = []
  const api = {
    cardProfile() { calls.push({ type: 'profile' }); return profile() },
    progressCard(route, frame) { calls.push({ type: 'create', route, frame }); return create() },
    editProgress(route, id, frame, seq, transient) {
      calls.push({ type: 'edit', route, id, frame, seq, transient })
      return edit(frame)
    },
    typing(route) { calls.push({ type: 'typing', route }) },
  }
  return { calls, logs, progress: new Progress(api, log => logs.push(log)) }
}

test('type-17 template shows queued, running, responding and confirmed completion', async t => {
  const tick = clock(t)
  const requests = []
  const api = new OctoClient({ apiBase: 'http://127.0.0.1', token: 'test-only', fetchImpl: async (url, init) => {
    const path = new URL(url).pathname
    requests.push([path, init.body && JSON.parse(init.body)])
    if (path === '/v1/bot/card/profile') return Response.json(template)
    return Response.json({ message_id: '456' })
  } })
  const handle = new Progress(api, assert.fail).start(job, 'auto', new AbortController().signal)

  await tick(450)
  handle.stage('running')
  await tick(799)
  assert.equal(requests.length, 2)
  await tick(1)
  handle.stage('responding')
  await tick(800)
  assert.equal(await handle.finish('completed'), true)
  await tick(20_000)

  const [, [createPath, created], ...edits] = requests
  assert.equal(createPath, '/v1/bot/sendMessage')
  assert.equal(created.payload.type, 17)
  assert.deepEqual(created.payload.template_ref, ref)
  assert.equal(created.payload.state, 'reasoning')
  assert.equal(created.payload.data.statusLabel, labels.queued)
  assert.deepEqual(edits.map(([path, body]) => [
    path, body.channel_id, body.channel_type, body.message_id, body.card_seq, body.transient,
    body.state, body.data.statusLabel, body.content_edit,
  ]), [
    ['/v1/bot/message/edit', 'thread', 5, '456', 2, true, 'reasoning', labels.running, undefined],
    ['/v1/bot/message/edit', 'thread', 5, '456', 3, true, 'answering', labels.responding, undefined],
    ['/v1/bot/message/edit', 'thread', 5, '456', 4, undefined, 'completed', labels.completed, undefined],
  ])
})

test('coalesces a burst during creation and serializes finalization with the in-flight edit', async t => {
  const tick = clock(t)
  const creating = Promise.withResolvers(), editing = Promise.withResolvers()
  const { calls, progress } = fixture({ create: () => creating.promise,
    edit: frame => frame.state === 'answering' ? editing.promise : undefined })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  handle.stage('answering') // compatibility with the existing host callback
  for (let i = 0; i < 100; i++) handle.stage('responding')
  handle.stage('running')
  await tick(20_000)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'create'])
  creating.resolve('456')
  await tick(0)
  await tick(800)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.responding)
  const done = handle.finish('error')
  assert.equal(handle.finish('completed'), done)
  await tick(20_000)
  assert.equal(calls.filter(call => call.type === 'edit').length, 1)
  editing.resolve()
  assert.equal(await done, true)
  await tick(20_000)
  assert.deepEqual(calls.filter(call => call.type === 'edit').map(call => [call.frame.state, call.seq, call.transient]),
    [['answering', 2, true], ['error', 3, false]])
})

test('a rate-limited edit resumes with the latest phase at Retry-After without a new event', async t => {
  const tick = clock(t)
  let attempts = 0
  const { calls, progress } = fixture({ edit() {
    if (++attempts === 1) throw new OctoError('http_429', 429, 7400)
  } })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  await tick(800)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.running)
  handle.stage('responding')
  await tick(7399)
  assert.equal(attempts, 1)
  await tick(1)
  assert.equal(attempts, 2)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.responding)
  assert.equal(calls.at(-1).transient, true)
  assert.equal(await handle.finish('completed'), true)
})

test('retries rate-limited profile and card creation without typing during cooldown', async t => {
  const tick = clock(t)
  let probes = 0, creates = 0
  const rateLimit = new OctoError('http_429', 429, 5000)
  const { calls, progress } = fixture({
    profile() { if (++probes === 1) throw rateLimit; return display },
    create() { if (++creates === 1) throw rateLimit; return '456' },
  })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  await tick(4999)
  assert.deepEqual(calls.map(call => call.type), ['profile'])
  await tick(1)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'profile', 'create'])
  handle.stage('responding')
  await tick(5000)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'profile', 'create', 'create'])
  assert.equal(calls.at(-1).frame.plain, labels.responding)
  assert.equal(await handle.finish('stopped'), true)
  assert.equal(calls.at(-1).frame.plain, labels.stopped)
})

test('a terminal retry keeps the same payload and sequence and never replays a transient edit', async t => {
  const tick = clock(t)
  let attempts = 0
  const { calls, progress } = fixture({ edit() {
    if (++attempts === 1) throw new OctoError('http_429', 429, 5000)
  } })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  const done = handle.finish('error')
  await tick(0)
  await tick(4999)
  assert.equal(attempts, 1)
  await tick(1)
  assert.equal(await done, true)
  assert.equal(attempts, 2)
  assert.deepEqual(calls.at(-1), calls.at(-2))
  assert.equal(calls.at(-1).transient, false)
  assert.equal(calls.at(-1).frame.state, 'error')
})

test('a long cooldown leaves finish best effort and also applies to other handles', async t => {
  const tick = clock(t)
  const { calls, progress } = fixture({ edit() { throw new OctoError('http_429', 429, 30_000) } })
  const first = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  const second = progress.start({ ...job, message_id: '987' }, 'auto', new AbortController().signal)
  first.stage('running')
  // Second handle creates after its debounce. First handle's edit then sets the cooldown.
  await tick(450)
  await tick(350)
  assert.equal(await first.finish('error'), false)
  second.stage('responding')
  await tick(29_999)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'create', 'profile', 'create', 'edit'])
  await tick(1)
  assert.equal(calls.at(-1).frame.state, 'answering')
  assert.equal(await second.finish('stopped'), false)
})

test('an uncertain card create falls back to typing instead of risking a duplicate card', async t => {
  const tick = clock(t)
  const { calls, logs, progress } = fixture({ create() {
    throw new OctoError('sensitive server response', 503)
  } })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  await tick(4000)
  assert.equal(await handle.finish('error'), false)
  await tick(20_000)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'create', 'typing', 'typing'])
  assert.deepEqual(logs, ['progress_http_503'])
})

test('short, disabled, and aborted runs stop without leaving progress work behind', async t => {
  const tick = clock(t)
  const { calls, progress } = fixture()
  const controller = new AbortController()
  assert.equal(await progress.start(job, 'off', controller.signal).finish('completed'), false)
  assert.equal(await progress.start(job, 'auto', controller.signal).finish('completed'), false)
  const handle = progress.start(job, 'typing', controller.signal)
  await tick(450)
  assert.deepEqual(calls, [{ type: 'typing', route: { channel_id: 'thread', channel_type: 5 } }])
  controller.abort()
  await tick(20_000)
  assert.equal(await handle.finish('error'), false)
  assert.equal(calls.length, 1)
})

test('progress only renders fixed labels, even if inputs contain private content', async t => {
  const tick = clock(t)
  const { calls, logs, progress } = fixture()
  const handle = progress.start({ ...job, message_id: 'private-id', input: 'private-prompt' },
    'auto', new AbortController().signal)
  handle.stage('private-partial-text')
  handle.stage({ type: 'reasoning-delta', text: 'private-reasoning' })
  await tick(450)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.queued)
  handle.stage('running', 'private-tool-result')
  await tick(800)
  await handle.finish('error', new Error('private-error'))
  assert.equal(calls.at(-1).frame.data.errorMessage, labels.error)
  assert.doesNotMatch(JSON.stringify([calls, logs]), /private-/)
})
