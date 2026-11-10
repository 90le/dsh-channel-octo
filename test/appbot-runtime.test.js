import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OctoClient, admit, permitsRoute } from '../src/octo.js'
import { CHANNEL_API_OPERATIONS } from '../src/channel-api.js'
import { sendCard, resolveCardAction } from '../src/octo-cards.js'
import { Worker } from '../src/worker.js'

const base = { apiBase: 'https://octo.invalid/api', token: 'app_secretfixture', botUid: 'app_fixture_bot',
  botKind: 'app', spaceId: null, ownerUid: 'alice', senderPolicy: 'octo', channelPolicy: 'allowlist',
  allowed: new Set(), groups: new Set(), threads: new Set(), transport: 'websocket' }
const registration = { robot_id: base.botUid, name: 'Fixture', im_token: base.token,
  ws_url: 'wss://octo.invalid/ws', api_url: 'https://octo.invalid/api', owner_uid: 'alice', owner_channel_id: 'alice' }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
const dm = { channel_id: 'alice', channel_type: 1 }
const source = { message_id: '123', message_seq: 1, from_uid: 'alice', ...dm,
  payload: { type: 1, content: 'hello', space_id: 'server-space' } }
function fixture(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace('/api', '')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, body, auth: init.headers.Authorization, method: init.method })
    return handler(path, body, calls)
  }
  const config = { ...base, fetchImpl }
  return { api: new OctoClient(config), config, calls }
}

test('published App Bot identity uses official registration without manufacturing a Space or leaking connection secrets', async () => {
  const f = fixture(() => response({ ...registration, unexpected_secret: 'never expose' }))
  const identity = await f.api.verify(base.botUid, null)
  assert.deepEqual(identity, { botUid: base.botUid, botKind: 'app', spaceId: null, ownerUid: 'alice' })
  assert.deepEqual(await f.api.register(base.botUid), { robot_id: base.botUid, im_token: base.token, ws_url: registration.ws_url })
  assert.equal(f.calls.length, 1, 'reuse startup registration for the first WS connection')
  assert.deepEqual(f.calls[0], { path: '/v1/bot/register', body: {}, auth: 'Bearer ' + base.token, method: 'POST' })
  await f.api.register(base.botUid)
  assert.equal(f.calls.length, 2, 'reconnection obtains a fresh registration')
})

test('App identity and connection errors never fall back to the User Bot endpoint', async t => {
  for (const [name, edit, code] of [
    ['non-App UID', r => { r.robot_id = 'ordinary_bot' }, 'invalid_bot_identity'],
    ['missing owner', r => { delete r.owner_uid }, 'invalid_bot_identity'],
    ['self owner', r => { r.owner_uid = r.robot_id }, 'invalid_bot_identity'],
    ['token owner', r => { r.owner_uid = base.token }, 'invalid_bot_identity'],
    ['insecure socket', r => { r.ws_url = 'ws://outside.invalid/ws' }, 'invalid_ws_url'],
    ['socket credential', r => { r.ws_url = 'wss://user:pass@octo.invalid/ws' }, 'invalid_ws_url'],
    ['missing socket token', r => { delete r.im_token }, 'invalid_bot_registration'],
  ]) await t.test(name, async () => {
    const value = { ...registration }; edit(value)
    const f = fixture(() => response(value))
    await assert.rejects(f.api.identify(), { code })
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].path, '/v1/bot/register')
  })
  const f = fixture(() => response(registration))
  await assert.rejects(f.api.verify('app_other_bot', null), { code: 'bot_identity_mismatch' })
  await assert.rejects(f.api.verify(base.botUid, 'invented-space'), { code: 'bot_identity_mismatch' })
})

test('User Bot identity contract remains verified-Space based', async () => {
  const calls = []
  const api = new OctoClient({ ...base, token: 'bf_fixture', botKind: undefined, botUid: 'user_bot', spaceId: 'space',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ bot_uid: 'user_bot', space_id: 'space', owner_uid: 'alice' }) } })
  assert.deepEqual(await api.verify('user_bot', 'space'), { botUid: 'user_bot', spaceId: 'space', ownerUid: 'alice' })
  assert.equal(calls[0].url, base.apiBase + '/v1/auth/verify-bot')
  assert.equal(calls[0].init.headers.Authorization, undefined)
})

