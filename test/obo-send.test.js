import test from 'node:test'
import assert from 'node:assert/strict'
import { createOboSend, OBO_SEND_CONTRACT } from '../src/obo-send.js'
import { readApiError } from '../src/api-errors.js'
import { readJson } from '../src/octo.js'

const human = 'human_1', bot = 'bot_1', space = 'space_1'
const group = '2'.repeat(32), short = '1234567890123456789', thread = group + '____' + short
const originId = '9007199254741991', receiptId = '9007199254741999'
const sendPath = '/v1/bot/sendMessage', grantPath = '/v1/bot/obo-grant', groupPath = '/v1/bot/groups/' + group
const dmPath = '/v1/bot/messages/person/' + human + '/' + originId
const action = { channel_type: 2, channel_id: group, text: 'First line\n第二行' }
const threadAction = { ...action, channel_type: 5, channel_id: thread }
const ack = { message_id: receiptId, message_seq: 42, client_msg_no: 'server-number' }
const allow = review => ({ id: review.id, operatorUid: review.operatorUid, decision: 'allow' })
const official = (status, suffix, semanticStatus = status) => readApiError(new Response(JSON.stringify({
  status, error: { code: 'err.server.bot_api.' + suffix, http_status: semanticStatus },
}), { status }))

function fixture(overrides = {}) {
  const lifetime = new AbortController()
  const calls = [], reviews = []
  const config = { token: 'bf_synthetic', botUid: bot, spaceId: space,
    senderPolicy: 'allowlist', allowed: new Set([human]), channelPolicy: 'allowlist',
    groups: new Set([group]), threads: new Set([thread]), toolPermission: 'workspace-write' }
  const origin = { sender: human, channel_type: 1, channel_id: human, message_id: originId, message_seq: 17 }
  const fx = { config, origin, calls, reviews, lifetime, active: true,
    source: { message_id: originId, message_seq: 17, from_uid: human, channel_type: 1, channel_id: bot + '@' + human,
      payload: { type: 1, content: 'Synthetic initiating message', space_id: space } },
    grant: { grantor_uid: human, active: true, global_enabled: true, persona_prompt: 'never shown to model or approver' },
    groups: [{ group_no: group, space_id: space }],
    group: { group_no: group, status: 1 },
    roster: [{ uid: human, robot: 0 }, { uid: bot, robot: 1 }],
    thread: { group_no: group, short_id: short, channel_id: thread, channel_type: 5, status: 1 },
    subscribers: [{ uid: human }, { uid: bot }],
    approve: allow, ...overrides }
  let posted
  const request = async (path, encoded, signal, options) => {
    const body = encoded === undefined ? undefined : JSON.parse(encoded)
    calls.push({ path, method: options.method, body, approved: reviews.length })
    if (fx.intercept) {
      const value = await fx.intercept(path, body, signal)
      if (value !== undefined) return value
    }
    if (path === '/v1/bot/users/batch') {
      assert.deepEqual(body, { uids: [human] })
      return { users: [{ uid: human, status: 1, robot: 0 }], missing_uids: [] }
    }
    if (path === dmPath) return fx.source
    if (path === '/v1/bot/groups?space_id=' + space) return fx.groups
    if (path === groupPath) return fx.group
    if (path === groupPath + '/members') return fx.roster
    if (path === groupPath + '/threads/' + short) return fx.thread
    if (path === groupPath + '/threads/' + short + '/members') return fx.subscribers
    if (path === grantPath) return fx.grant
    if (path === sendPath) {
      posted = body
      // Same lossless decoding used by the authenticated production transport.
      return readJson('{"message_id":' + receiptId + ',"message_seq":42,"client_msg_no":"server-number"}')
    }
    assert.equal(path, groupPath + (posted?.channel_type === 5 ? '/threads/' + short : '') + '/messages/' + receiptId)
    return { ...ack, channel_type: posted.channel_type, channel_id: posted.channel_id, from_uid: human,
      payload: { ...posted.payload, __obo_processed__: true, actual_sender_uid: bot } }
  }
  fx.send = createOboSend({ config: fx.config, origin: fx.origin, request,
    isActive: () => fx.active, authorize: async () => fx.active,
    confirm: async (review, signal) => { reviews.push(review); return fx.approve(review, signal) },
    verifiedContract: 'verifiedContract' in overrides ? overrides.verifiedContract : OBO_SEND_CONTRACT,
    signal: lifetime.signal })
  fx.posts = () => calls.filter(call => call.path === sendPath)
  return fx
}

