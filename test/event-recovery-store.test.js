import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/store.js'

const now = 1_800_000_000_123
const maxId = '9223372036854775807'
const route = { channel_type: 1, channel_id: 'fixture-human' }
const message = (id = '101', seq = 41, channelId = route.channel_id) => ({
  messageId: id, messageSeq: seq, sender: 'fixture-human', channelType: 1, channelId,
  text: 'obsolete event body must not execute', timestamp: 1_800_000_001,
  attachment: { id: 'obsolete-file' }, command: '/obsolete',
})
const initial = () => ({ ready: false, baseline: '0', bootstrapCursor: '0', failed: false, startedAt: 0 })
const invalidIds = ['', '0', '-1', '+1', '01', ' 1', '1 ', '1.0', '1e3', '１２',
  '9223372036854775808', '99999999999999999999', 1, 9007199254740992, 1n, null, undefined, {}, NaN]

function fixture(t) {
  t.mock.method(Date, 'now', () => now)
  const root = mkdtempSync(join(tmpdir(), 'octo-event-recovery-store-'))
  let store = new Store(root, 'fixture-bot')
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }) })
  return {
    get store() { return store },
    reopen(legacyWrite) {
      store.close(); store = null
      if (legacyWrite) {
        const db = new DatabaseSync(join(root, 'channel.sqlite'))
        try { legacyWrite(db) } finally { db.close() }
      }
      store = new Store(root, 'fixture-bot')
      return store
    },
  }
}

function failWrite(store, table, operation = 'INSERT') {
  // Only test-owned tables and fixed operation names are passed here.
  store.db.exec(`CREATE TRIGGER fixture_failure BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END;`)
}

test('opening and reopening a Store does not activate recovery', t => {
  const f = fixture(t)
  assert.deepEqual(f.store.eventRecovery(), initial())
  f.store.add('ws:101', message())
  const job = f.store.db.prepare('SELECT * FROM jobs').get()
  t.mock.method(Date, 'now', () => now + 86_400_000)
  f.reopen()
  assert.deepEqual(f.store.eventRecovery(), initial())
  assert.deepEqual(f.store.db.prepare('SELECT * FROM jobs').get(), job)
  f.reopen()
  assert.equal(f.store.eventRecovery().startedAt, 0)
  const column = f.store.db.prepare('PRAGMA table_info(event_recovery)').all().find(row => row.name === 'started_at')
  assert.equal(column.dflt_value, '0')
})

test('first actual activation fixes the boundary and repeated starts preserve it', t => {
  const f = fixture(t), enabledAt = now + 86_400_000
  t.mock.method(Date, 'now', () => enabledAt)
  assert.equal(f.store.activateEventRecovery(), true)
  f.store.advanceEventBootstrap('201'); f.store.finishEventBootstrap()
  const activated = f.store.eventRecovery()
  assert.equal(activated.startedAt, enabledAt)
  f.reopen()
  assert.equal(f.store.activateEventRecovery(enabledAt + 86_400_000), false)
  assert.equal(f.store.activateEventRecovery(now), false)
  assert.deepEqual(f.store.eventRecovery(), activated)
})

test('invalid and failed activations leave no boundary, and existing positive boundaries survive', t => {
  const f = fixture(t)
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '123']) {
    assert.equal(f.store.activateEventRecovery(invalid), false)
  }
  failWrite(f.store, 'event_recovery', 'UPDATE')
  assert.throws(() => f.store.activateEventRecovery(now), /fixture write failed/)
  f.reopen()
  assert.deepEqual(f.store.eventRecovery(), initial())
  f.store.db.exec('DROP TRIGGER fixture_failure')
  f.reopen(db => db.prepare('UPDATE event_recovery SET started_at=? WHERE id=1').run(now - 1000))
  assert.equal(f.store.activateEventRecovery(now), false)
  assert.equal(f.store.eventRecovery().startedAt, now - 1000)
})

