import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { Accounts } from '../src/accounts.js'
import { Worker } from '../src/worker.js'
import { admit } from '../src/octo.js'
import { registerWeb } from '../src/web.js'
import { administerWebhooks } from '../src/webhook-admin.js'
import { webhookChatReceipt } from '../src/webhook-chat-command.js'
import { createAccountView } from '../src/account-view.js'

const group = '00112233445566778899aabbccddeeff'
const thread = '123456789012345678'
const route = { type: 2, address: group }
const threadRoute = { type: 5, address: group + '____' + thread }
const hookId = 'iwh_' + 'a'.repeat(32)
const token = 'bf_synthetic_webhook_bot'
const secret = 'b'.repeat(64)
const botUid = 'fixture-bot', spaceId = 'fixture-space', ownerUid = 'fixture-owner'
const path = '/v1/bot/groups/' + group + '/incoming-webhooks'
const hook = (extra = {}) => ({ webhook_id: hookId, group_no: group, name: 'Fixture hook', avatar: '', creator_uid: botUid,
  status: 1, allow_mention_all: 0, allow_mention_bots: 0, mention_uids: ['fixture-person'],
  last_used_at: 0, call_count: 0, created_at: 123, ...extra })
const created = item => {
  const url = '/v1/incoming-webhooks/' + item.webhook_id + '/' + secret
  return { ...item, token: secret, url, urls: { native: url, github: url + '/github', gitlab: url + '/gitlab' },
    adapter_examples: [{ key: 'gitlab', title: 'GitLab', description: 'Synthetic setup', url: url + '/gitlab',
      content_type: 'application/json', auth: { type: 'url_token_and_header', header: 'X-Gitlab-Token', value_source: 'token' }, steps: ['Use ' + url + '/gitlab'] }] }
}
const errorResponse = (code, status = 403, semantic = status) => Response.json({ status,
  error: { code, http_status: semantic, message: token + secret, details: { secret } } }, { status })

