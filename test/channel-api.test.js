import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelApi, ChannelApiError, CHANNEL_API_OPERATIONS } from '../src/channel-api.js'
import { sendDisplayCard } from '../src/display-card.js'

const G = '00112233445566778899aabbccddeeff'
const OTHER = 'ffeeddccbbaa99887766554433221100'
const T = '123456789012345678'
const SIBLING = '223456789012345678'
const route = { channel_id: G, channel_type: 2 }
const topic = { channel_id: G + '____' + T, channel_type: 5 }
const dm = { channel_id: 'human', channel_type: 1 }
const root = '/v1/bot/groups/' + G
const signal = new AbortController().signal
const secret = 'bf_TEST_CREDENTIAL_NEVER_RETURN'
const config = { botUid: 'bot', spaceId: 'space', senderPolicy: 'octo', channelPolicy: 'joined', token: secret, ownerUid: 'human' }
const thread = (short_id = T, changes = {}) => ({ group_no: G, short_id, channel_id: G + '____' + short_id,
  channel_type: 5, name: 'Design', creator_uid: 'bot', status: 1, ...changes })
const message = (changes = {}) => ({ message_id: '9223372036854775806', message_seq: 22,
  from_uid: 'bot', ...route, payload: { type: 1, content: 'Original' }, ...changes })

function fixture(configChanges = {}) {
  const calls = [], writes = []
  const state = {
    members: [
      { uid: 'bot', name: 'Assistant', robot: 1, role: 0 },
      { uid: 'human', name: '张三', robot: 0, role: 0 },
      { uid: 'owner', name: 'Owner', robot: 0, role: 1 },
      { uid: 'admin', name: 'Administrator', robot: 0, role: 2 },
    ],
    groups: [{ group_no: G, space_id: 'space', name: 'Current group' }],
    group: { group_no: G, name: 'Current group', notice: 'Welcome', status: 1, token: secret },
    thread: thread(), message: message(), history: [],
    search: { data: [], pagination: { has_more: false, next_cursor: '' } },
    ack: { status: 200 }, send: { message_id: '9223372036854775807' }, ruleAck: { version: 4 }, groupAck: { ok: true },
    spaceMembers: [{ uid: 'invitee', name: 'Invited Person', robot: 0 }],
    principals: { human: 'human', owner: 'human', admin: 'human', invitee: 'human', bot: 'user_bot' },
    addAck: { ok: true, added: 1 }, removeAck: { ok: true, removed: 1 },
    createAck: { group_no: OTHER, name: 'New group' },
    voice: { status: 200, has_context: true, context: 'Octo vocabulary', updated_at: '2026-11-09T00:00:00Z' },
  }
  const request = async (path, bodyString, passedSignal, options) => {
    assert.ok(path.startsWith('/v1/bot/'))
    assert.ok(bodyString === undefined || typeof bodyString === 'string')
    const body = bodyString === undefined ? undefined : JSON.parse(bodyString)
    assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(options?.method))
    const call = { path, body, bodyString, signal: passedSignal, method: options.method }
    calls.push(call)
    if (options.method !== 'GET' && !['/v1/bot/messages/sync', '/v1/bot/messages/_search',
      '/v1/bot/messages/_search_files', '/v1/bot/messages/_search_media', '/v1/bot/messages/_search_all',
      '/v1/bot/messages/_search_around'].includes(path)) writes.push(call)
    if (state.intercept) {
      const result = await state.intercept(call)
      if (result !== undefined) return result
    }
    if (path === '/v1/bot/groups?space_id=space') return structuredClone(state.groups)
    if (path.startsWith('/v1/bot/space/principals/')) {
      const target = decodeURIComponent(path.slice('/v1/bot/space/principals/'.length).split('?')[0])
      assert.equal(path.split('?')[1], 'space_id=space')
      if (!state.principals[target]) throw Object.assign(new Error(secret), { status: 404 })
      return { uid: target, principal_type: state.principals[target] }
    }
    if (path.startsWith('/v1/bot/space/members?')) return structuredClone(state.spaceMembers)
    if (path === '/v1/bot/createGroup') return structuredClone(state.createAck)
    if (path === '/v1/bot/voice/context') return structuredClone(options.method === 'GET' ? state.voice : state.ack)
    if (path === root + '/members') return structuredClone(state.members)
    if (path === root + '/members/add') return structuredClone(state.addAck)
    if (path === root + '/members/remove') return structuredClone(state.removeAck)
    if (path === root) return structuredClone(state.group)
    if (path.endsWith('/md')) return options.method === 'PUT' ? structuredClone(state.ruleAck)
      : { content: '# Rules', version: 3, token: secret, updated_by: 'owner' }
    if (path === root + '/info' && options.method === 'PUT') return structuredClone(state.groupAck)
    if (path.startsWith(root + '/threads?')) return { count: 2, list: [thread(), thread(SIBLING)] }
    if (path === root + '/threads' && body) return thread(SIBLING, { name: body.name })
    if (path === root + '/threads/' + T) return structuredClone(options.method === 'DELETE' ? state.ack : state.thread)
    if (path === root + '/threads/' + SIBLING) return thread(SIBLING)
    if (path.endsWith('/members')) return [{ uid: 'human', name: '张三', role: 0 }]
    if (/\/(join|leave|archive)$/.test(path)) return structuredClone(state.ack)
    if (path === '/v1/bot/messages/sync') return { messages: structuredClone(state.history), more: 0 }
    if (path === '/v1/bot/messages/_search') return structuredClone(state.search)
    if (path === '/v1/bot/messages/_search_files') return structuredClone(state.searchFiles)
    if (path === '/v1/bot/messages/_search_media') return structuredClone(state.searchMedia)
    if (path === '/v1/bot/messages/_search_all') return structuredClone(state.searchAll)
    if (path === '/v1/bot/messages/_search_around') return structuredClone(state.searchAround)
    if (/\/messages\/\d+$/.test(path) || /\/messages\/person\/[^/]+\/\d+$/.test(path)) {
      return structuredClone(state.messages?.[path.split('/').at(-1)] ?? state.message)
    }
    if (['/v1/bot/message/edit', '/v1/bot/readReceipt'].includes(path)) return structuredClone(state.ack)
    if (path === '/v1/bot/card/profile') return structuredClone(state.cardProfile ?? editManifest)
    if (path === '/v1/bot/sendMessage') return structuredClone(state.send)
    throw new Error('unexpected request ' + secret)
  }
  const trustedConfig = { ...config, ...configChanges }
  const api = new ChannelApi({ request, config: trustedConfig })
  const run = (op, args = {}, sender = 'human', current = route) => api.dispatch(current, sender, op, args, signal)
  return { api, state, calls, writes, run, trustedConfig }
}
const denies = (promise, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof ChannelApiError)
  assert.equal(error.code, code)
  assert.ok(error.message === code || error.message.startsWith(code + ': '))
  assert.equal(error.cause, undefined)
  assert.ok(!String(error.stack).includes(secret))
  assert.ok(!JSON.stringify(error).includes(secret))
  return true
})

// Independent wire fixtures from octo-server f984d405 messages_search:
// validate.go, envelope.go, search_{messages,files,media,all,around}.go.
const searchContracts = [
  { op: 'messages.search', path: '/v1/bot/messages/_search', key: 'search', args: { keyword: 'report' } },
  { op: 'messages.search_files', path: '/v1/bot/messages/_search_files', key: 'searchFiles', args: {} },
  { op: 'messages.search_media', path: '/v1/bot/messages/_search_media', key: 'searchMedia', args: {} },
  { op: 'messages.search_all', path: '/v1/bot/messages/_search_all', key: 'searchAll', args: { keyword: 'report' } },
  { op: 'messages.search_around', path: '/v1/bot/messages/_search_around', key: 'searchAround', args: { anchor_message_id: '100' } },
]
const searchHit = (live, channel = route) => ({ message_id: live.message_id, message_seq: live.message_seq,
  sender_id: live.from_uid, sender_name: 'Assistant', sent_at: '2026-11-09T01:02:03Z',
  message_kind: 'text', snippet: secret, ...channel })
const fileHit = live => ({ message_id: live.message_id, message_seq: live.message_seq, sender_id: live.from_uid,
  sender_name: 'Assistant', sent_at: '2026-11-09T01:02:03Z', file_name: secret, file_ext: 'pdf',
  file_size_bytes: 999, download_url: 'https://index.invalid/' + secret, preview_url: null, content_snippet: secret })
function searchFixture(contract, current = route, changes = {}) {
  const f = fixture(changes)
  const payload = contract.key === 'searchFiles' ? { type: 8, name: 'Current report.pdf', url: 'chat/current.pdf', size: 42 }
    : contract.key === 'searchMedia' ? { type: 2, name: 'Current image.png', url: 'chat/current.png', size: 24 }
      : { type: 1, content: 'Current report' }
  f.live = message({ message_id: '100', message_seq: 10, ...current, payload })
  f.state.messages = { '100': f.live }
  f.hit = contract.key === 'searchFiles' ? fileHit(f.live)
    : contract.key === 'searchMedia' ? { message_id: '100', message_seq: 10, sender_id: 'bot', sender_name: 'Assistant',
      sent_at: '2026-11-09T01:02:03Z', media_kind: 'image', thumb_url: 'https://index.invalid/' + secret }
      : searchHit(f.live, current)
  f.state[contract.key] = contract.key === 'searchAround'
    ? { before: [], anchor: f.hit, after: [], has_more_before: false, has_more_after: false }
    : { data: [contract.key === 'searchAll' ? { result_type: 'message', sorted_at: f.hit.sent_at, message: f.hit } : f.hit],
      pagination: { has_more: false, next_cursor: '' } }
  return f
}

test('specs are immutable ordinary JSON schemas with no model-supplied route, URL or requester', () => {
  assert.ok(CHANNEL_API_OPERATIONS.length > 15)
  assert.equal(new Set(CHANNEL_API_OPERATIONS.map(s => s.name)).size, CHANNEL_API_OPERATIONS.length)
  for (const entry of CHANNEL_API_OPERATIONS) {
    assert.equal(entry.parameters.type, 'object')
    assert.equal(entry.parameters.additionalProperties, false)
    assert.ok(Object.isFrozen(entry.parameters))
    assert.ok(!['url', 'host', 'group_no', 'channel_id', 'sender', 'on_behalf_of'].some(k => k in entry.parameters.properties))
    if ('path' in entry.parameters.properties) {
      // The sole path input selects a protected workspace file, never an HTTP
      // endpoint. It is host-mediated and absent without private file access.
      assert.equal(entry.name, 'messages.send_target_file')
      assert.equal(entry.privateOnly, true)
      assert.equal(entry.requiresFiles, true)
      assert.equal(entry.mutating, true)
    }
    assert.equal(entry.available, !entry.unavailableReason)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(CHANNEL_API_OPERATIONS)), CHANNEL_API_OPERATIONS)
})

test('members metadata is an array of authoritative uid/name/robot/role, never owner-derived privileges', async () => {
  const f = fixture()
  f.state.members[0].owner_uid = 'owner'
  f.state.members[0].bot_admin = 1
  f.state.members[1].token = secret
  assert.deepEqual(await f.api.members(topic, signal), [
    { uid: 'bot', name: 'Assistant', robot: 1, role: 0 },
    { uid: 'human', name: '张三', robot: 0, role: 0 },
    { uid: 'owner', name: 'Owner', robot: 0, role: 1 },
    { uid: 'admin', name: 'Administrator', robot: 0, role: 2 },
  ])
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(c => c.signal === signal && c.body === undefined))
  const inspect = await f.run('inspect')
  assert.equal(inspect.requester_group_admin, false)
  assert.equal(inspect.bot_group_admin, false)
  assert.equal(inspect.bot_rules_admin, 'unknown')
  assert.ok(!JSON.stringify(inspect).includes(secret))
})

test('read-only members can inspect group, rules, and list bounded member/thread metadata', async () => {
  const f = fixture()
  assert.deepEqual(await f.run('groups.list'), [{ group_no: G, name: 'Current group', notice: 'Welcome', status: 1 }])
  assert.deepEqual(await f.run('rules.read'), { content: '# Rules', version: 3 })
  const members = await f.run('members', { limit: 2 })
  assert.equal(members.members.length, 2)
  assert.equal(members.total, 4)
  assert.equal(members.truncated, true)
  const threads = await f.run('threads.list', { limit: 2, page: 1 })
  assert.equal(threads.threads.length, 2)
  assert.equal(threads.more, false)
  assert.ok(f.calls.some(c => c.path === root + '/threads?page_index=1&page_size=2'))
  assert.equal(f.writes.length, 0)
})

