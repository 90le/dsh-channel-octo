import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelApi } from '../src/channel-api.js'
import { OctoError, readApiError } from '../src/api-errors.js'

const G = '00112233445566778899aabbccddeeff'
const G2 = 'ffeeddccbbaa99887766554433221100'
const topic = G + '____123456789012345678'
const targets = [{ channel_type: 2, channel_id: G }, { channel_type: 5, channel_id: topic }]
const dm = { channel_type: 1, channel_id: 'friend' }
const op = 'messages.search_authorized'
const missingGrant = async () => readApiError(Response.json({ status: 403,
  error: { code: 'err.server.bot_api.obo_not_authorized', http_status: 403, message: 'SECRET_UPSTREAM' } }, { status: 403 }))
const empty = { data: [], pagination: { has_more: false, next_cursor: '' } }

function fixture(overrides = {}) {
  const config = { botUid: 'bot', ownerUid: 'owner', spaceId: 'space', senderPolicy: 'octo', channelPolicy: 'joined', ...overrides }
  const state = { groups: [{ group_no: G, name: 'Group', space_id: 'space' }],
    principals: { friend: 'human', bot: 'user_bot' }, real: empty }
  const calls = []
  const api = new ChannelApi({ config, request: async (path, raw, signal, options) => {
    const body = raw && JSON.parse(raw)
    calls.push({ path, body, method: options.method })
    if (path === '/v1/bot/messages/sync') return { messages: [] }
    if (path.startsWith('/v1/bot/space/principals/')) {
      const uid = decodeURIComponent(path.split('/').at(-1).split('?')[0])
      assert.ok(path.endsWith('?space_id=space'))
      return { uid, principal_type: state.principals[uid] }
    }
    if (path === '/v1/bot/groups?space_id=space') return state.groups
    if (path.startsWith('/v1/bot/messages/_search_global_')) {
      assert.equal(options.method, 'POST')
      assert.equal(typeof body.on_behalf_of, 'string')
      if (body.on_behalf_of === 'bot') {
        assert.deepEqual(body, { on_behalf_of: 'bot', keyword: 'x'.repeat(65) })
        if (state.probe) return state.probe(body, signal)
        throw await missingGrant()
      }
      assert.equal(body.on_behalf_of, 'friend')
      if (state.onReal) return state.onReal(body, signal)
      return structuredClone(state.real)
    }
    throw Error('Unexpected path; no as-bot full message lookup is allowed')
  } })
  const run = (args = { targets }, operation = op, sender = 'friend', route = dm, signal = new AbortController().signal) => api.dispatch(route, sender, operation, args, signal)
  return { api, state, calls, run }
}
const denied = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code)
  assert.doesNotMatch(error.message, /SECRET_UPSTREAM/)
  return true
})

test('an admitted non-owner human searches only their own existing delegation and fixed-space targets', async () => {
  const f = fixture()
  const result = await f.run({ targets, keyword: '周报', limit: 3, sort: 'time_desc', filters: { sender_ids: ['member'] } })
  assert.deepEqual(result.entries, [])
  const queries = f.calls.filter(row => row.path.includes('_search_global_'))
  assert.equal(queries.length, 2)
  assert.deepEqual(queries[0].body, { keyword: 'x'.repeat(65), on_behalf_of: 'bot' })
  assert.deepEqual(queries[1].body, { keyword: '周报', filters: { sender_ids: ['member'], channel_ids: targets, channel_types: [2, 5] },
    page_size: 3, sort: 'time_desc', on_behalf_of: 'friend' })
  assert.ok(f.calls.every(row => !row.path.includes('grants') && !/\/messages\/\d/.test(row.path)))
})

