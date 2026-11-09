import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { ChannelApi, CHANNEL_API_OPERATIONS } from '../src/channel-api.js'
import { OctoClient } from '../src/octo.js'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'

const group = 'a'.repeat(32), otherGroup = 'b'.repeat(32), short = '12345678901234567'
const groupRoute = { channel_id: group, channel_type: 2 }
const topicRoute = { channel_id: group + '____' + short, channel_type: 5 }
const dmRoute = { channel_id: 'alice', channel_type: 1 }
const whID = 'iwh_' + 'c'.repeat(32)
const names = ['messages.user_info', 'messages.users_batch', 'webhooks.list', 'webhooks.deliveries']
const secret = 'NEVER_RETURN_THIS_SECRET'
const extras = { token: secret, url: 'https://secret.invalid/' + secret, urls: { native: secret },
  avatar: secret, adapter_examples: [{ token: secret }], raw: secret, ip: secret }
const webhook = (thread = false) => ({ webhook_id: whID, group_no: group,
  ...(thread && { thread_short_id: short }), name: 'Build status', creator_uid: 'bot', status: 1,
  allow_mention_all: 0, allow_mention_bots: 0, mention_uids: ['elsewhere'],
  last_used_at: 0, call_count: 2, created_at: 100, ...extras })
const delivery = () => ({ status: 1, reason: '', http_status: 200, adapter: 'native',
  byte_size: 120, message_id: '9223372036854775807', created_at: 100, ...extras })

// Exercise the real HTTP method/body/error/JSON-int64 boundary in OctoClient.
// No sockets, environment credentials or live endpoints; every URL is matched.
function fixture(t, { route = groupRoute, sender = 'alice', config = {}, respond } = {}) {
  const calls = [], unexpected = []
  const bot = config.botUid ?? 'bot'
  const root = '/v1/bot/groups/' + group
  const threadPath = root + '/threads/' + short
  const hookPath = (route.channel_type === 5 ? threadPath : root) + '/incoming-webhooks'
  const state = {
    groups: [{ group_no: group, space_id: 'space' }],
    members: [{ uid: 'alice', name: 'Alice', role: 1, robot: 0 },
      { uid: bot, name: 'Bot', role: 0, robot: 1 },
      { uid: 'bob', name: 'Bob', role: 0, robot: 0 },
      { uid: 'carol', name: 'Carol', role: 0, robot: 0 }],
    group: { group_no: group, name: 'Current', status: 1 },
    thread: { group_no: group, short_id: short, channel_id: topicRoute.channel_id, channel_type: 5,
      name: 'Topic', creator_uid: 'alice', status: 1 },
    participants: [{ uid: 'bob', role: 0 }],
    webhooks: [webhook(route.channel_type === 5)], deliveries: [delivery()],
  }
  const api = new OctoClient({ apiBase: 'https://octo.invalid', token: 'bf_fixture', botUid: bot,
    spaceId: 'space', ownerUid: 'alice', ...config, fetchImpl: async (input, init) => {
      const url = new URL(input)
      const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(init.body) }
      calls.push(call)
      if (url.origin !== 'https://octo.invalid' || init.redirect !== 'manual'
        || init.headers.Authorization !== 'Bearer ' + (config.token ?? 'bf_fixture')) unexpected.push('invalid transport')
      let value = await respond?.({ ...call, state, calls })
      if (value === undefined) {
        if (call.path === '/v1/bot/groups') value = state.groups
        else if (call.path === root + '/members') value = state.members
        else if (call.path === root) value = state.group
        else if (call.path === threadPath) value = state.thread
        else if (call.path === threadPath + '/members') value = state.participants
        else if (call.path === hookPath) value = { list: state.webhooks, ...extras }
        else if (call.path === hookPath + '/' + whID + '/deliveries') value = { list: state.deliveries, ...extras }
        else if (call.path === '/v1/bot/messages/sync') value = { messages: [] }
        else if (call.path === '/v1/bot/user/info') value = { uid: call.query.uid.replace(/^s\d+_(.+)$/, '$1'), name: 'Name', ...extras }
        else if (call.path === '/v1/bot/users/batch') value = { users: call.body.uids.map(uid => ({ uid,
          status: 1, robot: uid === bot ? 1 : 0, name: uid, ...extras })), missing_uids: [], ...extras }
        else { unexpected.push(call); return new Response('unexpected fixture path', { status: 500 }) }
      }
      if (!['GET', 'POST'].includes(call.method) || call.method === 'POST'
        && !['/v1/bot/users/batch', '/v1/bot/messages/sync'].includes(call.path)) unexpected.push(call)
      return value instanceof Response ? value : Response.json(value)
    } })
  t.after(() => assert.deepEqual(unexpected, [], 'only fixed read HTTP contracts may be used'))
  return { api, calls, state, hookPath, run: (operation, args = {}, target = route, actor = sender, signal) =>
    api.channel.dispatch(target, actor, operation, args, signal) }
}
const identityCalls = f => f.calls.filter(call => ['/v1/bot/user/info', '/v1/bot/users/batch'].includes(call.path))
const hookCalls = f => f.calls.filter(call => call.path.includes('incoming-webhooks'))
const noSecret = result => assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN|secret\.invalid|avatar|mention_uids|adapter_examples|"token"|"urls?"|"raw"|"ip"/)

