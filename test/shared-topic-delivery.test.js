import test from 'node:test'
import assert from 'node:assert/strict'
import { ChannelApi, CHANNEL_API_OPERATIONS } from '../src/channel-api.js'

const group = '00112233445566778899aabbccddeeff'
const otherGroup = 'ffeeddccbbaa99887766554433221100'
const groupRoute = { channel_id: group, channel_type: 2 }
const dm = { channel_id: 'human', channel_type: 1 }
const shortA = '123456789012345678', shortB = '123456789012345679'
const topic = (short, parent = group) => ({ channel_id: parent + '____' + short, channel_type: 5 })
const source = topic(shortA), destination = topic(shortB)
const root = '/v1/bot/groups/' + group
const topicPath = short => root + '/threads/' + short
const send = '/v1/bot/sendMessage', profile = '/v1/bot/card/profile'
const textOp = 'messages.send_target', fileOp = 'messages.send_target_file', cardOp = 'messages.send_target_card'
const operations = [textOp, fileOp, cardOp]
const firstId = '9223372036854775807', secondId = '9223372036854775806'
const exactText = '## Update\n\n内容 🙂  \n'
const fileURL = 'https://uploads.example.invalid/file?signature=synthetic'
const payloadArgs = (operation, target = destination) => ({ target: { ...target }, confirm_send: true,
  ...(operation === textOp ? { text: exactText } : operation === fileOp
    ? { path: 'reports/result.pdf', caption: exactText }
    : { title: 'Update', blocks: [{ type: 'text', text: 'Ready.' }] }) })
const reject = (result, code) => assert.rejects(result, error => error.code === code)

function fixture(t, overrides = {}) {
  const calls = [], writes = [], preparations = [], uploads = [], unexpected = []
  const thread = short => ({ detail: { ...topic(short), group_no: group, short_id: short,
    creator_uid: 'human', name: short === shortA ? 'Source' : 'Destination', status: 1 },
  members: [{ uid: 'human', role: 1 }, { uid: 'bot', role: 0 }, { uid: 'recipient', role: 0 }] })
  const state = { allowed: true, groupStatus: 1, groupSpace: 'space', principal: 'human', botPrincipal: 'user_bot',
    members: [{ uid: 'human', name: 'Requester', role: 0, robot: 0 }, { uid: 'bot', name: 'Bot', role: 0, robot: 1 },
      { uid: 'recipient', name: 'Recipient', role: 0, robot: 0 }, { uid: 'parent-only', name: 'Parent Only', role: 0, robot: 0 }],
    threads: { [shortA]: thread(shortA), [shortB]: thread(shortB) },
    file: { type: 8, url: fileURL, name: 'result.pdf', size: 123 },
    acks: [{ message_id: firstId, token: 'upstream-only' }, { message_id: secondId }],
  }
  const api = new ChannelApi({ config: { botUid: 'bot', spaceId: 'space', ownerUid: 'owner',
    senderPolicy: 'octo', channelPolicy: 'joined', ...overrides }, request: async (path, raw, signal, { method }) => {
    const body = raw && JSON.parse(raw)
    const call = { path, body, method }
    calls.push(call)
    if (path === send) writes.push(body)
    await state.beforeRequest?.(call)
    if (path === '/v1/bot/messages/sync' && body?.channel_type === 1 && body?.channel_id === 'human') return { messages: [] }
    if (path === '/v1/bot/space/principals/human?space_id=space') return { uid: 'human', principal_type: state.principal }
    if (path === '/v1/bot/space/principals/bot?space_id=space') return { uid: 'bot', principal_type: state.botPrincipal }
    if (path === '/v1/bot/groups?space_id=space') return [{ group_no: group, space_id: state.groupSpace }]
    if (path === root) return { group_no: group, status: state.groupStatus, name: 'Parent' }
    if (path === root + '/members') return structuredClone(state.members)
    for (const short of [shortA, shortB]) {
      if (path === topicPath(short)) return structuredClone(state.threads[short].detail)
      if (path === topicPath(short) + '/members') return structuredClone(state.threads[short].members)
    }
    if (path === profile) return { enabled: true, card_version: '1.5', profiles: ['octo/v1'],
      config: { card_enabled: true, display_enabled: true } }
    if (path === send) return structuredClone(state.acks[writes.length - 1])
    unexpected.push(path)
    throw Error('Unexpected fixture endpoint')
  } })
  const runtime = {
    authorizeSharedSend: () => state.allowed,
    prepareFile: async (path, authorize, signal) => {
      preparations.push(path)
      await state.beforeUpload?.()
      await authorize()
      signal.throwIfAborted()
      uploads.push(path)
      await state.afterUpload?.()
      return state.file
    },
  }
  const run = (operation, { route = source, args = payloadArgs(operation), sender = 'human',
    signal, host = runtime } = {}) => api.dispatch(route, sender, operation, args, signal, host)
  t.after(() => assert.deepEqual(unexpected, [], 'only fixed synthetic endpoints are permitted'))
  return { api, state, run, runtime, calls, writes, preparations, uploads }
}

