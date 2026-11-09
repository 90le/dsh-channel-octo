import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OctoClient } from '../src/octo.js'
import { createCard } from '../src/octo-cards.js'
import { Worker } from '../src/worker.js'
import { mountChannelTools } from '../src/channel-tools.js'

// Contract fixtures, not a second implementation of ChannelApi.
// Pinned octo-server f984d40549f66d56b1e90a048d28315eb12c92df:
//   modules/incomingwebhook/api.go:602-683,885-1027,1172-1246
//   modules/incomingwebhook/model.go:180-198; mention.go:buildMention
//   modules/bot_api/card_revision.go:26-111
// Only fetchImpl is used: no sockets, credentials, persistent store or live sends.
const G = 'c'.repeat(32), T = '23456789012345678', H = 'iwh_' + 'd'.repeat(32)
const MID = '9223372036854775806'
const GROUP = { channel_id: G, channel_type: 2 }
const TOPIC = { channel_id: G + '____' + T, channel_type: 5 }
const DM = { channel_id: 'owner', channel_type: 1 }
const ROOT = '/v1/bot/groups/' + G
const CANARY = 'SYNTHETIC_PRIVATE_FIELD'
const mutations = [
  ['webhooks.update', { webhook_id: H, enabled: false }],
  ['webhooks.delete', { webhook_id: H }],
  ['webhooks.test', { webhook_id: H, confirm_send: true }],
  ['messages.clear_card_revisions', { message_id: MID, confirm_clear: true }],
]
const signal = () => new AbortController().signal
const clean = result => assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_FIELD|adapter_examples|"token"|"urls?"/)

function fixture(route = GROUP) {
  const calls = [], writes = [], deliveries = []
  const base = ROOT + (route.channel_type === 5 ? '/threads/' + T : '')
  const hooks = base + '/incoming-webhooks'
  const readMessage = route.channel_type === 1 ? '/v1/bot/messages/person/owner/' + MID : base + '/messages/' + MID
  const config = { apiBase: 'https://mutation-regressions.invalid', token: 'bf_synthetic',
    botUid: 'bot', ownerUid: 'owner', spaceId: 'space', senderPolicy: 'octo', channelPolicy: 'joined' }
  const state = {
    members: [{ uid: 'owner', name: 'Owner', robot: 0, role: 1 },
      { uid: 'bot', name: 'Bot', robot: 1, role: 0 },
      { uid: 'human', name: 'Human', robot: 0, role: 0 },
      { uid: 'peer-bot', name: 'Peer bot', robot: 1, role: 0 }],
    hook: { webhook_id: H, group_no: G, ...(route.channel_type === 5 && { thread_short_id: T }),
      creator_uid: 'bot', name: 'Build notifications', avatar: '/private/' + CANARY,
      status: 1, allow_mention_all: 0, allow_mention_bots: 0,
      mention_uids: [], last_used_at: 0, call_count: 0, created_at: 1 },
    message: { ...route, message_id: MID, message_seq: 7, from_uid: 'bot',
      payload: createCard({ title: 'Completed report', text: 'Synthetic display card' }) },
    revisions: 3, before: undefined, reply: undefined,
  }
  config.fetchImpl = async (input, init) => {
    const url = new URL(input)
    assert.equal(url.origin, config.apiBase)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.Authorization, 'Bearer bf_synthetic')
    const call = { path: url.pathname, method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    await state.before?.(call)
    let response
    if (call.path === '/v1/bot/groups' && call.method === 'GET') {
      assert.equal(url.searchParams.get('space_id'), 'space')
      response = [{ group_no: G, space_id: 'space' }]
    } else if (call.path === ROOT + '/members' && call.method === 'GET') response = state.members
    else if (call.path === ROOT && call.method === 'GET') response = { group_no: G, name: 'Group', status: 1 }
    else if (call.path === ROOT + '/threads/' + T && call.method === 'GET') {
      response = { group_no: G, short_id: T, ...TOPIC, creator_uid: 'bot', status: 1, name: 'Topic' }
    } else if (call.path === hooks && call.method === 'GET') response = { list: [state.hook] }
    else if (call.path === readMessage && call.method === 'GET') response = state.message
    else if (call.path === '/v1/bot/messages/sync' && call.method === 'POST') response = { messages: null }
    else {
      writes.push(call)
      response = await state.reply?.(call)
      if (response === undefined) {
        if (call.path === hooks + '/' + H && call.method === 'PUT') {
          // The official DTO uses integer flags. Names are Go strings.TrimSpace;
          // U+0085 is Go whitespace but is NOT ECMAScript String.trim whitespace.
          Object.assign(state.hook, call.body)
          if (call.body.name !== undefined) state.hook.name = call.body.name.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '')
          for (const key of ['allow_mention_all', 'allow_mention_bots']) {
            if (call.body[key] !== undefined) state.hook[key] = Number(call.body[key])
          }
          response = state.hook
        } else if (call.path === hooks + '/' + H && call.method === 'DELETE') response = { status: 200 }
        else if (call.path === hooks + '/' + H + '/test' && call.method === 'POST') {
          assert.equal(call.body, undefined, 'the server test route accepts no custom push payload')
          // testPush uses stored configuration, filters departed members, permits
          // targeted bot UIDs, and suppresses broadcasts even when flags are on.
          deliveries.push({ ...route, from_uid: H, mention: {
            uids: state.hook.mention_uids.filter(uid => state.members.some(row => row.uid === uid)),
          } })
          return new Response('{"status":0,"message_id":9223372036854775806}')
        } else if (call.path === '/v1/bot/message/card/revisions/clear' && call.method === 'POST') {
          response = { cleared: state.revisions }
          state.revisions = 0
        } else assert.fail('Unexpected hermetic API request: ' + call.method + ' ' + call.path)
      }
    }
    return response instanceof Response ? response : Response.json(response)
  }
  const api = new OctoClient(config)
  return { api, config, state, calls, writes, deliveries, hooks, readMessage,
    run: (operation, args, who = 'owner', abort = signal()) => api.channel.dispatch(route, who, operation, args, abort) }
}