function server() {
  const calls = [], state = { item: hook(), member: true, space: true, admin: true, response: null, threadStatus: 1 }
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const parsed = new URL(url), endpoint = parsed.pathname.replace(/^\/api/, '')
    assert.equal(init.redirect, 'manual')
    assert.equal(parsed.origin, 'https://octo.invalid')
    if (endpoint === '/v1/auth/verify-bot') {
      return Response.json({ bot_uid: state.botUid || (JSON.parse(init.body).bot_token === 'bf_second' ? 'second-bot' : botUid),
        space_id: spaceId, owner_uid: state.ownerUid ?? ownerUid })
    }
    assert.equal(init.headers.Authorization, 'Bearer ' + token)
    if (endpoint === '/v1/bot/sendMessage') return Response.json({ message_id: '9001' })
    if (endpoint.startsWith('/v1/bot/space/principals/')) return state.space
      ? Response.json(endpoint.endsWith('/' + ownerUid) ? { uid: ownerUid, principal_type: 'human' }
        : { uid: botUid, principal_type: 'user_bot' }) : errorResponse('err.server.bot_api.user_not_found', 404)
    if (endpoint === '/v1/bot/groups') return Response.json([{ group_no: group, name: 'Fixture group', space_id: state.spaceId || spaceId }])
    if (endpoint === '/v1/bot/groups/' + group) return Response.json({ group_no: group, status: 1 })
    if (endpoint === '/v1/bot/groups/' + group + '/members') {
      await state.onMembers?.()
      return Response.json([{ uid: ownerUid, robot: 0, role: 1 }, { uid: botUid, robot: 1, role: 0 }])
    }
    if (endpoint === '/v1/bot/groups/' + group + '/threads/' + thread) return Response.json({ group_no: group, short_id: thread,
      status: state.threadStatus, name: 'Thread', channel_type: 5, channel_id: threadRoute.address })
    if (endpoint === '/v1/bot/groups/' + group + '/threads') return Response.json({ count: 101, list: [{ group_no: group, short_id: thread, status: 1, name: 'Thread' }] })
    const base = endpoint.includes('/threads/') ? '/v1/bot/groups/' + group + '/threads/' + thread + '/incoming-webhooks' : path
    const item = endpoint.includes('/threads/') ? { ...state.item, thread_short_id: thread } : state.item
    if (!state.member) return errorResponse('err.server.incomingwebhook.mgmt_forbidden')
    if (endpoint === base && init.method === 'GET') return state.listResponse?.() ?? Response.json({ list: item ? [item] : [] })
    if (state.response) return state.response(endpoint, init)
    if (!state.admin && item?.creator_uid !== botUid) return errorResponse('err.server.incomingwebhook.mgmt_forbidden')
    if (endpoint.endsWith('/deliveries')) return new Response('{"list":[{"status":1,"reason":"","http_status":200,"adapter":"test","byte_size":9,"message_id":9223372036854775807,"created_at":123}]}')
    if (endpoint.endsWith('/test')) return new Response('{"status":0,"message_id":9223372036854775807}')
    if (endpoint.endsWith('/regenerate')) return Response.json(created(item))
    if (init.method === 'DELETE') return Response.json({ status: 200 })
    if (init.method === 'PUT') {
      const changes = JSON.parse(init.body)
      if (!state.admin && 'avatar' in changes) return errorResponse('err.server.incomingwebhook.mgmt_request_invalid', 400)
      state.item = { ...state.item, ...changes }
      for (const key of ['allow_mention_all', 'allow_mention_bots']) state.item[key] = Number(state.item[key])
      return Response.json({ ...item, ...state.item })
    }
    assert.equal(endpoint, base, 'synthetic transport rejects any unexpected destination')
    assert.equal(init.method, 'POST')
    const changes = JSON.parse(init.body)
    for (const key of ['allow_mention_all', 'allow_mention_bots']) if (key in changes) changes[key] = Number(changes[key])
    return Response.json(created({ ...item, ...changes }))
  }
  const context = { apiBase: 'https://octo.invalid/api', token, fetchImpl, signal: new AbortController().signal,
    record: { botUid, spaceId }, conversations: [{ ...threadRoute }, { type: 1, address: 'private-user' }] }
  return { state, calls, context, run: input => administerWebhooks(context, input) }
}
const mutation = (action, item, extra = {}) => ({ action, route, webhookId: hookId, expected: item.version,
  ...(['delete', 'regenerate', 'test'].includes(action) && { confirmed: true }), ...extra })

test('discovery is scoped to live Space and joined groups; thread discovery is paginated and read-only', async () => {
  const { run, calls, state } = server()
  const result = await run({ action: 'routes' })
  assert.deepEqual(result.routes.map(r => [r.type, r.address]), [[2, group], [5, threadRoute.address]])
  const threads = await run({ action: 'threads', route, page: 1 })
  assert.equal(threads.more, true)
  assert.equal(threads.routes[0].type, 5)
  assert.ok(calls.every(c => c.init.method === 'GET'))
  state.spaceId = 'wrong-space'
  assert.deepEqual((await run({ action: 'routes' })).routes, [])
  await assert.rejects(run({ action: 'list', route }), /webhook_forbidden/)
  state.space = false
  await assert.rejects(run({ action: 'routes' }), /webhook_not_found/)
})

test('metadata whitelist excludes nested secrets; create/rotate return protected setup only without automatic test', async () => {
  const { run, state, calls } = server()
  state.item = created(hook())
  const item = (await run({ action: 'list', route })).list[0]
  assert.doesNotMatch(JSON.stringify(item), new RegExp(secret + '|incoming-webhooks|adapter_examples|token'))
  for (const input of [{ action: 'create', route, changes: {} }, mutation('regenerate', item)]) {
    const result = await run(input)
    assert.equal(result.secret.token, secret)
    assert.equal(result.secret.urls.gitlab, 'https://octo.invalid/api/v1/incoming-webhooks/' + hookId + '/' + secret + '/gitlab')
    assert.doesNotMatch(JSON.stringify(result.webhook), new RegExp(secret))
  }
  assert.ok(!calls.some(call => call.url.endsWith('/test')))
})

