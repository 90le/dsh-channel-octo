import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { cardInputs } from '../src/card-inputs.js'
import { formToolSpec } from '../src/form-tool.js'
import { OctoClient } from '../src/octo.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const form = { title: 'Synthetic regression form', inputs: [
  { id: 'note', kind: 'text', label: 'Note', required: true },
], actions: [{ id: 'submit', label: 'Submit' }] }
const question = { id: 'question', question: 'Synthetic regression question' }
const profile = { enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'],
  elements: ['TextBlock'], inputs: ['Input.Text', 'Input.ChoiceSet'],
  config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
}
const turn = () => new Promise(resolve => setImmediate(resolve))

async function until(predicate, description) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return
    await turn()
  }
  assert.fail(description)
}

function gate() {
  const released = Promise.withResolvers()
  return { entered: false, release: released.resolve,
    async wait() { this.entered = true; await released.promise },
  }
}

// Use the real store/worker and Octo serialization, but never a real endpoint or
// host/model. A held synthetic host turn exposes the same callbacks DSH receives.
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'octo-form-regressions-'))
  const store = new Store(directory, 'synthetic-form-regressions')
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, t.signal])
  const hostResult = Promise.withResolvers(), pending = [], gates = []
  const f = { store, signal, outbound: [], edits: [], acks: [], events: [], profileRequests: 0, hostRuns: 0 }
  const track = promise => {
    pending.push(promise)
    void promise.catch(() => {})
    return promise
  }
  const config = { cwd: directory, apiBase: 'https://form-regression.invalid/api', token: 'bf_fixture',
    botUid: 'bot', spaceId: 'space', ownerUid: 'alice', senderPolicy: 'allowlist', allowed: new Set(['alice']),
    toolScope: 'owner', toolPermission: 'workspace-write', dmCommands: 'safe', progress: 'off',
    fetchImpl: async (url, request) => {
      assert.ok(url.startsWith('https://form-regression.invalid/api/'), 'fixture must never use a live endpoint')
      if (url.endsWith('/card/profile')) {
        f.profileRequests++
        await f.profileGate?.wait()
        return Response.json(profile)
      }
      if (url.endsWith('/sendMessage')) {
        f.outbound.push(JSON.parse(request.body))
        return Response.json({ message_id: String(900 + f.outbound.length) })
      }
      if (url.endsWith('/message/edit')) {
        f.edits.push(JSON.parse(request.body))
        return Response.json({})
      }
      assert.fail('unexpected fixture request: ' + new URL(url).pathname)
    },
  }
  const api = new OctoClient(config)
  const allowsMessage = api.allowsMessage.bind(api)
  api.allowsMessage = async (...args) => {
    await f.accessGate?.wait()
    return allowsMessage(...args)
  }
  api.readReceipt = undefined
  api.events = async () => f.events
  api.ack = async id => { f.acks.push(id) }
  const host = { async run(session, input, created, runSignal, rules, stage, timeout, toolsAllowed, extras) {
    f.hostRuns++
    await created()
    f.sessionId = session.session_id
    f.extras = extras
    return hostResult.promise
  } }
  f.worker = new Worker({ config, api, store, host, log() {} })
  f.hold = phase => { const held = gate(); gates.push(held); f[phase + 'Gate'] = held; return held }
  f.revoke = kind => f.worker.reconfigure({ ...f.worker.config,
    ...(kind === 'allowlist' ? { allowed: new Set(['bob']) } : { toolPermission: 'text-only' }),
  }, host)
  f.invoke = (kind, questions = [question]) => {
    const result = { settled: false }
    result.promise = track(Promise.resolve().then(() => kind === 'form'
      ? f.extras.channelTools.execute('octo_form', structuredClone(form), signal)
      : f.extras.onQuestion(questions, signal)))
    void result.promise.then(() => { result.settled = true }, () => { result.settled = true })
    return result
  }
  f.ingest = async (events, cardsOnly = true) => { f.events = events; await f.worker.ingest(signal, cardsOnly) }
  f.text = (text, id = '9010') => f.worker.acceptInbound('ws:' + id,
    { messageId: id, sender: 'alice', channelId: 'alice', channelType: 1, text })
  t.after(async () => {
    controller.abort(new Error('synthetic fixture finished'))
    for (const held of gates) held.release()
    hostResult.resolve('Synthetic final answer')
    await Promise.allSettled(pending)
    store.close()
    // Keep recursive cleanup confined to the exact temporary fixture directory.
    const target = resolve(directory), parent = resolve(tmpdir()) + sep
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('octo-form-regressions-'))
    rmSync(target, { recursive: true, force: true })
  })
  store.add('1', { messageId: '1', sender: 'alice', channelId: 'alice', channelType: 1, text: 'Synthetic request' })
  track(f.worker.process(store.next(Date.now()), signal))
  await until(() => f.extras, 'worker did not enter the synthetic host turn')
  assert.ok(f.extras.channelTools.specs.some(spec => spec.name === 'octo_form'))
  assert.equal(typeof f.extras.onQuestion, 'function')
  return f
}

