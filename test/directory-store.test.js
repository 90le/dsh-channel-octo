import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/store.js'

const now = 1_800_000_000_123
const groupA = 'a'.repeat(32), groupB = 'b'.repeat(32), groupC = 'c'.repeat(32)
const topic = groupA + '____123456789012345'
const initial = () => ({ startedAt: 0, ready: false, completedAt: 0, failed: false, pendingGroups: 0 })
const message = (type = 2, id = groupA, seq = 41, messageId = '101') => ({
  messageId, messageSeq: seq, sender: 'synthetic-human', channelType: type, channelId: id,
  text: 'synthetic directory recovery message',
})
const groups = store => store.db.prepare('SELECT * FROM directory_groups ORDER BY group_no').all()
const snapshot = store => ({ recovery: store.directoryRecovery(), groups: groups(store), listedAt: store.directoryListedAt() })

// Only private, synthetic SQLite files are opened. No worker or API is started.
function fixture(t) {
  t.mock.method(Date, 'now', () => now)
  const root = mkdtempSync(join(tmpdir(), 'octo-directory-store-'))
  let store = new Store(root, 'synthetic-directory-bot')
  t.after(() => {
    store?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('octo-directory-store-'))
    rmSync(root, { recursive: true, force: true })
  })
  return {
    get store() { return store },
    reopen(legacyWrite) {
      store.close(); store = null
      if (legacyWrite) {
        const db = new DatabaseSync(join(root, 'channel.sqlite'))
        try { legacyWrite(db) } finally { db.close() }
      }
      store = new Store(root, 'synthetic-directory-bot')
      return store
    },
  }
}

function failWrite(store, table, operation = 'UPDATE') {
  // Table/operation names are fixed test constants, never external input.
  store.db.exec(`CREATE TRIGGER synthetic_directory_failure BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT, 'synthetic directory write failed'); END`)
}

test('opening a Store leaves directory recovery inactive and schema defaults are additive', t => {
  const f = fixture(t)
  assert.deepEqual(f.store.directoryRecovery(), initial())
  assert.equal(f.store.directoryListedAt(), 0)
  assert.equal(f.store.nextDirectoryGroup(), undefined)
  assert.equal(f.store.beginDirectoryScan([]), false)
  assert.equal(f.store.seedDirectoryRoute(2, groupA), false)
  assert.equal(f.store.seedDirectoryRoute(5, topic), false)
  assert.equal(f.store.inboxRoute(2, groupA), undefined)
  for (const [table, expected] of [
    ['directory_recovery', { started_at: '0', ready: '0', completed_at: '0', failed: '0', listed_at: '0' }],
    ['directory_groups', { page: '1', done: '0', failed: '0', checked_ms: '0', retry_ms: '0' }],
    ['inbox_routes', { since_ms: '0', directory_at: '0', directory_all: '0', prefix_until_seq: '0', prefix_since_ms: '0' }],
  ]) {
    const columns = f.store.db.prepare(`PRAGMA table_info(${table})`).all()
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(columns.find(column => column.name === name)?.dflt_value, value)
      assert.equal(columns.find(column => column.name === name)?.notnull, 1)
    }
  }
  assert.throws(() => f.store.db.exec('INSERT INTO directory_recovery(id) VALUES (2)'), /CHECK constraint/)
  f.reopen()
  assert.deepEqual(f.store.directoryRecovery(), initial())
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM directory_recovery').get().n, 1)
})

