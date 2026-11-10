import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { parseWebhookChatCommand, webhookChatReceipt } from '../src/webhook-chat-command.js'
import { createWebhookChat } from '../src/webhook-chat.js'
import { createWebhookChatView } from '../src/webhook-chat-view.js'
import { registerWeb } from '../src/web.js'
import { Worker } from '../src/worker.js'
import { admit } from '../src/octo.js'

const group = '00112233445566778899aabbccddeeff'
const thread = '123456789012345678'
const address = group + '____' + thread
const hookId = 'iwh_' + 'a'.repeat(32)
const setup = 'b'.repeat(64)
const url = '/v1/incoming-webhooks/' + hookId + '/' + setup
const bot = 'fixture-bot', owner = 'fixture-owner', space = 'fixture-space'
const groupPath = '/v1/bot/groups/' + group
const record = { id: 'legacy', botUid: bot, spaceId: space, enabled: true }
const config = { ...record, ownerUid: owner, groupCommands: 'safe', channelPolicy: 'joined', senderPolicy: 'octo', toolPermission: 'ask' }
const mention = { uids: [bot] }
const parse = (text, overrides = {}) => parseWebhookChatCommand(text, {
  config, sender: owner, plain: true, channelType: 2, channelId: group, mention, ...overrides,
})
const noSecret = data => assert.doesNotMatch(JSON.stringify(data), new RegExp(setup + '|/v1/incoming-webhooks/|adapter_examples'))

test('admitted live Webhook command is acknowledged once without entering the DSH job queue', async () => {
  const stored = new Set(), calls = [], sent = []
  const store = { rememberAnswer: (id, message, session) => {
    assert.equal(message.text, '')
    assert.equal(session, null)
    if (stored.has(message.messageId)) return false
    stored.add(message.messageId)
    return true
  }, add() { assert.fail('Webhook command entered the model queue') } }
  const worker = new Worker({ config: { ...config, allowed: new Set(), groups: new Set(), threads: new Set() },
    store, log() {}, api: { async send(...args) { sent.push(args.slice(0, 2)) } },
    async proposeWebhookChat(message) { calls.push(message.webhookChat); return { status: 'pending' } } })
  worker.intakeSignal = new AbortController().signal
  const command = messageId => admit({ message: {
    from_uid: owner, message_id: messageId, message_seq: Number(messageId),
    channel_type: 2, channel_id: group, timestamp: Math.floor(Date.now() / 1000),
    payload: { type: 1, content: '@Bot /webhook create Synthetic', mention, space_id: space },
  } }, worker.config)
  worker.acceptInbound('ws:1', command('1'))
  worker.acceptInbound('ws:1', command('1'))
  worker.acceptInbound('history:2', command('2'), { historical: true })
  await Promise.all(worker.stopControls)
  assert.deepEqual(calls, [{ kind: 'request', action: 'create', name: 'Synthetic' }])
  assert.deepEqual(sent, [[group, webhookChatReceipt]])
})