test('only the three existing target sends opt into the shared host gate', () => {
  assert.deepEqual(CHANNEL_API_OPERATIONS.filter(row => row.sharedTopicSend).map(row => row.name), operations)
  for (const spec of CHANNEL_API_OPERATIONS.filter(row => row.sharedTopicSend)) {
    assert.equal(spec.privateOnly, true)
    assert.equal(spec.mutating, true)
    assert.equal(!!spec.requiresFiles, spec.name === fileOp)
  }
})

test('main group and sibling topic send text, a native file/image with exact caption, and a display card', async t => {
  for (const route of [groupRoute, source]) for (const operation of operations) {
    await t.test(route.channel_type + '/' + operation, async t => {
      const f = fixture(t)
      if (route === groupRoute) f.state.file = { type: 2, url: fileURL, name: 'chart.png', size: 123, width: 640, height: 480 }
      const result = await f.run(operation, { route })
      assert.equal(result.ok, true)
      assert.equal(result.message_id, firstId)
      assert.equal(result.channel_id, destination.channel_id)
      assert.equal(result.channel_type, 5)
      assert.equal(result.name, 'Destination')
      assert.equal(result.parent_name, 'Parent')
      assert.equal(result.sent_as, 'bot')
      assert.equal(result.requiresFinalSummary, true)
      assert.doesNotMatch(JSON.stringify(result), /signature|upstream-only/)
      assert.equal(f.writes.length, operation === fileOp ? 2 : 1)
      for (const { payload, ...wireRoute } of f.writes) {
        assert.deepEqual(wireRoute, destination)
        assert.doesNotMatch(JSON.stringify(payload), /"(?:on_behalf_of|reply|callback|template_ref)"/)
      }
      if (operation === textOp) assert.deepEqual(f.writes[0].payload, { type: 1, content: exactText })
      if (operation === fileOp) {
        assert.deepEqual(f.uploads, ['reports/result.pdf'])
        assert.deepEqual(f.writes[0].payload, f.state.file)
        assert.deepEqual(f.writes[1].payload, { type: 1, content: exactText })
        assert.equal(result.caption_message_id, secondId)
        assert.equal(result.caption, exactText)
      }
      if (operation === cardOp) {
        assert.equal(f.writes[0].payload.type, 17)
        assert.equal(result.format, 'display_card')
        assert.match(JSON.stringify(f.writes[0].payload.card), /Ready\./)
      }
      assert.ok(f.calls.some(({ path }) => path === topicPath(shortB) + '/members'))
      assert.equal(f.calls.some(({ path }) => path === topicPath(shortA) + '/members'), route === source)
    })
  }
})

test('wrong or implicit shared targets fail before any lookup, preparation, or send', async t => {
  const cases = [
    ['other group topic', topic(shortB, otherGroup), 'shared_topic_target_required'],
    ['same current topic', source, 'shared_topic_target_required'],
    ['parent group', groupRoute, 'shared_topic_target_required'],
    ['person', dm, 'shared_topic_target_required'],
    ['bare name', { channel_id: 'Destination', channel_type: 5 }, 'shared_topic_target_required'],
    ['bare short ID', { channel_id: shortB, channel_type: 5 }, 'shared_topic_target_required'],
    ['wrong parent casing', topic(shortB, group.toUpperCase()), 'shared_topic_target_required'],
    ['extra target field', { ...destination, group_no: group }, 'invalid_arguments'],
  ]
  for (const operation of operations) for (const [name, target, code] of cases) await t.test(operation + '/' + name, async t => {
    const f = fixture(t)
    await reject(f.run(operation, { args: payloadArgs(operation, target) }), code)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.preparations, [])
  })
  for (const operation of operations) await t.test(operation + '/explicit confirmation and closed arguments', async t => {
    const f = fixture(t), args = payloadArgs(operation)
    await reject(f.run(operation, { args: { ...args, confirm_send: false } }), 'explicit_confirmation_required')
    await reject(f.run(operation, { args: { ...args, sender: 'owner' } }), 'invalid_arguments')
    assert.deepEqual(f.calls, [])
  })
})

