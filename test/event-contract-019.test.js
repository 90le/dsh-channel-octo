import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as settle } from 'node:timers/promises'
import { OctoClient, admit } from '../src/octo.js'

// Official octo-server f984d405: modules/bot_api/events.go:306-320 omits
// BOTH channel fields for DMs; docs/bot-events-longpoll.md defines wait 0..30.
// Only fetch is faked: events, #request, streaming JSON parsing and admit are real.
beforeEach(t => t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network request')))

const eventId = '9223372036854775805', messageId = '9223372036854775806'
const group = 'a'.repeat(32), thread = group + '____123456789012345678'
const ordinary = (fields = {}) => ({ event_id: eventId, message: {
  message_id: messageId, message_seq: 10, from_uid: 'alice', timestamp: 1794268800,
  payload: { type: 1, content: 'hello', space_id: 'space' }, ...fields,
} })
const wire = results => JSON.stringify({ status: 1, results })
  .replaceAll('"' + eventId + '"', eventId).replaceAll('"' + messageId + '"', messageId)

function fixture(respond = () => new Response(wire([ordinary()]))) {
  const calls = []
  const config = { apiBase: 'https://event-contract.invalid/api', token: 'bf_fixture',
    waitSeconds: 15, botUid: 'bot', botKind: 'user', spaceId: 'space',
    allowed: new Set(['alice']), groups: new Set([group]), threads: new Set([thread]),
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init })
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'manual')
      assert.equal(init.headers.Authorization, 'Bearer bf_fixture')
      assert.equal(init.headers['Content-Type'], 'application/json')
      assert.ok(init.signal instanceof AbortSignal)
      return respond(url, init)
    } }
  return { api: new OctoClient(config), config, calls }
}

test('official omitted-field DM is normalized only at events boundary, preserving int64 IDs', async t => {
  const f = fixture(), cursor = '9223372036854775804'
  assert.equal(admit(ordinary(), f.config), undefined, 'generic / WS admission must not infer DM')
  const [event] = await f.api.events(t.signal, cursor, { wait: 0 })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, f.config.apiBase + '/v1/bot/events')
  assert.equal(f.calls[0].body, '{"event_id":' + cursor + ',"limit":20,"wait":0}')
  assert.deepEqual(event, ordinary({ channel_type: 1, channel_id: 'alice' }))
  assert.equal(event.event_id, eventId)
  assert.equal(event.message.message_id, messageId)
  const accepted = admit(event, f.config)
  assert.equal(accepted.messageId, messageId)
  assert.equal(accepted.messageSeq, 10)
  assert.equal(accepted.channelType, 1)
  assert.equal(accepted.channelId, 'alice')
  assert.equal(accepted.sender, 'alice')
  assert.equal(admit(ordinary(), f.config), undefined)
})

test('partial, null and contradictory channel fields never acquire a DM default', async t => {
  const fields = [
    { channel_id: 'alice' }, { channel_id: group }, { channel_id: null }, { channel_id: '' },
    { channel_type: null }, { channel_type: 0 }, { channel_type: '1' },
    { channel_type: 2 }, { channel_type: 5 },
    { channel_type: null, channel_id: 'alice' }, { channel_type: 0, channel_id: 'alice' },
    { channel_type: '1', channel_id: 'alice' }, { channel_type: 2, channel_id: thread },
    { channel_type: 5, channel_id: group },
  ]
  const source = fields.map(ordinary), f = fixture(() => new Response(wire(source)))
  const batch = await f.api.events(t.signal)
  assert.deepEqual(batch, source, 'leave invalid routing evidence intact')
  for (const event of batch) assert.equal(admit(event, f.config), undefined, JSON.stringify(event.message))
})

test('explicit type-1 DMs retain normal sender routing, including internal wire IDs', async t => {
  const source = [ordinary({ channel_type: 1 }), ordinary({ channel_type: 1, channel_id: 'alice' }),
    ordinary({ channel_type: 1, channel_id: 'different-wire-dm-id' })]
  const f = fixture(() => new Response(wire(source))), batch = await f.api.events(t.signal)
  assert.deepEqual(batch, source)
  for (const event of batch) {
    assert.equal(admit(event, f.config).channelType, 1)
    assert.equal(admit(event, f.config).channelId, 'alice')
  }
})

test('ordinary groups and threads retain their explicit routes and admission checks', async t => {
  const source = [ordinary({ channel_type: 2, channel_id: group }), ordinary({ channel_type: 5, channel_id: thread })]
  for (const event of source) event.message.payload.mention = { uids: ['bot'] }
  const f = fixture(() => new Response(wire(source))), batch = await f.api.events(t.signal)
  assert.deepEqual(batch, source)
  assert.deepEqual(batch.map(event => {
    const m = admit(event, f.config)
    return [m.channelType, m.channelId]
  }), [[2, group], [5, thread]])
})

