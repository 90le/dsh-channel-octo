import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admit, OctoClient } from '../src/octo.js'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'

function fixture(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-integrated-'))
  const store = new Store(cwd, 'fixture-bot')
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  return { store, cwd, config: { cwd, botUid: 'bot', ownerUid: 'alice', spaceId: 'space', allowed: new Set(['alice']),
    apiBase: 'https://octo.example.invalid/api', token: 'bf_integration_fixture', waitSeconds: 5, ...options } }
}
const signal = new AbortController().signal
const msg = (id, payload) => ({ event_id: id, message: {
  message_id: id, from_uid: 'alice', channel_type: 1, payload,
} })

test('admitted attachment goes to DSH; the same turn sends its declared file to the same DM', async t => {
  const { store, config, cwd } = fixture(t, { allowFiles: true,
    mediaDownloadOrigins: ['https://files.example.invalid'], mediaUploadOrigins: ['https://storage.example.invalid'] })
  const received = Buffer.from('incoming attachment')
  const made = Buffer.from('generated output')
  writeFileSync(join(cwd, 'output.txt'), made)
  const calls = []
  config.fetchImpl = async (input, init) => {
    const url = new URL(input)
    if (url.hostname === 'files.example.invalid') {
      assert.equal(init.headers.Authorization, undefined)
      return new Response(received, { headers: { 'Content-Type': 'text/plain' } })
    }
    if (url.hostname === 'storage.example.invalid') {
      assert.equal(init.method, 'PUT')
      assert.equal(init.headers.Authorization, undefined)
      assert.deepEqual(init.body, made)
      calls.push('upload')
      return new Response()
    }
    if (url.pathname.endsWith('/upload/presigned')) return Response.json({
      method: 'PUT', uploadUrl: 'https://storage.example.invalid/output.txt?signature=fixture',
      downloadUrl: 'https://files.example.invalid/output.txt', contentType: 'text/plain',
    })
    if (url.pathname.endsWith('/sendMessage')) {
      const body = JSON.parse(init.body)
      assert.equal(body.channel_id, 'alice')
      assert.equal(body.channel_type, 1)
      if (body.payload.type === 8) {
        assert.equal(body.payload.url, 'https://files.example.invalid/output.txt')
        calls.push('file')
      } else calls.push('text')
      return Response.json({ message_id: String(10 + calls.length) })
    }
    assert.fail('unexpected synthetic request')
  }
  const worker = new Worker({ api: new OctoClient(config), store, config, log() {}, host: {
    async run(session, text, created, _signal, _rules, _progress, _timeout, tools, extras) {
      assert.equal(text, '')
      assert.equal(tools, false)
      assert.equal(extras.onDeliverables, undefined)
      assert.deepEqual(extras.attachments[0].bytes, received)
      await created()
      return 'received'
    },
  } })
  const message = msg('1', { type: 8, name: 'input.txt', url: 'https://files.example.invalid/input.txt' })
  assert.equal(admit(message, { ...config, allowFiles: false }), undefined)
  store.add('1', admit(message, config))
  await worker.process(store.next(Date.now()), signal)
  // Model tools are enabled only with the explicit private allowlist. The host
  // fixture emulates one deliverable event already correlated to that turn.
  config.senderPolicy = 'allowlist'
  worker.host = { async run(_s, _text, _create, _signal, _rules, _progress, _timeout, tools, extras) {
    assert.equal(tools, true)
    extras.onDeliverables([join(cwd, 'output.txt')])
    return 'done'
  } }
  store.add('2', admit(msg('2', { type: 1, content: 'prepare a file' }), config))
  await worker.process(store.next(Date.now()), signal)
  assert.deepEqual(calls, ['text', 'text', 'upload', 'file'])
  assert.deepEqual(store.overview().counts.map(row => [row.state, row.total]), [['sent', 2]])
})

test('WebSocket sidecar consumes only its own click, persists before ACK and does not replay', async t => {
  const { store, config } = fixture(t, { dmCommands: 'safe' })
  let rawCard
  const acks = [], responses = []
  config.fetchImpl = async (input, init) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/card/profile')) return Response.json({ enabled: true, card_version: '1.5',
      profiles: ['octo/v1', 'octo/v2'], inputs: ['Input.ChoiceSet'],
      config: { card_enabled: true, display_enabled: true, interaction_enabled: true } })
    if (url.pathname.endsWith('/sendMessage')) {
      const { payload } = JSON.parse(init.body)
      if (payload.type === 17) rawCard = payload
      else responses.push(payload.content)
      return Response.json({ message_id: payload.type === 17 ? '400' : '401' })
    }
    assert.fail('unexpected synthetic request')
  }
  const api = new OctoClient(config)
  const worker = new Worker({ api, store, config, host: { run() { assert.fail('command/click ran the model') } }, log() {} })
  store.add('1', admit(msg('1', { type: 1, content: '/choose' }), config))
  await worker.process(store.next(Date.now()), signal)
  assert.equal(rawCard.profile, 'octo/v2')
  assert.equal(store.hasOpenCard(), true)
  const click = { event_id: '8', event_type: 'card_action', event_data: {
    message_id: '400', action_id: 'confirm', space_id: 'space', channel_id: 'alice', channel_type: 1,
    operator_uid: 'alice', inputs: { selection: 'B' }, data: rawCard.card.actions[0].data,
  } }
  api.events = async () => [msg('6', { type: 1, content: 'stale socket backlog' }),
    { ...click, event_id: '7', event_data: { ...click.event_data, operator_uid: 'other' } }, click,
    { ...click, event_id: '9' }]
  api.ack = async id => {
    acks.push(id)
    assert.equal(store.hasEvent(id), true)
  }
  await worker.ingest(signal, true)
  await worker.process(store.next(Date.now()), signal)
  await worker.ingest(signal, true)
  assert.deepEqual(acks, ['8'])
  assert.equal(responses.length, 1)
  assert.match(responses[0], /B/)
  assert.equal(store.next(Date.now()), undefined)
})