test('host operator grant and exact source/target account route constraints fail closed', async t => {
  const f = fixture(t)
  await reject(f.run(textOp, { host: {} }), 'private_operation_required')
  await reject(f.run(cardOp, { host: { authorizeSharedSend: () => 'yes' } }), 'shared_topic_operator_required')
  f.state.allowed = false
  await reject(f.run(fileOp), 'shared_topic_operator_required')
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.preparations, [])
  const allowlisted = threads => fixture(t, { channelPolicy: 'allowlist', threads })
  await reject(allowlisted([destination.channel_id]).run(textOp), 'route_not_allowed')
  await reject(allowlisted([source.channel_id]).run(textOp), 'route_not_allowed')
  assert.equal((await allowlisted([source.channel_id, destination.channel_id]).run(textOp)).ok, true)
  const blockedHuman = fixture(t, { senderPolicy: 'allowlist', allowed: ['owner'] })
  await reject(blockedHuman.run(textOp), 'requester_not_allowed')
  assert.deepEqual(blockedHuman.calls, [])
  const app = fixture(t, { botKind: 'app', botUid: 'app_test_bot', spaceId: null })
  await reject(app.run(textOp), 'api_unsupported')
  assert.deepEqual(app.calls, [])
  const workspace = fixture(t)
  await reject(workspace.run(fileOp, { host: { authorizeSharedSend: () => true } }), 'file_delivery_unavailable')
  assert.deepEqual(workspace.writes, [])
})

test('live parent, Space principals, active topics and explicit human/Bot membership are all necessary', async t => {
  const cases = [
    ['other Space', s => { s.groupSpace = 'foreign' }, 'group_access_denied'],
    ['inactive parent', s => { s.groupStatus = 2 }, 'group_not_active'],
    ['no parent requester', s => { s.members.shift() }, 'requester_not_member'],
    ['no parent Bot', s => { s.members.splice(1, 1) }, 'bot_not_member'],
    ['non-human principal', s => { s.principal = 'user_bot' }, 'requester_not_allowed'],
    ['non-Bot principal', s => { s.botPrincipal = 'human' }, 'requester_not_allowed'],
    ...[shortA, shortB].flatMap(short => [
      [short + ' archived', s => { s.threads[short].detail.status = 2 }, 'thread_not_active'],
      [short + ' wrong binding', s => { s.threads[short].detail.channel_id = topic(short, otherGroup).channel_id }, 'invalid_thread_response'],
      [short + ' no requester (even creator)', s => { s.threads[short].members.shift() }, 'requester_not_topic_member'],
      [short + ' no Bot', s => { s.threads[short].members.splice(1, 1) }, 'bot_not_topic_member'],
      [short + ' removed Bot row', s => { s.threads[short].members[1].is_deleted = 1 }, 'bot_not_topic_member'],
      [short + ' duplicate UID', s => { s.threads[short].members.push(s.threads[short].members[0]) }, 'invalid_thread_response'],
    ]),
  ]
  for (const [name, change, code] of cases) await t.test(name, async t => {
    const f = fixture(t)
    change(f.state)
    await reject(f.run(fileOp), code)
    assert.deepEqual(f.preparations, [])
    assert.deepEqual(f.writes, [])
  })
})