test('full edit fields, disabled rotation, server-admin access to other creators and explicit test use official contracts', async () => {
  const { run, state, calls } = server()
  state.item = hook({ creator_uid: 'other-person', status: 0 })
  let item = (await run({ action: 'list', route })).list[0]
  let result = await run(mutation('update', item, { changes: { name: 'Changed', avatar: 'https://images.invalid/fixture.png', status: 0,
    allow_mention_all: true, allow_mention_bots: true, mention_uids: [] } }))
  assert.equal(result.webhook.name, 'Changed')
  assert.equal(calls.at(-1).init.method, 'PUT')
  item = result.webhook
  result = await run(mutation('regenerate', item))
  assert.equal(result.webhook.status, 0)
  result = await run(mutation('test', item))
  assert.deepEqual(result.test, { message_id: '9223372036854775807' })
  assert.equal(calls.at(-1).init.body, undefined)
  const diagnostics = await run({ action: 'deliveries', route, webhookId: hookId, limit: 100 })
  assert.equal(diagnostics.deliveries[0].message_id, '9223372036854775807')
  await run(mutation('delete', item))
  assert.equal(calls.at(-1).init.method, 'DELETE')
  assert.equal(calls.at(-1).init.body, undefined)
})

test('creator and avatar permission are server enforced and no DSH admin IM impersonation is sent', async () => {
  const { run, calls, state } = server()
  state.admin = false
  let item = (await run({ action: 'list', route })).list[0]
  await assert.rejects(run(mutation('update', item, { changes: { avatar: 'https://image.invalid/a' } })), /invalid_webhook_request/)
  await run(mutation('update', item, { changes: { allow_mention_all: true, allow_mention_bots: true } }))
  state.item.creator_uid = 'other-person'
  item = (await run({ action: 'list', route })).list[0]
  for (const action of ['delete', 'regenerate', 'test']) await assert.rejects(run(mutation(action, item)), /webhook_forbidden/)
  await assert.rejects(run({ action: 'deliveries', route, webhookId: hookId }), /webhook_forbidden/)
  assert.doesNotMatch(JSON.stringify(calls), /on_behalf_of|operator_uid|sender_uid/)
})

test('revocation, cross-route IDs and changed mentions block writes before submission', async () => {
  const { run, state, calls } = server()
  const item = (await run({ action: 'list', route })).list[0]
  state.member = false
  await assert.rejects(run(mutation('test', item)), /webhook_forbidden/)
  state.member = true
  state.item.mention_uids.push('new-target')
  await assert.rejects(run(mutation('test', item)), /webhook_changed/)
  state.listResponse = () => Response.json({ list: [hook({ thread_short_id: thread })] })
  await assert.rejects(run(mutation('delete', item)), /webhook_unavailable/)
  state.listResponse = () => Response.json({ list: [] })
  await assert.rejects(run(mutation('regenerate', item)), /webhook_not_found/)
  assert.ok(calls.every(c => c.init.method === 'GET'))
})

test('exact thread endpoints never fall back to parent and archived threads retain non-creation management', async () => {
  const { run, calls, state } = server()
  state.threadStatus = 2
  const item = (await run({ action: 'list', route: threadRoute })).list[0]
  await run({ ...mutation('delete', item), route: threadRoute })
  assert.equal(new URL(calls.at(-1).url).pathname, '/api/v1/bot/groups/' + group + '/threads/' + thread + '/incoming-webhooks/' + hookId)
  assert.ok(!calls.some(c => new URL(c.url).pathname === '/api' + path))
})

test('strict inputs reject arbitrary routes, destinations, unconfirmed actions and oversized/malformed changes', async () => {
  const { run, calls } = server()
  for (const input of [null, [], { action: 'list', route: { type: 1, address: 'private-user' } },
    { action: 'list', route: { type: 2, address: '..' } }, { action: 'list', route, token },
    { action: 'create', route, changes: { name: '中'.repeat(22) } }, { action: 'create', route, changes: { status: 0 } },
    { action: 'create', route, changes: { allow_mention_all: 1 } }, { action: 'create', route, changes: { mention_uids: ['a', 'a'] } },
    { action: 'delete', route, webhookId: hookId, expected: 'a'.repeat(64) },
    { action: 'test', route, webhookId: hookId, expected: 'a'.repeat(64), confirmed: true, content: 'injected' }]) {
    await assert.rejects(run(input), /invalid_webhook_request/)
  }
  assert.equal(calls.length, 0)
})

