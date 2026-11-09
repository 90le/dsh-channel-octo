import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { OctoClient } from '../src/octo.js'
import { ChannelApi, CHANNEL_API_OPERATIONS } from '../src/channel-api.js'

// Real ChannelApi + transport/error parser, with exclusively in-memory HTTP
// responses and uploads. Unknown endpoints fail even if production catches them.
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn)
const source = Object.freeze({ channel_id: 'requester', channel_type: 1 })
const target = Object.freeze({ channel_id: 'colleague', channel_type: 1 })
const group = '00112233445566778899aabbccddeeff'
const topic = group + '____123456789012345678'
const sendOp = 'messages.send_target', fileOp = 'messages.send_target_file'
const cardOp = 'messages.send_target_card', resolveOp = 'messages.resolve_people'
const sends = [sendOp, fileOp, cardOp], operations = [resolveOp, ...sends]
const sendPath = '/v1/bot/sendMessage', syncPath = '/v1/bot/messages/sync'
const profilePath = '/v1/bot/card/profile', infoPath = '/v1/bot/user/info'
const directoryPath = '/v1/bot/space/members', principalPath = '/v1/bot/space/principals/'
const firstId = '9223372036854775807', captionId = '9223372036854775806'
const origin = 'https://octo-person.invalid', token = 'bf_person_delivery_fixture'
const uploadURL = 'https://uploads.invalid/report?signature=FIXTURE_SECRET'
const extras = { avatar: 'https://private.invalid/avatar', token: 'FIXTURE_SECRET',
  on_behalf_of: 'PRIVATE_RAW', raw: { content: 'PRIVATE_HISTORY' } }
const manifest = { enabled: true, available: true, card_version: '1.5', profiles: ['octo/v1'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: false },
  elements: ['TextBlock', 'RichTextBlock', 'FactSet', 'Container', 'ActionSet'],
  actions: ['Action.OpenUrl', 'Action.ToggleVisibility', 'Action.CopyToClipboard'],
  limits: { max_payload_bytes: 524288, max_nodes: 400, max_depth: 16 } }
const inputFor = op => op === resolveOp ? { name: '同事' }
  : { target: { ...target }, confirm_send: true, ...(op === sendOp ? { text: '## 通知\n\n完整内容🙂  \n' }
    : op === fileOp ? { path: 'reports/result.pdf' }
      : { title: 'Daily report', blocks: [{ type: 'text', text: 'Ready for review.' }] }) }
const noLeaks = value => assert.doesNotMatch(JSON.stringify(value),
  /FIXTURE_SECRET|PRIVATE_RAW|PRIVATE_HISTORY|bf_person_delivery_fixture|https?:|"(?:avatar|raw|url|token|on_behalf_of|reply|callback)"/)
const denied = (promise, codes) => assert.rejects(promise, error => {
  // The runtime upload authorizer uses native signal.throwIfAborted(); HTTP
  // boundaries classify the same cancellation as ChannelApiError('aborted').
  const code = error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : error.code
  assert.ok([codes].flat().includes(code), 'unexpected rejection: ' + code)
  noLeaks({ code: error.code, message: error.message })
  return true
})
const failure = (code = 'not_space_member', status = 403) => Response.json({ status,
  error: { code: 'err.server.bot_api.' + code, http_status: status, message: 'PRIVATE_RAW ' + uploadURL,
    details: extras } }, { status })