test('webhook management separates human administrator, bot creator and bot_admin', async t => {
  for (const [operation, args] of mutations.slice(0, 3)) {
    for (const scenario of ['human-member', 'robot-requester', 'bot-admin-only', 'bot-manager', 'departed-creator']) {
      await t.test(operation + ': ' + scenario, async () => {
        const f = fixture()
        if (scenario === 'human-member') f.state.members[0].role = 0
        if (scenario === 'robot-requester') f.state.members[0].robot = 1
        if (scenario === 'bot-admin-only') {
          f.state.hook.creator_uid = 'human'
          f.state.members[1].bot_admin = 1
        }
        if (scenario === 'bot-manager' || scenario === 'departed-creator') {
          f.state.members[1].role = 2
          f.state.hook.creator_uid = scenario === 'departed-creator' ? 'departed' : 'human'
        }
        if (scenario === 'departed-creator' && operation === 'webhooks.test') {
          // The server rejects creator departure atomically. This is an ordinary
          // HTTP 409 fixture, deliberately not the other agent's wire400 cases.
          f.state.reply = () => Response.json({ error: { code: 'err.server.incomingwebhook.mgmt_creator_left',
            http_status: 409 }, status: 409 }, { status: 409 })
          await assert.rejects(f.run(operation, args))
          assert.equal(f.writes.length, 1)
        } else if (['bot-manager', 'departed-creator'].includes(scenario)) {
          clean(await f.run(operation, args))
          assert.equal(f.writes.length, 1)
        } else {
          await assert.rejects(f.run(operation, args))
          assert.equal(f.writes.length, 0)
        }
      })
    }
  }
})

test('disabled webhook test really sends targeted human/bot mentions in the exact route, never broadcasts', async () => {
  for (const route of [GROUP, TOPIC]) {
    const f = fixture(route)
    Object.assign(f.state.hook, { status: 0, allow_mention_all: 1, allow_mention_bots: 1,
      mention_uids: ['human', 'peer-bot', 'departed'] })
    const receipt = await f.run('webhooks.test', { webhook_id: H, confirm_send: true })
    assert.equal(receipt.message_id, MID, 'int64 receipt must survive the actual HTTP JSON decoder')
    assert.equal(receipt.broadcast, false)
    assert.equal(receipt.sent, true)
    assert.deepEqual(f.deliveries, [{ ...route, from_uid: H, mention: { uids: ['human', 'peer-bot'] } }])
    assert.deepEqual(f.writes, [{ path: f.hooks + '/' + H + '/test', method: 'POST', body: undefined }])
    assert.equal(f.state.hook.status, 0, 'test must not silently enable a disabled public webhook')
    clean(receipt)
  }
})