test('uncertain writes never retry or expose response/errors; malformed secrets fail closed', async () => {
  const { run, state, calls } = server()
  const item = (await run({ action: 'list', route })).list[0]
  const failures = [
    () => { throw Error(token + secret) }, () => new Response('bad ' + secret),
    () => Response.json({ ...created(hook()), url: 'https://evil.invalid/' + secret }),
    () => Response.json({ ...created(hook()), webhook_id: 'iwh_' + 'c'.repeat(32) }),
    () => Response.json({ error: { message: secret } }),
    () => errorResponse('err.server.incomingwebhook.mgmt_operation_failed', 500),
    () => new Response('', { status: 302, headers: { location: 'https://evil.invalid/' + secret } }),
    () => new Response('x'.repeat(1_048_577)),
  ]
  for (const response of failures) {
    state.response = response
    const before = calls.filter(c => c.init.method !== 'GET').length
    await assert.rejects(run(mutation('regenerate', item)), error => {
      assert.equal(error.message, 'webhook_outcome_unknown'); assert.doesNotMatch(error.stack, new RegExp(secret + '|' + token)); return true
    })
    assert.equal(calls.filter(c => c.init.method !== 'GET').length, before + 1)
  }
})

test('stalled response readers abort and cancel without awaiting a hung cancellation', async () => {
  const { run, context, state } = server()
  const item = (await run({ action: 'list', route })).list[0]
  const controller = new AbortController(); context.signal = controller.signal
  let cancelled = 0
  state.response = () => {
    setTimeout(() => controller.abort(), 10)
    return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancelled++; return new Promise(() => {}) } }) } }
  }
  await assert.rejects(run(mutation('test', item)), /webhook_outcome_unknown/)
  assert.equal(cancelled, 1)
})

test('Go Unicode name trimming and signed int64 boundaries match official contracts', async () => {
  const { run, state, calls } = server()
  const item = (await run({ action: 'list', route })).list[0]
  await run({ action: 'create', route, changes: { name: '\u0085 Name \u0085' } })
  assert.equal(JSON.parse(calls.at(-1).init.body).name, 'Name')
  await run({ action: 'create', route, changes: { name: '\ufeffName\ufeff' } })
  assert.equal(JSON.parse(calls.at(-1).init.body).name, '\ufeffName\ufeff')
  for (const value of ['-1', '9223372036854775808', '1e19', 'null', 'true', '1.5']) {
    state.response = () => new Response('{"status":0,"message_id":' + value + '}')
    await assert.rejects(run(mutation('test', item)), /webhook_outcome_unknown/)
  }
  state.response = () => Response.json({ status: 0, message_id: 0 })
  assert.deepEqual((await run(mutation('test', item))).test, { message_id: '0' })
})

