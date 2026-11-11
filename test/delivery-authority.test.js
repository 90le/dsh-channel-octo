import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { admit, OctoClient, permitsRoute } from '../src/octo.js'
import { sendDisplayCard } from '../src/display-card.js'
import { Store } from '../src/store.js'
import { Worker, authorizedTools } from '../src/worker.js'

const endpoint = 'https://octo.example.invalid/api'
const storage = 'https://storage.example.invalid'
const cdn = 'https://cdn.example.invalid'
const group = '00112233445566778899aabbccddeeff'
const topic = group + '____123456789012345678'
const identity = 'delivery-authority-fixture'
const answer = 'The prepared answer.'
const fileContent = 'authority-fixture document\n'
const cardArgs = { title: 'Report', blocks: [{ type: 'text', text: 'Prepared report.' }] }
const manifest = {
  enabled: true, available: true, card_version: '1.5', profiles: ['octo/v1'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: false },
  elements: ['TextBlock'], limits: { max_payload_bytes: 524288, max_nodes: 400, max_depth: 16 },
}

// Keep the real Worker, SQLite store, workspace reads and OctoClient. Only HTTP
// is synthetic; no assertion runs inside a host/transport callback that the
// production error handlers could catch and disguise as a successful test.
function fixture(t, options = {}, upstream = {}) {
  const apiOrigin = new URL(options.apiBase ?? endpoint).origin
  const uploadOrigin = upstream.storage ?? storage
  const downloadOrigin = upstream.cdn ?? cdn
  const root = mkdtempSync(join(tmpdir(), 'octo-delivery-authority-'))
  const cwd = join(root, 'workspace'), stateDir = join(root, 'state')
  const otherCwd = join(root, 'other-workspace')
  mkdirSync(cwd); mkdirSync(otherCwd)
  for (const name of ['first.txt', 'second.txt']) writeFileSync(join(cwd, name), fileContent)
  const f = {
    root, cwd, otherCwd, stateDir, requests: [], posts: [], puts: [], presigns: [], profiles: [],
    syncs: [], edits: [], typings: [], verifications: [], unexpected: [], hostCalls: [], hostErrors: [],
    toolResults: [], finishes: [], logs: [], readyRows: [],
    files: [], reply: answer, hooks: {}, syncDenied: false, controller: new AbortController(),
    route: { channelType: 1, channelId: 'alice' }, cardProfile: manifest, verifiedOwner: options.ownerUid ?? 'alice',
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const call = { method: init.method ?? 'GET', path: url.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }
    f.requests.push(call)
    if (url.origin === apiOrigin && url.pathname.endsWith('/auth/verify-bot')) {
      f.verifications.push(call)
      return Response.json({ bot_uid: 'bot', space_id: 'space', owner_uid: f.verifiedOwner })
    }
    if (url.origin === apiOrigin && url.pathname === '/api/v1/bot/groups') {
      return Response.json({ groups: [{ group_no: group, space_id: 'space' }] })
    }
    if (url.origin === apiOrigin && url.pathname === '/api/v1/bot/groups/' + group + '/members') {
      return Response.json({ members: [{ uid: 'alice', name: 'Alice', robot: 0 }, { uid: 'bot', name: 'Bot', robot: 1 }] })
    }
    if (url.origin === apiOrigin && url.pathname === '/api/v1/bot/groups/' + group + '/threads/123456789012345678') {
      return Response.json({ group_no: group, short_id: '123456789012345678', channel_id: topic,
        channel_type: 5, status: 1, name: 'Fixture topic' })
    }
    if (url.origin === apiOrigin && [
      '/api/v1/bot/groups/' + group + '/md',
      '/api/v1/bot/groups/' + group + '/threads/123456789012345678/md',
    ].includes(url.pathname)) {
      await f.hooks.rules?.(call)
      return Response.json({ content: 'Fixture channel policy.', version: 1 })
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/messages/sync')) {
      f.syncs.push(call)
      await f.hooks.sync?.(call)
      return f.syncDenied ? new Response(null, { status: 403 }) : Response.json({ messages: [] })
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/readReceipt')) {
      return Response.json({ status: 200 })
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/upload/presigned')) {
      f.presigns.push(call)
      await f.hooks.presign?.(call)
      const name = url.searchParams.get('filename')
      return Response.json({ method: 'PUT', uploadUrl: uploadOrigin + '/' + name + '?signature=fixture',
        downloadUrl: downloadOrigin + '/' + name, contentType: 'text/plain' })
    }
    if (url.origin === uploadOrigin && call.method === 'PUT') {
      f.puts.push(call)
      await f.hooks.put?.(call)
      return new Response(null, { status: 200 })
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/card/profile')) {
      f.profiles.push(call)
      await f.hooks.profile?.(call)
      return Response.json(f.cardProfile)
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/sendMessage')) {
      f.posts.push(call)
      const messageId = String(900 + f.posts.length)
      await f.hooks.post?.(call)
      return Response.json({ message_id: messageId })
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/message/edit')) {
      f.edits.push(call)
      await f.hooks.edit?.(call)
      return Response.json({ status: 200 })
    }
    if (url.origin === apiOrigin && url.pathname.endsWith('/typing')) {
      f.typings.push(call)
      await f.hooks.typing?.(call)
      return Response.json({ status: 200 })
    }
    f.unexpected.push({ method: call.method, path: url.pathname, origin: url.origin })
    return new Response(null, { status: 500 })
  }
  f.config = {
    apiBase: endpoint, token: 'bf_synthetic_authority_only', botUid: 'bot', spaceId: 'space', ownerUid: 'alice',
    senderPolicy: 'octo', channelPolicy: 'joined', mentionPolicy: 'required', allowed: new Set(['alice']),
    toolPermission: 'workspace-write', toolScope: 'private', sessionProfile: 'fixture-profile',
    allowFiles: true, dmCommands: 'safe', groupCommands: 'safe', transport: 'websocket', sendMode: 'queue',
    waitSeconds: 5, cwd, threadRuleMode: 'thread-only',
    mediaDownloadOrigins: [cdn], mediaUploadOrigins: [storage], ...options, fetchImpl,
  }
  f.host = {
    async run(session, text, created, signal, rules, stage, timeout, allowed, extras) {
      f.hostCalls.push({ session, text, allowed, extras })
      try {
        await created()
        if (f.files.length) extras.onDeliverables(f.files.map(name => join(cwd, name)))
        await f.onHost?.(extras, signal)
        return f.reply
      } catch (error) {
        f.hostErrors.push(error)
        throw error
      }
    },
  }
  const bind = () => {
    const ready = f.store.ready.bind(f.store)
    f.store.ready = (seq, reply, metadata) => {
      ready(seq, reply, metadata)
      f.readyRows.push({ seq, reply, metadata: structuredClone(metadata) })
      f.onReady?.()
    }
    f.api = new OctoClient(f.config)
    f.worker = new Worker({ config: f.config, api: f.api, store: f.store, host: f.host,
      log: issue => f.logs.push(issue) })
    const start = f.worker.progress.start.bind(f.worker.progress)
    f.worker.progress.start = (...args) => {
      const progress = start(...args), finish = progress.finish.bind(progress)
      progress.finish = async (outcome, details) => {
        f.finishes.push({ outcome, details })
        return finish(outcome, details)
      }
      return progress
    }
  }
  f.store = new Store(stateDir, identity)
  bind()
  f.reconfigure = changes => {
    f.config = { ...f.config, ...changes }
    f.worker.reconfigure(f.config, f.host)
  }
  f.restart = changes => {
    f.store.close()
    f.config = { ...f.config, ...changes }
    f.store = new Store(stateDir, identity)
    bind()
  }
  f.enqueue = (text = 'Prepare a response.') => {
    const message = admit({ event_id: '101', message: {
      message_id: '101', from_uid: 'alice', channel_type: f.route.channelType, channel_id: f.route.channelId,
      payload: { type: 1, content: text, ...(f.route.channelType !== 1 && { mention: { uids: [f.config.botUid] } }) },
    } }, f.config)
    assert.ok(message, 'fixture request must be admitted before authority changes')
    f.store.add('101', message)
    return message
  }
  f.process = () => {
    const job = f.store.next(Date.now())
    assert.ok(job, 'fixture must have a runnable job')
    return f.worker.process(job, f.controller.signal)
  }
  f.job = () => f.store.db.prepare('SELECT * FROM jobs WHERE message_id=?').get('101')
  t.after(() => {
    try { f.store.close() } finally {
      assert.equal(resolve(dirname(root)), resolve(tmpdir()), 'remove only the owned temporary fixture')
      rmSync(root, { recursive: true, force: true })
    }
  })
  return f
}