for (const kind of ['form', 'native question']) {
  for (const revocation of ['allowlist', 'text-only']) {
    for (const phase of ['before access', 'during access', 'during profile']) {
      test(`${kind}: ${revocation} revocation ${phase} prevents POST and text fallback`, { timeout: 5000 }, async t => {
        const f = await fixture(t)
        const held = phase === 'before access' ? undefined : f.hold(phase === 'during access' ? 'access' : 'profile')
        if (!held) f.revoke(revocation)
        const operation = f.invoke(kind)
        if (held) {
          await until(() => held.entered, 'operation did not reach the controlled async boundary')
          f.revoke(revocation)
          held.release()
        }
        // An unfixed implementation waits for 15 minutes after its unwanted POST.
        // Detect that observable write immediately instead of waiting for rejection.
        await until(() => operation.settled || f.outbound.length, 'operation neither rejected nor attempted delivery')
        assert.equal(f.outbound.length, 0, 'revoked work must not send a card or a fallback message')
        await assert.rejects(operation.promise, /octo_access_denied/)
        assert.equal(f.profileRequests, phase === 'during profile' ? 1 : 0)
        assert.equal(f.edits.length, 0)
        assert.equal(f.worker.questions.current, undefined)
      })
    }
  }
}

const callback = (binding, inputs, eventId = '101', overrides = {}) => ({
  event_id: eventId, event_type: 'card_action', event_data: {
    message_id: binding.messageId, action_id: binding.actionIds[0], operator_uid: 'alice',
    channel_id: 'alice', channel_type: 1, space_id: 'space',
    data: { dsh_card_nonce: binding.cardNonce }, inputs, ...overrides,
  },
})
test('a protected review ignores typed JSON and accepts only the authenticated card reply', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const card = { ...form, text: 'Literal preview: **bold** and https://example.invalid.' }
  const reviewed = f.worker.questions.form(card, { sender: 'alice', channel_type: 1, session_id: f.sessionId },
    f.worker.config, AbortSignal.any([f.signal, controller.signal]), () => {}, () => true, { cardOnly: true })
  void reviewed.catch(() => {})
  await until(() => f.worker.questions.current?.ready, 'protected form did not open')
  const { binding } = f.worker.questions.current
  f.text(JSON.stringify({ action: 'submit', values: { note: 'typed input' } }))
  assert.equal(f.worker.questions.current?.ready, true)
  assert.match(f.outbound[0].payload.card.body[1].text, /\\\*\\\*bold/)
  await f.ingest([callback(binding, { note: 'authenticated input' })])
  assert.deepEqual(await reviewed, { action: 'submit', values: { note: 'authenticated input' } })
})
const options = [{ label: 'First' }, { label: 'Second' }]
const recoveries = [
  { name: 'typed form', kind: 'form', invalid: { note: '   ' },
    reply: JSON.stringify({ action: 'submit', values: { note: 'corrected' } }),
    expected: { action: 'submit', values: { note: 'corrected' } } },
  { name: 'native text', invalid: { response: '   ' }, reply: 'corrected',
    expected: { answers: [{ id: 'question', selected: [], custom: 'corrected' }] } },
  { name: 'native single choice', questions: [{ ...question, options }], invalid: { selection: '' }, reply: '2',
    expected: { answers: [{ id: 'question', selected: ['Second'] }] } },
  { name: 'native multiple choice', questions: [{ ...question, options, multiSelect: true }],
    invalid: { selection: 'q1,q1' }, reply: '1,2',
    expected: { answers: [{ id: 'question', selected: ['First', 'Second'] }] } },
]