test('first actual activation marks existing groups/topics without rewriting any recovery range', t => {
  const f = fixture(t)
  f.store.activateEventRecovery(now - 5000)
  f.store.enrolInbox(message(), true)
  f.store.enrolInbox(message(1, 'synthetic-human'))
  f.store.seedInboxEvent('201', message(5, topic, 61, '102'))
  f.store.db.prepare(`UPDATE inbox_routes SET checkpoint=checkpoint+7,checked_ms=11,retry_ms=22,failed=1`).run()
  const before = f.store.db.prepare('SELECT * FROM inbox_routes ORDER BY channel_type').all()
  const eventState = f.store.eventRecovery(), acks = f.store.pendingMessageEventAcks()
  assert.equal(f.store.activateDirectoryRecovery(), true)
  for (const row of before) {
    assert.equal(row.directory_all, 0)
    assert.deepEqual({ ...f.store.inboxRoute(row.channel_type, row.channel_id) },
      { ...row, directory_at: row.channel_type === 1 ? 0 : now, directory_all: 0 })
  }
  assert.equal(f.store.seedDirectoryRoute(2, groupA), false)
  assert.equal(f.store.seedDirectoryRoute(5, topic), false)
  // A second activation must not absorb a route that raced after the first.
  f.store.enrolInbox(message(2, groupB))
  f.reopen()
  assert.equal(f.store.activateDirectoryRecovery(now + 5000), false)
  assert.equal(f.store.inboxRoute(2, groupB).directory_at, 0)
  assert.equal(f.store.directoryRecovery().startedAt, now)
  assert.deepEqual(f.store.eventRecovery(), eventState)
  assert.deepEqual(f.store.pendingMessageEventAcks(), acks)
})

test('activation rejects invalid time and atomically rolls back marking existing routes', t => {
  const f = fixture(t)
  f.store.enrolInbox(message())
  const before = f.store.inboxRoute(2, groupA)
  for (const at of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '123']) {
    assert.equal(f.store.activateDirectoryRecovery(at), false)
  }
  failWrite(f.store, 'inbox_routes')
  assert.throws(() => f.store.activateDirectoryRecovery(), /synthetic directory write failed/)
  assert.deepEqual(f.store.directoryRecovery(), initial())
  assert.deepEqual(f.store.inboxRoute(2, groupA), before)
  f.reopen()
  assert.deepEqual(f.store.directoryRecovery(), initial())
  f.store.db.exec('DROP TRIGGER synthetic_directory_failure')
  assert.equal(f.store.activateDirectoryRecovery(), true)
})

for (const [type, id] of [[2, groupA], [5, topic]]) {
  test(`new directory route type ${type} starts blocked at zero with the first activation boundary`, t => {
    const f = fixture(t)
    f.store.activateDirectoryRecovery(now - 1000)
    assert.equal(f.store.seedDirectoryRoute(type, id), true)
    assert.deepEqual({ ...f.store.inboxRoute(type, id) }, {
      channel_type: type, channel_id: id, floor_seq: 0, checkpoint: 0,
      blocked: 1, checked_ms: 0, retry_ms: 0, failed: 0, since_ms: now - 1000,
      directory_at: now - 1000, directory_all: 1, prefix_until_seq: 0, prefix_since_ms: 0,
    })
    f.store.checkpointInbox({ channel_type: type, channel_id: id }, 77, [])
    f.store.releaseInbox({ channel_type: type, channel_id: id })
    const before = f.store.inboxRoute(type, id)
    f.reopen()
    assert.equal(f.store.seedDirectoryRoute(type, id), false)
    assert.deepEqual(f.store.inboxRoute(type, id), before)
    assert.deepEqual(f.store.pendingMessageEventAcks(), [])
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0)
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_staged').get().n, 0)
  })
}

for (const [type, id, oldSince] of [[2, groupA, 0], [5, topic, now - 2000], [2, groupB, now + 2000]]) {
  test(`post-activation route type ${type} preserves upper-range since_ms=${oldSince} on prefix rewind`, t => {
    const f = fixture(t)
    f.store.activateDirectoryRecovery()
    const m = message(type, id)
    if (oldSince) {
      f.store.activateEventRecovery(oldSince)
      assert.equal(f.store.seedInboxEvent('201', m), true)
    } else f.store.enrolInbox(m)
    f.store.stageInbox('ws:101', m, true)
    f.store.add('ws:102', message(type, id, 42, '102'))
    f.store.db.prepare(`UPDATE inbox_routes SET checkpoint=55,checked_ms=23,retry_ms=99,failed=1
      WHERE channel_type=? AND channel_id=?`).run(type, id)
    const before = f.store.inboxRoute(type, id)
    assert.equal(before.directory_all, 0)
    const staged = f.store.stagedInbox(before), acks = f.store.pendingMessageEventAcks()
    assert.equal(f.store.seedDirectoryRoute(type, id), true)
    const after = f.store.inboxRoute(type, id)
    assert.deepEqual({ ...after }, { ...before, floor_seq: 0, checkpoint: 0, blocked: 1,
      checked_ms: 0, retry_ms: 0, directory_at: now, directory_all: 0, prefix_until_seq: 40, prefix_since_ms: now })
    // The parent parser applies prefix_since_ms inclusively through old floor
    // 40. Sequence 41 and up retain oldSince, including an unrestricted WS range.
    assert.equal(after.since_ms, oldSince)
    assert.equal(after.prefix_until_seq + 1, m.messageSeq)
    assert.notEqual(after.floor_seq, before.floor_seq, 'the inbox await guard can detect the rewind')
    assert.deepEqual(f.store.stagedInbox(after), staged)
    assert.deepEqual(f.store.pendingMessageEventAcks(), acks)
    assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('102').state, 'queued')
    f.reopen()
    assert.equal(f.store.seedDirectoryRoute(type, id), false)
    assert.deepEqual(f.store.inboxRoute(type, id), after)
  })
}

