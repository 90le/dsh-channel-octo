import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readApiError } from '../src/api-errors.js'
import { OctoDiscovery, isOctoDiscoveryOperation, octoDiscoverySpecs } from '../src/octo-discovery.js'

const owner = 'owner-fixture', bot = 'bot-fixture', space = 'space-fixture'
const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), foreign = 'd'.repeat(32)
const short = '123456789012345678', short2 = '223456789012345678'
const dm = { channel_type: 1, channel_id: owner }
const groupRow = (group_no, extra = {}) => ({ group_no, name: 'Project', space_id: space, ...extra })
const groupDetail = (group_no, extra = {}) => ({ group_no, status: 1, name: 'Project', notice: 'private notice', ...extra })
const thread = (group_no, short_id = short, extra = {}) => ({
  group_no, short_id, channel_id: group_no + '____' + short_id, channel_type: 5,
  name: 'Topic', status: 1, last_message_content: 'private preview',
  last_message_sender_name: 'private author', message_count: 782, source_message_id: 1, ...extra,
})
const candidate = (id, topic = false, selected = short) => topic
  ? { ...thread(id, selected), kind: 'thread', parent_name: 'private parent' }
  : { kind: 'group', group_no: id, channel_id: id, channel_type: 2, name: 'Project' }
const groupPath = id => '/v1/bot/groups/' + id
const principalPath = id => '/v1/bot/space/principals/' + id
const asPrincipal = (uid, principal_type = 'human') => ({ uid, principal_type, email: 'private' })

async function officialError(code, status, wire = status) {
  return readApiError(Response.json({ status: wire,
    error: { code: 'err.server.bot_api.' + code, http_status: status, message: 'private upstream body' },
  }, { status: wire }))
}

function fixture({ config: overrides, handle, verify } = {}) {
  const calls = [], verifications = []
  const config = { botUid: bot, ownerUid: owner, spaceId: space, ...overrides }
  const api = new OctoDiscovery({ config, verifyAccount: async signal => {
    assert.ok(signal instanceof AbortSignal)
    verifications.push(signal)
    return verify ? verify(verifications.length) : { botUid: bot, spaceId: space, ownerUid: owner }
  }, request: async (path, body, signal, options) => {
    assert.equal(body, undefined)
    assert.deepEqual(options, { method: 'GET' })
    assert.ok(signal instanceof AbortSignal)
    const url = new URL(path, 'https://fixture.invalid')
    const { pathname, searchParams } = url
    calls.push(url)
    const custom = await handle?.(pathname, searchParams, calls)
    if (custom !== undefined) return custom
    if (pathname === principalPath(owner) || pathname === principalPath(bot)) {
      assert.equal(searchParams.get('space_id'), space)
      return asPrincipal(pathname === principalPath(owner) ? owner : bot,
        pathname === principalPath(owner) ? 'human' : 'user_bot')
    }
    throw new Error('Unexpected fixture request ' + pathname)
  } })
  const dispatch = (operation, args, signal) => api.dispatch(dm, owner, operation, args, signal)
  return { api, dispatch, calls, verifications }
}

test('owner DM reads exact group info and paginated roles; a missing group role or route prevents disclosure', async () => {
  let role = 1
  const f = fixture({ handle(path) {
    if (path === '/v1/bot/groups') return [groupRow(a)]
    if (path === groupPath(a)) return groupDetail(a, { internal_field: 'never disclose' })
    if (path === groupPath(a) + '/members') return [
      { uid: owner, name: 'Owner', role, robot: 0 },
      { uid: bot, name: 'Robot', role: 0, robot: 1, owner_uid: owner, created_at: 'never disclose' },
      { uid: 'removed', name: 'Removed', role: 0, robot: 0, is_deleted: 1 },
    ]
  } })
  assert.deepEqual(await f.dispatch('groups.info_joined', { group_no: a }), {
    group: { ...candidate(a), notice: 'private notice' },
  })
  assert.deepEqual(await f.dispatch('groups.members_joined', { group_no: a, page: 2, limit: 1 }), {
    group_no: a, members: [{ uid: bot, name: 'Robot', role: 0, robot: 1 }], page: 2, more: false,
  })
  const detailCalls = () => f.calls.filter(url => url.pathname === groupPath(a)).length
  const before = detailCalls()
  role = 0
  await assert.rejects(f.dispatch('groups.info_joined', { group_no: a }), { code: 'discovery_target_not_allowed' })
  assert.equal(detailCalls(), before)
  await assert.rejects(f.dispatch('groups.members_joined', { group_no: foreign }), { code: 'discovery_target_not_allowed' })
  assert.ok(!f.calls.some(url => url.pathname.startsWith(groupPath(foreign))))
})