function healthy(f) {
  assert.deepEqual(f.unexpected, [], 'all requests must use the synthetic transport routes')
  assert.deepEqual(f.hostErrors, [], 'host exceptions must not be swallowed by Worker.process')
}

function stopped(f, receipt = null, issue = 'delivery_access_changed') {
  healthy(f)
  const job = f.job()
  assert.equal(job.state, 'review')
  assert.equal(job.issue, issue)
  assert.equal(job.result_id, receipt, 'retain only a confirmed send receipt')
  assert.equal(f.store.next(Date.now() + 86_400_000), undefined, 'revoked delivery must not auto-retry')
  assert.ok(!f.finishes.some(item => item.outcome === 'completed'), 'revoked delivery must not report success')
}

test('fresh official Octo configuration delivers workspace bytes without a custom media policy', async t => {
  const f = fixture(t, {
    apiBase: 'https://im.deepminer.com.cn/api', mediaUploadOrigins: undefined, mediaDownloadOrigins: undefined,
  }, { storage: 'https://im-data-1255521909.cos.ap-beijing.myqcloud.com', cdn: 'https://cdn.deepminer.com.cn' })
  f.files = ['first.txt']
  f.enqueue()
  await f.process()
  healthy(f)
  assert.equal(f.job().state, 'sent')
  assert.equal(f.presigns.length, 1)
  assert.equal(f.puts.length, 1)
  assert.deepEqual(f.puts[0].body, Buffer.from(fileContent))
  assert.deepEqual(f.posts.map(call => call.body.payload.type), [8, 1])
  assert.equal(f.posts[0].body.payload.url, 'https://cdn.deepminer.com.cn/first.txt')
})