function fixture() {
  let timestamp = 1_800_000_000_000
  const calls = [], state = { active: true, role: 1, groupStatus: 1, threadStatus: 1, botRole: 0, creator: bot, name: 'Synthetic hook' }
  const item = extra => ({
    webhook_id: hookId, group_no: group, name: state.name, avatar: '', creator_uid: state.creator, status: 1,
    allow_mention_all: 0, allow_mention_bots: 0, mention_uids: [], last_used_at: 0, call_count: 0, created_at: 42, ...extra,
  })
  const context = { record, config, identity: { ...config }, revision: 'fixture-revision', apiBase: 'https://octo.invalid/api', token: 'bf_fixture',
    isActive: () => state.active, signal: new AbortController().signal,
    async fetchImpl(target, options) {
      const destination = new URL(target)
      assert.equal(destination.origin, 'https://octo.invalid')
      assert.equal(options.redirect, 'manual')
      assert.equal(options.cache, 'no-store')
      const path = destination.pathname.replace(/^\/api/, '')
      calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body) })
      if (path.startsWith('/v1/bot/space/principals/')) {
        assert.equal(destination.searchParams.get('space_id'), space)
        const uid = path.split('/').at(-1)
        return Response.json({ uid, principal_type: uid === bot ? 'user_bot' : state.ownerType ?? 'human' })
      }
      if (path === '/v1/bot/groups') return Response.json([{ group_no: group, name: 'Synthetic group', space_id: state.space ?? space }])
      if (path === groupPath) return Response.json({ group_no: group, status: state.groupStatus })
      if (path === groupPath + '/members') {
        await state.beforeMembers?.()
        return Response.json([{ uid: owner, robot: 0, role: state.role }, { uid: bot, robot: 1, role: state.botRole }])
      }
      const topic = path.startsWith(groupPath + '/threads/' + thread)
      if (path === groupPath + '/threads/' + thread) {
        return Response.json({ group_no: group, short_id: thread, channel_type: 5, channel_id: address, status: state.threadStatus })
      }
      const base = groupPath + (topic ? '/threads/' + thread : '') + '/incoming-webhooks'
      const row = item(topic ? { thread_short_id: thread } : {})
      if (path === base && options.method === 'GET') return Response.json({ list: state.missing ? [] : [{ ...row, token: setup, url }] })
      assert.equal(options.method, 'POST')
      assert.ok(path === base || path === base + '/' + hookId + '/regenerate')
      await state.afterWrite?.()
      if (state.fail) throw Object.assign(new Error('webhook_forbidden'), { body: setup })
      return Response.json({ ...row, token: setup, url, urls: { native: url }, adapter_examples: [] })
    },
  }
  const chat = createWebhookChat({ now: () => timestamp })
  const message = (text, topic = false) => ({ sender: owner, ambient: false, channelType: topic ? 5 : 2, channelId: topic ? address : group,
    webhookSentAt: Math.floor(timestamp / 1000), webhookChat: parse(text) })
  const propose = (text, topic = false) => chat.propose(context, message(text, topic), { live: true })
  const manage = (input, ctx = context) => chat.manage(ctx, { revision: ctx.revision, ...input })
  const pending = async ctx => (await manage({ action: 'chat_pending' }, ctx)).proposals
  const approve = (id, ctx) => manage({ action: 'chat_approve', proposalId: id, confirmed: true }, ctx)
  const writes = () => calls.filter(call => call.method !== 'GET')
  return { state, calls, context, chat, message, propose, manage, pending, approve, writes, advance: amount => { timestamp += amount } }
}

test('only a whole explicit owner command in an admitted group/topic can request a Webhook handoff', () => {
  assert.deepEqual(parse('/webhook create 发布通知'), { kind: 'request', action: 'create', name: '发布通知' })
  assert.deepEqual(parse('@[' + bot + ':Bot Name] /webhook rotate ' + hookId), { kind: 'request', action: 'regenerate', webhookId: hookId })
  assert.equal(parse('@Bot Name /webhook create a', { mention: { ...mention, entities: [{ uid: bot, offset: 0, length: 9 }] } }).kind, 'request')
  for (const text of ['@[other:Bot] /webhook create a', '/webhook create ' + setup, '/webhook create https://example.invalid' + url,
    '/webhook rotate ' + hookId + '/abc', '/webhook create ok\nmore', '/webhook create ' + '界'.repeat(22), '/webhook create x\u200d', '/webhook']) {
    assert.equal(parse(text)?.kind, 'blocked', text.slice(0, 20))
  }
  for (const override of [{ sender: 'someone-else' }, { channelType: 1 }, { plain: false }, { mention: undefined },
    { mention: { ...mention, ais: 1 } }, { mention: { uids: [bot, 'another'] } },
    { config: { ...config, groupCommands: 'off' } }, { config: { ...config, botKind: 'app' } }]) {
    assert.equal(parse('/webhook create a', override)?.kind, 'blocked')
  }
  assert.equal(parse('How do I use /webhook create?'), undefined)
  noSecret(webhookChatReceipt)
})