test('a raced route already at floor zero is only marked, without resetting its checkpoint or time boundary', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.activateEventRecovery(now - 1000)
  f.store.seedInboxEvent('201', message(5, topic, 1))
  f.store.enrolInbox(message(2, groupA, 1))
  f.store.db.exec('UPDATE inbox_routes SET checkpoint=15,blocked=0,checked_ms=12,retry_ms=34,failed=1')
  for (const [type, id] of [[2, groupA], [5, topic]]) {
    const before = f.store.inboxRoute(type, id)
    assert.equal(f.store.seedDirectoryRoute(type, id), true)
    assert.deepEqual({ ...f.store.inboxRoute(type, id) }, { ...before, directory_at: now, directory_all: 0 })
  }
})

test('directory route validation accepts only exact group/topic addresses and type numbers', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  const invalid = ['', '.', 'not-hex', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33),
    groupA + '\n', ' ' + groupA, null, undefined, 1, {}, []]
  for (const id of invalid) {
    assert.equal(f.store.seedDirectoryRoute(2, id), false)
    assert.equal(f.store.seedDirectoryRoute(5, id), false)
  }
  for (const type of [1, 0, 3, '2', '5', null, undefined, NaN]) {
    assert.equal(f.store.seedDirectoryRoute(type, groupA), false)
    assert.equal(f.store.seedDirectoryRoute(type, topic), false)
  }
  for (const id of [groupA, groupA + '____' + '1'.repeat(14), groupA + '____' + '1'.repeat(21),
    groupA + '___123456789012345', topic + '\n', topic + '\r', topic + ' ', topic.replace('123', '+23'),
    'g'.repeat(32) + '____123456789012345']) assert.equal(f.store.seedDirectoryRoute(5, id), false)
  assert.equal(f.store.seedDirectoryRoute(2, topic), false)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox_routes').get().n, 0)
  assert.equal(f.store.seedDirectoryRoute(2, groupA.toUpperCase()), true)
  assert.equal(f.store.seedDirectoryRoute(5, groupA.toUpperCase() + '____' + '0'.repeat(20)), true)
})

test('failed route inserts and rewinds leave no partial route state', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  failWrite(f.store, 'inbox_routes', 'INSERT')
  assert.throws(() => f.store.seedDirectoryRoute(2, groupA), /synthetic directory write failed/)
  assert.equal(f.store.inboxRoute(2, groupA), undefined)
  f.store.db.exec('DROP TRIGGER synthetic_directory_failure')
  f.store.enrolInbox(message())
  const before = f.store.inboxRoute(2, groupA)
  failWrite(f.store, 'inbox_routes')
  assert.throws(() => f.store.seedDirectoryRoute(2, groupA), /synthetic directory write failed/)
  f.reopen()
  assert.deepEqual(f.store.inboxRoute(2, groupA), before)
})

test('empty first scan immediately completes at the default current time and survives restart', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.directoryRecoveryFailed(true)
  assert.equal(f.store.beginDirectoryScan([]), true)
  const complete = { startedAt: now, ready: true, completedAt: now, failed: false, pendingGroups: 0 }
  assert.deepEqual(f.store.directoryRecovery(), complete)
  assert.equal(f.store.nextDirectoryGroup(), undefined)
  f.reopen()
  assert.deepEqual(f.store.directoryRecovery(), complete)
  assert.equal(f.store.beginDirectoryScan([], now + 60_000), true)
  assert.equal(f.store.directoryRecovery().completedAt, now + 60_000)
  assert.equal(f.store.directoryRecovery().startedAt, now)
})