test('blocked attachment domain is reported without a signed URL or any upload attempt', async t => {
  const f = fixture(t, { mediaUploadOrigins: [] })
  f.files = ['first.txt']
  f.enqueue()
  await f.process()
  stopped(f, null, 'media_upload_origin_blocked')
  assert.equal(f.presigns.length, 1)
  assert.equal(f.puts.length, 0)
  assert.equal(f.posts.length, 0)
  assert.deepEqual(f.finishes, [{ outcome: 'stopped',
    details: { detail: 'Octo 返回的附件上传域名未获允许，请检查附件上传域名配置。' } }])
})

const revocations = [
  ['allowFiles mutation', f => { f.config.allowFiles = false }],
  ['allowFiles reconfigure', f => f.reconfigure({ allowFiles: false })],
  ['text-only reconfigure', f => f.reconfigure({ toolPermission: 'text-only' })],
  ['allowed sender removal', f => f.reconfigure({ allowed: new Set() })],
]

for (const phase of ['presign', 'put']) for (const [name, revoke] of revocations) {
  test(`file delivery: ${name} during ${phase} blocks the next side effect`, async t => {
    const f = fixture(t, { senderPolicy: 'allowlist' })
    f.files = ['first.txt']
    let changes = 0
    f.hooks[phase] = () => { changes++; revoke(f) }
    f.enqueue()
    await f.process()
    healthy(f)
    assert.equal(changes, 1, 'the intended in-flight boundary must be reached')
    assert.equal(f.presigns.length, 1)
    assert.equal(f.puts.length, phase === 'put' ? 1 : 0)
    assert.equal(f.posts.length, 0, 'neither a file nor a final/failure text may be posted')
    if (phase === 'put') assert.deepEqual(f.puts[0].body, Buffer.from(fileContent))
    stopped(f)
  })
}

test('revocation while a real workspace file is being read prevents presign, PUT and POST', async t => {
  const f = fixture(t)
  f.files = ['first.txt']
  const handle = await open(join(f.cwd, 'first.txt'), 'r')
  const prototype = Object.getPrototypeOf(handle), read = prototype.read
  await handle.close()
  let changes = 0
  const mockedRead = t.mock.method(prototype, 'read', async function (...args) {
    const result = await read.apply(this, args)
    if (!changes && Buffer.isBuffer(args[0]) && args[0].toString() === fileContent) {
      changes++
      f.reconfigure({ allowFiles: false })
    }
    return result
  })
  f.enqueue()
  try { await f.process() } finally { mockedRead.mock.restore() }
  assert.equal(changes, 1, 'the real file read must trigger the change')
  assert.equal(f.presigns.length, 0)
  assert.equal(f.puts.length, 0)
  assert.equal(f.posts.length, 0)
  stopped(f)
})