test('model-selected cross-group/channel/host/method/OBO fields are rejected before any network call', async () => {
  for (const field of ['group_no', 'channel_id', 'channel_type', 'url', 'host', 'path', 'method', 'on_behalf_of', 'sender', 'payload', 'bot_admin']) {
    const f = fixture()
    await denies(f.run('messages.notify', { text: 'Hi', [field]: OTHER }), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
  for (const address of ['https://evil.invalid', '../other', '%2fother', G + '?secret=x', G + '____bad']) {
    const f = fixture()
    await denies(f.run('inspect', {}, 'human', { channel_id: address, channel_type: 2 }), 'invalid_route')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  await denies(f.run('inspect', {}, 'human', { channel_id: OTHER, channel_type: 2 }), 'group_access_denied')
  assert.ok(f.calls.every(c => !c.path.includes(OTHER)))
})

test('allowlists and configured Space remain an independent gate', async () => {
  const f = fixture({ senderPolicy: 'allowlist', allowed: new Set(['owner']), channelPolicy: 'allowlist', groups: new Set([G]), threads: new Set() })
  await denies(f.run('inspect'), 'requester_not_allowed')
  await denies(f.run('inspect', {}, 'owner', topic), 'route_not_allowed')
  f.state.groups[0].space_id = 'other-space'
  await denies(f.run('inspect', {}, 'owner'), 'group_access_denied')
  assert.equal(f.writes.length, 0)
})

test('removed requesters and removed bots lose access on the very next call, including reads', async () => {
  for (const who of ['human', 'bot']) {
    const f = fixture()
    await f.run('inspect')
    f.state.members = f.state.members.filter(m => m.uid !== who)
    await denies(f.run('rules.read'), who === 'human' ? 'requester_not_member' : 'bot_not_member')
    await denies(f.run('messages.notify', { text: 'No send' }), who === 'human' ? 'requester_not_member' : 'bot_not_member')
    assert.equal(f.writes.length, 0)
  }
})

test('explicit deleted/blacklisted membership, bot requesters and malformed roles never authorize', async () => {
  for (const change of [{ is_deleted: 1 }, { status: 2 }, { robot: 1 }]) {
    const f = fixture()
    Object.assign(f.state.members[1], change)
    await denies(f.run('inspect'), 'requester_not_member')
  }
  for (const role of ['2', 'admin', -1, 3, null]) {
    const f = fixture()
    f.state.members[1].role = role
    await denies(f.run('threads.create', { name: 'No create' }), 'invalid_member_response')
    assert.equal(f.writes.length, 0)
  }
})

test('bot ownership and bot_admin never grant a regular requester group-wide mutation privileges', async () => {
  const f = fixture()
  Object.assign(f.state.members[0], { role: 2, bot_admin: 1, owner_uid: 'human' })
  for (const [op, args] of [
    ['threads.create', { name: 'No' }], ['thread.archive', { short_id: T }],
    ['rules.edit', { content: 'No' }], ['group.edit', { name: 'No' }], ['thread.rules.edit', { short_id: T, content: 'No' }],
    ['thread.delete', { short_id: T }],
    ['messages.edit', { message_id: '9223372036854775806', text: 'No' }], ['messages.notify', { text: 'No', all: true }],
  ]) await denies(f.run(op, args), 'requester_admin_required')
  assert.equal(f.writes.length, 0)
})

test('explicit broadcast requires requester admin but sendMessage does not require bot_admin or bot role', async () => {
  for (const humanRole of [1, 2]) {
    for (const botRole of [0, 1, 2]) {
      const f = fixture()
      f.state.members[1].role = humanRole
      f.state.members[0].role = botRole
      const result = await f.run('messages.notify', { text: 'Meeting starts', all: true }, 'human', topic)
      assert.equal(f.writes.length, 1)
      assert.deepEqual(f.writes[0].body, { ...topic,
        payload: { type: 1, content: 'Meeting starts\n@所有人 ', mention: { all: 1, humans: 1 } } })
      assert.equal(result.message_id, '9223372036854775807')
      assert.equal((await f.run('inspect')).broadcast_available, true)
    }
  }
  const f = fixture({ botAdmin: true, bot_admin: 1 }) // bot grants cannot elevate a human requester
  f.state.members[0].owner_uid = 'owner'
  await denies(f.run('messages.notify', { text: 'No', all: true }), 'requester_admin_required')
  const inspection = await f.run('inspect')
  assert.equal(inspection.broadcast_available, false)
  assert.equal(f.writes.length, 0)
  f.state.send = { msg: secret }
  await denies(f.run('messages.notify', { text: 'No fake success', all: true }, 'owner'), 'mutation_unconfirmed')
})

test('targeted notifications mention only current members and send only the fixed route', async () => {
  const f = fixture()
  await f.run('messages.notify', { text: '@张三 hello', uids: ['human'] }, 'owner', topic)
  assert.deepEqual(f.writes[0].body, { ...topic, payload: { type: 1, content: '@张三 hello\n@张三 ',
    mention: { uids: ['human'], entities: [{ uid: 'human', offset: 10, length: 3 }] } } })
  await denies(f.run('messages.notify', { text: 'No', uids: ['stranger'] }), 'mention_not_member')
  await denies(f.run('messages.notify', { text: 'No', all: true, uids: ['human'] }), 'invalid_arguments')
  assert.equal(f.writes.length, 1)
})

test('notify appends verified display names and native UTF-16 entities, including astral names and duplicate labels', async () => {
  const f = fixture()
  f.state.members[1].name = '张😀三'
  f.state.members[2].name = '张😀三'
  const original = '😀 Please review the document'
  const result = await f.run('messages.notify', { text: original, uids: ['human', 'owner'] }, 'human', topic)
  const payload = f.writes[0].body.payload
  assert.equal(payload.content, original + '\n@张😀三 @张😀三 ')
  assert.deepEqual(payload.mention.uids, ['human', 'owner'])
  assert.deepEqual(payload.mention.entities, [
    { uid: 'human', offset: original.length + 1, length: 5 },
    { uid: 'owner', offset: original.length + 7, length: 5 },
  ])
  for (const entity of payload.mention.entities) assert.equal(payload.content.slice(entity.offset, entity.offset + entity.length), '@张😀三')
  assert.equal(result.text, payload.content)
  assert.deepEqual(result.mention, payload.mention)
  assert.equal(payload.mention.all, undefined)
  assert.equal(payload.mention.humans, undefined)
  assert.equal(payload.mention.ais, undefined)
  assert.equal(f.writes[0].body.channel_id, topic.channel_id)
  assert.equal(f.writes[0].body.from_uid, undefined)
})

test('ordinary targeted mentions cannot inject broadcast flags, sentinel UIDs or deceptive display labels', async () => {
  for (const name of ['所有人', '所\u200b有人', '所有人:now', 'All People', 'ａｌｌ', '张@所有人', '张＠所有人']) {
    const f = fixture()
    f.state.members[2].name = name
    await denies(f.run('messages.notify', { text: 'Notice', uids: ['owner'] }), 'unsafe_mention_label')
    assert.equal(f.writes.length, 0)
  }
  for (const uid of ['all', '-1', '-2', '-3']) {
    const f = fixture()
    f.state.members.push({ uid, name: 'A member', role: 0, robot: 0 })
    await denies(f.run('messages.notify', { text: 'Notice', uids: [uid] }), 'invalid_mention_target')
    assert.equal(f.writes.length, 0)
  }
  for (const args of [{ text: 'Notice', humans: true }, { text: 'Notice', entities: [] },
    { text: 'Notice', uids: ['owner'], sender: 'owner' }, { text: 'Notice', uids: ['owner'], name: 'Forged' }]) {
    const f = fixture()
    await denies(f.run('messages.notify', args), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  const result = await f.run('messages.notify', { text: '@所有人 example only' })
  assert.equal(result.mention, undefined) // text alone never creates notification authority
})

test('notifications and edits need concrete positive server acknowledgements', async () => {
  for (const send of [null, {}, { ok: true }, { message_id: 9223372036854775807 }, { message_id: '9223372036854775808' }]) {
    const f = fixture()
    f.state.send = send
    await denies(f.run('messages.notify', { text: 'Hi' }), 'mutation_unconfirmed')
    assert.equal(f.writes.length, 1) // no retry of a possibly accepted mutation
  }
  const f = fixture()
  f.state.ack = { ok: true }
  await denies(f.run('messages.edit', { message_id: '9223372036854775806', text: 'Edit' }, 'owner'), 'mutation_unconfirmed')
})

test('thread create is parent-scoped and bot-owned, without fabricated OBO or copied source messages', async () => {
  const f = fixture()
  const created = await f.run('threads.create', { name: 'New topic' }, 'owner', topic)
  assert.equal(created.group_no, G)
  assert.equal(created.creator_uid, 'bot')
  assert.deepEqual(f.writes[0].body, { name: 'New topic' })
  assert.equal(f.writes[0].path, root + '/threads')
  await denies(f.run('threads.create', { name: 'No', source_message_id: '123' }, 'owner'), 'invalid_arguments')
})

test('thread sessions never address sibling threads; bare IDs from parent sessions stay in the current group', async () => {
  for (const op of ['thread.read', 'thread.members', 'thread.rules.read', 'thread.join', 'thread.leave', 'thread.archive', 'thread.delete']) {
    const f = fixture()
    await denies(f.run(op, { short_id: SIBLING }, 'owner', topic), 'current_thread_only')
    assert.equal(f.calls.length, 0)
    await denies(f.run(op, { short_id: OTHER + '____' + T }, 'owner'), 'invalid_arguments')
  }
  const f = fixture()
  assert.equal((await f.run('thread.read', {}, 'human', topic)).short_id, T)
  assert.equal((await f.run('thread.read', { short_id: SIBLING })).short_id, SIBLING)
  assert.deepEqual(await f.run('thread.rules.read', {}, 'human', topic), { content: '# Rules', version: 3 })
  assert.equal((await f.run('thread.members', {}, 'human', topic)).members[0].name, '张三')
})

test('thread response cannot redirect a read or mutation to another group or child', async () => {
  for (const change of [{ group_no: OTHER }, { short_id: SIBLING }, { channel_id: OTHER + '____' + T }, { channel_type: 2 }, { status: 3 }]) {
    const f = fixture()
    Object.assign(f.state.thread, change)
    await denies(f.run('thread.join', {}, 'human', topic), 'invalid_thread_response')
    assert.equal(f.writes.length, 0)
  }
})

test('join/leave act only as the bot, creator cannot leave, archive checks bot creator/role separately', async () => {
  const f = fixture()
  assert.deepEqual(await f.run('thread.join', {}, 'human', topic), { ok: true, short_id: T, actor_uid: 'bot' })
  assert.deepEqual(f.writes[0].body, {})
  await denies(f.run('thread.leave', {}, 'human', topic), 'thread_creator_cannot_leave')
  f.state.thread.creator_uid = 'owner'
  await f.run('thread.leave', {}, 'human', topic)
  await denies(f.run('thread.archive', {}, 'owner', topic), 'bot_permission_required')
  f.state.members[0].role = 2
  await f.run('thread.archive', {}, 'owner', topic)
  assert.equal(f.writes.at(-1).path, root + '/threads/' + T + '/archive')
})

test('PUT group/thread rules uses server bot_admin authorization independently of bot member.role', async () => {
  const f = fixture()
  // Official /members does not include bot_admin. role=0 must neither deny a
  // legitimate server-granted bot_admin nor grant one from requester authority.
  assert.equal(f.state.members[0].role, 0)
  assert.deepEqual(await f.run('rules.edit', { content: '# New rules' }, 'owner', topic), { ok: true, version: 4 })
  assert.deepEqual(f.writes[0], { path: root + '/md', body: { content: '# New rules' },
    bodyString: '{"content":"# New rules"}', signal, method: 'PUT' })
  await f.run('rules.edit', { content: '' }, 'admin') // group rules support clearing
  assert.equal(f.writes.at(-1).body.content, '')
  await f.run('thread.rules.edit', { content: '# Thread rules' }, 'owner', topic)
  assert.equal(f.writes.at(-1).method, 'PUT')
  assert.equal(f.writes.at(-1).path, root + '/threads/' + T + '/md')
  assert.deepEqual(f.writes.at(-1).body, { content: '# Thread rules' })
  await denies(f.run('thread.rules.edit', { content: '' }, 'owner', topic), 'invalid_arguments')
  await denies(f.run('thread.rules.edit', { content: 'No', short_id: SIBLING }, 'owner', topic), 'current_thread_only')
  await denies(f.run('rules.edit', { content: '中'.repeat(3500) }, 'owner'), 'invalid_arguments')
  assert.equal(f.writes.length, 3)
})

test('PUT group info changes only supplied name/notice, supports clearing notice and validates nonempty patch', async () => {
  const f = fixture()
  assert.deepEqual(await f.run('group.edit', { name: '新名字', notice: 'New notice' }, 'admin', topic), { ok: true, group_no: G })
  assert.equal(f.writes[0].path, root + '/info')
  assert.equal(f.writes[0].method, 'PUT')
  assert.deepEqual(f.writes[0].body, { name: '新名字', notice: 'New notice' })
  await f.run('group.edit', { notice: '' }, 'owner')
  assert.deepEqual(f.writes[1].body, { notice: '' })
  await denies(f.run('group.edit', {}, 'owner'), 'invalid_arguments')
  await denies(f.run('group.edit', { name: '' }, 'owner'), 'invalid_arguments')
  await denies(f.run('group.edit', { name: 'x'.repeat(51) }, 'owner'), 'invalid_arguments')
  assert.equal(f.writes.length, 2)
})

test('server denial of bot_admin is explicit, redacted, and never retried or converted to success', async () => {
  for (const [op, args] of [['rules.edit', { content: '# New' }], ['group.edit', { notice: 'New' }],
    ['thread.rules.edit', { content: '# New' }]]) {
    const f = fixture()
    f.state.members[0].role = 2 // group role cannot substitute for bot_admin
    f.state.intercept = call => {
      if (call.method === 'PUT') throw Object.assign(new Error(secret), { status: 403, body: secret, token: secret })
    }
    await denies(f.run(op, args, 'owner', topic), 'api_permission_denied')
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].method, 'PUT')
  }
})

test('PUT mutations require the actual version/ok response contract', async () => {
  for (const ack of [{}, { version: 0 }, { version: -1 }, { version: '4' }, { ok: true }]) {
    const f = fixture()
    f.state.ruleAck = ack
    await denies(f.run('rules.edit', { content: 'Rules' }, 'owner'), 'mutation_unconfirmed')
  }
  const f = fixture()
  f.state.groupAck = { status: 200 }
  await denies(f.run('group.edit', { notice: 'Changed' }, 'owner'), 'mutation_unconfirmed')
})

test('DELETE thread requires both requester group authority and bot creator/group authority, with server acknowledgement', async () => {
  const f = fixture()
  const result = await f.run('thread.delete', {}, 'owner', topic)
  assert.equal(result.ok, true)
  assert.equal(f.writes[0].method, 'DELETE')
  assert.equal(f.writes[0].path, root + '/threads/' + T)
  assert.equal(f.writes[0].body, undefined)
  f.state.thread.creator_uid = 'human'
  await denies(f.run('thread.delete', {}, 'owner', topic), 'bot_permission_required')
  f.state.members[0].role = 2
  f.state.ack = { ok: true }
  await denies(f.run('thread.delete', {}, 'owner', topic), 'mutation_unconfirmed')
  assert.equal(f.writes.length, 2)
})

test('operations without an official bot-token endpoint fail explicitly and never make network requests', async () => {
  const argumentsByOperation = { 'thread.rename': { name: 'New' },
    'messages.react': { message_id: '1' }, 'messages.pin': { message_id: '1' }, 'messages.delete': { message_id: '1' } }
  const f = fixture()
  for (const entry of CHANNEL_API_OPERATIONS.filter(s => !s.available)) {
    await denies(f.run(entry.name, argumentsByOperation[entry.name], 'owner', topic), entry.unavailableReason)
  }
  assert.equal(f.calls.length, 0)
  await denies(f.run('request', { path: '/v1/user/token' }), 'unknown_operation')
})

test('history uses fixed exclusive sequence pagination and skips foreign, revoked, hidden or malformed content', async () => {
  const f = fixture()
  f.state.history = [message(), message({ message_id: '2', message_seq: 21, channel_id: OTHER }),
    message({ message_id: '3', message_seq: 20, extra: { revoke: 1 } }),
    message({ message_id: '4', message_seq: 19, payload: { type: 1, content: secret, visibles: ['bot'] } }),
    message({ message_id: '5', message_seq: 18, payload: { type: 1, content: 'Wrong Space', space_id: 'elsewhere' } }),
    message({ message_id: '6', message_seq: 17, payload: 'not-json' })]
  const result = await f.run('messages.recent', { limit: 10, before_seq: 23 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].message_id, '9223372036854775806')
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.deepEqual(f.calls.at(-1).body, { ...route, limit: 10, pull_mode: 0, start_message_seq: 22, end_message_seq: 0 })
  f.state.history = [message({ message_seq: 23 })]
  assert.equal((await f.run('messages.recent', { before_seq: 23 })).messages.length, 0)
  assert.deepEqual(await f.run('messages.recent', { before_seq: 1 }), { messages: [], more: false })
})

test('current-thread message reads reject parent/sibling messages and use the official thread path', async () => {
  const f = fixture()
  await denies(f.run('messages.read', { message_id: '9223372036854775806' }, 'human', topic), 'invalid_message_response')
  f.state.message = message({ ...topic, payload: Buffer.from('{"type":1,"content":"Thread text"}').toString('base64') })
  assert.equal((await f.run('messages.read', { message_id: '9223372036854775806' }, 'human', topic)).text, 'Thread text')
  assert.equal(f.calls.at(-1).path, root + '/threads/' + T + '/messages/9223372036854775806')
  f.state.message.channel_id = G + '____' + SIBLING
  await denies(f.run('messages.read', { message_id: '9223372036854775806' }, 'human', topic), 'message_outside_channel')
})

test('message edit checks bot ownership, plain-text type and requester group role; no raw payload or sequence injection', async () => {
  const f = fixture()
  f.state.message.from_uid = 'human'
  await denies(f.run('messages.edit', { message_id: '9223372036854775806', text: 'Changed' }, 'owner'), 'bot_message_required')
  f.state.message = message({ payload: { type: 17, plain: 'Card' } })
  await denies(f.run('messages.edit', { message_id: '9223372036854775806', text: 'Changed' }, 'owner'), 'plain_text_message_required')
  f.state.message = message({ ...topic })
  await f.run('messages.edit', { message_id: '9223372036854775806', text: 'Changed' }, 'owner', topic)
  assert.deepEqual(f.writes[0].body, { ...topic, message_id: '9223372036854775806', content_edit: '{"type":1,"content":"Changed"}' })
  assert.equal(f.writes[0].body.message_seq, undefined)
  await denies(f.run('messages.edit', { message_id: '9223372036854775806', text: 'No', message_seq: 22 }, 'owner'), 'invalid_arguments')
})

test('membership removal or admin demotion during target lookup prevents the subsequent write', async () => {
  for (const change of ['remove', 'demote', 'remove-bot']) {
    const f = fixture()
    f.state.intercept = call => {
      if (call.path.endsWith('/messages/9223372036854775806')) {
        if (change === 'remove') f.state.members = f.state.members.filter(m => m.uid !== 'owner')
        if (change === 'remove-bot') f.state.members = f.state.members.filter(m => m.uid !== 'bot')
        if (change === 'demote') f.state.members.find(m => m.uid === 'owner').role = 0
      }
    }
    await denies(f.run('messages.edit', { message_id: '9223372036854775806', text: 'No' }, 'owner'),
      change === 'remove' ? 'requester_not_member' : change === 'remove-bot' ? 'bot_not_member' : 'mutation_permission_changed')
    assert.equal(f.writes.length, 0)
  }
})

test('search is fixed-route, bounded and reads actual messages before returning content', async () => {
  const f = fixture()
  f.state.search = { data: [{ message_id: '9223372036854775806', message_seq: 22, sender_id: 'bot', sender_name: 'Assistant',
    channel_id: G, snippet: secret }], pagination: { has_more: true, next_cursor: 'cursor-2' } }
  const result = await f.run('messages.search', { keyword: 'Original', limit: 1, cursor: 'cursor-1' })
  assert.equal(result.messages[0].text, 'Original')
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.equal(result.next_cursor, 'cursor-2')
  assert.deepEqual(f.calls.find(c => c.path.endsWith('/_search')).body,
    { ...route, keyword: 'Original', page_size: 1, sort: 'time_desc', cursor: 'cursor-1' })
  assert.equal(f.calls.length, 8) // access + search + read + final access; no cursor loop
  f.state.message.payload = { type: 1, content: secret, visibles: ['bot'] }
  await denies(f.run('messages.search', { keyword: 'secret' }), 'message_unavailable')
  f.state.search.data[0].channel_id = OTHER
  await denies(f.run('messages.search', { keyword: 'secret' }), 'invalid_search_response')
})

test('all reviewed searches use exact POST contracts and pinned group/thread/DM verification routes', async t => {
  for (const contract of searchContracts) for (const current of [route, topic, dm]) {
    await t.test(contract.op + ' type ' + current.channel_type, async () => {
      const f = searchFixture(contract, current)
      const filters = { sender_ids: ['bot'], sent_at_from: '2026-11-09', sent_at_to: '2026-11-09T23:59:59+08:00' }
      const around = contract.key === 'searchAround'
      const args = { ...contract.args, limit: 2, filters, ...(!around && { cursor: 'opaque-page', sort: 'time_asc' }) }
      const result = await f.run(contract.op, args, 'human', current)
      const posts = f.calls.filter(call => call.path === contract.path)
      assert.equal(posts.length, 1)
      assert.equal(posts[0].method, 'POST')
      assert.equal(posts[0].signal, signal)
      assert.deepEqual(posts[0].body, { ...current, page_size: 2, filters, ...contract.args,
        ...(!around && { cursor: 'opaque-page', sort: 'time_asc' }) })
      const expectedRead = current.channel_type === 1 ? '/v1/bot/messages/person/human/100'
        : root + (current.channel_type === 5 ? '/threads/' + T : '') + '/messages/100'
      assert.equal(f.calls.filter(call => call.path === expectedRead).length, around ? 2 : 1)
      const verified = around ? result.anchor : result.messages[0]
      assert.equal(verified.message_id, '100')
      assert.equal(verified.from_uid, 'bot')
      assert.ok(!JSON.stringify(result).includes(secret))
      assert.equal(f.writes.length, 0)
      assert.ok(f.calls.every(call => !/global|resolve|webhook|download|upload/.test(call.path)))
      if (contract.key === 'searchFiles' || contract.key === 'searchMedia') {
        assert.equal(verified.attachments[0].name, f.live.payload.name)
        assert.equal(verified.attachments[0].size, f.live.payload.size)
        assert.ok(!Object.hasOwn(verified.attachments[0], 'url'))
      }
    })
  }
})

test('mixed search consumes tagged message/file hits and returns current edits, not indexed content', async () => {
  const contract = searchContracts[3], f = searchFixture(contract)
  f.live.message_extra = { content_edit: JSON.stringify({ type: 1, content: 'Edited current text' }) }
  const file = message({ message_id: '101', message_seq: 11,
    payload: { type: 8, name: 'Fresh.pdf', size: 123, url: 'chat/fresh.pdf' } })
  const image = message({ message_id: '102', message_seq: 12, payload: { type: 2, url: 'chat/image.png', name: 'Fresh.png' } })
  Object.assign(f.state.messages, { '101': file, '102': image })
  f.state.searchAll = { data: [
    { result_type: 'message', sorted_at: f.hit.sent_at, message: { ...f.hit, inner_messages: [{ snippet: secret }] } },
    { result_type: 'file', sorted_at: f.hit.sent_at, file: { ...fileHit(file), ...route } },
    { result_type: 'message', sorted_at: f.hit.sent_at, message: { ...searchHit(image), message_kind: 'image' } },
  ], pagination: { has_more: true, next_cursor: 'next-page' } }
  const result = await f.run(contract.op, { keyword: 'report', limit: 3, sort: 'relevance' })
  assert.deepEqual(result.messages.map(row => [row.message_id, row.result_type, row.type]),
    [['100', 'message', 1], ['101', 'file', 8], ['102', 'message', 2]])
  assert.equal(result.messages[0].text, 'Edited current text')
  assert.deepEqual(result.messages[1].attachments, [{ kind: 'file', name: 'Fresh.pdf', mime: 'application/pdf', size: 123 }])
  assert.equal(result.messages[2].attachments[0].name, 'Fresh.png')
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('https://'))
  assert.equal(result.more, true)
  assert.equal(result.next_cursor, 'next-page')
  assert.equal(f.calls.filter(call => call.path === contract.path).length, 1)
  assert.equal(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).length, 3)
})

test('around uses its unwrapped per-side envelope, checks the anchor first, and preserves both paging flags', async () => {
  const contract = searchContracts[4], f = searchFixture(contract, topic)
  const records = [98, 99, 101, 102].map(n => message({ message_id: String(n), message_seq: n,
    ...topic, from_uid: 'human', payload: { type: 1, content: 'Verified ' + n } }))
  for (const row of records) f.state.messages[row.message_id] = row
  f.state.searchAround = { before: records.slice(0, 2).map(row => searchHit(row, topic)), anchor: f.hit,
    after: records.slice(2).map(row => searchHit(row, topic)), has_more_before: true, has_more_after: true }
  // The upstream anchor lookup intentionally ignores sender/time filters.
  const result = await f.run(contract.op, { anchor_message_id: '100', limit: 2, filters: { sender_ids: ['human'] } }, 'human', topic)
  assert.deepEqual(result.before.map(row => row.message_id), ['98', '99'])
  assert.deepEqual(result.after.map(row => row.message_id), ['101', '102'])
  assert.equal(result.anchor.from_uid, 'bot')
  assert.equal(result.has_more_before, true)
  assert.equal(result.has_more_after, true)
  assert.ok(!Object.hasOwn(result, 'pagination'))
  const work = f.calls.filter(call => call.path === contract.path || /\/messages\/\d+$/.test(call.path))
  assert.deepEqual(work.map(call => call.path.split('/').at(-1)), ['100', '_search_around', '100', '98', '99', '101', '102'])
  assert.equal(f.writes.length, 0)
})

test('keyword or effective sender/time filters drive search/all; files/media may browse a bounded page', async () => {
  for (const contract of searchContracts.slice(0, 4)) {
    for (const filters of [{ sender_ids: ['former-member'] }, { sent_at_from: '2024-02-29' },
      { sent_at_to: '2026-11-09' }, { sent_at_from: '2026-11-09', sent_at_to: '2026-11-08T16:00:00Z' },
      { sent_at_from: '2026-11-09T23:59:59+08:00', sent_at_to: '2026-11-09' },
      { sent_at_from: '2026-11-09T00:00:00.123456789Z', sent_at_to: '2026-11-09T00:00:00.9Z' }]) {
      const f = searchFixture(contract)
      await f.run(contract.op, { filters })
      const call = f.calls.find(call => call.path === contract.path)
      assert.deepEqual(call.body, { ...route, page_size: 10, sort: 'time_desc', filters })
    }
  }
  for (const contract of [searchContracts[1], searchContracts[2]]) {
    const f = searchFixture(contract)
    await f.run(contract.op)
    assert.deepEqual(f.calls.find(call => call.path === contract.path).body, { ...route, page_size: 10, sort: 'time_desc' })
  }
  for (const contract of [searchContracts[0], searchContracts[3]]) {
    const f = searchFixture(contract)
    await f.run(contract.op, { keyword: '  report  ', sort: 'relevance' })
    assert.equal(f.calls.find(call => call.path === contract.path).body.keyword, 'report')
  }
})

test('search arguments reject route/identity overrides and malformed bounds before any request', async t => {
  const invalidCommon = [
    { channel_id: OTHER }, { channel_type: 5 }, { group_no: OTHER }, { space_id: 'other' },
    { short_id: SIBLING }, { on_behalf_of: 'owner' }, { sender: 'owner' }, { accountId: 'other' },
    { path: '/v1/bot/messages/_search_global_messages' }, { method: 'GET' }, { url: 'https://other.invalid' },
    { page_size: 100 }, { limit: 0 }, { limit: 11 }, { limit: 1.1 }, { limit: '1' }, { limit: NaN },
    { filters: null }, { filters: [] }, { filters: { channel_id: OTHER } }, { filters: { on_behalf_of: 'owner' } },
    { filters: { sender_ids: [] } }, { filters: { sender_ids: ['bot', 'bot'] } },
    { filters: { sender_ids: Array.from({ length: 51 }, (_, i) => 'u' + i) } },
    { filters: { sender_ids: [''] } }, { filters: { sender_ids: ['../owner'] } }, { filters: { sender_ids: 'bot' } },
    { filters: { sent_at_from: '2026-11-10', sent_at_to: '2026-11-09' } },
    { filters: { sent_at_from: '2026-11-09', sent_at_to: '2026-11-08T15:59:59Z' } },
    { filters: { sent_at_from: '2026-11-09T16:00:00Z', sent_at_to: '2026-11-09' } },
    ...['', '2026-02-29', '2026-04-31', '2026-00-01', '2026-11-9', ' 2026-11-09', 'tomorrow',
      '2026-11-09T12:00:00', '2026-11-09T24:00:00Z', '2026-11-09T00:00:60Z',
      '2026-11-09T00:00:00+24:00', '2026-11-09T00:00:00+08:60', '2026-11-09T00:00:00.1234567890Z']
      .map(sent_at_from => ({ filters: { sent_at_from } })),
  ]
  for (const contract of searchContracts) await t.test(contract.op, async () => {
    for (const patch of invalidCommon) {
      const f = searchFixture(contract)
      await denies(f.run(contract.op, { ...contract.args, ...patch }), 'invalid_arguments')
      assert.equal(f.calls.length, 0, JSON.stringify(patch))
    }
  })
})

test('search endpoint-specific schemas reject unsupported keyword/sort/cursor and empty full-text scans', async () => {
  for (const contract of searchContracts) {
    const invalid = contract.key === 'searchAround'
      ? [{ cursor: 'page' }, { sort: 'time_asc' }, { keyword: 'x' }, { anchor_message_id: '0' },
        { anchor_message_id: '9223372036854775808' }, { anchor_message_id: 100 }]
      : [{ sort: 'random' }, { cursor: 'x'.repeat(4097) }, { cursor: 5 }, { keyword: 'x'.repeat(65) },
        ...(contract.key === 'searchMedia' ? [{ keyword: '' }, { keyword: 'photo' }, { sort: 'relevance' }]
          : [{ keyword: '', sort: 'relevance', filters: { sender_ids: ['bot'] } }])]
    for (const patch of invalid) {
      const f = searchFixture(contract)
      await denies(f.run(contract.op, { ...contract.args, ...patch }), 'invalid_arguments')
      assert.equal(f.calls.length, 0)
    }
  }
  for (const op of ['messages.search', 'messages.search_all']) for (const args of [{}, { keyword: '' }, { keyword: '   ' }, { filters: {} }]) {
    const f = fixture()
    await denies(f.run(op, args), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  for (const op of ['messages.search_global_messages', 'messages.search_global_files', 'messages.search_global_groups']) {
    await denies(f.run(op, {}), 'unknown_operation')
  }
  assert.equal(f.calls.length, 0)
})

test('search response envelopes and bounded pages fail closed instead of fabricating empty success', async t => {
  for (const contract of searchContracts.slice(0, 4)) await t.test(contract.op, async () => {
    for (const patch of [undefined, null, {}, { data: [], pagination: null },
      { data: null, pagination: { has_more: false, next_cursor: '' } },
      { data: {}, pagination: { has_more: false, next_cursor: '' } },
      { data: [], pagination: { has_more: 0, next_cursor: '' } },
      { data: [], pagination: { has_more: false } },
      { data: [], pagination: { has_more: true, next_cursor: '' } },
      { data: [], pagination: { has_more: false, next_cursor: 'x'.repeat(4097) } }]) {
      const f = searchFixture(contract)
      f.state[contract.key] = patch
      await denies(f.run(contract.op, contract.args), 'invalid_search_response')
      assert.equal(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).length, 0)
    }
    const f = searchFixture(contract)
    f.state[contract.key].data.push(structuredClone(f.state[contract.key].data[0]))
    await denies(f.run(contract.op, { ...contract.args, limit: 1 }), 'response_limit_exceeded')
    assert.equal(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).length, 0)
  })
})

test('all search hit identities must be precise, unique and route-consistent before per-hit reads', async t => {
  for (const contract of searchContracts) await t.test(contract.op, async () => {
    for (const patch of [{ message_id: 100 }, { message_id: '0' }, { message_id: '9223372036854775808' },
      { message_seq: 0 }, { message_seq: 0x100000000 }, { message_seq: '10' }, { sender_id: '' },
      { sender_id: '../owner' }, { channel_id: OTHER }, { channel_id: topic.channel_id },
      { channel_type: 1 }, { channel_type: null }]) {
      const f = searchFixture(contract)
      Object.assign(f.hit, patch)
      await denies(f.run(contract.op, contract.args), 'invalid_search_response')
    }
    if (contract.key !== 'searchAround') {
      const f = searchFixture(contract)
      f.state[contract.key].data.push(structuredClone(f.state[contract.key].data[0]))
      await denies(f.run(contract.op, contract.args), 'invalid_search_response')
      assert.equal(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).length, 0)
    }
  })
})