async function fixture(t, active = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-webhook-'))
  const secrets = new Map(), logs = [], upstream = server()
  const accounts = new Accounts({ logger: () => ({ info: (...args) => logs.push(args), error: (...args) => logs.push(args) }),
    get: name => name === 'credentials' ? { set: async (key, value) => secrets.set(key, value),
      resolve: async key => ({ value: secrets.get(key) }), unset: async key => secrets.delete(key) }
      : name === 'permissionPresets' ? { names: ['ask'] } : undefined,
  }, { apiBase: upstream.context.apiBase, stateDir: root, cwd: root, hostPermissions: ['ask'] }, { env: {}, fetchImpl: upstream.context.fetchImpl })
  const started = Promise.withResolvers()
  if (active) {
    t.mock.method(Worker.prototype, 'run', async function (signal) {
      this.config.ownerUid = ownerUid
      this.intakeSignal = signal
      started.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    })
  } else accounts.start = runtime => { runtime.status = 'disabled' }
  t.after(async () => {
    await accounts.dispose()
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith('dsh-octo-webhook-'))
    rmSync(root, { recursive: true, force: true })
  })
  await accounts.initialize()
  const saved = await accounts.save(null, { revision: accounts.revision, account: { token, label: 'Synthetic', cwd: root, enabled: active,
    ...(active && { permission: 'ask', groupCommands: 'safe' }) } })
  const runtime = accounts.runtimes.get(saved.accountId)
  if (active) {
    await started.promise
    await accounts.saveRules(saved.accountId, { revision: runtime.settings.revision(),
      settings: { allowedGroupIds: [route.address], allowedThreadIds: [threadRoute.address] } })
  }
  upstream.calls.length = 0
  return { accounts, id: saved.accountId, runtime, root, secrets, logs, ...upstream }
}

test('account management secrets are request-local, never overview, vault, disk, log or sequencing-promise results', async t => {
  const { accounts, id, root, secrets, logs, calls } = await fixture(t)
  const disk = readFileSync(join(root, 'accounts.json'), 'utf8'), vault = [...secrets]
  const result = await accounts.manageWebhooks(id, { revision: accounts.revision, action: 'create', route, changes: {} })
  assert.equal(result.secret.token, secret)
  assert.equal(await accounts.ops, undefined)
  assert.doesNotMatch(JSON.stringify(accounts.overview()), new RegExp(secret))
  assert.equal(readFileSync(join(root, 'accounts.json'), 'utf8'), disk)
  assert.deepEqual([...secrets], vault)
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret))
  const readFiles = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? readFiles(join(folder, entry.name)) : [join(folder, entry.name)])
  for (const file of readFiles(root)) assert.ok(!readFileSync(file).includes(Buffer.from(secret)), 'secret absent from persisted account/SQLite state')
  assert.ok(!calls.some(c => c.url.endsWith('/test')))
})

test('account revisions, transitions, identity switching and duplicate submits isolate accounts', async t => {
  const { accounts, id, calls, state } = await fixture(t)
  const input = { revision: accounts.revision, action: 'create', route, changes: {} }
  await assert.rejects(accounts.manageWebhooks(id, { ...input, revision: 'stale' }), /account_changed/)
  await assert.rejects(accounts.manageWebhooks('missing', input), /account_not_found/)
  accounts.runtimes.get(id).changing = true
  await assert.rejects(accounts.manageWebhooks(id, input), /account_transition/)
  accounts.runtimes.get(id).changing = false
  assert.equal(calls.length, 0)
  state.botUid = 'second-bot'
  await assert.rejects(accounts.manageWebhooks(id, input), /bot_identity_mismatch/)
  assert.equal(calls.length, 1)
  state.botUid = null
  const both = await Promise.allSettled([accounts.manageWebhooks(id, input), accounts.manageWebhooks(id, input)])
  assert.equal(both[0].status, 'fulfilled'); assert.equal(both[1].reason.message, 'account_changed')
  assert.equal(calls.filter(c => c.url.endsWith('/incoming-webhooks') && c.init.method === 'POST').length, 1)
})

function web(accounts, rejection = req => req.headers.authorization === 'fixture-manager-session' ? undefined : 401) {
  let handler
  registerWeb({ get: () => ({ requestRejection: rejection }), webServer: { register(route) { handler = route.handler } } }, accounts)
  return async ({ id = 'legacy', method = 'POST', headers = {}, body = {}, suffix = '/webhooks', raw, url } = {}) => {
    const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))])
    Object.assign(req, { method, url: url ?? '/api/dsh-channel-octo/accounts/' + id + suffix,
      headers: { authorization: 'fixture-manager-session', 'content-type': 'application/json', 'x-dsh-octo-client': '1', ...headers } })
    let status, responseHeaders, data
    await handler(req, { writeHead(code, fields) { status = code; responseHeaders = fields },
      end(value) { data = responseHeaders['Content-Type'].startsWith('application/javascript') ? value : JSON.parse(value) } })
    return { status, headers: responseHeaders, data }
  }
}