test('before-enable timestamps cannot activate recovery or seed a route', t => {
  const f = fixture(t), enabledAt = now + 86_400_000
  const old = { ...message(), timestamp: Math.floor((now + 3_600_000) / 1000) }
  t.mock.method(Date, 'now', () => enabledAt)
  f.reopen()
  f.store.advanceEventBootstrap('201'); f.store.finishEventBootstrap()
  for (const m of [old, { ...message(), timestamp: Math.floor(enabledAt / 1000) }]) {
    assert.equal(f.store.seedInboxEvent('201', m), false)
  }
  assert.equal(f.store.eventRecovery().startedAt, 0)
  assert.equal(f.store.inboxRoute(1, route.channel_id), undefined)
  assert.deepEqual(f.store.pendingInboxDiscoveries(route), [])
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  assert.equal(f.store.activateEventRecovery(), true)
  assert.equal(f.store.seedInboxEvent('202', message('102')), true)
  // History filtering uses this actual activation boundary, not Store creation.
  assert.equal(f.store.inboxRoute(1, route.channel_id).since_ms, enabledAt)
  assert.ok(old.timestamp * 1000 < f.store.inboxRoute(1, route.channel_id).since_ms)
})

test('bootstrap pages advance monotonically across restarts without publishing a partial baseline', t => {
  const f = fixture(t)
  for (const page of [['9', '10', '8'], ['99', '100', '99'], ['9007199254740992', '9007199254740993']]) {
    let cursor = BigInt(f.store.eventRecovery().bootstrapCursor)
    for (const id of page) {
      assert.equal(f.store.advanceEventBootstrap(id), BigInt(id) > cursor)
      if (BigInt(id) > cursor) cursor = BigInt(id)
      assert.equal(f.store.eventRecovery().baseline, '0')
    }
    f.reopen()
    assert.deepEqual(f.store.eventRecovery(), { ...initial(), bootstrapCursor: String(cursor) })
  }
  f.store.finishEventBootstrap()
  const completed = { ...initial(), ready: true, baseline: '9007199254740993', bootstrapCursor: '9007199254740993' }
  assert.deepEqual(f.store.eventRecovery(), completed)
  assert.equal(f.store.advanceEventBootstrap(maxId), false)
  f.store.finishEventBootstrap()
  f.reopen()
  assert.deepEqual(f.store.eventRecovery(), completed)
})

test('interrupted bootstrap writes retain the last committed cursor and can resume', t => {
  const f = fixture(t)
  f.store.advanceEventBootstrap('10')
  failWrite(f.store, 'event_recovery', 'UPDATE')
  assert.throws(() => f.store.advanceEventBootstrap('20'), /fixture write failed/)
  f.reopen()
  assert.deepEqual(f.store.eventRecovery(), { ...initial(), bootstrapCursor: '10' })
  f.store.db.exec('DROP TRIGGER fixture_failure')
  f.store.advanceEventBootstrap('20')
  f.store.finishEventBootstrap()
  assert.equal(f.store.eventRecovery().baseline, '20')
})

test('finish publishes ready and baseline atomically and rolls back a failed publication', t => {
  const f = fixture(t)
  f.store.advanceEventBootstrap(maxId)
  // A split ready/baseline update would violate this trigger even on a successful finish.
  f.store.db.exec(`CREATE TRIGGER require_atomic_finish BEFORE UPDATE ON event_recovery
    WHEN NEW.ready=1 AND NEW.baseline<>NEW.bootstrap_cursor
    BEGIN SELECT RAISE(ABORT, 'split publication'); END;
    CREATE TRIGGER fixture_failure AFTER UPDATE ON event_recovery
    BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END;`)
  assert.throws(() => f.store.finishEventBootstrap(), /fixture write failed/)
  f.reopen()
  assert.deepEqual(f.store.eventRecovery(), { ...initial(), bootstrapCursor: maxId })
  f.store.db.exec('DROP TRIGGER fixture_failure')
  f.store.finishEventBootstrap()
  assert.deepEqual(f.store.eventRecovery(), { ...initial(), ready: true, baseline: maxId, bootstrapCursor: maxId })
})

test('an empty bootstrap finishes at zero without changing its activation time', t => {
  const f = fixture(t)
  f.store.finishEventBootstrap(); f.reopen(); f.store.finishEventBootstrap()
  assert.deepEqual(f.store.eventRecovery(), { ...initial(), ready: true })
})

test('recovery failure flags persist and clear independently of cursor, baseline and startedAt', t => {
  const f = fixture(t)
  f.store.advanceEventBootstrap('42'); f.store.eventRecoveryFailed(true); f.reopen()
  assert.deepEqual(f.store.eventRecovery(), { ...initial(), bootstrapCursor: '42', failed: true })
  f.store.finishEventBootstrap(); f.store.eventRecoveryFailed(false); f.reopen()
  assert.deepEqual(f.store.eventRecovery(), { ...initial(), ready: true, baseline: '42', bootstrapCursor: '42' })
  f.store.eventRecoveryFailed(true); f.reopen()
  assert.equal(f.store.eventRecovery().failed, true)
})