test('a verified human approves exact group and thread sends, each with a fresh grant and attributed receipt', async () => {
  for (const args of [action, threadAction]) {
    const f = fixture()
    const supplied = { ...args }
    f.approve = review => {
      assert.equal(Object.isFrozen(review), true)
      assert.equal(Object.isFrozen(review.destination), true)
      assert.deepEqual(review, { id: review.id, operatorUid: human, botUid: bot, spaceId: space,
        originMessageId: originId, destination: { channel_id: args.channel_id, channel_type: args.channel_type }, text: args.text })
      supplied.text = 'different model text after the review was generated'
      return allow(review)
    }
    assert.deepEqual(await f.send(supplied), { ok: true, status: 'confirmed', message_id: receiptId,
      message_seq: 42, from_uid: human, actual_sender_uid: bot, retry_safe: false })
    assert.deepEqual(f.posts(), [{ path: sendPath, method: 'POST', approved: 1, body: {
      channel_id: args.channel_id, channel_type: args.channel_type, on_behalf_of: human,
      payload: { type: 1, content: args.text },
    } }])
    assert.equal(f.calls.at(-3).path, grantPath)
    assert.equal(f.calls.at(-3).approved, 1)
    assert.equal(f.calls.filter(call => call.path === dmPath).length, 2)
    assert.deepEqual(f.calls.filter(call => call.path === grantPath).map(call => call.approved), [0, 1])
    assert.equal(f.calls.at(-1).method, 'GET')
  }
})

test('unknown contract, non-Bot credentials, and unbound origin cannot make requests', async () => {
  for (const [opts, reason] of [
    [{ verifiedContract: undefined }, 'server_contract_unverified'],
    [{ config: { token: 'uk_synthetic', botUid: bot, spaceId: space } }, 'verified_user_bot_required'],
    [{ config: { token: 'app_synthetic', botKind: 'app', botUid: bot, spaceId: space } }, 'verified_user_bot_required'],
    [{ origin: { sender: human, channel_type: 1, channel_id: 'different_human', message_id: originId, message_seq: 17 } },
      'verified_human_dm_required'],
  ]) {
    const f = fixture(opts)
    assert.equal((await f.send(action)).reason, reason)
    assert.equal(f.calls.length, 0)
  }
})

test('blocks supplied identity or consent, DM, aliases, unlisted targets and ambiguous text before approval', async () => {
  const f = fixture()
  for (const [args, reason] of [
    [{ ...action, on_behalf_of: human }, 'invalid_arguments'],
    [{ ...action, confirm: true }, 'invalid_arguments'],
    [{ ...action, channel_type: 1, channel_id: human }, 'unsupported_destination'],
    [{ ...action, channel_type: 1, channel_id: 'other_human' }, 'unsupported_destination'],
    [{ ...action, channel_id: group + '@alias' }, 'unsupported_destination'],
    [{ ...action, channel_id: '3'.repeat(32) }, 'destination_not_allowed'],
    [{ ...threadAction, channel_id: thread + '____1234' }, 'unsupported_destination'],
    [{ ...action, text: 'visible\u202ehidden' }, 'invalid_text'],
    [{ ...action, text: 'a'.repeat(601) }, 'invalid_text'],
  ]) assert.equal((await f.send(args)).reason, reason)
  assert.equal(f.calls.length, 0)
  assert.equal(f.reviews.length, 0)
})

test('OBO fan-out, impersonated initiating messages and unverified Space cannot obtain approval', async () => {
  for (const change of [
    { actual_sender_uid: 'different_bot', __obo_processed__: true },
    { obo_fanout: true }, { space_id: 'foreign_space' }, { space_id: undefined },
  ]) {
    const f = fixture()
    Object.assign(f.source.payload, change)
    assert.equal((await f.send(action)).reason, 'human_origin_unverified')
    assert.equal(f.reviews.length, 0)
  }
  const f = fixture({ intercept: path => path === '/v1/bot/users/batch'
    ? { users: [{ uid: human, robot: 1, status: 1 }], missing_uids: [] } : undefined })
  assert.equal((await f.send(action)).reason, 'human_identity_unverified')
  assert.equal(f.reviews.length, 0)
})

test('only a fresh approval from the initiating operator permits a send', async () => {
  const f = fixture()
  for (const [approve, reason] of [
    [() => true, 'approval_unverified'],
    [review => ({ ...allow(review), operatorUid: 'other_operator' }), 'approval_unverified'],
    [review => ({ ...allow(review), id: f.reviews[0].id }), 'approval_unverified'],
    [review => ({ ...allow(review), decision: 'deny' }), 'approval_denied'],
    [review => ({ ...allow(review), decision: 'cancel' }), 'approval_not_given'],
  ]) {
    f.approve = approve
    assert.equal((await f.send(action)).reason, reason)
  }
  assert.equal(f.posts().length, 0)
  assert.equal(f.calls.filter(call => call.path === grantPath).length, 5)
})

test('one approval is in flight and cancelling the run retires a late response', async () => {
  const f = fixture()
  const start = Promise.withResolvers(), finish = Promise.withResolvers()
  f.approve = review => { start.resolve(review); return finish.promise }
  const pending = f.send(action)
  const review = await Promise.race([start.promise, pending.then(outcome => assert.fail(JSON.stringify(outcome)))])
  assert.equal((await f.send(action)).reason, 'approval_pending')
  f.lifetime.abort()
  assert.equal((await pending).reason, 'approval_unavailable')
  finish.resolve(allow(review))
  assert.equal(f.posts().length, 0)
})

