import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OctoClient, OctoError } from '../src/octo.js'
import { apiErrorCode } from '../src/api-errors.js'

const group = 'a'.repeat(32), other = 'b'.repeat(32), foreign = 'c'.repeat(32)
const root = '/v1/bot/groups/' + group
const empty = { routes: [], nextPage: null }
const topic = (n, parent = group) => {
  const short_id = String(100000000000000000n + BigInt(n))
  return { group_no: parent, short_id, channel_id: parent + '____' + short_id,
    channel_type: 5, status: 1, name: 'never return this name', last_message_content: 'never return history' }
}
const route = row => ({ channel_type: row.channel_type, channel_id: row.channel_id })
const main = { channel_type: 2, channel_id: group }
const historyRow = (seq, timestamp, overrides = {}) => ({ ...main, message_id: String(seq), message_seq: seq,
  from_uid: 'human', timestamp, payload: { type: 1, content: 'body ' + seq, mention: { uids: ['bot'] } }, ...overrides })

function fixture(overrides = {}) {
  const f = { calls: [], historyRequests: [], replies: {}, topics: [topic(1), topic(2)], history: [] }
  f.config = { apiBase: 'https://directory.invalid', token: 'bf_fixture', botUid: 'bot', spaceId: 'space:fixed',
    transport: 'websocket', mentionPolicy: 'octo', channelPolicy: 'joined', senderPolicy: 'octo',
    allowed: new Set(['human']), groups: new Set(), threads: new Set(), ...overrides }
  f.client = new OctoClient({ ...f.config, fetchImpl: async (url, options) => {
    const u = new URL(url), path = u.pathname, query = u.searchParams
    assert.ok(path.startsWith('/v1/bot/'), 'directory work must use Bot endpoints only')
    assert.equal(options.headers.Authorization, 'Bearer ' + f.config.token)
    assert.equal(options.redirect, 'manual')
    assert.equal(options.method, path === '/v1/bot/messages/sync' ? 'POST' : 'GET')
    assert.ok(options.signal instanceof AbortSignal)
    f.calls.push(path + u.search)
    let key, value
    if (path === '/v1/bot/groups') {
      key = 'groups'; assert.equal(query.get('space_id'), f.config.spaceId)
      value = [{ group_no: group, space_id: f.config.spaceId }]
    } else if (path === root) { key = 'info'; value = { group_no: group, status: 1 } }
    else if (path === root + '/mention_pref') {
      key = 'pref'; value = { effective: true, no_mention: 1, group_allow_no_mention: 1 }
    } else if (path === root + '/threads') {
      key = 'threads'
      const page = Number(query.get('page_index')), size = Number(query.get('page_size'))
      assert.ok(Number.isSafeInteger(page) && page > 0)
      assert.ok(size === 1 || size === 100)
      value = { count: f.topics.length, list: f.topics.slice((page - 1) * size, page * size) }
    } else if (path.startsWith(root + '/threads/')) {
      key = 'detail'; value = f.topics.find(row => row.short_id === path.split('/').at(-1)) ?? null
    } else if (path === root + '/members') {
      key = 'members'; value = [{ uid: 'bot', robot: 1 }, { uid: 'human', robot: 0 }]
    } else if (path === '/v1/bot/messages/sync') {
      key = 'history'
      const body = JSON.parse(options.body); f.historyRequests.push(body)
      const rows = f.history.filter(row => body.pull_mode === 0
        ? (!body.start_message_seq || row.message_seq <= body.start_message_seq) && row.message_seq > body.end_message_seq
        : row.message_seq >= body.start_message_seq && (!body.end_message_seq || row.message_seq < body.end_message_seq))
      value = { messages: body.pull_mode === 0 ? rows.slice(-body.limit) : rows.slice(0, body.limit) }
    }
    else assert.fail('unexpected endpoint: ' + path)
    if (Object.hasOwn(f.replies, key)) value = typeof f.replies[key] === 'function' ? f.replies[key](query) : f.replies[key]
    return value instanceof Response ? value : Response.json(value)
  } })
  f.groups = () => f.client.inboxDirectoryGroups(f.config)
  f.page = (page = 1) => f.client.inboxDirectoryPage(f.config, group, page)
  f.access = (target = main) => f.client.inboxDirectoryAccess(f.config, target)
  return f
}

