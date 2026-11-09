import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelApi, CHANNEL_API_OPERATIONS } from '../src/channel-api.js'
import { OctoError, readApiError } from '../src/api-errors.js'
import { displayCardParameters } from '../src/display-card.js'

// Independent, in-memory transport and upload fixture. No OctoClient, disk
// uploads, credentials, timers for races, or external services are used.
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn)
const group = '00112233445566778899aabbccddeeff'
const foreign = 'ffeeddccbbaa99887766554433221100'
const short = '123456789012345678'
const target = Object.freeze({ channel_id: group, channel_type: 2 })
const topic = Object.freeze({ channel_id: group + '____' + short, channel_type: 5 })
const dm = Object.freeze({ channel_id: 'human', channel_type: 1 })
const root = '/v1/bot/groups/' + group
const sendPath = '/v1/bot/sendMessage', profilePath = '/v1/bot/card/profile'
const syncPath = '/v1/bot/messages/sync'
const fileOp = 'messages.send_target_file', cardOp = 'messages.send_target_card'
const firstId = '9223372036854775807', captionId = '9223372036854775806'
const uploadURL = 'https://uploads.example.invalid/output?signature=fixture-only'
const manifest = {
  enabled: true, available: true, card_version: '1.5', profiles: ['octo/v1'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: false },
  elements: ['TextBlock', 'RichTextBlock', 'FactSet', 'ColumnSet', 'Table', 'Container', 'ActionSet'],
  actions: ['Action.OpenUrl', 'Action.ToggleVisibility', 'Action.CopyToClipboard'],
  limits: { max_payload_bytes: 524288, max_nodes: 400, max_depth: 16 },
}
const fileArgs = (selected = target) => ({ target: { ...selected }, path: 'reports/result.pdf', confirm_send: true })
const cardArgs = (selected = target) => ({ target: { ...selected }, confirm_send: true,
  title: 'Daily report', blocks: [{ type: 'text', text: 'Ready for review.' }] })
const inputFor = (op, selected = target) => op === fileOp ? fileArgs(selected) : cardArgs(selected)
const richCard = selected => ({ ...cardArgs(selected), blocks: [
  { type: 'heading', text: 'Overview' },
  { type: 'text', text: 'Ready for review.' },
  { type: 'rich', segments: [{ text: 'Rich detail', bold: true }] },
  { type: 'facts', items: [{ label: 'Passed', value: '12' }] },
  { type: 'columns', columns: [{ blocks: [{ type: 'text', text: 'West: 20' }] }] },
  { type: 'table', rows: [{ cells: [{ text: 'Apples' }, { text: '4' }] }] },
  { type: 'link', text: 'Read guide', url: 'https://example.com/guide' },
  { type: 'group', blocks: [{ type: 'text', text: 'Next step: review.' }] },
  { type: 'collapsible', summary: 'Details', blocks: [{ type: 'text', text: 'Folded detail retained.' }] },
  { type: 'copy', text: 'Copy this\n  exactly' },
] })
const objects = value => Array.isArray(value) ? value.flatMap(objects)
  : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(objects)] : []
const noLeaks = value => assert.doesNotMatch(JSON.stringify(value),
  /https?:|fixture-only|UPSTREAM_PRIVATE|"(?:reply|on_behalf_of|obo|raw|url|urls|callback|token)"/)
const denied = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code)
  noLeaks({ code: error.code, message: error.message })
  return true
})
const officialSendFailure = () => readApiError(Response.json({ status: 400,
  error: { code: 'err.server.bot_api.send_failed', http_status: 500, message: 'UPSTREAM_PRIVATE' },
}, { status: 400 }))