for (const files of [[], ['first.txt']]) {
  test(`text-only after host final suppresses ${files.length ? 'file and text' : 'text'} delivery`, async t => {
    const f = fixture(t)
    f.files = files
    f.onReady = () => f.reconfigure({ toolPermission: 'text-only' })
    f.enqueue()
    await f.process()
    assert.equal(f.hostCalls.length, 1)
    assert.equal(f.readyRows[0]?.reply, answer, 'change occurs after the host supplied its final answer')
    assert.equal(f.presigns.length, 0)
    assert.equal(f.posts.length, 0)
    stopped(f)
  })
}

for (const mode of ['allowed sender removed', 'DM sync 403', 'account intake stopped']) {
  test(`${mode} after host final blocks every final POST`, async t => {
    const f = fixture(t, mode === 'allowed sender removed' ? { senderPolicy: 'allowlist' } : {})
    f.onReady = () => {
      if (mode === 'allowed sender removed') f.reconfigure({ allowed: new Set() })
      else if (mode === 'DM sync 403') f.syncDenied = true
      else f.worker.pause(true)
    }
    f.enqueue()
    await f.process()
    assert.equal(f.hostCalls.length, 1)
    if (mode === 'DM sync 403') assert.ok(f.syncs.length >= 2, 'DM access must be checked again after the host final')
    assert.equal(f.posts.length, 0)
    stopped(f)
  })
}

for (const kind of ['files', 'text']) for (const change of ['local permission', 'DM sync 403']) {
  test(`${kind} batch: ${change} during first POST preserves receipt and blocks the remainder`, async t => {
    const f = fixture(t)
    if (kind === 'files') f.files = ['first.txt', 'second.txt']
    else f.reply = ['A'.repeat(1200), 'B'.repeat(1200), 'C'.repeat(1200)].join('\n\n')
    f.hooks.post = () => {
      if (f.posts.length !== 1) return
      if (change === 'DM sync 403') f.syncDenied = true
      else f.reconfigure(kind === 'files' ? { allowFiles: false } : { toolPermission: 'text-only' })
    }
    f.enqueue()
    await f.process()
    assert.equal(f.posts.length, 1, 'no remaining file, text chunk or success notice may be sent')
    assert.equal(f.posts[0].body.payload.type, kind === 'files' ? 8 : 1)
    if (kind === 'files') {
      assert.equal(f.presigns.length, 1)
      assert.equal(f.puts.length, 1)
      assert.equal(f.posts[0].body.payload.name, 'first.txt')
    } else {
      assert.equal(f.posts[0].body.payload.content, 'A'.repeat(1200))
    }
    stopped(f, '901')
  })
}

test('current display-card helper rechecks authorization after fetching the profile', async t => {
  const f = fixture(t)
  const checked = []
  f.hooks.profile = () => f.reconfigure({ toolPermission: 'text-only' })
  await assert.rejects(sendDisplayCard({ api: f.api, route: { channel_id: 'alice', channel_type: 1 },
    args: cardArgs, signal: f.controller.signal, authorize: async active => {
      checked.push(active)
      return f.worker.config.toolPermission !== 'text-only'
    } }), /octo_access_denied/)
  healthy(f)
  assert.equal(f.profiles.length, 1)
  assert.equal(checked.length, 2)
  assert.ok(checked.every(signal => signal instanceof AbortSignal))
  assert.equal(f.posts.length, 0)
})

test('current octo_display_card tool cannot POST after profile-time permission change', async t => {
  const f = fixture(t)
  f.hooks.profile = () => f.reconfigure({ toolPermission: 'text-only' })
  f.onHost = async (extras, signal) => {
    const result = await extras.channelTools.execute('octo_display_card', cardArgs, signal)
      .then(value => ({ value }), error => ({ error }))
    f.toolResults.push(result)
  }
  f.enqueue()
  await f.process()
  healthy(f)
  assert.equal(f.profiles.length, 1)
  assert.equal(f.toolResults.length, 1)
  assert.equal(f.toolResults[0].value, undefined, 'no successful card receipt may be returned')
  assert.match(f.toolResults[0].error?.message ?? '', /delivery_access_changed|octo_access_denied/)
  assert.equal(f.posts.length, 0, 'the tool and subsequent final answer must both be blocked')
  stopped(f)
})