test('HTTP DSH authentication, CSRF, version, no-store and LAN-browser access protect secret actions', async t => {
  const { accounts, id, calls } = await fixture(t)
  const invoke = web(accounts), body = { revision: accounts.revision, action: 'create', route, changes: {} }
  for (const headers of [{ authorization: '' }, { authorization: 'other' }]) assert.equal((await invoke({ id, body, headers })).status, 401)
  for (const headers of [{ 'x-dsh-octo-client': '' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await invoke({ id, body, headers })).status, 403)
  }
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await invoke({ id, body, method })).status, 404)
  assert.equal((await invoke({ id, body: { ...body, revision: 'old' } })).status, 409)
  assert.equal((await invoke({ id, raw: '{bad' })).status, 400)
  assert.equal((await invoke({ id, raw: 'x'.repeat(16385) })).status, 400)
  assert.equal((await web(accounts, null)({ id, body })).status, 503)
  assert.equal(calls.length, 0)
  const result = await invoke({ id, body, headers: { host: '192.168.10.1:8787', origin: 'http://192.168.10.1:8787', 'sec-fetch-site': 'same-origin' } })
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.data.secret.token, secret)
})

test('HTTP rechecks session revocation before releasing a newly created secret', async t => {
  const { accounts, id } = await fixture(t)
  let checks = 0
  const response = await web(accounts, () => ++checks === 1 ? undefined : 401)({ id,
    body: { revision: accounts.revision, action: 'create', route, changes: {} } })
  assert.equal(response.status, 401)
  assert.doesNotMatch(JSON.stringify(response), new RegExp(secret))
})

function chatMessage(target = route, command = { kind: 'request', action: 'create', name: 'CI fixture' }) {
  return { sender: ownerUid, channelType: target.type, channelId: target.address, ambient: false,
    webhookSentAt: Math.floor(Date.now() / 1000), webhookChat: command }
}