test('mixed discriminators and media types must match the actual upstream union contract', async () => {
  for (const bad of [{ result_type: 'other' }, { result_type: 'file' }, { result_type: 'message', message: null },
    { result_type: 'message', message: {}, file: {} }, { result_type: 'file', file: {}, message: null }, null]) {
    const f = searchFixture(searchContracts[3])
    f.state.searchAll.data = [bad]
    await denies(f.run('messages.search_all', { keyword: 'x' }), 'invalid_search_response')
  }
  for (const media_kind of [undefined, 'audio', 'gif', null]) {
    const f = searchFixture(searchContracts[2])
    f.hit.media_kind = media_kind
    await denies(f.run('messages.search_media'), 'invalid_search_response')
  }
  for (const contract of [searchContracts[0], searchContracts[3]]) {
    const f = searchFixture(contract)
    delete f.hit.channel_id
    await denies(f.run(contract.op, contract.args), 'invalid_search_response')
  }
})

test('media supports verified video hits and all supports route-bearing file branches', async () => {
  const video = searchFixture(searchContracts[2])
  video.live.payload = { type: 5, name: 'Clip.mp4', url: 'chat/clip.mp4', mime: 'video/mp4', size: 456 }
  video.hit.media_kind = 'video'
  video.hit.video_url = 'https://index.invalid/' + secret
  const result = await video.run('messages.search_media')
  assert.equal(result.messages[0].result_type, 'video')
  assert.deepEqual(result.messages[0].attachments, [{ kind: 'video', name: 'Clip.mp4', mime: 'video/mp4', size: 456 }])
  assert.ok(!JSON.stringify(result).includes(secret))
  video.live.payload.type = 2
  await denies(video.run('messages.search_media'), 'invalid_search_response')
  const f = searchFixture(searchContracts[3])
  f.live.payload = { type: 8, name: 'Report.pdf', url: 'chat/report.pdf' }
  f.state.searchAll.data = [{ result_type: 'file', sorted_at: f.hit.sent_at, file: { ...fileHit(f.live), ...route } }]
  assert.equal((await f.run('messages.search_all', { keyword: 'report' })).messages[0].result_type, 'file')
  delete f.state.searchAll.data[0].file.channel_id
  await denies(f.run('messages.search_all', { keyword: 'report' }), 'invalid_search_response')
})