function fixture(t, overrides = {}) {
  const calls = [], writes = [], uploads = [], prepares = [], violations = []
  const controller = new AbortController()
  const config = { apiBase: origin, token, botUid: 'bot', spaceId: 'fixed-space', ownerUid: 'another-owner',
    senderPolicy: 'octo', channelPolicy: 'joined', ...overrides }
  const state = {
    principals: new Map(['requester', 'colleague', 'second-person', 'bot'].map(uid =>
      [uid, { uid, principal_type: uid === 'bot' ? 'user_bot' : 'human', ...extras }])),
    deniedPrincipals: new Map(), sourceDenied: false, spaceActive: true, botActive: true,
    directory: [{ uid: 'colleague', name: '同事', robot: 0, ...extras }],
    info: { uid: 'colleague', name: 'Current colleague', ...extras },
    profile: structuredClone(manifest),
    file: { type: 8, url: uploadURL, name: 'result.pdf', size: 1234 },
  }
  const client = new OctoClient(Object.assign(config, { fetchImpl: async (input, init) => {
    const url = new URL(input)
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    if (call.path === sendPath) writes.push(call)
    if (url.origin !== origin || init.redirect !== 'manual' || init.headers.Authorization !== 'Bearer ' + token)
      violations.push('transport escaped the bound Bot account')
    if (!(init.signal instanceof AbortSignal)) violations.push('missing abort signal')
    const expectedMethod = [syncPath, sendPath].includes(call.path) ? 'POST' : 'GET'
    if (call.method !== expectedMethod) violations.push('wrong method: ' + call.path)
    if (call.path === syncPath && (call.body?.channel_id !== source.channel_id || call.body?.channel_type !== 1))
      violations.push('read a third-party conversation')
    if ((call.path === directoryPath || call.path.startsWith(principalPath)) && call.query.space_id !== 'fixed-space')
      violations.push('lookup escaped the fixed Space')
    await state.intercept?.(call)
    let result
    if (call.path === syncPath) result = state.sourceDenied ? failure('not_friend')
      : { messages: [{ message_id: '21', payload: { type: 1, content: 'PRIVATE_HISTORY' } }] }
    else if (call.path.startsWith(principalPath)) {
      const uid = decodeURIComponent(call.path.slice(principalPath.length))
      // The official exact-principal endpoint also checks the calling UserBot
      // on every request, including requests for a human principal.
      result = !state.botActive ? failure('bot_unavailable') : !state.spaceActive ? failure() : state.deniedPrincipals.has(uid)
        ? failure(...state.deniedPrincipals.get(uid)) : state.principals.get(uid) ?? failure('user_not_found', 404)
    } else if (call.path === directoryPath) result = state.directoryError?.() ?? state.directory
    else if (call.path === infoPath) {
      if (call.query.uid !== target.channel_id) violations.push('metadata target changed')
      result = state.infoError?.() ?? state.info
    } else if (call.path === profilePath) result = state.profileError?.() ?? state.profile
    else if (call.path === sendPath) result = state.send ? await state.send(call, writes.length)
      : { message_id: writes.length % 2 ? firstId : captionId, ...extras }
    else { violations.push('unexpected endpoint: ' + call.path); result = failure('request_invalid', 400) }
    return result instanceof Response ? result : Response.json(result)
  } }))
  const api = client.channel
  assert.ok(api instanceof ChannelApi)
  const runtime = { prepareFile: async (path, authorize, signal) => {
    prepares.push({ path, signal })
    await state.beforeUpload?.()
    await authorize()
    signal.throwIfAborted()
    uploads.push(path)
    await state.afterUpload?.()
    return state.file
  } }
  t.after(() => assert.deepEqual(violations, [], 'only bound Bot HTTP contracts and source history are permitted'))
  const run = (op = sendOp, args = inputFor(op), options = {}) => api.dispatch(options.route ?? source,
    options.sender ?? source.channel_id, op, args, options.signal ?? controller.signal,
    Object.hasOwn(options, 'runtime') ? options.runtime : runtime)
  return { api, client, state, calls, writes, uploads, prepares, config, controller, run }
}
function assertRoute(body) {
  const { payload, ...route } = body
  assert.deepEqual(route, target)
  assert.doesNotMatch(JSON.stringify(payload), /"(?:on_behalf_of|from_uid|actual_sender_uid|obo|reply|callback|callback_url|channel_id|channel_type)"|Action\.Submit|Input\./)
}
function assertReceipt(result, op = sendOp) {
  assert.equal(result.message_id, firstId)
  assert.equal(result.channel_id, target.channel_id)
  assert.equal(result.channel_type, 1)
  assert.equal(result.name, 'Current colleague')
  assert.equal(result.sent_as, 'bot')
  if (op !== sendOp) {
    assert.equal(result.format, op === fileOp ? 'file' : 'display_card')
    assert.equal(result.requiresFinalSummary, true)
  }
  noLeaks(result)
}
function assertPartial(result, status) {
  assertReceipt(result, fileOp)
  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.caption_status, status)
  assert.equal(result.retry_whole_delivery, false)
  assert.equal(result.caption_message_id, undefined)
}

test('person operations keep private closed schemas, existing target types, and bounded directory pagination', () => {
  for (const op of operations) {
    const spec = CHANNEL_API_OPERATIONS.find(row => row.name === op)
    assert.ok(spec?.available)
    assert.equal(spec.privateOnly, true)
    assert.equal(spec.mutating, op !== resolveOp)
    assert.equal(spec.parameters.additionalProperties, false)
    assert.ok(Object.isFrozen(spec.parameters))
    if (op !== resolveOp) assert.deepEqual(spec.parameters.properties.target.properties.channel_type.enum, [1, 2, 5])
  }
  const parameters = CHANNEL_API_OPERATIONS.find(row => row.name === resolveOp).parameters
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['limit', 'name', 'page'])
  assert.equal(parameters.properties.limit.maximum, 5)
  assert.equal(parameters.properties.page.maximum, 100)
  assert.equal(CHANNEL_API_OPERATIONS.find(row => row.name === fileOp).requiresFiles, true)
})

test('non-owner admitted humans can send exact text, workspace file and display card as the bound Bot', async t => {
  for (const op of sends) await t.test(op, async t => {
    const f = fixture(t, { channelPolicy: 'allowlist', groups: new Set(), threads: new Set(),
      senderPolicy: 'allowlist', allowed: new Set(['requester']) })
    const args = inputFor(op), before = structuredClone(args)
    const result = await f.run(op, args)
    assertReceipt(result, op)
    assert.equal(result.ok, true)
    assert.deepEqual(args, before)
    assert.equal(f.writes.length, 1)
    assertRoute(f.writes[0].body)
    const payload = f.writes[0].body.payload
    if (op === sendOp) {
      assert.deepEqual(payload, { type: 1, content: args.text })
      assert.equal(result.text, args.text)
    } else if (op === fileOp) {
      assert.deepEqual(payload, f.state.file)
      assert.deepEqual(f.uploads, [args.path])
      assert.equal(result.file_name, 'result.pdf')
      assert.equal(result.size, 1234)
    } else {
      assert.equal(payload.type, 17)
      assert.equal(payload.profile, 'octo/v1')
      assert.equal(payload.plain, 'Daily report\nReady for review.')
      assert.equal(f.calls.filter(call => call.path === profilePath).length, 1)
    }
    assert.ok(f.calls.some(call => call.path === principalPath + target.channel_id))
    assert.ok(f.calls.some(call => call.path === infoPath && call.query.uid === target.channel_id))
    assert.equal(f.calls.some(call => call.path === directoryPath), false, 'exact UID does not require a name search')
  })
})