test('a model-authored fallback card cannot POST when card authorization changes during its profile request', async t => {
  const f = fixture(t)
  f.hooks.profile = () => f.reconfigure({ dmCommands: 'off' })
  f.reply = '\`\`\`octo-card\n{"title":"Report","text":"Synthetic summary."}\n\`\`\`'
  f.enqueue('请发一张展示卡片')
  await f.process()
  assert.equal(f.hostCalls.length, 1)
  assert.equal(f.profiles.length, 1)
  assert.equal(f.posts.length, 0, 'no card or plain-text fallback may bypass the disabled command')
  stopped(f)
})

async function persistReady(f) {
  f.onReady = () => f.controller.abort()
  f.enqueue()
  await assert.rejects(f.process(), { name: 'AbortError' })
  healthy(f)
  const job = f.job(), metadata = JSON.parse(job.metadata)
  assert.equal(job.state, 'ready')
  assert.equal(job.reply, answer)
  assert.match(metadata.deliveryProfile ?? '', /^[a-f0-9]{64}$/, 'new ready output must persist its security-profile digest')
  assert.ok(!job.metadata.includes(f.config.token), 'metadata must not persist the synthetic credential')
  if (!f.files.length) assert.ok(!job.metadata.includes(f.config.cwd), 'the profile must be an opaque digest')
  else assert.match(metadata.deliveryMediaProfile ?? '', /^[a-f0-9]{64}$/, 'file output must persist its media-policy digest')
  assert.equal(f.posts.length, 0)
  f.onReady = undefined
  f.controller = new AbortController()
  return metadata.deliveryProfile
}

const profileChanges = [
  ['endpoint', () => ({ apiBase: 'https://changed.example.invalid/api' })],
  ['Bot', () => ({ botUid: 'other-bot' })],
  ['Space', () => ({ spaceId: 'other-space' })],
  ['cwd', f => ({ cwd: f.otherCwd })],
  ['sessionProfile', () => ({ sessionProfile: 'other-session-profile' })],
  ['toolPermission', () => ({ toolPermission: 'read-only' })],
  ['toolScope', () => ({ toolScope: 'admitted' })],
]

for (const transition of ['reconfigure', 'restart']) for (const [name, changes] of profileChanges) {
  test(`persisted ready reply rejects mismatched ${name} after ${transition}`, async t => {
    const f = fixture(t, { senderPolicy: 'allowlist' })
    const profile = await persistReady(f)
    f[transition](changes(f))
    assert.equal(JSON.parse(f.job().metadata).deliveryProfile, profile, 'the original profile survives the transition')
    await f.process()
    assert.equal(f.hostCalls.length, 1, 'ready delivery must not regenerate an answer under the new profile')
    assert.equal(f.posts.length, 0)
    stopped(f)
  })
}

for (const transition of ['reconfigure', 'restart']) {
  test(`persisted ready reply survives harmless label/sendMode ${transition}`, async t => {
    const f = fixture(t)
    const profile = await persistReady(f)
    f[transition]({ label: 'Renamed account', sendMode: 'steer' })
    assert.equal(JSON.parse(f.job().metadata).deliveryProfile, profile)
    await f.process()
    healthy(f)
    assert.equal(f.hostCalls.length, 1)
    assert.deepEqual(f.posts.map(call => call.body.payload), [{ type: 1, content: answer }])
    assert.equal(f.job().state, 'sent')
    assert.equal(f.job().result_id, '901')
    assert.equal(f.store.next(Date.now() + 86_400_000), undefined)
  })
}

for (const phase of ['host final', 'presign']) {
  test(`harmless label/sendMode reconfigure during ${phase} permits normal file and text delivery`, async t => {
    const f = fixture(t)
    f.files = ['first.txt']
    const change = () => f.reconfigure({ label: 'Renamed account', sendMode: 'steer' })
    if (phase === 'host final') f.onReady = change
    else f.hooks.presign = change
    f.enqueue()
    await f.process()
    healthy(f)
    assert.equal(f.presigns.length, 1)
    assert.equal(f.puts.length, 1)
    assert.deepEqual(f.puts[0].body, Buffer.from(fileContent))
    assert.deepEqual(f.posts.map(call => call.body.payload.type), [8, 1])
    assert.equal(f.posts[1].body.payload.content, answer)
    assert.equal(f.job().state, 'sent')
    assert.equal(f.job().issue, null)
    assert.equal(f.job().result_id, '902')
    assert.deepEqual(f.finishes.map(item => item.outcome), ['completed'])
  })
}

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  return async ms => { t.mock.timers.tick(ms); await setImmediate() }
}