test('typed events and typed payloads remain raw, including ordinary-looking message fields', async t => {
  const source = ['card_action', 'bot_task', 'bot_joined_group', 'future_event'].flatMap(event_type => [
    { ...ordinary(), event_type, event_data: { message_id: messageId, channel_type: 1, channel_id: 'alice' } },
    { ...ordinary({ channel_type: null, channel_id: group }), event_type, event_data: { opaque: true } },
  ])
  source.push(ordinary({ payload: { type: 1, content: 'system notification', event: 'system_event' } }))
  // Malformed type markers are not evidence of an ordinary DM either.
  for (const event_type of ['', null, false, 0]) source.push({ ...ordinary(), event_type })
  const f = fixture(() => new Response(wire(source))), batch = await f.api.events(t.signal)
  assert.deepEqual(batch, source)
  for (const event of batch) assert.equal(admit(event, f.config), undefined)
})

test('omitted DM fields do not bypass sender, self, Space or message ID checks', async t => {
  const source = [ordinary({ from_uid: 'mallory' }), ordinary({ from_uid: 'bot' }),
    ordinary({ from_uid: null }), ordinary({ from_uid: '' }),
    ordinary({ payload: { type: 1, content: 'wrong Space', space_id: 'other-space' } }),
    ordinary({ message_id: '9223372036854775808' })]
  const f = fixture(() => new Response(wire(source)))
  for (const event of await f.api.events(t.signal)) assert.equal(admit(event, f.config), undefined)
})

test('history continues to use its requested route, retaining since_ms suppression', async t => {
  const now = Math.floor(Date.now() / 1000)
  const source = [ordinary({ message_id: '101', message_seq: 10, timestamp: now - 60 }).message,
    ordinary({ message_id: '102', message_seq: 11, timestamp: now - 10 }).message]
  for (const row of source) row.payload.mention = { uids: ['bot'] }
  const f = fixture((url, init) => {
    assert.equal(url, 'https://event-contract.invalid/api/v1/bot/messages/sync')
    assert.deepEqual(JSON.parse(init.body), { channel_type: 2, channel_id: group,
      start_message_seq: 10, end_message_seq: 12, pull_mode: 1, limit: 100 })
    return Response.json({ messages: source })
  })
  const page = await f.api.inboxPage(f.config, { channel_type: 2, channel_id: group,
    since_ms: (now - 30) * 1000 }, 10, 11, t.signal)
  assert.deepEqual(page.suppressed, ['101'])
  assert.deepEqual(page.observed, ['101', '102'])
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].messageId, '102')
  assert.equal(page.messages[0].channelType, 2)
  assert.equal(page.messages[0].channelId, group)
})

test('wait override selects matching request timeout without changing the configured default', async t => {
  const timeouts = [], f = fixture()
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal })
  const cases = [[undefined, 15], [{}, 15], [{ wait: undefined }, 15], [{ wait: 0 }, 0],
    [undefined, 15], [{ wait: 1 }, 1], [{ wait: 30 }, 30]]
  for (const [options, wait] of cases) {
    await f.api.events(t.signal, undefined, options)
    assert.equal(f.calls.at(-1).body, '{"event_id":0,"limit":20,"wait":' + wait + '}')
    assert.equal(timeouts.at(-1), (wait + 10) * 1000)
    assert.equal(f.api.wait, 15)
  }
  f.api.wait = 23
  await f.api.events(t.signal)
  assert.equal(JSON.parse(f.calls.at(-1).body).wait, 23)
  assert.equal(timeouts.at(-1), 33000)
})

test('wait is an integer in 0..30 and invalid options fail before HTTP', async t => {
  const f = fixture()
  for (const wait of [-1, 31, 0.5, NaN, Infinity, -Infinity, '0', '15', null, true, false, 0n, [], {}, Symbol('wait')]) {
    await assert.rejects(f.api.events(t.signal, '0', { wait }), { code: 'invalid_event_wait' })
  }
  f.api.wait = 31
  await assert.rejects(f.api.events(t.signal), { code: 'invalid_event_wait' })
  assert.equal(f.calls.length, 0)
})

for (const wait of [0, 15]) for (const results of [[], null]) {
  test('empty response pacing remains abortable: wait=' + wait + ', results=' + JSON.stringify(results), async t => {
    const f = fixture(() => new Response(wire(results)))
    const started = performance.now()
    let complete = false
    const polling = f.api.events(t.signal, '0', { wait }).then(batch => { complete = true; return batch })
    await settle()
    assert.equal(complete, false)
    assert.deepEqual(await polling, [])
    assert.ok(performance.now() - started >= 700, 'fast empty responses must retain the 750ms pacing delay')
    const stop = new AbortController(), stopped = f.api.events(stop.signal, '0', { wait })
    const rejection = assert.rejects(stopped, { name: 'AbortError' })
    await settle()
    stop.abort()
    await rejection
  })
}
