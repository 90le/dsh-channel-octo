import assert from 'node:assert/strict'
import test from 'node:test'
import { OctoError, readApiError } from '../src/api-errors.js'
import { ChannelApi } from '../src/channel-api.js'
import { discoverRegistryCards, editRegistryCard, RegistryCardError, registryCardParameters,
  sendRegistryCard } from '../src/registry-cards.js'

const profilePath = '/v1/bot/card/profile'
const sendPath = '/v1/bot/sendMessage'
const editPath = '/v1/bot/message/edit'
const route = { channel_id: 'test-human', channel_type: 1 }
const groupRoute = { channel_id: 'test-group', channel_type: 2 }
const botUid = 'test-bot'
const messageId = '9007199254740999'
const processRef = { id: 'ai.reasoning-process', version: '0.4.1' }
// The pinned Bot server only ships the process template. This synthetic
// additive catalog exercises the wire contract without pretending it's live.
const noticeRef = { id: 'test.notice', version: '2.1.0' }
const view = (name, states, wire_profile = 'octo/v1', submit_actions = []) => ({ name, states, wire_profile, submit_actions })
const processTemplate = {
  ...processRef, views: [
    view('active', ['reasoning', 'answering'], 'octo/v2'),
    view('result', ['completed', 'stopped']),
    view('error', ['error'], 'octo/v2'),
  ],
}
const noticeTemplate = {
  ...noticeRef, views: [view('result', ['ready', 'updated']), view('confirm', ['pending'], 'octo/v2', ['test_confirm'])],
}

function profile({ templates = [processTemplate, noticeTemplate], display = true } = {}) {
  return structuredClone({
    enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'],
    config: { card_enabled: true, display_enabled: display, interaction_enabled: display,
      reasoning_enabled: true, reasoning_template_ref: processRef },
    templating: { supported: true, wire: 'template-ref/v1', templates },
    limits: { max_payload_bytes: 512 * 1024 },
  })
}

const sendArgs = (state = 'ready') => ({ template_ref: { ...noticeRef }, state,
  data: { state, title: 'Delivery summary', fields: [{ label: 'Files', value: 2 }, { label: 'Ready', value: true }] } })
const editArgs = (state = 'updated') => ({ ...sendArgs(state), message_id: messageId })

function cardFrame({ seq, marker = noticeRef, principal = botUid, wire = 'octo/v1', space = 'test-space' } = {}) {
  return {
    type: 17, profile: wire, card_version: '1.5', render_profile: 'octo-chat/v1',
    template_ref: { ...marker },
    catalog_provenance: { version: 1, principal_type: 'bot', principal_id: principal, space_id: space },
    space_id: space,
    card: { type: 'AdaptiveCard', version: '1.5', body: [],
      metadata: { octo: { protocol: 'octo-card@1.0', template: { ...marker }, variant: 'result' } } },
    plain: 'Server-rendered fixture',
    ...(seq !== undefined && { card_seq: seq }),
  }
}

function source({ seq, original = cardFrame(), target = route, effective } = {}) {
  return {
    ...target, from_uid: botUid, message_id: messageId, message_seq: 13,
    payload: Buffer.from(JSON.stringify(original)).toString('base64'),
    ...(seq !== undefined && { message_extra: { content_edit: effective ?? cardFrame({ seq }) } }),
  }
}

test('channel dispatch uses live host admission and passes an exact visible Registry source', async t => {
  const requests = []
  const channel = new ChannelApi({
    config: { botUid, spaceId: 'test-space', botKind: 'user' },
    request: async (path, body) => {
      requests.push({ path, body: body && JSON.parse(body) })
      if (path === '/v1/bot/messages/sync') return { messages: [] }
      if (path === profilePath) return profile()
      if (path === editPath) return { status: 200 }
      if (path === '/v1/bot/messages/person/test-human/' + messageId) return source()
      assert.fail(path)
    },
  })
  const runtime = { authorizeRegistry: async () => true, registryActive: () => true }
  await assert.rejects(channel.dispatch(route, route.channel_id, 'cards.registry.edit', editArgs(), t.signal),
    { code: 'registry_access_denied' })
  assert.deepEqual(requests, [])
  const result = await channel.dispatch(route, route.channel_id, 'cards.registry.edit', editArgs(), t.signal, runtime)
  assert.equal(result.card_seq, 1)
  assert.equal(requests.filter(x => x.path === editPath).length, 1)
  assert.equal(requests.at(-1).body.message_id, messageId)
})