test('native images and full independent captions retain their exact receipts', async t => {
  for (const type of [2, 8]) await t.test(String(type), async t => {
    const f = fixture(t), caption = '## 文件说明\n\n' + '完整内容🙂\n'.repeat(180) + '最后一行  \n'
    f.state.file = { ...f.state.file, type, ...(type === 2 && { name: 'chart.png', width: 640, height: 480 }) }
    const result = await f.run(fileOp, { ...inputFor(fileOp), caption })
    assert.equal(result.ok, true)
    assert.equal(result.format, type === 2 ? 'image' : 'file')
    assert.equal(result.message_id, firstId)
    assert.equal(result.caption_message_id, captionId)
    assert.equal(result.caption, caption)
    assert.equal(f.uploads.length, 1)
    assert.equal(f.writes.length, 2)
    f.writes.forEach(call => assertRoute(call.body))
    assert.deepEqual(f.writes[0].body.payload, f.state.file)
    assert.deepEqual(f.writes[1].body.payload, { type: 1, content: caption })
    noLeaks(result)
  })
})

test('directory lookup uses one fixed Space page, exact human principals and no friendship/history probe', async t => {
  const f = fixture(t)
  const result = await f.run(resolveOp, { name: '  同事 & 李  ' })
  assert.deepEqual(result, { candidates: [{ ...target, name: '同事' }], page: 1, more: false,
    scope: 'configured_space_humans', friendship_checked: false, needs_choice: false })
  assert.deepEqual(f.calls.filter(call => call.path === directoryPath), [{ path: directoryPath, method: 'GET', body: undefined,
    query: { space_id: 'fixed-space', keyword: '同事 & 李', limit: '5', page: '1' } }])
  assert.equal(f.calls.some(call => call.path === infoPath), false)
  assert.ok(f.calls.filter(call => call.path === principalPath + 'colleague').length >= 2)
  assert.equal(f.writes.length, 0)
  assert.equal(f.uploads.length, 0)
  noLeaks(result)
})

test('ambiguous names, full pages, later pages and no matches never imply a unique recipient', async t => {
  const cases = [
    ['ambiguous', [{ uid: 'colleague', robot: 0, name: '同名' }, { uid: 'second-person', robot: 0, name: '同名' }], {}, true, false],
    ['full page', [{ uid: 'colleague', robot: 0, name: '同名' }], { limit: 1 }, true, true],
    ['later page', [{ uid: 'colleague', robot: 0, name: '同名' }], { page: 100 }, true, false],
    ['empty', [], {}, true, false],
    ['bots fill page', [{ uid: 'bot', robot: 1, name: 'Bot' }], { limit: 1 }, true, true],
  ]
  for (const [label, rows, args, choice, more] of cases) await t.test(label, async t => {
    const f = fixture(t); f.state.directory = rows
    const result = await f.run(resolveOp, { name: '同名', ...args })
    assert.equal(result.needs_choice, choice)
    assert.equal(result.more, more)
    assert.equal(result.page, args.page ?? 1)
    assert.equal(result.friendship_checked, false)
    assert.equal(f.calls.filter(call => call.path === directoryPath).length, 1, 'no hidden pagination')
    assert.equal(f.writes.length, 0)
    noLeaks(result)
  })
})

test('a roster name and robot=0 cannot authorize an ineligible, departed or wrong-UID principal', async t => {
  for (const kind of ['user_bot', 'not_space_member', 'user_not_found', 'wrong uid', 'invalid type']) await t.test(kind, async t => {
    const f = fixture(t)
    f.state.directory[0].name = 'PRIVATE_RAW'
    if (kind === 'not_space_member') f.state.deniedPrincipals.set('colleague', [kind, 403])
    else if (kind === 'user_not_found') f.state.deniedPrincipals.set('colleague', [kind, 404])
    else f.state.principals.set('colleague', { uid: kind === 'wrong uid' ? 'second-person' : 'colleague',
      principal_type: kind === 'user_bot' ? kind : kind === 'invalid type' ? 'app_bot' : 'human' })
    if (['wrong uid', 'invalid type'].includes(kind)) await denied(f.run(resolveOp), 'invalid_principal_response')
    else {
      const result = await f.run(resolveOp)
      assert.deepEqual(result.candidates, [])
      assert.equal(result.needs_choice, true)
      noLeaks(result)
    }
    assert.equal(f.writes.length, 0)
  })
})

test('directory candidates are refreshed after source re-admission', async t => {
  const f = fixture(t)
  let searched = false, changed = false
  f.state.intercept = call => {
    if (call.path === directoryPath) searched = true
    if (searched && call.path === syncPath) {
      changed = true
      f.state.deniedPrincipals.set('colleague', ['not_space_member', 403])
    }
  }
  const result = await f.run(resolveOp)
  assert.equal(changed, true)
  assert.deepEqual(result.candidates, [])
  assert.equal(result.needs_choice, true)
})