test('discovery is opt-in, read-only, and rejects non-owner, shared, App Bot and forged scope inputs before I/O', async () => {
  const f = fixture()
  assert.ok(octoDiscoverySpecs.every(row => row.available && !row.mutating && row.privateOnly && row.ownerOnly && row.dmAvailable))
  assert.equal(isOctoDiscoveryOperation('messages.search_authorized'), false)
  assert.equal(isOctoDiscoveryOperation('docs.list'), false)
  await assert.rejects(f.api.dispatch(dm, 'another-user', 'spaces.current'), { code: 'owner_dm_required' })
  await assert.rejects(f.api.dispatch({ channel_type: 2, channel_id: a }, owner, 'groups.list_joined'), { code: 'owner_dm_required' })
  for (const input of [{ space_id: 'other-space' }, { on_behalf_of: 'another-user' }, { token: 'fake' },
    Object.defineProperty({}, 'page', { get: () => assert.fail('accessor must not execute') })]) {
    await assert.rejects(f.dispatch('space.members.list', input), { code: 'invalid_arguments' })
  }
  await assert.rejects(f.dispatch('space.principals.get', { uid: '..' }), { code: 'invalid_arguments' })
  await assert.rejects(f.dispatch('groups.resolve_targets', { name: '   ' }), { code: 'invalid_arguments' })
  await assert.rejects(f.dispatch('groups.threads.list', { group_no: a, limit: 21 }), { code: 'invalid_arguments' })
  const app = fixture({ config: { botKind: 'app', botUid: 'app_fixture_bot', spaceId: null } })
  await assert.rejects(app.dispatch('spaces.current'), { code: 'api_unsupported' })
  const disallowed = fixture({ config: { senderPolicy: 'allowlist', allowed: ['another-user'] } })
  await assert.rejects(disallowed.dispatch('spaces.current'), { code: 'owner_dm_required' })
  for (const x of [f, app, disallowed]) assert.equal(x.calls.length + x.verifications.length, 0)
})

test('current Space and exact principals use the same verified identity and do not surface profiles or aliases', async () => {
  const inactive = await officialError('user_not_found', 404)
  const f = fixture({ handle(path) {
    if (path === principalPath('person')) return asPrincipal('person')
    if (path === principalPath('alias')) return asPrincipal('other')
    if (path === principalPath('absent')) throw inactive
    if (path === principalPath('old-gateway')) throw Object.assign(new Error('raw body'), { status: 404 })
  } })
  assert.deepEqual(await f.dispatch('spaces.current'), { space_id: space })
  assert.deepEqual(await f.dispatch('space.principals.get', { uid: 'person' }),
    { principal: { uid: 'person', principal_type: 'human' } })
  assert.deepEqual(await f.dispatch('space.principals.get', { uid: 'absent' }), { principal: null })
  await assert.rejects(f.dispatch('space.principals.get', { uid: 'alias' }), { code: 'invalid_discovery_response' })
  await assert.rejects(f.dispatch('space.principals.get', { uid: 'old-gateway' }),
    { code: 'api_not_found', message: 'api_not_found' })
  assert.ok(f.calls.every(url => url.searchParams.get('space_id') === space))
})

