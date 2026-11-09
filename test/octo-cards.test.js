import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCard, parseCardAction, resolveCardAction, sendCard } from '../src/octo-cards.js'

const account = { apiBase: 'https://octo.invalid/api/', botUid: 'bot', spaceId: 'space-a', token: 'bf_fixture' }
const dm = { channel_id: 'alice', channel_type: 1 }
const group = { channel_id: 'group-a', channel_type: 2, operatorUid: 'alice' }
const topic = { channel_id: '1'.repeat(32) + '____' + '2'.repeat(19), channel_type: 5, operatorUid: 'alice' }
const messageId = '9223372036854775806'
const eventId = '9223372036854775807'
const display = { title: 'Status', text: 'Ready' }
const confirmation = { title: 'Confirm selection', actions: [{ id: 'confirm', label: 'Confirm' }] }
const choice = {
  ...confirmation,
  actions: [...confirmation.actions, { id: 'record', label: 'Record choice' }],
  choice: {
    id: 'color', label: 'Pick a color',
    options: [{ title: 'Red', value: 'red' }, { title: 'Blue', value: 'blue' }],
  },
}
const manifest = {
  enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'],
  elements: ['TextBlock'], inputs: ['Input.ChoiceSet'], actions: ['Action.OpenUrl'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
  limits: { max_payload_bytes: 524288, max_nodes: 200, max_depth: 16 },
}
const json = (data, init) => new Response(JSON.stringify(data), init)

function fixture({
  profile = () => json(manifest),
  post = () => new Response('{"message_id":9223372036854775806,"message_seq":8}'),
  config = {},
} = {}) {
  const calls = []
  const fetchImpl = async (url, request) => {
    calls.push({ url, ...request, body: request.body === undefined ? undefined : JSON.parse(request.body) })
    if (url === 'https://octo.invalid/api/v1/bot/card/profile') return profile(request)
    if (url === 'https://octo.invalid/api/v1/bot/sendMessage') return post(request)
    throw new Error('unexpected fixture request')
  }
  return { config: { ...account, ...config, fetchImpl }, calls }
}

// octo-server modules/message/api_card_action.go: event_data comes from the stored
// effective frame and the authenticated operator; the DM address is the Bot's peer.
function click(overrides = {}, outer = {}) {
  return {
    event_id: eventId, event_type: 'card_action',
    event_data: {
      message_id: messageId, channel_id: 'alice', channel_type: 1, action_id: 'confirm',
      inputs: null, operator_uid: 'alice', client_token: 'ui-correlation', acted_at: 1794180000,
      space_id: 'space-a', ...overrides,
    },
    ...outer,
  }
}

test('builds Octo v1 display and v2 top-level submit and single-choice payloads', () => {
  assert.deepEqual(createCard(display), {
    type: 17, profile: 'octo/v1', card_version: '1.5', plain: 'Status\nReady',
    card: {
      type: 'AdaptiveCard', version: '1.5', body: [
        { type: 'TextBlock', text: 'Status', weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: 'Ready', wrap: true },
      ],
    },
  })
  const payload = createCard({ ...choice, text: '[link](javascript:bad) <img>' })
  assert.equal(payload.profile, 'octo/v2')
  assert.deepEqual(payload.card.actions, [
    { type: 'Action.Submit', id: 'confirm', title: 'Confirm' },
    { type: 'Action.Submit', id: 'record', title: 'Record choice' },
  ])
  assert.equal(payload.card.body[1].text, '\\[link\\](javascript:bad) \\<img\\>')
  assert.deepEqual(payload.card.body[2], {
    type: 'Input.ChoiceSet', id: 'color', label: 'Pick a color', isRequired: true,
    isMultiSelect: false, style: 'expanded',
    choices: [{ title: 'Red', value: 'red' }, { title: 'Blue', value: 'blue' }],
  })
})

test('rejects caller-supplied wire fields, duplicate IDs and choices, and oversized form content', () => {
  for (const form of [
    { ...display, catalog_provenance: {} }, { ...display, card: {} }, { ...display, template_ref: {} },
    { ...display, title: '测'.repeat(54) }, { ...display, text: 'a'.repeat(2049) },
    { ...display, actions: [{ id: 'open', label: 'Open', url: 'https://example.invalid' }] },
    { ...display, actions: [{ id: 'confirm', label: 'Confirm', data: { owner: 'internal' } }] },
    { ...display, actions: Array.from({ length: 5 }, (_, n) => ({ id: 'a' + n, label: 'Pick' })) },
    { ...choice, actions: [confirmation.actions[0], confirmation.actions[0]] },
    { ...choice, actions: [] },
    { ...choice, choice: { ...choice.choice, id: 'confirm' } },
    { ...choice, choice: { ...choice.choice, options: [choice.choice.options[0], choice.choice.options[0]] } },
  ]) assert.throws(() => createCard(form), { code: 'invalid_card_form' })
})

test('normalizes the typed event and keeps 64-bit IDs, optional Space, and untrusted inputs separate', () => {
  const raw = JSON.stringify(click({
    space_id: undefined, inputs: { count: 0, enabled: false, text: ' x\ny ' },
    data: { owner: 'internal', action_type: 'run', operator_uid: 'spoof', action_id: 'spoof' },
  })).replace(`"${eventId}"`, eventId)
  assert.deepEqual(parseCardAction(raw), {
    eventId, messageId, channelId: 'alice', channelType: 1, actionId: 'confirm', operatorUid: 'alice',
    spaceId: undefined, actedAt: 1794180000, inputs: { count: '0', enabled: 'false', text: ' x\ny ' },
    cardNonce: undefined,
  })
  assert.deepEqual(parseCardAction(click()).inputs, {})
  assert.equal(parseCardAction(click({ channel_id: group.channel_id, channel_type: 2 })).channelId, group.channel_id)
  assert.equal(parseCardAction(click({ channel_id: topic.channel_id, channel_type: 5 })).channelId, topic.channel_id)
})

test('rejects malformed inputs and identities instead of converting a malformed event into a valid click', () => {
  const hugeInputs = Object.fromEntries(Array.from({ length: 5 }, (_, n) => ['a' + n, 'x'.repeat(4096)]))
  for (const event of [
    ' '.repeat(65537), '{', [],
    { message: { payload: { type: 17, event: 'card_action' } } },
    click({}, { event_type: 'bot_task' }), click({}, { event_id: Number(eventId) }), click({}, { message: {} }),
    click({ message_id: '9223372036854775808' }), click({ channel_type: '1' }),
    click({ channel_id: 'alice@bot' }), click({ channel_id: 'bot' }), click({ operator_uid: undefined }),
    click({ inputs: [] }), click({ inputs: { color: {} } }), click({ inputs: { color: null } }),
    click({ inputs: { color: Infinity } }), click({ inputs: { color: '测'.repeat(1366) } }),
    click({ inputs: hugeInputs }), click({ data: [] }),
    click({ inputs: JSON.parse('{"__proto__":"bad"}') }), click({ inputs: { constructor: 'bad' } }),
  ]) assert.equal(parseCardAction(event), null)
})

test('probes effective capability, sends only bot-authorized wire fields, and returns a confirmed ID', async () => {
  const { config, calls } = fixture({
    config: { token: 'app_fixture' },
    profile: () => json({ ...manifest, config: { ...manifest.config, interaction_enabled: false } }),
  })
  assert.deepEqual(await sendCard(config, dm, display), { messageId, binding: null })
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['https://octo.invalid/api/v1/bot/card/profile', 'GET'],
    ['https://octo.invalid/api/v1/bot/sendMessage', 'POST'],
  ])
  for (const request of calls) {
    assert.equal(request.headers.Authorization, 'Bearer app_fixture')
    assert.equal(request.redirect, 'manual')
    assert.ok(request.signal instanceof AbortSignal)
  }
  assert.equal(calls[0].body, undefined)
  const { client_msg_no: clientMsgNo, ...request } = calls[1].body
  assert.match(clientMsgNo, /^[a-f0-9]{32}$/)
  assert.deepEqual(request, { ...dm, payload: createCard(display) })
})