test('chat and pending DTOs never contain setup; private confirmation creates the exact route once with safe defaults', async () => {
  const f = fixture()
  assert.deepEqual(await f.propose('/webhook create CI Builds', true), { status: 'pending' })
  assert.deepEqual(await f.propose('/webhook create CI Builds', true), { status: 'pending' })
  assert.deepEqual(f.writes(), [])
  const previews = await f.pending()
  assert.equal(previews.length, 1)
  assert.deepEqual(previews[0].route, { type: 5, address })
  assert.equal(previews[0].name, 'CI Builds')
  noSecret(previews)
  const id = previews[0].id
  await assert.rejects(f.manage({ action: 'chat_approve', proposalId: id }), /invalid_webhook_request/)
  await assert.rejects(f.manage({ action: 'chat_approve', proposalId: id, confirmed: true, route: { type: 2, address: group } }), /invalid_webhook_request/)
  const both = await Promise.allSettled([f.approve(id), f.approve(id)])
  assert.equal(both[0].value.secret.token, setup)
  assert.equal(both[0].value.secret.url, 'https://octo.invalid/api' + url)
  assert.deepEqual(both[0].value.webhook, { webhook_id: hookId })
  assert.match(both[1].reason.message, /^webhook_proposal_unavailable$/)
  assert.deepEqual(f.writes(), [{ path: groupPath + '/threads/' + thread + '/incoming-webhooks', method: 'POST',
    body: { name: 'CI Builds', allow_mention_all: false, allow_mention_bots: false, mention_uids: [] } }])
  assert.deepEqual(await f.pending(), [])
})

test('rotation revalidates live ownership, current membership, route and exact configuration', async t => {
  const text = '/webhook rotate ' + hookId
  for (const [change, rejection] of [
    [{ role: 0 }, 'webhook_forbidden'], [{ ownerType: 'user_bot' }, 'webhook_forbidden'],
    [{ creator: 'other-person' }, 'webhook_forbidden'], [{ space: 'another-space' }, 'webhook_forbidden'],
    [{ threadStatus: 2 }, 'webhook_not_found'], [{ groupStatus: 2 }, 'webhook_forbidden'],
    [{ missing: true }, 'webhook_not_found'], [{ name: 'Changed hook' }, 'webhook_changed'],
  ]) {
    await t.test(rejection + ': ' + Object.keys(change)[0], async () => {
      const f = fixture()
      await f.propose(text, true)
      const [p] = await f.pending()
      Object.assign(f.state, change)
      await assert.rejects(f.approve(p.id), { message: rejection })
      await assert.rejects(f.approve(p.id), /webhook_proposal_unavailable/)
      assert.deepEqual(f.writes(), [])
    })
  }
  const f = fixture()
  f.state.name = setup
  await f.propose(text, true)
  const [p] = await f.pending()
  assert.equal(p.name, undefined)
  noSecret(p)
  const result = await f.approve(p.id)
  assert.equal(result.secret.token, setup)
  assert.equal(f.writes()[0].path, groupPath + '/threads/' + thread + '/incoming-webhooks/' + hookId + '/regenerate')
})

