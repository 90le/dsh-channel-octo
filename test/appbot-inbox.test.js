import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { admit, OctoClient } from '../src/octo.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const route = { channel_type: 1, channel_id: 'human' }
const humanPath = '/v1/bot/users/batch'
const syncPath = '/v1/bot/messages/sync'
const exactPath = id => '/v1/bot/messages/person/human/' + id
const options = { timeout: 5000 }

// Real App authorization, inbox recovery and SQLite writes; only HTTP and the
// model host are synthetic. Assertions stay outside caught API callbacks.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'octo-appbot-inbox-'))
  const f = { root, calls: [], trace: [], runs: [], sends: [], logs: [], unexpected: [], hooks: {},
    people: { users: [{ uid: 'human', status: 1, robot: 0 }], missing_uids: [] },
    rows: [], exact: new Map(), denied: new Map(), controller: new AbortController() }
  f.config = { apiBase: 'https://app-inbox.invalid', token: 'app_synthetic_inbox',
    botUid: 'app_fixture_bot', botKind: 'app', spaceId: null, ownerUid: 'human',
    senderPolicy: 'allowlist', channelPolicy: 'allowlist', mentionPolicy: 'required',
    allowed: new Set(['human']), groups: new Set(), threads: new Set(), transport: 'websocket',
    toolPermission: 'text-only', toolScope: 'owner', sendMode: 'queue', progress: 'off', cwd: root }
  f.wire = (seq, text = 'Synthetic App request ' + seq) => ({
    message_id: String(1000 + seq), message_seq: seq, ...route, from_uid: 'human',
    payload: { type: 1, content: text, space_id: 'server-managed-space' },
  })
  f.store = new Store(root, 'synthetic-app-inbox')
  f.jobs = () => f.store.db.prepare('SELECT * FROM jobs ORDER BY seq').all()
  const stage = f.store.stageInbox.bind(f.store), add = f.store.add.bind(f.store)
  f.store.stageInbox = (event, message, ...args) => {
    f.trace.push({ stage: event, messageId: message.messageId })
    return stage(event, message, ...args)
  }
  f.store.add = (event, message) => {
    f.trace.push({ job: event, messageId: message.messageId })
    return add(event, message)
  }
  f.api = new OctoClient({ ...f.config, fetchImpl: async (url, init) => {
    const parsed = new URL(url)
    const call = { path: parsed.pathname, method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined }
    f.calls.push(call); f.trace.push(call)
    if (parsed.origin !== f.config.apiBase) {
      f.unexpected.push(parsed.origin); return new Response(null, { status: 500 })
    }
    if (call.path === humanPath) return Response.json(f.people)
    if (call.path === syncPath) {
      await f.hooks.sync?.(call)
      const q = call.body, rows = [...f.rows].sort((a, b) => a.message_seq - b.message_seq)
      const messages = q.pull_mode === 0 ? rows.slice(-q.limit)
        : rows.filter(row => row.message_seq >= q.start_message_seq
          && (!q.end_message_seq || row.message_seq < q.end_message_seq)).slice(0, q.limit)
      return Response.json({ messages })
    }
    if (call.path.startsWith('/v1/bot/messages/person/human/')) {
      const id = call.path.split('/').at(-1)
      await f.hooks.exact?.(id)
      if (f.denied.has(id)) return new Response(null, { status: f.denied.get(id) })
      const row = f.exact.get(id) ?? f.rows.find(item => item.message_id === id)
      return row ? Response.json(row) : new Response(null, { status: 404 })
    }
    if (call.path === '/v1/bot/readReceipt') return Response.json({ status: 200 })
    if (call.path === '/v1/bot/sendMessage') {
      f.sends.push(call); return Response.json({ message_id: '8001' })
    }
    f.unexpected.push(call.path)
    return new Response(null, { status: 500 })
  } })
  f.worker = new Worker({ api: f.api, store: f.store, config: f.config, log: issue => f.logs.push(issue),
    host: { async run(_session, input, created, _signal, _rules, _stage, _timeout, tools) {
      f.runs.push({ input, tools }); await created(); return 'Synthetic App answer.'
    } } })
  f.enrol = (seq = 10) => f.store.enrolInbox(admit({ message: f.wire(seq) }, f.config), true)
  f.sweep = async () => {
    f.worker.inbox.connection(true)
    await f.worker.inbox.sweep(f.controller.signal)
  }
  t.after(() => {
    try { f.controller.abort(); f.store.close() }
    finally {
      assert.equal(resolve(dirname(root)), resolve(tmpdir()))
      assert.ok(basename(root).startsWith('octo-appbot-inbox-'))
      rmSync(root, { recursive: true, force: true })
    }
    assert.deepEqual(f.unexpected, [], 'only the expected Bot endpoints may be used')
  })
  return f
}