const invalid = promise => assert.rejects(promise, error => error instanceof OctoError && error.code === 'invalid_directory_response')

test('group candidates are sorted unique IDs, filtered by exact main or topic-parent allowlists', async () => {
  const f = fixture({ channelPolicy: 'allowlist', groups: new Set([other]), threads: new Set([topic(1).channel_id]) })
  f.replies.groups = [other, group, foreign, group].map(group_no => ({ group_no, space_id: f.config.spaceId, name: 'omit me' }))
  assert.deepEqual(await f.groups(), [group, other])
  assert.deepEqual(f.calls, ['/v1/bot/groups?space_id=space%3Afixed'])
  f.config.channelPolicy = 'joined'
  assert.deepEqual(await f.groups(), [group, other, foreign])
})

for (const changes of [{ botKind: 'app' }, { token: 'app_fixture' }, { transport: 'events' }, { transport: 'http' },
  { mentionPolicy: 'required' }, { spaceId: null }, { botUid: '' }]) {
  test('ineligible discovery makes zero requests: ' + JSON.stringify(changes), async () => {
    const f = fixture(changes)
    assert.deepEqual(await f.groups(), [])
    assert.deepEqual(await f.page(), empty)
    assert.deepEqual(f.calls, [])
  })
}

test('null/empty groups are absent; malformed or foreign rows fail even outside the allowlist', async () => {
  const f = fixture({ channelPolicy: 'allowlist', groups: new Set([group]) })
  for (const data of [null, []]) {
    f.replies.groups = data
    assert.deepEqual(await f.groups(), [])
    assert.deepEqual(await f.page(), empty)
  }
  for (const data of [{ groups: [] }, {}, [null], [{ group_no: 'not-32-hex', space_id: f.config.spaceId }],
    [{ group_no: group }], [{ group_no: foreign, space_id: 'another-space' }],
    [{ group_no: group, space_id: f.config.spaceId }, { group_no: other, space_id: null }]]) {
    f.replies.groups = data
    await invalid(f.groups())
  }
})

test('discovery pages return only routes; full, partial, exact EOF and empty directory are consistent', async () => {
  const f = fixture()
  f.topics = Array.from({ length: 101 }, (_, n) => topic(n))
  assert.deepEqual(await f.page(), { routes: [main, ...f.topics.slice(0, 100).map(route)], nextPage: 2 })
  assert.deepEqual(await f.page(2), { routes: [route(f.topics[100])], nextPage: null })
  assert.deepEqual(await f.page(3), empty)
  f.topics = f.topics.slice(0, 100)
  assert.deepEqual(await f.page(), { routes: [main, ...f.topics.map(route)], nextPage: null })
  f.topics = []
  assert.deepEqual(await f.page(), { routes: [main], nextPage: null })
  assert.ok(f.calls.includes(root + '/threads?page_index=1&page_size=100'))
})

test('main-only still proves active parent membership; topic-only never returns its parent or siblings', async () => {
  const f = fixture({ channelPolicy: 'allowlist', groups: new Set([group]) })
  assert.deepEqual(await f.page(), { routes: [main], nextPage: null })
  assert.ok(f.calls.includes(root + '/threads?page_index=1&page_size=100'))
  f.config.groups.clear(); f.config.threads.add(topic(2).channel_id)
  assert.deepEqual(await f.page(), { routes: [route(topic(2))], nextPage: null })
  f.config.threads.clear(); f.calls.length = 0
  assert.deepEqual(await f.page(), empty)
  assert.deepEqual(f.calls, [])
})

test('absent, inactive and preference-off groups never yield routes', async () => {
  for (const [key, value] of [['groups', []], ['info', null], ['info', { group_no: group, status: 0 }],
    ['info', { group_no: group, status: 2 }], ['pref', { effective: false }],
    ['pref', { effective: 0 }], ['pref', { effective: true, group_allow_no_mention: 0 }]]) {
    const f = fixture(); f.replies[key] = value
    assert.deepEqual(await f.page(), empty)
    assert.ok(!f.calls.some(path => path.includes('/threads?')))
  }
})