test('the real Accounts host and authenticated HTTP route hand off chat creation and rotation once', async t => {
  const { accounts, id, runtime, root, secrets, logs, calls } = await fixture(t, true)
  const disk = readFileSync(join(root, 'accounts.json'), 'utf8'), vault = [...secrets]
  const invoke = web(accounts)
  const { worker, store } = runtime
  const propose = message => worker.proposeWebhookChat(message, new AbortController().signal)
  const send = (action, fields = {}, options = {}) => invoke({ id, body: { revision: accounts.revision, action, ...fields }, ...options })
  const writes = () => calls.filter(c => c.init.method === 'POST' && c.url.includes('/incoming-webhooks'))
  const hidden = data => assert.doesNotMatch(JSON.stringify(data), new RegExp(secret + '|/v1/incoming-webhooks/'))
  assert.deepEqual(await propose({ ...chatMessage(), sender: 'not-the-owner' }), { status: 'ignored' })
  assert.equal(calls.length, 0)
  let seq = 0
  const inbound = (target, content) => {
    const messageId = String(++seq)
    return admit({ message: { message_id: messageId, message_seq: seq, from_uid: ownerUid, channel_id: target.address,
      channel_type: target.type, timestamp: Math.floor(Date.now() / 1000), payload: { type: 1, content, mention: { uids: [botUid] } } } }, worker.config)
  }
  const recovered = inbound(route, '/webhook create Recovered fixture')
  assert.equal(worker.acceptInbound('history:' + recovered.messageId, recovered, { historical: true }), true)
  assert.deepEqual((await send('chat_pending')).data.proposals, [])
  assert.equal(inbound(route, '/webhook create ' + secret), undefined)
  for (const target of [route, threadRoute]) {
    const rotation = target.type === 5
    const command = rotation ? '/webhook rotate ' + hookId : '/webhook create CI fixture'
    const message = inbound(target, command)
    assert.equal(message.text, '')
    worker.inbox.receive('ws:' + message.messageId, message)
    worker.inbox.receive('duplicate:' + message.messageId, message)
    await Promise.all([...worker.stopControls])
    const stored = store.db.prepare('SELECT input, state FROM jobs WHERE message_id = ?').get(message.messageId)
    assert.equal(stored.input, '')
    assert.equal(stored.state, 'ignored')
    const receipts = calls.filter(call => call.url.endsWith('/v1/bot/sendMessage'))
    assert.equal(receipts.length, Number(rotation) + 1)
    assert.deepEqual(JSON.parse(receipts.at(-1).init.body), { channel_id: target.address, channel_type: target.type,
      payload: { type: 1, content: webhookChatReceipt } })
    const list = await send('chat_pending')
    assert.equal(list.status, 200)
    assert.equal(list.data.accountId, id)
    assert.equal(list.data.proposals.length, 1)
    const [proposal] = list.data.proposals
    assert.deepEqual(proposal.route, target)
    hidden(list.data)
    const fields = { proposalId: proposal.id, confirmed: true }
    await assert.rejects(accounts.manageWebhooks(id, { revision: accounts.revision, action: 'chat_approve', ...fields }),
      { message: 'webhook_proposal_unavailable' })
    assert.equal((await send('chat_approve', fields, { headers: { authorization: '' } })).status, 401)
    assert.equal((await send('chat_approve', fields, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal(writes().length, Number(rotation))
    const revision = accounts.revision
    const both = await Promise.all([send('chat_approve', fields), send('chat_approve', fields)])
    assert.deepEqual(both.map(response => response.status).sort(), [200, 409])
    const issued = both.find(response => response.status === 200)
    assert.equal(issued.headers['Cache-Control'], 'no-store')
    assert.equal(issued.data.secret.token, secret)
    assert.equal(issued.data.accountRevision, accounts.revision)
    assert.notEqual(issued.data.accountRevision, revision)
    assert.equal(writes().length, Number(rotation) + 1)
    assert.equal(writes().at(-1).url, 'https://octo.invalid/api' + (rotation
      ? '/v1/bot/groups/' + group + '/threads/' + thread + '/incoming-webhooks/' + hookId + '/regenerate' : path))
    hidden(both.find(response => response.status === 409))
  }
  hidden((await invoke({ method: 'GET', url: '/api/dsh-channel-octo' })).data)
  hidden(logs)
  assert.equal(await accounts.ops, undefined)
  assert.equal(readFileSync(join(root, 'accounts.json'), 'utf8'), disk)
  assert.deepEqual([...secrets], vault)
})

test('chat confirmation rechecks the web session at submission and disclosure; unknown writes invalidate pending approval', async t => {
  const { accounts, id, runtime, state, calls } = await fixture(t, true)
  let signedIn = true
  const invoke = web(accounts, () => signedIn ? undefined : 401)
  const send = (action, fields = {}) => invoke({ id, body: { revision: accounts.revision, action, ...fields } })
  const queue = async () => {
    assert.deepEqual(await runtime.worker.proposeWebhookChat(chatMessage(), new AbortController().signal), { status: 'pending' })
    return { proposalId: (await send('chat_pending')).data.proposals[0].id, confirmed: true }
  }
  const writes = () => calls.filter(c => c.init.method === 'POST' && c.url.includes('/incoming-webhooks')).length
  const revokedBefore = await queue()
  const before = accounts.revision
  state.onMembers = () => { signedIn = false }
  assert.equal((await send('chat_approve', revokedBefore)).status, 401)
  assert.equal(writes(), 0)
  assert.equal(accounts.revision, before)
  state.onMembers = undefined
  signedIn = true
  assert.equal((await send('chat_approve', revokedBefore)).status, 409)
  const revokedAfter = await queue()
  state.response = () => { signedIn = false; return Response.json(created(hook())) }
  const withheld = await send('chat_approve', revokedAfter)
  assert.equal(withheld.status, 401)
  assert.doesNotMatch(JSON.stringify(withheld), new RegExp(secret))
  assert.equal(writes(), 1)
  assert.notEqual(accounts.revision, before)
  signedIn = true
  assert.equal((await send('chat_approve', revokedAfter)).status, 409)
  const oldRules = await queue()
  await accounts.saveRules(id, { revision: runtime.settings.revision(), settings: { mentionPolicy: 'required' } })
  assert.equal((await send('chat_approve', oldRules)).status, 409)
  assert.equal(writes(), 1)
  const stale = await queue()
  const revision = accounts.revision
  state.response = () => { throw new Error(secret) }
  const unknown = await send('create', { route, changes: {} })
  assert.deepEqual(unknown.data, { error: 'webhook_outcome_unknown' })
  assert.notEqual(accounts.revision, revision)
  assert.equal((await send('chat_approve', stale)).status, 409)
  assert.equal(writes(), 2)
})

test('the authenticated account asset graph includes the versioned chat review module', async () => {
  const root = '/api/dsh-channel-octo'
  const invoke = web({ overview: () => ({}) })
  const get = (suffix = '', headers) => invoke({ method: 'GET', url: root + suffix, headers })
  const overview = await get()
  const version = overview.data.accountUiVersion
  assert.match(version, /^[a-f0-9]{16}$/)
  const account = await get('/account-view.js?v=' + version)
  assert.ok(account.data.includes("'./webhook-view.js?v=" + version + "'"))
  const webhook = await get('/webhook-view.js?v=' + version)
  assert.ok(webhook.data.includes("'./webhook-chat-view.js?v=" + version + "'"))
  const chat = await get('/webhook-chat-view.js?v=' + version)
  assert.equal(chat.status, 200)
  assert.match(chat.headers['Content-Type'], /^application\/javascript/)
  assert.equal(chat.headers['Cache-Control'], 'no-store')
  assert.equal(chat.headers['X-Content-Type-Options'], 'nosniff')
  assert.match(chat.data, /export function createWebhookChatView/)
  assert.equal((await get('/webhook-chat-view.js', { authorization: '' })).status, 401)
})

test('account settings wiring sends current account/version and never publishes secret results to the shared snapshot', async () => {
  const slots = [], requests = [], published = []
  let index = 0, refreshed = 0
  const React = {
    useEffect() {}, useId: () => 'fixture',
    useState(initial) { const key = index++; if (!(key in slots)) slots[key] = initial; return [slots[key], next => { slots[key] = next }] },
    useRef(current) { const key = index++; return slots[key] ??= { current } },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  }
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : []
  const View = createAccountView(React, { Button: 'button', Switch: 'switch' }, { status() {}, label() {},
    request: async (url, options) => { requests.push({ url, options }); return { accountId: 'legacy', accountRevision: 'new-revision', secret: created(hook()), webhook: hook() } },
  })
  const account = { id: 'legacy', label: 'Synthetic', config: {}, enabled: false }
  const props = { data: { accounts: [account], canManage: true, accountRevision: 'original' }, lang: 'en',
    choose() {}, publish: result => published.push(result), refresh: () => refreshed++ }
  const render = () => { index = 0; return View(props) }
  nodes(render()).find(node => node.type === 'button' && node.children.includes('Settings')).props.onClick()
  const modal = nodes(render()).find(node => node.type?.name === 'Modal')
  slots.length = 0; index = 0
  const tree = modal.type(modal.props)
  const widget = nodes(tree).find(node => node.type?.name === 'WebhookView')
  assert.ok(widget)
  const signal = new AbortController().signal
  const result = await widget.props.perform({ action: 'create', route, changes: {} }, signal)
  assert.equal(result.secret.token, secret)
  await widget.props.perform({ action: 'list', route }, signal)
  assert.equal(requests[0].url, '/accounts/legacy/webhooks')
  assert.equal(JSON.parse(requests[0].options.body).revision, 'original')
  assert.equal(JSON.parse(requests[1].options.body).revision, 'new-revision')
  assert.equal(requests[0].options.signal, signal)
  assert.deepEqual(requests[0].options.headers, { 'Content-Type': 'application/json', 'x-dsh-octo-client': '1' })
  assert.deepEqual(published, [])
  assert.equal(refreshed, 2)
})