test('space member paging checks exact eligible principals and withholds results if Space access changed', async () => {
  const absent = await officialError('user_not_found', 404)
  let withdraw = false
  const f = fixture({ handle(path, params, calls) {
    if (path === '/v1/bot/space/members') {
      assert.deepEqual(Object.fromEntries(params), { space_id: space, page: '2', limit: '3', keyword: 'Design & QA' })
      return [{ uid: 'p1', name: 'Name\u202E', robot: 0, owner_uid: 'private' },
        { uid: 'app1', name: 'Ineligible app', robot: 1 },
        { uid: 'bot2', name: 'Helper', robot: 1 }]
    }
    if (path === principalPath('p1')) return asPrincipal('p1')
    if (path === principalPath('app1')) throw absent
    if (path === principalPath('bot2')) return asPrincipal('bot2', 'user_bot')
    if (path === principalPath(owner) && withdraw && calls.some(url => url.pathname === '/v1/bot/space/members')) throw absent
  } })
  const args = { page: 2, limit: 3, keyword: ' Design & QA ' }
  assert.deepEqual(await f.dispatch('space.members.list', args), { page: 2, more: true, members: [
    { uid: 'p1', name: 'Name', principal_type: 'human' },
    { uid: 'bot2', name: 'Helper', principal_type: 'user_bot' },
  ] })
  f.calls.length = 0
  withdraw = true
  await assert.rejects(f.dispatch('space.members.list', args), { code: 'discovery_space_access_denied' })
})

test('joined groups use the pinned ordinary-group list and reject disabled and blacklisted groups', async () => {
  const blocked = await officialError('not_group_member', 403, 400)
  const f = fixture({ config: { channelPolicy: 'allowlist', groups: [a, b, c] }, handle(path, params) {
    if (path === '/v1/bot/groups') {
      assert.equal(params.get('space_id'), space)
      return [groupRow(c), groupRow(b), groupRow(a), groupRow(foreign)]
    }
    if ([a, b, c].some(id => path === groupPath(id))) return groupDetail(path.split('/').at(-1), path === groupPath(c) ? { status: 2 } : {})
    if (path === groupPath(a) + '/threads') return { count: 1, list: [thread(a)] }
    if (path === groupPath(b) + '/threads') throw blocked
  } })
  assert.deepEqual(await f.dispatch('groups.list_joined', { limit: 3 }), { page: 1, groups: [candidate(a)] })
  assert.ok(!f.calls.some(url => url.pathname.startsWith(groupPath(foreign))))
  assert.ok(!f.calls.some(url => url.pathname === groupPath(c) + '/threads'))
  const badSpace = fixture({ handle(path) {
    if (path === '/v1/bot/groups') return [groupRow(a, { space_id: 'foreign-space' })]
  } })
  await assert.rejects(badSpace.dispatch('groups.list_joined'), { code: 'invalid_discovery_response' })
})

test('unscoped resolver candidates are intersected with live Space and exact route policy; no raw metadata escapes', async () => {
  let listCalls = 0, dropParent = false
  const f = fixture({ config: { channelPolicy: 'allowlist', groups: [], threads: [thread(a).channel_id] },
    handle(path, params) {
      if (path === '/v1/bot/groups') return ++listCalls % 2 === 0 && dropParent ? [groupRow(b)] : [groupRow(a), groupRow(b)]
      if (path === '/v1/bot/resolve/targets') {
        assert.deepEqual(Object.fromEntries(params), { name: 'Topic & QA', kind: 'all', limit: '4' })
        const candidates = [candidate(foreign), candidate(a), candidate(a, true), candidate(a, true, short2), candidate(b, true)]
        return { total: candidates.length, truncated: true, candidates }
      }
      if (path === groupPath(a)) return groupDetail(a)
      if (path === groupPath(a) + '/threads/' + short) return thread(a, short, { status: 2 })
    },
  })
  const args = { name: ' Topic & QA ', limit: 4 }
  const visible = { kind: 'thread', name: 'Topic', group_no: a, short_id: short, status: 2,
    channel_id: thread(a).channel_id, channel_type: 5 }
  assert.deepEqual(await f.dispatch('groups.resolve_targets', args), { candidates: [visible] })
  assert.ok(f.calls.every(url => !url.pathname.startsWith(groupPath(foreign)) && !url.pathname.startsWith(groupPath(b))))
  assert.ok(!f.calls.some(url => url.pathname.endsWith('/' + short2)))
  dropParent = true
  assert.deepEqual(await f.dispatch('groups.resolve_targets', args), { candidates: [] })
})