for (const scenario of recoveries) {
  test(`${scenario.name}: authenticated invalid input gets feedback, one ACK and text continuation`, { timeout: 5000 }, async t => {
    const f = await fixture(t), operation = f.invoke(scenario.kind, scenario.questions)
    await until(() => f.worker.questions.current?.ready, 'question did not become ready')
    const active = f.worker.questions.current, binding = active.binding
    const event = callback(binding, scenario.invalid)
    await f.ingest([event])
    assert.deepEqual(f.acks, ['101'])
    assert.deepEqual(f.store.pendingCardAcks(), [])
    assert.equal(f.worker.questions.current, active, 'invalid input must retain the original waiting turn')
    assert.equal(active.ready, true)
    assert.equal(operation.settled, false)
    assert.equal(f.store.cardBinding(binding.messageId), null, 'the consumed submit action must be retired')
    assert.ok(f.edits.some(edit => edit.message_id === binding.messageId
      && !JSON.parse(edit.content_edit).card.actions?.length), 'close the rejected card visibly')
    const instructions = f.outbound.filter(message => message.payload.type === 1).map(message => message.payload.content).join('\n')
    assert.match(instructions, /回复/, 'explain how to continue by text')
    if (scenario.kind === 'form') assert.match(instructions, /JSON[\s\S]*"action"[\s\S]*"values"/)
    const receipts = f.store.db.prepare('SELECT state,session_id,input FROM jobs WHERE event_id=?').all('101')
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].state, 'ignored')
    assert.equal(receipts[0].session_id, f.sessionId)
    assert.equal(receipts[0].input, '')
    const beforeReplay = { outbound: f.outbound.length, edits: f.edits.length }
    await f.ingest([event])
    assert.deepEqual(f.acks, ['101'], 'a repeated event in the same polling session must not ACK or handle twice')
    assert.deepEqual({ outbound: f.outbound.length, edits: f.edits.length }, beforeReplay)
    f.text(scenario.reply)
    assert.deepEqual(await operation.promise, scenario.expected)
    assert.equal(f.worker.questions.current, undefined)
    assert.equal(f.hostRuns, 1, 'the correction must resume this turn, never enqueue another host run')
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get().n, 0)
    assert.deepEqual(f.acks, ['101'])
  })
}

test('invalid-input reporting still requires the original callback identity, nonce and action', { timeout: 5000 }, async t => {
  const f = await fixture(t), operation = f.invoke('form')
  await until(() => f.worker.questions.current?.ready, 'form did not become ready')
  const active = f.worker.questions.current, binding = active.binding
  const mismatches = [
    { message_id: '800' }, { space_id: 'other-space' },
    { operator_uid: 'bob', channel_id: 'bob' },
    { channel_type: 2, channel_id: 'a'.repeat(32) },
    { data: { dsh_card_nonce: '0'.repeat(32) } }, { data: {} }, { action_id: 'other-action' },
  ]
  for (const [index, mismatch] of mismatches.entries()) {
    await f.ingest([callback(binding, { note: '   ' }, String(index + 2), mismatch)])
    assert.deepEqual(f.acks, [], 'foreign callbacks do not acquire our ACK obligation')
    assert.equal(f.edits.length, 0)
    assert.equal(f.outbound.length, 1, 'foreign callbacks must not trigger validation feedback')
    assert.ok(f.store.cardBinding(binding.messageId))
    assert.equal(f.worker.questions.current, active)
    assert.equal(operation.settled, false)
  }
  await f.ingest([callback(binding, { note: 'correct' })])
  assert.deepEqual(await operation.promise, { action: 'submit', values: { note: 'correct' } })
  assert.deepEqual(f.acks, ['101'])
})

test('advertised choice-value pattern rejects Unicode values while allowing Chinese option titles', () => {
  const schema = formToolSpec.parameters.properties.inputs.items.properties.options.items.properties.value
  assert.equal(typeof schema.pattern, 'string', 'the model-facing schema must advertise the runtime value restriction')
  const pattern = new RegExp(schema.pattern, 'u')
  const input = value => [{ id: 'decision', kind: 'choice', label: '选择', options: [{ title: '是', value }] }]
  for (const value of ['是', 'a b', 'a,b', '', 'a'.repeat(65)]) {
    assert.equal(pattern.test(value), false, 'schema must reject ' + JSON.stringify(value))
    assert.throws(() => cardInputs(input(value)), /invalid_card_inputs/)
  }
  for (const value of ['yes', 'option-1', 'a_b.c:2', 'a'.repeat(64)]) {
    assert.equal(pattern.test(value), true)
    assert.equal(cardInputs(input(value))[0].choices[0].title, '是')
  }
  for (const value of ['constructor', 'prototype', 'toString']) {
    assert.ok(schema.not?.enum?.includes(value), 'schema must also exclude reserved value ' + value)
    assert.throws(() => cardInputs(input(value)), /invalid_card_inputs/)
  }
})