function fixture(t, overrides = {}) {
  const calls = [], writes = [], prepares = [], uploads = [], unexpected = []
  const controller = new AbortController()
  const state = {
    groups: [{ group_no: group, space_id: 'space' }], groupStatus: 1, threadStatus: 1,
    members: [{ uid: 'human', robot: 0, role: 0, name: 'Human' }, { uid: 'bot', robot: 1, role: 0, name: 'Bot' }],
    principal: 'human', botPrincipal: 'user_bot', profile: structuredClone(manifest),
    file: { type: 8, url: uploadURL, name: 'result.pdf', size: 1234 },
    acks: [{ message_id: firstId, url: uploadURL, token: 'UPSTREAM_PRIVATE' }, { message_id: captionId }],
  }
  const api = new ChannelApi({ config: { botUid: 'bot', spaceId: 'space', ownerUid: 'different-owner',
    senderPolicy: 'octo', channelPolicy: 'joined', ...overrides },
  request: async (path, raw, signal, options) => {
    const call = { path, body: raw === undefined ? undefined : JSON.parse(raw), signal, options }
    calls.push(call)
    if (path === sendPath) writes.push(call)
    await state.intercept?.(call)
    if (path === syncPath) {
      assert.equal(call.body.channel_id, 'human')
      if (state.sourceError) throw state.sourceError
      return { messages: [] }
    }
    if (path === '/v1/bot/space/principals/human?space_id=space') return { uid: 'human', principal_type: state.principal }
    if (path === '/v1/bot/space/principals/bot?space_id=space') return { uid: 'bot', principal_type: state.botPrincipal }
    if (path === '/v1/bot/groups?space_id=space') return structuredClone(state.groups)
    if (path === root + '/members') return structuredClone(state.members)
    if (path === root) return { group_no: group, name: 'Current group', status: state.groupStatus }
    if (path === root + '/threads/' + short) return { ...topic, group_no: group, short_id: short,
      creator_uid: 'human', name: 'Current topic', status: state.threadStatus }
    if (path === profilePath) {
      if (state.profileError) throw state.profileError
      return structuredClone(state.profile)
    }
    if (path === sendPath) {
      if (state.send) return state.send(call, writes.length)
      return structuredClone(state.acks[writes.length - 1])
    }
    unexpected.push(path)
    throw Error('Unexpected fixture endpoint')
  } })
  const runtime = { prepareFile: async (path, authorize, signal) => {
    prepares.push({ path, authorize, signal })
    await state.beforeUpload?.()
    await authorize()
    signal.throwIfAborted()
    uploads.push(path)
    await state.afterUpload?.()
    return state.file
  } }
  t.after(() => assert.deepEqual(unexpected, [], 'fixture must handle every requested endpoint'))
  const run = (input = fileArgs(), op = fileOp, options = {}) => api.dispatch(options.route ?? dm,
    options.sender ?? 'human', op, input, options.signal ?? controller.signal,
    Object.hasOwn(options, 'runtime') ? options.runtime : runtime)
  return { state, calls, writes, prepares, uploads, controller, runtime, run, api }
}
function assertRoute(body, selected) {
  const { payload, ...route } = body
  assert.deepEqual(route, selected)
  for (const node of objects(payload)) {
    for (const key of ['reply', 'on_behalf_of', 'obo', 'callback', 'callback_url', 'channel_id', 'channel_type']) {
      assert.equal(Object.hasOwn(node, key), false, key)
    }
    assert.notEqual(node.type, 'Action.Submit')
    assert.ok(!node.type?.startsWith?.('Input.'))
  }
}
function assertReceipt(result, selected, format = 'file') {
  assert.equal(result.message_id, firstId)
  assert.equal(result.channel_id, selected.channel_id)
  assert.equal(result.channel_type, selected.channel_type)
  assert.equal(result.name, selected.channel_type === 5 ? 'Current topic' : 'Current group')
  if (selected.channel_type === 5) assert.equal(result.parent_name, 'Current group')
  assert.equal(result.format, format)
  assert.equal(result.sent_as, 'bot')
  assert.equal(result.requiresFinalSummary, true)
  noLeaks(result)
}
function assertPartial(result, selected, status) {
  assertReceipt(result, selected)
  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.caption_status, status)
  assert.equal(result.retry_whole_delivery, false)
  assert.equal(result.caption_message_id, undefined)
  if (status === 'unconfirmed') assert.equal(Object.hasOwn(result, 'caption_sent'), false)
}

test('target delivery operations expose closed private schemas and the shared display DSL', () => {
  const file = CHANNEL_API_OPERATIONS.find(row => row.name === fileOp)
  const card = CHANNEL_API_OPERATIONS.find(row => row.name === cardOp)
  for (const spec of [file, card]) {
    assert.equal(spec.available, true)
    assert.equal(spec.privateOnly, true)
    assert.equal(spec.mutating, true)
    assert.equal(spec.parameters.additionalProperties, false)
    assert.ok(Object.isFrozen(spec.parameters))
    assert.equal(spec.parameters.properties.target.additionalProperties, false)
  }
  assert.equal(file.requiresFiles, true)
  assert.deepEqual(Object.keys(file.parameters.properties).sort(), ['caption', 'confirm_send', 'path', 'target'])
  const display = displayCardParameters()
  assert.deepEqual(card.parameters.$defs, display.$defs)
  assert.deepEqual(card.parameters.properties.blocks, display.properties.blocks)
})