test('fails closed on denied capability, undersized manifest limits, and invalid local routes', async () => {
  const denied = [
    () => json({ ...manifest, enabled: false }),
    () => json({ ...manifest, available: false }),
    () => json({ ...manifest, config: undefined }),
    () => json({ ...manifest, config: { ...manifest.config, display_enabled: false } }),
    () => json({ ...manifest, config: { ...manifest.config, interaction_enabled: false } }),
    () => json({ ...manifest, profiles: ['octo/v1'] }),
    () => json({ ...manifest, card_version: '1.4' }),
    () => json({ ...manifest, inputs: [] }),
    () => json({ ...manifest, limits: { max_nodes: 2 } }),
    () => json({ ...manifest, limits: { max_payload_bytes: 150 } }),
    () => json({ ...manifest, limits: [] }),
  ]
  for (const profile of denied) {
    const { config, calls } = fixture({ profile })
    await assert.rejects(sendCard(config, dm, choice), { code: 'card_profile_unavailable' })
    assert.equal(calls.length, 1)
  }
  const missing = fixture({ profile: () => new Response('', { status: 404 }) })
  await assert.rejects(sendCard(missing.config, dm, choice), { code: 'http_404' })
  assert.equal(missing.calls.length, 1)
  const { config, calls } = fixture()
  await assert.rejects(sendCard({ ...config, token: 'app_fixture' }, group, display), { code: 'card_app_bot_dm_only' })
  await assert.rejects(sendCard(config, { ...dm, on_behalf_of: 'alice' }, display), { code: 'invalid_card_route' })
  await assert.rejects(sendCard(config, { ...dm, operatorUid: 'other' }, confirmation), { code: 'invalid_card_operator' })
  await assert.rejects(sendCard(config, { channel_id: group.channel_id, channel_type: 2 }, confirmation), { code: 'invalid_card_operator' })
  assert.equal(calls.length, 0)
})