test('invalid event IDs cannot advance, enqueue or complete an ACK', t => {
  const { store } = fixture(t)
  store.add('ws:101', message())
  assert.equal(store.queueMessageEventAck('1', '101'), true)
  for (const id of invalidIds) {
    assert.equal(store.advanceEventBootstrap(id), false)
    assert.equal(store.queueMessageEventAck(id, '101'), false)
    assert.equal(store.messageEventAckDue(id), false)
    store.messageEventAckFailed(id)
    store.messageEventAcked(id)
  }
  assert.deepEqual(store.eventRecovery(), initial())
  assert.deepEqual(store.pendingMessageEventAcks(), ['1'])
})

test('adjacent IDs above Number precision and the maximum int64 stay distinct TEXT values', t => {
  const f = fixture(t)
  f.store.add('ws:101', message())
  const ids = ['9007199254740992', '9007199254740993', maxId]
  for (const id of ids) {
    assert.equal(f.store.advanceEventBootstrap(id), true)
    assert.equal(f.store.queueMessageEventAck(id, '101'), true)
  }
  f.store.finishEventBootstrap(); f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids)
  assert.equal(f.store.eventRecovery().baseline, maxId)
  assert.ok(f.store.db.prepare('SELECT typeof(event_id) AS kind FROM message_event_acks').all().every(r => r.kind === 'text'))
  const types = f.store.db.prepare('SELECT typeof(baseline) AS baseline,typeof(bootstrap_cursor) AS cursor FROM event_recovery').get()
  assert.equal(types.baseline, 'text'); assert.equal(types.cursor, 'text')
  f.store.messageEventAcked(ids[0])
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids.slice(1))
})

for (const receipt of ['jobs', 'inbox_staged', 'inbox_seen']) {
  test(`ACK accepts a durable ${receipt} receipt after reopening`, t => {
    const f = fixture(t)
    if (receipt === 'jobs') f.store.add('ws:101', message())
    if (receipt === 'inbox_staged') f.store.stageInbox('ws:101', message(), true)
    if (receipt === 'inbox_seen') f.store.db.prepare('INSERT INTO inbox_seen(message_id) VALUES (?)').run('101')
    f.reopen()
    assert.equal(f.store.queueMessageEventAck('201', '101'), true)
    f.reopen()
    assert.deepEqual(f.store.pendingMessageEventAcks(), ['201'])
  })
}

test('unknown receipts, route presence and unrelated IDs never authorize an ACK', t => {
  const { store } = fixture(t)
  store.enrolInbox(message())
  store.add('999', message())
  store.bindCard({ messageId: '102', expiresAt: now + 60_000 })
  store.recordDelivery(store.next(now).seq, '103')
  for (const id of ['999', '102', '103', '', null, undefined, 101, {}, '404']) {
    assert.equal(store.queueMessageEventAck('201', id), false)
  }
  store.messageEventAcked('201')
  assert.deepEqual(store.pendingMessageEventAcks(), [])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_event_acks').get().n, 0)
})

test('duplicate mappings are idempotent and conflicting mappings stay rejected after ACK and restart', t => {
  const f = fixture(t)
  f.store.add('ws:101', message()); f.store.add('ws:102', message('102', 42))
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.equal(f.store.queueMessageEventAck('201', '102'), false)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['201'])
  f.store.messageEventAcked('201'); f.store.messageEventAcked('201'); f.reopen()
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.equal(f.store.queueMessageEventAck('201', '102'), false)
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM message_event_acks').get().n, 1)
  assert.equal(f.store.queueMessageEventAck('202', '101'), true)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['202'])
})

test('pending ACK reads return at most twenty strings and do not consume the queue', t => {
  const f = fixture(t)
  f.store.add('ws:101', message())
  const ids = Array.from({ length: 25 }, (_, i) => String(BigInt(maxId) - BigInt(i)))
  for (const id of ids) f.store.queueMessageEventAck(id, '101')
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids.slice(0, 20))
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids.slice(0, 20))
  for (const id of ids.slice(0, 20)) f.store.messageEventAcked(id)
  f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids.slice(20))
})

