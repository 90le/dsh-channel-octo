import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

const now = 1_800_000_000_000
const day = 86_400_000
const conversation = JSON.stringify([2, 'fixture-group', 'alice'])
const eventId = '9223372036854775807'

function fixture(t, identity = 'fixture-bot') {
  t.mock.method(Date, 'now', () => now)
  const root = mkdtempSync(join(tmpdir(), 'octo-deferred-store-'))
  let store = new Store(root, identity)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return {
    get store() { return store },
    reopen() { store.close(); store = new Store(root, identity); return store },
  }
}

function binding(id = 'card-1', sessionId = 'session-a', expiresAt = now + day) {
  return {
    account: 'fixture-account', spaceId: 'fixture-space', messageId: id,
    route: { channel_type: 2, channel_id: 'fixture-group' }, operatorUid: 'alice',
    cardNonce: 'fixture-nonce', actionIds: ['confirm', 'cancel'], choice: null,
    inputSpecs: [{ type: 'text', id: 'comment', label: '备注' }], expiresAt,
    deferred: {
      sessionId, conversation, profile: 'octo/v2', title: '审批', text: '请确认',
      actions: [{ id: 'confirm', label: '确认' }, { id: 'cancel', label: '取消' }],
      sourceMessageId: 'source:' + id, createdAt: now, state: 'pending',
    },
  }
}

function publish(store, card = binding()) {
  const seq = Number(store.add('source:' + card.messageId, {
    messageId: card.deferred.sourceMessageId, sender: 'alice', text: '创建表单',
    channelType: 2, channelId: 'fixture-group',
  }).lastInsertRowid)
  store.bindDeferredCard(card, seq)
  return seq
}

function callback(id = 'card-1', event = eventId) {
  return {
    action: { messageId: id, eventId: event, actionId: 'confirm' },
    m: {
      messageId: 'card_action:' + event, sender: 'alice', text: '确认；备注：同意',
      channelType: 2, channelId: 'fixture-group',
      deferredForm: { messageId: id, sessionId: 'session-a', conversation, profile: 'octo/v2',
        actionId: 'confirm', values: { comment: '同意' } },
    },
  }
}

function responseJobs(store) {
  return store.db.prepare("SELECT * FROM jobs WHERE message_id LIKE 'card_action:%' ORDER BY seq").all()
}

function claimed(store, id = 'card-1') {
  return store.db.prepare('SELECT claimed FROM card_bindings WHERE message_id=?').get(id).claimed
}

