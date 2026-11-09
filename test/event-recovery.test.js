import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'
import { OctoClient } from '../src/octo.js'

function fixture(t, type = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'octo-event-recovery-'))
  const group = 'a'.repeat(32), id = type === 1 ? 'alice' : group + (type === 5 ? '____123456789012345678' : '')
  const f = { directory, events: [], rows: [], acks: [], route: { channel_type: type, channel_id: id } }
  f.config = { apiBase: 'https://event-recovery.invalid/api', token: 'bf_fixture', botUid: 'bot', spaceId: 'space',
    allowed: new Set(['alice']), groups: new Set([group]), threads: new Set([id]), transport: 'websocket',
    ownerUid: 'alice', toolPermission: 'workspace-write', toolScope: 'owner',
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/messages/sync'))
      const query = JSON.parse(init.body)
      const rows = f.rows.filter(row => row.channel_type === query.channel_type).sort((a, b) => a.message_seq - b.message_seq)
      return Response.json({ messages: query.pull_mode === 0 ? rows.slice(-1) : rows.filter(row =>
        row.message_seq >= query.start_message_seq && (!query.end_message_seq || row.message_seq < query.end_message_seq)).slice(0, query.limit) })
    } }
  f.api = new OctoClient(f.config)
  f.api.events = async (_signal, cursor) => f.events.filter(row => BigInt(row.event_id) > BigInt(cursor)).slice(0, 20)
  f.api.ack = async id => { if (f.failAck) throw new Error('unconfirmed ACK'); f.acks.push(id) }
  const open = () => {
    f.store = new Store(directory, 'event-recovery-fixture')
    f.worker = new Worker({ api: f.api, store: f.store, config: f.config, host: {}, log() {} })
    f.worker.inbox.connection(true)
  }
  open()
  f.timestamp = Math.floor(Date.now() / 1000) + 2
  f.message = (seq, text = 'event body must not execute', timestamp = f.timestamp) => ({
    message_id: String(seq), message_seq: seq, from_uid: 'alice', ...f.route, timestamp,
    payload: { type: 1, content: text, ...(type !== 1 && { mention: { uids: ['bot'] } }) },
  })
  f.event = (eventId, seq, text, timestamp) => ({ event_id: eventId, message: f.message(seq, text, timestamp) })
  f.ingest = () => f.worker.ingest(t.signal, 'recover')
  f.sweep = () => f.worker.inbox.sweep(t.signal)
  f.restart = () => { f.store.close(); open() }
  f.jobs = () => f.store.db.prepare('SELECT message_id,input,state FROM jobs ORDER BY seq').all().map(row => ({ ...row }))
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }) })
  return f
}

for (const type of [1, 2, 5]) test('new offline route discovered from event, then current history drives work: ' + type, async t => {
  const f = fixture(t, type)
  await f.ingest() // Explicit initial empty queue establishes the recovery state.
  f.events = [f.event('200', 10)]
  f.rows = [f.message(10, 'current edited body')]
  await f.ingest()
  assert.deepEqual(f.acks, ['200'])
  assert.deepEqual(f.jobs(), [], 'event payload itself cannot create a task')
  assert.equal(f.store.inboxRoute(type, f.route.channel_id).blocked, 1)
  assert.ok(f.store.inboxRoute(type, f.route.channel_id).since_ms > 0)
  f.restart()
  await f.sweep()
  assert.deepEqual(f.jobs(), [{ message_id: '10', input: 'current edited body', state: 'queued' }])
})

test('initial old backlog and a late old message do not become commands; new lower ID can recover', async t => {
  const f = fixture(t), oldTime = f.timestamp - 60
  f.events = [f.event('100', 1, 'old command', oldTime)]
  await f.ingest()
  assert.equal(f.store.eventRecovery().ready, false)
  await f.ingest()
  assert.equal(f.store.eventRecovery().ready, true)
  f.events.push(f.event('50', 2, 'late old command', oldTime), f.event('60', 3))
  f.rows = [f.message(3, 'new message')]
  await f.ingest()
  assert.deepEqual(f.acks, ['60'])
  await f.sweep()
  assert.deepEqual(f.jobs().map(row => row.message_id), ['3'])
})

test('a known live route retains text-question ownership and is not injected by events', async t => {
  const f = fixture(t)
  await f.ingest()
  const input = { messageId: '10', messageSeq: 10, sender: 'alice', channelId: 'alice', channelType: 1, text: 'first' }
  f.worker.inbox.receive('ws:10', input)
  let answers = 0
  f.worker.questions.match = () => ({ key: 'live-question', sessionId: 'native-session' })
  f.worker.questions.text = () => { answers++ }
  f.events = [f.event('200', 11, 'answer')]
  await f.ingest()
  assert.equal(answers, 0)
  assert.deepEqual(f.acks, [])
  assert.equal(f.jobs().length, 1)
  f.worker.inbox.receive('ws:11', { ...input, messageId: '11', messageSeq: 11, text: 'answer' })
  assert.equal(answers, 1)
  f.worker.cursor = '0'
  await f.ingest()
  assert.deepEqual(f.acks, ['200'])
  assert.equal(answers, 1)
})