test('valid empty pages are explicit successes and default around size is five per side', async () => {
  for (const contract of searchContracts.slice(0, 4)) {
    const f = searchFixture(contract)
    f.state[contract.key] = { data: [], pagination: { has_more: false, next_cursor: '' } }
    assert.deepEqual(await f.run(contract.op, contract.args), { messages: [], more: false, next_cursor: '' })
    assert.equal(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).length, 0)
  }
  const f = searchFixture(searchContracts[4])
  const result = await f.run('messages.search_around', { anchor_message_id: '100' })
  assert.deepEqual(result.before, [])
  assert.deepEqual(result.after, [])
  assert.equal(f.calls.find(call => call.path.endsWith('/_search_around')).body.page_size, 5)
})

test('every hit is re-read for requester visibility, lifecycle, sender and sequence consistency', async t => {
  const mutations = [
    [live => { live.payload.visibles = ['bot'] }, 'message_unavailable'],
    [live => { live.payload.space_id = 'foreign' }, 'message_unavailable'],
    [live => { live.extra = { revoke: 1 } }, 'message_unavailable'],
    [live => { live.message_extra = { is_deleted: true } }, 'message_unavailable'],
    [live => { live.message_extra = { content_edit: JSON.stringify({ type: 1, content: secret, visibles: ['bot'] }) } }, 'invalid_message_response'],
    [live => { live.channel_id = OTHER }, 'message_outside_channel'],
    [live => { live.channel_type = 5 }, 'invalid_message_response'],
    [live => { live.message_id = '999' }, 'message_outside_channel'],
    [live => { live.message_seq = 11 }, 'invalid_search_response'],
    [live => { live.from_uid = 'human' }, 'invalid_search_response'],
    [live => { live.payload.type = { content: secret } }, 'invalid_search_response'],
    [live => { live.payload.type = 99 }, 'invalid_search_response'],
  ]
  for (const contract of searchContracts) await t.test(contract.op, async () => {
    for (const [mutate, code] of mutations) {
      const f = searchFixture(contract)
      mutate(f.live)
      await denies(f.run(contract.op, contract.args), code)
      assert.equal(f.writes.length, 0)
    }
    const f = searchFixture(contract)
    f.live.payload.visibles = ['human']
    await f.run(contract.op, contract.args)
  })
  for (const contract of [searchContracts[1], searchContracts[2], searchContracts[3]]) {
    const f = searchFixture(contract)
    f.live.payload = { type: contract.key === 'searchAll' ? 8 : 1, content: secret }
    await denies(f.run(contract.op, contract.args), 'invalid_search_response')
  }
})

test('a later hidden hit rejects the whole page without returning earlier verified text', async () => {
  for (const contract of searchContracts.slice(0, 4)) {
    const f = searchFixture(contract)
    const second = structuredClone(f.live)
    Object.assign(second, { message_id: '101', message_seq: 11 })
    second.payload.visibles = ['bot']
    f.state.messages['101'] = second
    const row = structuredClone(f.state[contract.key].data[0])
    const inner = contract.key === 'searchAll' ? row.message : row
    Object.assign(inner, { message_id: '101', message_seq: 11 })
    f.state[contract.key].data.push(row)
    await denies(f.run(contract.op, contract.args), 'message_unavailable')
    assert.deepEqual(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).map(call => call.path.split('/').at(-1)), ['100', '101'])
  }
})

test('around refuses hidden anchors before search and changed anchors before reading any neighbors', async () => {
  const contract = searchContracts[4]
  const f = searchFixture(contract)
  f.live.payload.visibles = ['bot']
  await denies(f.run(contract.op, contract.args), 'message_unavailable')
  assert.ok(!f.calls.some(call => call.path === contract.path))
  const g = searchFixture(contract)
  const neighbor = message({ message_id: '99', message_seq: 9 })
  g.state.searchAround.before = [searchHit(neighbor)]
  g.state.messages['99'] = neighbor
  g.state.intercept = call => { if (call.path === contract.path) g.live.payload.visibles = ['bot'] }
  await denies(g.run(contract.op, contract.args), 'message_unavailable')
  assert.ok(!g.calls.some(call => call.path.endsWith('/messages/99')))
})

