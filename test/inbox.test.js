import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { InboxRecovery } from '../src/inbox.js'
import { OctoClient } from '../src/octo.js'

const signal = new AbortController().signal
const route = { channel_type: 1, channel_id: 'human' }
const config = { botUid: 'bot', spaceId: 'space', allowed: new Set(['human']), transport: 'websocket' }
const message = seq => ({ messageId: String(seq), messageSeq: seq, sender: 'human', channelId: 'human', channelType: 1, text: 'message ' + seq })
const wire = seq => ({ message_id: String(seq), message_seq: seq, channel_type: 1, channel_id: 'internal-dm', from_uid: 'human', payload: { type: 1, content: 'message ' + seq } })
function fixture(t, initial = []) {
  const dir = mkdtempSync(join(tmpdir(), 'octo-inbox-')), store = new Store(dir, 'fixture')
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const state = { rows: initial, received: [], requests: [], config, logs: [] }
  const api = new OctoClient({ ...config, apiBase: 'https://fixture.invalid/api', token: 'bf_fixture', fetchImpl: async (_url, options) => {
    const req = JSON.parse(options.body); state.requests.push(req)
    if (state.reply) return state.reply(req)
    const rows = [...state.rows].sort((a, b) => a.message_seq - b.message_seq)
    return Response.json({ messages: req.pull_mode === 0 ? rows.slice(-1)
      : rows.filter(row => row.message_seq >= req.start_message_seq && (!req.end_message_seq || row.message_seq < req.end_message_seq)).slice(0, req.limit) })
  } })
  const inbox = new InboxRecovery({ api, store, config: () => state.config, log: l => state.logs.push(l),
    accept: (id, m, options) => { state.received.push({ id, m, options }); store.add(id, m) } })
  return { inbox, store, api, state, dir }
}

test('first real intake enrolls without executing pre-upgrade history', async t => {
  const { inbox, store, state } = fixture(t, [wire(1), wire(50)])
  inbox.connection(true)
  inbox.receive('ws:50', message(50))
  assert.equal(store.inboxRoute(1, 'human').floor_seq, 49)
  inbox.connection(false); inbox.connection(true)
  await inbox.sweep(signal)
  assert.deepEqual(state.received.map(x => x.m.messageSeq), [50])
  assert.equal(store.inboxRoute(1, 'human').checkpoint, 50)
  assert.equal(store.inboxRoute(1, 'human').blocked, 0)
})

test('reconnect stages live work before ACK and releases missing work in channel order', async t => {
  const { inbox, store, state } = fixture(t, [wire(100)])
  inbox.connection(true); inbox.receive('ws:100', message(100)); store.sent(store.next(Date.now()).seq, 'reply')
  inbox.connection(false)
  // This packet can arrive in the same frame as CONNACK, before connect resolves.
  inbox.receive('ws:103', message(103))
  assert.equal(store.stagedInbox(route).length, 1)
  assert.equal(store.next(Date.now()), undefined)
  state.rows.push(wire(101), wire(102), wire(103))
  inbox.connection(true); await inbox.sweep(signal)
  assert.deepEqual(state.received.map(x => x.m.messageSeq), [100, 101, 102, 103])
  assert.equal(state.received[1].options.historical, true)
  assert.equal(state.received[3].options.historical, false)
  assert.equal(store.stagedInbox(route).length, 0)
  assert.equal(store.next(Date.now()).message_seq, 101)
})

test('same route queue orders channel sequences even when local insertion differs', t => {
  const { store } = fixture(t)
  store.add('ws:12', message(12)); store.add('history:11', message(11))
  const first = store.next(Date.now()); assert.equal(first.message_seq, 11)
  store.sent(first.seq, 'sent')
  assert.equal(store.next(Date.now()).message_seq, 12)
})

test('cursor and staged input survive process reopen without rerunning a committed receipt', async t => {
  const { inbox, store, state, dir } = fixture(t, [wire(10), wire(11), wire(12)])
  inbox.connection(true); inbox.receive('ws:10', message(10)); inbox.connection(false)
  store.checkpointInbox(route, 12, [message(11), message(12)], ['10', '11', '12'])
  store.add('history:11', message(11)) // crash after ordinary receipt before stage deletion
  store.close()
  const reopened = new Store(dir, 'fixture')
  // Keep fixture cleanup valid, and give the recovery process the reopened writer.
  store.db = reopened.db; store.lease = reopened.lease
  inbox.connection(true); await inbox.sweep(signal)
  assert.deepEqual(store.db.prepare('SELECT message_id FROM jobs ORDER BY message_seq').all().map(r => r.message_id), ['10', '11', '12'])
  assert.equal(store.stagedInbox(route).length, 0)
  assert.equal(store.inboxRoute(1, 'human').checkpoint, 12)
})