test('four bounded operations use ordinary frozen readonly schemas', () => {
  for (const name of names) {
    const spec = CHANNEL_API_OPERATIONS.find(spec => spec.name === name)
    assert.ok(spec.available)
    assert.equal(spec.mutating, false)
    assert.equal(spec.parameters.additionalProperties, false)
    assert.ok(Object.isFrozen(spec.parameters.properties))
    assert.equal(spec.parameters.properties.channel_id, undefined)
  }
  assert.deepEqual(CHANNEL_API_OPERATIONS.filter(spec => spec.name.startsWith('webhooks.') && !spec.mutating).map(spec => spec.name), names.slice(2))
})

test('identity info uses bot GET query, returns only admitted key/name, and rechecks membership', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.run('messages.user_info', { uid: 'bob' }), { uid: 'bob', name: 'Name' })
  assert.deepEqual(identityCalls(f), [{ path: '/v1/bot/user/info', query: { uid: 'bob' }, method: 'GET', body: undefined }])
  assert.equal(f.calls.filter(call => call.path.endsWith('/members')).length, 2)
})

test('DM identity admits only current actor and this bot for either token kind', async t => {
  for (const [token, botUid] of [['bf_fixture', 'bot'], ['app_fixture', 'app_example_bot']]) {
    await t.test(token, async t => {
      const f = fixture(t, { route: dmRoute, config: { token, botUid } })
      for (const uid of ['alice', botUid]) {
        noSecret(await f.run('messages.user_info', { uid }))
      }
      assert.ok(f.calls.filter(call => call.path.endsWith('/sync')).every(call => call.method === 'POST'
        && call.body.channel_id === 'alice' && call.body.channel_type === 1 && call.body.limit === 1))
      const before = identityCalls(f).length
      for (const uid of ['bob', 's123_alice', 'ALICE']) {
        await assert.rejects(f.run('messages.user_info', { uid }), { code: 'identity_outside_channel' })
      }
      assert.equal(identityCalls(f).length, before)
    })
  }
  const f = fixture(t, { route: { channel_id: 'bob', channel_type: 1 }, sender: 'bob' })
  await assert.rejects(f.run('messages.user_info', { uid: 'alice' }), { code: 'identity_outside_channel' })
  await assert.rejects(f.run('messages.user_info', { uid: 'bob' }, dmRoute, 'bob'), { code: 'requester_not_allowed' })
  assert.equal(identityCalls(f).length, 0)
})

test('group and topic visibility is live, exact, and does not inherit other routes', async t => {
  const f = fixture(t, { route: topicRoute })
  for (const uid of ['bob', 'alice', 'bot']) noSecret(await f.run('messages.user_info', { uid }))
  for (const uid of ['carol', 's1_bob', 'outside']) {
    await assert.rejects(f.run('messages.user_info', { uid }), { code: 'identity_outside_channel' })
  }
  f.state.participants.push({ uid: 'departed', role: 0 })
  await assert.rejects(f.run('messages.user_info', { uid: 'departed' }), { code: 'identity_outside_channel' })
  f.state.participants[0].is_deleted = 1
  await assert.rejects(f.run('messages.user_info', { uid: 'bob' }), { code: 'identity_outside_channel' })
  assert.equal(identityCalls(f).length, 3)
  await f.run('messages.user_info', { uid: 'carol' }, groupRoute)
  await assert.rejects(f.run('messages.user_info', { uid: 'carol' }), { code: 'identity_outside_channel' })
})