test('scan lists are bounded, unique, strictly validated, and cannot replace pending groups', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([])
  const before = snapshot(f.store)
  for (const ids of [null, undefined, groupA, new Set([groupA]), {}, [groupA, groupA], [groupA, null],
    ['a'.repeat(31)], ['g'.repeat(32)], [groupA + '\n'], [topic], new Array(1),
    Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(32, '0'))]) {
    assert.equal(f.store.beginDirectoryScan(ids), false)
    assert.deepEqual(snapshot(f.store), before)
  }
  for (const at of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '123']) {
    assert.equal(f.store.beginDirectoryScan([groupA], at), false)
    assert.deepEqual(snapshot(f.store), before)
  }
  const ids = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(32, '0'))
  assert.equal(f.store.beginDirectoryScan(ids), true)
  assert.equal(f.store.directoryRecovery().pendingGroups, 1000)
  assert.deepEqual({ ...f.store.nextDirectoryGroup() }, { group_no: ids[0], page: 1, done: 0, failed: 0, checked_ms: 0, retry_ms: 0 })
  const pending = snapshot(f.store)
  assert.equal(f.store.beginDirectoryScan([groupA]), false)
  assert.equal(f.store.beginDirectoryScan([]), false)
  assert.deepEqual(snapshot(f.store), pending)
})

test('page scheduling visits unchecked groups first then oldest checked groups and persists progress', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupC, groupB, groupA])
  assert.equal(f.store.nextDirectoryGroup().group_no, groupA)
  assert.equal(f.store.completeDirectoryStep(groupA, 2, false, now + 1), true)
  assert.equal(f.store.nextDirectoryGroup().group_no, groupB)
  f.store.completeDirectoryStep(groupB, 2, false, now + 1)
  assert.equal(f.store.nextDirectoryGroup().group_no, groupC)
  f.store.completeDirectoryStep(groupC, 2, false, now + 2)
  f.reopen()
  assert.equal(f.store.nextDirectoryGroup().group_no, groupA, 'equal check times use group_no')
  assert.equal(f.store.nextDirectoryGroup().page, 2)
  f.store.completeDirectoryStep(groupA, 3, false, now + 3)
  assert.equal(f.store.nextDirectoryGroup().group_no, groupB)
  assert.deepEqual(f.store.directoryRecovery(), { ...initial(), startedAt: now, pendingGroups: 3 })
  f.store.completeDirectoryStep(groupB, null, false, now + 4)
  f.store.completeDirectoryStep(groupC, null, false, now + 5)
  assert.equal(f.store.nextDirectoryGroup().page, 3)
  assert.equal(f.store.directoryRecovery().pendingGroups, 1)
  f.store.completeDirectoryStep(groupA, null, false, now + 6)
  assert.equal(f.store.nextDirectoryGroup(), undefined)
  assert.deepEqual(f.store.directoryRecovery(), { ...initial(), startedAt: now, ready: true, completedAt: now + 6 })
  const before = snapshot(f.store)
  assert.equal(f.store.completeDirectoryStep(groupA, 4, true, now + 7), false)
  assert.deepEqual(snapshot(f.store), before)
  f.reopen()
  assert.deepEqual(snapshot(f.store), before)
  assert.equal(f.store.beginDirectoryScan([groupC], now + 60_000), true)
  assert.deepEqual(groups(f.store).map(row => ({ ...row })), [
    { group_no: groupC, page: 1, done: 0, failed: 0, checked_ms: now + 5, retry_ms: 0 },
  ])
  assert.deepEqual(f.store.directoryRecovery(), { ...initial(), startedAt: now, pendingGroups: 1 })
})

test('invalid pages, times and missing groups cannot mutate a pending scan', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA])
  const before = snapshot(f.store)
  for (const page of [0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, false, {}]) {
    assert.equal(f.store.completeDirectoryStep(groupA, page), false)
    assert.deepEqual(snapshot(f.store), before)
  }
  for (const at of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '123']) {
    assert.equal(f.store.completeDirectoryStep(groupA, null, false, at), false)
    assert.deepEqual(snapshot(f.store), before)
  }
  for (const group of [groupB, groupA + '\n', topic, null, {}, 1]) {
    assert.equal(f.store.completeDirectoryStep(group), false)
    assert.deepEqual(snapshot(f.store), before)
  }
  assert.equal(f.store.completeDirectoryStep(groupA, 1), true)
  assert.equal(f.store.nextDirectoryGroup().page, 1)
  assert.equal(f.store.nextDirectoryGroup().checked_ms, now)
  assert.equal(f.store.completeDirectoryStep(groupA), true)
  assert.equal(f.store.directoryRecovery().completedAt, now)
})