test('around validates anchor identity, both arrays/flags, cross-wing duplicates and per-side bounds', async () => {
  const contract = searchContracts[4]
  for (const patch of [{ anchor: null }, { anchor: { message_id: '101' } }, { before: null }, { after: {} },
    { has_more_before: 1 }, { has_more_after: undefined }, { data: {} }]) {
    const f = searchFixture(contract)
    if (Object.hasOwn(patch, 'data')) f.state.searchAround = patch
    else Object.assign(f.state.searchAround, patch)
    await denies(f.run(contract.op, contract.args), 'invalid_search_response')
  }
  for (const side of ['before', 'after']) {
    const f = searchFixture(contract)
    f.state.searchAround[side] = [f.hit]
    await denies(f.run(contract.op, contract.args), 'invalid_search_response')
    const g = searchFixture(contract)
    g.state.searchAround[side] = [f.hit, f.hit]
    await denies(g.run(contract.op, { ...contract.args, limit: 1 }), 'response_limit_exceeded')
  }
  const f = searchFixture(contract)
  const neighbor = searchHit(message({ message_id: '99', message_seq: 9 }))
  f.state.searchAround.before = [neighbor]
  f.state.searchAround.after = [structuredClone(neighbor)]
  await denies(f.run(contract.op, contract.args), 'invalid_search_response')
})

test('all search operations retain requester/bot/Space/allowlist admission, including DM and child isolation', async t => {
  for (const contract of searchContracts) await t.test(contract.op, async () => {
    for (const mutate of [f => { f.state.members = f.state.members.filter(row => row.uid !== 'human') },
      f => { f.state.members = f.state.members.filter(row => row.uid !== 'bot') },
      f => { f.state.members[1].robot = 1 }, f => { f.state.members[1].status = 2 },
      f => { f.state.groups[0].space_id = 'foreign' }]) {
      const f = searchFixture(contract)
      mutate(f)
      await assert.rejects(f.run(contract.op, contract.args), ChannelApiError)
      assert.ok(!f.calls.some(call => call.path === contract.path))
    }
    const f = searchFixture(contract, route, { senderPolicy: 'allowlist', allowed: ['owner'] })
    await denies(f.run(contract.op, contract.args), 'requester_not_allowed')
    const g = searchFixture(contract, topic, { channelPolicy: 'allowlist', threads: [G + '____' + SIBLING] })
    await denies(g.run(contract.op, contract.args, 'human', topic), 'route_not_allowed')
    const h = searchFixture(contract, dm)
    await denies(h.run(contract.op, contract.args, 'owner', dm), 'requester_not_allowed')
    h.live.channel_id = 'human@stranger'
    await denies(h.run(contract.op, contract.args, 'human', dm), 'message_outside_channel')
    const k = searchFixture(contract, topic)
    k.live.channel_id = G + '____' + SIBLING
    await denies(k.run(contract.op, contract.args, 'human', topic), 'message_outside_channel')
  })
})

test('membership loss during search or verification prevents even an empty/fully verified result', async () => {
  for (const contract of searchContracts) for (const phase of ['search', 'read']) {
    const f = searchFixture(contract)
    let searching = false
    f.state.intercept = call => {
      if (call.path === contract.path) {
        searching = true
        if (phase === 'search') f.state.members = f.state.members.filter(row => row.uid !== 'human')
      }
      if (phase === 'read' && searching && call.path.endsWith('/messages/100')) {
        f.state.members = f.state.members.filter(row => row.uid !== 'bot')
      }
    }
    await denies(f.run(contract.op, contract.args), phase === 'search' ? 'requester_not_member' : 'bot_not_member')
  }
  const f = searchFixture(searchContracts[0])
  f.state.search.data = []
  f.state.intercept = call => { if (call.path.endsWith('/_search')) f.state.members[1].status = 2 }
  await denies(f.run('messages.search', { keyword: 'x' }), 'requester_not_member')
})

test('search errors keep safe status feedback and explain User Bot/backend requirements without retry', async t => {
  const failures = [[400, 'api_invalid_request'], [401, 'api_authentication_failed'], [403, 'api_permission_denied'],
    [404, 'api_not_found'], [405, 'api_method_not_allowed'], [429, 'api_rate_limited'], [503, 'api_server_error']]
  for (const contract of searchContracts) await t.test(contract.op, async () => {
    for (const [status, code] of failures) for (const thrown of [false, true]) {
      const f = searchFixture(contract)
      f.state.intercept = call => {
        if (call.path !== contract.path) return
        if (thrown) throw Object.assign(new Error(secret), { status, body: secret })
        return { status, error: { message: secret } }
      }
      await denies(f.run(contract.op, contract.args), code)
      await assert.rejects(f.run(contract.op, contract.args), error => /User Bot/.test(error.message) && /server search backend/.test(error.message))
      assert.equal(f.calls.filter(call => call.path === contract.path).length, 2) // two explicit calls, zero retries
      assert.equal(f.writes.length, 0)
    }
    const f = searchFixture(contract)
    f.state.intercept = call => call.path === contract.path ? { error: { code: 'SEARCH_DISABLED', message: secret } } : undefined
    await denies(f.run(contract.op, contract.args), 'api_request_failed')
    assert.equal(f.calls.filter(call => call.path === contract.path).length, 1)
  })
})

test('search aborts stop endpoint/verification work and never leak abort reasons', async () => {
  for (const contract of searchContracts) for (const phase of ['before', 'search', 'read']) {
    const f = searchFixture(contract), controller = new AbortController()
    if (phase === 'before') controller.abort(new Error(secret))
    f.state.intercept = call => {
      if (phase === 'search' && call.path === contract.path || phase === 'read' && call.path.endsWith('/messages/100')) {
        controller.abort(new Error(secret))
      }
    }
    await denies(f.api.dispatch(route, 'human', contract.op, contract.args, controller.signal), 'aborted')
    if (phase === 'before') assert.equal(f.calls.length, 0)
    else assert.equal(f.calls.at(-1).path, phase === 'search' ? contract.path : root + '/messages/100')
  }
})

test('failed per-hit reads and revoked DM access stay errors without partial results or fallback', async () => {
  for (const contract of searchContracts) {
    const f = searchFixture(contract)
    f.state.intercept = call => {
      if (call.path.endsWith('/messages/100')) throw Object.assign(new Error(secret), { status: 403 })
    }
    await denies(f.run(contract.op, contract.args), 'api_permission_denied')
    assert.equal(f.calls.filter(call => call.path.endsWith('/messages/100')).length, 1)
    const g = searchFixture(contract, dm)
    let syncs = 0
    g.state.intercept = call => {
      if (call.path.endsWith('/sync') && ++syncs === 2) throw Object.assign(new Error(secret), { status: 403 })
    }
    await denies(g.run(contract.op, contract.args, 'human', dm), 'api_permission_denied')
    assert.equal(syncs, 2)
    assert.equal(g.writes.length, 0)
  }
})

test('search snapshots nested filters and trusted route before asynchronous access checks', async () => {
  for (const contract of searchContracts) {
    const current = { ...route }, f = searchFixture(contract)
    const args = { ...contract.args, filters: { sender_ids: ['bot'], sent_at_from: '2026-11-09' } }
    f.state.intercept = () => {
      current.channel_id = OTHER
      args.filters.sender_ids[0] = 'stranger'
      args.filters.sent_at_from = '2099-01-01'
      args.channel_id = OTHER
    }
    await f.run(contract.op, args, 'human', current)
    const call = f.calls.find(call => call.path === contract.path)
    assert.equal(call.body.channel_id, G)
    assert.deepEqual(call.body.filters, { sender_ids: ['bot'], sent_at_from: '2026-11-09' })
    assert.ok(!JSON.stringify(f.calls).includes(OTHER))
  }
})

test('maximum around window keeps verified Unicode text and bounded attachment metadata below 64 KiB', async () => {
  const contract = searchContracts[4], f = searchFixture(contract)
  const rows = Array.from({ length: 21 }, (_, i) => message({ message_id: String(i + 90), message_seq: i + 1,
    from_uid: 'u'.repeat(128), payload: { type: 14, content: [
      ...[1, 2, 3].map(n => ({ type: 'file', url: 'chat/' + n + '.pdf', name: '😀'.repeat(100) + '.pdf', mime: 'application/pdf', size: 123 })),
      { type: 'text', text: ('😀"\\\n').repeat(2000) },
    ] } }))
  f.state.messages = Object.fromEntries(rows.map(row => [row.message_id, row]))
  const hits = rows.map(row => ({ ...searchHit(row), sender_name: '😀'.repeat(100) }))
  f.state.searchAround = { before: hits.slice(0, 10), anchor: hits[10], after: hits.slice(11), has_more_before: true, has_more_after: true }
  const result = await f.run(contract.op, { anchor_message_id: '100', limit: 10 })
  const verified = [...result.before, result.anchor, ...result.after]
  assert.equal(verified.length, 21)
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024)
  assert.ok(verified.every(row => row.text.length > 0 && !row.text.includes('\ufffd')))
  assert.ok(verified.every(row => row.attachments.length === 2 && row.attachments_truncated))
  assert.equal(f.calls.filter(call => /\/messages\/\d+$/.test(call.path)).length, 22)
  assert.equal(f.calls.filter(call => call.path === contract.path).length, 1)
})

test('DM access is tied to sender and live friendship; only the exact two-party channel is accepted', async () => {
  const f = fixture()
  const dm = { channel_type: 1, channel_id: 'human' }
  await denies(f.run('inspect', {}, 'owner', dm), 'requester_not_allowed')
  await denies(f.run('rules.read', {}, 'human', dm), 'group_required')
  for (const channel_id of ['human', 'human@bot', 'bot@human']) {
    f.state.message = message({ channel_type: 1, channel_id })
    assert.equal((await f.run('messages.read', { message_id: '9223372036854775806' }, 'human', dm)).text, 'Original')
  }
  f.state.message.channel_id = 'human@stranger'
  await denies(f.run('messages.read', { message_id: '9223372036854775806' }, 'human', dm), 'message_outside_channel')
  f.state.intercept = call => { if (call.path.endsWith('/sync')) throw new Error(secret) }
  await denies(f.run('messages.notify', { text: 'No' }, 'human', dm), 'api_request_failed')
  assert.equal(f.writes.length, 0)
})

test('inactive groups allow reads but no writes; archived threads cannot be joined', async () => {
  const f = fixture()
  f.state.group.status = 2
  await f.run('rules.read')
  await denies(f.run('messages.notify', { text: 'No' }), 'group_not_active')
  f.state.group.status = 1
  f.state.thread.status = 2
  await denies(f.run('thread.join', {}, 'human', topic), 'thread_not_active')
  assert.equal(f.writes.length, 0)
})

test('bounded response and argument limits fail closed without pagination/retry loops', async () => {
  const f = fixture()
  await denies(f.run('members', { limit: 51 }), 'invalid_arguments')
  await denies(f.run('messages.search', { keyword: 'x', limit: 11 }), 'invalid_arguments')
  await denies(f.run('messages.notify', { text: 'x'.repeat(4001) }), 'invalid_arguments')
  assert.equal(f.calls.length, 0)
  f.state.members = Array.from({ length: 1001 }, (_, i) => ({ uid: 'u' + i, name: 'N', robot: 0, role: 0 }))
  await denies(f.api.members(route, signal), 'response_limit_exceeded')
  assert.equal(f.calls.length, 2)
  const g = fixture()
  g.state.history = [message(), message()]
  await denies(g.run('messages.recent', { limit: 1 }), 'response_limit_exceeded')
})

test('worst-case Unicode/escaped history snippets fit the mounted tool 64 KiB result limit', async () => {
  const f = fixture()
  f.state.history = Array.from({ length: 50 }, (_, i) => message({ message_id: String(i + 1), message_seq: i + 1,
    from_uid: 'u'.repeat(128), payload: { type: 1, content: ('😀"\\\n').repeat(2000) } }))
  const result = await f.run('messages.recent', { limit: 50 })
  assert.equal(result.messages.length, 50)
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024)
  assert.ok(result.messages.every(row => row.text.length > 0 && !row.text.includes('\ufffd')))
})