test('group and effective preference DTOs reject missing, foreign or coercible authority', async () => {
  for (const [key, value] of [['info', {}], ['info', { group_no: other, status: 1 }],
    ['info', { group_no: group, status: '1' }], ['pref', null], ['pref', {}], ['pref', { no_mention: '1' }],
    ['pref', { effective: 'true' }], ['pref', { effective: true, group_allow_no_mention: '1' }]]) {
    const f = fixture(); f.replies[key] = value
    await invalid(f.page())
  }
})

test('legacy no_mention fallback keeps strict flags, effective precedence and group veto', async () => {
  for (const pref of [{ no_mention: 1 }, { no_mention: true }, { effective: null, no_mention: 1 }]) {
    const f = fixture(); f.replies.pref = pref
    assert.deepEqual((await f.page()).routes, [main, ...f.topics.map(route)])
  }
  for (const pref of [{ no_mention: 0 }, { no_mention: false }, { effective: false, no_mention: 1 },
    { effective: 0, no_mention: 1 }, { no_mention: 1, group_allow_no_mention: 0 },
    { no_mention: true, group_allow_no_mention: false }]) {
    const f = fixture(); f.replies.pref = pref
    assert.deepEqual(await f.page(), empty)
  }
})

test('raw group count is bounded before deduplication, including the access recheck', async () => {
  const f = fixture()
  f.replies.groups = Array.from({ length: 1000 }, () => ({ group_no: group, space_id: f.config.spaceId }))
  assert.deepEqual(await f.groups(), [group])
  f.replies.groups.push({ group_no: group, space_id: f.config.spaceId })
  await invalid(f.groups())
  await invalid(f.page())
  await invalid(f.access())
})

test('all topic rows must have exact active parent, short ID, channel ID/type and no duplicates', async () => {
  for (const row of [null, {}, { ...topic(1), status: 2 }, { ...topic(1), status: '1' },
    { ...topic(1), group_no: other }, topic(1, other), { ...topic(1), channel_type: 2 },
    { ...topic(1), short_id: '1' }, { ...topic(1), short_id: topic(2).short_id },
    { ...topic(1), channel_id: group + '____1' }]) {
    const f = fixture({ channelPolicy: 'allowlist', groups: new Set([group]) })
    f.replies.threads = { count: 1, list: [row] }
    await invalid(f.page())
  }
  const f = fixture(); f.replies.threads = { count: 2, list: [topic(1), topic(1)] }
  await invalid(f.page())
})

test('reject truncated, oversized, impossible or unbounded pages instead of silently ending', async () => {
  for (const data of [null, [], {}, { count: '1', list: [topic(1)] }, { count: -1, list: [] },
    { count: 1.5, list: [] }, { count: 0, list: null }, { count: 1, list: [] },
    { count: 101, list: [topic(1)] }, { count: 0, list: [topic(1)] },
    { count: 101, list: Array.from({ length: 101 }, (_, n) => topic(n)) },
    { count: Number.MAX_SAFE_INTEGER, list: [] }, { count: 1_000_001, list: [] }]) {
    const f = fixture(); f.replies.threads = data
    await invalid(f.page())
  }
  const f = fixture(); f.replies.threads = { count: 101, list: [] }
  await invalid(f.page(2))
})

test('invalid page/group input cannot issue requests; maximum page has a finite EOF', async () => {
  const f = fixture()
  for (const page of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER, 10_001]) {
    await assert.rejects(f.page(page), { code: 'invalid_directory_scope' })
  }
  await assert.rejects(f.client.inboxDirectoryPage(f.config, '../group', 1), { code: 'invalid_directory_scope' })
  assert.deepEqual(f.calls, [])
  f.replies.threads = { count: 1_000_000, list: Array.from({ length: 100 }, (_, n) => topic(n)) }
  assert.equal((await f.page(10_000)).nextPage, null)
})

for (const key of ['groups', 'info', 'pref', 'threads']) {
  for (const semantic of [403, 404]) test('denial remains a failed cycle at ' + key + ': ' + semantic, async () => {
    for (const status of [semantic, 400]) {
      const f = fixture()
      f.replies[key] = Response.json({ status, error: {
        code: 'err.server.bot_api.' + (semantic === 403 ? 'not_group_member' : 'group_not_found'), http_status: semantic,
      } }, { status })
      await assert.rejects(f.page(), error => error instanceof OctoError && error.status === status
        && apiErrorCode(error) === (semantic === 403 ? 'api_permission_denied' : 'api_not_found'))
    }
  })
}