test('a lost external ACK response backs off through restart until completion is recorded', async t => {
  const f = fixture(t)
  f.store.add('ws:101', message()); f.store.queueMessageEventAck('201', '101')
  const flush = async ack => {
    for (const id of f.store.pendingMessageEventAcks()) {
      try { await ack(id); f.store.messageEventAcked(id) }
      catch { f.store.messageEventAckFailed(id) }
    }
  }
  const received = []
  await flush(async id => { received.push(id); throw new Error('fixture ACK response lost') })
  assert.deepEqual(received, ['201'])
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  f.reopen()
  assert.equal(f.store.messageEventAckDue('201', now + 999), false)
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.deepEqual(f.store.pendingMessageEventAcks(now + 999), [])
  t.mock.method(Date, 'now', () => now + 1000)
  const retried = []
  await flush(async id => { retried.push(id) })
  assert.deepEqual(retried, ['201'])
  f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
})

test('failed ACK batches give other mappings a turn and exact due checks ignore the batch limit', t => {
  const f = fixture(t)
  f.store.add('ws:101', message())
  const ids = Array.from({ length: 25 }, (_, i) => String(201 + i))
  for (const id of ids) f.store.queueMessageEventAck(id, '101')
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids.slice(0, 20))
  assert.equal(f.store.messageEventAckDue(ids[24]), true)
  assert.equal(f.store.messageEventAckDue('999'), false)
  f.store.messageEventAckFailed('999')
  for (const id of f.store.pendingMessageEventAcks()) f.store.messageEventAckFailed(id)
  f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), ids.slice(20))
  assert.equal(f.store.messageEventAckDue(ids[0]), false)
  assert.equal(f.store.messageEventAckDue(ids[0], now + 1000), true)
  // Untried mappings still precede retries when their due times coincide with a sweep.
  assert.deepEqual(f.store.pendingMessageEventAcks(now + 1000), [...ids.slice(20), ...ids.slice(0, 15)])
  for (const id of ids.slice(20)) f.store.messageEventAcked(id)
  f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(now + 1000), ids.slice(0, 20))
  assert.equal(f.store.messageEventAckDue(ids[24]), true) // Server duplicate can be re-ACKed.
  f.store.messageEventAckFailed(ids[24])
  assert.equal(f.store.queueMessageEventAck(ids[24], '101'), true)
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
})

test('ACK backoff grows to a bounded delay, survives requeue, and clears on completion', t => {
  const f = fixture(t)
  f.store.add('ws:101', message()); f.store.add('ws:102', message('102', 42))
  f.store.queueMessageEventAck('201', '101')
  let at = now
  for (const [i, delay] of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000].entries()) {
    f.store.messageEventAckFailed('201', at)
    const expected = { event_id: '201', message_id: '101', acked: 0, attempt: Math.min(i + 1, 7), retry_ms: at + delay }
    assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM message_event_acks').get() }, expected)
    assert.equal(f.store.queueMessageEventAck('201', '101'), true)
    assert.equal(f.store.queueMessageEventAck('201', '102'), false)
    f.reopen()
    assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM message_event_acks').get() }, expected)
    assert.deepEqual(f.store.pendingMessageEventAcks(at + delay - 1), [])
    assert.deepEqual(f.store.pendingMessageEventAcks(at + delay), ['201'])
    at += delay
  }
  f.store.messageEventAcked('201'); f.reopen()
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM message_event_acks').get() },
    { event_id: '201', message_id: '101', acked: 1, attempt: 0, retry_ms: 0 })
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.equal(f.store.queueMessageEventAck('201', '102'), false)
  assert.equal(f.store.messageEventAckDue('201', at), true)
  assert.deepEqual(f.store.pendingMessageEventAcks(at), [])
})

test('failed local ACK completion retains the retry obligation', t => {
  const f = fixture(t)
  f.store.add('ws:101', message()); f.store.queueMessageEventAck('201', '101')
  failWrite(f.store, 'message_event_acks', 'UPDATE')
  assert.throws(() => f.store.messageEventAcked('201'), /fixture write failed/)
  f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['201'])
  f.store.db.exec('DROP TRIGGER fixture_failure')
  f.store.messageEventAcked('201'); f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
})

test('receipt and ACK insertion participate in the caller transaction and roll back together', t => {
  const f = fixture(t)
  f.store.db.exec('BEGIN IMMEDIATE')
  f.store.add('ws:101', message())
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  f.store.db.exec('ROLLBACK'); f.reopen()
  assert.equal(f.store.queueMessageEventAck('201', '101'), false)
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  f.store.add('ws:101', message())
  failWrite(f.store, 'message_event_acks')
  assert.throws(() => f.store.queueMessageEventAck('201', '101'), /fixture write failed/)
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  f.store.db.exec('DROP TRIGGER fixture_failure')
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
})

