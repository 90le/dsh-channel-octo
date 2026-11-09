import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelApi } from '../src/channel-api.js'
import { OctoError } from '../src/api-errors.js'

const group = '00112233445566778899aabbccddeeff'
const foreign = 'ffeeddccbbaa99887766554433221100'
const short = '123456789012345678'
const topic = group + '____' + short
const target = { channel_id: group, channel_type: 2 }
const threadTarget = { channel_id: topic, channel_type: 5 }
const dm = { channel_id: 'human', channel_type: 1 }
const sendOp = 'messages.send_target', resolveOp = 'messages.resolve_targets'
function fixture(overrides = {}) {
  const calls = [], writes = []
  const config = { botUid: 'bot', spaceId: 'space', ownerUid: 'different-owner', senderPolicy: 'octo', channelPolicy: 'joined', ...overrides }
  const state = {
    groups: [{ group_no: group, space_id: 'space' }], groupStatus: 1, threadStatus: 1,
    members: [{ uid: 'human', robot: 0, role: 0, name: '张三' }, { uid: 'bot', robot: 1, role: 0, name: 'Assistant' }],
    candidates: [{ ...target, kind: 'group', group_no: group, name: 'UNTRUSTED_NAME' },
      { ...threadTarget, kind: 'thread', group_no: group, short_id: short, name: 'UNTRUSTED_NAME' }],
    ack: { message_id: '9223372036854775807' }, principal: 'human', truncated: false,
  }
  const api = new ChannelApi({ config, request: async (path, raw, signal, options) => {
    const body = raw && JSON.parse(raw)
    const call = { path, body, signal, options }; calls.push(call)
    if (state.intercept) await state.intercept(call)
    if (path === '/v1/bot/messages/sync') {
      assert.equal(body.channel_id, 'human'); return { messages: [] }
    }
    if (path.includes('/space/principals/')) return { uid: path.includes('/human?') ? 'human' : 'bot',
      principal_type: path.includes('/human?') ? state.principal : 'user_bot' }
    if (path.startsWith('/v1/bot/resolve/targets?')) return { candidates: structuredClone(state.candidates), total: state.candidates.length, truncated: state.truncated }
    if (path === '/v1/bot/groups?space_id=space') return structuredClone(state.groups)
    if (path.endsWith('/members')) return structuredClone(state.members)
    if (path.endsWith('/threads/' + short)) return { ...threadTarget, group_no: group, short_id: short, creator_uid: 'human', status: state.threadStatus, name: 'Current topic' }
    if (path === '/v1/bot/groups/' + group) return { group_no: group, status: state.groupStatus, name: 'Current group' }
    if (path === '/v1/bot/sendMessage') {
      writes.push(call)
      if (state.sendError) throw state.sendError
      return structuredClone(state.ack)
    }
    throw Error('unexpected endpoint')
  } })
  const run = (args, op = sendOp, route = dm, sender = 'human', signal = new AbortController().signal) => api.dispatch(route, sender, op, args, signal)
  return { state, calls, writes, run, api }
}
const args = { target, text: '## 通知\n\n请查看。', confirm_send: true }
const reject = (promise, code) => assert.rejects(promise, error => error.code === code)

test('explicit group/topic sends use verified names and native mentions, without OBO or empty quotes', async () => {
  const f = fixture()
  const result = await f.run({ ...args, uids: ['human'] })
  assert.equal(result.message_id, '9223372036854775807')
  assert.equal(result.name, 'Current group')
  assert.equal(result.sent_as, 'bot')
  assert.deepEqual(Object.keys(f.writes[0].body).sort(), ['channel_id', 'channel_type', 'payload'])
  assert.equal(f.writes[0].body.payload.type, 1)
  assert.equal(f.writes[0].body.payload.reply, undefined)
  assert.match(result.text, /@张三/)
  assert.deepEqual(result.mention.uids, ['human'])
  await f.run({ ...args, target: threadTarget })
  assert.equal(f.writes[1].body.channel_id, topic)
})

test('resolver independently checks live human access, fixed Space and exact topic policy', async () => {
  const f = fixture({ channelPolicy: 'allowlist', groups: new Set(), threads: new Set([topic]) })
  f.state.candidates.push({ channel_id: foreign, channel_type: 2, kind: 'group', group_no: foreign, name: 'OTHER_SPACE_SECRET' })
  const result = await f.run({ name: 'topic' }, resolveOp)
  assert.deepEqual(result.candidates, [{ ...threadTarget, name: 'Current topic', parent_name: 'Current group' }])
  assert.equal(result.needs_choice, false)
  assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED_NAME|OTHER_SPACE_SECRET/)
  await f.run({ ...args, target: threadTarget })
  await reject(f.run(args), 'route_not_allowed')
})

test('ambiguous/truncated discovery remains a choice, never sends automatically', async () => {
  const f = fixture()
  assert.equal((await f.run({ name: 'Current' }, resolveOp)).needs_choice, true)
  f.state.candidates = [f.state.candidates[0]]; f.state.truncated = true
  const result = await f.run({ name: 'Current' }, resolveOp)
  assert.equal(result.needs_choice, true)
  assert.equal(result.truncated, true)
  assert.equal(f.writes.length, 0)
})