test('directory access proves active membership without consulting no-@ preference', async () => {
  const f = fixture({ mentionPolicy: 'required' }); f.topics = []
  f.replies.pref = () => assert.fail('access cannot be gated by no-@')
  assert.equal(await f.access(), true)
  assert.deepEqual(f.calls, ['/v1/bot/groups?space_id=space%3Afixed', root, root + '/threads?page_index=1&page_size=1'])
  f.config.mentionPolicy = 'octo'; f.topics = [topic(1)]
  assert.equal(await f.access(route(topic(1))), true)
  assert.equal(f.calls.at(-1), root + '/threads/' + topic(1).short_id)
})

test('access respects exact local routes and rejects App Bot, invalid routes and foreign current Space', async () => {
  const f = fixture({ channelPolicy: 'allowlist', threads: new Set([topic(1).channel_id]) })
  for (const target of [main, route(topic(2)), { channel_type: 1, channel_id: 'human' },
    { channel_type: 2, channel_id: 'short-group' }, { channel_type: 5, channel_id: group + '____1' }]) {
    assert.equal(await f.access(target), false)
  }
  assert.deepEqual(f.calls, [])
  assert.equal(await f.access(route(topic(1))), true)
  f.replies.groups = [{ group_no: group, space_id: 'foreign' }]
  await invalid(f.access(route(topic(1))))
  const app = fixture({ token: 'app_fixture' })
  assert.equal(await app.access(), false); assert.deepEqual(app.calls, [])
})

test('topic access requires an exact active detail and always visits the strict parent gate first', async () => {
  for (const detail of [null, { ...topic(1), status: 2 }, { ...topic(1), status: 3 }]) {
    const f = fixture(); f.replies.detail = detail
    assert.equal(await f.access(route(topic(1))), false)
    assert.ok(f.calls.indexOf(root + '/threads?page_index=1&page_size=1') < f.calls.indexOf(root + '/threads/' + topic(1).short_id))
  }
  for (const detail of [topic(2), topic(1, other), { ...topic(1), channel_type: 2 }, {}]) {
    const f = fixture(); f.replies.detail = detail
    await invalid(f.access(route(topic(1))))
  }
})

test('pure directory history checks access and preference before sync; membership denial holds it', async () => {
  const f = fixture(), target = { ...main, directory_at: 1, directory_all: 1, since_ms: 1 }
  await f.client.inboxPage(f.config, target, 0, 2)
  assert.equal(f.calls.at(-1), '/v1/bot/messages/sync')
  assert.ok(f.calls.includes(root + '/threads?page_index=1&page_size=1'))
  assert.ok(f.calls.some(path => path.includes('/mention_pref')))
  f.calls.length = 0; f.replies.groups = []
  await assert.rejects(f.client.inboxPage(f.config, target, 0, 2), { code: 'directory_access_denied' })
  assert.ok(!f.calls.includes('/v1/bot/messages/sync'))
  f.calls.length = 0; delete f.replies.groups
  f.replies.threads = Response.json({}, { status: 403 })
  await assert.rejects(f.client.inboxPage(f.config, target, 0, 2), { status: 403 })
  assert.ok(!f.calls.includes('/v1/bot/messages/sync'))
})

test('ambient authorization checks access before pref/roster; preference off only blocks ambient', async () => {
  const f = fixture(), job = { sender: 'human', ...main, ambient: true }
  assert.equal(await f.client.allowsMessage(f.config, job), true)
  assert.ok(f.calls.indexOf(root + '/threads?page_index=1&page_size=1') < f.calls.indexOf(root + '/mention_pref'))
  f.calls.length = 0; f.replies.pref = { effective: false, no_mention: 0 }
  assert.equal(await f.client.allowsMessage(f.config, job), false)
  assert.ok(!f.calls.includes(root + '/members'))
  assert.equal(await f.access(), true)
  assert.equal(await f.client.allowsMessage(f.config, { ...job, ambient: false }), true)
  f.calls.length = 0; f.replies.threads = Response.json({}, { status: 403 })
  await assert.rejects(f.client.allowsMessage(f.config, job), { status: 403 })
  assert.ok(!f.calls.includes(root + '/mention_pref') && !f.calls.includes(root + '/members'))
})