test('discovery and unconfirmed ACK survive restart without replaying the event body', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [f.event('200', 10)]; f.rows = [f.message(10, 'verified history')]
  f.failAck = true
  await f.ingest()
  assert.deepEqual(f.store.pendingMessageEventAcks(Date.now() + 60_000), ['200'])
  f.restart(); f.failAck = false
  f.store.db.prepare('UPDATE message_event_acks SET retry_ms=0 WHERE event_id=?').run('200')
  await f.ingest()
  assert.equal(f.store.pendingMessageEventAcks().length, 0)
  assert.deepEqual(f.jobs(), [])
  await f.sweep()
  assert.equal(f.jobs().length, 1)
  assert.equal(f.jobs()[0].input, 'verified history')
})

test('one failed event ACK does not block other discoveries or event scanning', async t => {
  const f = fixture(t)
  await f.ingest()
  const ack = f.api.ack
  f.api.ack = async (id, signal) => { if (id === '200') throw new Error('isolated ACK failure'); return ack(id, signal) }
  f.events = [f.event('200', 10)]
  await f.ingest()
  const other = f.event('201', 20)
  other.message.from_uid = 'bob'; other.message.channel_id = 'bob'
  f.config.allowed.add('bob'); f.events.push(other)
  await f.ingest()
  assert.ok(f.store.inboxRoute(1, 'bob'))
  assert.ok(f.acks.includes('201'))
  assert.equal(f.worker.cursor, '201')
  assert.deepEqual(f.store.pendingMessageEventAcks(Date.now() + 60_000), ['200'])
})

test('a missing discovered message stays pending beyond the overlap window until current history contains it', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [f.event('200', 10)]; f.rows = [f.message(300, 'later message')]
  await f.ingest(); await f.sweep()
  assert.equal(f.store.inboxRoute(1, 'alice').checkpoint, 300)
  assert.equal(f.store.inboxRoute(1, 'alice').blocked, 1)
  assert.equal(f.store.inboxRoute(1, 'alice').failed, 1)
  assert.deepEqual(f.jobs(), [])
  f.restart()
  f.rows.unshift(f.message(10, 'late current history'))
  f.store.db.exec('UPDATE inbox_routes SET retry_ms=0')
  await f.sweep()
  assert.deepEqual(f.jobs().map(row => row.message_id), ['10', '300'])
  assert.equal(f.store.inboxRoute(1, 'alice').blocked, 0)
})

test('opening a disabled account database does not activate historical execution', async t => {
  const f = fixture(t)
  assert.equal(f.store.eventRecovery().startedAt, 0)
  const old = Math.floor(Date.now() / 1000) - 60
  f.events = [f.event('100', 1, 'pre-activation command', old)]
  await f.ingest(); await f.ingest(); await f.ingest()
  assert.ok(f.store.eventRecovery().startedAt > old * 1000)
  assert.deepEqual(f.jobs(), [])
  assert.equal(f.store.inboxRoute(1, 'alice'), undefined)
})

test('recovery scans use nonwaiting events requests so low steady traffic cannot hold bootstrap open', async t => {
  const f = fixture(t), cursors = []
  f.api.events = async (_signal, cursor, options) => {
    assert.deepEqual(options, { wait: 0 })
    cursors.push(cursor)
    return cursor === '0' && cursors.length === 1 ? [f.event('100', 1, 'old', f.timestamp - 60)] : []
  }
  await f.ingest(); await f.ingest()
  assert.equal(f.store.eventRecovery().ready, true)
  f.worker.eventRescanAt = 0
  await f.ingest()
  assert.equal(f.worker.cursor, '0')
})

test('revoked or missing current history does not execute the stale event body', async t => {
  for (const revoked of [false, true]) await t.test(String(revoked), async t => {
    const f = fixture(t)
    await f.ingest()
    f.events = [f.event('200', 10)]
    f.rows = revoked ? [{ ...f.message(10), revoke: 1 }] : []
    await f.ingest(); await f.sweep()
    assert.deepEqual(f.jobs(), [])
  })
})

test('newly discovered history enforces the fixed activation boundary on every row', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [f.event('200', 10)]
  f.rows = [f.message(10, 'backdated old command', f.timestamp - 60), f.message(11, 'new history')]
  await f.ingest(); await f.sweep()
  assert.deepEqual(f.jobs().map(row => row.message_id), ['11'])
  assert.equal(f.store.inboxSeen('10'), true)
})