test('after approval rechecks Space, exact thread, memberships, and account authority', async () => {
  for (const [args, change, reason] of [
    [action, f => { f.groups[0].space_id = 'foreign_space' }, 'destination_unverified'],
    [action, f => { f.roster.pop() }, 'destination_membership_unverified'],
    [threadAction, f => { f.thread.status = 2 }, 'destination_unverified'],
    [threadAction, f => { f.subscribers.shift() }, 'destination_membership_unverified'],
    [action, f => { f.grant.active = false }, 'matching_enabled_grant_unverified'],
    [action, f => { f.config.toolPermission = 'read-only' }, 'access_changed'],
    [action, f => { f.config.token = 'bf_replaced' }, 'access_changed'],
  ]) {
    const f = fixture()
    f.approve = review => { change(f); return allow(review) }
    assert.equal((await f.send(args)).reason, reason)
    assert.equal(f.posts().length, 0)
  }
})

test('missing grant, plain 404, another grantor and disabled grant fail before dispatch', async () => {
  const grantError = await official(404, 'obo_grant_not_found')
  for (const [options, reason] of [
    [{ intercept: path => { if (path === grantPath) throw grantError } }, 'no_usable_grant'],
    [{ intercept: path => { if (path === grantPath) throw Object.assign(new Error('not found'), { status: 404 }) } },
      'grant_endpoint_unverified'],
    [{ grant: { grantor_uid: 'other', active: true, global_enabled: true } }, 'matching_enabled_grant_unverified'],
    [{ grant: { grantor_uid: human, active: true, global_enabled: false } }, 'matching_enabled_grant_unverified'],
  ]) {
    const f = fixture(options)
    assert.deepEqual(await f.send(action), { ok: false, status: 'not_sent', reason, retry_safe: false })
    assert.equal(f.posts().length, 0)
    assert.equal(f.reviews.length, 0)
  }
})

test('the send handler can reject exact scope after the matching grant read', async () => {
  const denied = await official(400, 'obo_not_authorized', 403)
  const f = fixture({ intercept: path => { if (path === sendPath) throw denied } })
  assert.deepEqual(await f.send(action), { ok: false, status: 'rejected', reason: 'grant_or_scope_denied', retry_safe: false })
  assert.equal(f.posts().length, 1)
  assert.equal(f.calls.at(-1).path, sendPath)
})

test('ambiguous transport and malformed receipts never trigger fallback or another dispatch', async () => {
  for (const [intercept, reason] of [
    [() => { throw new Error('transport timeout with private details') }, 'send_outcome_unverified'],
    [() => ({ message_id: receiptId, message_seq: 0 }), 'send_receipt_unverified'],
    [() => { throw Object.assign(new Error('untrusted error'), { officialCode: 'err.server.bot_api.obo_not_authorized' }) },
      'send_outcome_unverified'],
  ]) {
    const f = fixture({ intercept: path => path === sendPath ? intercept() : undefined })
    assert.equal((await f.send(action)).reason, reason)
    assert.equal((await f.send(action)).reason, 'previous_send_unresolved')
    assert.equal(f.posts().length, 1)
  }
})

test('a receipt survives cancellation; it does not prove which identity sent the message', async () => {
  const f = fixture()
  f.intercept = path => {
    if (path === sendPath) { f.lifetime.abort(); return ack }
  }
  assert.deepEqual(await f.send(action), { ok: false, status: 'acknowledged', reason: 'sender_unverified',
    message_id: receiptId, message_seq: 42, retry_safe: false })
  assert.equal(f.calls.at(-1).path, sendPath)
})

test('reads back the exact ID, route, body and server markers; detects a verified bot fallback', async () => {
  const readPath = groupPath + '/messages/' + receiptId
  const row = { ...ack, channel_type: 2, channel_id: group, from_uid: bot, payload: { type: 1, content: action.text } }
  const fallback = fixture({ intercept: path => path === readPath ? row : undefined })
  assert.deepEqual(await fallback.send(action), { ok: false, status: 'sender_mismatch', reason: 'sent_as_bot',
    message_id: receiptId, message_seq: 42, from_uid: bot, retry_safe: false })
  const unverified = fixture({ intercept: path => path === readPath
    ? { ...row, from_uid: human, channel_id: thread, payload: { ...row.payload, actual_sender_uid: bot } } : undefined })
  assert.equal((await unverified.send(action)).status, 'acknowledged')
  assert.equal(unverified.posts().length, 1)
})

test('readback may become visible after the receipt, without sending twice', async () => {
  let reads = 0
  const f = fixture({ intercept: path => {
    if (path === groupPath + '/messages/' + receiptId && ++reads === 1) throw new Error('not persisted yet')
  } })
  assert.equal((await f.send(action)).status, 'confirmed')
  assert.equal(reads, 2)
  assert.equal(f.posts().length, 1)
})