test('final authorized file page fits the native encoded byte budget including continuation', async () => {
  const f = fixture()
  const sent_at = '2026-11-09T00:00:00.123456789+08:00'
  f.state.real = { data: Array.from({ length: 10 }, (_, i) => ({
    channel_id: G, channel_type: 2, message_id: String(9000000000000000000n + BigInt(i)),
    message_seq: 0xffffffff - i, sender_id: 's'.repeat(128), sender_name: '🚀'.repeat(100), sent_at,
    file_name: '🚀'.repeat(200), file_ext: '🚀'.repeat(20), file_size_bytes: Number.MAX_SAFE_INTEGER,
    content_snippet: '🚀'.repeat(1200),
  })), pagination: { has_more: true, next_cursor: 'WIRE_CURSOR' } }
  for (const text of ['🚀'.repeat(1200), '\\"\n\t'.repeat(400)]) {
    for (const row of f.state.real.data) row.content_snippet = text
    const result = await f.run({ targets: [targets[0]] }, 'messages.search_authorized_files')
    const encoded = JSON.stringify(result)
    assert.ok(Buffer.byteLength(encoded, 'utf8') <= 63 * 1024)
    assert.equal(result.entries.length, 10)
    assert.match(result.continuation, /^ocs_[a-f0-9]{32}$/)
    assert.doesNotMatch(encoded, /WIRE_CURSOR/)
    if (text.startsWith('🚀')) assert.equal(result.excerpts_truncated, true)
  }
})

test('server-specific negative recognition is required; no identity fallback on any failure', async t => {
  for (const [label, probe] of [
    ['old server ignores field', async () => ({ data: [{ secret: 'SECRET_UPSTREAM' }], pagination: empty.pagination })],
    ['generic403', async () => { throw new OctoError('http_403', 403) }],
    ['forged public field', async () => { throw Object.assign(new OctoError('http_403', 403), { officialCode: 'err.server.bot_api.obo_not_authorized' }) }],
    ['unknown official code', async () => { throw await readApiError(Response.json({ status: 403,
      error: { code: 'err.shared.auth.forbidden', http_status: 403 } }, { status: 403 })) }],
    ['timeout', async () => { throw Error('SECRET_UPSTREAM') }],
  ]) await t.test(label, async () => {
    const f = fixture(); f.state.probe = probe
    await denied(f.run(), 'delegated_search_unavailable')
    assert.equal(f.calls.filter(row => row.body?.on_behalf_of === 'friend').length, 0)
  })
  const f = fixture(); f.state.onReal = async () => { throw await missingGrant() }
  await denied(f.run(), 'delegated_search_denied')
  assert.equal(f.calls.filter(row => row.path.includes('_search_global_')).length, 2)
})

test('origin and account route policies are checked before delegated reads', async t => {
  for (const [label, setup, args, sender, route, code] of [
    ['group origin', {}, { targets }, 'friend', targets[0], 'private_search_required'],
    ['other DM', {}, { targets }, 'owner', dm, 'requester_not_allowed'],
    ['sender allowlist', { senderPolicy: 'allowlist', allowed: new Set(['owner']) }, { targets }, 'friend', dm, 'requester_not_allowed'],
    ['group allowlist', { channelPolicy: 'allowlist', groups: new Set(), threads: new Set([topic]) }, { targets }, 'friend', dm, 'route_not_allowed'],
    ['other space/group', {}, { targets: [{ channel_id: G2, channel_type: 2 }] }, 'friend', dm, 'delegated_target_not_allowed'],
  ]) await t.test(label, async () => {
    const f = fixture(setup)
    await denied(f.run(args, op, sender, route), code)
    assert.equal(f.calls.filter(row => row.path.includes('_search_global_')).length, 0)
  })
  const f = fixture(); f.state.groups[0].space_id = 'other-space'
  await denied(f.run(), 'delegated_target_not_allowed')
  const duplicate = fixture()
  duplicate.state.groups.push({ ...duplicate.state.groups[0], space_id: 'other-space' })
  await denied(duplicate.run(), 'delegated_target_not_allowed')
})

test('an explicitly allowed topic does not require granting its parent main channel', async () => {
  const f = fixture({ channelPolicy: 'allowlist', groups: new Set(), threads: new Set([topic]) })
  await f.run({ targets: [targets[1]] })
  const query = f.calls.find(row => row.body?.on_behalf_of === 'friend')
  assert.deepEqual(query.body.filters.channel_ids, [targets[1]])
  await denied(f.run({ targets: [targets[0]] }), 'route_not_allowed')
})