test('source route, sender policy, exact principals and fixed Space failures stop before file/card preparation', async t => {
  const cases = [
    ['group source', () => {}, { route: { channel_id: group, channel_type: 2 } }, 'private_operation_required'],
    ['topic source', () => {}, { route: { channel_id: topic, channel_type: 5 } }, 'private_operation_required'],
    ['other sender', () => {}, { sender: 'second-person' }, 'requester_not_allowed'],
    ['other source', () => {}, { route: { channel_id: 'second-person', channel_type: 1 } }, 'requester_not_allowed'],
    ['source friendship', f => { f.state.sourceDenied = true }, {}, 'api_permission_denied'],
    ['Space revoked', f => { f.state.spaceActive = false }, {}, 'api_permission_denied'],
    ['requester robot', f => { f.state.principals.get('requester').principal_type = 'user_bot' }, {}, 'requester_not_allowed'],
    ['Bot is human', f => { f.state.principals.get('bot').principal_type = 'human' }, {}, 'requester_not_allowed'],
    ['App Bot', f => { f.state.principals.get('bot').principal_type = 'app_bot' }, {}, 'invalid_principal_response'],
    ['principal UID mismatch', f => { f.state.principals.get('requester').uid = 'second-person' }, {}, 'invalid_principal_response'],
    ['account revoked', f => f.api.revoke(), {}, 'account_configuration_changed'],
  ]
  for (const op of operations) for (const [label, change, options, code] of cases) await t.test(`${op}/${label}`, async t => {
    const f = fixture(t); change(f)
    await denied(f.run(op, inputFor(op), options), code)
    assert.equal(f.prepares.length, 0)
    assert.equal(f.writes.length, 0)
    assert.equal(f.calls.some(call => call.path === profilePath), false)
  })
  for (const op of operations) await t.test(`${op}/sender allowlist`, async t => {
    const f = fixture(t, { senderPolicy: 'allowlist', allowed: new Set(['another-owner']) })
    await denied(f.run(op), 'requester_not_allowed')
    assert.equal(f.calls.length, 0)
  })
})

test('target must be a current exact human in this Space and metadata must match its UID', async t => {
  const cases = [
    ['target outside Space', f => f.state.deniedPrincipals.set('colleague', ['not_space_member', 403]), 'api_permission_denied'],
    ['target missing', f => f.state.deniedPrincipals.set('colleague', ['user_not_found', 404]), 'api_not_found'],
    ['target robot', f => { f.state.principals.get('colleague').principal_type = 'user_bot' }, 'human_member_required'],
    ['wrong principal UID', f => { f.state.principals.get('colleague').uid = 'second-person' }, 'invalid_principal_response'],
    ['wrong metadata UID', f => { f.state.info.uid = 'second-person' }, 'invalid_identity_response'],
    ['prefixed metadata UID', f => { f.state.info.uid = 's123_colleague' }, 'invalid_identity_response'],
    ['invalid name', f => { f.state.info.name = {} }, 'invalid_identity_response'],
    ['metadata denied', f => { f.state.infoError = () => failure('user_not_found', 404) }, 'api_not_found'],
  ]
  for (const op of sends) for (const [label, change, code] of cases) await t.test(`${op}/${label}`, async t => {
    const f = fixture(t); change(f)
    await denied(f.run(op), code)
    assert.equal(f.writes.length, 0)
    assert.equal(f.prepares.length, 0)
  })
})

test('friendship is decided by the actual send endpoint: definitive 403 is never retried or followed by a caption', async t => {
  for (const op of sends) for (const code of ['not_friend', 'conversation_not_started']) await t.test(`${op}/${code}`, async t => {
    const f = fixture(t), input = inputFor(op)
    if (op === fileOp) input.caption = 'Must not follow a rejected file.'
    f.state.send = () => failure(code)
    await denied(f.run(op, input), 'api_permission_denied')
    assert.equal(f.writes.length, 1)
    assert.equal(f.uploads.length, op === fileOp ? 1 : 0)
    assertRoute(f.writes[0].body)
  })
})

test('malformed person addresses, broadcast sentinels and disguised group/topic routes never send', async t => {
  const invalid = ['', '张三', 'with space', 'a/b', 'a?uid=x', '%2f', 'x'.repeat(129), '.', '..',
    'all', 'ALL_BOTS', '-1', '-2', '-3', 'requester@colleague', 's1:colleague', topic, group, 'bot']
  for (const op of sends) for (const value of invalid) await t.test(`${op}/${value.slice(0, 40)}`, async t => {
    const f = fixture(t), input = inputFor(op)
    input.target.channel_id = value
    await denied(f.run(op, input), ['invalid_arguments', 'invalid_route', 'api_not_found'])
    assert.equal(f.writes.length, 0)
    assert.equal(f.prepares.length, 0)
    assert.equal(f.calls.some(call => call.path === infoPath), false)
  })
})