test('transport failure is separate from group failures and event recovery, and success clears its group failure', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.activateEventRecovery(now - 1000)
  f.store.eventRecoveryFailed(true)
  const eventBefore = f.store.eventRecovery()
  f.store.directoryRecoveryFailed(true)
  f.store.beginDirectoryScan([groupA, groupB, groupC])
  assert.equal(f.store.directoryRecovery().failed, false)
  f.store.completeDirectoryStep(groupA, 2, true, now + 1)
  f.store.completeDirectoryStep(groupB, null, true, now + 2)
  const pending = groups(f.store)
  f.store.directoryRecoveryFailed(true)
  assert.equal(f.store.directoryRecovery().failed, true)
  f.reopen()
  assert.equal(f.store.directoryRecovery().failed, true)
  f.store.directoryRecoveryFailed(false)
  assert.deepEqual(groups(f.store), pending, 'transport recovery must not erase per-group failure')
  f.store.completeDirectoryStep(groupA, null, false, now + 3)
  assert.equal(f.store.directoryRecovery().ready, false)
  f.store.completeDirectoryStep(groupC, null, false, now + 4)
  assert.deepEqual(f.store.directoryRecovery(), { startedAt: now, ready: true, completedAt: now + 4,
    failed: true, pendingGroups: 0 })
  assert.equal(groups(f.store)[0].failed, 0, 'successful retry clears this group while another failed group keeps aggregate failure')
  assert.deepEqual(f.store.eventRecovery(), eventBefore)
  f.reopen()
  assert.equal(f.store.directoryRecovery().failed, true)
  f.store.beginDirectoryScan([], now + 60_000)
  assert.equal(f.store.directoryRecovery().failed, false)
  assert.deepEqual(f.store.eventRecovery(), eventBefore)
})

test('catalog refresh merges candidates atomically without losing pending progress or retry deadlines', t => {
  const f = fixture(t)
  assert.equal(f.store.mergeDirectoryScan([groupA]), false)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA, groupB])
  f.store.completeDirectoryStep(groupA, 3)
  f.store.retryDirectoryStep(groupA, now + 300_000)
  f.store.completeDirectoryStep(groupB, null, false, now + 1)
  const waiting = groups(f.store)[0]
  assert.equal(f.store.mergeDirectoryScan([groupA, groupB, groupC], now + 60_000), true)
  assert.deepEqual(groups(f.store)[0], waiting)
  assert.deepEqual({ ...groups(f.store)[1] }, { group_no: groupB, page: 1, done: 0, failed: 0,
    retry_ms: 0, checked_ms: now + 1 })
  assert.equal(f.store.nextDirectoryGroup(now + 60_000).group_no, groupC)
  assert.equal(f.store.directoryListedAt(), now + 60_000)
  assert.equal(f.store.directoryRecovery().failed, true)
  assert.equal(f.store.directoryRecovery().pendingGroups, 3)
  assert.equal(Object.hasOwn(f.store.directoryRecovery(), 'listedAt'), false)
  const before = snapshot(f.store)
  f.reopen()
  assert.deepEqual(snapshot(f.store), before)
  for (const invalid of [null, [groupA, groupA], [groupA, 'bad'], new Array(1001).fill(groupA)]) {
    assert.equal(f.store.mergeDirectoryScan(invalid, now + 120_000), false)
    assert.deepEqual(snapshot(f.store), before)
  }
  failWrite(f.store, 'directory_recovery')
  assert.throws(() => f.store.mergeDirectoryScan([groupB], now + 120_000), /synthetic directory write failed/)
  assert.deepEqual(snapshot(f.store), before, 'candidate removal and listing clock must roll back together')
  f.store.db.exec('DROP TRIGGER synthetic_directory_failure')
  assert.equal(f.store.mergeDirectoryScan([groupB], now + 120_000), true)
  assert.deepEqual(groups(f.store).map(row => row.group_no), [groupB])
  assert.equal(f.store.directoryRecovery().failed, false)
  assert.equal(f.store.mergeDirectoryScan([], now + 180_000), true)
  assert.deepEqual(f.store.directoryRecovery(), { ...initial(), startedAt: now, ready: true, completedAt: now + 180_000 })
  assert.equal(f.store.directoryListedAt(), now + 180_000)
})

