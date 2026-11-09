import assert from 'node:assert/strict'
import test from 'node:test'
import { OctoClient } from '../src/octo.js'
import { sendDisplayCard, spec } from '../src/display-card.js'

const messageId = '9223372036854775806'
const dm = { channel_id: 'alice', channel_type: 1 }
const group = { channel_id: 'group-a', channel_type: 2 }
const topic = { channel_id: 'a'.repeat(32) + '____123456789012345678', channel_type: 5 }
const manifest = {
  enabled: true, available: true, card_version: '1.5', profiles: ['octo/v1'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: false },
  elements: ['TextBlock', 'RichTextBlock', 'FactSet', 'ColumnSet', 'Table', 'Container', 'ActionSet'],
  actions: ['Action.OpenUrl', 'Action.ToggleVisibility', 'Action.CopyToClipboard'],
  limits: { max_payload_bytes: 524288, max_nodes: 400, max_depth: 16 },
}
const simple = { title: 'Report', blocks: [{ type: 'text', text: 'Ready.' }] }
const allBlocks = {
  title: 'Daily summary',
  blocks: [
    { type: 'heading', text: 'Overview', size: 'large' },
    { type: 'text', text: 'All checks completed.' },
    { type: 'rich', segments: [{ text: 'Ready ', bold: true }, { text: 'now', color: 'good', fontType: 'Monospace', subtle: true }] },
    { type: 'facts', items: [{ label: 'Passed', value: '12' }, { label: 'Failed', value: '0' }] },
    { type: 'columns', columns: [{ blocks: [{ type: 'text', text: 'West: 20' }] }, { blocks: [{ type: 'text', text: 'East: 24' }] }] },
    { type: 'table', columns: [{ width: 2 }, {}], rows: [
      { cells: [{ text: 'Item' }, { text: 'Count' }] },
      { cells: [{ blocks: [{ type: 'text', text: 'Apples' }] }, { text: '4' }] },
    ] },
    { type: 'link', text: 'Read guide', url: 'https://example.com/guide#overview' },
    { type: 'group', style: 'emphasis', blocks: [{ type: 'text', text: 'Next step: review.' }] },
    { type: 'collapsible', summary: 'Details', expandLabel: 'Show details', collapseLabel: 'Hide details',
      blocks: [{ type: 'text', text: 'All rows remain visible in fallback.' }] },
    { type: 'copy', label: 'Copy value', text: 'Copy this\n  exactly' },
  ],
}
const objects = value => Array.isArray(value) ? value.flatMap(objects)
  : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(objects)] : []
function fixture({ profile = () => Response.json(manifest), post = () => new Response('{"message_id":9223372036854775806}') } = {}) {
  const calls = []
  const api = new OctoClient({ apiBase: 'https://octo.invalid/api', token: 'bf_fixture', fetchImpl: async (url, request) => {
    const body = request.body === undefined ? undefined : JSON.parse(request.body)
    calls.push({ url, request, body })
    if (url.endsWith('/card/profile')) return profile(request)
    if (url.endsWith('/sendMessage')) return post(request, body)
    throw new Error('unexpected fixture request')
  } })
  return { api, calls, send: (args = simple, route = dm, signal) => sendDisplayCard({ api, route, args, signal }) }
}

test('exposes a closed, recursive display schema and requires a final summary after the receipt', () => {
  assert.equal(spec.name, 'octo_display_card')
  assert.match(spec.description, /delivery receipt, NOT a final answer/)
  assert.match(spec.description, /MUST still produce a short final summary/)
  assert.match(spec.description, /Never include secrets, raw logs or private reasoning/)
  assert.deepEqual(Object.keys(spec.parameters.properties), ['title', 'blocks'])
  assert.equal(spec.parameters.additionalProperties, false)
  const types = spec.parameters.$defs.block.oneOf.map(variant => variant.properties.type.const)
  assert.deepEqual(types, ['heading', 'text', 'rich', 'facts', 'columns', 'table', 'link', 'group', 'collapsible', 'copy'])
  assert.ok(objects(spec.parameters).filter(node => node.type === 'object').every(node => node.additionalProperties === false))
})