test('seed discovers an unknown blocked route with a minimal receipt, fixed since_ms and no executable body', t => {
  const f = fixture(t), m = message()
  f.store.activateEventRecovery()
  t.mock.method(Date, 'now', () => now + 60_000)
  assert.equal(f.store.seedInboxEvent('201', m), true)
  const seeded = f.store.inboxRoute(1, m.channelId)
  assert.equal(seeded.floor_seq, 40); assert.equal(seeded.checkpoint, 40)
  assert.equal(seeded.blocked, 1); assert.equal(seeded.since_ms, now)
  const receipt = f.store.db.prepare('SELECT * FROM inbox_event_discoveries').get()
  assert.deepEqual({ ...receipt }, { event_id: '201', message_id: '101', channel_type: 1,
    channel_id: m.channelId, message_seq: 41 })
  assert.equal(f.store.inboxSeen('101'), false) // History must still fetch and evaluate it.
  assert.equal(f.store.hasPending(), false)
  assert.equal(f.store.next(now), undefined)
  assert.deepEqual(f.store.stagedInbox(route), [])
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['201'])
  f.reopen()
  assert.deepEqual(f.store.inboxRoute(1, m.channelId), seeded)
  assert.deepEqual(f.store.db.prepare('SELECT * FROM inbox_event_discoveries').get(), receipt)
  assert.equal(f.store.eventRecovery().startedAt, now)
  assert.equal(f.store.queueMessageEventAck('202', '101'), true)
  assert.equal(f.store.queueMessageEventAck('203', '404'), false)
})

test('seed leaves existing routes, floors, checkpoints and since_ms unchanged without claiming a new event', t => {
  const f = fixture(t), m = message()
  f.store.activateEventRecovery()
  f.store.enrolInbox(m)
  f.store.checkpointInbox(route, 60, [])
  const original = f.store.inboxRoute(1, m.channelId)
  assert.equal(original.since_ms, 0)
  assert.equal(f.store.seedInboxEvent('201', message('102', 1)), false)
  assert.equal(f.store.seedInboxEvent('202', message('103', 100)), false)
  assert.deepEqual(f.store.inboxRoute(1, m.channelId), original)
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  assert.equal(f.store.queueMessageEventAck('202', '103'), false)
  f.reopen()
  assert.deepEqual(f.store.inboxRoute(1, m.channelId), original)
})

test('seed rejects illegal sequences, event IDs and malformed routes without leaving receipts', t => {
  const { store } = fixture(t)
  store.activateEventRecovery()
  for (const seq of [0, -1, 1.5, '41', 41n, NaN, Infinity, 0x100000000, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.equal(store.seedInboxEvent('201', { ...message(), messageSeq: seq }), false)
  }
  for (const id of invalidIds) assert.equal(store.seedInboxEvent(id, message()), false)
  for (const patch of [{ messageId: '0' }, { messageId: '' }, { channelType: 3 }, { channelType: '1' },
    { channelId: '' }, { channelId: null }]) assert.equal(store.seedInboxEvent('201', { ...message(), ...patch }), false)
  assert.equal(store.seedInboxEvent('201', null), false)
  assert.equal(store.inboxRoute(1, route.channel_id), undefined)
  assert.deepEqual(store.pendingMessageEventAcks(), [])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM inbox_event_discoveries').get().n, 0)
  assert.equal(store.seedInboxEvent(maxId, message(maxId, 0xffffffff)), true)
  assert.equal(store.inboxRoute(1, route.channel_id).floor_seq, 0xfffffffe)
})

for (const table of ['inbox_event_discoveries', 'message_event_acks']) {
  test(`seed transaction rolls back route and discovery when ${table} cannot be written`, t => {
    const f = fixture(t)
    f.store.activateEventRecovery()
    failWrite(f.store, table)
    assert.throws(() => f.store.seedInboxEvent('201', message()), /fixture write failed/)
    f.reopen()
    assert.equal(f.store.inboxRoute(1, route.channel_id), undefined)
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_event_discoveries').get().n, 0)
    assert.deepEqual(f.store.pendingMessageEventAcks(), [])
    f.store.db.exec('DROP TRIGGER fixture_failure')
    assert.equal(f.store.seedInboxEvent('201', message()), true)
  })
}

test('seed cannot overwrite event mappings or reuse a discovery for another route', t => {
  const f = fixture(t)
  f.store.activateEventRecovery()
  f.store.add('ws:102', message('102'))
  f.store.queueMessageEventAck('201', '102')
  assert.equal(f.store.seedInboxEvent('201', message()), false)
  assert.equal(f.store.inboxRoute(1, route.channel_id), undefined)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_event_discoveries').get().n, 0)
  assert.equal(f.store.seedInboxEvent('202', message()), true)
  assert.equal(f.store.seedInboxEvent('202', message('103', 80, 'other-route')), false)
  assert.equal(f.store.inboxRoute(1, 'other-route'), undefined)
  f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['201', '202'])
})

