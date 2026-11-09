import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'
import { OctoError } from '../src/octo.js'
import { sendCard } from '../src/octo-cards.js'

const eventId = '9223372036854775807'
const signal = new AbortController().signal

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'octo-callback-ack-'))
  let store = new Store(root, 'fixture-bot')
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  let data
  const config = {
    apiBase: 'https://callback.invalid/api', botUid: 'bot', spaceId: 'space', token: 'bf_fixture',
    ownerUid: 'alice', allowed: new Set(['alice']), dmCommands: 'safe', transport: 'websocket',
    fetchImpl: async (url, request) => {
      if (url.endsWith('/card/profile')) return Response.json({
        enabled: true, card_version: '1.5', profiles: ['octo/v2'], inputs: ['Input.ChoiceSet'],
        config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
      })
      assert.ok(url.endsWith('/sendMessage'))
      data = JSON.parse(request.body).payload.card.actions[0].data
      return Response.json({ message_id: '400' })
    },
  }
  const { binding } = await sendCard(config, { channel_type: 1, channel_id: 'alice' }, {
    title: 'Choose', actions: [{ id: 'confirm', label: 'Confirm' }],
    choice: { id: 'selection', label: 'Selection', options: [{ title: 'A', value: 'A' }, { title: 'B', value: 'B' }] },
  }, signal)
  store.bindCard(binding)
  const click = { event_id: eventId, event_type: 'card_action', event_data: {
    message_id: '400', action_id: 'confirm', space_id: 'space', channel_id: 'alice', channel_type: 1,
    operator_uid: 'alice', inputs: { selection: 'B' }, data,
  } }
  let polls = 0, sends = 0
  const api = {
    async events() { polls++; return [click] },
    async ack() {},
    async send() { sends++; return '401' },
  }
  const makeWorker = () => new Worker({ api, store, config, log() {}, host: {
    run() { assert.fail('callback receipt/ACK must not invoke the model') },
  } })
  return {
    get store() { return store }, config, api, click, makeWorker,
    get polls() { return polls }, get sends() { return sends },
    reopen() { store.close(); store = new Store(root, 'fixture-bot'); return makeWorker() },
  }
}

test('side loop retries the last closed form without fetching or replaying ordinary events', { timeout: 7000 }, async t => {
  const f = await fixture(t), stop = new AbortController(), acks = []
  t.after(() => stop.abort())
  let polls = 0
  f.api.events = async () => {
    assert.equal(++polls, 1, 'ACK retry must not need another events request')
    return [
      { event_id: '1', message: { message_id: '1', from_uid: 'alice', channel_type: 1,
        payload: { type: 1, content: 'old ordinary backlog' } } },
      { ...f.click, event_id: '2', event_data: { ...f.click.event_data, operator_uid: 'foreign' } },
      f.click,
    ]
  }
  f.api.ack = async id => {
    acks.push(id)
    assert.equal(id, eventId)
    assert.equal(f.store.hasOpenCard(), false)
    assert.deepEqual(f.store.pendingCardAcks(), [eventId])
    assert.equal(f.store.db.prepare('SELECT typeof(event_id) AS type FROM pending_card_acks').get().type, 'text')
    if (acks.length === 1) throw new OctoError('fixture_ack_failed', 503)
    stop.abort()
  }
  const worker = f.makeWorker()
  await worker.pollCardEvents(stop.signal)
  assert.deepEqual(acks, [eventId, eventId])
  assert.deepEqual(f.store.pendingCardAcks(), [])
  assert.equal(polls, 1)
  assert.deepEqual(f.store.db.prepare('SELECT message_id FROM jobs').all().map(row => row.message_id), ['card_action:' + eventId])
})