test('group/topic native file and image delivery preserve receipts and the entire independent caption', async t => {
  const caption = '## 通知\n\n' + '完整内容🙂\n'.repeat(300) + '结尾  \n'
  for (const selected of [target, topic]) for (const type of [8, 2]) for (const withCaption of [false, true]) {
    await t.test(`${selected.channel_type}/${type}/caption=${withCaption}`, async t => {
      const f = fixture(t)
      f.state.file = { ...f.state.file, type, ...(type === 2 && { name: 'chart.png', width: 640, height: 480 }) }
      const input = { ...fileArgs(selected), ...(withCaption && { caption }) }
      const original = structuredClone(input)
      const result = await f.run(input)
      assertReceipt(result, selected, type === 2 ? 'image' : 'file')
      assert.equal(result.ok, true)
      assert.equal(result.file_name, f.state.file.name)
      assert.equal(result.size, 1234)
      assert.deepEqual(input, original)
      assert.deepEqual(f.uploads, [input.path])
      assert.equal(f.prepares[0].signal, f.controller.signal)
      assert.equal(typeof f.prepares[0].authorize, 'function')
      assert.equal(f.writes.length, withCaption ? 2 : 1)
      assert.deepEqual(f.writes[0].body.payload, f.state.file)
      for (const write of f.writes) { assertRoute(write.body, selected); assert.equal(write.options.method, 'POST') }
      if (withCaption) {
        assert.deepEqual(f.writes[1].body.payload, { type: 1, content: caption })
        assert.equal(result.caption, caption)
        assert.equal(result.caption_message_id, captionId)
      } else assert.equal(result.caption_message_id, undefined)
    })
  }
})

test('prepareFile cannot inject route, identity, reply, raw card or callback fields into the target payload', async t => {
  for (const selected of [target, topic]) for (const type of [8, 2]) await t.test(`${selected.channel_type}/${type}`, async t => {
    const f = fixture(t)
    const clean = { ...f.state.file, type, ...(type === 2 && { width: 320, height: 240 }) }
    f.state.afterUpload = () => Object.assign(f.state.file, clean, {
      route: { channel_id: foreign, channel_type: 2 }, channel_id: foreign, channel_type: 1,
      target: { channel_id: 'other', channel_type: 1 }, on_behalf_of: 'owner', reply: { message_id: '1' },
      callback: 'https://example.invalid/action', card: { actions: [{ type: 'Action.Submit' }] },
      payload: { type: 17 }, client_msg_no: 'injected', caption: 'Injected caption',
    })
    let callbackReads = 0
    Object.defineProperty(f.state.file, 'callback_url', { enumerable: true, get() { callbackReads++; return uploadURL } })
    const result = await f.run({ ...fileArgs(selected), caption: 'Approved caption' })
    assertReceipt(result, selected, type === 2 ? 'image' : 'file')
    assert.equal(callbackReads, 0)
    assert.equal(f.writes.length, 2)
    assert.deepEqual(f.writes[0].body, { ...selected, payload: clean })
    assert.deepEqual(f.writes[1].body, { ...selected, payload: { type: 1, content: 'Approved caption' } })
  })
})

test('target cards render all display variants in groups/topics without exposing raw card data in receipts', async t => {
  for (const selected of [target, topic]) await t.test(String(selected.channel_type), async t => {
    const f = fixture(t)
    const result = await f.run(richCard(selected), cardOp)
    assertReceipt(result, selected, 'display_card')
    assert.equal(result.ok, true)
    assert.deepEqual(result.fallbackBlocks, [])
    assert.equal(f.writes.length, 1)
    assert.equal(f.prepares.length, 0)
    assertRoute(f.writes[0].body, selected)
    const payload = f.writes[0].body.payload, nodes = objects(payload.card)
    assert.equal(payload.type, 17)
    assert.equal(payload.profile, 'octo/v1')
    for (const type of [...manifest.elements, ...manifest.actions]) assert.ok(nodes.some(row => row.type === type), type)
    assert.match(payload.plain, /^Daily report\nOverview\n/)
    for (const text of ['Apples | 4', 'Folded detail retained.', 'Copy this\n  exactly']) assert.ok(payload.plain.includes(text))
    assert.equal(f.calls.filter(call => call.path === profilePath).length, 1)
  })
})