test('batch uses exact bot POST, maps aliases only after visibility, and partitions missing targets', async t => {
  const f = fixture(t, { respond: call => call.path === '/v1/bot/users/batch' ? {
    users: [{ uid: 's123_bob', name: 'Bob', status: 1, robot: 0, ...extras }], missing_uids: ['bot'], ...extras,
  } : undefined })
  f.state.members.find(row => row.uid === 'bob').uid = 's123_bob'
  const result = await f.run('messages.users_batch', { uids: ['bot', 's123_bob'] })
  assert.deepEqual(result, { users: [{ uid: 's123_bob', name: 'Bob', status: 1, robot: 0 }], missing_uids: ['bot'] })
  assert.deepEqual(identityCalls(f), [{ path: '/v1/bot/users/batch', query: {}, method: 'POST', body: { uids: ['bot', 's123_bob'] } }])
  assert.deepEqual(await f.run('messages.user_info', { uid: 's123_bob' }), { uid: 's123_bob', name: 'Name' })
  await assert.rejects(f.run('messages.user_info', { uid: 'bob' }), { code: 'identity_outside_channel' })
  noSecret(result)
})

test('invalid identifiers, argument hooks, scope overrides and oversized batches fail before HTTP', async t => {
  const f = fixture(t)
  let invoked = false
  const getter = Object.defineProperty({}, 'uid', { enumerable: true, get() { invoked = true; return 'bob' } })
  const array = ['bob']; array.toJSON = () => { invoked = true; return ['carol'] }
  const cases = [
    ['messages.user_info', getter], ['messages.users_batch', { uids: array }],
    ['messages.user_info', { uid: 'bob', toJSON() { invoked = true } }],
    ['messages.user_info', { uid: 'bob', [Symbol('route')]: 'x' }],
    ...['../bob', '%2e%2e', 'a/b', 'a\\b', 'a?uid=x', '..', 's1_..', 'a'.repeat(65)].map(uid => ['messages.user_info', { uid }]),
    ['messages.users_batch', { uids: [] }], ['messages.users_batch', { uids: Array.from({ length: 21 }, (_, n) => 'u' + n) }],
    ['messages.users_batch', { uids: ['bob', 'bob'] }], ['messages.users_batch', { uids: ['bob', 's1_bob'] }],
    ['messages.users_batch', { uids: ['bob', 'BOB'] }], ['messages.users_batch', { uids: Array(2) }],
    ['messages.user_info', { uid: 'bob', channel_id: otherGroup }],
    ['webhooks.list', { short_id: short }], ['webhooks.list', { limit: 51 }],
    ...[whID + '/../test', '../x', whID + '%2frotate', 'iwh_x', 'https://bad.invalid'].map(webhook_id => ['webhooks.deliveries', { webhook_id }]),
  ]
  for (const [operation, args] of cases) await assert.rejects(f.run(operation, args), { code: 'invalid_arguments' })
  for (const channel_id of ['..', 'a/../../b', group + '____../x', group + '____' + short + '/..']) {
    await assert.rejects(f.run('webhooks.list', {}, { channel_id, channel_type: 5 }), { code: 'invalid_route' })
  }
  assert.equal(invoked, false)
  assert.equal(f.calls.length, 0)
})

test('inputs are detached before the first async access check', async t => {
  const args = { uids: ['bob'] }
  const f = fixture(t, { respond: call => {
    if (call.path === '/v1/bot/groups') args.uids[0] = 'outside'
  } })
  const result = await f.run('messages.users_batch', args)
  assert.equal(result.users[0].uid, 'bob')
  assert.deepEqual(identityCalls(f)[0].body, { uids: ['bob'] })
})

test('all new reads retain route/Space/sender admission and reject malformed topic visibility', async t => {
  for (const operation of names) {
    const args = operation === 'messages.user_info' ? { uid: 'bob' }
      : operation === 'messages.users_batch' ? { uids: ['bob'] }
        : operation === 'webhooks.deliveries' ? { webhook_id: whID } : {}
    for (const [config, code] of [
      [{ channelPolicy: 'allowlist', groups: [] }, 'route_not_allowed'],
      [{ senderPolicy: 'allowlist', allowed: [] }, 'requester_not_allowed'],
    ]) {
      const f = fixture(t, { config })
      await assert.rejects(f.run(operation, args), { code })
      assert.equal(f.calls.length, 0)
    }
    const foreign = fixture(t)
    await assert.rejects(foreign.run(operation, args, { channel_type: 2, channel_id: otherGroup }), { code: 'group_access_denied' })
    assert.equal(foreign.calls.length, 1)
    assert.equal(identityCalls(foreign).length + hookCalls(foreign).length, 0)
  }
  for (const participants of [null, {}, [{ uid: 'bob', role: 2 }], [{ uid: 'bob', role: 0 }, { uid: 'bob', role: 0 }]]) {
    const f = fixture(t, { route: topicRoute }); f.state.participants = participants
    await assert.rejects(f.run('messages.user_info', { uid: 'bob' }), { code: 'invalid_thread_response' })
    assert.equal(identityCalls(f).length, 0)
  }
})