test('surfaces the server refusal or ambiguous send without retry, fallback, or binding', async () => {
  for (const [post, expected] of [
    [() => json({ msg: 'denied' }, { status: 403 }), { code: 'http_403', status: 403 }],
    [() => json({}, { status: 429, headers: { 'Retry-After': '3' } }), { code: 'http_429', retryAfterMs: 3000 }],
    [() => json({ status: 1 }), { code: 'card_send_unconfirmed' }],
  ]) {
    const { config, calls } = fixture({ post })
    await assert.rejects(sendCard(config, dm, confirmation), expected)
    assert.equal(calls.length, 2)
  }
  const controller = new AbortController()
  const { config, calls } = fixture({ profile: () => { controller.abort(); return json(manifest) } })
  await assert.rejects(sendCard(config, dm, display, controller.signal), { name: 'AbortError' })
  assert.equal(calls.length, 1)
})

test('binds the server echo to the authored card and original conversation for DM, group and topic', async () => {
  for (const route of [dm, group, topic]) {
    const { config, calls } = fixture()
    const { binding } = await sendCard(config, route, choice)
    const { payload, ...request } = calls[1].body
    assert.deepEqual(Object.keys(request).sort(), ['channel_id', 'channel_type', 'client_msg_no'])
    assert.equal(request.channel_id, route.channel_id)
    assert.equal(request.channel_type, route.channel_type)
    const [{ data }, second] = payload.card.actions
    assert.match(data.dsh_card_nonce, /^[a-f0-9]{32}$/)
    assert.deepEqual(Object.keys(data), ['dsh_card_nonce'])
    assert.deepEqual(second.data, data)
    assert.equal(JSON.stringify(binding).includes(config.token), false)

    const echo = {
      data, channel_id: route.channel_id, channel_type: route.channel_type, inputs: { color: 'blue' },
    }
    // Persisted binding is a local snapshot, not something read from the incoming event.
    const saved = JSON.parse(JSON.stringify(binding))
    const candidate = resolveCardAction(click(echo), saved, config)
    assert.deepEqual(candidate, {
      cardKey: candidate.cardKey, eventId, messageId, operatorUid: 'alice', actionId: 'confirm', selection: 'blue',
      route: { channel_id: route.channel_id, channel_type: route.channel_type },
    })
    const replay = resolveCardAction(click({ ...echo, client_token: 'different' }), saved, config)
    assert.deepEqual(replay, candidate)
    const other = resolveCardAction(click({ ...echo, action_id: 'record', inputs: { color: 'red' } }, { event_id: '8' }), saved, config)
    assert.equal(other.cardKey, candidate.cardKey)
    assert.notEqual(other.eventId, candidate.eventId)
    assert.equal(other.selection, 'red')
  }
})

test('requires the matching account, source Space, operator, frame, and declared choice before routing', async () => {
  const { config, calls } = fixture()
  const { binding } = await sendCard(config, group, choice)
  const data = calls[1].body.payload.card.actions[0].data
  const echo = { data, channel_id: group.channel_id, channel_type: 2, inputs: { color: 'blue' } }
  for (const changes of [
    { space_id: undefined }, { space_id: 'space-b' }, { message_id: '7' }, { data: undefined },
    { data: { dsh_card_nonce: '0'.repeat(32) } }, { action_id: 'run_tool' },
    { channel_id: 'other-group' }, { channel_type: 1, channel_id: 'alice' },
    { operator_uid: 'mallory', data: { ...data, operator_uid: 'alice' } },
    { inputs: null }, { inputs: { color: '' } }, { inputs: { color: 'green' } },
    { inputs: { color: 'blue', action_id: 'confirm' } },
  ]) assert.equal(resolveCardAction(click({ ...echo, ...changes }), binding, config), null)
  for (const changes of [{ apiBase: 'https://another.invalid' }, { botUid: 'another-bot' }, { spaceId: 'space-b' }]) {
    assert.equal(resolveCardAction(click(echo), binding, { ...config, ...changes }), null)
  }
  assert.equal(resolveCardAction(click(echo), null, config), null)
  assert.equal(resolveCardAction(click({ ...echo, inputs: null }), { ...binding, choice: undefined }, config), null)
  assert.equal(resolveCardAction(click(echo), binding, config, binding.expiresAt), null)
  assert.ok(resolveCardAction(click(echo), binding, config, binding.expiresAt - 1))
})

test('accepts an authored confirmation with no inputs and does not return submit metadata', async () => {
  const { config, calls } = fixture()
  const { binding } = await sendCard(config, dm, confirmation)
  const data = calls[1].body.payload.card.actions[0].data
  const candidate = resolveCardAction(click({ data: { ...data, owner: 'unused', action_type: 'run_tool' } }), binding, config)
  assert.equal(candidate.actionId, 'confirm')
  assert.equal('selection' in candidate, false)
  assert.equal('data' in candidate, false)
  assert.equal(resolveCardAction(click({ data, inputs: { command: 'run_tool' } }), binding, config), null)
})
