import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OctoClient } from '../src/octo.js'
import { CHANNEL_API_OPERATIONS } from '../src/channel-api.js'
import { Worker } from '../src/worker.js'

const G = 'a'.repeat(32), T = '12345678901234567', H = 'iwh_' + 'b'.repeat(32)
const root = '/v1/bot/groups/' + G
const group = { channel_id: G, channel_type: 2 }
const topic = { channel_id: G + '____' + T, channel_type: 5 }
const dm = { channel_id: 'human', channel_type: 1 }
const mid = '9223372036854775807'
const secret = 'NEVER_ECHO_THIS_SECRET'
const card = () => ({ type: 17, profile: 'octo/v1', card_version: '1.5',
  card: { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Report', wrap: true }] } })

function fixture({ route = group, sender = 'human' } = {}) {
  const calls = [], writes = []
  const hp = root + (route.channel_type === 5 ? '/threads/' + T : '') + '/incoming-webhooks'
  const config = { apiBase: 'https://octo.invalid', token: 'bf_fixture', botUid: 'bot', spaceId: 'space', ownerUid: 'human' }
  const state = {
    groupStatus: 1, threadStatus: 1,
    members: [{ uid: 'human', robot: 0, role: 1, name: 'Human' }, { uid: 'bot', robot: 1, role: 0, name: 'Bot' },
      { uid: 'member', robot: 0, role: 0, name: 'Member' }],
    hook: { webhook_id: H, group_no: G, ...(route.channel_type === 5 && { thread_short_id: T }),
      name: 'Build', creator_uid: 'bot', status: 1, allow_mention_all: 0, allow_mention_bots: 0,
      mention_uids: [], last_used_at: 0, call_count: 1, created_at: 100,
      token: secret, urls: { native: secret }, adapter_examples: [{ url: secret }] },
    message: { ...route, message_id: mid, message_seq: 1, from_uid: 'bot', payload: card() },
    response: undefined, intercept: undefined,
  }
  config.fetchImpl = async (input, init) => {
    const url = new URL(input), path = url.pathname
    assert.equal(url.origin, 'https://octo.invalid')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.Authorization, path === '/v1/auth/verify-bot' ? undefined : 'Bearer bf_fixture')
    const call = { path, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    let result = await state.intercept?.(call, state)
    if (result === undefined) {
      if (path === '/v1/bot/groups') result = [{ group_no: G, space_id: 'space' }]
      else if (path === root + '/members') result = structuredClone(state.members)
      else if (path === root) result = { group_no: G, name: 'Group', status: state.groupStatus }
      else if (path === root + '/threads/' + T) result = { group_no: G, short_id: T, ...topic, name: 'Topic', creator_uid: 'bot', status: state.threadStatus }
      else if (path === hp && init.method === 'GET') result = { list: state.hook ? [structuredClone(state.hook)] : [] }
      else if (path === '/v1/bot/messages/sync') result = { messages: [] }
      else if (path === (route.channel_type === 1 ? '/v1/bot/messages/person/human/' + mid
        : root + (route.channel_type === 5 ? '/threads/' + T : '') + '/messages/' + mid)) result = structuredClone(state.message)
      else {
        writes.push(call)
        if (state.response !== undefined) result = state.response
        else if (path === hp + '/' + H && init.method === 'PUT') result = { ...state.hook,
          ...Object.fromEntries(Object.entries(call.body).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value])) }
        else if (path === hp + '/' + H && init.method === 'DELETE') result = { status: 200 }
        else if (path === hp + '/' + H + '/test' && init.method === 'POST') return new Response('{"status":0,"message_id":9223372036854775807}')
        else if (path === '/v1/bot/message/card/revisions/clear' && init.method === 'POST') result = { cleared: 4, token: secret }
        else assert.fail('unexpected API path: ' + path)
      }
    }
    return result instanceof Response ? result : Response.json(result)
  }
  const api = new OctoClient(config)
  return { state, calls, writes, hp, config, api, run: (name, args, signal) => api.channel.dispatch(route, sender, name, args, signal) }
}
const denies = (promise, code) => assert.rejects(promise, { code })
const noSecret = value => assert.doesNotMatch(JSON.stringify(value), /NEVER_ECHO|"token"|adapter_examples|"urls?"/)

test('new operations are scoped, frozen mutations with no credential argument', () => {
  for (const name of ['webhooks.update', 'webhooks.delete', 'webhooks.test', 'messages.clear_card_revisions']) {
    const spec = CHANNEL_API_OPERATIONS.find(s => s.name === name)
    assert.equal(spec.available, true)
    assert.equal(spec.mutating, true)
    assert.equal(spec.parameters.additionalProperties, false)
    assert.equal(spec.parameters.properties.channel_id, undefined)
    assert.equal(spec.parameters.properties.token, undefined)
    assert.ok(Object.isFrozen(spec.parameters))
  }
})

test('webhook update maps status, trims UTF8 name and retains explicit false/empty fields in both routes', async () => {
  for (const route of [group, topic]) {
    const f = fixture({ route })
    const result = await f.run('webhooks.update', { webhook_id: H, name: ' 构建通知 ', enabled: false,
      allow_mention_all: false, allow_mention_bots: false, mention_uids: [] })
    noSecret(result)
    assert.equal(result.ok, true)
    assert.deepEqual(f.writes, [{ path: f.hp + '/' + H, method: 'PUT',
      body: { name: '构建通知', status: 0, allow_mention_all: false, allow_mention_bots: false, mention_uids: [] } }])
    assert.equal(f.calls.filter(c => c.path.endsWith('/members')).length, 3)
    assert.equal(result.webhook.status, 0)
  }
})

test('webhook name byte limit, no-op, unknown fields and active member mentions are enforced before writes', async () => {
  for (const fields of [{}, { name: '字'.repeat(22) }, { name: '' }, { name: '  ' }, { token: 'x' },
    { status: 2 }, { mention_uids: ['member', 'member'] }, { enabled: 'false' }, { name: 'x', channel_id: 'other' }]) {
    const f = fixture()
    await denies(f.run('webhooks.update', { webhook_id: H, ...fields }), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
  for (const target of ['outsider', 'all', 'all_bots']) {
    const f = fixture()
    await denies(f.run('webhooks.update', { webhook_id: H, mention_uids: [target] }), 'invalid_mention_target')
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  noSecret(await f.run('webhooks.update', { webhook_id: H, mention_uids: ['human', 'member'], allow_mention_all: true }))
  assert.deepEqual(f.writes[0].body.mention_uids, ['human', 'member'])
})

test('webhook delete is exactly one DELETE; test requires explicit sending and returns lossless receipt', async () => {
  for (const route of [group, topic]) {
    const f = fixture({ route })
    noSecret(await f.run('webhooks.delete', { webhook_id: H }))
    assert.deepEqual(f.writes, [{ path: f.hp + '/' + H, method: 'DELETE', body: undefined }])
    const g = fixture({ route })
    const result = await g.run('webhooks.test', { webhook_id: H, confirm_send: true })
    assert.equal(result.message_id, mid)
    assert.equal(result.sent, true)
    assert.equal(result.broadcast, false)
    assert.deepEqual(g.writes, [{ path: g.hp + '/' + H + '/test', method: 'POST', body: undefined }])
  }
  for (const value of [false, undefined, 1]) {
    const f = fixture()
    const args = { webhook_id: H, ...(value !== undefined && { confirm_send: value }) }
    await denies(f.run('webhooks.test', args), value === false ? 'explicit_confirmation_required' : 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
})

test('webhooks reject nonadmin requester, foreign scope/owner, inactive group, and DM', async () => {
  for (const operation of ['webhooks.update', 'webhooks.delete', 'webhooks.test']) {
    const args = { webhook_id: H, ...(operation.endsWith('update') && { enabled: true }), ...(operation.endsWith('test') && { confirm_send: true }) }
    for (const [change, code] of [
      [f => f.state.members[0].role = 0, 'requester_admin_required'],
      [f => f.state.hook.creator_uid = 'member', 'webhook_bot_permission_required'],
      [f => f.state.hook.group_no = 'b'.repeat(32), 'invalid_webhook_response'],
      [f => f.state.hook.thread_short_id = T, 'invalid_webhook_response'],
      [f => f.state.hook = undefined, 'webhook_outside_channel'],
      [f => f.state.groupStatus = 2, 'group_not_active'],
    ]) {
      const f = fixture(); change(f)
      await denies(f.run(operation, args), code)
      assert.equal(f.writes.length, 0)
    }
    const f = fixture({ route: dm })
    await denies(f.run(operation, args), 'group_required')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  f.state.hook.creator_uid = 'member'; f.state.members[1].role = 2
  assert.equal((await f.run('webhooks.delete', { webhook_id: H })).deleted, true)
})

test('late membership, webhook ownership and mention membership changes stop the write', async () => {
  for (const mode of ['requester', 'bot', 'webhook', 'target']) {
    const f = fixture(); let reads = 0
    f.state.intercept = call => {
      if (call.path === f.hp && ++reads === 2) {
        if (mode === 'requester') f.state.members[0].role = 0
        if (mode === 'bot') f.state.members.splice(1, 1)
        if (mode === 'webhook') f.state.hook.creator_uid = 'member'
        if (mode === 'target') f.state.members.splice(2, 1)
      }
    }
    await assert.rejects(f.run('webhooks.update', { webhook_id: H, mention_uids: ['member'] }))
    assert.equal(f.writes.length, 0)
  }
})

test('webhook writes do not retry, reflect error prose, or claim success without exact acknowledgement', async () => {
  for (const operation of ['webhooks.update', 'webhooks.delete', 'webhooks.test']) {
    const args = { webhook_id: H, ...(operation.endsWith('update') && { enabled: false }), ...(operation.endsWith('test') && { confirm_send: true }) }
    for (const response of [{}, { status: 200 }, { status: 0, message_id: 0 }, new Response(secret, { status: 500 }),
      new Response(secret, { status: 403 }), new Response(secret, { status: 429 })]) {
      if (operation.endsWith('delete') && response.status === 200 && !(response instanceof Response)) continue
      const f = fixture(); f.state.response = response
      await assert.rejects(f.run(operation, args), error => {
        assert.ok(['mutation_unconfirmed', 'api_permission_denied', 'api_rate_limited'].includes(error.code), error.code)
        assert.doesNotMatch(error.message, /NEVER_ECHO/)
        return true
      })
      assert.equal(f.writes.length, 1)
    }
  }
})

test('card cleanup preserves current card and requires verified owner plus group admin, exact route and confirmation', async () => {
  for (const route of [dm, group, topic]) {
    const f = fixture({ route })
    const result = await f.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true })
    noSecret(result)
    assert.deepEqual(result, { ok: true, message_id: mid, cleared: 4, current_card_retained: true, audit_tombstone: true })
    assert.deepEqual(f.writes, [{ path: '/v1/bot/message/card/revisions/clear', method: 'POST', body: { ...route, message_id: mid } }])
  }
  const nonOwner = fixture({ sender: 'member' })
  await denies(nonOwner.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true }), 'requester_owner_required')
  const noConfirm = fixture()
  await denies(noConfirm.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: false }), 'explicit_confirmation_required')
  assert.equal(noConfirm.calls.length, 0)
  const nonAdmin = fixture(); nonAdmin.state.members[0].role = 0
  await denies(nonAdmin.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true }), 'requester_admin_required')
})