test('identity malformed replies never produce partial data', async t => {
  const user = { uid: 'bob', name: 'Bob', status: 1, robot: 0 }
  const cases = [
    ['messages.user_info', { uid: 'outside', name: secret }],
    ['messages.user_info', { uid: 'bob', name: { token: secret } }],
    ['messages.users_batch', { users: [user], missing_uids: ['bob'] }],
    ['messages.users_batch', { users: [user, user], missing_uids: [] }],
    ['messages.users_batch', { users: [{ ...user, uid: 'outside' }], missing_uids: [] }],
    ['messages.users_batch', { users: [{ ...user, status: 0 }], missing_uids: [] }],
    ['messages.users_batch', { users: [{ ...user, robot: 2 }], missing_uids: [] }],
    ['messages.users_batch', { users: [], missing_uids: [] }],
    ['messages.users_batch', { users: null, missing_uids: ['bob'] }],
    ['messages.users_batch', { users: [], missing_uids: ['outside'] }],
    ['messages.users_batch', { users: [user] }],
  ]
  for (const [operation, response] of cases) {
    const f = fixture(t, { respond: call => ['/v1/bot/user/info', '/v1/bot/users/batch'].includes(call.path) ? response : undefined })
    await assert.rejects(f.run(operation, operation === 'messages.user_info' ? { uid: 'bob' } : { uids: ['bob'] }), { code: 'invalid_identity_response' })
  }
  for (const response of [{}, { messages: {} }, { messages: 'malformed' }]) {
    const dm = fixture(t, { route: dmRoute, respond: call => call.path.endsWith('/sync') ? response : undefined })
    await assert.rejects(dm.run('messages.user_info', { uid: 'alice' }), { code: 'invalid_api_response' })
    assert.equal(identityCalls(dm).length, 0)
  }
})

test('official empty DM sync messages:null admits scoped info and batch reads', async t => {
  const dm = fixture(t, { route: dmRoute, respond: call => call.path.endsWith('/sync') ? { messages: null } : undefined })
  assert.deepEqual(await dm.run('messages.user_info', { uid: 'alice' }), { uid: 'alice', name: 'Name' })
  assert.deepEqual((await dm.run('messages.users_batch', { uids: ['alice', 'bot'] })).users.map(row => row.uid), ['alice', 'bot'])
  assert.equal(dm.calls.filter(call => call.path.endsWith('/sync')).length, 4)
  await assert.rejects(dm.run('messages.user_info', { uid: 'bob' }), { code: 'identity_outside_channel' })
})

test('membership, topic visibility and DM access revoked during identity lookup suppress results', async t => {
  for (const [who, code] of [['bob', 'identity_outside_channel'], ['alice', 'requester_not_member'], ['bot', 'bot_not_member']]) {
    const f = fixture(t, { respond: call => {
      if (call.path === '/v1/bot/user/info') call.state.members = call.state.members.filter(row => row.uid !== who)
    } })
    await assert.rejects(f.run('messages.user_info', { uid: 'bob' }), { code })
  }
  const topic = fixture(t, { route: topicRoute, respond: call => {
    if (call.path === '/v1/bot/users/batch') call.state.participants = []
  } })
  await assert.rejects(topic.run('messages.users_batch', { uids: ['bob'] }), { code: 'identity_outside_channel' })
  let probes = 0
  const dm = fixture(t, { route: dmRoute, respond: call => call.path.endsWith('/sync') && ++probes === 2
    ? new Response(secret, { status: 403 }) : undefined })
  await assert.rejects(dm.run('messages.user_info', { uid: 'alice' }), { code: 'api_permission_denied' })
})