test('App DM checks active human identity and friendship even under local allowlist admission', async t => {
  const job = { sender: 'alice', message_id: '123', ...dm }
  for (const senderPolicy of ['octo', 'allowlist']) await t.test(senderPolicy, async () => {
    const f = fixture(path => path.endsWith('/users/batch')
      ? response({ users: [{ uid: 'alice', name: 'Alice', robot: 0, status: 1 }], missing_uids: [] })
      : response(path.endsWith('/123') ? source : { messages: null }))
    assert.equal(await f.api.allowsMessage({ ...f.config, senderPolicy }, job), true)
    assert.deepEqual(f.calls.map(c => c.path), ['/v1/bot/users/batch', '/v1/bot/messages/sync', '/v1/bot/messages/person/alice/123'])
    assert.equal(f.calls[1].body.limit, 1)
  })
  for (const user of [{ uid: 'alice', robot: 1, status: 1 }, { uid: 'alice', robot: 0, status: 0 },
    { uid: 'other', robot: 0, status: 1 }]) {
    const f = fixture(() => response({ users: [user], missing_uids: [] }))
    assert.equal(await f.api.allowsMessage(f.config, job), false)
    assert.equal(f.calls.length, 1)
  }
  const f = fixture(path => path.endsWith('/users/batch')
    ? response({ users: [{ uid: 'alice', robot: 0, status: 1 }], missing_uids: [] })
    : response({ code: 'err.server.bot_api.not_friend' }, 403))
  await assert.rejects(f.api.allowsMessage(f.config, job))
})

test('App ingress accepts server-managed DM Space metadata but never group/topic or malformed Space', async () => {
  const event = { message: { message_id: '123', from_uid: 'alice', channel_type: 1,
    channel_id: base.botUid, payload: { type: 1, content: 'hello', space_id: 'server-space' } } }
  assert.equal(admit(event, base)?.text, 'hello')
  delete event.message.payload.space_id
  assert.equal(admit(event, base)?.text, 'hello')
  event.message.payload.space_id = { untrusted: true }
  assert.equal(admit(event, base), undefined)
  const hostile = { ...base, channelPolicy: 'joined', groups: new Set(['group']) }
  for (const type of [2, 5]) assert.equal(permitsRoute(hostile, 'alice', type, 'group'), false)
  const f = fixture(() => { throw new Error('must not call API') })
  assert.equal(await f.api.allowsMessage(hostile, { sender: 'alice', channel_type: 2, channel_id: 'group' }), false)
  assert.equal(f.calls.length, 0)
  assert.equal(admit({ message: { ...event.message, payload: { type: 1, content: 'hello', space_id: 'other' } } },
    { ...base, botKind: undefined, spaceId: 'user-space' }), undefined)
})

test('App interaction stays bound to the exact Bot, peer, operator, message and nonce without a fictitious Space', async () => {
  const manifest = { enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'], elements: ['TextBlock'],
    inputs: ['Input.ChoiceSet'], actions: ['Action.OpenUrl'],
    config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
    limits: { max_payload_bytes: 524288, max_nodes: 200, max_depth: 16 } }
  const f = fixture(path => response(path.endsWith('/profile') ? manifest : { message_id: '123' }))
  const { binding } = await sendCard(f.config, dm, { title: 'Choose', actions: [{ id: 'yes', label: 'Yes' }] })
  const event = { event_id: '124', event_type: 'card_action', event_data: {
    message_id: '123', channel_id: 'alice', channel_type: 1, operator_uid: 'alice', action_id: 'yes',
    data: { dsh_card_nonce: binding.cardNonce }, inputs: null,
  } }
  assert.ok(resolveCardAction(event, binding, f.config))
  event.event_data.space_id = 'server-space'
  assert.ok(resolveCardAction(event, binding, f.config))
  for (const change of [{ message_id: '999' }, { operator_uid: 'other' }, { channel_id: 'other' }, { channel_type: 2 },
    { data: { dsh_card_nonce: '0'.repeat(32) } }, { space_id: 7 }]) {
    assert.equal(resolveCardAction({ ...event, event_data: { ...event.event_data, ...change } }, binding, f.config), null)
  }
  assert.equal(resolveCardAction(event, binding, { ...f.config, botUid: 'app_other_bot' }), null)
  assert.equal(resolveCardAction(event, binding, { ...f.config, apiBase: 'https://different.invalid/api' }), null)
  assert.equal(JSON.stringify(binding).includes(base.token + '"'), false)
})

