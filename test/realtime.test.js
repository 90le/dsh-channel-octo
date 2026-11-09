import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { wirePeer } from '../scripts/wukong-fixture.mjs'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'
import { receiveRealtime } from '../src/realtime.js'

async function until(fn, timeout = 6000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fn()) return
    await delay(25)
  }
  assert.fail('timed out waiting for fixture')
}

test('real WuKong wire reconnects and ACKs durable work; replay does not rerun it', { timeout: 15000 }, async () => {
  const bot = 'fixture-bot'
  const peer = await wirePeer({ bot })
  const dir = mkdtempSync(join(tmpdir(), 'octo-wire-'))
  const store = new Store(dir, 'fixture')
  const stop = new AbortController()
  let runs = 0
  const worker = new Worker({
    store, log() {},
    config: { botUid: bot, spaceId: 'space', allowed: new Set(['human']), transport: 'websocket' },
    api: {
      async verify() {},
      async register() { return { robot_id: bot, im_token: 'fixture-im-secret', ws_url: peer.wsUrl } },
      async send(_to, _text, _signal, type) { assert.equal(type, 1); return String(runs) },
    },
    host: { async run() { runs++; return 'reply' } },
  })
  const running = worker.run(stop.signal).catch(error => { if (!stop.signal.aborted) throw error })
  // Hold a rejection handler during the test; finally also checks the outcome.
  void running.catch(() => {})
  const send = messageId => peer.send({
    messageId, channelId: 'wire-private', channelType: 1, sender: 'human', payload: { type: 1, content: 'hello' },
  })
  const sent = () => store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='sent'").get().n
  try {
    await until(() => peer.send)
    send('9223372036854775806')
    await until(() => peer.acked.length === 1)
    assert.equal(store.db.prepare('SELECT message_id FROM jobs').get().message_id, '9223372036854775806')
    await until(() => sent() === 1)
    peer.disconnect()
    await until(() => peer.connections === 2 && peer.send)
    send('9223372036854775806')
    send('9223372036854775807')
    await until(() => peer.acked.length === 3 && sent() === 2)
    assert.equal(runs, 2)
  } finally {
    stop.abort()
    await running
    await peer.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('REST heartbeat follows acknowledged socket lifetime without reconnecting on heartbeat failure', async () => {
  const stop = new AbortController(), logs = []
  let connect, disconnect, beats = 0, registrations = 0, closed = 0, heartbeatSignal
  const connected = new Promise(resolve => { connect = resolve })
  const run = receiveRealtime({ signal: stop.signal, botUid: 'fixture', accept() {}, log: line => logs.push(line),
    api: { async register() { registrations++; return {} }, async heartbeat(signal) {
      beats++; heartbeatSignal = signal; throw new Error('fixture offline heartbeat')
    } },
    makeConnection(_accept, end) { disconnect = end; return { async connect() { await connected }, async close() { closed++ } } },
    pause: async () => { stop.abort() },
  })
  await delay(10)
  assert.equal(beats, 0)
  connect()
  await until(() => beats === 1 && logs.includes('octo_heartbeat_unavailable'))
  assert.equal(registrations, 1)
  assert.equal(closed, 0)
  disconnect(new Error('fixture disconnected'))
  await run
  assert.equal(heartbeatSignal.aborted, true)
  assert.equal(beats, 1)
  assert.equal(closed, 1)
})