function failInsert(store, table) {
  // Table names come only from the static test cases below.
  store.db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table}
    BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`)
}

test('confirmed binding and original delivery ID survive reopening without changing the job lifecycle', t => {
  const f = fixture(t), card = binding(), seq = publish(f.store, card)
  const original = f.store.db.prepare('SELECT * FROM jobs WHERE seq=?').get(seq)
  assert.equal(original.state, 'queued')
  assert.equal(original.result_id, card.messageId)
  assert.equal(original.input, '创建表单')
  f.reopen()
  assert.deepEqual(f.store.deferredCard(card.messageId), card)
  assert.deepEqual(f.store.cardBinding(card.messageId), card)
  assert.deepEqual(f.store.db.prepare('SELECT * FROM jobs WHERE seq=?').get(seq), original)
  assert.equal(f.store.deferredCard('missing'), null)
  assert.deepEqual(f.store.deferredFeedback(), [])
})

test('failed original delivery write rolls back binding and cleanup; missing jobs cannot leave orphan cards', t => {
  const { store } = fixture(t), card = binding()
  store.bindCard({ messageId: 'old-ordinary', expiresAt: now - 1 })
  const seq = Number(store.add('source', { messageId: 'source', sender: 'alice', text: '原任务' }).lastInsertRowid)
  store.db.exec(`CREATE TRIGGER fail_delivery BEFORE UPDATE OF result_id ON jobs
    BEGIN SELECT RAISE(ABORT, 'fixture delivery failure'); END;`)
  assert.throws(() => store.bindDeferredCard(card, seq), /fixture delivery failure/)
  assert.equal(store.deferredCard(card.messageId), null)
  assert.equal(store.db.prepare('SELECT result_id FROM jobs WHERE seq=?').get(seq).result_id, null)
  assert.ok(store.db.prepare('SELECT 1 FROM card_bindings WHERE message_id=?').get('old-ordinary'))
  store.db.exec('DROP TRIGGER fail_delivery')
  assert.throws(() => store.bindDeferredCard(card, 999), /deferred_job_missing/)
  assert.equal(store.deferredCard(card.messageId), null)
  store.bindDeferredCard(card, seq)
  assert.equal(store.db.prepare('SELECT result_id FROM jobs WHERE seq=?').get(seq).result_id, card.messageId)
  assert.throws(() => store.bindDeferredCard(card, seq), /UNIQUE/)
  assert.deepEqual(store.deferredCard(card.messageId), card)
})

test('add persists trusted deferredForm alongside existing metadata and preserves deduplication', t => {
  const f = fixture(t), { m } = callback()
  const old = { attachment: { id: 'attachment' }, attachments: [{ id: 'file' }],
    parts: [{ type: 'text', text: '原文' }], quoteId: 'quote', command: '/fixture', cardAction: { id: 'ordinary' } }
  assert.equal(f.store.add(eventId, { ...m, ...old, messageSeq: 42, ambient: true }).changes, 1)
  f.store.add('ordinary', { messageId: 'ordinary', sender: 'bob', text: '消息' })
  f.reopen()
  const row = responseJobs(f.store)[0]
  assert.deepEqual(JSON.parse(row.metadata), { ...old, deferredForm: m.deferredForm })
  assert.equal(row.input, m.text)
  assert.equal(row.channel_type, 2)
  assert.equal(row.channel_id, 'fixture-group')
  assert.equal(row.ambient, 1)
  assert.equal(row.message_seq, 42)
  assert.equal(row.route_order, 42)
  assert.equal(row.state, 'queued')
  assert.equal(f.store.db.prepare('SELECT metadata FROM jobs WHERE message_id=?').get('ordinary').metadata, null)
  assert.equal(f.store.add(eventId, { ...m, text: '重放', deferredForm: { changed: true } }).changes, 0)
  assert.deepEqual(responseJobs(f.store)[0], row)
})

test('claim atomically submits, enqueues and owes ACK once; duplicate events never consume another card', t => {
  const f = fixture(t), card = binding(), { action, m } = callback()
  publish(f.store, card)
  assert.equal(f.store.claimDeferredCard(action, m), true)
  assert.equal(claimed(f.store), 1)
  const accepted = f.store.deferredCard(card.messageId)
  assert.deepEqual(accepted, { ...card, deferred: { ...card.deferred, state: 'submitted',
    responseId: m.messageId, feedback: false }, responseState: 'queued' })
  assert.equal(f.store.cardBinding(card.messageId), null)
  assert.deepEqual(JSON.parse(responseJobs(f.store)[0].metadata), { deferredForm: m.deferredForm })
  assert.equal(responseJobs(f.store)[0].state, 'queued')
  assert.equal(f.store.hasEvent(eventId), true)
  assert.deepEqual(f.store.pendingCardAcks(), [eventId])
  assert.equal(f.store.db.prepare('SELECT typeof(event_id) AS kind FROM pending_card_acks').get().kind, 'text')
  assert.equal(f.store.claimDeferredCard(action, m), false)
  const otherEvent = callback(card.messageId, '9007199254740993')
  assert.equal(f.store.claimDeferredCard(otherEvent.action, otherEvent.m), false)
  const otherCard = binding('card-2')
  publish(f.store, otherCard)
  assert.equal(f.store.claimDeferredCard({ ...action, messageId: otherCard.messageId }, m), false)
  assert.deepEqual(f.store.deferredCard(otherCard.messageId), otherCard)
  assert.equal(claimed(f.store, otherCard.messageId), 0)
  assert.equal(responseJobs(f.store).length, 1)
  f.reopen()
  assert.deepEqual(f.store.deferredCard(card.messageId), accepted)
  assert.deepEqual(f.store.pendingCardAcks(), [eventId])
  const seq = responseJobs(f.store)[0].seq
  f.store.running(seq, 'session-a')
  assert.equal(f.store.deferredCard(card.messageId).responseState, 'running')
  f.reopen()
  assert.equal(f.store.deferredCard(card.messageId).responseState, 'review')
  f.store.sent(seq, 'reply')
  assert.equal(f.store.deferredCard(card.messageId).responseState, 'sent')
})

for (const operation of ['claim', 'reject', 'acknowledge']) {
  for (const table of ['jobs', 'pending_card_acks']) {
    test(`${operation}: failure inserting ${table} rolls back every write and can retry after restart`, t => {
      const f = fixture(t), card = binding(), { action, m } = callback()
      publish(f.store, card)
      if (operation === 'acknowledge') f.store.closeDeferredCard(card.messageId, 'cancelled', '已取消')
      const before = f.store.deferredCard(card.messageId), beforeClaimed = claimed(f.store)
      const run = () => operation === 'claim' ? f.store.claimDeferredCard(action, m)
        : operation === 'reject' ? f.store.rejectDeferredCard(action, m, 'invalid', '内容无效')
          : f.store.acknowledgeDeferredEvent(action, m)
      failInsert(f.store, table)
      assert.throws(run, /fixture write failure/)
      assert.deepEqual(f.store.deferredCard(card.messageId), before)
      assert.equal(claimed(f.store), beforeClaimed)
      assert.equal(f.store.hasEvent(eventId), false)
      assert.deepEqual(responseJobs(f.store), [])
      assert.deepEqual(f.store.pendingCardAcks(), [])
      f.store.db.exec('DROP TRIGGER fail_write')
      f.reopen()
      assert.deepEqual(f.store.deferredCard(card.messageId), before)
      assert.equal(run(), true)
      assert.equal(responseJobs(f.store).length, 1)
      assert.equal(responseJobs(f.store)[0].state, operation === 'claim' ? 'queued' : 'ignored')
      assert.deepEqual(f.store.pendingCardAcks(), [eventId])
    })
  }
}

for (const failure of ['remote-rejected', 'remote-response-lost', 'local-ACK-delete']) {
  test(`ACK obligation survives ${failure} and restart without replaying the submitted task`, async t => {
    const f = fixture(t), { action, m } = callback(), attempts = [], received = new Set()
    publish(f.store)
    assert.equal(f.store.claimDeferredCard(action, m), true)
    if (failure === 'local-ACK-delete') f.store.db.exec(`CREATE TRIGGER fail_ack_delete BEFORE DELETE ON pending_card_acks
      BEGIN SELECT RAISE(ABORT, 'fixture ACK delete failure'); END;`)
    // A local stand-in for the transport; no Worker, network or credentials.
    const flush = async send => {
      for (const id of f.store.pendingCardAcks()) { await send(id); f.store.cardAcked(id) }
    }
    await assert.rejects(flush(async id => {
      attempts.push(id)
      if (failure !== 'remote-rejected') received.add(id)
      if (failure !== 'local-ACK-delete') throw new Error('fixture ACK failure')
    }), /fixture ACK/)
    assert.deepEqual(f.store.pendingCardAcks(), [eventId])
    if (failure === 'local-ACK-delete') f.store.db.exec('DROP TRIGGER fail_ack_delete')
    f.reopen()
    assert.equal(f.store.claimDeferredCard(action, m), false)
    await flush(async id => { attempts.push(id); received.add(id) })
    assert.deepEqual(attempts, [eventId, eventId])
    assert.deepEqual([...received], [eventId])
    assert.deepEqual(f.store.pendingCardAcks(), [])
    assert.equal(responseJobs(f.store).length, 1)
    assert.equal(f.store.acknowledgeDeferredEvent(action, m), false, 'redelivery only requeues the ACK')
    assert.deepEqual(f.store.pendingCardAcks(), [eventId])
    assert.equal(responseJobs(f.store)[0].state, 'queued', 'the original task must remain untouched')
    await flush(async () => {})
    assert.deepEqual(f.store.pendingCardAcks(), [])
    assert.equal(responseJobs(f.store).length, 1)
  })
}

for (const first of ['cancel', 'submit']) {
  test(`cancel versus submit: ${first} wins and the other transition cannot overwrite it`, t => {
    const { store } = fixture(t), { action, m } = callback()
    publish(store)
    if (first === 'cancel') {
      assert.equal(store.closeDeferredCard(action.messageId, 'cancelled', '用户已取消'), true)
      assert.equal(store.claimDeferredCard(action, m), false)
      assert.equal(responseJobs(store).length, 0)
      assert.deepEqual(store.pendingCardAcks(), [])
    } else {
      assert.equal(store.claimDeferredCard(action, m), true)
      assert.equal(store.closeDeferredCard(action.messageId, 'cancelled', '用户已取消'), false)
      assert.equal(responseJobs(store).length, 1)
    }
    assert.equal(claimed(store), 1)
    assert.equal(store.deferredCard(action.messageId).deferred.state, first === 'cancel' ? 'cancelled' : 'submitted')
    assert.equal(store.deferredFeedback().length, 1)
  })
}

test('close uses a closed state set, only transitions pending, and remains usable inside a caller transaction', t => {
  const { store } = fixture(t)
  publish(store)
  for (const state of ['pending', 'submitted', 'unknown', '', null, undefined]) {
    assert.throws(() => store.closeDeferredCard('card-1', state, '无效'), /invalid_deferred_card_state/)
  }
  assert.throws(() => store.bindDeferredCard({ ...binding(), deferred: { state: 'submitted' } }, 1), /invalid_deferred_card_state/)
  assert.equal(claimed(store), 0)
  store.db.exec('BEGIN IMMEDIATE')
  assert.equal(store.closeDeferredCard('card-1', 'cancelled', '撤销'), true)
  store.db.exec('ROLLBACK')
  assert.equal(store.deferredCard('card-1').deferred.state, 'pending')
  for (const state of ['cancelled', 'expired', 'invalid', 'unavailable']) {
    publish(store, binding(state))
    assert.equal(store.closeDeferredCard(state, state, '关闭：' + state), true)
    assert.equal(store.closeDeferredCard(state, 'cancelled', '不能覆盖'), false)
    const card = store.deferredCard(state)
    assert.equal(card.deferred.state, state)
    assert.equal(card.deferred.summary, '关闭：' + state)
    assert.equal(card.deferred.feedback, false)
    assert.equal(claimed(store, state), 1)
  }
  assert.equal(store.closeDeferredCard('missing', 'invalid', '无效'), false)
})

for (const state of ['invalid', 'unavailable']) {
  test(`rejection as ${state} atomically closes with an ignored receipt and ACK; repeats never add jobs`, t => {
    const f = fixture(t), { action, m } = callback()
    publish(f.store)
    assert.equal(f.store.rejectDeferredCard(action, m, state, '表单无法处理'), true)
    f.reopen()
    const card = f.store.deferredCard(action.messageId), row = responseJobs(f.store)[0]
    assert.equal(card.deferred.state, state)
    assert.equal(card.deferred.summary, '表单无法处理')
    assert.equal(card.deferred.feedback, false)
    assert.equal(claimed(f.store), 1)
    assert.equal(row.state, 'ignored')
    assert.equal(row.input, '')
    assert.equal(row.metadata, null)
    assert.equal(row.session_id, null)
    assert.deepEqual(f.store.pendingCardAcks(), [eventId])
    assert.equal(f.store.rejectDeferredCard(action, m, state, '重复'), false)
    const another = callback(action.messageId, '901')
    assert.equal(f.store.rejectDeferredCard(another.action, another.m, state, '重复'), false)
    assert.equal(f.store.claimDeferredCard(another.action, another.m), false)
    assert.equal(responseJobs(f.store).length, 1)
    const other = binding('other')
    publish(f.store, other)
    assert.equal(f.store.rejectDeferredCard({ ...action, messageId: other.messageId }, m, state, '重复事件'), false)
    assert.deepEqual(f.store.deferredCard(other.messageId), other)
  })
}

test('only known terminal or expired deferred callbacks get ignored receipts and ACKs, including different button events', t => {
  const f = fixture(t)
  for (const state of ['submitted', 'cancelled', 'expired', 'invalid', 'unavailable', 'pending-expired', 'pending']) {
    const card = binding(state, 'session-a', state === 'pending-expired' ? now : now + day)
    publish(f.store, card)
    if (state === 'submitted') {
      const first = callback(state, '100')
      assert.equal(f.store.claimDeferredCard(first.action, first.m), true)
      f.store.cardAcked('100')
    } else if (!state.startsWith('pending')) f.store.closeDeferredCard(state, state, '已结束')
  }
  f.store.bindCard({ messageId: 'ordinary', expiresAt: now - 1 })
  const before = responseJobs(f.store).length
  for (const [index, id] of ['submitted', 'cancelled', 'expired', 'invalid', 'unavailable', 'pending-expired'].entries()) {
    const { action, m } = callback(id, String(200 + index))
    action.actionId = 'cancel'
    const prior = f.store.deferredCard(id)
    assert.equal(f.store.acknowledgeDeferredEvent(action, m), true)
    const row = responseJobs(f.store).at(-1)
    assert.equal(row.state, 'ignored')
    assert.equal(row.input, '')
    assert.equal(row.metadata, null)
    assert.equal(row.session_id, null)
    assert.deepEqual(f.store.deferredCard(id), prior, 'ACK does not change a terminal or expired form')
    f.store.cardAcked(action.eventId)
    assert.equal(f.store.acknowledgeDeferredEvent(action, m), false)
    assert.ok(f.store.pendingCardAcks().includes(action.eventId))
  }
  for (const id of ['pending', 'ordinary', 'missing']) {
    const { action, m } = callback(id, '300')
    assert.equal(f.store.acknowledgeDeferredEvent(action, m), false)
  }
  assert.equal(responseJobs(f.store).length, before + 6)
  const pending = f.store.pendingCardAcks()
  f.reopen()
  assert.deepEqual(f.store.pendingCardAcks(), pending)
  assert.equal(responseJobs(f.store).filter(row => row.state === 'queued').length, 1)
})

test('callback IDs must be canonical and invalid ACK event IDs roll back all three paths', t => {
  const { store } = fixture(t)
  publish(store)
  publish(store, binding('terminal'))
  store.closeDeferredCard('terminal', 'cancelled', '已取消')
  const { action, m } = callback()
  for (const run of [
    (a, message) => store.claimDeferredCard(a, message),
    (a, message) => store.rejectDeferredCard(a, message, 'invalid', '无效'),
    (a, message) => store.acknowledgeDeferredEvent({ ...a, messageId: 'terminal' }, message),
  ]) {
    assert.throws(() => run(action, { ...m, messageId: 'arbitrary' }), /invalid_deferred_response_id/)
    for (const invalid of ['0', '07', '-1', '9223372036854775808', 7]) {
      assert.throws(() => run({ ...action, eventId: invalid }, { ...m, messageId: 'card_action:' + invalid }), /invalid_card_event_id/)
    }
  }
  assert.equal(claimed(store), 0)
  assert.equal(store.deferredCard('card-1').deferred.state, 'pending')
  assert.deepEqual(responseJobs(store), [])
  assert.deepEqual(store.pendingCardAcks(), [])
})

test('expiry is inclusive, bounded to 50 and durable; expired, claimed and ordinary cards cannot be submitted', t => {
  const f = fixture(t)
  for (let i = 0; i < 52; i++) publish(f.store, binding('expired-' + i, 'session-a', now))
  publish(f.store, binding('future', 'session-a', now + 1))
  publish(f.store, binding('closed', 'session-a', now))
  f.store.closeDeferredCard('closed', 'cancelled', '保留原原因')
  f.store.bindCard({ messageId: 'ordinary', expiresAt: now + day })
  for (const id of ['expired-0', 'closed', 'ordinary', 'missing']) {
    const { action, m } = callback(id)
    assert.equal(f.store.claimDeferredCard(action, m), false)
    assert.equal(f.store.rejectDeferredCard(action, m, 'invalid', '无效'), false)
  }
  assert.equal(f.store.expireDeferredCards(now - 1), 0)
  assert.equal(f.store.expireDeferredCards(now), 50)
  assert.equal(f.store.expireDeferredCards(), 2)
  assert.equal(f.store.expireDeferredCards(now), 0)
  f.reopen()
  for (let i = 0; i < 52; i++) {
    const card = f.store.deferredCard('expired-' + i)
    assert.equal(card.deferred.state, 'expired')
    assert.match(card.deferred.summary, /已过期/)
    assert.equal(card.deferred.feedback, false)
    assert.equal(claimed(f.store, card.messageId), 1)
    assert.equal(f.store.cardBinding(card.messageId), null)
  }
  assert.equal(f.store.deferredCard('future').deferred.state, 'pending')
  assert.equal(f.store.deferredCard('closed').deferred.summary, '保留原原因')
  assert.deepEqual(responseJobs(f.store), [])
  assert.deepEqual(f.store.pendingCardAcks(), [])
})

test('preflight enforces per-session and account quotas but never discards a confirmed send at capacity', t => {
  const f = fixture(t)
  for (let i = 0; i < 9; i++) publish(f.store, binding('a-' + i))
  assert.equal(f.store.canPublishDeferred('session-a'), true)
  publish(f.store, binding('a-9'))
  assert.equal(f.store.canPublishDeferred('session-a'), false)
  assert.equal(f.store.canPublishDeferred('session-b'), true)
  for (let i = 0; i < 39; i++) publish(f.store, binding('other-' + i, 'session-' + (i % 4)))
  assert.equal(f.store.canPublishDeferred('session-b'), true)
  publish(f.store, binding('fiftieth', 'session-b'))
  assert.equal(f.store.canPublishDeferred('session-b'), false)
  const seq = publish(f.store, binding('confirmed-after-check', 'session-a'))
  assert.equal(f.store.db.prepare('SELECT result_id FROM jobs WHERE seq=?').get(seq).result_id, 'confirmed-after-check')
  assert.equal(f.store.deferredCard('confirmed-after-check').deferred.state, 'pending')
  f.reopen()
  assert.equal(f.store.canPublishDeferred('session-b'), false)
  f.store.closeDeferredCard('a-0', 'cancelled', '释放名额')
  assert.equal(f.store.canPublishDeferred('session-b'), false, '50 still pending')
  f.store.closeDeferredCard('a-1', 'cancelled', '释放名额')
  assert.equal(f.store.canPublishDeferred('session-b'), true)
  assert.equal(f.store.canPublishDeferred('session-a'), true)
  const otherAccount = fixture(t, 'another-fixture-bot')
  assert.equal(otherAccount.store.canPublishDeferred('session-a'), true)
})

test('quota counts only unexpired pending deferred forms', t => {
  const { store } = fixture(t)
  for (let i = 0; i < 12; i++) {
    publish(store, binding('expired-' + i, 'session-a', now))
    publish(store, binding('closed-' + i))
    store.closeDeferredCard('closed-' + i, 'unavailable', '不可用')
    store.bindCard({ messageId: 'ordinary-' + i, expiresAt: now + day })
  }
  publish(store, binding('submitted'))
  const { action, m } = callback('submitted')
  store.claimDeferredCard(action, m)
  assert.equal(store.canPublishDeferred('session-a'), true)
  for (let i = 0; i < 9; i++) publish(store, binding('pending-' + i))
  assert.equal(store.canPublishDeferred('session-a'), true)
  publish(store, binding('pending-9'))
  assert.equal(store.canPublishDeferred('session-a'), false)
})

test('feedback is a restart-safe outbox limited to 20 and cannot be marked sent before closure', t => {
  const f = fixture(t)
  publish(f.store, binding('pending'))
  f.store.deferredFeedbackSent('pending')
  assert.equal(f.store.deferredCard('pending').deferred.feedback, undefined)
  for (let i = 0; i < 21; i++) {
    publish(f.store, binding('closed-' + String(i).padStart(2, '0')))
    f.store.closeDeferredCard('closed-' + String(i).padStart(2, '0'), 'unavailable', '无法继续')
  }
  assert.equal(f.store.deferredFeedback().length, 20)
  f.reopen()
  const first = f.store.deferredFeedback()[0]
  f.store.deferredFeedbackSent(first.messageId)
  f.store.deferredFeedbackSent(first.messageId)
  f.store.deferredFeedbackSent('missing')
  f.reopen()
  assert.equal(f.store.deferredCard(first.messageId).deferred.feedback, true)
  assert.equal(f.store.deferredFeedback().length, 20)
  for (const card of f.store.deferredFeedback()) {
    assert.notEqual(card.messageId, first.messageId)
    f.store.deferredFeedbackSent(card.messageId)
  }
  assert.deepEqual(f.store.deferredFeedback(), [])
  assert.equal(f.store.deferredCard('pending').deferred.state, 'pending')
})

test('bindCard preserves overdue pending and unacknowledged feedback, only collects old completed feedback', t => {
  const { store } = fixture(t)
  for (const [id, age] of [['pending', 40], ['unreported', 40], ['reported-recent', 29], ['reported-old', 31]]) {
    publish(store, binding(id, 'session-a', now - age * day))
    if (id !== 'pending') store.closeDeferredCard(id, 'expired', '已过期')
  }
  store.deferredFeedbackSent('reported-recent')
  store.deferredFeedbackSent('reported-old')
  store.bindCard({ messageId: 'expired-question', expiresAt: now - 1, questionKey: 'q', questionFeedback: false })
  store.bindCard({ messageId: 'fresh-question', expiresAt: now + day, questionKey: 'fresh' })
  for (const id of ['pending', 'unreported', 'reported-recent']) assert.ok(store.deferredCard(id))
  assert.equal(store.deferredCard('reported-old'), null)
  assert.equal(store.db.prepare('SELECT 1 FROM card_bindings WHERE message_id=?').get('expired-question'), undefined)
  assert.deepEqual(store.unfinishedQuestionCards().map(card => card.messageId), ['fresh-question'])
})

test('ordinary and question claims retain their queued/ignored and ACK behavior', t => {
  const { store } = fixture(t)
  store.bindCard({ messageId: 'ordinary', expiresAt: now + day })
  store.bindCard({ messageId: 'question', expiresAt: now + day, questionKey: 'q' })
  const plain = callback('ordinary', '401'), question = callback('question', '402')
  delete plain.m.deferredForm
  plain.m.cardAction = { actionId: 'confirm' }
  delete question.m.deferredForm
  assert.equal(store.deferredCard('ordinary'), null)
  assert.equal(store.claimCard(plain.action, plain.m), true)
  assert.equal(store.claimCard(question.action, question.m, 'session-original'), true)
  const rows = responseJobs(store)
  assert.equal(rows[0].state, 'queued')
  assert.deepEqual(JSON.parse(rows[0].metadata), { cardAction: plain.m.cardAction })
  assert.equal(rows[1].state, 'ignored')
  assert.equal(rows[1].session_id, 'session-original')
  assert.deepEqual(store.pendingCardAcks(), ['401', '402'])
  assert.deepEqual(store.deferredFeedback(), [])
  store.finishQuestionCard('question', '已选择')
  store.questionFeedbackSent('question')
  assert.deepEqual(store.unfinishedQuestionCards(), [])
  assert.equal(store.hasOpenCard(), false)
})

test('boundSession is an exact read-only current/history lookup; deleted mappings never revive', t => {
  const f = fixture(t), store = f.store
  const old = store.session(conversation)
  assert.equal(store.boundSession(conversation, old.session_id), null)
  store.sessionCreated(conversation)
  assert.deepEqual(store.boundSession(conversation, old.session_id), { session_id: old.session_id, created: 1 })
  const current = store.session(conversation, 0, now + 1000, true)
  assert.deepEqual(store.boundSession(conversation, old.session_id), { session_id: old.session_id, created: 1 })
  assert.equal(store.boundSession(conversation, current.session_id), null)
  store.sessionCreated(conversation)
  const foreign = store.session('bob')
  store.sessionCreated('bob')
  const snapshot = () => ({
    current: store.db.prepare('SELECT * FROM conversations ORDER BY sender').all(),
    history: store.db.prepare('SELECT * FROM conversation_history ORDER BY session_id').all(),
    changes: store.db.prepare('SELECT total_changes() AS n').get().n,
  })
  const before = snapshot()
  assert.deepEqual(store.boundSession(conversation, current.session_id), { session_id: current.session_id, created: 1 })
  for (const id of [old.session_id, current.session_id]) {
    assert.equal(store.boundSession('bob', id), null)
    assert.equal(store.boundSession(JSON.stringify([2, 'fixture-group', 'bob']), id), null)
    assert.equal(store.boundSession(conversation, id + '-suffix'), null)
  }
  assert.equal(store.boundSession(conversation, foreign.session_id), null)
  assert.equal(store.boundSession('missing', 'missing'), null)
  assert.deepEqual(snapshot(), before)
  publish(store, binding('historical-form', old.session_id))
  store.forgetSession(old.session_id)
  store.forgetSession(current.session_id)
  assert.equal(store.boundSession(conversation, old.session_id), null)
  assert.equal(store.boundSession(conversation, current.session_id), null)
  f.reopen()
  assert.equal(f.store.boundSession(conversation, old.session_id), null)
  assert.equal(f.store.boundSession(conversation, current.session_id), null)
  assert.equal(f.store.db.prepare('SELECT 1 FROM conversations WHERE sender=?').get(conversation), undefined)
  assert.equal(f.store.db.prepare('SELECT 1 FROM conversation_history WHERE sender=?').get(conversation), undefined)
  assert.equal(f.store.deferredCard('historical-form').deferred.sessionId, old.session_id)
  assert.deepEqual(f.store.knownSessions(), [foreign.session_id])
})
