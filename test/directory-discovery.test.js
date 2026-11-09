import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { InboxRecovery } from '../src/inbox.js'
import { OctoClient } from '../src/octo.js'
import { DirectoryDiscovery } from '../src/directory-discovery.js'

const a = 'a'.repeat(32), b = 'b'.repeat(32), topic = a + '____123456789012345'
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'octo-directory-'))
  const f = { directory, groups: [], rows: [], calls: [], online: false, paused: false }
  f.config = { apiBase: 'https://directory.invalid/api', token: 'bf_fixture', botUid: 'bot', spaceId: 'space',
    allowed: new Set(['alice']), groups: new Set([a, b]), threads: new Set([topic]),
    transport: 'websocket', mentionPolicy: 'octo', channelPolicy: 'allowlist' }
  f.api = new OctoClient({ ...f.config, fetchImpl: async (_url, init) => {
    if (new URL(_url).pathname.endsWith('/mention_pref')) {
      return Response.json({ effective: true, group_allow_no_mention: 1 })
    }
    const query = JSON.parse(init.body)
    const rows = f.rows.filter(row => row.channel_id === query.channel_id).sort((x, y) => x.message_seq - y.message_seq)
    return Response.json({ messages: query.pull_mode === 0 ? rows.slice(-1) : rows.filter(row =>
      row.message_seq >= query.start_message_seq && (!query.end_message_seq || row.message_seq < query.end_message_seq)).slice(0, 100) })
  } })
  // Permission HTTP contracts have separate real-client tests. These fixtures
  // isolate the durable scheduling/history behavior without a second server.
  f.api.inboxDirectoryAccess = async () => true
  f.api.inboxDirectoryGroups = async () => { f.calls.push('groups'); return f.groups }
  f.api.inboxDirectoryPage = async (_config, group, page) => {
    f.calls.push([group, page])
    return f.page ? f.page(group, page) : { routes: [{ channel_type: 2, channel_id: group },
      ...(group === a ? [{ channel_type: 5, channel_id: topic }] : [])], nextPage: null }
  }
  const open = () => {
    f.store = new Store(directory, 'directory-fixture')
    f.discovery = new DirectoryDiscovery({ api: f.api, store: f.store, config: () => f.config,
      online: () => f.online, paused: () => f.paused, log() {} })
    f.inbox = new InboxRecovery({ api: f.api, store: f.store, config: () => f.config, log() {},
      accept: (id, message) => f.store.add(id, message) })
    f.inbox.connection(true)
  }
  open()
  f.timestamp = Math.floor(Date.now() / 1000) + 2
  f.wire = (seq, route = a, timestamp = f.timestamp) => ({ message_id: (route === topic ? '9' : '8') + seq,
    message_seq: seq, channel_type: route === topic ? 5 : 2, channel_id: route, from_uid: 'alice', timestamp,
    payload: { type: 1, content: 'no mention ' + seq } })
  f.sweep = () => f.discovery.sweep(t.signal)
  f.jobs = () => f.store.db.prepare('SELECT message_id,input,channel_type,ambient FROM jobs ORDER BY seq').all()
  f.restart = () => { f.store.close(); open() }
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }) })
  return f
}

test('unknown no-mention group/topic routes recover current post-activation history with no WS or events', async t => {
  const f = fixture(t)
  await f.sweep()
  assert.ok(f.store.directoryRecovery().startedAt > 0)
  assert.deepEqual(f.calls, [])
  f.online = true; f.groups = [a]
  await f.sweep()
  assert.equal(f.store.directoryRecovery().ready, true)
  assert.equal(f.store.inboxRoute(2, a).floor_seq, 0)
  assert.equal(f.store.inboxRoute(5, topic).floor_seq, 0)
  assert.deepEqual(f.jobs(), [])
  f.rows = [f.wire(1, a, f.timestamp - 60), f.wire(2), f.wire(3, topic, f.timestamp - 60), f.wire(4, topic)]
  f.restart()
  await f.inbox.sweep(t.signal)
  assert.deepEqual(f.jobs().map(row => [row.message_id, row.channel_type, row.ambient]), [['82', 2, 1], ['94', 5, 1]])
  f.inbox.connection(false); f.inbox.connection(true)
  await f.inbox.sweep(t.signal)
  assert.equal(f.jobs().length, 2)
})