test('App channel tools expose only current DM operations and reject unsupported calls before network access', async () => {
  const f = fixture(() => { throw new Error('unsupported operations must never reach the network') })
  const allowed = ['inspect', 'messages.recent', 'messages.read', 'messages.user_info', 'messages.users_batch',
    'messages.notify', 'messages.mark_read', 'messages.edit', 'messages.edit_richtext', 'messages.edit_display_card',
    'messages.clear_card_revisions', 'cards.registry.list', 'cards.registry.send', 'cards.registry.edit']
  assert.deepEqual(CHANNEL_API_OPERATIONS.filter(s => f.api.channel.supports(s.name)).map(s => s.name).sort(), allowed.sort())
  for (const operation of CHANNEL_API_OPERATIONS.filter(s => !allowed.includes(s.name))) {
    await assert.rejects(f.api.channel.dispatch(dm, 'alice', operation.name, {}), { code: 'api_unsupported' })
  }
  await assert.rejects(f.api.channel.dispatch({ channel_type: 2, channel_id: 'a'.repeat(32) }, 'alice', 'inspect'), { code: 'api_unsupported' })
  assert.equal(f.calls.length, 0)
})

test('App current-DM reads and edits stay bound to real peer and Bot authorship; server Space is preserved as metadata', async () => {
  let original = { message_id: '123', message_seq: 7, from_uid: base.botUid, ...dm,
    payload: { type: 1, content: 'before', space_id: 'scope-managed-by-server' } }
  const f = fixture((path, body) => {
    if (path.endsWith('/users/batch')) return response({ users: [{ uid: 'alice', robot: 0, status: 1 }], missing_uids: [] })
    if (path.endsWith('/messages/sync')) return response({ messages: [original] })
    if (path === '/v1/bot/messages/person/alice/123') return response(original)
    if (path === '/v1/bot/message/edit') return response({ status: 200 })
    throw new Error('unexpected request')
  })
  const result = await f.api.channel.dispatch(dm, 'alice', 'messages.recent', { limit: 3 })
  assert.equal(result.messages[0].text, 'before')
  assert.deepEqual(await f.api.channel.dispatch(dm, 'alice', 'messages.edit', { message_id: '123', text: 'after' }),
    { ok: true, message_id: '123' })
  original = { ...original, from_uid: 'alice' }
  await assert.rejects(f.api.channel.dispatch(dm, 'alice', 'messages.edit', { message_id: '123', text: 'forbidden' }),
    { code: 'bot_message_required' })
  original = { ...original, channel_id: 'someone-else' }
  await assert.rejects(f.api.channel.dispatch(dm, 'alice', 'messages.read', { message_id: '123' }),
    { code: 'message_outside_channel' })
  assert.equal(f.calls.filter(c => c.path === '/v1/bot/message/edit').length, 1)
  assert.ok(f.calls.every(c => !c.path.includes('/space/')))
})

test('App scope loss is denied even when active-human and friendship checks both succeed', async () => {
  const f = fixture(path => {
    if (path.endsWith('/users/batch')) return response({ users: [{ uid: 'alice', robot: 0, status: 1 }], missing_uids: [] })
    if (path.endsWith('/messages/sync')) return response({ messages: [source] })
    if (path.endsWith('/person/alice/123')) return response({ status: 404 }, 404)
    throw new Error('no delivery or mutation may reach the API')
  })
  assert.equal(await f.api.allowsMessage({ ...f.config, senderPolicy: 'allowlist' }, { ...dm, sender: 'alice', message_id: '123' }), false)
  for (const [operation, args] of [['inspect', {}], ['messages.recent', {}],
    ['messages.edit', { message_id: '123', text: 'must not write' }], ['messages.mark_read', { message_ids: ['123'] }]]) {
    await assert.rejects(f.api.channel.dispatch(dm, 'alice', operation, args))
  }
  assert.equal(f.calls.filter(c => c.path.endsWith('/person/alice/123')).length, 5)
})