test('parent and sibling topic webhooks cannot be mutated through the current topic', async () => {
  for (const [operation, args] of mutations.slice(0, 3)) {
    for (const other of ['', '34567890123456789']) {
      const f = fixture(TOPIC)
      f.state.hook.thread_short_id = other
      await assert.rejects(f.run(operation, args))
      assert.equal(f.writes.length, 0)
    }
  }
})

test('webhook test zero receipt is unconfirmed and never retried despite possible delivery', async () => {
  const f = fixture()
  f.state.reply = () => new Response('{"status":0,"message_id":0,"url":"' + CANARY + '"}')
  await assert.rejects(f.run('webhooks.test', { webhook_id: H, confirm_send: true }), error => {
    clean({ message: error.message, code: error.code })
    return error.code === 'mutation_unconfirmed'
  })
  assert.equal(f.writes.length, 1)
})

test('update confirmation must reject a duplicate recipient replacing another requested UID', async () => {
  const f = fixture()
  f.state.reply = () => ({ ...f.state.hook, mention_uids: ['human', 'human'] })
  const outcome = await f.run('webhooks.update', { webhook_id: H, mention_uids: ['human', 'peer-bot'] })
    .then(value => ({ value }), error => ({ error }))
  assert.equal(f.writes.length, 1)
  assert.equal(outcome.error?.code, 'mutation_unconfirmed',
    'a same-length duplicate array is not acknowledgement of both requested recipients')
})

test('a successful Go-normalized webhook name is not reported as an uncertain write', async () => {
  const f = fixture()
  const receipt = await f.run('webhooks.update', { webhook_id: H, name: '\u0085Build\u0085' })
  assert.equal(f.writes.length, 1)
  assert.equal(receipt.webhook.name, 'Build')
})

test('successful mutation receipts discard nested credential material', async () => {
  for (const [operation, args] of mutations) {
    const f = fixture()
    f.state.reply = call => ({
      ...(operation === 'webhooks.update' ? { ...f.state.hook, status: call.body.status }
        : operation === 'webhooks.delete' ? { status: 200 }
          : operation === 'webhooks.test' ? { status: 0, message_id: MID } : { cleared: 0 }),
      token: CANARY, url: '/' + CANARY, urls: { native: '/' + CANARY },
      adapter_examples: [{ url: CANARY, auth: { value_source: CANARY } }],
    })
    clean(await f.run(operation, args))
    assert.equal(f.writes.length, 1)
  }
})

test('clear rejects pending display frames in original and effective content, including encoded legacy frames', async t => {
  const managed = [
    ['question', createCard({ title: 'DSH 等待你的回答（1/2）', text: 'Choose a value' })],
    ['approval', createCard({ title: 'DSH 等待你的批准', text: 'Review the operation' })],
    ['progress', createCard({ title: 'DSH 回复进度', text: 'Waiting for approval' })],
    ['question receipt', createCard({ title: 'DSH 提问回执', text: 'The turn is continuing' })],
    ['interactive form', createCard({ title: 'Pending form', actions: [{ id: 'accept', label: 'Accept' }] })],
    ['Registry', { type: 17, profile: 'octo/v1', template_ref: { id: 'ai.reasoning-process', version: '0.4.1' },
      state: 'reasoning', data: { title: 'Processing' } }],
  ]
  for (const [name, payload] of managed) {
    for (const representation of ['original', 'base64', 'effective']) {
      await t.test(name + ': ' + representation, async () => {
        const f = fixture()
        if (representation === 'effective') f.state.message.message_extra = { content_edit: JSON.stringify(payload) }
        else f.state.message.payload = representation === 'base64'
          ? Buffer.from(JSON.stringify(payload)).toString('base64') : payload
        await assert.rejects(f.run(...mutations[3]))
        assert.equal(f.writes.length, 0)
      })
    }
  }
})

test('revocation exposed by the second message read stops revision erasure', async () => {
  for (const marker of ['revoke', 'is_mutual_deleted']) {
    const f = fixture()
    let reads = 0
    f.state.before = call => {
      if (call.path === f.readMessage && ++reads === 2) f.state.message.message_extra = { [marker]: 1 }
    }
    await assert.rejects(f.run(...mutations[3]))
    assert.equal(f.writes.length, 0)
  }
})