test('sends all structured display variants to the bound DM, group or topic and returns only a confirmed receipt', async () => {
  for (const route of [dm, group, topic]) {
    const { send, calls } = fixture()
    const original = structuredClone(allBlocks)
    assert.deepEqual(await send(allBlocks, route), {
      messageId, format: 'display_card', fallbackBlocks: [], requiresFinalSummary: true,
    })
    assert.deepEqual(allBlocks, original)
    assert.deepEqual(calls.map(call => call.request.method), ['GET', 'POST'])
    for (const { request } of calls) {
      assert.equal(request.redirect, 'manual')
      assert.equal(request.headers.Authorization, 'Bearer bf_fixture')
      assert.ok(request.signal instanceof AbortSignal)
    }
    const { client_msg_no, payload, ...target } = calls[1].body
    assert.deepEqual(target, route)
    assert.match(client_msg_no, /^[a-f0-9]{32}$/)
    assert.equal(payload.type, 17)
    assert.equal(payload.profile, 'octo/v1')
    assert.equal(payload.card_version, '1.5')
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 24 * 1024)
    assert.equal(payload.card.actions, undefined)
    const nodes = objects(payload.card)
    for (const type of [...manifest.elements, ...manifest.actions]) assert.ok(nodes.some(node => node.type === type), type)
    assert.ok(nodes.every(node => node.type !== 'Action.Submit' && !node.type?.startsWith('Input.')))
    assert.equal(nodes.find(node => node.type === 'Action.CopyToClipboard').text, 'Copy this\n  exactly')
    assert.equal(nodes.find(node => node.type === 'Action.OpenUrl').url, 'https://example.com/guide#overview')
    assert.match(payload.plain, /Apples \| 4/)
    assert.match(payload.plain, /All rows remain visible in fallback\./)
    assert.match(payload.plain, /Copy this\n  exactly/)
    const ids = nodes.map(node => node.id).filter(Boolean)
    assert.equal(new Set(ids).size, ids.length)
    for (const node of nodes.filter(node => node.type === 'Action.ToggleVisibility')) {
      assert.ok(node.targetElements.every(target => ids.includes(target.elementId)))
    }
  }
})

test('unsupported elements and local actions degrade without losing accepted text, rows, links or folded content', async () => {
  const full = fixture()
  await full.send(allBlocks)
  const plain = full.calls[1].body.payload.plain
  for (const elements of [['TextBlock'], undefined]) {
    const { send, calls } = fixture({ profile: () => Response.json({ ...manifest, elements, actions: [] }) })
    const receipt = await send(allBlocks)
    assert.deepEqual(receipt.fallbackBlocks, ['rich', 'facts', 'columns', 'table', 'link', 'group', 'collapsible', 'copy'])
    const payload = calls[1].body.payload
    assert.equal(payload.plain, plain)
    assert.ok(payload.card.body.every(node => node.type === 'TextBlock'))
    assert.match(payload.card.body.map(node => node.text).join('\n'), /All rows remain visible in fallback\./)
  }
  const { send, calls } = fixture({ profile: () => Response.json({ ...manifest, actions: [] }) })
  assert.deepEqual((await send(allBlocks)).fallbackBlocks, ['link', 'collapsible', 'copy'])
  assert.equal(calls[1].body.payload.plain, plain)
  assert.ok(objects(calls[1].body.payload.card).every(node => !node.type?.startsWith('Action.')))
})

test('probes each execution and snapshots the bound route and arguments before awaiting capabilities', async () => {
  const ready = Promise.withResolvers()
  let reads = 0
  const { send, calls } = fixture({ profile: async () => {
    if (++reads === 1) { await ready.promise; return Response.json({ ...manifest, elements: ['TextBlock'], actions: [] }) }
    return Response.json(manifest)
  } })
  const route = { ...group }, args = structuredClone(allBlocks)
  const pending = send(args, route)
  route.channel_id = 'other-group'
  args.blocks[1].text = 'Changed while probing'
  ready.resolve()
  assert.ok((await pending).fallbackBlocks.length)
  assert.equal(calls[1].body.channel_id, group.channel_id)
  assert.match(calls[1].body.payload.plain, /All checks completed\./)
  assert.doesNotMatch(calls[1].body.payload.plain, /Changed while probing/)
  assert.deepEqual((await send(allBlocks, group)).fallbackBlocks, [])
  assert.equal(reads, 2)
})