test('card cleanup refuses managed/interactive/foreign/revoked cards and effective frame replacement', async () => {
  const changes = [
    message => message.from_uid = 'member',
    message => message.channel_id = 'b'.repeat(32),
    message => message.payload.type = 1,
    message => message.extra = { revoke: 1 },
    message => message.payload.card.body[0].text = 'DSH 等待你的批准',
    message => message.payload.card.body[0].text = 'DSH 回复进度',
    message => message.payload.card.body.push({ type: 'ActionSet', actions: [{ type: 'Action.Submit', title: 'Answer' }] }),
    message => message.payload.registry = { template: 'form' },
    message => message.extra = { content_edit: { ...card(), profile: 'octo/v2' } },
  ]
  for (const change of changes) {
    const f = fixture(); change(f.state.message)
    await assert.rejects(f.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true }))
    assert.equal(f.writes.length, 0)
  }
})

test('card cleanup rechecks live ownership, permission and source before sending; false receipts are unknown', async () => {
  for (const mode of ['card', 'owner', 'member']) {
    const f = fixture(); let reads = 0
    f.state.intercept = call => {
      if (call.path.endsWith('/messages/' + mid) && ++reads === 2) {
        if (mode === 'card') f.state.message.from_uid = 'member'
        if (mode === 'owner') f.config.ownerUid = 'member'
        if (mode === 'member') f.state.members[0].role = 0
      }
    }
    await assert.rejects(f.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true }))
    assert.equal(f.writes.length, 0)
  }
  for (const raw of [{ cleared: -1 }, { cleared: '2' }, {}, { cleared: 1.1 }, new Response(secret, { status: 503 })]) {
    const f = fixture(); f.state.response = raw
    await denies(f.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true }), 'mutation_unconfirmed')
    assert.equal(f.writes.length, 1)
  }
})

