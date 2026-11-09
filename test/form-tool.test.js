import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardInputs, cardInputValues } from '../src/card-inputs.js'
import { createCard, sendCard, resolveCardAction } from '../src/octo-cards.js'
import { QuestionBridge } from '../src/questions.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const inputs = [
  { id: 'note', kind: 'text', label: '说明', required: true },
  { id: 'count', kind: 'number', label: '数量', required: true },
  { id: 'day', kind: 'date', label: '日期', required: true },
  { id: 'time', kind: 'time', label: '时间', required: true },
  { id: 'flag', kind: 'toggle', label: '是否需要', required: true },
  { id: 'selected', kind: 'choice', label: '选项', required: true, multi: true,
    options: [{ title: '甲', value: 'a' }, { title: '乙', value: 'b' }] },
]
const form = { title: '填写测试表单', text: '只填写合成测试内容', inputs, actions: [{ id: 'submit', label: '提交' }] }
const wire = { note: '中文\n第二行🙂', count: '1.5', day: '2028-02-29', time: '23:59', flag: 'false', selected: 'a,b' }
const values = { ...wire, count: 1.5, flag: false, selected: ['a', 'b'] }
const profile = { enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'],
  inputs: Object.values(cardInputs(inputs)).map(input => input.type), elements: ['TextBlock'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
}
const signal = new AbortController().signal

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'octo-form-')), store = new Store(dir, 'fixture')
  t.after(() => { store.close(); rmSync(dir, { force: true, recursive: true }) })
  let sent, posts = 0
  const messages = [], edits = [], config = { botUid: 'bot', spaceId: 'space', apiBase: 'https://form.invalid/api', token: 'bf_fixture',
    ownerUid: 'alice', allowed: new Set(['alice']), toolScope: 'owner', dmCommands: 'safe',
    fetchImpl: async (url, request) => {
      if (url.endsWith('/card/profile')) return Response.json(options.profile ?? profile)
      assert.ok(url.endsWith('/sendMessage')); posts++; sent = JSON.parse(request.body).payload
      if (options.lost) throw new Error('synthetic uncertain delivery')
      return Response.json({ message_id: '900' })
    },
  }
  const api = { async send(route, text) { messages.push({ route, text }); return '901' }, async editProgress(...args) { edits.push(args) } }
  const bridge = new QuestionBridge({ api, store, log() {} })
  const job = { sender: 'alice', channel_id: 'alice', channel_type: 1, session_id: 'session-test' }
  return { config, store, api, bridge, job, messages, edits, get posts() { return posts }, get sent() { return sent } }
}
async function ready(bridge) {
  for (let i = 0; i < 100; i++) { if (bridge.current?.ready) return bridge.current; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('form did not become ready')
}
const event = (binding, overrides = {}) => ({ event_id: '9223372036854775807', event_type: 'card_action', event_data: {
  message_id: binding.messageId, action_id: 'submit', operator_uid: 'alice', channel_id: 'alice', channel_type: 1,
  space_id: 'space', data: { dsh_card_nonce: binding.cardNonce }, inputs: wire, ...overrides,
} })

test('all six Octo input controls have native shapes and callback types', () => {
  const card = createCard(form)
  assert.deepEqual(card.card.body.slice(2).map(node => node.type), ['Input.Text', 'Input.Number', 'Input.Date', 'Input.Time', 'Input.Toggle', 'Input.ChoiceSet'])
  assert.equal(card.card.body.at(-1).isMultiSelect, true)
  assert.equal(card.card.body.at(-2).title, '是否需要')
  assert.deepEqual(cardInputValues(inputs, wire), values)
  assert.deepEqual(cardInputValues(inputs, { ...wire, count: 0, flag: true }), { ...values, count: 0, flag: true })
})
for (const [key, value] of Object.entries({ note: ' ', count: '0x10', day: '2026-02-29', time: '24:00', flag: 'yes', selected: 'a,other' })) {
  test('rejects malformed form field ' + key, () => assert.equal(cardInputValues(inputs, { ...wire, [key]: value }), null))
}
test('rejects unknown, missing, oversized, duplicate choices and invalid authoring before network', () => {
  assert.equal(cardInputValues(inputs, { ...wire, unknown: 'x' }), null)
  assert.equal(cardInputValues(inputs, { ...wire, selected: 'a,a' }), null)
  assert.equal(cardInputValues(inputs, { ...wire, count: undefined }), null)
  assert.equal(cardInputValues(inputs, wire, { max_input_text_bytes: 4 }), null)
  assert.equal(cardInputValues(inputs, wire, { max_inputs_bytes: 4 }), null)
  assert.throws(() => createCard({ ...form, inputs: [...inputs, inputs[0]] }), /invalid_card_form/)
  assert.throws(() => createCard({ ...form, inputs: [{ ...inputs[0], id: '__proto__' }] }), /invalid_card_form/)
  assert.throws(() => createCard({ ...form, inputs: [{ ...inputs[1], multi: true }] }), /invalid_card_form/)
})
test('negotiates each input, clamps text bytes and detaches definitions across awaits', async t => {
  const f = fixture(t, { profile: { ...profile, limits: { max_input_text_bytes: 20, max_inputs_bytes: 4096 } } })
  const authored = structuredClone(form)
  const pending = sendCard(f.config, { channel_id: 'alice', channel_type: 1 }, authored, signal)
  authored.inputs[0].id = 'changed'
  const { binding } = await pending
  assert.equal(f.sent.card.body[2].maxLength, 5)
  assert.equal(binding.inputSpecs[0].id, 'note')
  assert.deepEqual(resolveCardAction(event(binding), binding, f.config).values, values)
  assert.equal(resolveCardAction(event(binding, { inputs: { ...wire, note: '界'.repeat(8) } }), binding, f.config), null)
  assert.equal(resolveCardAction(event(binding, { operator_uid: 'other' }), binding, f.config), null)
  assert.equal(resolveCardAction(event(binding, { action_id: 'delete' }), binding, f.config), null)
  assert.equal(resolveCardAction(event(binding, { data: { dsh_card_nonce: '0'.repeat(32) } }), binding, f.config), null)
})
test('typed callback resumes original waiting turn, records ACK and one visible receipt', async t => {
  const f = fixture(t), states = []
  const waiting = f.bridge.form(form, f.job, f.config, signal, value => states.push(value))
  const active = await ready(f.bridge)
  f.api.events = async () => [event(active.binding)]
  const acks = []; f.api.ack = async id => acks.push(id)
  const worker = new Worker({ ...f, log() {}, host: { run() { assert.fail('new task must not be started') } } })
  worker.questions = f.bridge
  await worker.ingest(signal, true)
  assert.deepEqual(await waiting, { action: 'submit', values })
  await worker.ingest(signal, true)
  assert.deepEqual(states, [true, false]); assert.equal(f.edits.length, 1)
  assert.equal(f.edits[0][2].card.actions, undefined)
  assert.deepEqual(acks, ['9223372036854775807'])
  const row = f.store.db.prepare('SELECT state,session_id,input FROM jobs').get()
  assert.equal(row.state, 'ignored'); assert.equal(row.session_id, 'session-test'); assert.equal(row.input, '')
})
test('unsupported control falls back to bounded text form; invalid answers do not settle it', async t => {
  const f = fixture(t, { profile: { ...profile, inputs: ['Input.Text'] } })
  const waiting = f.bridge.form(form, f.job, f.config, signal, () => {})
  const active = await ready(f.bridge)
  assert.equal(f.posts, 0); assert.match(f.messages[0].text, /JSON/)
  assert.equal(f.bridge.text(active, JSON.stringify({ action: 'submit', values: { ...wire, count: 'bad' } })), false)
  assert.equal(active.ready, true)
  assert.equal(f.bridge.text(active, JSON.stringify({ action: 'submit', values: wire })), true)
  assert.deepEqual(await waiting, { action: 'submit', values })
})
test('uncertain card send is not resent as another form or plain text', async t => {
  const f = fixture(t, { lost: true })
  await assert.rejects(f.bridge.form(form, f.job, f.config, signal, () => {}), /transport_or_invalid_response/)
  assert.equal(f.posts, 1); assert.equal(f.messages.length, 0); assert.equal(f.bridge.current, undefined)
})
for (const multi of [false, true]) test('native question uses ' + (multi ? 'multiple choice' : 'text input') + ' and returns native answers', async t => {
  const f = fixture(t), question = { id: 'q', question: '请回答', ...(multi && { multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }) }
  const waiting = f.bridge.ask([question], f.job, f.config, signal, () => {})
  const active = await ready(f.bridge)
  const click = event(active.binding, { action_id: 'answer', inputs: multi ? { selection: 'q1,q2' } : { response: '我的答案' } })
  const resolved = resolveCardAction(click, active.binding, f.config)
  assert.ok(resolved)
  assert.equal(f.bridge.card(active, active.key, undefined, resolved), true)
  assert.deepEqual(await waiting, { answers: [multi ? { id: 'q', selected: ['甲', '乙'] } : { id: 'q', selected: [], custom: '我的答案' }] })
})
test('cancelled form closes waiting state and restart retires the old card', async t => {
  const f = fixture(t), stop = new AbortController(), states = []
  const waiting = f.bridge.form(form, f.job, f.config, stop.signal, state => states.push(state))
  const rejection = assert.rejects(waiting, /stopped/)
  const active = await ready(f.bridge)
  stop.abort(new Error('stopped')); await rejection
  assert.deepEqual(states, [true, false]); assert.equal(f.edits.length, 0)
  await new QuestionBridge({ ...f, log() {} }).closeInterrupted(signal)
  assert.equal(f.edits.length, 1); assert.equal(f.store.cardBinding(active.binding.messageId), null)
})