test('fits manifest node/depth limits using complete plaintext and refuses truncation or malformed limits', async () => {
  for (const limits of [{ max_nodes: 1 }, { max_depth: 1 }]) {
    const { send, calls } = fixture({ profile: () => Response.json({ ...manifest, limits }) })
    assert.deepEqual((await send(allBlocks)).fallbackBlocks, ['limits'])
    const payload = calls[1].body.payload
    assert.equal(payload.card.body.length, 1)
    assert.equal(payload.card.body[0].type, 'TextBlock')
    assert.match(payload.card.body[0].text, /All rows remain visible in fallback\./)
    assert.match(payload.card.body[0].text, /Copy this\n  exactly/)
  }
  for (const limits of [{ max_payload_bytes: 100 }, { max_payload_bytes: 1 }]) {
    const { send, calls } = fixture({ profile: () => Response.json({ ...manifest, limits }) })
    await assert.rejects(send(allBlocks), { code: 'display_card_limits_exceeded' })
    assert.equal(calls.length, 1)
  }
  for (const limits of [[], null, { max_nodes: 0 }, { max_depth: -1 }, { max_payload_bytes: '4096' }, { max_nodes: 1.5 }]) {
    const { send, calls } = fixture({ profile: () => Response.json({ ...manifest, limits }) })
    await assert.rejects(send(), { code: 'display_card_unavailable' })
    assert.equal(calls.length, 1)
  }
})

test('card-disabled or incompatible profiles fail closed without any send', async () => {
  for (const profile of [null, {}, { ...manifest, available: false }, { ...manifest, enabled: false },
    { ...manifest, config: {} }, { ...manifest, config: { ...manifest.config, display_enabled: false } },
    { ...manifest, config: { ...manifest.config, card_enabled: false } },
    { ...manifest, card_version: '1.4' }, { ...manifest, profiles: ['octo/v2'] },
    { ...manifest, elements: [] }, { ...manifest, actions: {} }]) {
    const { send, calls } = fixture({ profile: () => Response.json(profile) })
    await assert.rejects(send(), { code: 'display_card_unavailable' })
    assert.equal(calls.length, 1)
  }
})

test('rejects selectable targets, arbitrary payloads, callbacks and malformed block structures before probing', async () => {
  const { send, calls } = fixture()
  for (const key of ['route', 'target', 'channel_id', 'accountId', 'on_behalf_of', 'card', 'actions', 'plain', 'reasoning', 'logs']) {
    await assert.rejects(send({ ...simple, [key]: 'untrusted' }), { code: 'invalid_display_card' })
  }
  const blocks = [
    { type: 'unknown', text: 'x' }, { type: 'text', text: 'x', selectAction: {} },
    { type: 'heading', text: 'x', size: 'huge' }, { type: 'rich', segments: [{ text: 'x', bold: 'yes' }] },
    { type: 'facts', items: [{ label: 'x' }] }, { type: 'columns', columns: [] },
    { type: 'table', rows: [{ cells: [{ text: 'A' }] }, { cells: [{ text: 'B' }, { text: 'C' }] }] },
    { type: 'table', columns: [{ width: -1 }], rows: [{ cells: [{ text: 'A' }] }] },
    { type: 'table', rows: [{ cells: [{ text: 'A', blocks: [{ type: 'text', text: 'B' }] }] }] },
    { type: 'group', style: 'arbitrary', blocks: [{ type: 'text', text: 'x' }] },
    { type: 'collapsible', summary: 'x', defaultVisible: 'true', blocks: [{ type: 'text', text: 'x' }] },
    { type: 'copy', text: 'x', data: { callback: 'run' } },
  ]
  for (const block of blocks) await assert.rejects(send({ blocks: [block] }), { code: 'invalid_display_card' })
  for (const route of [null, { ...dm, on_behalf_of: 'other' }, { ...dm, channel_id: 'alice@bot' },
    { ...dm, channel_type: 3 }, { channel_id: 'invalid-topic', channel_type: 5 }, { channel_id: '..', channel_type: 2 }]) {
    await assert.rejects(send(simple, route), { code: 'invalid_display_card_route' })
  }
  assert.equal(calls.length, 0)
})

test('enforces UTF-8 field/total limits, aggregate object budget, depth and cycles without partial sends', async () => {
  const { send, calls } = fixture()
  let deep = { type: 'text', text: 'Bottom' }
  for (let i = 0; i < 6; i++) deep = { type: 'group', blocks: [deep] }
  const cycle = { type: 'group', blocks: [] }; cycle.blocks.push(cycle)
  const excessiveObjects = Array.from({ length: 20 }, () => ({ type: 'facts',
    items: Array.from({ length: 20 }, () => ({ label: 'x', value: 'y' })) }))
  for (const args of [
    { ...simple, title: '中'.repeat(54) }, { blocks: [] }, { blocks: [{ type: 'text', text: '中'.repeat(683) }] },
    { blocks: [{ type: 'copy', text: 'x'.repeat(4097) }] }, { blocks: [deep] }, { blocks: [cycle] },
    { blocks: excessiveObjects }, { blocks: Array.from({ length: 21 }, () => ({ type: 'text', text: 'x' })) },
    { blocks: Array.from({ length: 5 }, () => ({ type: 'text', text: 'x'.repeat(1800) })) },
    { blocks: [{ type: 'text', text: 'a\u0000b' }] }, { blocks: [{ type: 'text', text: 'a\u202eb' }] },
    { blocks: new Array(1) },
  ]) await assert.rejects(send(args), { code: 'invalid_display_card' })
  assert.equal(calls.length, 0)
})