test('stale/historical inputs, account switches, revision, cancellation and expiry never write', async () => {
  const f = fixture()
  const text = '/webhook create Build'
  const m = f.message(text)
  assert.deepEqual(await f.chat.propose(f.context, m, { live: false }), { status: 'ignored' })
  assert.deepEqual(await f.chat.propose(f.context, { ...m, webhookSentAt: m.webhookSentAt - 121 }, { live: true }), { status: 'ignored' })
  assert.deepEqual(await f.chat.propose(f.context, { ...m, webhookSentAt: m.webhookSentAt + 31 }, { live: true }), { status: 'ignored' })
  assert.deepEqual(await f.chat.propose({ ...f.context, config: { ...config, toolPermission: 'read-only' } }, m, { live: true }), { status: 'ignored' })
  assert.deepEqual(await f.chat.propose({ ...f.context, apiBase: 'http://octo.invalid' }, m, { live: true }), { status: 'ignored' })
  assert.equal(f.calls.length, 0)
  await f.propose(text)
  const [p] = await f.pending()
  const second = { ...f.context, record: { ...record, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }
  assert.deepEqual(await f.pending(second), [])
  await assert.rejects(f.approve(p.id, second), /webhook_proposal_unavailable/)
  assert.deepEqual(await f.manage({ action: 'chat_cancel', proposalId: p.id }), { cancelled: true })
  await assert.rejects(f.approve(p.id), /webhook_proposal_unavailable/)
  await f.propose(text)
  const [expired] = await f.pending()
  f.advance(300_001)
  await assert.rejects(f.approve(expired.id), /webhook_proposal_unavailable/)
  await f.propose(text)
  const [old] = await f.pending()
  await assert.rejects(f.approve(old.id, { ...f.context, revision: 'next' }), /webhook_proposal_unavailable/)
  await f.propose(text)
  const [otherOwner] = await f.pending()
  await assert.rejects(f.approve(otherOwner.id, { ...f.context, identity: { ...config, ownerUid: 'new-owner' } }), /webhook_proposal_unavailable/)
  assert.deepEqual(f.writes(), [])
})

test('late revocation or expiration prevents submission; uncertain upstream writes consume the approval without leaking transport errors', async () => {
  for (const change of [f => { f.state.active = false }, f => f.advance(300_001)]) {
    const f = fixture()
    await f.propose('/webhook create Build')
    const [p] = await f.pending()
    f.state.beforeMembers = () => change(f)
    await assert.rejects(f.approve(p.id), { message: 'webhook_proposal_unavailable' })
    assert.deepEqual(f.writes(), [])
  }
  for (const afterWrite of [f => { f.state.fail = true }, f => { f.state.active = false }]) {
    const f = fixture()
    await f.propose('/webhook rotate ' + hookId)
    const [p] = await f.pending()
    f.state.afterWrite = () => afterWrite(f)
    await assert.rejects(f.approve(p.id), error => {
      assert.equal(error.message, 'webhook_outcome_unknown')
      noSecret({ ...error, stack: error.stack })
      return true
    })
    f.state.active = true
    await assert.rejects(f.approve(p.id), /webhook_proposal_unavailable/)
    assert.equal(f.writes().length, 1)
  }
})

test('integration contract: the existing authenticated no-store account endpoint is the only secret response', async () => {
  const f = fixture()
  await f.propose('/webhook create Build')
  const [p] = await f.pending()
  const action = { action: 'chat_approve', confirmed: true, proposalId: p.id }
  let handler
  registerWeb({ get: () => ({ requestRejection: req => req.headers.authorization === 'fixture' ? undefined : 401 }),
    webServer: { register: route => { handler = route.handler } } }, {
    manageWebhooks(id, input, signal) {
      assert.equal(id, 'legacy')
      return f.chat.manage({ ...f.context, signal }, input)
    },
  })
  const request = async (input, headers) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ ...input, revision: f.context.revision }))])
    Object.assign(req, { method: 'POST', url: '/api/dsh-channel-octo/accounts/legacy/webhooks',
      headers: { authorization: 'fixture', 'content-type': 'application/json', 'x-dsh-octo-client': '1', ...headers } })
    const result = {}
    await handler(req, { writeHead(status, fields) { Object.assign(result, { status, headers: fields }) }, end(data) { result.data = JSON.parse(data) } })
    return result
  }
  const unauthorized = await request(action, { authorization: '' })
  const csrf = await request(action, { 'sec-fetch-site': 'cross-site' })
  const listed = await request({ action: 'chat_pending' })
  assert.deepEqual([unauthorized.status, csrf.status, listed.status], [401, 403, 200])
  noSecret([unauthorized, csrf, listed])
  assert.deepEqual(f.writes(), [])
  const approved = await request(action)
  assert.equal(approved.headers['Cache-Control'], 'no-store')
  assert.equal(approved.data.secret.token, setup)
  const replay = await request(action)
  assert.equal(replay.status, 409)
  noSecret(replay)
  assert.equal(f.writes().length, 1)
})

test('account UI reviews the exact scope and needs a separate confirm click before forwarding to the secret display', async () => {
  const f = fixture()
  await f.propose('/webhook rotate ' + hookId, true)
  const requests = [], states = [], displayed = []
  let index = 0
  const React = { createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = initial
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }]
    } }
  const View = createWebhookChatView(React, { Button: 'button' })
  const tree = () => {
    index = 0
    return View({ lang: 'en', request: async (input, apply) => { requests.push(input); apply(await f.manage(input)) },
      onComplete: result => displayed.push(result) })
  }
  const nodes = node => node?.children ? [node, ...node.children.flatMap(nodes)] : []
  const click = label => nodes(tree()).find(node => node.type === 'button' && node.children.includes(label)).props.onClick()
  await click('Load chat requests')
  click('Review request')
  const review = JSON.stringify(tree())
  assert.ok(review.includes(address) && review.includes(hookId) && review.includes('invalidates the old push URLs'))
  noSecret(review)
  assert.deepEqual(requests.map(x => x.action), ['chat_pending'])
  assert.deepEqual(f.writes(), [])
  await click('Confirm and execute')
  assert.equal(displayed[0].secret.token, setup)
  assert.equal(f.writes().length, 1)
  noSecret(tree())
})