test('targeted topic listing never enumerates unallowlisted topics or returns message previews', async () => {
  const handle = (path, params) => {
    if (path === '/v1/bot/groups') return [groupRow(a)]
    if (path === groupPath(a)) return groupDetail(a)
    if (path === groupPath(a) + '/threads/' + short2) return thread(a, short2)
    if (path === groupPath(a) + '/threads') {
      assert.deepEqual(Object.fromEntries(params), { page_index: '1', page_size: '1' })
      return { count: 2, list: [thread(a, short2)] }
    }
  }
  const opts = { group_no: a, limit: 1 }
  const f = fixture({ config: { channelPolicy: 'allowlist', threads: [thread(a, short2).channel_id] }, handle })
  const visible = { kind: 'thread', group_no: a, short_id: short2, channel_type: 5,
    channel_id: thread(a, short2).channel_id, name: 'Topic', status: 1 }
  assert.deepEqual(await f.dispatch('groups.threads.list', opts), { page: 1, more: false, threads: [visible] })
  assert.ok(!f.calls.some(url => url.pathname.endsWith('/threads')))
  await assert.rejects(f.dispatch('groups.threads.list', { ...opts, group_no: b }), { code: 'discovery_target_not_allowed' })
  assert.deepEqual(await fixture({ handle }).dispatch('groups.threads.list', opts), { page: 1, more: true, threads: [visible] })
})

test('OBO reports generic self policy only and rejects an unexpected grantor or scope', async () => {
  let rows = []
  const f = fixture({ handle(path, params) {
    if (path === '/v1/bot/obo-grants/self') {
      assert.equal(params.get('space_id'), space)
      return rows
    }
  } })
  assert.deepEqual(await f.dispatch('obo.scopes.list'), { grant: null })
  const row = { grantor_uid: owner, grant_state: 'PAUSED', global_enabled: true, scopes: ['ALL'],
    policy_version: 5, persona_prompt: 'private persona', other_scopes: ['private'] }
  rows = [row]
  assert.deepEqual(await f.dispatch('obo.scopes.list'), { grant: { state: 'PAUSED', global_enabled: true, scopes: ['ALL'] } })
  for (const result of [{ ...row, grantor_uid: 'another-user' }, { ...row, scopes: ['messages.read'] }, { ...row, scopes: ['ALL', 'ALL'] }]) {
    rows = [result]
    await assert.rejects(f.dispatch('obo.scopes.list'), { code: 'invalid_discovery_response' })
  }
  assert.ok(f.calls.every(url => url.pathname === '/v1/bot/obo-grants/self' || url.pathname.startsWith('/v1/bot/space/principals/')))
})

test('owner, token identity, revocation and cancellation checks suppress in-flight metadata', async () => {
  for (const other of [{ ownerUid: 'new-owner' }, { spaceId: 'other-space' }, { botUid: 'different-bot' }]) {
    const f = fixture({ handle: path => path === '/v1/bot/obo-grants/self' ? [] : undefined,
      verify: n => ({ botUid: bot, ownerUid: owner, spaceId: space, ...(n === 2 && other) }) })
    await assert.rejects(f.dispatch('obo.scopes.list'), { code: 'discovery_account_unverified' })
  }
  for (const abort of [false, true]) {
    const controller = new AbortController()
    const f = fixture({ handle(path) {
      if (path === '/v1/bot/obo-grants/self') {
        if (abort) controller.abort('raw abort reason')
        else f.api.revoke()
        return []
      }
    } })
    await assert.rejects(f.dispatch('obo.scopes.list', {}, controller.signal),
      { code: abort ? 'aborted' : 'account_configuration_changed' })
  }
})