test('cards fetch the live profile on each send and preserve all text through capability/limit fallbacks', async t => {
  const f = fixture(t), input = richCard(topic)
  await f.run(input, cardOp)
  const fullText = f.writes[0].body.payload.plain
  const variants = [
    [{ elements: ['TextBlock'], actions: [] }, ['rich', 'facts', 'columns', 'table', 'link', 'group', 'collapsible', 'copy']],
    [{ actions: [] }, ['link', 'collapsible', 'copy']],
    [{ limits: { max_nodes: 1 } }, ['limits']],
    [{ limits: { max_depth: 1 } }, ['limits']],
  ]
  for (const [changes, expected] of variants) {
    f.state.profile = { ...structuredClone(manifest), ...changes }
    f.state.acks.push({ message_id: firstId })
    const result = await f.run(input, cardOp)
    assert.equal(result.ok, true)
    assert.deepEqual(result.fallbackBlocks, expected)
    assert.equal(f.writes.at(-1).body.payload.plain, fullText)
    assertRoute(f.writes.at(-1).body, topic)
    noLeaks(result)
  }
  assert.equal(f.calls.filter(call => call.path === profilePath).length, 5)
})

test('disabled, incompatible, rejected and undersized card profiles never send', async t => {
  const cases = [
    ['null', null], ['empty', {}], ['disabled', { ...manifest, enabled: false }],
    ['unavailable', { ...manifest, available: false }], ['config missing', { ...manifest, config: {} }],
    ['display disabled', { ...manifest, config: { ...manifest.config, display_enabled: false } }],
    ['cards disabled', { ...manifest, config: { ...manifest.config, card_enabled: false } }],
    ['version', { ...manifest, card_version: '1.4' }], ['profile', { ...manifest, profiles: ['octo/v2'] }],
    ['elements', { ...manifest, elements: [] }], ['actions', { ...manifest, actions: {} }],
    ['bad limit', { ...manifest, limits: { max_nodes: 0 } }],
    ['too small', { ...manifest, limits: { max_payload_bytes: 1 } }, 'display_card_limits_exceeded'],
  ]
  for (const [name, profile, code = 'display_card_unavailable'] of cases) await t.test(name, async t => {
    const f = fixture(t); f.state.profile = profile
    await denied(f.run(cardArgs(), cardOp), code)
    assert.equal(f.writes.length, 0)
    assert.equal(f.uploads.length, 0)
  })
  for (const [name, error, code] of [
    ['forbidden', new OctoError('http_403', 403), 'api_permission_denied'],
    ['timeout', Error('UPSTREAM_PRIVATE'), 'api_request_failed'],
  ]) await t.test(name, async t => {
    const f = fixture(t); f.state.profileError = error
    await denied(f.run(cardArgs(), cardOp), code)
    assert.equal(f.calls.filter(call => call.path === profilePath).length, 1)
    assert.equal(f.writes.length, 0)
  })
})