test('webhook list uses exact current group/topic GET and projects metadata only', async t => {
  for (const route of [groupRoute, topicRoute]) {
    const f = fixture(t, { route })
    f.state.webhooks.push({ ...webhook(route.channel_type === 5), webhook_id: 'iwh_' + 'd'.repeat(32) })
    const result = await f.run('webhooks.list', { limit: 1 })
    assert.equal(result.total, 2)
    assert.equal(result.truncated, true)
    assert.equal(result.webhooks.length, 1)
    assert.equal(result.webhooks[0].thread_short_id, route.channel_type === 5 ? short : undefined)
    noSecret(result)
    assert.deepEqual(hookCalls(f), [{ path: f.hookPath, query: {}, method: 'GET', body: undefined }])
    assert.equal(f.calls.filter(call => call.path.endsWith('/members')).length, 2)
  }
})

test('webhook reads require live human management role and bot access, not bot ownership', async t => {
  for (const operation of names.slice(2)) {
    const args = operation === 'webhooks.list' ? {} : { webhook_id: whID }
    for (const [change, code] of [
      [s => { s.members[0].role = 0 }, 'requester_admin_required'],
      [s => { s.members[0].robot = 1 }, 'requester_not_member'],
      [s => { s.members[0].status = 0 }, 'requester_not_member'],
      [s => { s.members[1].is_deleted = 1 }, 'bot_not_member'],
      [s => { s.groups = [] }, 'group_access_denied'],
      [s => { s.groups[0].space_id = 'elsewhere' }, 'group_access_denied'],
      [s => { s.group.status = 2 }, 'group_not_active'],
    ]) {
      const f = fixture(t); change(f.state)
      await assert.rejects(f.run(operation, args), { code })
      assert.equal(hookCalls(f).length, 0)
    }
    const dm = fixture(t, { route: dmRoute })
    await assert.rejects(dm.run(operation, args), { code: 'group_required' })
    assert.equal(dm.calls.length, 0)
  }
  const app = fixture(t, { config: { token: 'app_fixture' } }); app.state.groups = []
  await assert.rejects(app.run('webhooks.list'), { code: 'group_access_denied' })
  assert.equal(hookCalls(app).length, 0)
})

test('deliveries require a current-scope listed webhook and bot ownership or live admin role', async t => {
  const f = fixture(t)
  f.state.webhooks[0].creator_uid = 'carol'
  await assert.rejects(f.run('webhooks.deliveries', { webhook_id: whID }), { code: 'webhook_bot_permission_required' })
  assert.equal(hookCalls(f).length, 1)
  f.state.members[1].role = 2
  const result = await f.run('webhooks.deliveries', { webhook_id: whID, limit: 7 })
  noSecret(result)
  assert.equal(result.deliveries[0].message_id, '9223372036854775807')
  assert.deepEqual(hookCalls(f).at(-1), { path: f.hookPath + '/' + whID + '/deliveries', query: { limit: '7' }, method: 'GET', body: undefined })
  await assert.rejects(f.run('webhooks.deliveries', { webhook_id: 'iwh_' + 'e'.repeat(32) }), { code: 'webhook_outside_channel' })
  const topic = fixture(t, { route: topicRoute })
  await topic.run('webhooks.deliveries', { webhook_id: whID })
  assert.ok(hookCalls(topic).every(call => call.path.startsWith(topic.hookPath)))
})

test('webhook response validation rejects cross-route, duplicate, deleted and unsafe-counter rows', async t => {
  const changes = [s => { s.webhooks[0].group_no = otherGroup },
    s => { s.webhooks[0].thread_short_id = short }, s => { s.webhooks[0].status = 2 },
    s => { s.webhooks[0].webhook_id = whID + '/../test' }, s => { s.webhooks.push(s.webhooks[0]) },
    s => { s.webhooks[0].call_count = Number.MAX_SAFE_INTEGER + 1 },
    s => { s.webhooks[0].created_at = -1 }, s => { s.webhooks[0].allow_mention_all = true },
    s => { s.webhooks[0].name = {} }, s => { s.webhooks = null }]
  for (const change of changes) {
    const f = fixture(t); change(f.state)
    await assert.rejects(f.run('webhooks.list'), { code: 'invalid_webhook_response' })
  }
  const topic = fixture(t, { route: topicRoute }); delete topic.state.webhooks[0].thread_short_id
  await assert.rejects(topic.run('webhooks.list'), { code: 'invalid_webhook_response' })
  topic.state.thread.channel_id = otherGroup + '____' + short
  await assert.rejects(topic.run('webhooks.list'), { code: 'invalid_thread_response' })
  const hidden = fixture(t)
  hidden.state.webhooks.push({ ...webhook(), group_no: otherGroup, webhook_id: 'iwh_' + 'd'.repeat(32) })
  await assert.rejects(hidden.run('webhooks.list', { limit: 1 }), { code: 'invalid_webhook_response' })
})