test('prefix activation filters old prefix input while preserving the accepted higher sequence range', async () => {
  const f = fixture(), seconds = Math.floor(Date.now() / 1000) - 60
  f.history = [10, 11].map(seq => ({ ...main, message_id: String(seq), message_seq: seq, from_uid: 'human',
    timestamp: seconds, payload: { type: 1, content: 'older timestamp at ' + seq } }))
  const target = { ...main, directory_at: 1,
    since_ms: (seconds - 10) * 1000, prefix_until_seq: 10, prefix_since_ms: (seconds + 10) * 1000 }
  const result = await f.client.inboxPage(f.config, target, 1, 11)
  assert.deepEqual(result.suppressed, ['10'])
  assert.deepEqual(result.messages, [])
  assert.equal(result.last, 10)
  assert.deepEqual(result.observed, ['10'])
  assert.equal(f.historyRequests[0].end_message_seq, 11)
  const upper = await f.client.inboxPage(f.config, target, 11, 11)
  assert.deepEqual(upper.messages.map(m => m.messageId), ['11'])
  assert.equal(upper.messages[0].directoryRecovery, undefined)
})

test('prefix cannot weaken original since; legacy routes still make only their history request', async () => {
  const f = fixture(), seconds = Math.floor(Date.now() / 1000) - 60
  f.history = [10, 11].map(seq => ({ ...main, message_id: String(seq), message_seq: seq, from_uid: 'human',
    timestamp: seconds, payload: { type: 1, content: 'old' } }))
  const target = { ...main, since_ms: (seconds + 10) * 1000,
    prefix_until_seq: 10, prefix_since_ms: (seconds - 10) * 1000 }
  const result = await f.client.inboxPage(f.config, target, 1, 11)
  const upper = await f.client.inboxPage(f.config, target, 11, 11)
  assert.deepEqual([...result.suppressed, ...upper.suppressed], ['10', '11'])
  assert.deepEqual([...result.messages, ...upper.messages], [])
  f.calls.length = 0
  await f.client.inboxPage(f.config, { ...main, since_ms: target.since_ms }, 1, 11)
  assert.deepEqual(f.calls, ['/v1/bot/messages/sync'])
})

test('pure directory recovery requires current preference before both tip and body reads', async () => {
  const seconds = Math.floor(Date.now() / 1000) - 60
  for (const through of [undefined, 2]) {
    const f = fixture()
    f.history = [historyRow(2, seconds + 1)]
    f.replies.pref = { effective: false, no_mention: 0 }
    await assert.rejects(f.client.inboxPage(f.config, { ...main, directory_all: 1, directory_at: seconds * 1000,
      since_ms: seconds * 1000 }, 0, through), { code: 'directory_preference_denied' })
    assert.ok(f.calls.includes(root + '/threads?page_index=1&page_size=1'))
    assert.ok(f.calls.includes(root + '/mention_pref'))
    assert.deepEqual(f.historyRequests, [])
  }
})

test('disabled prefix returns an explicit skip boundary; latest and accepted upper input continue', async () => {
  const f = fixture({ mentionPolicy: 'required' }), seconds = Math.floor(Date.now() / 1000) - 60
  const target = { ...main, directory_at: 1, directory_all: 0, since_ms: 0,
    prefix_since_ms: seconds * 1000, prefix_until_seq: 10 }
  f.history = [historyRow(10, seconds + 1), historyRow(11, seconds - 100)]
  assert.deepEqual(await f.client.inboxPage(f.config, target, 0, 11), {
    last: 0, count: 0, messages: [], observed: [], suppressed: [], skippedThrough: 10,
  })
  assert.deepEqual(f.historyRequests, [])
  const tip = await f.client.inboxPage(f.config, target, 0, undefined)
  assert.equal(tip.last, 11); assert.deepEqual(tip.messages, [])
  const upper = await f.client.inboxPage(f.config, target, 11, 11)
  assert.deepEqual(upper.messages.map(m => m.messageId), ['11'])
  assert.equal(upper.messages[0].directoryRecovery, undefined)
  assert.ok(!f.calls.includes(root + '/mention_pref'))
  f.config.mentionPolicy = 'octo'; f.replies.pref = { no_mention: 0 }
  assert.equal((await f.client.inboxPage(f.config, target, 1, 11)).skippedThrough, 10)
  assert.equal(f.historyRequests.length, 2, 'only latest/upper requests occur while preference is off')
  assert.deepEqual((await f.client.inboxPage(f.config, target, 11, 11)).messages.map(m => m.messageId), ['11'])
})