test('a late smaller event ID can discover a route below the completed scan baseline', t => {
  const f = fixture(t)
  f.store.activateEventRecovery()
  f.store.advanceEventBootstrap(maxId); f.store.finishEventBootstrap(); f.reopen()
  assert.equal(f.store.seedInboxEvent('1', message()), true)
  assert.equal(f.store.inboxRoute(1, route.channel_id).since_ms, now)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['1'])
  assert.equal(f.store.eventRecovery().baseline, maxId)
})

test('ACKed discoveries remain pending through missing history, staging and restart until observed or handled', t => {
  const f = fixture(t)
  f.store.activateEventRecovery()
  assert.equal(f.store.seedInboxEvent('201', message()), true)
  assert.equal(f.store.seedInboxEvent('202', message('102', 40)), true)
  const other = { channel_type: 2, channel_id: route.channel_id }
  assert.equal(f.store.seedInboxEvent('203', { ...message('103', 39), channelType: 2 }), true)
  assert.equal(f.store.seedInboxEvent('204', message('104', 38, 'other-route')), true)
  f.store.messageEventAcked('201'); f.store.messageEventAcked('202')
  const pending = [
    { event_id: '202', message_id: '102', message_seq: 40 },
    { event_id: '201', message_id: '101', message_seq: 41 },
  ]
  const discoveries = () => f.store.pendingInboxDiscoveries(route).map(row => ({ ...row }))
  assert.deepEqual(discoveries(), pending)
  f.store.checkpointInbox(route, 300, [], ['300'])
  f.store.stageInbox('ws:101', message(), true)
  f.store.stageInbox('ws:102', message('102', 40), true)
  t.mock.method(Date, 'now', () => now + 61_000)
  f.reopen()
  assert.deepEqual(discoveries(), pending)
  assert.equal(f.store.inboxRoute(1, route.channel_id).checkpoint, 300)
  assert.equal(f.store.pendingInboxDiscoveries(other).length, 1)
  assert.equal(f.store.pendingInboxDiscoveries({ channel_type: 1, channel_id: 'other-route' }).length, 1)
  assert.deepEqual(f.store.pendingInboxDiscoveries({ channel_type: 5, channel_id: route.channel_id }), [])
  // A known revocation is a durable observed receipt; an empty page was not.
  f.store.checkpointInbox(route, 300, [], ['101'], ['101'])
  assert.deepEqual(discoveries(), pending.slice(0, 1))
  f.store.add('ws:102', message('102', 40))
  f.reopen()
  assert.deepEqual(discoveries(), [])
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_event_discoveries').get().n, 4)
})

test('pending discovery reads bound memory to the earliest hundred unresolved obligations', t => {
  const f = fixture(t)
  f.store.activateEventRecovery()
  for (let seq = 105; seq >= 1; seq--) {
    assert.equal(f.store.seedInboxEvent(String(1000 + seq), message(String(2000 + seq), seq)), true)
  }
  const first = f.store.pendingInboxDiscoveries(route)
  assert.equal(first.length, 100)
  assert.deepEqual(first.map(row => row.message_seq), Array.from({ length: 100 }, (_, i) => i + 1))
  assert.ok(first.every(row => Object.keys(row).sort().join(',') === 'event_id,message_id,message_seq'))
  assert.deepEqual(f.store.pendingInboxDiscoveries(route), first)
  f.store.checkpointInbox(route, 500, [], first.map(row => row.message_id))
  f.reopen()
  assert.deepEqual(f.store.pendingInboxDiscoveries(route).map(row => row.message_seq), [101, 102, 103, 104, 105])
})