test('unknown historical timestamps hold the route instead of executing unbounded old content', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [f.event('200', 10)]
  const row = f.message(10); delete row.timestamp; f.rows = [row]
  await f.ingest(); await f.sweep()
  assert.deepEqual(f.jobs(), [])
  assert.equal(f.store.inboxRoute(1, 'alice').failed, 1)
})

test('unrelated typed events are not ACKed and a lower-ID revisit preserves the forward cursor', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [{ event_id: '300', event_type: 'external_task', event_data: {} }]
  await f.ingest()
  f.events.push(f.event('200', 10)); f.rows = [f.message(10, 'late publication')]
  f.worker.eventRescanAt = 0
  await f.ingest()
  assert.equal(f.worker.cursor, '300')
  await f.sweep()
  assert.deepEqual(f.acks, ['200'])
  assert.equal(f.jobs().length, 1)
})

test('nonempty event streams have bounded bootstrap and interleaved lower-ID revisits without starving the tail', async t => {
  const f = fixture(t), requests = []
  let top = 99, published = []
  f.api.events = async (_signal, cursor, options) => {
    assert.deepEqual(options, { wait: 0 }); requests.push(cursor)
    for (let i = 0; i < 20; i++) published.push({ event_id: String(++top), event_type: 'external_task' })
    return published.filter(row => BigInt(row.event_id) > BigInt(cursor))
      .sort((a, b) => Number(BigInt(a.event_id) - BigInt(b.event_id))).slice(0, 20)
  }
  for (let i = 0; i < 20; i++) await f.ingest()
  assert.equal(f.store.eventRecovery().ready, true, 'initialization must not require an empty page')
  await f.ingest(); await f.ingest()
  const forward = BigInt(f.worker.cursor)
  published.push(f.event('50', 10)); f.rows = [f.message(10, 'late lower event')]
  f.worker.eventRescanAt = 0
  await f.ingest()
  assert.equal(BigInt(f.worker.cursor), forward)
  assert.ok(f.store.inboxRoute(1, 'alice'))
  assert.ok(f.worker.eventRevisit, 'prefix needs multiple pages')
  await f.ingest()
  assert.ok(BigInt(f.worker.cursor) > forward, 'next page must advance the live tail')
  for (let i = 0; i < 4 && f.worker.eventRevisit; i++) await f.ingest()
  assert.equal(f.worker.eventRevisit, undefined)
  assert.ok(requests.filter(cursor => cursor === '0').length >= 3)
  await f.sweep()
  assert.equal(f.jobs().length, 1)
  assert.deepEqual(f.acks, ['50'])
})

test('late lower channel sequence expands only a discovered time-bounded route without replaying completed work', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [f.event('300', 12)]; f.rows = [f.message(12, 'first visible')]
  await f.ingest(); await f.sweep()
  assert.deepEqual(f.jobs().map(row => row.message_id), ['12'])
  f.events.push(f.event('200', 11)); f.rows.unshift(f.message(11, 'late older sequence'))
  f.worker.cursor = '0'
  await f.ingest(); await f.sweep()
  assert.deepEqual(f.jobs().map(row => row.message_id), ['12', '11'])
  assert.equal(f.store.inboxRoute(1, 'alice').floor_seq, 10)
  f.worker.cursor = '0'; await f.ingest(); await f.sweep()
  assert.equal(f.jobs().length, 2)
})

for (const phase of ['tip', 'page', 'accept']) test('late discovery during ' + phase + ' preserves the rewind and holds work until the next sweep', async t => {
  const f = fixture(t)
  await f.ingest()
  f.events = [f.event('300', 300)]
  f.rows = [f.message(1, 'earlier current body'), f.message(300, 'later current body')]
  await f.ingest()
  let rewound = false, calls = 0
  const rewind = () => {
    if (rewound) return
    rewound = true
    assert.equal(f.store.seedInboxEvent('301', { messageId: '1', messageSeq: 1, channelType: 1, channelId: 'alice' }), true)
  }
  const page = f.api.inboxPage.bind(f.api), accept = f.worker.inbox.accept
  f.api.inboxPage = async (...args) => {
    const result = await page(...args)
    calls++
    if (phase === 'tip' && calls === 1 || phase === 'page' && calls === 2) rewind()
    return result
  }
  f.worker.inbox.accept = async (...args) => {
    const result = await accept(...args)
    if (phase === 'accept') rewind()
    return result
  }
  await f.sweep()
  assert.equal(rewound, true)
  assert.equal(f.store.inboxRoute(1, 'alice').checkpoint, 0)
  assert.equal(f.store.inboxRoute(1, 'alice').blocked, 1)
  assert.equal(f.store.next(Date.now()), undefined)
  await f.sweep()
  assert.deepEqual(f.jobs().map(row => row.message_id).sort(), ['1', '300'])
  assert.equal(f.store.inboxRoute(1, 'alice').blocked, 0)
  assert.equal(f.store.next(Date.now()).message_id, '1')
})