function fixture({ manifests = [profile()], replies = [{ message_id: messageId }], sources = [source()], authority = [true] } = {}) {
  const steps = [], writes = []
  let probes = 0, checks = 0, reads = 0
  async function reply(value) {
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value() : value
  }
  return {
    steps, writes,
    authorize: async signal => {
      assert.ok(signal instanceof AbortSignal)
      steps.push('authorize')
      return reply(authority[Math.min(checks++, authority.length - 1)])
    },
    call: async (path, body, signal) => {
      assert.ok(signal instanceof AbortSignal)
      steps.push(path)
      if (path === profilePath) {
        assert.equal(body, undefined)
        return reply(manifests[Math.min(probes++, manifests.length - 1)])
      }
      assert.ok([sendPath, editPath].includes(path), 'must use a fixed Bot path')
      writes.push({ path, body: JSON.parse(JSON.stringify(body)) })
      return reply(replies[writes.length - 1])
    },
    readSource: async (id, signal) => {
      assert.equal(id, messageId)
      assert.ok(signal instanceof AbortSignal)
      steps.push('source')
      return reply(sources[Math.min(reads++, sources.length - 1)])
    },
  }
}

const errorIs = code => error => {
  assert.ok(error instanceof RegistryCardError)
  assert.equal(error.code, code)
  assert.doesNotMatch(error.message, /private fixture detail/)
  return true
}

test('discovers the formal Bot catalog without exposing its process states as writable', async () => {
  const f = fixture({ manifests: [profile({ templates: [processTemplate] })] })
  const result = await discoverRegistryCards(f)
  assert.equal(result.wire, 'template-ref/v1')
  assert.deepEqual(result.templates, [{
    ...processRef, available: true, reserved: true,
    views: processTemplate.views.map(item => ({ ...item, writable: false })),
  }])
  assert.deepEqual(f.steps, ['authorize', profilePath, 'authorize'])
  await assert.rejects(sendRegistryCard({ ...f, route, args: {
    template_ref: processRef, state: 'completed', data: { state: 'completed' },
  } }), errorIs('registry_card_reserved'))
  await assert.rejects(editRegistryCard({ ...f, route, botUid, args: {
    template_ref: processRef, state: 'stopped', data: { state: 'stopped' }, message_id: messageId,
  } }), errorIs('registry_card_reserved'))
  assert.deepEqual(f.writes, [])
})

test('reports callback states as read-only and delegates display rendering to the authenticated Bot API', async () => {
  const f = fixture()
  const catalog = await discoverRegistryCards(f)
  assert.deepEqual(catalog.templates[1].views.map(item => item.writable), [true, false])
  await assert.rejects(sendRegistryCard({ ...f, route, args: sendArgs('pending') }), errorIs('registry_card_read_only'))
  const args = sendArgs()
  const receipt = await sendRegistryCard({ ...f, route, args })
  assert.deepEqual(receipt, { ok: true, message_id: messageId, card_seq: 0, requiresFinalSummary: true })
  assert.deepEqual(f.steps.slice(-4), ['authorize', profilePath, 'authorize', sendPath])
  assert.deepEqual(f.writes, [{ path: sendPath, body: { ...route, payload: { type: 17, ...args } } }])
})