test('cross-route boundaries reject before writes', async t => {
  for (const [name, change, input, route, sender, code] of [
    ['shared origin', () => {}, args, target, 'human', 'private_operation_required'],
    ['other person origin', () => {}, args, dm, 'other', 'requester_not_allowed'],
    ['robot initiator', f => { f.state.principal = 'user_bot' }, args, dm, 'human', 'requester_not_allowed'],
    ['no confirmation', () => {}, { ...args, confirm_send: false }, dm, 'human', 'explicit_confirmation_required'],
    ['blank', () => {}, { ...args, text: '  ' }, dm, 'human', 'invalid_arguments'],
    ['identity override', () => {}, { ...args, on_behalf_of: 'owner' }, dm, 'human', 'invalid_arguments'],
    ['DM target', () => {}, { ...args, target: { channel_id: 'someone', channel_type: 1 } }, dm, 'human', 'invalid_arguments'],
    ['other space', f => { f.state.groups[0].space_id = 'elsewhere' }, args, dm, 'human', 'group_access_denied'],
    ['duplicate group metadata', f => { f.state.groups.push({ ...f.state.groups[0] }) }, args, dm, 'human', 'group_access_denied'],
    ['human left', f => { f.state.members = f.state.members.slice(1) }, args, dm, 'human', 'requester_not_member'],
    ['bot left', f => { f.state.members = f.state.members.slice(0, 1) }, args, dm, 'human', 'bot_not_member'],
    ['disbanded', f => { f.state.groupStatus = 2 }, args, dm, 'human', 'group_not_active'],
    ['archived topic', f => { f.state.threadStatus = 2 }, { ...args, target: threadTarget }, dm, 'human', 'thread_not_active'],
    ['unknown mention', () => {}, { ...args, uids: ['unknown'] }, dm, 'human', 'mention_not_member'],
    ['broadcast non-admin', () => {}, { ...args, all: true }, dm, 'human', 'requester_admin_required'],
    ['mixed mentions', () => {}, { ...args, all: true, uids: ['human'] }, dm, 'human', 'invalid_arguments'],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f)
    await reject(f.run(input, sendOp, route, sender), code)
    assert.equal(f.writes.length, 0)
  })
})

test('live membership loss and config revocation interrupt multi-stage authorization', async () => {
  const f = fixture()
  let reads = 0
  f.state.intercept = async call => { if (call.path.endsWith('/members') && ++reads === 2) f.state.members = f.state.members.slice(1) }
  await reject(f.run(args), 'requester_not_member'); assert.equal(f.writes.length, 0)
  const revoked = fixture()
  revoked.state.intercept = async call => { if (call.path.endsWith('/members')) revoked.api.revoke() }
  await reject(revoked.run(args), 'account_configuration_changed')
  assert.equal(revoked.writes.length, 0)
  await reject(revoked.run({ name: 'Current' }, resolveOp), 'account_configuration_changed')
})

test('final metadata awaits cannot retain stale members or broadcast authority', async t => {
  for (const selected of [target, threadTarget]) {
    for (const adminLoss of [false, true]) await t.test(selected.channel_type + ':' + adminLoss, async () => {
      const f = fixture(); f.state.members[0].role = 1
      let reads = 0
      f.state.intercept = async call => {
        if (call.path === '/v1/bot/groups/' + group && ++reads === 2) {
          if (adminLoss) f.state.members[0].role = 0
          else f.state.members = f.state.members.slice(1)
        }
      }
      await reject(f.run({ ...args, target: selected, all: adminLoss }), adminLoss ? 'requester_admin_required' : 'requester_not_member')
      assert.equal(f.writes.length, 0)
    })
  }
})

test('resolver rechecks targets after the final source DM access check', async () => {
  const f = fixture(); f.state.candidates = [f.state.candidates[0]]
  let reads = 0
  f.state.intercept = async call => {
    if (call.path === '/v1/bot/messages/sync' && ++reads === 2) f.state.members = f.state.members.slice(1)
  }
  await reject(f.run({ name: 'Current' }, resolveOp), 'requester_not_member')
  assert.equal(f.writes.length, 0)
})

test('unknown write outcomes do not become successful or get retried', async t => {
  for (const [name, setup, code] of [
    ['missing receipt', f => { f.state.ack = {} }, 'mutation_unconfirmed'],
    ['unsafe numeric receipt', f => { f.state.ack = { message_id: 9223372036854775807 } }, 'mutation_unconfirmed'],
    ['timeout', f => { f.state.sendError = Error('SECRET') }, 'mutation_unconfirmed'],
    ['denied', f => { f.state.sendError = new OctoError('http_403', 403) }, 'api_permission_denied'],
  ]) await t.test(name, async () => {
    const f = fixture(); setup(f)
    await reject(f.run(args), code)
    assert.equal(f.writes.length, 1)
  })
})

test('resolver rejects malformed IDs, duplicates, and foreign thread bindings', async t => {
  for (const transform of [
    rows => [rows[0], rows[0]],
    rows => [{ ...rows[1], group_no: foreign }],
    rows => [{ ...rows[1], short_id: '999999999999999999' }],
  ]) await t.test('invalid target', async () => {
    const f = fixture(); f.state.candidates = transform(f.state.candidates)
    await reject(f.run({ name: 'Current' }, resolveOp), 'invalid_target_response')
    assert.equal(f.writes.length, 0)
  })
})