test('mutation arguments cannot invoke getters or mutate after validation; aborted requests never write', async () => {
  const f = fixture()
  await denies(f.run('webhooks.delete', { get webhook_id() { assert.fail('must not invoke') } }), 'invalid_arguments')
  const controller = new AbortController(); controller.abort()
  await denies(f.run('webhooks.delete', { webhook_id: H }, controller.signal), 'aborted')
  assert.equal(f.writes.length, 0)
  let pending
  const g = fixture(), args = { webhook_id: H, mention_uids: ['member'] }
  g.state.intercept = async call => { if (call.path === '/v1/bot/groups') await (pending ??= new Promise(resolve => setTimeout(resolve, 5))) }
  const task = g.run('webhooks.update', args)
  args.mention_uids.push('outsider'); args.webhook_id = 'foreign'
  await task
  assert.deepEqual(g.writes[0].body.mention_uids, ['member'])
})

test('startup verified owner reaches channel tools despite account connection config copy; a missing owner revokes it', async () => {
  const f = fixture({ route: dm })
  f.api.configureChannel({ ...f.config, ownerUid: undefined })
  const workerConfig = { ...f.config, ownerUid: 'stale-owner', transport: 'websocket' }
  const worker = new Worker({ api: f.api, store: { unfinishedQuestionCards: () => [] },
    host: {}, config: workerConfig, log() {} })
  f.state.intercept = call => {
    if (call.path === '/v1/auth/verify-bot') return { bot_uid: 'bot', space_id: 'space', owner_uid: 'human' }
  }
  worker.runRealtime = async () => {
    assert.equal(worker.config.ownerUid, 'human')
    assert.equal((await f.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true })).ok, true)
  }
  await worker.run(new AbortController().signal)
  assert.equal(f.writes.length, 1)
  f.state.intercept = call => {
    if (call.path === '/v1/auth/verify-bot') return { bot_uid: 'bot', space_id: 'space' }
  }
  worker.runRealtime = async () => {
    assert.equal(worker.config.ownerUid, undefined)
    await denies(f.run('messages.clear_card_revisions', { message_id: mid, confirm_clear: true }), 'owner_identity_required')
  }
  await worker.run(new AbortController().signal)
  assert.equal(f.writes.length, 1)
})