test('requires the advertised version and state, correct wire profile, availability and effective policy', async t => {
  const cases = [
    ['unadvertised version', profile(), { ...sendArgs(), template_ref: { ...noticeRef, version: '2.0.0' } }, 'registry_card_not_advertised'],
    ['unadvertised state', profile(), sendArgs('invented'), 'registry_card_not_advertised'],
    ['unavailable template', profile({ templates: [processTemplate, { ...noticeTemplate, available: false }] }), sendArgs(), 'registry_card_not_advertised'],
    ['duplicate ref', profile({ templates: [processTemplate, noticeTemplate, noticeTemplate] }), sendArgs(), 'registry_profile_unavailable'],
    ['ambiguous versions', profile({ templates: [processTemplate, noticeTemplate,
      { ...noticeTemplate, version: '2.2.0' }] }), sendArgs(), 'registry_card_read_only'],
    ['ambiguous state', profile({ templates: [processTemplate, { ...noticeTemplate, views: [
      ...noticeTemplate.views, view('other', ['ready'], 'octo/v2'),
    ] }] }), sendArgs(), 'registry_profile_unavailable'],
    ['v1 with an advertised submit', profile({ templates: [processTemplate, { ...noticeTemplate, views: [
      view('result', ['ready'], 'octo/v1', ['submit']),
    ] }] }), sendArgs(), 'registry_card_read_only'],
    ['v2 without an advertised submit', profile({ templates: [processTemplate, { ...noticeTemplate, views: [
      view('result', ['ready'], 'octo/v2'),
    ] }] }), sendArgs(), 'registry_card_read_only'],
    ['no raw display authority for generic template', profile({ display: false }), sendArgs(), 'registry_card_read_only'],
    ['missing v1', { ...profile(), profiles: ['octo/v2'] }, sendArgs(), 'registry_card_read_only'],
    ['wire mismatch', { ...profile(), templating: { ...profile().templating, wire: 'template-ref/v2' } }, sendArgs(), 'registry_profile_unavailable'],
    ['old deployment without profile route', new OctoError('private fixture detail', 404), sendArgs(), 'registry_profile_unavailable'],
    ['new process alias reserved by effective policy', { ...profile(), config: {
      ...profile().config, reasoning_template_ref: noticeRef,
    } }, sendArgs(), 'registry_card_reserved'],
  ]
  for (const [name, manifest, args, code] of cases) await t.test(name, async () => {
    const f = fixture({ manifests: [manifest] })
    await assert.rejects(sendRegistryCard({ ...f, route, args }), errorIs(code))
    assert.deepEqual(f.writes, [])
  })
})

test('rejects non-JSON, excessive and spoofable model arguments before probing', async () => {
  const f = fixture()
  let invoked = 0
  const accessor = () => { invoked++; return 'unexpected' }
  const cycle = {}; cycle.cycle = cycle
  let deep = { value: 'bottom' }
  for (let i = 0; i < 10; i++) deep = { inner: deep }
  const inputs = [
    ...['catalog_provenance', 'on_behalf_of', 'channel_id', 'url', 'card', 'card_seq', 'transient', 'content_edit']
      .map(key => ({ ...sendArgs(), [key]: 'private fixture detail' })),
    { ...sendArgs(), template_ref: { ...noticeRef, url: 'relative' } },
    { ...sendArgs(), template_ref: { ...noticeRef, version: 'latest' } },
    { ...sendArgs(), data: { state: 'updated' } },
    { ...sendArgs(), data: { title: 'No state' } },
    ...[
      Object.defineProperty({}, 'value', { enumerable: true, get: accessor }),
      new Proxy({}, { ownKeys: accessor }),
      Object.defineProperty({}, 'hidden', { value: true }),
      { [Symbol('hidden')]: true },
      { toJSON: accessor },
      Object.assign([], { extra: true }),
      Array(2),
      Object.setPrototypeOf({ text: 'test' }, { inherited: true }),
      JSON.parse('{"__proto__":{"poison":true}}'),
      { catalogProvenance: { version: 1 } },
      { nested: [{ __obo_fanout: true }] },
      { callbackScope: 'owner' },
      { reasoningId: 'forged-progress' },
      { image_url: '/relative' },
      'https://example.invalid',
      'https:example.invalid',
      'person@example.invalid',
      '[open](/relative)',
      '![remote](//example.invalid/a)',
      '<javascript:example>',
      '\ud800',
      '\u0000',
      Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, 10n, accessor, new Date(0), cycle, deep,
      '汉'.repeat(3_000), Array(550).fill(1),
      Array(4).fill('"'.repeat(4_000)),
    ].map(value => ({ ...sendArgs(), data: { state: 'ready', value } })),
  ]
  for (const args of inputs) await assert.rejects(sendRegistryCard({ ...f, route, args }), errorIs('invalid_registry_arguments'))
  assert.equal(invoked, 0)
  assert.deepEqual(f.steps, [])
})

test('snapshots arguments and route before awaiting and honors the advertised size cap', async () => {
  const args = sendArgs(), target = { ...route }
  const f = fixture({ authority: [() => {
    args.data.fields[0].label = 'Changed'
    args.state = 'pending'
    target.channel_id = 'other-human'
    return true
  }, true] })
  await sendRegistryCard({ ...f, route: target, args })
  assert.deepEqual(f.writes[0].body, { ...route, payload: { type: 17, ...sendArgs() } })
  const capped = fixture({ manifests: [{ ...profile(), limits: { max_payload_bytes: 80 } }] })
  await assert.rejects(sendRegistryCard({ ...capped, route, args: sendArgs() }), errorIs('invalid_registry_arguments'))
  assert.equal(capped.writes.length, 0)
})