test('retiring pending work preserves receipts, discovery and ACK history without reviving executable queues', t => {
  const f = fixture(t)
  f.store.activateEventRecovery()
  f.store.seedInboxEvent('205', message('105', 45, 'discovery-route'))
  f.store.messageEventAcked('205')
  f.store.add('ws:101', message())
  f.store.add('ws:102', message('102', 42))
  f.store.ready(f.store.db.prepare('SELECT seq FROM jobs WHERE message_id=?').get('102').seq, 'stale reply')
  f.store.enrolInbox(message(), true)
  for (const id of ['103', '104']) f.store.stageInbox('ws:' + id, message(id, Number(id)))
  for (const [event, id] of [['201', '101'], ['202', '102'], ['203', '103'], ['204', '104']]) {
    f.store.queueMessageEventAck(event, id)
  }
  f.store.messageEventAcked('201'); f.store.messageEventAcked('203')
  f.store.advanceEventBootstrap('205'); f.store.finishEventBootstrap(); f.store.eventRecoveryFailed(true)
  const recovery = f.store.eventRecovery()
  f.store.retirePending(); f.reopen()
  assert.deepEqual(f.store.eventRecovery(), recovery)
  assert.equal(f.store.hasPending(), false); assert.equal(f.store.next(now), undefined)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_routes').get().n, 0)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['202', '204'])
  for (const id of ['101', '102', '103', '104', '105']) {
    assert.equal(f.store.inboxSeen(id), true)
    f.store.stageInbox('replay:' + id, message(id, Number(id)))
  }
  assert.deepEqual(f.store.stagedInbox(route), [])
  assert.equal(f.store.add('replay:101', message()).changes, 0)
  assert.ok(f.store.db.prepare('SELECT * FROM jobs').all().every(j =>
    j.state === 'review' && j.issue === 'account_removed' && j.input === '' && j.reply === null && j.metadata === null))
  assert.equal(f.store.queueMessageEventAck('203', '103'), true)
  assert.equal(f.store.queueMessageEventAck('204', '104'), true)
  assert.equal(f.store.queueMessageEventAck('205', '105'), true)
  assert.equal(f.store.seedInboxEvent('205', message('105', 45, 'discovery-route')), false)
  assert.equal(f.store.inboxRoute(1, 'discovery-route'), undefined)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['202', '204'])
  f.store.messageEventAcked('202'); f.store.messageEventAcked('204'); f.reopen()
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
})

test('retirement failure rolls back job changes, staged deletion and receipt conversion together', t => {
  const f = fixture(t)
  f.store.add('ws:101', message()); f.store.enrolInbox(message(), true)
  f.store.stageInbox('ws:102', message('102', 42)); f.store.queueMessageEventAck('202', '102')
  failWrite(f.store, 'inbox_routes', 'DELETE')
  assert.throws(() => f.store.retirePending(), /fixture write failed/)
  f.reopen()
  assert.equal(f.store.db.prepare('SELECT state FROM jobs').get().state, 'queued')
  assert.equal(f.store.stagedInbox(route).length, 1)
  assert.equal(f.store.inboxSeen('102'), false)
  assert.equal(f.store.inboxRoute(1, route.channel_id).blocked, 1)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['202'])
  f.store.db.exec('DROP TRIGGER fixture_failure'); f.store.retirePending()
  assert.equal(f.store.inboxSeen('102'), true)
})