function holdHost(f) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  f.onHost = () => { entered.resolve(); return released.promise }
  return { entered: entered.promise, release: released.resolve }
}

// Capture rejections immediately, then assert them outside all Worker callbacks.
const runObserved = f => f.process().then(() => undefined, error => error)
const progressWrites = f => [f.posts.length, f.edits.length, f.typings.length]

test('harmless label/sendMode reconfigure during pending delivery admission preserves the final reply', { timeout: 10_000 }, async t => {
  const f = fixture(t)
  const checking = Promise.withResolvers(), release = Promise.withResolvers()
  let held = false
  f.hooks.sync = () => {
    if (f.hostCalls.length && !held) {
      held = true
      checking.resolve()
      return release.promise
    }
  }
  f.enqueue()
  const running = runObserved(f)
  try {
    await checking.promise
    assert.equal(f.hostCalls.length, 1, 'hold delivery admission, not initial intake')
    assert.equal(f.posts.length, 0)
    f.reconfigure({ label: 'Renamed while checking access', sendMode: 'steer' })
    release.resolve()
    assert.equal(await running, undefined)
    healthy(f)
    assert.deepEqual(f.posts.map(call => call.body.payload), [{ type: 1, content: answer }])
    assert.equal(f.job().state, 'sent')
    assert.equal(f.job().issue, null)
    assert.equal(f.job().result_id, '901')
  } finally {
    release.resolve()
    f.controller.abort()
    await running
  }
})

for (const available of [true, false]) {
  test(`auto progress cannot ${available ? 'create a card' : 'fall back to typing'} after revocation during profile wait`,
    { timeout: 10_000 }, async t => {
      const tick = clock(t), f = fixture(t, { progress: 'auto', senderPolicy: 'allowlist' })
      if (!available) f.cardProfile = { ...manifest, enabled: false }
      const host = holdHost(f), releaseProfile = Promise.withResolvers()
      f.hooks.profile = () => releaseProfile.promise
      f.enqueue()
      const running = runObserved(f)
      try {
        await host.entered
        await tick(450)
        assert.equal(f.profiles.length, 1, 'the progress profile request must be pending')
        assert.deepEqual(progressWrites(f), [0, 0, 0])
        f.reconfigure({ allowed: new Set() })
        releaseProfile.resolve()
        await tick(0)
        await tick(8000)
        assert.deepEqual(progressWrites(f), [0, 0, 0], 'no revoked card, edit or typing request while the host remains active')
        assert.equal(f.profiles.length, 1, 'denied progress must not schedule another probe')
        host.release()
        assert.equal(await running, undefined)
        await tick(8000)
        assert.deepEqual(progressWrites(f), [0, 0, 0], 'finalization must not bypass revocation')
        stopped(f)
      } finally {
        releaseProfile.resolve()
        host.release()
        f.controller.abort()
        await running
      }
    })
}

test('auto progress checks revocation before its first profile request', { timeout: 10_000 }, async t => {
  const tick = clock(t), f = fixture(t, { progress: 'auto', senderPolicy: 'allowlist' })
  const host = holdHost(f)
  f.enqueue()
  const running = runObserved(f)
  try {
    await host.entered
    f.reconfigure({ allowed: new Set() })
    await tick(450)
    await tick(8000)
    assert.equal(f.profiles.length, 0)
    assert.deepEqual(progressWrites(f), [0, 0, 0])
    host.release()
    assert.equal(await running, undefined)
    stopped(f)
  } finally {
    host.release()
    f.controller.abort()
    await running
  }
})