test('empty split prefix cannot masquerade as EOF and skip accepted upper history', async () => {
  const f = fixture(), seconds = Math.floor(Date.now() / 1000) - 60
  f.history = [historyRow(11, seconds - 10)]
  const target = { ...main, directory_at: 1, since_ms: 0, prefix_since_ms: seconds * 1000, prefix_until_seq: 10 }
  const prefix = await f.client.inboxPage(f.config, target, 1, 11)
  assert.deepEqual(prefix, { last: 0, count: 0, messages: [], observed: [], suppressed: [], scannedThrough: 10 })
  assert.deepEqual(f.historyRequests.map(r => [r.start_message_seq, r.end_message_seq]), [[1, 11]])
  const result = await f.client.inboxPage(f.config, target, prefix.scannedThrough + 1, 11)
  assert.deepEqual(f.historyRequests.map(r => [r.start_message_seq, r.end_message_seq]), [[1, 11], [11, 12]])
  assert.deepEqual(result.messages.map(m => m.messageId), ['11'])
  assert.equal(result.messages[0].directoryRecovery, undefined)
  assert.equal(result.last, 11)
})

test('pure and prefix messages carry snake-case provenance only in newly authorized ranges', async () => {
  const seconds = Math.floor(Date.now() / 1000) - 60, bounds = {
    since_ms: seconds * 1000, prefix_since_ms: 0, prefix_until_seq: 0,
  }
  const f = fixture()
  f.history = [historyRow(1, seconds + 1), historyRow(2, seconds + 2,
    { payload: { type: 1, content: 'ambient' } })]
  const pure = await f.client.inboxPage(f.config, { ...main, directory_all: 1, directory_at: 1, ...bounds }, 1, 2)
  assert.deepEqual(pure.messages.map(m => m.directoryRecovery), [bounds, bounds])
  assert.deepEqual(pure.messages.map(m => m.ambient), [false, true])
  const prefixBounds = { since_ms: 0, prefix_since_ms: seconds * 1000, prefix_until_seq: 1 }
  const lower = await f.client.inboxPage(f.config, { ...main, directory_at: 1, ...prefixBounds }, 1, 2)
  assert.deepEqual(lower.messages[0].directoryRecovery, prefixBounds)
  const upper = await f.client.inboxPage(f.config, { ...main, directory_at: 1, ...prefixBounds }, 2, 2)
  assert.equal(upper.messages[0].directoryRecovery, undefined)
  assert.deepEqual((await f.client.inboxPage(f.config, { ...main, directory_at: 1, ...bounds }, 1, 2))
    .messages.map(m => m.directoryRecovery), [undefined, undefined], 'directory_at/since_ms alone are not provenance')
})

test('strict history denial and malformed preference cannot fetch or mark directory messages', async () => {
  for (const [key, value, code] of [['threads', Response.json({}, { status: 403 }), 'http_403'],
    ['pref', { effective: 'true' }, 'invalid_directory_response'],
    ['pref', { no_mention: 1, group_allow_no_mention: false }, 'directory_preference_denied']]) {
    const f = fixture(); f.replies[key] = value
    await assert.rejects(f.client.inboxPage(f.config, { ...main, directory_all: 1, since_ms: 1 }, 1, 2), { code })
    assert.deepEqual(f.historyRequests, [])
  }
})