test('confirmation, malformed arguments and raw route/card injections fail before any requests or uploads', async t => {
  for (const op of [fileOp, cardOp]) {
    const cases = [
      ['confirmation missing', input => { delete input.confirm_send }, 'invalid_arguments'],
      ['confirmation false', input => { input.confirm_send = false }, 'explicit_confirmation_required'],
      ['confirmation string', input => { input.confirm_send = 'true' }, 'invalid_arguments'],
      ['unsupported channel type', input => { input.target.channel_type = 3 }, 'invalid_arguments'],
      ['target type', input => { input.target.channel_type = '2' }, 'invalid_arguments'],
      ['target extra', input => { input.target.name = 'Untrusted name' }, 'invalid_arguments'],
    ]
    for (const key of ['on_behalf_of', 'reply', 'url', 'payload', 'card', 'actions', 'callback', 'route', 'accountId', 'raw', 'toJSON']) {
      cases.push([key, input => { input[key] = 'injected' }, 'invalid_arguments'])
    }
    if (op === fileOp) cases.push(
      ['blank path', input => { input.path = '  ' }, 'invalid_arguments'],
      ['long path', input => { input.path = 'a'.repeat(1025) }, 'invalid_arguments'],
      ['blank caption', input => { input.caption = '  ' }, 'invalid_arguments'],
      ['long caption', input => { input.caption = 'a'.repeat(4001) }, 'invalid_arguments'])
    else cases.push(
      ['no blocks', input => { delete input.blocks }, 'invalid_display_card'],
      ['empty blocks', input => { input.blocks = [] }, 'invalid_display_card'],
      ['raw callback', input => { input.blocks = [{ type: 'Action.Submit', data: { action: 'run' } }] }, 'invalid_display_card'],
      ['nested actions', input => { input.blocks[0].actions = [{ type: 'Action.Submit' }] }, 'invalid_display_card'],
      ['unsafe link', input => { input.blocks = [{ type: 'link', text: 'Guide', url: 'http://example.com' }] }, 'display_card_unsafe_link'])
    for (const [name, change, code] of cases) await t.test(`${op}/${name}`, async t => {
      const f = fixture(t), input = inputFor(op); change(input)
      await denied(f.run(input, op), code)
      assert.equal(f.calls.length, 0)
      assert.equal(f.prepares.length, 0)
      assert.equal(f.uploads.length, 0)
    })
  }
})

test('argument accessors, symbols and serialization hooks are rejected without evaluating them', async t => {
  for (const op of [fileOp, cardOp]) for (const location of ['top', 'target', 'symbol', 'toJSON', ...(op === cardOp ? ['block', 'nested'] : [])]) {
    await t.test(`${op}/${location}`, async t => {
      const f = fixture(t), input = inputFor(op)
      let reads = 0
      const get = () => { reads++; throw Error('UPSTREAM_PRIVATE') }
      if (location === 'top') Object.defineProperty(input, 'confirm_send', { enumerable: true, get })
      if (location === 'target') Object.defineProperty(input.target, 'channel_id', { enumerable: true, get })
      if (location === 'symbol') input[Symbol('injected')] = true
      if (location === 'toJSON') input.toJSON = get
      if (location === 'block') Object.defineProperty(input.blocks[0], 'text', { enumerable: true, get })
      if (location === 'nested') {
        input.blocks = [{ type: 'group', blocks: [{ type: 'text', text: 'Safe' }] }]
        Object.defineProperty(input.blocks[0].blocks[0], 'text', { enumerable: true, get })
      }
      await denied(f.run(input, op), ['block', 'nested'].includes(location) ? 'invalid_display_card' : 'invalid_arguments')
      assert.equal(reads, 0)
      assert.equal(f.calls.length, 0)
      assert.equal(f.prepares.length, 0)
    })
  }
})

test('source/target authorization denials prevent both preparation and upload', async t => {
  const cases = [
    ['group source', () => {}, { route: target }, 'private_operation_required'],
    ['other source person', () => {}, { sender: 'other' }, 'requester_not_allowed'],
    ['source denied', f => { f.state.sourceError = new OctoError('http_403', 403) }, {}, 'api_permission_denied'],
    ['robot requester', f => { f.state.principal = 'user_bot' }, {}, 'requester_not_allowed'],
    ['human bot identity', f => { f.state.botPrincipal = 'human' }, {}, 'requester_not_allowed'],
    ['foreign Space', f => { f.state.groups[0].space_id = 'elsewhere' }, {}, 'group_access_denied'],
    ['duplicate group', f => { f.state.groups.push({ ...f.state.groups[0] }) }, {}, 'group_access_denied'],
    ['requester left', f => { f.state.members.shift() }, {}, 'requester_not_member'],
    ['bot left', f => { f.state.members.pop() }, {}, 'bot_not_member'],
    ['inactive group', f => { f.state.groupStatus = 2 }, {}, 'group_not_active'],
    ['archived topic', f => { f.state.threadStatus = 2 }, {}, 'thread_not_active'],
    ['revoked account', f => f.api.revoke(), {}, 'account_configuration_changed'],
  ]
  for (const op of [fileOp, cardOp]) for (const [name, change, options, code] of cases) await t.test(`${op}/${name}`, async t => {
    const f = fixture(t); change(f)
    await denied(f.run(inputFor(op, topic), op, options), code)
    assert.equal(f.writes.length, 0)
    assert.equal(f.prepares.length, 0)
    assert.equal(f.uploads.length, 0)
    assert.equal(f.calls.filter(call => call.path === profilePath).length, 0)
  })
  for (const op of [fileOp, cardOp]) await t.test(`${op}/exact topic allowlist`, async t => {
    const f = fixture(t, { channelPolicy: 'allowlist', groups: new Set(), threads: new Set([topic.channel_id]) })
    await denied(f.run(inputFor(op), op), 'route_not_allowed')
    assert.equal(f.prepares.length, 0)
    assert.equal(f.writes.length, 0)
    const result = await f.run(inputFor(op, topic), op)
    assertReceipt(result, topic, op === fileOp ? 'file' : 'display_card')
  })
})