for (const phase of ['periodic refresh', 'final delivery']) {
  test(`auto progress suppresses ${phase} edits after local revocation`, { timeout: 10_000 }, async t => {
    const tick = clock(t), f = fixture(t, { progress: 'auto', senderPolicy: 'allowlist' })
    const host = holdHost(f)
    f.enqueue()
    const running = runObserved(f)
    try {
      await host.entered
      await tick(450)
      assert.equal(f.profiles.length, 1)
      assert.equal(f.posts.length, 1, 'establish a real progress-card receipt before revoking access')
      assert.equal(f.posts[0].body.payload.type, 17)
      assert.match(f.posts[0].body.payload.plain, /DSH/)
      assert.deepEqual(progressWrites(f), [1, 0, 0])
      if (phase === 'periodic refresh') {
        f.reconfigure({ allowed: new Set() })
        await tick(5500)
        assert.deepEqual(progressWrites(f), [1, 0, 0], 'the scheduled edit must be suppressed')
      } else {
        // Allow the host-final check and revoke only after durable ready output.
        f.onReady = () => f.reconfigure({ allowed: new Set() })
      }
      host.release()
      assert.equal(await running, undefined)
      if (phase === 'final delivery') {
        assert.equal(f.readyRows.length, 1)
        assert.deepEqual(f.finishes.map(item => item.outcome), ['stopped'])
      }
      await tick(8000)
      assert.deepEqual(progressWrites(f), [1, 0, 0], 'no terminal edit, final message or typing after revocation')
      stopped(f)
    } finally {
      host.release()
      f.controller.abort()
      await running
    }
  })
}

test('authorized auto progress still creates a card and performs the terminal edit', { timeout: 10_000 }, async t => {
  const tick = clock(t), f = fixture(t, { progress: 'auto' })
  const host = holdHost(f)
  f.enqueue()
  const running = runObserved(f)
  try {
    await host.entered
    await tick(450)
    assert.equal(f.posts.length, 1)
    host.release()
    assert.equal(await running, undefined)
    healthy(f)
    assert.deepEqual(f.posts.map(call => call.body.payload.type), [17, 1])
    assert.equal(f.edits.length, 1, 'the positive control must exercise a real terminal edit')
    assert.equal(f.edits[0].body.message_id, '901')
    assert.match(JSON.parse(f.edits[0].body.content_edit).plain, /回复已发送/)
    assert.equal(f.job().state, 'sent')
    assert.equal(f.job().result_id, '902')
  } finally {
    host.release()
    f.controller.abort()
    await running
  }
})

test('owner mutation after host final invalidates output even when effective tool access remains admitted', async t => {
  const f = fixture(t, { toolScope: 'admitted' })
  f.onReady = () => { f.config.ownerUid = 'bob' }
  f.enqueue()
  await f.process()
  assert.equal(f.hostCalls[0].allowed, true)
  assert.equal(authorizedTools(f.config, f.job()), true)
  assert.equal(f.posts.length, 0)
  stopped(f)
})

test('restarted ready reply rejects a changed owner obtained from real client verification', async t => {
  const f = fixture(t, { senderPolicy: 'allowlist' })
  await persistReady(f)
  f.restart({})
  f.verifiedOwner = 'bob'
  // Keep Worker.run's verification and ownership assignment; replace only the
  // subsequent endless websocket loop with processing our one persisted job.
  f.worker.runRealtime = signal => f.worker.process(f.store.next(Date.now()), signal)
  await f.worker.run(f.controller.signal)
  assert.equal(f.verifications.length, 1)
  assert.equal(f.worker.config.ownerUid, 'bob')
  assert.equal(f.hostCalls.length, 1)
  assert.equal(f.posts.length, 0)
  stopped(f)
})

for (const transition of ['reconfigure', 'restart']) {
  test(`ready reply rejects reduced per-sender tool access after ${transition} while chat stays admitted`, async t => {
    const f = fixture(t, { senderPolicy: 'allowlist', ownerUid: 'bob' })
    await persistReady(f)
    assert.equal(f.hostCalls[0].allowed, true)
    f[transition]({ senderPolicy: 'octo' })
    assert.equal(permitsRoute(f.config, 'alice', 1, 'alice'), true)
    assert.equal(authorizedTools(f.config, f.job()), false)
    await f.process()
    assert.equal(f.hostCalls.length, 1)
    assert.equal(f.posts.length, 0)
    stopped(f)
  })

  test(`ready topic reply rejects changed threadRuleMode after ${transition}`, async t => {
    const f = fixture(t)
    f.route = { channelType: 5, channelId: topic }
    await persistReady(f)
    f[transition]({ threadRuleMode: 'inherit-group' })
    await f.process()
    assert.equal(f.hostCalls.length, 1)
    assert.equal(f.posts.length, 0)
    stopped(f)
  })
}