test('rechecks access after reads before any delivery or discovery result', async () => {
  const revoked = new Error('private fixture detail')
  const send = fixture({ authority: [true, revoked] })
  await assert.rejects(sendRegistryCard({ ...send, route, args: sendArgs() }), errorIs('registry_access_denied'))
  assert.deepEqual(send.steps, ['authorize', profilePath, 'authorize'])
  const discover = fixture({ authority: [true, false] })
  await assert.rejects(discoverRegistryCards(discover), errorIs('registry_access_denied'))
  const before = fixture({ authority: [false] })
  await assert.rejects(sendRegistryCard({ ...before, route, args: sendArgs() }), errorIs('registry_access_denied'))
  assert.deepEqual(before.steps, ['authorize'])
  const aborted = new AbortController()
  const midProbe = fixture({ manifests: [() => { aborted.abort(revoked); return profile() }] })
  await assert.rejects(sendRegistryCard({ ...midProbe, route, args: sendArgs(), signal: aborted.signal }),
    errorIs('registry_aborted'))
  assert.equal(midProbe.writes.length, 0)
})

test('keeps auth failures and definitive server validation distinct from uncertain writes', async t => {
  const officialError = async (status, semantic, code) => readApiError(new Response(JSON.stringify({
    status, error: { code, http_status: semantic, message: 'private fixture detail' },
  }), { status }))
  const auth = fixture({ manifests: [await officialError(401, 401, 'err.shared.auth.token_invalid')] })
  await assert.rejects(discoverRegistryCards(auth), errorIs('api_authentication_failed'))
  assert.equal(auth.writes.length, 0)
  const cases = [
    ['schema refusal', await officialError(400, 400, 'err.server.bot_api.card_invalid'), 'api_invalid_request'],
    ['membership revoked', await officialError(403, 403, 'err.server.bot_api.not_group_member'), 'api_permission_denied'],
    ['legacy wrapped send failure', await officialError(400, 500, 'err.server.bot_api.send_failed'), 'registry_delivery_unconfirmed'],
    ['write timeout', new Error('private fixture detail'), 'registry_delivery_unconfirmed'],
    ['malformed success', { message_id: 9007199254740999 }, 'registry_delivery_unconfirmed'],
    ['error body disguised as success', { message_id: messageId, error: 'private fixture detail' }, 'registry_delivery_unconfirmed'],
    ['rate limit', new OctoError('private fixture detail', 429), 'api_rate_limited'],
  ]
  for (const [name, reply, code] of cases) await t.test(name, async () => {
    const f = fixture({ replies: [reply] })
    await assert.rejects(sendRegistryCard({ ...f, route, args: sendArgs() }), errorIs(code))
    assert.equal(f.writes.length, 1)
  })
})

test('preserves a confirmed send receipt if authority changes while Octo replies', async () => {
  const controller = new AbortController()
  const f = fixture({ replies: [() => {
    controller.abort()
    return { message_id: messageId, private: 'private fixture detail' }
  }] })
  const receipt = await sendRegistryCard({ ...f, route, args: sendArgs(), signal: controller.signal })
  assert.deepEqual(receipt, { ok: true, message_id: messageId, card_seq: 0, requiresFinalSummary: true, authority_changed: true })
  assert.equal(f.writes.length, 1)
})

test('edits the same Registry template with a server-confirmed monotonic revision', async () => {
  for (const seq of [undefined, 7]) {
    const args = { ...editArgs(), expected_card_seq: seq ?? 0 }
    const raw = source({ seq, target: groupRoute })
    // The same official effective frame can be decoded or a stored JSON string.
    if (seq !== undefined) raw.extra = { content_edit: JSON.stringify(raw.message_extra.content_edit) }
    const f = fixture({ sources: [raw], replies: [{ status: 200, ignored: 'private fixture detail' }] })
    const result = await editRegistryCard({ ...f, route: groupRoute, botUid, args })
    const card_seq = (seq ?? 0) + 1
    assert.deepEqual(result, { ok: true, message_id: messageId, card_seq, requiresFinalSummary: true })
    assert.deepEqual(f.steps, ['authorize', profilePath, 'source', 'authorize', 'source', profilePath, 'authorize', editPath])
    assert.deepEqual(f.writes, [{ path: editPath, body: { ...groupRoute, message_id: messageId, ...sendArgs('updated'), card_seq } }])
  }
})