test('file runtime absence, preparation rejection and invalid prepared media never send', async t => {
  const absent = fixture(t)
  await denied(absent.run(fileArgs(), fileOp, { runtime: {} }), 'file_delivery_unavailable')
  assert.equal(absent.writes.length, 0)
  const rejected = fixture(t)
  rejected.state.beforeUpload = () => { throw new OctoError('file_outside_workspace') }
  await denied(rejected.run(), 'file_outside_workspace')
  assert.equal(rejected.uploads.length, 0)
  assert.equal(rejected.writes.length, 0)
  for (const [name, patch] of [
    ['wrong type', { type: 17 }], ['http', { url: 'http://example.invalid/a' }],
    ['credentials', { url: 'https://user:pass@example.invalid/a' }], ['fragment', { url: uploadURL + '#x' }],
    ['empty name', { name: '' }], ['negative size', { size: -1 }], ['too large', { size: 20 * 1024 * 1024 + 1 }],
    ['unsafe size', { size: Number.MAX_SAFE_INTEGER + 1 }],
  ]) await t.test(name, async t => {
    const f = fixture(t); Object.assign(f.state.file, patch)
    await denied(f.run(), 'invalid_prepared_file')
    assert.equal(f.writes.length, 0)
  })
})

test('authorization changes during preparation/profile awaits stop upload or dispatch at the next boundary', async t => {
  const races = [
    ['source access lost', f => { f.state.sourceError = new OctoError('http_403', 403) }, 'api_permission_denied'],
    ['requester left', f => { f.state.members.shift() }, 'requester_not_member'],
    ['bot left', f => { f.state.members.pop() }, 'bot_not_member'],
    ['Space changed', f => { f.state.groups[0].space_id = 'elsewhere' }, 'group_access_denied'],
    ['group closed', f => { f.state.groupStatus = 2 }, 'group_not_active'],
    ['topic archived', f => { f.state.threadStatus = 2 }, 'thread_not_active'],
    ['account revoked', f => f.api.revoke(), 'account_configuration_changed'],
  ]
  for (const phase of ['before upload', 'after upload', 'profile']) for (const [name, change, code] of races) {
    await t.test(`${phase}/${name}`, async t => {
      const f = fixture(t), op = phase === 'profile' ? cardOp : fileOp
      let entered = false
      const mutate = async () => { await Promise.resolve(); entered = true; change(f) }
      if (phase === 'before upload') f.state.beforeUpload = mutate
      else if (phase === 'after upload') f.state.afterUpload = mutate
      else f.state.intercept = call => { if (call.path === profilePath) return mutate() }
      await denied(f.run(inputFor(op, topic), op), code)
      assert.equal(entered, true)
      assert.equal(f.writes.length, 0)
      assert.equal(f.uploads.length, phase === 'after upload' ? 1 : 0)
    })
  }
})

test('membership is refreshed after final metadata awaits for both target delivery operations', async t => {
  for (const op of [fileOp, cardOp]) for (const selected of [target, topic]) for (const who of ['human', 'bot']) {
    await t.test(`${op}/${selected.channel_type}/${who}`, async t => {
      const f = fixture(t)
      let preparing = false, changed = false
      f.state.afterUpload = () => { preparing = true }
      f.state.intercept = call => {
        if (call.path === profilePath) preparing = true
        const metadata = selected.channel_type === 5 ? root + '/threads/' + short : root
        if (preparing && call.path === metadata) {
          f.state.members = f.state.members.filter(row => row.uid !== who)
          changed = true
        }
      }
      await denied(f.run(inputFor(op, selected), op), who === 'human' ? 'requester_not_member' : 'bot_not_member')
      assert.equal(changed, true)
      assert.equal(f.writes.length, 0)
    })
  }
})