test('listed_at migration defaults to a fresh catalog without resetting pending pages', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA])
  f.store.completeDirectoryStep(groupA, 5)
  f.store.retryDirectoryStep(groupA, now + 300_000)
  const waiting = groups(f.store)
  f.reopen(db => db.exec('ALTER TABLE directory_recovery DROP COLUMN listed_at'))
  assert.equal(f.store.directoryListedAt(), 0)
  assert.deepEqual(groups(f.store), waiting)
  assert.equal(f.store.mergeDirectoryScan([groupA, groupB], now + 60_000), true)
  assert.deepEqual(groups(f.store)[0], waiting[0])
  f.reopen()
  assert.equal(f.store.directoryListedAt(), now + 60_000)
  f.store.retirePending()
  f.reopen()
  assert.equal(f.store.directoryListedAt(), 0, 're-added accounts immediately refresh the catalog')
})

test('retry deadline migration preserves pending pages and is durable across reopen', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA, groupB])
  f.store.completeDirectoryStep(groupA, 3)
  f.reopen(db => db.exec('ALTER TABLE directory_groups DROP COLUMN retry_ms'))
  assert.equal(f.store.nextDirectoryGroup().group_no, groupB)
  assert.equal(groups(f.store)[0].page, 3)
  assert.ok(groups(f.store).every(row => row.retry_ms === 0))
  assert.equal(f.store.retryDirectoryStep(groupA, now + 120_000), true)
  f.store.completeDirectoryStep(groupB)
  const before = snapshot(f.store)
  f.reopen()
  assert.deepEqual(snapshot(f.store), before)
  assert.equal(f.store.nextDirectoryGroup(now + 119_999), undefined)
  assert.equal(f.store.nextDirectoryGroup(now + 120_000).page, 3)
  assert.equal(f.store.beginDirectoryScan([]), false, 'a waiting group is still pending work')
  f.store.completeDirectoryStep(groupA, 4, false, now + 120_000)
  assert.equal(f.store.directoryRecovery().failed, false)
  assert.equal(f.store.directoryRecovery().ready, false)
  assert.equal(groups(f.store)[0].retry_ms, 0)
  f.reopen()
  assert.equal(f.store.nextDirectoryGroup().page, 4)
  assert.equal(f.store.directoryRecovery().failed, false)
})

test('invalid retry updates and failed retry writes leave page and aggregate state unchanged', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA, groupB])
  f.store.completeDirectoryStep(groupA, 3)
  f.store.completeDirectoryStep(groupB)
  const before = snapshot(f.store)
  for (const at of [0, now, now - 1, NaN, Infinity, '1800000030123', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(f.store.retryDirectoryStep(groupA, at), false)
  }
  for (const at of [0, -1, 1.5, NaN, Infinity, '123', null]) {
    assert.equal(f.store.retryDirectoryStep(groupA, now + 30_000, at), false)
  }
  for (const group of [groupB, groupC, groupA + '\n', topic, null]) {
    assert.equal(f.store.retryDirectoryStep(group, now + 30_000), false)
  }
  assert.deepEqual(snapshot(f.store), before)
  failWrite(f.store, 'directory_recovery')
  assert.throws(() => f.store.retryDirectoryStep(groupA, now + 30_000), /synthetic directory write failed/)
  assert.deepEqual(snapshot(f.store), before)
  f.reopen()
  assert.deepEqual(snapshot(f.store), before)
  f.store.db.exec('DROP TRIGGER synthetic_directory_failure')
  assert.equal(f.store.retryDirectoryStep(groupA, now + 30_000), true)
  const waiting = snapshot(f.store)
  failWrite(f.store, 'directory_recovery')
  assert.throws(() => f.store.completeDirectoryStep(groupA, 4), /synthetic directory write failed/)
  f.reopen()
  assert.deepEqual(snapshot(f.store), waiting, 'failure to publish success cannot discard the retry obligation')
})