test('refuses raw, interactive, foreign, revoked, substituted and inconsistent revision targets', async t => {
  const withoutProvenance = cardFrame()
  delete withoutProvenance.catalog_provenance
  const compatible = fixture({ sources: [source({ original: withoutProvenance })], replies: [{ status: 200 }] })
  await editRegistryCard({ ...compatible, route, botUid, args: editArgs() })
  const rawCard = cardFrame()
  delete rawCard.template_ref
  const cases = [
    ['raw original with a valid effective card', source({ original: rawCard, seq: 1 })],
    ['interactive original with a valid effective card', source({ original: cardFrame({ wire: 'octo/v2' }), seq: 1 })],
    ['interactive effective', source({ seq: 1, effective: cardFrame({ seq: 1, wire: 'octo/v2' }) })],
    ['original with another exact ref', source({ original: cardFrame({ marker: { ...noticeRef, version: '2.0.0' } }) })],
    ['another principal', source({ original: cardFrame({ principal: 'another-bot' }) })],
    ['foreign stored Space', source({ seq: 1, effective: cardFrame({ seq: 1, space: 'other-space' }) })],
    ['revoked', { ...source(), message_extra: { revoke: 1 } }],
    ['mutually deleted', { ...source(), extra: { is_mutual_deleted: 1 } }],
    ['foreign author', { ...source(), from_uid: 'another-bot' }],
    ['foreign conversation', { ...source(), channel_id: 'another-human' }],
    ['different ID', { ...source(), message_id: '91' }],
    ['invalid revision number', source({ seq: Number.MAX_SAFE_INTEGER + 1 })],
    ['effective absent sequence', source({ seq: 1, effective: cardFrame() })],
    ['transient effective frame', source({ seq: 1, effective: { ...cardFrame({ seq: 1 }), transient: true } })],
    ['conflicting extras', { ...source({ seq: 1 }), extra: { content_edit: cardFrame({ seq: 2 }) } }],
    ['forged metadata', source({ original: { ...cardFrame(), card: cardFrame({ marker: processRef }).card } })],
  ]
  for (const [name, row] of cases) await t.test(name, async () => {
    const f = fixture({ sources: [row] })
    await assert.rejects(editRegistryCard({ ...f, route, botUid, args: editArgs() }), errorIs('registry_source_unavailable'))
    assert.equal(f.writes.length, 0)
  })
})

test('stops stale edits, profile revocation and final authorization changes', async t => {
  const sameRow = source({ seq: 1 })
  const cases = [
    ['expected sequence differs', fixture({ sources: [source({ seq: 2 })] }),
      { ...editArgs(), expected_card_seq: 1 }, 'registry_revision_conflict'],
    ['source sequence advanced', fixture({ sources: [source({ seq: 1 }), source({ seq: 2 })] }),
      editArgs(), 'registry_revision_conflict'],
    ['source mutated in place', fixture({ sources: [sameRow, () => {
      sameRow.message_extra.content_edit.plain = 'changed'
      return sameRow
    }] }), editArgs(), 'registry_revision_conflict'],
    ['policy changed after the first read', fixture({ manifests: [profile(), profile({ display: false })] }),
      editArgs(), 'registry_card_read_only'],
    ['role changed before delivery', fixture({ authority: [true, true, false] }),
      editArgs(), 'registry_access_denied'],
  ]
  for (const [name, f, args, code] of cases) await t.test(name, async () => {
    await assert.rejects(editRegistryCard({ ...f, route, botUid, args }), errorIs(code))
    assert.equal(f.writes.length, 0)
  })
})

test('does not retry an edit conflict or a write without ResponseOK', async () => {
  const conflict = await readApiError(new Response(JSON.stringify({
    status: 400, error: { code: 'err.server.bot_api.card_seq_conflict', http_status: 409, message: 'private fixture detail' },
  }), { status: 400 }))
  for (const [reply, code] of [[conflict, 'api_conflict'], [{ ok: true }, 'registry_delivery_unconfirmed'],
    [new OctoError('private fixture detail', 500), 'registry_delivery_unconfirmed']]) {
    const f = fixture({ replies: [reply] })
    await assert.rejects(editRegistryCard({ ...f, route, botUid, args: editArgs() }), errorIs(code))
    assert.equal(f.writes.length, 1)
  }
})

test('the integration schema keeps routing, provenance and transport fields out of model arguments', () => {
  assert.deepEqual(registryCardParameters().required, ['template_ref', 'state', 'data'])
  assert.deepEqual(Object.keys(registryCardParameters({ edit: true }).properties),
    ['template_ref', 'state', 'data', 'message_id', 'expected_card_seq'])
})