test('permits only safe HTTPS links and literal author text; secret-shaped strings never reach transport', async () => {
  const { send, calls } = fixture()
  for (const url of ['http://example.com', 'javascript:alert(1)', 'file:///c:/local', '//example.com/path',
    'https://alice:password@example.com', 'https://example.com/?token=hidden', 'https://localhost/private',
    'https://127.0.0.1/local', 'https://[::1]/local', 'https://service.internal/path',
    'https://example.com/%0aheader', 'https://example.com/\\other', 'https://example.com/bf_fixture']) {
    await assert.rejects(send({ blocks: [{ type: 'link', text: 'Open', url }] }),
      error => ['display_card_unsafe_link', 'display_card_sensitive_content'].includes(error.code))
  }
  for (const text of ['bf_fixture', 'password=hidden', 'sk-abcdefghijklmnopqrstuv', 'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN PRIVATE KEY-----', 'eyJabcdefgh.abcdefgh.abcdefghijkl', 'xeyJabcdefgh.abcdefgh.a', 'x'.repeat(32) + '1']) {
    await assert.rejects(send({ blocks: [{ type: 'copy', text }] }), { code: 'display_card_sensitive_content' })
  }
  await assert.rejects(send({ blocks: [{ type: 'rich', segments: [{ text: 'sk-' }, { text: 'abcdefghijklmnopqrstuv' }] }] }),
    { code: 'display_card_sensitive_content' })
  await assert.rejects(send({ blocks: [{ type: 'rich', segments: [{ text: 'java' }, { text: 'script:alert(1)' }] }] }),
    { code: 'display_card_unsafe_link' })
  assert.equal(calls.length, 0)
  await send({ blocks: [{ type: 'text', text: '[guide](https://example.com) <b>literal</b>' }] })
  assert.equal(calls[1].body.payload.card.body[0].text, '\\[guide\\](https://example.com) \\<b\\>literal\\</b\\>')
  assert.equal(calls[1].body.payload.plain, '[guide](https://example.com) <b>literal</b>')
  await send({ blocks: [{ type: 'text', text: '本次 token 用量 500；请在设置中修改密码。' },
    { type: 'link', text: '查询说明', url: 'https://example.com/help?q=usage&page=2' }] })
})

test('sanitizes probe/send errors, never retries ambiguous writes, and does not return raw content', async () => {
  const probe = fixture({ profile: () => { throw new Error('Authorization: bf_private') } })
  await assert.rejects(probe.send(), { code: 'display_card_probe_failed', message: 'display_card_probe_failed' })
  assert.equal(probe.calls.length, 1)
  for (const [post, code] of [
    [() => Response.json({ error: 'bf_private' }, { status: 403 }), 'display_card_refused'],
    [() => Response.json({}, { status: 429 }), 'display_card_refused'],
    [() => Response.json({}, { status: 500 }), 'display_card_delivery_unconfirmed'],
    [() => Response.json({ message_id: 'not-confirmed' }), 'display_card_delivery_unconfirmed'],
    [() => { throw new Error('bf_private connection lost') }, 'display_card_delivery_unconfirmed'],
  ]) {
    const { send, calls } = fixture({ post })
    await assert.rejects(send(), { code, message: code })
    assert.equal(calls.length, 2)
  }
})

test('cancellation cannot send after probing or leak its reason; cancellation during a write remains unconfirmed', async () => {
  const before = new AbortController()
  before.abort(new Error('bf_private'))
  const unused = fixture()
  await assert.rejects(unused.send(simple, dm, before.signal), { code: 'display_card_aborted' })
  assert.equal(unused.calls.length, 0)
  const probing = new AbortController()
  const duringProbe = fixture({ profile: () => { probing.abort('bf_private'); return Response.json(manifest) } })
  await assert.rejects(duringProbe.send(simple, dm, probing.signal), { code: 'display_card_aborted' })
  assert.equal(duringProbe.calls.length, 1)
  const writing = new AbortController()
  const duringWrite = fixture({ post: () => { writing.abort('bf_private'); throw new Error('bf_private') } })
  await assert.rejects(duringWrite.send(simple, dm, writing.signal), { code: 'display_card_delivery_unconfirmed' })
  assert.equal(duringWrite.calls.length, 2)
})