for (const failure of ['ack-rejected', 'ack-response-lost', 'receipt-delete-failed']) {
  test(`pending ACK survives restart and expired binding after ${failure}`, async t => {
    const f = await fixture(t), acks = [], removed = new Set()
    const worker = f.makeWorker()
    f.api.ack = async id => {
      acks.push(id)
      if (failure !== 'ack-rejected') removed.add(id)
      if (failure !== 'receipt-delete-failed') throw new OctoError('fixture_ack_failed', 503)
    }
    if (failure === 'receipt-delete-failed') {
      f.store.cardAcked = () => { throw new Error('fixture delete failed') }
    }
    await assert.rejects(worker.ingest(signal, true), /fixture/)
    assert.deepEqual(f.store.pendingCardAcks(), [eventId])
    assert.equal(f.store.hasOpenCard(), false)
    await worker.process(f.store.next(Date.now()), signal)
    assert.equal(f.sends, 1)
    // The ACK is owned by the receipt, not an unexpired form or a cursor position.
    f.store.db.prepare('DELETE FROM card_bindings').run()
    const restarted = f.reopen(), stop = new AbortController()
    t.after(() => stop.abort())
    restarted.cursor = eventId
    f.api.events = async () => assert.fail('no forms: retry exact ACK without polling')
    f.api.ack = async id => { acks.push(id); removed.add(id); stop.abort() }
    await restarted.pollCardEvents(stop.signal)
    assert.deepEqual(acks, [eventId, eventId])
    assert.deepEqual([...removed], [eventId])
    assert.deepEqual(f.store.pendingCardAcks(), [])
    assert.equal(f.store.next(Date.now()), undefined)
    assert.equal(f.sends, 1)
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1)
    // A lost server response can redeliver an accepted event. ACK it, never act again.
    f.api.events = async () => [f.click]
    f.api.ack = async id => acks.push(id)
    restarted.cursor = '0'
    await restarted.ingest(signal, true)
    assert.equal(f.store.next(Date.now()), undefined)
    assert.equal(f.sends, 1)
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1)
    assert.deepEqual(f.store.pendingCardAcks(), [])
  })
}

test('pending ACK write failure rolls back the claim and action receipt before any ACK', async t => {
  const f = await fixture(t), worker = f.makeWorker(), acks = []
  f.api.ack = async id => acks.push(id)
  f.store.db.exec(`CREATE TRIGGER fail_card_ack BEFORE INSERT ON pending_card_acks
    BEGIN SELECT RAISE(ABORT, 'fixture storage full'); END;`)
  await assert.rejects(worker.ingest(signal, true), /fixture storage full/)
  assert.equal(f.store.hasOpenCard(), true)
  assert.equal(f.store.hasEvent(eventId), false)
  assert.deepEqual(f.store.pendingCardAcks(), [])
  assert.deepEqual(acks, [])
  f.store.db.exec('DROP TRIGGER fail_card_ack')
  await worker.ingest(signal, true)
  assert.deepEqual(acks, [eventId])
  assert.equal(f.store.hasOpenCard(), false)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1)
})

test('additive migration preserves prior jobs/forms; only canonical owned callback IDs can queue ACK', async t => {
  const f = await fixture(t)
  f.store.add('7', { messageId: '7', sender: 'alice', text: 'ordinary queued task' })
  const prior = f.store.db.prepare('SELECT * FROM jobs').all()
  // A v0.7.0 database has the same tables and columns except this new outbox.
  f.store.db.exec('DROP TABLE pending_card_acks')
  f.reopen()
  assert.deepEqual(f.store.db.prepare('SELECT * FROM jobs').all(), prior)
  assert.equal(f.store.hasOpenCard(), true)
  assert.deepEqual(f.store.pendingCardAcks(), [])
  assert.equal(f.store.queueCardAck('7'), false)
  assert.equal(f.store.queueCardAck(eventId), false)
  for (const id of [Number(eventId), 7, '0', '07', '-1', '9223372036854775808']) {
    assert.throws(() => f.store.queueCardAck(id), /invalid_card_event_id/)
  }
  assert.deepEqual(f.store.pendingCardAcks(), [])
})

test('ACK retry below a later cursor never reclaims the card or acknowledges a foreign event', async t => {
  const f = await fixture(t), worker = f.makeWorker(), acks = []
  f.click.event_id = '9007199254740993'
  const foreign = { ...f.click, event_id: '9007199254740994',
    event_data: { ...f.click.event_data, message_id: '999' } }
  f.api.events = async () => [foreign, f.click]
  f.api.ack = async id => { acks.push(id); throw new OctoError('fixture_ack_failed', 503) }
  await assert.rejects(worker.ingest(signal, true), /fixture_ack_failed/)
  worker.cursor = eventId
  f.api.ack = async id => acks.push(id)
  await worker.ingest(signal, true)
  assert.deepEqual(acks, ['9007199254740993', '9007199254740993'])
  assert.equal(worker.cursor, eventId)
  assert.equal(f.store.hasEvent(foreign.event_id), false)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1)
  assert.deepEqual(f.store.pendingCardAcks(), [])
})