test('mentions use the target roster and only live parent owner/admin can broadcast', async t => {
  const f = fixture(t), args = payloadArgs(textOp)
  await reject(f.run(textOp, { args: { ...args, uids: ['parent-only'] } }), 'mention_not_member')
  await reject(f.run(textOp, { args: { ...args, uids: ['all_bots'] } }), 'invalid_mention_target')
  await reject(f.run(textOp, { args: { ...args, all: true } }), 'requester_admin_required')
  f.state.members[0].role = 1
  f.state.beforeRequest = ({ path }) => { if (path === topicPath(shortB) + '/members') f.state.members[0].role = 0 }
  await reject(f.run(textOp, { args: { ...args, all: true } }), 'requester_admin_required')
  assert.deepEqual(f.writes, [])
  f.state.beforeRequest = undefined
  f.state.members[0].role = 2
  await f.run(textOp, { args: { ...args, all: true } })
  await f.run(textOp, { args: { ...args, uids: ['recipient'] } })
  assert.deepEqual(f.writes[0].payload.mention, { all: 1, humans: 1 })
  assert.deepEqual(f.writes[1].payload.mention.uids, ['recipient'])
  assert.match(f.writes[1].payload.content, /@Recipient /)
})

test('authorization is refreshed after card preparation, before upload, and after upload', async t => {
  const profileRace = fixture(t)
  profileRace.state.beforeRequest = ({ path }) => {
    if (path === profile) profileRace.state.threads[shortA].members.shift()
  }
  await reject(profileRace.run(cardOp), 'requester_not_topic_member')
  assert.deepEqual(profileRace.writes, [])
  const uploadRace = fixture(t)
  uploadRace.state.beforeUpload = () => { uploadRace.state.threads[shortB].members.splice(1, 1) }
  await reject(uploadRace.run(fileOp), 'bot_not_topic_member')
  assert.deepEqual(uploadRace.uploads, [])
  assert.deepEqual(uploadRace.writes, [])
  const sendRace = fixture(t)
  sendRace.state.afterUpload = () => { sendRace.state.allowed = false }
  await reject(sendRace.run(fileOp), 'shared_topic_operator_required')
  assert.equal(sendRace.uploads.length, 1)
  assert.deepEqual(sendRace.writes, [])
})

test('acknowledgements distinguish unconfirmed sends, confirmed files, and unsent or uncertain captions', async t => {
  const uncertain = fixture(t)
  uncertain.state.acks[0] = { message_id: Number(firstId) }
  await reject(uncertain.run(textOp), 'mutation_unconfirmed')
  assert.equal(uncertain.writes.length, 1)
  const deniedCaption = fixture(t)
  deniedCaption.state.beforeRequest = ({ path }) => {
    if (path === send) deniedCaption.state.threads[shortB].members.shift()
  }
  const first = await deniedCaption.run(fileOp)
  assert.equal(first.ok, false)
  assert.equal(first.message_id, firstId)
  assert.equal(first.partial, true)
  assert.equal(first.caption_status, 'not_sent')
  assert.equal(first.retry_whole_delivery, false)
  assert.equal(deniedCaption.writes.length, 1)
  for (const unconfirmedId of ['', firstId]) {
    const uncertainCaption = fixture(t)
    uncertainCaption.state.acks[1] = { message_id: unconfirmedId }
    const second = await uncertainCaption.run(fileOp)
    assert.equal(second.message_id, firstId)
    assert.equal(second.partial, true)
    assert.equal(second.caption_status, 'unconfirmed')
    assert.equal(second.retry_whole_delivery, false)
    assert.equal(uncertainCaption.writes.length, 2)
  }
  const operatorRevoked = fixture(t)
  operatorRevoked.state.beforeRequest = ({ path }) => { if (path === send) operatorRevoked.state.allowed = false }
  assert.deepEqual(await operatorRevoked.run(cardOp), { ok: true, message_id: firstId, sent_as: 'bot',
    authority_changed: true, requiresFinalSummary: true })
})

test('private target delivery and private-only discovery keep their existing boundaries', async t => {
  const f = fixture(t)
  f.state.allowed = false
  const result = await f.run(textOp, { route: dm, args: payloadArgs(textOp, groupRoute), host: {} })
  assert.equal(result.channel_id, group)
  assert.equal(result.message_id, firstId)
  await reject(f.run('messages.resolve_targets', { args: { name: 'Other' } }), 'private_operation_required')
  await reject(f.run('messages.resolve_people', { args: { name: 'Other' } }), 'private_operation_required')
  assert.equal(f.writes.length, 1)
})