test('raw HTTP numeric int64 is lossless; zero is valid; malformed diagnostics are rejected or redacted', async t => {
  const f = fixture(t, { respond: call => call.path.endsWith('/deliveries') ? new Response(
    '{"list":[{"status":1,"reason":"","http_status":200,"adapter":"native","byte_size":8,"message_id":9223372036854775807,"created_at":100}]}'
  ) : undefined })
  assert.equal((await f.run('webhooks.deliveries', { webhook_id: whID })).deliveries[0].message_id, '9223372036854775807')
  const zero = fixture(t)
  zero.state.deliveries = [{ ...delivery(), status: 3, message_id: 0, reason: 'event' }]
  assert.equal((await zero.run('webhooks.deliveries', { webhook_id: whID })).deliveries[0].message_id, '0')
  // Official migration retains unknown HTTP outcomes as zero, without claiming 200.
  zero.state.deliveries = [{ ...delivery(), http_status: 0 }]
  assert.equal((await zero.run('webhooks.deliveries', { webhook_id: whID })).deliveries[0].http_status, 0)
  zero.state.deliveries[0].reason = secret
  zero.state.deliveries[0].adapter = 'https://secret.invalid/' + secret
  const redacted = (await zero.run('webhooks.deliveries', { webhook_id: whID })).deliveries[0]
  assert.equal(redacted.reason, 'unknown'); assert.equal(redacted.adapter, 'unknown'); noSecret(redacted)
  for (const patch of [{ message_id: '9223372036854775808' }, { message_id: '01' }, { message_id: '1e18' },
    { message_id: -1 }, { message_id: null }, { status: 4 }, { http_status: -1 }, { http_status: 99 },
    { http_status: 600 }, { http_status: 200.5 }, { byte_size: -1 },
    { created_at: Number.MAX_SAFE_INTEGER + 1 }, { reason: {} }, { adapter: null }]) {
    const f = fixture(t); Object.assign(f.state.deliveries[0], patch)
    await assert.rejects(f.run('webhooks.deliveries', { webhook_id: whID }), { code: 'invalid_delivery_response' })
  }
  const many = fixture(t); many.state.deliveries.push(delivery())
  await assert.rejects(many.run('webhooks.deliveries', { webhook_id: whID, limit: 1 }), { code: 'invalid_delivery_response' })
  for (const list of [null, {}, 'malformed']) {
    const f = fixture(t); f.state.deliveries = list
    await assert.rejects(f.run('webhooks.deliveries', { webhook_id: whID }), { code: 'invalid_delivery_response' })
  }
  // A custom transport that already rounded an int64 must fail closed too.
  const direct = new ChannelApi({ config: { botUid: 'bot', spaceId: 'space' }, request: async path => {
    if (path.endsWith('/deliveries?limit=20')) return { list: [{ ...delivery(), message_id: Number.MAX_SAFE_INTEGER + 1 }] }
    if (path.endsWith('/incoming-webhooks')) return { list: [webhook()] }
    if (path.endsWith('/members')) return [{ uid: 'alice', role: 1, robot: 0 }, { uid: 'bot', role: 0, robot: 1 }]
    if (path.includes('?space_id=')) return [{ group_no: group, space_id: 'space' }]
    return { group_no: group, status: 1 }
  } })
  await assert.rejects(direct.dispatch(groupRoute, 'alice', 'webhooks.deliveries', { webhook_id: whID }), { code: 'invalid_delivery_response' })
})