test('failed scan replacement and final completion atomically retain the previous durable state', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA])
  f.store.completeDirectoryStep(groupA, null, true)
  const completed = snapshot(f.store)
  failWrite(f.store, 'directory_recovery')
  assert.throws(() => f.store.beginDirectoryScan([groupB]), /synthetic directory write failed/)
  assert.deepEqual(snapshot(f.store), completed)
  f.reopen()
  assert.deepEqual(snapshot(f.store), completed)
  f.store.db.exec('DROP TRIGGER synthetic_directory_failure')
  failWrite(f.store, 'directory_groups', 'INSERT')
  assert.throws(() => f.store.beginDirectoryScan([groupB]), /synthetic directory write failed/)
  assert.deepEqual(snapshot(f.store), completed)
  f.store.db.exec('DROP TRIGGER synthetic_directory_failure')
  f.store.beginDirectoryScan([groupB])
  const pending = snapshot(f.store)
  failWrite(f.store, 'directory_recovery')
  assert.throws(() => f.store.completeDirectoryStep(groupB), /synthetic directory write failed/)
  assert.deepEqual(snapshot(f.store), pending)
  f.reopen()
  assert.deepEqual(snapshot(f.store), pending)
})

test('retiring pending work resets the directory cycle but retains activation and existing recovery receipts', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.activateEventRecovery(now - 1000)
  f.store.advanceEventBootstrap('200'); f.store.finishEventBootstrap()
  const m = message()
  f.store.seedInboxEvent('201', m)
  f.store.stageInbox('ws:101', m)
  f.store.beginDirectoryScan([groupA, groupB])
  f.store.completeDirectoryStep(groupA, null, true)
  f.store.directoryRecoveryFailed(true)
  const eventBefore = f.store.eventRecovery(), acks = f.store.pendingMessageEventAcks()
  f.store.retirePending()
  assert.deepEqual(f.store.directoryRecovery(), { ...initial(), startedAt: now })
  assert.deepEqual(groups(f.store), [])
  assert.equal(f.store.inboxRoute(2, groupA), undefined)
  assert.equal(f.store.inboxSeen('101'), true)
  assert.deepEqual(f.store.pendingMessageEventAcks(), acks)
  assert.deepEqual(f.store.eventRecovery(), eventBefore)
  f.reopen()
  assert.equal(f.store.activateDirectoryRecovery(now + 60_000), false)
  assert.equal(f.store.beginDirectoryScan([groupA], now + 60_000), true)
  assert.equal(f.store.seedDirectoryRoute(2, groupA), true)
  assert.equal(f.store.inboxRoute(2, groupA).since_ms, now)
  assert.equal(f.store.inboxSeen('101'), true)
  f.store.completeDirectoryStep(groupA)
  assert.ok(f.store.directoryRecovery().completedAt > 0)
  f.store.retirePending()
  f.reopen()
  assert.deepEqual(f.store.directoryRecovery(), { ...initial(), startedAt: now })
})

test('failed retirement rolls back directory reset, routes, jobs and staged receipts together', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.seedDirectoryRoute(2, groupA)
  f.store.stageInbox('ws:101', message())
  f.store.add('ws:102', message(2, groupA, 42, '102'))
  f.store.beginDirectoryScan([groupA])
  const before = snapshot(f.store), route = f.store.inboxRoute(2, groupA)
  failWrite(f.store, 'directory_recovery')
  assert.throws(() => f.store.retirePending(), /synthetic directory write failed/)
  assert.deepEqual(snapshot(f.store), before)
  assert.deepEqual(f.store.inboxRoute(2, groupA), route)
  assert.equal(f.store.stagedInbox(route).length, 1)
  assert.equal(f.store.inboxSeen('101'), false)
  assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('102').state, 'queued')
})