test('additive upgrade preserves legacy tables, default since_ms and rollback column-list INSERTs', t => {
  const f = fixture(t)
  f.store.add('ws:101', message()); f.store.enrolInbox(message())
  f.store.stageInbox('ws:102', message('102', 42))
  f.store.db.prepare('INSERT INTO inbox_seen(message_id) VALUES (?)').run('103')
  f.store.rememberAnswer('301', { ...message('card_action:301'), messageSeq: undefined }, null)
  assert.equal(f.store.queueCardAck('301'), true)
  f.store.bindCard({ messageId: 'fixture-card', expiresAt: now + 60_000 })
  const session = f.store.session('fixture-human'); f.store.sessionCreated('fixture-human')
  f.reopen() // Apply the existing route_order normalization before taking the legacy snapshot.
  const tables = ['jobs', 'inbox_staged', 'inbox_seen', 'pending_card_acks', 'card_bindings', 'conversations', 'conversation_history']
  const rows = new Map(tables.map(table => [table, f.store.db.prepare(`SELECT * FROM ${table}`).all()]))
  const schemas = new Map(tables.map(table => [table, f.store.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql]))
  // Only this synthetic test database is reduced to its 0.18 schema.
  f.reopen(db => {
    db.exec(`DROP TABLE event_recovery; DROP TABLE message_event_acks; DROP TABLE inbox_event_discoveries;
      ALTER TABLE inbox_routes DROP COLUMN since_ms;`)
  })
  assert.deepEqual(f.store.eventRecovery(), initial())
  assert.equal(f.store.inboxRoute(1, route.channel_id).since_ms, 0)
  for (const table of tables) {
    assert.deepEqual(f.store.db.prepare(`SELECT * FROM ${table}`).all(), rows.get(table))
    assert.equal(f.store.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql, schemas.get(table))
  }
  f.store.advanceEventBootstrap('400'); f.store.finishEventBootstrap()
  f.store.activateEventRecovery()
  f.store.seedInboxEvent('401', message('104', 50, 'discovery-route'))
  const recovery = f.store.eventRecovery()
  f.reopen(db => {
    // Former releases use explicit column lists and ignore the new tables.
    db.prepare('INSERT INTO jobs(message_id,event_id,sender,input) VALUES (?,?,?,?)').run('105', 'ws:105', 'legacy-human', 'legacy input')
    db.prepare(`INSERT INTO inbox_routes(channel_type,channel_id,floor_seq,checkpoint,blocked,checked_ms)
      VALUES (1,?,4,4,0,?)`).run('legacy-route', now)
    assert.equal(db.prepare('SELECT since_ms FROM inbox_routes WHERE channel_id=?').get('legacy-route').since_ms, 0)
  })
  assert.deepEqual(f.store.eventRecovery(), recovery)
  assert.equal(f.store.inboxRoute(1, 'legacy-route').since_ms, 0)
  assert.equal(f.store.inboxRoute(1, 'discovery-route').since_ms, now)
  assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE message_id=?').get('105').input, 'legacy input')
  assert.equal(f.store.boundSession('fixture-human', session.session_id).created, 1)
  assert.deepEqual(f.store.pendingCardAcks(), ['301'])
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['401'])
})

test('message ACKs do not change card ACK semantics or overview', t => {
  const f = fixture(t)
  f.store.add('ws:101', message())
  f.store.rememberAnswer('201', message('card_action:201'), null)
  assert.equal(f.store.queueCardAck('201'), true)
  const overview = f.store.overview()
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.deepEqual(f.store.overview(), overview)
  f.store.messageEventAcked('201')
  assert.deepEqual(f.store.pendingCardAcks(), ['201'])
  f.store.cardAcked('201')
  assert.deepEqual(f.store.pendingCardAcks(), [])
  assert.equal(f.store.queueCardAck('201'), true) // Existing card requeue semantics remain intact.
  assert.equal(f.store.queueMessageEventAck('201', '101'), true)
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
  assert.equal(f.store.queueCardAck('999'), false)
  assert.throws(() => f.store.queueCardAck('0'), /invalid_card_event_id/)
  f.reopen()
  assert.deepEqual(f.store.overview(), overview)
  assert.deepEqual(f.store.pendingCardAcks(), ['201'])
  assert.deepEqual(f.store.pendingMessageEventAcks(), [])
})

test('ACK retry columns are additive and completed mappings survive old column-list writes', t => {
  const f = fixture(t)
  f.store.add('ws:101', message())
  f.store.queueMessageEventAck('201', '101'); f.store.messageEventAcked('201')
  f.store.queueMessageEventAck('202', '101')
  // Synthetic unreleased schema only; real released upgrades start from 0.18.
  f.reopen(db => db.exec('ALTER TABLE message_event_acks DROP COLUMN attempt; ALTER TABLE message_event_acks DROP COLUMN retry_ms;'))
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['202'])
  assert.equal(f.store.messageEventAckDue('201'), true)
  assert.deepEqual(f.store.db.prepare('SELECT * FROM message_event_acks ORDER BY event_id').all().map(row => ({ ...row })), [
    { event_id: '201', message_id: '101', acked: 1, attempt: 0, retry_ms: 0 },
    { event_id: '202', message_id: '101', acked: 0, attempt: 0, retry_ms: 0 },
  ])
  f.store.messageEventAckFailed('202')
  f.reopen(db => db.prepare('INSERT INTO message_event_acks(event_id,message_id) VALUES (?,?)').run('203', '101'))
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['203'])
  assert.equal(f.store.messageEventAckDue('202'), false)
  assert.equal(f.store.messageEventAckDue('201'), true)
})