test('role or membership loss before/after webhook reads prevents diagnostics release', async t => {
  for (const stage of ['list', 'deliveries']) {
    for (const [change, code] of [
      [s => { s.members[0].role = 0 }, 'requester_admin_required'],
      [s => { s.members = s.members.filter(row => row.uid !== 'alice') }, 'requester_not_member'],
      [s => { s.members = s.members.filter(row => row.uid !== 'bot') }, 'bot_not_member'],
      [s => { s.members[1].role = 0 }, 'webhook_bot_permission_required'],
    ]) {
      const f = fixture(t, { respond: call => {
        if (stage === 'list' ? call.path.endsWith('/incoming-webhooks') : call.path.endsWith('/deliveries')) change(call.state)
      } })
      f.state.members[1].role = 2
      f.state.webhooks[0].creator_uid = 'carol'
      await assert.rejects(f.run('webhooks.deliveries', { webhook_id: whID }), { code })
      assert.equal(hookCalls(f).filter(call => call.path.endsWith('/deliveries')).length, stage === 'list' ? 0 : 1)
    }
  }
  const list = fixture(t, { respond: call => {
    if (call.path.endsWith('/incoming-webhooks')) call.state.members[0].role = 0
  } })
  await assert.rejects(list.run('webhooks.list'), { code: 'requester_admin_required' })
})

test('HTTP failures, error envelopes, malformed JSON and abort are sanitized without retries', async t => {
  for (const [status, code] of [[401, 'api_authentication_failed'], [403, 'api_permission_denied'],
    [404, 'api_not_found'], [429, 'api_rate_limited'], [500, 'api_server_error']]) {
    const f = fixture(t, { respond: call => call.path.endsWith('/incoming-webhooks') ? new Response(secret, { status }) : undefined })
    await assert.rejects(f.run('webhooks.list'), error => { assert.equal(error.code, code); noSecret(error.message); return true })
    assert.equal(hookCalls(f).length, 1)
  }
  for (const response of [{ status: 403, msg: secret }, { error: secret }, new Response('{bad ' + secret)]) {
    const f = fixture(t, { respond: call => call.path.endsWith('/user/info') ? response : undefined })
    await assert.rejects(f.run('messages.user_info', { uid: 'bob' }), error => { noSecret(error.message); return true })
    assert.equal(identityCalls(f).length, 1)
  }
  const f = fixture(t)
  const controller = new AbortController(); controller.abort(secret)
  await assert.rejects(f.run('webhooks.list', {}, groupRoute, 'alice', controller.signal), { code: 'aborted' })
  assert.equal(f.calls.length, 0)
})

test('native readonly permission filter mounts conversation identities and group/topic webhook reads', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-admin-read-'))
  const store = new Store(cwd, 'fixture')
  t.after(() => {
    store.close()
    assert.equal(dirname(cwd), tmpdir())
    assert.ok(basename(cwd).startsWith('octo-admin-read-'))
    rmSync(cwd, { recursive: true, force: true })
  })
  const config = { cwd, botUid: 'bot', ownerUid: 'alice', spaceId: 'space', toolScope: 'owner',
    toolPermission: 'read-only', senderPolicy: 'octo', channelPolicy: 'joined', allowed: new Set() }
  const dispatched = [], runs = []
  const api = { async allowsMessage() { return true }, async rules() { return [] }, async send() { return '900' },
    channel: { async members() { return [] }, async dispatch(...args) { dispatched.push(args); return {} } } }
  const worker = new Worker({ config, store, api, log() {}, host: {
    async run(session, text, created, signal, rules, stage, timeout, allowed, extras) {
      await created()
      const tools = extras.channelTools
      const mounted = tools.specs.map(spec => spec.name)
      runs.push(mounted)
      for (const name of names.slice(0, 2)) assert.ok(mounted.includes('octo_' + name.replaceAll('.', '_')))
      assert.ok(!mounted.includes('octo_messages_notify'))
      assert.throws(() => tools.execute('octo_messages_notify', { text: 'no send' }, signal), /unavailable/)
      await tools.execute('octo_messages_user_info', { uid: 'alice' }, signal)
      return 'fixture'
    },
  } })
  for (const [i, route] of [dmRoute, groupRoute, topicRoute].entries()) {
    store.add(String(i + 1), { messageId: String(i + 1), sender: 'alice', channelId: route.channel_id,
      channelType: route.channel_type, messageSeq: i + 1, text: 'inspect' })
    await worker.process(store.next(Date.now()), new AbortController().signal)
  }
  assert.equal(runs.length, 3)
  for (const name of ['octo_webhooks_list', 'octo_webhooks_deliveries']) {
    assert.ok(!runs[0].includes(name)); assert.ok(runs[1].includes(name)); assert.ok(runs[2].includes(name))
  }
  assert.deepEqual(dispatched.map(call => call[0]), [dmRoute, groupRoute, topicRoute])
  assert.ok(dispatched.every(call => call[1] === 'alice' && call[2] === 'messages.user_info'))
})