function assertHeldWithoutWork(f) {
  assert.deepEqual(f.jobs(), [])
  assert.deepEqual(f.store.stagedInbox(route), [])
  assert.equal(f.store.inboxRoute(1, 'human').blocked, 1)
  assert.equal(f.store.inboxRoute(1, 'human').failed, 1)
  assert.equal(f.store.inboxRoute(1, 'human').checkpoint, 9)
  assert.equal(f.trace.some(item => item.stage?.startsWith('history:')), false)
  assert.equal(f.runs.length, 0)
  assert.equal(f.sends.length, 0)
}

test('App coalesced initial RECV stays blocked until human, sync and exact-message checks precede jobs', options, async t => {
  const f = fixture(t), wire = f.wire(10)
  f.rows = [wire]
  // CONNACK and RECV can share a frame: receive runs before connection(true).
  const live = admit({ message: wire }, f.config)
  assert.ok(live)
  f.worker.inbox.receive('ws:' + wire.message_id, live)
  assert.equal(f.worker.inbox.online, false)
  assert.equal(f.store.inboxRoute(1, 'human').blocked, 1)
  assert.equal(f.store.stagedInbox(route).length, 1, 'live receipt is durable before a transport ACK')
  assert.deepEqual(f.jobs(), [])
  assert.deepEqual(f.calls, [])
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  let first = true
  f.hooks.exact = async () => {
    if (first) { first = false; entered.resolve(); await released.promise }
  }
  const sweeping = f.sweep()
  try {
    await Promise.race([entered.promise, sweeping.then(() => assert.fail('exact-message authorization was never reached'))])
    assert.deepEqual(f.jobs(), [], 'an awaited Space guard cannot expose a queued job')
    assert.equal(f.trace.some(item => item.stage?.startsWith('history:')), false)
    assert.deepEqual(f.calls.map(call => call.path), [humanPath, syncPath, humanPath, syncPath, exactPath('1010')])
  } finally { released.resolve() }
  await sweeping
  assert.equal(f.jobs().length, 1)
  assert.equal(f.jobs()[0].input, wire.payload.content)
  assert.equal(f.jobs()[0].state, 'queued')
  assert.equal(f.store.inboxRoute(1, 'human').blocked, 0)
  assert.deepEqual(f.store.stagedInbox(route), [])
  const exact = f.trace.findIndex(item => item.path === exactPath('1010'))
  assert.ok(f.trace.findIndex(item => item.stage === 'history:1010') > exact)
  assert.ok(f.trace.findIndex(item => item.job) > exact)
  for (let i = 0; i < f.calls.length; i++) if (f.calls[i].path === syncPath) {
    assert.equal(f.calls[i - 1].path, humanPath, 'each App history query refreshes active-human identity')
    assert.deepEqual(f.calls[i - 1].body, { uids: ['human'] })
  }
  assert.equal(f.runs.length, 0)
  await f.worker.process(f.jobs()[0], f.controller.signal)
  assert.deepEqual(f.runs, [{ input: wire.payload.content, tools: true }])
  assert.equal(f.sends.length, 1)
})