test('ambiguous or rejected initial sends never retry or start a caption', async t => {
  const legacy = await officialSendFailure()
  const outcomes = [
    ['missing receipt', {}, 'mutation_unconfirmed'],
    ['unsafe numeric receipt', { message_id: Number(firstId) }, 'mutation_unconfirmed'],
    ['invalid receipt', { message_id: 'not-an-id' }, 'mutation_unconfirmed'],
    ['timeout', Error('UPSTREAM_PRIVATE ' + uploadURL), 'mutation_unconfirmed'],
    ['server failure', new OctoError('http_500', 500), 'mutation_unconfirmed'],
    ['legacy400 semantic500', legacy, 'mutation_unconfirmed'],
    ['forbidden', new OctoError('http_403', 403), 'api_permission_denied'],
    ['rate limited', new OctoError('http_429', 429, 1), 'api_rate_limited'],
  ]
  for (const op of [fileOp, cardOp]) for (const [name, outcome, code] of outcomes) await t.test(`${op}/${name}`, async t => {
    const f = fixture(t)
    f.state.send = () => { if (outcome instanceof Error) throw outcome; return outcome }
    const input = inputFor(op, topic)
    if (op === fileOp) input.caption = 'Must not send after ambiguous media.'
    await denied(f.run(input, op), code)
    assert.equal(f.writes.length, 1)
    assert.equal(f.uploads.length, op === fileOp ? 1 : 0)
  })
})

test('in-flight initial send preserves a confirmed receipt after cancellation but never invents success or retries', async t => {
  for (const op of [fileOp, cardOp]) for (const kind of ['source', 'human', 'bot', 'revoke', 'abort']) {
    await t.test(`${op}/${kind}`, async t => {
      const f = fixture(t)
      f.state.send = async () => {
        await Promise.resolve()
        if (kind === 'revoke') { f.api.revoke(); return { message_id: firstId } }
        if (kind === 'abort') { f.controller.abort(); return { message_id: firstId } }
        if (kind === 'source') f.state.sourceError = new OctoError('http_403', 403)
        else f.state.members = f.state.members.filter(row => row.uid !== kind)
        // The server owns atomic enforcement once a request is in flight.
        throw new OctoError('http_403', 403)
      }
      const input = inputFor(op)
      if (op === fileOp) input.caption = 'No follow-up after failure.'
      if (['revoke', 'abort'].includes(kind)) {
        const result = await f.run(input, op)
        assert.deepEqual(result, { ok: op !== fileOp, message_id: firstId, sent_as: 'bot', authority_changed: true,
          requiresFinalSummary: true, ...(op === fileOp && { partial: true, caption_status: 'not_sent', retry_whole_delivery: false }) })
        noLeaks(result)
      } else await denied(f.run(input, op), 'api_permission_denied')
      assert.equal(f.writes.length, 1)
    })
  }
})