test('first activation preserves existing routes; a later live intake race gets a bounded prefix without changing its old higher range', async t => {
  const f = fixture(t)
  const received = { messageId: '900', messageSeq: 100, sender: 'alice', channelType: 2, channelId: b, text: 'known' }
  f.inbox.receive('ws:900', received)
  await f.sweep()
  const baseline = { ...f.store.inboxRoute(2, b) }
  f.inbox.receive('ws:810', { ...received, messageId: '810', messageSeq: 10, channelId: a, text: 'accepted live' })
  f.groups = [a, b]; f.online = true
  await f.sweep(); await f.sweep()
  assert.equal(f.store.inboxRoute(2, b).floor_seq, baseline.floor_seq)
  const expanded = f.store.inboxRoute(2, a)
  assert.equal(expanded.prefix_until_seq, 9)
  assert.ok(expanded.prefix_since_ms > 0)
  assert.equal(expanded.since_ms, 0)
  f.rows = [f.wire(8, a, f.timestamp - 60), f.wire(9), f.wire(10, a, f.timestamp - 60)]
  await f.inbox.sweep(t.signal)
  assert.ok(f.jobs().some(row => row.message_id === '89'))
  assert.ok(f.jobs().some(row => row.message_id === '810'))
  assert.ok(!f.jobs().some(row => row.message_id === '88'))
})

test('directory pagination is fair across groups and persists across restart', async t => {
  const f = fixture(t); f.online = true; f.groups = [a, b]
  f.page = (group, page) => ({ routes: [], nextPage: group === a && page === 1 ? 2 : null })
  await f.sweep()
  f.restart()
  await f.sweep(); await f.sweep()
  assert.deepEqual(f.calls, ['groups', [a, 1], [b, 1], [a, 2]])
  assert.equal(f.store.directoryRecovery().ready, true)
  await f.sweep()
  assert.equal(f.calls.length, 4, 'do not restart a completed catalog every tick')
})

test('one unavailable group does not prevent other group discovery', async t => {
  const f = fixture(t); f.online = true; f.groups = [a, b]
  f.page = group => {
    if (group === a) throw new Error('unavailable')
    return { routes: [{ channel_type: 2, channel_id: b }], nextPage: null }
  }
  await f.sweep()
  assert.equal(f.store.directoryRecovery().failed, true, 'partial failures must be visible before the catalog finishes')
  await f.sweep()
  assert.equal(f.store.directoryRecovery().failed, true)
  assert.equal(f.store.directoryRecovery().ready, false)
  assert.equal(f.store.directoryRecovery().pendingGroups, 1, 'failed group retains its unfinished page')
  assert.ok(f.store.inboxRoute(2, b))
  assert.equal(f.store.inboxRoute(2, a), undefined)
})

for (const change of ['config', 'offline', 'pause']) test('a stale directory page cannot seed routes after ' + change, async t => {
  const f = fixture(t); f.online = true; f.groups = [a]
  f.page = () => {
    if (change === 'config') f.config = { ...f.config, mentionPolicy: 'required' }
    if (change === 'offline') f.online = false
    if (change === 'pause') f.paused = true
    return { routes: [{ channel_type: 2, channel_id: a }], nextPage: null }
  }
  await f.sweep()
  assert.equal(f.store.inboxRoute(2, a), undefined)
  assert.equal(f.store.directoryRecovery().pendingGroups, 1)
})

for (const invalid of [
  { routes: [{ channel_type: 1, channel_id: 'alice' }], nextPage: null },
  { routes: [{ channel_type: 2, channel_id: b }], nextPage: null },
  { routes: [], nextPage: 1 },
]) test('invalid or cross-group directory results do not seed any inbox route', async t => {
  const f = fixture(t); f.online = true; f.groups = [a]; f.page = () => invalid
  await f.sweep()
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_routes').get().n, 0)
  assert.equal(f.store.directoryRecovery().failed, true)
})

for (const overrides of [{ botKind: 'app' }, { transport: 'events' }, { mentionPolicy: 'required' }]) {
  test('unsupported discovery mode makes no calls and does not activate: ' + JSON.stringify(overrides), async t => {
    const f = fixture(t); f.online = true; f.config = { ...f.config, ...overrides }
    await f.sweep()
    assert.deepEqual(f.calls, [])
    assert.equal(f.store.directoryRecovery().startedAt, 0)
  })
}