test('HTTP error classes have safe actionable messages without copying the error body', async () => {
  for (const [status, code] of [[400, 'api_invalid_request'], [401, 'api_authentication_failed'], [403, 'api_permission_denied'],
    [404, 'api_not_found'], [405, 'api_method_not_allowed'], [409, 'api_conflict'], [429, 'api_rate_limited'], [503, 'api_server_error']]) {
    const f = fixture()
    f.state.intercept = () => { throw Object.assign(new Error(secret), { status, body: secret }) }
    await assert.rejects(f.run('inspect'), error => {
      assert.equal(error.code, code)
      assert.ok(error.message.startsWith(code + ': '))
      assert.ok(!error.message.includes(secret))
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(f.calls.length, 1)
  }
})

test('raw errors, server bodies, secrets, and abort reasons never escape; no automatic retry', async () => {
  for (const failure of [new Error('Bearer ' + secret), { status: 403, msg: secret }, { error: { message: secret } }]) {
    const f = fixture()
    f.state.intercept = () => { if (failure instanceof Error) throw failure; return failure }
    await denies(f.run('inspect'), failure.status === 403 ? 'api_permission_denied' : 'api_request_failed')
    assert.equal(f.calls.length, 1)
    assert.equal(JSON.stringify(f.api), '{}')
  }
  const f = fixture()
  const controller = new AbortController()
  controller.abort(new Error(secret))
  await denies(f.api.dispatch(route, 'human', 'inspect', {}, controller.signal), 'aborted')
  assert.equal(f.calls.length, 0)
})

test('malformed identities, duplicate membership and unexpected envelopes are not permissions', async () => {
  assert.throws(() => new ChannelApi({ request() {}, config: {} }), /invalid_channel_api_config/)
  const f = fixture()
  f.state.members.push({ ...f.state.members[1], role: 2 })
  await denies(f.run('inspect'), 'invalid_member_response')
  const g = fixture()
  g.state.intercept = call => call.path === root + '/members' ? { members: g.state.members, token: secret } : undefined
  await denies(g.run('inspect'), 'invalid_api_response')
  assert.equal(g.writes.length, 0)
})

test('Space search uses an explicit keyword and configured Space, with live requester eligibility and one bounded page', async () => {
  const f = fixture()
  f.state.spaceMembers[0].token = secret
  const result = await f.run('space.members.search', { keyword: 'Invited & 名', limit: 1, page: 2 })
  assert.deepEqual(result, { members: [{ uid: 'invitee', name: 'Invited Person', robot: 0 }], page: 2, more: true })
  assert.equal(f.calls.at(-1).path, '/v1/bot/space/members?space_id=space&keyword=Invited+%26+%E5%90%8D&limit=1&page=2')
  assert.ok(f.calls.some(c => c.path === '/v1/bot/space/principals/human?space_id=space'))
  assert.equal(f.calls.length, 5)
  assert.equal(f.writes.length, 0)
  assert.deepEqual(await f.run('space.members.search', { keyword: 'Invited' }, 'human', dm),
    { members: [{ uid: 'invitee', name: 'Invited Person', robot: 0 }], page: 1, more: false })
})

test('Space search refuses blank/global overrides, removed requesters, missing Space eligibility and oversized results', async () => {
  for (const args of [{ keyword: ' ' }, { keyword: 'A', space_id: 'elsewhere' }, { keyword: 'A', page: 0 }]) {
    const f = fixture()
    await denies(f.run('space.members.search', args), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
  for (const kind of ['group-removed', 'space-removed', 'bot', 'oversized', 'duplicate']) {
    const f = fixture()
    if (kind === 'group-removed') f.state.members.splice(1, 1)
    if (kind === 'space-removed') delete f.state.principals.human
    if (kind === 'bot') f.state.principals.human = 'user_bot'
    if (['oversized', 'duplicate'].includes(kind)) f.state.spaceMembers.push({ ...f.state.spaceMembers[0] })
    await denies(f.run('space.members.search', { keyword: 'Invited', limit: kind === 'oversized' ? 1 : 2 }),
      { 'group-removed': 'requester_not_member', 'space-removed': 'api_not_found', bot: 'requester_not_allowed',
        oversized: 'response_limit_exceeded', duplicate: 'invalid_member_response' }[kind])
    assert.equal(f.writes.length, 0)
  }
})

test('add/remove members use explicit human UIDs and only the current parent, even from a thread', async () => {
  const f = fixture()
  const added = await f.run('members.add', { uids: ['invitee'] }, 'owner', topic)
  assert.deepEqual(added, { ok: true, group_no: G, added: 1 })
  assert.equal(f.writes[0].path, root + '/members/add')
  assert.equal(f.writes[0].method, 'POST')
  assert.deepEqual(f.writes[0].body, { members: ['invitee'] })
  assert.ok(f.calls.some(c => c.path === '/v1/bot/space/principals/invitee?space_id=space'))
  assert.equal(f.calls.filter(c => c.path === root + '/members').length, 2)
  f.state.removeAck.removed = 3 // server can cascade the person's owned bots
  assert.deepEqual(await f.run('members.remove', { uids: ['human'] }, 'admin', topic),
    { ok: true, group_no: G, removed: 3 })
  assert.equal(f.writes[1].path, root + '/members/remove')
  assert.deepEqual(f.writes[1].body, { members: ['human'] })
})

test('member mutations reject nonadmin requesters, empty/duplicate/injected UIDs and nonhuman/non-Space targets', async () => {
  for (const op of ['members.add', 'members.remove']) {
    const f = fixture()
    await denies(f.run(op, { uids: ['invitee'] }), 'requester_admin_required')
    for (const args of [{ uids: [] }, { uids: ['human', 'human'] }, { uids: ['../other'] },
      { uids: ['human'], group_no: OTHER }, { uids: Array(11).fill('human') }]) {
      await denies(f.run(op, args, 'owner'), 'invalid_arguments')
    }
    assert.equal(f.writes.length, 0)
  }
  for (const [target, code] of [['bot', 'human_member_required'], ['stranger', 'api_not_found']]) {
    const f = fixture()
    await denies(f.run('members.add', { uids: [target] }, 'owner'), code)
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  f.state.intercept = call => call.path.includes('/principals/invitee?')
    ? { uid: 'someone-else', principal_type: 'human' } : undefined
  await denies(f.run('members.add', { uids: ['invitee'] }, 'owner'), 'invalid_principal_response')
  assert.equal(f.writes.length, 0)
})

test('member removal protects the bot, privileged targets and absent members before making a write', async () => {
  for (const [target, code] of [['bot', 'protected_member'], ['owner', 'protected_member'],
    ['admin', 'protected_member'], ['invitee', 'target_not_member']]) {
    const f = fixture()
    await denies(f.run('members.remove', { uids: [target] }, 'owner'), code)
    assert.equal(f.writes.length, 0)
  }
})

test('member changes recheck requester and bot membership after target resolution', async () => {
  for (const change of ['remove-owner', 'remove-bot', 'demote']) {
    const f = fixture()
    f.state.intercept = call => {
      if (!call.path.includes('/principals/invitee?')) return
      if (change === 'demote') f.state.members.find(m => m.uid === 'owner').role = 0
      else f.state.members = f.state.members.filter(m => m.uid !== (change === 'remove-bot' ? 'bot' : 'owner'))
    }
    await denies(f.run('members.add', { uids: ['invitee'] }, 'owner'),
      change === 'demote' ? 'mutation_permission_changed' : change === 'remove-bot' ? 'bot_not_member' : 'requester_not_member')
    assert.equal(f.writes.length, 0)
  }
})

test('member APIs require actual acknowledgements and server bot_admin denial stays safe and actionable', async () => {
  for (const [op, key, ack] of [['members.add', 'addAck', { ok: true, added: 2 }],
    ['members.add', 'addAck', { ok: true, added: 1, skipped_bots: ['stranger'] }],
    ['members.remove', 'removeAck', { status: 200 }]]) {
    const f = fixture()
    f.state[key] = ack
    await denies(f.run(op, { uids: [op === 'members.add' ? 'invitee' : 'human'] }, 'owner'),
      ack.skipped_bots ? 'invalid_member_response' : 'mutation_unconfirmed')
    assert.equal(f.writes.length, 1)
  }
  const f = fixture()
  f.state.members[0].role = 2 // still not proof of bot_admin
  f.state.intercept = call => { if (call.path.endsWith('/members/remove')) throw Object.assign(new Error(secret), { status: 403 }) }
  await denies(f.run('members.remove', { uids: ['human'] }, 'owner'), 'api_permission_denied')
  assert.equal(f.writes.length, 1)
})

test('group creation uses the verified bot owner, fixed Space and revalidated explicit recipients without auto messaging', async () => {
  for (const current of [route, topic, dm]) {
    const f = fixture() // bot owner is a regular member of the current group
    const result = await f.run('groups.create', { name: ' New group ', uids: ['invitee'] }, 'human', current)
    assert.deepEqual(result, { group_no: OTHER, name: 'New group', space_id: 'space' })
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].path, '/v1/bot/createGroup')
    assert.equal(f.writes[0].method, 'POST')
    assert.deepEqual(f.writes[0].body, { name: 'New group', members: ['invitee'], creator: 'human', space_id: 'space' })
    assert.ok(f.calls.some(c => c.path === '/v1/bot/space/principals/human?space_id=space'))
    assert.ok(f.calls.some(c => c.path === '/v1/bot/space/principals/invitee?space_id=space'))
    assert.ok(f.calls.every(c => !c.path.includes(OTHER) && c.path !== '/v1/bot/sendMessage'))
  }
})

test('group creation requires verified owner identity plus current admission, never group admin or supplied creator', async () => {
  const args = { name: 'New', uids: ['invitee'] }
  for (const sender of ['owner', 'admin']) {
    const f = fixture()
    await denies(f.run('groups.create', args, sender), 'requester_owner_required')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture({ ownerUid: undefined })
  await denies(f.run('groups.create', args), 'owner_identity_required')
  f.trustedConfig.ownerUid = 'human' // host completes identity after client construction
  await f.run('groups.create', args)
  assert.equal(f.writes.length, 1)
  for (const key of ['creator', 'ownerUid', 'space_id', 'channel_id', 'name_url']) {
    const g = fixture()
    await denies(g.run('groups.create', { ...args, [key]: 'other' }), 'invalid_arguments')
    assert.equal(g.calls.length, 0)
  }
  const g = fixture()
  g.state.members.splice(1, 1)
  await denies(g.run('groups.create', args), 'requester_not_member')
  assert.equal(g.writes.length, 0)
  const h = fixture({ senderPolicy: 'allowlist', allowed: new Set(['owner']) })
  await denies(h.run('groups.create', args, 'human', dm), 'requester_not_allowed')
  assert.equal(h.calls.length, 0)
})

test('creation rejects cross-Space/nonhuman principals and owner or admission changes before its single POST', async () => {
  const args = { name: 'New', uids: ['invitee'] }
  for (const change of ['space-removed', 'bot', 'owner-changed', 'group-removed', 'dm-revoked']) {
    const f = fixture()
    let syncCount = 0
    if (change === 'space-removed') delete f.state.principals.invitee
    if (change === 'bot') f.state.principals.invitee = 'user_bot'
    f.state.intercept = call => {
      if (call.path.includes('/principals/invitee?')) {
        if (change === 'owner-changed') f.trustedConfig.ownerUid = 'admin'
        if (change === 'group-removed') f.state.members.splice(1, 1)
      }
      if (change === 'dm-revoked' && call.path.endsWith('/sync') && ++syncCount === 2) throw Object.assign(new Error(secret), { status: 403 })
    }
    await denies(f.run('groups.create', args, 'human', change === 'dm-revoked' ? dm : route),
      { 'space-removed': 'api_not_found', bot: 'human_member_required', 'owner-changed': 'requester_owner_required',
        'group-removed': 'requester_not_member', 'dm-revoked': 'api_permission_denied' }[change])
    assert.equal(f.writes.length, 0)
  }
})

test('group creation never invents success or hides skipped members', async () => {
  const args = { name: 'New', uids: ['invitee'] }
  for (const ack of [{}, { group_no: G, name: 'Same' }, { group_no: 'https://evil.invalid', name: 'No' },
    { group_no: OTHER, name: '' }]) {
    const f = fixture()
    f.state.createAck = ack
    await denies(f.run('groups.create', args), 'mutation_unconfirmed')
    assert.equal(f.writes.length, 1)
  }
  const f = fixture()
  f.state.createAck = { group_no: OTHER, name: 'New', skipped_members: ['invitee'], token: secret }
  assert.deepEqual(await f.run('groups.create', args),
    { group_no: OTHER, name: 'New', space_id: 'space', skipped_members: ['invitee'] })
  f.state.createAck.skipped_members = ['unrequested']
  await denies(f.run('groups.create', args), 'invalid_member_response')
})

test('target resolution never uses cross-group resolver and confines a thread session to its own thread', async () => {
  const f = fixture()
  assert.equal((await f.run('targets.resolve', { name: 'Design' }, 'human', topic)).candidates.length, 1)
  assert.ok(f.calls.every(c => !c.path.includes(SIBLING) && !c.path.includes('/resolve/')))
  assert.equal((await f.run('targets.resolve', { name: 'Current' }, 'human', topic)).candidates[0].group_no, G)
  await denies(f.run('targets.resolve', { name: 'Design', page: 2 }, 'human', topic), 'invalid_arguments')
  f.state.thread = thread(T, { group_no: OTHER })
  await denies(f.run('targets.resolve', { name: 'Design' }, 'human', topic), 'invalid_thread_response')
  const g = fixture()
  const result = await g.run('targets.resolve', { name: 'Design', limit: 2 })
  assert.deepEqual(result.candidates.map(c => c.short_id), [T, SIBLING])
  assert.equal(g.calls.filter(c => c.path.includes('/threads?')).length, 1)
})

test('voice context is exclusively verified owner DM, with exact official methods and explicit server-selected scope', async () => {
  const f = fixture()
  const read = await f.run('voice.context.read', {}, 'human', dm)
  assert.deepEqual(read, { scope: 'bot_owner_primary_space', has_context: true, context: 'Octo vocabulary', updated_at: f.state.voice.updated_at })
  assert.deepEqual(await f.run('voice.context.update', { context: ' New vocabulary ' }, 'human', dm),
    { ok: true, scope: 'bot_owner_primary_space' })
  assert.deepEqual(await f.run('voice.context.delete', {}, 'human', dm), { ok: true, scope: 'bot_owner_primary_space' })
  assert.deepEqual(f.writes.map(c => [c.path, c.method, c.body]), [
    ['/v1/bot/voice/context', 'PUT', { context: 'New vocabulary' }],
    ['/v1/bot/voice/context', 'DELETE', undefined],
  ])
  assert.ok(f.calls.some(c => c.path === '/v1/bot/space/principals/human?space_id=space'))
})

test('voice context cannot leak through groups, other users, spoofed owner/Space or stale owner identity', async () => {
  for (const op of ['voice.context.read', 'voice.context.update', 'voice.context.delete']) {
    const args = op === 'voice.context.update' ? { context: 'New' } : {}
    for (const [sender, current] of [['human', route], ['human', topic], ['owner', { channel_type: 1, channel_id: 'owner' }], ['owner', dm]]) {
      const f = fixture()
      await denies(f.run(op, args, sender, current), 'owner_dm_required')
      assert.equal(f.calls.length, 0)
    }
    const f = fixture({ ownerUid: undefined })
    await denies(f.run(op, args, 'human', dm), 'owner_identity_required')
    assert.equal(f.calls.length, 0)
    for (const key of ['owner_uid', 'space_id', 'subject_id']) {
      await denies(f.run(op, { ...args, [key]: 'someone-else' }, 'human', dm), 'invalid_arguments')
    }
  }
  const f = fixture()
  f.state.intercept = call => { if (call.path.includes('/principals/')) f.trustedConfig.ownerUid = 'admin' }
  await denies(f.run('voice.context.update', { context: 'No' }, 'human', dm), 'owner_dm_required')
  assert.equal(f.writes.length, 0)
})

test('voice context requires bounded content, valid response and acknowledgement without exposing errors', async () => {
  const f = fixture()
  for (const context of ['', '  ', 'x'.repeat(10001)]) {
    await denies(f.run('voice.context.update', { context }, 'human', dm), 'invalid_arguments')
  }
  assert.equal(f.calls.length, 0)
  f.state.voice.context = 'x'.repeat(10001)
  await denies(f.run('voice.context.read', {}, 'human', dm), 'invalid_voice_response')
  f.state.ack = { ok: true }
  await denies(f.run('voice.context.delete', {}, 'human', dm), 'mutation_unconfirmed')
  f.state.intercept = call => { if (call.path === '/v1/bot/voice/context') throw Object.assign(new Error(secret), { status: 403, body: secret }) }
  await denies(f.run('voice.context.read', {}, 'human', dm), 'api_permission_denied')
})

test('voice writes recheck current owner DM admission after principal resolution', async () => {
  const f = fixture()
  let syncCount = 0
  f.state.intercept = call => {
    if (call.path.endsWith('/sync') && ++syncCount === 2) throw Object.assign(new Error(secret), { status: 403 })
  }
  await denies(f.run('voice.context.update', { context: 'No' }, 'human', dm), 'api_permission_denied')
  assert.equal(f.writes.length, 0)
})

test('read receipts validate each message in the exact current channel and acknowledge only the bot', async () => {
  for (const current of [route, topic, dm]) {
    const f = fixture()
    f.state.message = message(current)
    const message_ids = ['9223372036854775806']
    assert.deepEqual(await f.run('messages.mark_read', { message_ids }, 'human', current),
      { ok: true, actor_uid: 'bot', message_ids })
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].path, '/v1/bot/readReceipt')
    assert.deepEqual(f.writes[0].body, { ...current, message_ids })
  }
})

test('read receipts reject foreign messages, removed requesters and absent acknowledgements', async () => {
  const args = { message_ids: ['9223372036854775806'] }
  for (const change of ['sibling', 'hidden', 'removed', 'ack']) {
    const f = fixture()
    f.state.message = message(topic)
    if (change === 'sibling') f.state.message.channel_id = G + '____' + SIBLING
    if (change === 'hidden') f.state.message.payload.visibles = ['bot']
    if (change === 'removed') f.state.intercept = call => { if (call.path.endsWith('/messages/9223372036854775806')) f.state.members.splice(1, 1) }
    if (change === 'ack') f.state.ack = {}
    await denies(f.run('messages.mark_read', args, 'human', topic),
      { sibling: 'message_outside_channel', hidden: 'message_unavailable', removed: 'requester_not_member', ack: 'mutation_unconfirmed' }[change])
    assert.equal(f.writes.length, change === 'ack' ? 1 : 0)
  }
})


// Independent edit-wire fixtures pinned to octo-server
// f984d40549f66d56b1e90a048d28315eb12c92df modules/bot_api/send.go
// (botMessageEdit, ResponseOK), pkg/richtext/plain.go, pkg/cardmsg/provenance.go;
// openclaw-channel-octo 3cdb7e794ba40ae617fb0215177d1493dd26460a
// src/api-fetch.ts editCardMessage/sendRichTextMessage and src/types.ts.
const editManifest = { enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
  elements: ['TextBlock', 'RichTextBlock', 'FactSet', 'ColumnSet', 'Table', 'Container', 'ActionSet'],
  actions: ['Action.OpenUrl', 'Action.ToggleVisibility', 'Action.CopyToClipboard'] }
const originalDisplay = () => ({ type: 17, profile: 'octo/v1', card_version: '1.5', render_profile: 'octo-chat/v1',
  card: { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Original display', wrap: true }] }, plain: 'Original display' })
const originalRichtext = () => ({ type: 14, content: [{ type: 'text', text: 'Original richtext' }], plain: 'Original richtext' })
const editContracts = [
  { op: 'messages.edit_display_card', payload: originalDisplay, format: 'display_card',
    args: { title: 'Updated', blocks: [{ type: 'facts', items: [{ label: 'State', value: 'Ready' }] }] } },
  { op: 'messages.edit_richtext', payload: originalRichtext, format: 'richtext', args: { blocks: [
    { type: 'text', text: 'Updated introduction' },
    { type: 'image', url: 'https://example.com/image.png', width: 640, height: 480, size: 1024, name: 'Example.png' },
    { type: 'text', text: 'Closing text' },
  ] } },
]
function editFixture(contract, current = route) {
  const f = fixture()
  f.state.message = message({ ...current, payload: contract.payload() })
  f.editArgs = { message_id: f.state.message.message_id, ...structuredClone(contract.args) }
  f.edit = (sender = current.channel_type === 1 ? 'human' : 'owner') => f.run(contract.op, f.editArgs, sender, current)
  return f
}

test('structured edit exports are closed, mutating schemas; display schema keeps root-relative refs', () => {
  for (const contract of editContracts) {
    const def = CHANNEL_API_OPERATIONS.find(item => item.name === contract.op)
    assert.equal(def.available, true)
    assert.equal(def.mutating, true)
    assert.deepEqual(def.parameters.required, ['message_id', 'blocks'])
    assert.equal(def.parameters.additionalProperties, false)
  }
  const display = CHANNEL_API_OPERATIONS.find(item => item.name === 'messages.edit_display_card').parameters
  assert.equal(display.properties.blocks.items.$ref, '#/$defs/block')
  assert.equal(display.$defs.block.oneOf.length, 10)
  assert.ok(Object.isFrozen(display.$defs.block.oneOf))
})

test('edits use exact official POST/JSON replacement and current DM/group/thread routes, never send or registry', async () => {
  for (const contract of editContracts) for (const current of [dm, route, topic]) {
    const f = editFixture(contract, current)
    // Official DM physical peer ordering is not a caller-selected destination.
    if (current === dm) f.state.message.channel_id = 'bot@human'
    const receipt = await f.edit()
    assert.deepEqual(receipt, { ok: true, message_id: f.editArgs.message_id, format: contract.format,
      ...(contract.format === 'display_card' && { fallbackBlocks: [], requiresFinalSummary: true }) })
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 512)
    assert.equal(f.writes.length, 1)
    const write = f.writes[0]
    assert.equal(write.path, '/v1/bot/message/edit')
    assert.equal(write.method, 'POST')
    const content = JSON.parse(write.body.content_edit)
    assert.deepEqual(Object.keys(write.body).sort(), ['channel_id', 'channel_type', 'content_edit', 'message_id'])
    assert.deepEqual({ ...write.body, content_edit: undefined }, { ...current, message_id: f.editArgs.message_id, content_edit: undefined })
    if (contract.format === 'richtext') assert.deepEqual(content, { type: 14, content: contract.args.blocks })
    else {
      assert.equal(content.type, 17)
      assert.equal(content.profile, 'octo/v1')
      assert.equal(content.card.body[1].type, 'FactSet')
      assert.equal(content.template_ref, undefined)
    }
    const expectedRead = current === dm ? '/v1/bot/messages/person/human/' + f.editArgs.message_id
      : root + (current === topic ? '/threads/' + T : '') + '/messages/' + f.editArgs.message_id
    assert.equal(f.calls.filter(call => call.path === expectedRead).length, 2)
    assert.equal(f.calls.at(-2).path, current === dm ? '/v1/bot/messages/sync' : root)
    assert.ok(f.calls.every(call => call.signal instanceof AbortSignal))
    assert.equal(f.calls.filter(call => call.path === '/v1/bot/card/profile').length, contract.format === 'display_card' ? 1 : 0)
  }
})

test('edit display negotiation matches send construction and refuses unavailable or impossible profiles', async () => {
  const contract = editContracts[0]
  for (const limits of [undefined, { max_nodes: 1 }]) {
    const f = editFixture(contract)
    f.state.cardProfile = { ...editManifest, elements: ['TextBlock'], actions: [], ...(limits && { limits }) }
    let sent
    await sendDisplayCard({ route, args: contract.args, api: {
      cardProfile: async () => f.state.cardProfile,
      progressCard: async (_route, frame) => { sent = { type: 17, ...frame }; return '100' },
    } })
    const receipt = await f.edit()
    assert.deepEqual(JSON.parse(f.writes[0].body.content_edit), sent)
    assert.ok(receipt.fallbackBlocks.includes('facts'))
  }
  for (const change of [{ enabled: false }, { config: { card_enabled: true, display_enabled: false } },
    { profiles: ['octo/v2'] }, { card_version: '2.0' }, { elements: [] }, { limits: { max_payload_bytes: 1 } }]) {
    const f = editFixture(contract)
    f.state.cardProfile = { ...editManifest, ...change }
    await denies(f.edit(), change.limits ? 'display_card_limits_exceeded' : 'display_card_unavailable')
    assert.equal(f.writes.length, 0)
  }
})

test('new edits refuse foreign IDs/routes, hidden/revoked sources, non-bot authors and non-admin requesters', async () => {
  const cases = [
    [live => { live.message_id = '99' }, 'message_outside_channel'],
    [live => { live.channel_id = OTHER }, 'message_outside_channel'],
    [live => { live.channel_type = 1 }, 'invalid_message_response'],
    [live => { live.from_uid = 'human' }, 'bot_message_required'],
    [live => { live.message_seq = 0 }, 'invalid_message_response'],
    [live => { live.payload.visibles = ['bot'] }, 'message_unavailable'],
    [live => { live.payload.space_id = 'foreign' }, 'message_unavailable'],
    [live => { live.payload.event = {} }, 'message_unavailable'],
    [live => { live.message_extra = { revoke: 1 } }, 'message_unavailable'],
    [live => { live.extra = { is_deleted: true } }, 'message_unavailable'],
    [live => { live.revoked = '1' }, 'message_unavailable'],
  ]
  for (const contract of editContracts) {
    for (const [change, code] of cases) {
      const f = editFixture(contract)
      change(f.state.message)
      await denies(f.edit(), code)
      assert.equal(f.writes.length, 0)
    }
    const f = editFixture(contract)
    await denies(f.edit('human'), 'requester_admin_required')
    assert.equal(f.writes.length, 0)
    for (const channel_id of [G, G + '____' + SIBLING, OTHER + '____' + T]) {
      const f = editFixture(contract, topic)
      f.state.message.channel_id = channel_id
      await denies(f.edit(), 'message_outside_channel')
      assert.equal(f.writes.length, 0)
    }
    const deniedDM = editFixture(contract, dm)
    await denies(deniedDM.edit('owner'), 'requester_not_allowed')
    assert.equal(deniedDM.writes.length, 0)
  }
})

test('structured edits recheck requester/bot/Space/group status after source lookups and card probing', async () => {
  for (const contract of editContracts) for (const [change, code] of [
    [state => { state.members = state.members.filter(row => row.uid !== 'owner') }, 'requester_not_member'],
    [state => { state.members = state.members.filter(row => row.uid !== 'bot') }, 'bot_not_member'],
    [state => { state.members.find(row => row.uid === 'owner').role = 0 }, 'mutation_permission_changed'],
    [state => { state.groups[0].space_id = 'other' }, 'group_access_denied'],
    [state => { state.group.status = 2 }, 'group_not_active'],
  ]) {
    const f = editFixture(contract)
    f.state.intercept = call => {
      if (call.path.endsWith('/messages/' + f.editArgs.message_id)) change(f.state)
    }
    await denies(f.edit(), code)
    assert.equal(f.writes.length, 0)
  }
  const f = editFixture(editContracts[0])
  f.state.intercept = call => {
    if (call.path === '/v1/bot/card/profile') f.state.members.find(row => row.uid === 'owner').role = 0
  }
  await denies(f.edit(), 'mutation_permission_changed')
  assert.equal(f.writes.length, 0)
  for (const contract of editContracts) {
    const f = editFixture(contract, dm)
    let checks = 0
    f.state.intercept = call => {
      if (call.path === '/v1/bot/messages/sync' && ++checks === 2) throw Object.assign(new Error(secret), { status: 403 })
    }
    await denies(f.edit(), 'api_permission_denied')
    assert.equal(f.writes.length, 0)
  }
})

test('live source is re-read: revocation, ownership, visibility and workflow changes during preparation deny writes', async () => {
  for (const contract of editContracts) for (const [change, code] of [
    [live => { live.message_extra = { revoke: 1 } }, 'message_unavailable'],
    [live => { live.from_uid = 'other' }, 'bot_message_required'],
    [live => { live.payload.visibles = ['other'] }, 'message_unavailable'],
    [live => { live.message_extra = { content_edit: JSON.stringify({ type: 17, profile: 'octo/v2', card: {} }) } },
      contract.format === 'display_card' ? 'display_card_message_required' : 'richtext_message_required'],
  ]) {
    const f = editFixture(contract)
    let reads = 0
    f.state.intercept = call => {
      if (call.path.endsWith('/messages/' + f.editArgs.message_id) && ++reads === 2) change(f.state.message)
    }
    await denies(f.edit(), code)
    assert.equal(f.writes.length, 0)
  }
})

test('original and effective card frames must both be unmanaged v1 displays, even after prior edits', async () => {
  const denied = [
    card => { card.profile = 'octo/v2' }, card => { card.profile = 'octo/v3' },
    card => { card.template_ref = { id: 'ai.reasoning-process', version: '0.4.1' } },
    card => { card.catalog_provenance = { producer: 'registry' } },
    card => { card.card.metadata = { octo: { template: { id: 'question' } } } },
    card => { card.transient = false }, card => { card.card_seq = 4 },
    card => { card.card.body[0].text = 'DSH 回复进度' },
    card => { card.card.body[0].text = 'DSH 等待你的回答（1/2）' },
    card => { card.card.body[0].text = 'DSH 提问回执' },
    card => { card.card.actions = [{ type: 'Action.Submit', data: { key: 'callback' } }] },
    card => { card.card.body.push({ type: 'Container', items: [{ type: 'Input.Text', id: 'answer' }] }) },
    card => { card.card.body[0].selectAction = { type: 'Action.Execute', data: {} } },
    card => { card.card.body.push({ type: 'ActionSet', actions: [{ type: 'Action.Submit', title: 'Send' }] }) },
  ]
  for (const mutate of denied) for (const where of ['original', 'effective']) {
    const f = editFixture(editContracts[0])
    const blocked = originalDisplay(); mutate(blocked)
    f.state.message.payload = where === 'original' ? blocked : originalDisplay()
    f.state.message.message_extra = { content_edit: JSON.stringify(where === 'effective' ? blocked : originalDisplay()) }
    await denies(f.edit(), 'display_card_message_required')
    assert.equal(f.writes.length, 0)
  }
  for (const contract of editContracts) {
    const f = editFixture(contract)
    f.state.message.payload = Buffer.from(JSON.stringify(contract.payload())).toString('base64')
    f.state.message.message_extra = { content_edit: JSON.stringify(contract.payload()) }
    await f.edit()
    assert.equal(f.writes.length, 1)
  }
})

test('typed edits never cross types, including originals disguised by edited text or richtext', async () => {
  for (const contract of editContracts) for (const type of [1, 8, 14, 17]) {
    if (type === contract.payload().type) continue
    const f = editFixture(contract)
    f.state.message.payload = { type, content: 'Wrong original' }
    f.state.message.message_extra = { content_edit: JSON.stringify(contract.payload()) }
    await denies(f.edit(), contract.format === 'display_card' ? 'display_card_message_required' : 'richtext_message_required')
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  f.state.message.payload = originalDisplay()
  f.state.message.message_extra = { content_edit: '{"type":1,"content":"Disguised"}' }
  await denies(f.run('messages.edit', { message_id: f.state.message.message_id, text: 'No' }, 'owner'), 'plain_text_message_required')
  assert.equal(f.writes.length, 0)
})

test('structured edits reject injected control fields and oversized/unsafe arguments before any requests', async () => {
  for (const contract of editContracts) {
    for (const key of ['channel_id', 'channel_type', 'target', 'space_id', 'token', 'path', 'url', 'method', 'sender',
      'on_behalf_of', 'payload', 'card', 'content_edit', 'plain', 'template_ref', 'card_seq', 'message_seq', 'transient', 'actions']) {
      const f = editFixture(contract)
      f.editArgs[key] = secret
      await denies(f.edit(), 'invalid_arguments')
      assert.equal(f.calls.length, 0)
    }
    for (const value of ['0', '9223372036854775808', '1/other', 100, null]) {
      const f = editFixture(contract)
      f.editArgs.message_id = value
      await denies(f.edit(), 'invalid_arguments')
      assert.equal(f.calls.length, 0)
    }
  }
  const f = editFixture(editContracts[1])
  for (const blocks of [[], new Array(1), [{ type: 'text', text: '' }], [{ type: 'text', text: '中'.repeat(1334) }],
    Array.from({ length: 3 }, () => ({ type: 'text', text: 'x'.repeat(3000) })),
    [{ type: 'text', text: 'x', mention: { all: 1 } }], [{ type: 'image', url: 'https://example.com/a', width: 0, height: 2 }],
    [{ type: 'image', url: 'https://example.com/a', width: 1, height: 2, size: 20971521 }],
    [{ type: 'Action.Submit', text: 'Run' }]]) {
    f.editArgs.blocks = blocks
    await denies(f.edit(), 'invalid_richtext')
  }
  for (const url of ['http://example.com/a', 'https://127.0.0.1/a', 'https://example.com/?token=hidden', 'file:///private']) {
    f.editArgs.blocks = [{ type: 'image', url, width: 1, height: 1 }]
    await denies(f.edit(), 'display_card_unsafe_link')
  }
  f.editArgs.blocks = [{ type: 'text', text: secret }]
  await denies(f.edit(), 'display_card_sensitive_content')
  assert.equal(f.calls.length, 0)
  const display = editFixture(editContracts[0])
  display.editArgs.blocks = [{ type: 'text', text: 'Hi', selectAction: { type: 'Action.Submit' } }]
  await denies(display.edit(), 'invalid_display_card')
  assert.equal(display.calls.length, 0)
})

test('structured edit snapshots nested input and current route before awaits, without invoking top-level accessors', async () => {
  for (const contract of editContracts) {
    const current = { ...route }, f = editFixture(contract, current)
    f.state.intercept = () => {
      current.channel_id = OTHER
      f.editArgs.message_id = '99'
      f.editArgs.blocks[0].type = 'Action.Submit'
    }
    await f.edit()
    assert.equal(f.writes[0].body.channel_id, G)
    assert.equal(f.writes[0].body.message_id, '9223372036854775806')
    assert.ok(!f.writes[0].body.content_edit.includes('Action.Submit'))
    const rejected = editFixture(contract)
    Object.defineProperty(rejected.editArgs, 'message_id', { get() { throw new Error(secret) } })
    await denies(rejected.edit(), 'invalid_arguments')
    assert.equal(rejected.calls.length, 0)
  }
})

test('edit acknowledgements are explicit; unknown outcomes never retry, fallback-send or expose response content', async () => {
  for (const contract of editContracts) {
    for (const ack of [undefined, null, {}, { ok: true }, { status: 0 }, { status: '200' },
      { status: 500, body: secret }, { status: 200, error: secret }, { status: 200, ok: false }]) {
      const f = editFixture(contract)
      f.state.ack = ack
      await denies(f.edit(), 'mutation_unconfirmed')
      assert.equal(f.writes.length, 1)
    }
    for (const [status, code] of [[403, 'api_permission_denied'], [409, 'api_conflict'], [429, 'api_rate_limited'],
      [500, 'mutation_unconfirmed'], [undefined, 'mutation_unconfirmed']]) {
      const f = editFixture(contract)
      f.state.intercept = call => { if (call.path === '/v1/bot/message/edit') throw Object.assign(new Error(secret), { status }) }
      await denies(f.edit(), code)
      assert.equal(f.writes.length, 1)
    }
    const f = editFixture(contract)
    f.state.ack = { status: 200, content: secret, token: secret, raw: { text: 'x'.repeat(100000) } }
    assert.ok(JSON.stringify(await f.edit()).length < 512)
  }
})

test('abort before edit is a no-write; abort after dispatch is an unknown write, never retried', async () => {
  for (const contract of editContracts) for (const phase of ['before', 'lookup', 'write']) {
    const f = editFixture(contract), controller = new AbortController()
    if (phase === 'before') controller.abort(new Error(secret))
    f.state.intercept = call => {
      if (phase === 'lookup' && call.path.endsWith('/messages/' + f.editArgs.message_id)
        || phase === 'write' && call.path === '/v1/bot/message/edit') controller.abort(new Error(secret))
    }
    await denies(f.api.dispatch(route, 'owner', contract.op, f.editArgs, controller.signal), phase === 'write' ? 'mutation_unconfirmed' : 'aborted')
    assert.equal(f.writes.length, phase === 'write' ? 1 : 0)
  }
})


test('official GET content_edit objects are honored for typed edits and reads, alongside legacy strings', async () => {
  for (const contract of editContracts) for (const asString of [false, true]) {
    const f = editFixture(contract)
    const effective = contract.payload()
    if (effective.type === 14) effective.content[0].text = 'Latest object richtext'
    else { effective.card.body[0].text = 'Latest object card'; effective.plain = 'Latest object card' }
    f.state.message.message_extra = { content_edit: asString ? JSON.stringify(effective) : effective }
    const read = await f.run('messages.read', { message_id: f.editArgs.message_id })
    assert.match(read.text, /Latest object/)
    await f.edit()
    assert.equal(f.writes.length, 1)
  }
  const f = fixture()
  f.state.message.message_extra = { content_edit: { type: 1, content: 'Latest plain text' } }
  await f.run('messages.edit', { message_id: f.state.message.message_id, text: 'Next plain text' }, 'owner')
  assert.deepEqual(JSON.parse(f.writes[0].body.content_edit), { type: 1, content: 'Next plain text' })
})

test('official object-shaped current edits cannot hide v2, Registry, deleted, malformed or oversized sources', async () => {
  for (const [extra, code] of [
    [{ content_edit: { ...originalDisplay(), profile: 'octo/v2' } }, 'display_card_message_required'],
    [{ content_edit: { ...originalDisplay(), template_ref: { id: 'form', version: '1' } } }, 'display_card_message_required'],
    [{ content_edit: { ...originalDisplay(), catalog_provenance: {} } }, 'display_card_message_required'],
    [{ content_edit: { ...originalDisplay(), visibles: ['bot'] } }, 'invalid_message_response'],
    [{ content_edit: { ...originalDisplay(), space_id: 'other' } }, 'message_unavailable'],
    [{ content_edit: { ...originalDisplay(), plain: 'x'.repeat(120001) } }, 'invalid_message_response'],
    [{ content_edit: [] }, 'invalid_message_response'], [{ content_edit: 0 }, 'invalid_message_response'],
    [{ is_mutual_deleted: 1 }, 'message_unavailable'],
  ]) {
    const f = editFixture(editContracts[0])
    f.state.message.message_extra = extra
    await denies(f.edit(), code)
    assert.equal(f.writes.length, 0)
  }
  const f = editFixture(editContracts[0])
  f.state.message.extra = { content_edit: originalDisplay() }
  f.state.message.message_extra = { content_edit: { ...originalDisplay(), profile: 'octo/v2' } }
  await denies(f.edit(), 'invalid_message_response')
  assert.equal(f.writes.length, 0)
})

test('new typed edits retain sender/channel allowlists and pinned Space before reads or writes', async () => {
  for (const contract of editContracts) for (const [settings, current, code] of [
    [{ senderPolicy: 'allowlist', allowed: ['human'] }, route, 'requester_not_allowed'],
    [{ channelPolicy: 'allowlist', groups: [], threads: [] }, route, 'route_not_allowed'],
    [{ channelPolicy: 'allowlist', groups: [G], threads: [] }, topic, 'route_not_allowed'],
  ]) {
    const f = fixture(settings)
    await denies(f.run(contract.op, { message_id: '100', ...contract.args }, 'owner', current), code)
    assert.equal(f.calls.length, 0)
  }
})