for (const status of [403, 404]) test(`App exact-message ${status} cannot stage any row from a history page`, options, async t => {
  const f = fixture(t)
  f.rows = [f.wire(10), f.wire(11, 'FOREIGN_SPACE_BODY')]
  f.rows[1].payload.space_id = 'outside-app-scope'
  f.denied.set('1011', status)
  f.enrol()
  await f.sweep()
  assertHeldWithoutWork(f)
  assert.deepEqual(f.calls.filter(call => call.path.startsWith('/v1/bot/messages/person/')).map(call => call.path),
    [exactPath('1010'), exactPath('1011')])
  assert.equal(f.store.inboxSeen('1010'), false, 'an earlier valid row cannot partially commit the denied page')
  assert.equal(f.store.inboxSeen('1011'), false)
})

for (const [name, people] of [
  ['inactive', { users: [{ uid: 'human', status: 0, robot: 0 }], missing_uids: [] }],
  ['robot', { users: [{ uid: 'human', status: 1, robot: 1 }], missing_uids: [] }],
  ['coerced status', { users: [{ uid: 'human', status: '1', robot: 0 }], missing_uids: [] }],
  ['coerced robot', { users: [{ uid: 'human', status: 1, robot: '0' }], missing_uids: [] }],
  ['wrong identity', { users: [{ uid: 'other', status: 1, robot: 0 }], missing_uids: [] }],
  ['missing', { users: [], missing_uids: ['human'] }],
]) test(`App ${name} human makes zero history requests even under a local allowlist`, options, async t => {
  const f = fixture(t)
  f.people = people; f.rows = [f.wire(10)]; f.enrol()
  await f.sweep()
  assertHeldWithoutWork(f)
  assert.deepEqual(f.calls.map(call => call.path), [humanPath])
})

test('App human revocation between tip and forward page prevents the next history read', options, async t => {
  const f = fixture(t)
  f.rows = [f.wire(10)]; f.enrol()
  f.hooks.sync = async () => { f.people.users[0].status = 0 }
  await f.sweep()
  assertHeldWithoutWork(f)
  assert.deepEqual(f.calls.map(call => call.path), [humanPath, syncPath, humanPath])
})

for (const [name, alter] of [
  ['different sequence', row => ({ ...row, message_seq: 11 })],
  ['different ID', row => ({ ...row, message_id: '9999' })],
  ['different author', row => ({ ...row, from_uid: 'app_fixture_bot' })],
  ['foreign route', row => ({ ...row, channel_id: 'other' })],
  ['hidden', row => ({ ...row, payload: { ...row.payload, visibles: ['other'] } })],
  ['revoked', row => ({ ...row, message_extra: { revoke: 1 } })],
]) test(`App exact-message ${name} keeps sync content out of persistence and execution`, options, async t => {
  const f = fixture(t), row = f.wire(10)
  f.rows = [row]; f.exact.set('1010', alter(row)); f.enrol()
  await f.sweep()
  assertHeldWithoutWork(f)
  assert.equal(f.calls.at(-1).path, exactPath('1010'))
})

for (const [name, target, noChannel] of [
  ['group', { channel_type: 2, channel_id: 'a'.repeat(32) }],
  ['topic', { channel_type: 5, channel_id: 'a'.repeat(32) + '____123456789012345' }],
  ['self', { channel_type: 1, channel_id: 'app_fixture_bot' }],
  ['missing channel guard', route, true],
]) test(`App inbox rejects ${name} before HTTP`, options, async t => {
  const f = fixture(t)
  if (noChannel) f.api.channel = undefined
  await assert.rejects(f.api.inboxPage(f.config, target, 0, undefined, f.controller.signal))
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.jobs(), [])
  assert.equal(f.runs.length, 0)
})