test('App exact-message authorization rejects missing anchors, foreign peers and hidden/revoked source messages', async t => {
  for (const [name, value] of [
    ['wrong ID', { ...source, message_id: '124' }],
    ['wrong route', { ...source, channel_id: 'bob' }],
    ['foreign author', { ...source, from_uid: 'bob' }],
    ['revoked', { ...source, extra: { revoke: 1 } }],
    ['hidden', { ...source, payload: { ...source.payload, visibles: ['bob'] } }],
  ]) await t.test(name, async () => {
    const f = fixture(path => path.endsWith('/users/batch')
      ? response({ users: [{ uid: 'alice', robot: 0, status: 1 }], missing_uids: [] })
      : response(path.endsWith('/sync') ? { messages: [source] } : value))
    assert.equal(await f.api.allowsMessage(f.config, { ...dm, sender: 'alice', message_id: '123' }), false)
  })
  const f = fixture(path => path.endsWith('/users/batch')
    ? response({ users: [{ uid: 'alice', robot: 0, status: 1 }], missing_uids: [] }) : response({ messages: null }))
  assert.equal(await f.api.allowsMessage(f.config, { ...dm, sender: 'alice' }), false)
  await assert.rejects(f.api.channel.dispatch(dm, 'alice', 'inspect'), { code: 'message_unavailable' })
})

test('App live question answers are persisted before ACK and cannot continue DSH before scope authorization', async () => {
  const gate = Promise.withResolvers(), seen = []
  const worker = new Worker({ config: { ...base, toolPermission: 'workspace-write', toolScope: 'owner' },
    api: { allowsMessage: async () => gate.promise }, log: () => {},
    store: { stageInbox: () => seen.push('persist'), removeStagedInbox: () => seen.push('unstage'),
      rememberAnswer: () => { seen.push('receipt'); return true }, blockInboxRoute: () => seen.push('blocked') } })
  worker.questions.match = () => ({ key: 'question', sessionId: 'session' })
  worker.questions.text = () => seen.push('answer')
  const work = worker.acceptInbound('ws:123', { messageId: '123', messageSeq: 1, sender: 'alice',
    channelId: 'alice', channelType: 1, text: '1' })
  assert.deepEqual(seen, ['persist'])
  await Promise.resolve()
  assert.deepEqual(seen, ['persist'])
  gate.resolve(true)
  await work
  assert.deepEqual(seen, ['persist', 'receipt', 'answer', 'unstage'])
})

test('App live input denied or failing authorization does not answer or steer an active task', async () => {
  for (const throws of [false, true]) {
    const seen = []
    const worker = new Worker({ config: { ...base, toolPermission: 'workspace-write', toolScope: 'owner', sendMode: 'steer' },
      api: { allowsMessage: async () => { if (throws) throw new Error('scope denied'); return false } }, log: () => {},
      store: { stageInbox: () => seen.push('persist'), removeStagedInbox: () => seen.push('unstage'),
        rememberAnswer: () => { seen.push('ignored'); return true }, blockInboxRoute: () => seen.push('blocked') } })
    worker.questions.match = () => ({ key: 'question', sessionId: 'session' })
    worker.questions.text = () => assert.fail('must not answer')
    worker.attemptSteering = () => assert.fail('must not steer')
    await worker.acceptInbound('ws:123', { messageId: '123', messageSeq: 1, sender: 'alice',
      channelId: 'alice', channelType: 1, text: '1' })
    assert.deepEqual(seen, throws ? ['persist', 'blocked'] : ['persist', 'ignored', 'unstage'])
  }
})

test('App input cannot answer a different question that opens during the live scope check', async () => {
  const gate = Promise.withResolvers(), seen = []
  const worker = new Worker({ config: { ...base, toolPermission: 'workspace-write', toolScope: 'owner' },
    api: { allowsMessage: async () => gate.promise }, log: () => {},
    store: { stageInbox() {}, removeStagedInbox() {}, add() { seen.push('queued'); return { changes: 1 } } } })
  let key = 'first'
  worker.questions.match = () => ({ key, sessionId: 'session' })
  worker.questions.text = () => assert.fail('must not answer the new question')
  const work = worker.acceptInbound('ws:123', { messageId: '123', messageSeq: 1, sender: 'alice',
    channelId: 'alice', channelType: 1, text: '1' })
  key = 'second'; gate.resolve(true)
  await work
  assert.deepEqual(seen, ['queued'])
})