test('arguments are detached without executing getters and identities cannot be supplied by the model', async t => {
  const extra = [
    { targets, on_behalf_of: 'owner' }, { targets, sender: 'owner' }, { targets, space_id: 'other' }, { targets, cursor: 'wire-cursor' },
    { targets: [] }, { targets: [targets[0], { ...targets[0] }] },
    { targets: [{ channel_id: G, channel_type: 3 }] }, { targets: [dm] },
    { targets, filters: { content_types: [3] } },
    { targets, filters: { sent_at_from: '2026-02-30' } }, { targets, sort: 'relevance' },
  ]
  for (const [i, args] of extra.entries()) await t.test(String(i), async () => {
    const f = fixture(); await denied(f.run(args), 'invalid_arguments'); assert.equal(f.calls.length, 0)
  })
  let touched = 0
  const args = { get targets() { touched++; return targets } }
  const f = fixture()
  await denied(f.run(args), 'invalid_arguments')
  assert.equal(touched, 0)
  assert.equal(f.calls.length, 0)
})

test('continuations bind account, user, route and query without revealing wire cursors', async () => {
  const f = fixture()
  f.state.real = { data: [], pagination: { has_more: true, next_cursor: 'SECRET_CURSOR' } }
  const first = await f.run({ targets, keyword: 'same-query' })
  assert.match(first.continuation, /^ocs_[a-f0-9]{32}$/)
  assert.equal(first.more, true)
  assert.doesNotMatch(JSON.stringify(first), /SECRET_CURSOR|next_cursor/)
  await f.run({ targets: [...targets].reverse(), keyword: 'same-query', continuation: first.continuation })
  assert.equal(f.calls.at(-1).body.cursor, 'SECRET_CURSOR')
  for (const args of [
    { targets, keyword: 'changed' }, { targets: [targets[0]], keyword: 'same-query' },
    { targets, keyword: 'same-query', limit: 2 }, { targets, keyword: 'same-query', filters: { sender_ids: ['another'] } },
  ]) await denied(f.run({ ...args, continuation: first.continuation }), 'search_continuation_invalid')
  await denied(fixture().run({ targets, keyword: 'same-query', continuation: first.continuation }), 'search_continuation_invalid')
  f.state.principals.another = 'human'
  await denied(f.run({ targets, keyword: 'same-query', continuation: first.continuation }, op, 'another',
    { channel_id: 'another', channel_type: 1 }), 'search_continuation_invalid')
  // The same handle cannot switch operation families even with the same query.
  await denied(f.run({ targets, keyword: 'same-query', continuation: first.continuation }, 'messages.search_authorized_files'), 'search_continuation_invalid')
})

test('continuations expire and are bounded without caching result content', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const f = fixture()
  f.state.real = { data: [], pagination: { has_more: true, next_cursor: 'PRIVATE_CURSOR' } }
  const first = await f.run({ targets })
  now += 5 * 60_000
  await denied(f.run({ targets, continuation: first.continuation }), 'search_continuation_invalid')
  const second = await f.run({ targets })
  for (let i = 0; i < 64; i++) await f.run({ targets, keyword: 'query-' + i })
  await denied(f.run({ targets, continuation: second.continuation }), 'search_continuation_invalid')
})

test('files and group aggregation use their exact official schemas and cancellation is terminal', async () => {
  const f = fixture()
  f.state.real = { data: [], pagination: empty.pagination }
  await f.run({ targets, filters: { file_exts: ['pdf', 'md'], file_size_min: 100, file_size_max: 1000 } }, 'messages.search_authorized_files')
  await denied(f.run({ targets, filters: { file_exts: ['exe'] } }, 'messages.search_authorized_files'), 'invalid_arguments')
  await denied(f.run({ targets, filters: { file_size_min: 100, file_size_max: 1 } }, 'messages.search_authorized_files'), 'invalid_arguments')
  f.state.real = { data: { sequence: 0, total_groups: 0, total_groups_approx: true, groups: [] }, pagination: empty.pagination }
  await f.run({ targets }, 'messages.search_authorized_groups')
  const body = f.calls.at(-1).body
  assert.ok(!('sort' in body) && !('page_size' in body) && !('cursor' in body))
  const controller = new AbortController()
  f.state.probe = async () => { controller.abort(); throw await missingGrant() }
  await denied(f.run({ targets }, op, 'friend', dm, controller.signal), 'aborted')
})