test('verified owner revocation during the final access await prevents card-history deletion', async t => {
  for (const route of [DM, GROUP, TOPIC]) {
    await t.test('channel type ' + route.channel_type, async () => {
      const f = fixture(route)
      let reads = 0, revoked = false
      f.state.before = call => {
        if (call.path === f.readMessage) reads++
        if (reads === 2 && call.path === (route.channel_type === 1 ? '/v1/bot/messages/sync' : ROOT)) {
          f.config.ownerUid = 'replacement-owner'
          revoked = true
        }
      }
      const outcome = await f.run(...mutations[3]).then(value => ({ value }), error => ({ error }))
      assert.equal(revoked, true, 'exercise the final await after the last card read')
      assert.equal(f.writes.length, 0, 'the current requester no longer owns the bot when the clear is sent')
      assert.ok(outcome.error)
    })
  }
})

test('repeated explicit clear accepts zero and leaves the current card untouched in owner DM', async () => {
  const f = fixture(DM), original = structuredClone(f.state.message)
  const first = await f.run(...mutations[3]), second = await f.run(...mutations[3])
  assert.equal(first.cleared, 3)
  assert.equal(second.cleared, 0)
  assert.equal(f.writes.length, 2, 'two explicit calls, one POST each; no hidden retries')
  assert.deepEqual(f.state.message, original)
  for (const call of f.writes) assert.deepEqual(call.body, { ...DM, message_id: MID })
})

// Run Worker.process and the real mounting adapter, with only store/host service
// edges replaced. Unlike filtering CHANNEL_API_OPERATIONS in a test, this checks
// what the worker actually supplies to the host and its hidden-name dispatch gate.
test('read-only worker mounts reads and refuses all four new mutations even by hidden name', async () => {
  for (const route of [DM, GROUP, TOPIC]) {
    let visited = false, captured
    const dispatched = [], definitions = new Map(), state = { phase: 'queued' }
    const store = {
      running() { state.phase = 'running' }, session: () => ({ session_id: 'synthetic-session', created: false }),
      sessionCreated() {}, ready() { state.phase = 'ready' }, sending() {}, sent() { state.phase = 'sent' },
      review(_seq, reason) { state.phase = reason }, discard(_seq, reason) { state.phase = reason },
    }
    const api = { async allowsMessage() { return true }, async rules() { return [] }, async send() { return '900' },
      channel: { async members() { return [] }, async dispatch(...args) { dispatched.push(args); return {} } } }
    const config = { botUid: 'bot', ownerUid: 'owner', spaceId: 'space', toolScope: 'owner',
      toolPermission: 'read-only', senderPolicy: 'octo', channelPolicy: 'joined', allowed: new Set() }
    const scoped = {
      get: name => name === 'tools' ? { register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      } } : undefined,
      effect(factory) { const dispose = [...factory()]; return () => { for (const fn of dispose.reverse()) fn() } },
    }
    const worker = new Worker({ api, store, config, log() {}, host: {
      async run(_session, _input, created, lifetime, _rules, _stage, _timeout, _allowed, extras) {
        visited = true
        await created()
        const off = mountChannelTools(scoped, { ...extras.channelTools, signal: lifetime, isActive: () => true })
        try {
          for (const [operation, args] of mutations) {
            const name = 'octo_' + operation.replaceAll('.', '_')
            assert.equal(definitions.has(name), false, name + ' must not be in the read-only schema')
            await assert.rejects(Promise.resolve().then(() => extras.channelTools.execute(name, args, lifetime)))
          }
          assert.ok(definitions.has('octo_messages_recent'))
          assert.equal(definitions.has('octo_webhooks_list'), route.channel_type !== 1)
          await definitions.get('octo_messages_recent').execute({}, { signal: lifetime })
        } catch (error) { captured = error } finally { off() }
        return 'Synthetic completion'
      },
    } })
    await worker.process({ seq: 1, state: 'queued', sender: 'owner', channel_id: route.channel_id,
      channel_type: route.channel_type, message_id: '1', message_seq: 1, input: 'Inspect current conversation' }, signal())
    assert.equal(visited, true, 'the real worker must reach host mounting')
    if (captured) throw captured
    assert.equal(state.phase, 'sent')
    assert.equal(dispatched.length, 1)
    assert.deepEqual(dispatched[0].slice(0, 3), [route, 'owner', 'messages.recent'])
    assert.equal(definitions.size, 0)
  }
})