test('confirmed media retains its receipt when caption delivery is rejected or uncertain', async t => {
  const legacy = await officialSendFailure()
  const cases = [
    ['missing receipt', {}, 'unconfirmed'],
    ['unsafe receipt', { message_id: Number(captionId) }, 'unconfirmed'],
    ['timeout', Error('UPSTREAM_PRIVATE'), 'unconfirmed'],
    ['server error', new OctoError('http_500', 500), 'unconfirmed'],
    ['legacy400 semantic500', legacy, 'unconfirmed'],
    ['forbidden', new OctoError('http_403', 403), 'not_sent'],
    ['rate limited', new OctoError('http_429', 429, 1), 'not_sent'],
  ]
  for (const selected of [target, topic]) for (const [name, outcome, status] of cases) await t.test(`${selected.channel_type}/${name}`, async t => {
    const f = fixture(t), caption = '## Approved caption\n\nEvery line stays intact.  \n'
    f.state.send = (_, number) => {
      if (number === 1) return { message_id: firstId }
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    const result = await f.run({ ...fileArgs(selected), caption })
    assertPartial(result, selected, status)
    assert.equal(result.file_name, 'result.pdf')
    assert.equal(f.writes.length, 2)
    assert.equal(f.uploads.length, 1)
    assert.deepEqual(f.writes[1].body.payload, { type: 1, content: caption })
  })
})

test('loss of authorization between confirmed media and caption returns known partial delivery', async t => {
  for (const kind of ['source', 'human', 'bot', 'Space', 'group', 'topic', 'revoke']) await t.test(kind, async t => {
    const f = fixture(t)
    let changed = false
    f.state.intercept = call => {
      if (f.writes.length !== 1 || call.path !== syncPath) return
      changed = true
      if (kind === 'source') f.state.sourceError = new OctoError('http_403', 403)
      if (kind === 'human' || kind === 'bot') f.state.members = f.state.members.filter(row => row.uid !== kind)
      if (kind === 'Space') f.state.groups = []
      if (kind === 'group') f.state.groupStatus = 2
      if (kind === 'topic') f.state.threadStatus = 2
      if (kind === 'revoke') f.api.revoke()
    }
    const result = await f.run({ ...fileArgs(topic), caption: 'Caption after the confirmed file.' })
    assert.equal(changed, true)
    assertPartial(result, topic, 'not_sent')
    assert.equal(f.writes.length, 1)
    assert.equal(f.uploads.length, 1)
  })
})

test('account revocation or cancellation during caption send preserves both confirmed receipts without stale content', async t => {
  for (const kind of ['revoke', 'abort']) await t.test(kind, async t => {
    const f = fixture(t)
    f.state.send = async (_, number) => {
      if (number === 1) return { message_id: firstId }
      await Promise.resolve()
      if (kind === 'revoke') f.api.revoke()
      else f.controller.abort()
      return { message_id: captionId }
    }
    const result = await f.run({ ...fileArgs(), caption: 'Caption' })
    assert.deepEqual(result, { ok: true, message_id: firstId, caption_message_id: captionId, sent_as: 'bot',
      authority_changed: true, requiresFinalSummary: true })
    noLeaks(result)
    assert.equal(f.writes.length, 2)
    assert.equal(f.uploads.length, 1)
  })
})

test('mutating caller input during preparation/profile/send awaits cannot change the approved destination or content', async t => {
  for (const phase of ['prepare', 'profile', 'send']) for (const op of phase === 'prepare' ? [fileOp] : phase === 'profile' ? [cardOp] : [fileOp, cardOp]) {
    await t.test(`${op}/${phase}`, async t => {
      const f = fixture(t), input = inputFor(op, topic), source = { ...dm }
      if (op === fileOp) input.caption = 'Approved caption\n  preserved'
      const gate = Promise.withResolvers(), entered = Promise.withResolvers()
      let held = false
      const hold = async () => { if (held) return; held = true; entered.resolve(); await gate.promise }
      if (phase === 'prepare') f.state.afterUpload = hold
      else f.state.intercept = call => { if (call.path === (phase === 'profile' ? profilePath : sendPath)) return hold() }
      const pending = f.run(input, op, { route: source })
      t.after(() => gate.resolve())
      await entered.promise
      try {
        input.target.channel_id = foreign
        input.target.channel_type = 2
        input.confirm_send = false
        input.on_behalf_of = 'other'
        source.channel_id = 'other'
        if (op === fileOp) { input.path = 'changed.pdf'; input.caption = 'Changed caption' }
        else { input.title = 'Changed title'; input.blocks[0].text = 'Changed text'; input.blocks.push({ type: 'Action.Submit' }) }
      } finally { gate.resolve() }
      const result = await pending
      assertReceipt(result, topic, op === fileOp ? 'file' : 'display_card')
      for (const write of f.writes) assertRoute(write.body, topic)
      if (op === fileOp) {
        assert.deepEqual(f.uploads, ['reports/result.pdf'])
        assert.equal(f.writes[1].body.payload.content, 'Approved caption\n  preserved')
        assert.equal(result.caption, 'Approved caption\n  preserved')
      } else assert.equal(f.writes[0].body.payload.plain, 'Daily report\nReady for review.')
      assert.doesNotMatch(JSON.stringify(f.writes), /Changed|changed\.pdf|on_behalf_of|Action\.Submit/)
    })
  }
})