test('ready DM text remains deliverable after thread-rule and media-only settings change', async t => {
  const f = fixture(t)
  await persistReady(f)
  f.reconfigure({ threadRuleMode: 'inherit-group', mediaUploadOrigins: [], mediaDownloadOrigins: [], mediaMaxBytes: 1 })
  await f.process()
  healthy(f)
  assert.deepEqual(f.posts.map(call => call.body.payload), [{ type: 1, content: answer }])
  assert.equal(f.job().state, 'sent')
  assert.equal(f.hostCalls.length, 1)
})

test('turn does not pass fetched parent rules to the host after inheritance is disabled', async t => {
  const f = fixture(t, { threadRuleMode: 'inherit-group' })
  f.route = { channelType: 5, channelId: topic }
  f.hooks.rules = ({ path }) => {
    if (!path.includes('/threads/')) f.reconfigure({ threadRuleMode: 'thread-only' })
  }
  f.enqueue()
  await f.process()
  healthy(f)
  assert.equal(f.hostCalls.length, 0)
  assert.equal(f.posts.length, 0)
  stopped(f)
})

for (const invalid of [undefined, 'invalid-digest']) {
  test(`legacy ready reply with ${invalid === undefined ? 'missing' : 'invalid'} deliveryProfile is held for review`, async t => {
    const f = fixture(t)
    f.enqueue()
    const metadata = invalid === undefined ? undefined : { deliveryProfile: invalid }
    f.store.ready(f.job().seq, answer, metadata)
    f.store.recordDelivery(f.job().seq, '899')
    f.restart({})
    await f.process()
    assert.equal(f.hostCalls.length, 0)
    assert.equal(f.posts.length, 0)
    stopped(f, '899', 'delivery_profile_unavailable')
  })

  test(`ready file reply with ${invalid === undefined ? 'missing' : 'invalid'} deliveryMediaProfile is held for review`, async t => {
    const f = fixture(t)
    f.files = ['first.txt']
    await persistReady(f)
    const metadata = JSON.parse(f.job().metadata)
    if (invalid === undefined) delete metadata.deliveryMediaProfile
    else metadata.deliveryMediaProfile = invalid
    f.store.ready(f.job().seq, answer, metadata)
    f.restart({})
    await f.process()
    assert.equal(f.hostCalls.length, 1)
    assert.equal(f.presigns.length, 0)
    assert.equal(f.puts.length, 0)
    assert.equal(f.posts.length, 0)
    stopped(f, null, 'delivery_profile_unavailable')
  })
}

const mediaChanges = [
  ['upload origins', { mediaUploadOrigins: ['https://other-storage.example.invalid'] }],
  ['download origins', { mediaDownloadOrigins: ['https://other-cdn.example.invalid'] }],
  ['upload size limit', { mediaMaxBytes: 1 }],
]
for (const phase of ['presign', 'put']) for (const [name, changes] of mediaChanges) {
  test(`media policy: changed ${name} during ${phase} blocks remaining delivery`, async t => {
    const f = fixture(t)
    f.files = ['first.txt']
    let changed = 0
    f.hooks[phase] = () => { changed++; f.reconfigure(changes) }
    f.enqueue()
    await f.process()
    assert.equal(changed, 1)
    assert.equal(f.presigns.length, 1)
    assert.equal(f.puts.length, phase === 'put' ? 1 : 0)
    assert.equal(f.posts.length, 0)
    stopped(f)
  })
}

for (const phase of ['presign', 'put']) {
  test(`media origin reorder and explicit default size during ${phase} preserve delivery`, async t => {
    const extraUpload = 'https://other-storage.example.invalid', extraDownload = 'https://other-cdn.example.invalid'
    const f = fixture(t, { mediaUploadOrigins: [storage, extraUpload], mediaDownloadOrigins: [cdn, extraDownload] })
    f.files = ['first.txt']
    f.hooks[phase] = () => f.reconfigure({ mediaUploadOrigins: [extraUpload, storage],
      mediaDownloadOrigins: [extraDownload, cdn], mediaMaxBytes: 16 * 1024 * 1024 })
    f.enqueue()
    await f.process()
    healthy(f)
    assert.equal(f.presigns.length, 1)
    assert.equal(f.puts.length, 1)
    assert.deepEqual(f.posts.map(call => call.body.payload.type), [8, 1])
    assert.equal(f.job().state, 'sent')
    assert.equal(f.job().issue, null)
    assert.equal(f.job().result_id, '902')
  })
}