test('0.19 schema upgrades and old column-list writes preserve data and directory state across restarts', t => {
  const f = fixture(t)
  f.store.enrolInbox(message(), true)
  f.store.add('ws:101', message())
  f.store.activateEventRecovery(now - 1000)
  f.store.advanceEventBootstrap('200'); f.store.finishEventBootstrap()
  f.store.queueMessageEventAck('201', '101')
  const eventBefore = f.store.eventRecovery()
  // Reduce this generated database only to the released 0.19 schema.
  f.reopen(db => db.exec(`
    DROP TABLE directory_groups; DROP TABLE directory_recovery;
    ALTER TABLE inbox_routes DROP COLUMN directory_at;
    ALTER TABLE inbox_routes DROP COLUMN directory_all;
    ALTER TABLE inbox_routes DROP COLUMN prefix_until_seq;
    ALTER TABLE inbox_routes DROP COLUMN prefix_since_ms;
  `))
  assert.deepEqual(f.store.directoryRecovery(), initial())
  const route = f.store.inboxRoute(2, groupA)
  assert.equal(route.floor_seq, 40)
  assert.equal(route.checkpoint, 40)
  assert.equal(route.blocked, 1)
  assert.equal(route.directory_at, 0)
  assert.equal(route.directory_all, 0)
  assert.equal(route.prefix_until_seq, 0)
  assert.equal(route.prefix_since_ms, 0)
  f.store.activateDirectoryRecovery()
  f.store.beginDirectoryScan([groupA])
  f.store.completeDirectoryStep(groupA, 2)
  f.store.seedDirectoryRoute(5, topic)
  const before = snapshot(f.store)
  f.reopen(db => {
    // A rolled-back 0.19 binary uses these explicit lists and ignores new tables.
    db.prepare(`INSERT INTO inbox_routes(channel_type,channel_id,floor_seq,checkpoint,blocked,checked_ms,since_ms)
      VALUES (2,?,9,11,0,?,0)`).run(groupB, now)
    db.prepare(`INSERT INTO jobs(message_id,event_id,sender,input,channel_type,channel_id,message_seq)
      VALUES ('102','ws:102','synthetic-human','legacy input',2,?,10)`).run(groupB)
    db.prepare('INSERT INTO message_event_acks(event_id,message_id) VALUES (?,?)').run('202', '102')
  })
  assert.deepEqual(snapshot(f.store), before)
  assert.deepEqual(f.store.eventRecovery(), eventBefore)
  assert.deepEqual(f.store.pendingMessageEventAcks(), ['201', '202'])
  assert.equal(f.store.inboxRoute(2, groupB).directory_at, 0)
  assert.equal(f.store.inboxRoute(2, groupB).directory_all, 0)
  assert.equal(f.store.inboxRoute(2, groupB).prefix_until_seq, 0)
  assert.equal(f.store.inboxRoute(2, groupB).prefix_since_ms, 0)
  assert.equal(f.store.inboxRoute(5, topic).since_ms, now)
  assert.equal(f.store.inboxRoute(5, topic).directory_all, 1)
  assert.equal(f.store.db.prepare('SELECT route_order FROM jobs WHERE message_id=?').get('102').route_order, 10)
  assert.equal(f.store.seedDirectoryRoute(2, groupB), true)
  assert.equal(f.store.inboxRoute(2, groupB).prefix_until_seq, 9)
  f.reopen()
  assert.deepEqual(snapshot(f.store), before)
  assert.equal(f.store.inboxRoute(2, groupB).prefix_since_ms, now)
  assert.equal(f.store.inboxRoute(2, groupB).directory_all, 0)
  assert.equal(f.store.inboxRoute(5, topic).directory_all, 1)
})

test('individually guarded route migrations retain already-present directory boundary columns', t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery()
  f.store.enrolInbox(message())
  f.store.seedDirectoryRoute(2, groupA)
  f.store.seedDirectoryRoute(5, topic)
  const pure = f.store.inboxRoute(5, topic)
  const before = f.store.inboxRoute(2, groupA)
  f.reopen(db => db.exec('ALTER TABLE inbox_routes DROP COLUMN prefix_since_ms'))
  assert.deepEqual({ ...f.store.inboxRoute(2, groupA) }, { ...before, prefix_since_ms: 0 })
  assert.deepEqual(f.store.inboxRoute(5, topic), pure)
  assert.equal(f.store.inboxRoute(5, topic).directory_all, 1)
  const migrated = f.store.inboxRoute(2, groupA)
  f.reopen()
  assert.deepEqual(f.store.inboxRoute(2, groupA), migrated)
  assert.equal(f.store.directoryRecovery().startedAt, now)
})