test('targeted recovered jobs revalidate access from direct or persisted provenance without pref gating', async () => {
  const bounds = { since_ms: 1, prefix_since_ms: 0, prefix_until_seq: 0 }
  for (const provenance of [{ directoryRecovery: bounds }, { metadata: JSON.stringify({ directoryRecovery: bounds }) }]) {
    const f = fixture({ senderPolicy: 'allowlist', channelPolicy: 'allowlist', groups: new Set([group]), mentionPolicy: 'required' })
    const job = { ...main, sender: 'human', ambient: false, ...provenance }
    f.replies.pref = () => assert.fail('an explicit admitted job does not require no-@ preference')
    assert.equal(await f.client.allowsMessage(f.config, job), true)
    assert.ok(f.calls.includes(root + '/threads?page_index=1&page_size=1'))
    f.replies.threads = Response.json({}, { status: 403 })
    await assert.rejects(f.client.allowsMessage(f.config, job), { status: 403 })
    f.calls.length = 0
    assert.equal(await f.client.allowsMessage(f.config, { ...main, sender: 'human', ambient: false }), true)
    assert.deepEqual(f.calls, [], 'ordinary accepted upper work keeps its existing local policy')
  }
})

test('provenance rejects malformed bounds and rechecks exact active topic details', async () => {
  const f = fixture({ senderPolicy: 'allowlist', channelPolicy: 'allowlist', threads: new Set([topic(1).channel_id]) })
  const job = { ...route(topic(1)), sender: 'human', ambient: false }
  for (const directoryRecovery of [null, [], { since_ms: '1' }, { since_ms: -1 }, { prefix_until_seq: 0x100000000 }]) {
    await assert.rejects(f.client.allowsMessage(f.config, { ...job, directoryRecovery }), { code: 'invalid_directory_recovery' })
  }
  assert.deepEqual(f.calls, [])
  f.replies.detail = { ...topic(1), status: 2 }
  assert.equal(await f.client.allowsMessage(f.config, { ...job,
    metadata: JSON.stringify({ directoryRecovery: { since_ms: 1, prefix_since_ms: 0, prefix_until_seq: 0 } }) }), false)
})

test('recovery context filters each timestamp before decoding old bodies, without sending bounds', async () => {
  const f = fixture(), seconds = Math.floor(Date.now() / 1000) - 60
  f.history = [historyRow(1, seconds + 2), historyRow(2, seconds - 60,
    { payload: { type: 1, content: '/new PRE_ACTIVATION_SYNTHETIC' } }), historyRow(3, seconds + 1),
    historyRow(4, undefined), historyRow(5, String(seconds + 1)), historyRow(6, seconds),
    historyRow(7, Math.floor(Date.now() / 1000) + 600)]
  const result = await f.client.recentMessages(f.config, { ...main, since_ms: seconds * 1000,
    prefix_since_ms: 0, prefix_until_seq: 0, directory_all: 1, directory_at: 1 }, 8)
  assert.deepEqual(result.rows.map(r => r.messageId), ['1', '3'], 'no timestamp-order shortcut may discard later valid rows')
  assert.ok(!JSON.stringify(result).includes('PRE_ACTIVATION_SYNTHETIC'))
  assert.deepEqual(f.historyRequests[0], { ...main, start_message_seq: 7, end_message_seq: 0, pull_mode: 0, limit: 20 })
})

test('prefix context preserves older accepted upper rows while excluding the pre-activation prefix', async () => {
  const f = fixture(), seconds = Math.floor(Date.now() / 1000) - 60
  f.history = [historyRow(1, seconds - 1), historyRow(2, seconds + 1), historyRow(3, undefined),
    historyRow(11, seconds - 60), historyRow(12, undefined)]
  const target = { ...main, since_ms: 0, prefix_since_ms: seconds * 1000, prefix_until_seq: 10 }
  assert.deepEqual((await f.client.recentMessages(f.config, target, 13)).rows.map(r => r.messageId), ['2', '11', '12'])
  assert.deepEqual((await f.client.recentMessages(f.config, { ...target, since_ms: seconds * 1000 }, 13))
    .rows.map(r => r.messageId), ['2'])
  assert.deepEqual((await f.client.recentMessages(f.config, main, 13)).rows.map(r => r.messageId), ['1', '2', '3', '11', '12'])
  await assert.rejects(f.client.recentMessages(f.config, { ...main, since_ms: '1' }, 13), { code: 'invalid_directory_recovery' })
})