test('filtered history is durably seen and not replayed after later policy expansion', async t => {
  const { inbox, store, state } = fixture(t, [wire(10), { ...wire(11), payload: { type: 1, content: '/not-enabled' } }])
  inbox.connection(true); inbox.receive('ws:10', message(10)); inbox.connection(false); inbox.connection(true)
  await inbox.sweep(signal)
  assert.equal(store.inboxSeen('11'), true)
  // A later edited history result must not turn a previously consumed message into new work.
  state.rows[1].payload.content = 'now looks like chat'
  inbox.connection(false); inbox.connection(true); await inbox.sweep(signal)
  assert.deepEqual(state.received.map(x => x.m.messageSeq), [10])
})

test('pages use fixed upper exclusive bound and ignore absent more field', async t => {
  const { inbox, store, state } = fixture(t, Array.from({ length: 205 }, (_, i) => wire(i + 1)))
  inbox.connection(true); inbox.receive('ws:1', message(1)); inbox.connection(false); inbox.connection(true)
  await inbox.sweep(signal)
  assert.equal(store.inboxRoute(1, 'human').checkpoint, 205)
  assert.equal(state.received.length, 205)
  assert.deepEqual(state.requests.filter(r => r.pull_mode === 1).map(r => [r.start_message_seq, r.end_message_seq]), [[1, 206], [101, 206], [201, 206]])
})

test('page budget preserves a blocked checkpoint and subsequent pass catches up', async t => {
  const { inbox, store, state } = fixture(t, Array.from({ length: 1250 }, (_, i) => wire(i + 1)))
  inbox.connection(true); inbox.receive('ws:1', message(1)); inbox.connection(false); inbox.connection(true)
  await inbox.sweep(signal)
  assert.equal(store.inboxRoute(1, 'human').checkpoint, 1000)
  assert.equal(store.inboxRoute(1, 'human').blocked, 1)
  assert.equal(state.received.length, 1)
  await inbox.sweep(signal)
  assert.equal(store.inboxRoute(1, 'human').checkpoint, 1250)
  assert.equal(store.inboxRoute(1, 'human').blocked, 0)
  assert.equal(state.received.length, 1250)
})

test('late published rows inside overlap are recovered once', async t => {
  const { inbox, state } = fixture(t, [wire(100), wire(102)])
  inbox.connection(true); inbox.receive('ws:100', message(100)); inbox.connection(false); inbox.connection(true)
  await inbox.sweep(signal)
  state.rows.push(wire(101))
  inbox.connection(false); inbox.connection(true); await inbox.sweep(signal)
  inbox.connection(false); inbox.connection(true); await inbox.sweep(signal)
  assert.deepEqual(state.received.map(x => x.m.messageSeq), [100, 102, 101])
})

test('history parser preserves int64 IDs, edited content and filters revoked or foreign messages', async t => {
  const { api, state } = fixture(t)
  state.reply = () => new Response('{"messages":[{"message_id":9223372036854775807,"message_seq":1,"from_uid":"human","payload":{"type":1,"content":"old"},"message_extra":{"content_edit":{"type":1,"content":"edited"}}},{"message_id":"2","message_seq":2,"from_uid":"human","payload":{"type":1,"content":"revoked"},"message_extra":{"revoke":1}}]}')
  const result = await api.inboxPage(config, route, 1, 2, signal)
  assert.equal(result.last, 2)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].messageId, '9223372036854775807')
  assert.equal(result.messages[0].text, 'edited')
  assert.deepEqual(result.observed, ['9223372036854775807', '2'])
  state.reply = () => Response.json({ messages: [{ ...wire(1), from_uid: 'stranger' }] })
  await assert.rejects(api.inboxPage(config, route, 1, 2, signal), /invalid_inbox_response/)
})

test('malformed or out-of-window pages never advance the durable checkpoint', async t => {
  const { inbox, store, state } = fixture(t, [wire(10), wire(11)])
  inbox.connection(true); inbox.receive('ws:10', message(10)); inbox.connection(false); inbox.connection(true)
  state.reply = req => Response.json({ messages: req.pull_mode === 0 ? [wire(11)] : [wire(99)] })
  await inbox.sweep(signal)
  assert.equal(store.inboxRoute(1, 'human').checkpoint, 9)
  assert.equal(store.inboxRoute(1, 'human').blocked, 1)
  assert.deepEqual(state.logs, ['octo_inbox_recovery_unavailable'])
})