test('closed arguments reject confirmation bypasses, route/credential injection and DM mentions before HTTP', async t => {
  const changes = [
    ['confirmation missing', input => { delete input.confirm_send }],
    ['confirmation false', input => { input.confirm_send = false }],
    ['confirmation string', input => { input.confirm_send = 'true' }],
    ['raw payload', input => { input.payload = { type: 1 } }],
    ['OBO', input => { input.on_behalf_of = 'another-owner' }],
    ['token', input => { input.token = 'FIXTURE_SECRET' }],
    ['Space', input => { input.space_id = 'elsewhere' }],
    ['source', input => { input.sender = 'another-owner' }],
    ['nested route', input => { input.target.name = 'Fake identity' }],
    ['string type', input => { input.target.channel_type = '1' }],
    ['unknown type', input => { input.target.channel_type = 7 }],
  ]
  for (const op of sends) for (const [label, change] of changes) await t.test(`${op}/${label}`, async t => {
    const f = fixture(t), input = inputFor(op); change(input)
    await denied(f.run(op, input), ['invalid_arguments', 'explicit_confirmation_required'])
    assert.equal(f.calls.length, 0)
    assert.equal(f.prepares.length, 0)
  })
  for (const patch of [{ uids: ['colleague'] }, { all: true }, { uids: ['colleague'], all: true }, { text: ' \n ' }]) {
    const f = fixture(t)
    await denied(f.run(sendOp, { ...inputFor(sendOp), ...patch }), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
})

test('directory input bounds and model-supplied credentials cannot expand a page or choose a Space', async t => {
  for (const patch of [{ name: '' }, { name: ' \n ' }, { name: 'x'.repeat(101) }, { limit: 0 }, { limit: 6 },
    { limit: 1.5 }, { page: 0 }, { page: 101 }, { page: '2' }, { space_id: 'elsewhere' },
    { token: 'FIXTURE_SECRET' }, { on_behalf_of: 'another-owner' }, { channel_id: 'colleague' }]) {
    const f = fixture(t)
    await denied(f.run(resolveOp, { name: '同事', ...patch }), 'invalid_arguments')
    assert.equal(f.calls.length, 0)
  }
})

test('accessors, custom serialization and nested card injection are rejected without evaluating user code', async t => {
  for (const op of operations) for (const location of ['top', 'symbol', 'toJSON', ...(op !== resolveOp ? ['target'] : []),
    ...(op === cardOp ? ['nested card'] : [])]) await t.test(`${op}/${location}`, async t => {
    const f = fixture(t), args = inputFor(op)
    let reads = 0
    const get = () => { reads++; throw Error('PRIVATE_RAW') }
    if (location === 'top') Object.defineProperty(args, op === resolveOp ? 'name' : 'confirm_send', { enumerable: true, get })
    if (location === 'symbol') args[Symbol('injected')] = true
    if (location === 'toJSON') args.toJSON = get
    if (location === 'target') Object.defineProperty(args.target, 'channel_id', { enumerable: true, get })
    if (location === 'nested card') Object.defineProperty(args.blocks[0], 'text', { enumerable: true, get })
    await denied(f.run(op, args), location === 'nested card' ? 'invalid_display_card' : 'invalid_arguments')
    assert.equal(reads, 0)
    assert.equal(f.calls.length, 0)
  })
})

test('bad directory records fail closed rather than returning unverified candidates', async t => {
  const badUIDs = ['.', '..', 'all', 'all_bots', '-1', '-2', '-3', 'a@b', 's1:person', topic, '张三', 'a/b']
  for (const uid of badUIDs) await t.test(uid, async t => {
    const f = fixture(t); f.state.directory = [{ uid, robot: 0, name: 'PRIVATE_RAW' }]
    await denied(f.run(resolveOp), 'invalid_member_response')
    assert.equal(f.writes.length, 0)
  })
  for (const [label, rows] of [
    ['duplicate', [{ uid: 'colleague', robot: 0, name: 'One' }, { uid: 'colleague', robot: 0, name: 'Two' }]],
    ['robot string', [{ uid: 'colleague', robot: '0', name: 'Name' }]],
    ['missing robot', [{ uid: 'colleague', name: 'Name' }]],
  ]) await t.test(label, async t => {
    const f = fixture(t); f.state.directory = rows
    await denied(f.run(resolveOp), 'invalid_member_response')
  })
})

test('source/recipient/Space loss during lookup, upload, profile or final metadata blocks dispatch', async t => {
  const phases = ['lookup', 'before upload', 'after upload', 'profile', 'final metadata']
  const changes = [
    ['requester left', f => f.state.deniedPrincipals.set('requester', ['not_space_member', 403]), 'api_permission_denied'],
    ['recipient left', f => f.state.deniedPrincipals.set('colleague', ['not_space_member', 403]), 'api_permission_denied'],
    ['Space revoked', f => { f.state.spaceActive = false }, 'api_permission_denied'],
    ['Bot disabled', f => { f.state.botActive = false }, 'api_unavailable'],
    ['account revoked', f => f.api.revoke(), 'account_configuration_changed'],
    ['cancelled', f => f.controller.abort(), 'aborted'],
  ]
  for (const phase of phases) for (const op of phase.includes('upload') ? [fileOp] : phase === 'profile' ? [cardOp] : sends) {
    for (const [label, change, code] of changes) await t.test(`${op}/${phase}/${label}`, async t => {
      const f = fixture(t)
      let changed = false, ready = false, metadata = 0
      const mutate = async () => { await Promise.resolve(); changed = true; change(f) }
      if (phase === 'before upload') f.state.beforeUpload = mutate
      if (phase === 'after upload') f.state.afterUpload = mutate
      if (phase === 'final metadata') f.state.afterUpload = () => { ready = true }
      f.state.intercept = async call => {
        if (call.path === profilePath) {
          ready = true
          if (phase === 'profile') await mutate()
        }
        if (call.path !== infoPath) return
        metadata++
        if (phase === 'lookup' || phase === 'final metadata' && (ready || op === sendOp && metadata > 1)) await mutate()
      }
      await denied(f.run(op), code)
      assert.equal(changed, true, 'the intended await boundary was reached')
      assert.equal(f.writes.length, 0)
      assert.equal(f.uploads.length, phase === 'after upload' || phase === 'final metadata' && op === fileOp ? 1 : 0)
    })
  }
})

test('resolver revocation during directory or exact-principal lookup never releases a stale candidate', async t => {
  for (const phase of [directoryPath, principalPath + 'colleague']) for (const kind of ['revoke', 'abort', 'source access']) {
    await t.test(`${phase}/${kind}`, async t => {
      const f = fixture(t)
      let changed = false
      f.state.intercept = async call => {
        if (call.path !== phase || changed) return
        await Promise.resolve(); changed = true
        if (kind === 'revoke') f.api.revoke()
        else if (kind === 'abort') f.controller.abort()
        else f.state.sourceDenied = true
      }
      await denied(f.run(resolveOp), kind === 'revoke' ? 'account_configuration_changed'
        : kind === 'abort' ? 'aborted' : 'api_permission_denied')
      assert.equal(changed, true)
      assert.equal(f.writes.length, 0)
    })
  }
})

test('confirmed file plus rejected or uncertain caption preserves only the known delivery outcome', async t => {
  const cases = [
    ['friendship denied', () => failure('not_friend'), 'not_sent'],
    ['rate limited', () => new Response('PRIVATE_RAW', { status: 429 }), 'not_sent'],
    ['missing receipt', () => ({}), 'unconfirmed'],
    ['invalid receipt', () => ({ message_id: 'not-an-id' }), 'unconfirmed'],
    ['out of range', () => ({ message_id: '9223372036854775808' }), 'unconfirmed'],
    ['server error', () => failure('send_failed', 500), 'unconfirmed'],
    ['network failure', () => { throw Error('PRIVATE_RAW ' + uploadURL) }, 'unconfirmed'],
  ]
  for (const [label, outcome, status] of cases) await t.test(label, async t => {
    const f = fixture(t), caption = '## Approved caption\nEvery line remains intact.  \n'
    f.state.send = (_, n) => n === 1 ? { message_id: firstId } : outcome()
    assertPartial(await f.run(fileOp, { ...inputFor(fileOp), caption }), status)
    assert.equal(f.writes.length, 2)
    assert.equal(f.uploads.length, 1)
    assert.deepEqual(f.writes[1].body.payload, { type: 1, content: caption })
  })
})

test('authority loss between acknowledged file and caption prevents the second send without retrying the file', async t => {
  for (const kind of ['source', 'recipient', 'Space', 'revoke', 'abort']) await t.test(kind, async t => {
    const f = fixture(t)
    let changed = false
    f.state.intercept = call => {
      if (f.writes.length !== 1 || call.path !== syncPath) return
      changed = true
      if (kind === 'source') f.state.sourceDenied = true
      if (kind === 'recipient') f.state.deniedPrincipals.set('colleague', ['not_space_member', 403])
      if (kind === 'Space') f.state.spaceActive = false
      if (kind === 'revoke') f.api.revoke()
      if (kind === 'abort') f.controller.abort()
    }
    assertPartial(await f.run(fileOp, { ...inputFor(fileOp), caption: 'Send after the file.' }), 'not_sent')
    assert.equal(changed, true)
    assert.equal(f.writes.length, 1)
    assert.equal(f.uploads.length, 1)
  })
})

test('valid initial send acknowledgements survive in-flight revocation/cancellation without stale content or a second send', async t => {
  for (const op of sends) for (const kind of ['revoke', 'abort']) for (const caption of op === fileOp ? [undefined, 'Approved caption'] : [undefined]) {
    await t.test(`${op}/${kind}/caption=${caption !== undefined}`, async t => {
      const f = fixture(t), input = { ...inputFor(op), ...(caption !== undefined && { caption }) }
      f.state.send = async () => {
        await Promise.resolve()
        if (kind === 'revoke') f.api.revoke()
        else f.controller.abort()
        return { message_id: firstId, ...extras }
      }
      assert.deepEqual(await f.run(op, input), { ok: caption === undefined, message_id: firstId,
        sent_as: 'bot', authority_changed: true, requiresFinalSummary: true,
        ...(caption !== undefined && { partial: true, caption_status: 'not_sent', retry_whole_delivery: false }) })
      assert.equal(f.writes.length, 1)
      assert.equal(f.uploads.length, op === fileOp ? 1 : 0)
    })
  }
})

test('acknowledged final caption retains both message IDs after revocation/cancellation with no recipient or content data', async t => {
  for (const kind of ['revoke', 'abort']) await t.test(kind, async t => {
    const f = fixture(t)
    f.state.send = async (_, n) => {
      if (n === 1) return { message_id: firstId }
      await Promise.resolve()
      if (kind === 'revoke') f.api.revoke()
      else f.controller.abort()
      return { message_id: captionId, ...extras }
    }
    assert.deepEqual(await f.run(fileOp, { ...inputFor(fileOp), caption: 'Approved caption' }), {
      ok: true, message_id: firstId, caption_message_id: captionId, sent_as: 'bot',
      authority_changed: true, requiresFinalSummary: true,
    })
    assert.equal(f.writes.length, 2)
    assert.equal(f.uploads.length, 1)
  })
})

test('invalid or error-shaped send acknowledgements stay uncertain after in-flight revocation/cancellation', async t => {
  const outcomes = [
    ['missing', () => ({})], ['zero', () => ({ message_id: '0' })],
    ['too large', () => ({ message_id: '9223372036854775808' })],
    ['rounded number', () => ({ message_id: Number(firstId) })],
    ['error body with ID', () => ({ message_id: firstId, error: { message: 'PRIVATE_RAW' } })],
    ['failed status with ID', () => ({ message_id: firstId, status: 403 })],
    ['network failure', () => { throw Error('PRIVATE_RAW ' + uploadURL) }],
  ]
  for (const op of sends) for (const kind of ['unchanged', 'revoke', 'abort']) for (const [label, outcome] of outcomes) {
    await t.test(`${op}/${kind}/${label}`, async t => {
      const f = fixture(t), input = inputFor(op)
      if (op === fileOp) input.caption = 'No second send.'
      f.state.send = async () => {
        await Promise.resolve()
        if (kind === 'revoke') f.api.revoke()
        else if (kind === 'abort') f.controller.abort()
        return outcome()
      }
      await denied(f.run(op, input), 'mutation_unconfirmed')
      assert.equal(f.writes.length, 1)
    })
  }
  for (const kind of ['revoke', 'abort']) await t.test(`caption/${kind}`, async t => {
    const f = fixture(t)
    f.state.send = (_, n) => {
      if (n === 1) return { message_id: firstId }
      if (kind === 'revoke') f.api.revoke()
      else f.controller.abort()
      return { message_id: 'invalid', ...extras }
    }
    assertPartial(await f.run(fileOp, { ...inputFor(fileOp), caption: 'No retry.' }), 'unconfirmed')
    assert.equal(f.writes.length, 2)
  })
})

test('mutating arguments, admitted route and external account config across awaits cannot redirect or impersonate', async t => {
  for (const phase of ['lookup', 'upload', 'profile', 'send']) for (const op of phase === 'upload' ? [fileOp]
    : phase === 'profile' ? [cardOp] : sends) await t.test(`${op}/${phase}`, async t => {
    const f = fixture(t), input = inputFor(op), route = { ...source }
    if (op === fileOp) input.caption = 'Approved caption\n  preserved'
    const before = structuredClone(input)
    const gate = Promise.withResolvers(), entered = Promise.withResolvers()
    let held = false
    const hold = async () => { if (held) return; held = true; entered.resolve(); await gate.promise }
    if (phase === 'upload') f.state.afterUpload = hold
    else f.state.intercept = call => {
      if (call.path === (phase === 'lookup' ? infoPath : phase === 'profile' ? profilePath : sendPath)) return hold()
    }
    const pending = f.run(op, input, { route })
    t.after(() => gate.resolve())
    await entered.promise
    try {
      input.target.channel_id = 'second-person'; input.target.channel_type = 2
      input.confirm_send = false; input.on_behalf_of = 'another-owner'
      route.channel_id = 'second-person'; route.channel_type = 2
      f.config.apiBase = 'https://other.invalid'; f.config.token = 'FAKE_OTHER_ACCOUNT'
      f.config.spaceId = 'other-space'; f.config.botUid = 'other-bot'; f.config.ownerUid = 'requester'
      if (op === sendOp) input.text = 'Changed text'
      if (op === fileOp) { input.path = 'changed.pdf'; input.caption = 'Changed caption' }
      if (op === cardOp) { input.title = 'Changed title'; input.blocks[0].text = 'Changed card'; input.blocks.push({ type: 'Action.Submit' }) }
    } finally { gate.resolve() }
    const result = await pending
    assertReceipt(result, op)
    assert.equal(result.ok, true)
    f.writes.forEach(call => assertRoute(call.body))
    if (op === sendOp) assert.deepEqual(f.writes[0].body.payload, { type: 1, content: before.text })
    if (op === fileOp) {
      assert.deepEqual(f.uploads, [before.path])
      assert.deepEqual(f.writes[1].body.payload, { type: 1, content: before.caption })
    }
    if (op === cardOp) assert.equal(f.writes[0].body.payload.plain, 'Daily report\nReady for review.')
    assert.doesNotMatch(JSON.stringify(f.calls), /Changed|changed\.pdf|other-space|other-bot|on_behalf_of|FAKE_OTHER_ACCOUNT/)
  })
})

test('discovery snapshots its query before waiting and never releases raw directory secrets', async t => {
  const f = fixture(t), args = { name: '同事', page: 2, limit: 3 }
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  let held = false
  f.state.intercept = async call => {
    if (held || call.path !== syncPath) return
    held = true; entered.resolve(); await gate.promise
  }
  const pending = f.run(resolveOp, args)
  t.after(() => gate.resolve())
  await entered.promise
  args.name = 'PRIVATE_RAW'; args.page = 100; args.limit = 5; args.space_id = 'elsewhere'
  gate.resolve()
  const result = await pending
  const call = f.calls.find(call => call.path === directoryPath)
  assert.deepEqual(call.query, { space_id: 'fixed-space', keyword: '同事', page: '2', limit: '3' })
  assert.equal(result.page, 2)
  assert.equal(result.needs_choice, true)
  noLeaks(result)
})

test('prepared media cannot smuggle sender/route/callback fields into a person DM', async t => {
  const f = fixture(t), clean = { ...f.state.file }
  f.state.afterUpload = () => Object.assign(f.state.file, { channel_id: 'second-person', channel_type: 2,
    on_behalf_of: 'another-owner', reply: { message_id: '1' }, callback: 'PRIVATE_RAW',
    payload: { type: 17 }, card: { actions: [{ type: 'Action.Submit' }] } })
  let reads = 0
  Object.defineProperty(f.state.file, 'callback_url', { get() { reads++; return uploadURL }, enumerable: true })
  assertReceipt(await f.run(fileOp), fileOp)
  assert.equal(reads, 0)
  assert.deepEqual(f.writes[0].body, { ...target, payload: clean })
  assert.equal(f.writes.length, 1)
})

test('unavailable file runtime, invalid prepared media and disabled display profile do not dispatch', async t => {
  const unavailable = fixture(t)
  await denied(unavailable.run(fileOp, inputFor(fileOp), { runtime: {} }), 'file_delivery_unavailable')
  assert.equal(unavailable.writes.length, 0)
  for (const [label, patch] of [
    ['wrong type', { type: 17 }], ['insecure URL', { url: 'http://uploads.invalid/file' }],
    ['URL credentials', { url: 'https://user:pass@uploads.invalid/file' }], ['URL fragment', { url: uploadURL + '#private' }],
    ['negative size', { size: -1 }], ['oversized file', { size: 20 * 1024 * 1024 + 1 }], ['empty name', { name: '' }],
  ]) await t.test(label, async t => {
    const f = fixture(t); Object.assign(f.state.file, patch)
    await denied(f.run(fileOp), 'invalid_prepared_file')
    assert.equal(f.writes.length, 0)
  })
  const card = fixture(t)
  card.state.profile.config.display_enabled = false
  await denied(card.run(cardOp), 'display_card_unavailable')
  assert.equal(card.writes.length, 0)
})

test('directory errors, oversized pages and malformed response bodies cannot become successful discovery', async t => {
  for (const [label, response, code] of [
    ['request denied', () => failure(), 'api_permission_denied'],
    ['server error', () => failure('query_failed', 500), 'api_server_error'],
    ['oversized page', () => Array.from({ length: 6 }, (_, i) => ({ uid: 'p' + i, name: 'Person', robot: 0 })), 'response_limit_exceeded'],
    ['object instead of rows', () => ({ candidates: [{ uid: 'colleague', name: 'PRIVATE_RAW' }] }), 'invalid_api_response'],
  ]) await t.test(label, async t => {
    const f = fixture(t); f.state.directoryError = response
    await denied(f.run(resolveOp), code)
    assert.equal(f.writes.length, 0)
    assert.equal(f.uploads.length, 0)
  })
})

test('final candidate refresh cannot conceal lost Space, requester or Bot eligibility', async t => {
  // Pinned space_principal.go:62-66 and db.go:436-444 deliberately use the same
  // user_not_found/404 for an absent target, inactive Space or ineligible caller.
  // Keep ordinary DM friendship valid: a source sync cannot detect this loss.
  const global404 = f => {
    for (const uid of f.state.principals.keys()) f.state.deniedPrincipals.set(uid, ['user_not_found', 404])
  }
  const cases = [
    ['Space inactive / global 404', global404, 'api_not_found'],
    ['calling UserBot loses membership / global 404', global404, 'api_not_found'],
    ['current requester removed', f => f.state.deniedPrincipals.set('requester', ['user_not_found', 404]), 'api_not_found'],
    ['current requester no longer human', f => { f.state.principals.get('requester').principal_type = 'user_bot' }, 'requester_not_allowed'],
    ['current Bot no longer UserBot', f => { f.state.principals.get('bot').principal_type = 'human' }, 'requester_not_allowed'],
    // A single departed candidate still gets filtered when global authority is
    // intact; the fix must not turn every candidate 404 into a whole-page error.
    ['only last candidate removed', f => f.state.deniedPrincipals.set('second-person', ['user_not_found', 404])],
  ]
  for (const [label, change, code] of cases) await t.test(label, async t => {
    const f = fixture(t)
    f.state.directory = [
      { uid: 'colleague', name: '同名', robot: 0 },
      { uid: 'second-person', name: '同名', robot: 0 },
    ]
    let firstReads = 0, lastReads = 0, changed = false
    f.state.intercept = async call => {
      if (call.path === principalPath + 'colleague') firstReads++
      if (call.path !== principalPath + 'second-person' || ++lastReads !== 2) return
      // Both candidates passed the initial sweep. The first candidate has also
      // passed the final sweep before qualification changes during the last one.
      assert.equal(firstReads, 2)
      await Promise.resolve()
      change(f)
      changed = true
    }
    const pending = f.run(resolveOp, { name: '同名', limit: 5, page: 1 })
    if (code) await denied(pending, code)
    else assert.deepEqual(await pending, { candidates: [{ ...target, name: '同名' }],
      page: 1, more: false, scope: 'configured_space_humans', friendship_checked: false, needs_choice: false })
    assert.equal(changed, true, 'qualification changed during the final candidate lookup')
    assert.equal(lastReads, 2)
    assert.equal(f.state.sourceDenied, false, 'ordinary source friendship remains valid')
    assert.equal(f.calls.filter(call => call.path === directoryPath).length, 1)
    assert.equal(f.prepares.length, 0)
    assert.equal(f.uploads.length, 0)
    assert.equal(f.writes.length, 0)
  })
})