test('baseline directory_at does not change archived topic or explicit known-route history semantics', async () => {
  const f = fixture({ mentionPolicy: 'required' }), seconds = Math.floor(Date.now() / 1000) - 60
  f.replies.detail = { ...topic(1), status: 2 }
  f.history = [historyRow(11, seconds, route(topic(1)))]
  const result = await f.client.inboxPage(f.config, { ...route(topic(1)), directory_at: 1, directory_all: 0 }, 1, 11)
  assert.deepEqual(result.messages.map(m => m.messageId), ['11'])
  assert.equal(result.messages[0].directoryRecovery, undefined)
  assert.deepEqual(f.calls, ['/v1/bot/messages/sync'])
})

test('promoted actual @ receipt leaves a skippable prefix and a usable original upper range', async () => {
  const f = fixture({ senderPolicy: 'allowlist', channelPolicy: 'allowlist', groups: new Set([group]) })
  const seconds = Math.floor(Date.now() / 1000) - 60
  f.replies.pref = { effective: false }
  f.history = [historyRow(2, seconds + 1), historyRow(10, seconds - 60)]
  const pure = { ...main, directory_all: 1, directory_at: 1, since_ms: seconds * 1000 }
  await assert.rejects(f.client.inboxPage(f.config, pure, 0, undefined), { code: 'directory_preference_denied' })
  assert.deepEqual(f.historyRequests, [])
  // Store owns the actual receipt/promotion transaction. This is its agreed API shape.
  const promoted = { ...pure, directory_all: 0, since_ms: 0, prefix_since_ms: pure.since_ms, prefix_until_seq: 9 }
  const tip = await f.client.inboxPage(f.config, promoted, 0, undefined)
  assert.equal(tip.last, 10)
  const reads = f.historyRequests.length
  const skipped = await f.client.inboxPage(f.config, promoted, 1, tip.last)
  assert.equal(skipped.skippedThrough, 9); assert.equal(skipped.count, 0); assert.equal(skipped.last, 0)
  assert.equal(f.historyRequests.length, reads, 'skip does not fetch the prefix')
  const upper = await f.client.inboxPage(f.config, promoted, skipped.skippedThrough + 1, tip.last)
  assert.deepEqual(upper.messages.map(m => m.messageId), ['10'])
  assert.equal(upper.messages[0].ambient, false); assert.equal(upper.messages[0].directoryRecovery, undefined)
  assert.equal(await f.client.allowsMessage(f.config, { ...main, sender: 'human', ambient: false }), true)
})

test('prefix skip is clamped to the requested bound and false access also skips without a body read', async () => {
  for (const [key, value] of [['pref', { effective: false }], ['groups', []]]) {
    const f = fixture(); f.replies[key] = value
    const result = await f.client.inboxPage(f.config, { ...main, directory_all: 0,
      prefix_until_seq: 10, prefix_since_ms: 1 }, 1, 5)
    assert.equal(result.skippedThrough, 5)
    assert.equal(result.last, 0); assert.equal(result.count, 0)
    assert.equal(result.scannedThrough, undefined)
    assert.deepEqual(f.historyRequests, [])
  }
})

test('targeted recovered local-allowlist work requires the sender to remain a current human member', async () => {
  const job = { ...main, sender: 'human', ambient: false,
    directoryRecovery: { since_ms: 1, prefix_since_ms: 0, prefix_until_seq: 0 } }
  let modelCalls = 0
  for (const actor of [null, { uid: 'human', robot: 1 }, { uid: 'human', robot: true },
    { uid: 'human', robot: '0' }, { uid: 'human' }]) {
    const f = fixture({ senderPolicy: 'allowlist', channelPolicy: 'allowlist', groups: new Set([group]) })
    f.replies.members = [{ uid: 'bot', robot: 1 }, ...(actor ? [actor] : [])]
    const allowed = await f.client.allowsMessage(f.config, job)
    if (allowed) modelCalls++
    assert.equal(allowed, false)
    assert.ok(f.calls.includes(root + '/members'))
    assert.ok(f.calls.includes(root + '/threads?page_index=1&page_size=1'))
    assert.ok(!f.calls.includes(root + '/mention_pref'))
  }
  assert.equal(modelCalls, 0)
})
