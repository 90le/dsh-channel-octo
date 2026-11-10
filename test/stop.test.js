import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate, setTimeout as wait } from 'node:timers/promises'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'
import { admit } from '../src/octo.js'
import { OCTO_STOP } from '../src/im-controls.js'

function fixture(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-stop-'))
  const store = new Store(cwd, 'fixture'), lifetime = new AbortController()
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  const config = {
    botUid: 'bot', ownerUid: 'alice', spaceId: 'space', cwd, botKind: 'user',
    senderPolicy: 'allowlist', allowed: new Set(['alice', 'bob']), dmCommands: 'safe',
    transport: 'websocket', toolPermission: 'text-only', ...options,
  }
  const output = []
  const api = { async send(to, text) { output.push({ to, text }); return String(100 + output.length) } }
  const worker = new Worker({ store, config, api, log() {}, host: {} })
  worker.intakeSignal = lifetime.signal
  const inbound = (id, text, sender = 'alice', timestamp = Math.floor(Date.now() / 1000)) =>
    admit({ message: { message_id: String(id), message_seq: id, timestamp, from_uid: sender,
      channel_type: 1, payload: { type: 1, content: text } } }, config)
  const enqueue = (id, text, sender) => store.add('ws:' + id, inbound(id, text, sender))
  const stop = (id, sender, timestamp) => worker.inbox.receive('ws:' + id, inbound(id, '/stop', sender, timestamp))
  const state = id => store.db.prepare('SELECT state,issue,result_id FROM jobs WHERE message_id=?').get(String(id))
  return { store, worker, config, output, api, lifetime, inbound, enqueue, stop, state }
}

async function until(read) {
  for (let i = 0; i < 100 && !read(); i++) await wait(10)
  assert.ok(read(), 'expected worker transition')
}

test('a fresh same-actor stop bypasses blocked recovery and the queue, and cannot be replayed', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const entered = Promise.withResolvers(), next = Promise.withResolvers(), release = Promise.withResolvers()
  let firstSignal, secondSignal, runs = 0
  f.worker.host.run = async (_s, text, _created, signal) => {
    runs++
    if (text === 'slow') {
      firstSignal = signal
      entered.resolve()
      await release.promise
      return 'must not send this late final'
    }
    secondSignal = signal
    next.resolve()
    return 'next final'
  }
  f.enqueue(10, 'slow')
  const draining = f.worker.drain(f.lifetime.signal).catch(error => {
    if (error.name !== 'AbortError') throw error
  })
  try {
    await entered.promise
    f.enqueue(11, 'next')
    // The command bypasses intake recovery; it is not sent to the model.
    f.worker.inbox.enabled = true
    f.worker.inbox.online = false
    f.stop(12, 'bob')
    f.stop(13, 'alice', Math.floor(Date.now() / 1000) - 30)
    f.worker.acceptInbound('history:14', f.inbound(14, '/stop'), { historical: true })
    assert.equal(firstSignal.aborted, false)
    f.stop(15)
    assert.equal(firstSignal.reason, OCTO_STOP)
    assert.equal(f.state(10).state, 'stopped')
    assert.equal(f.state(10).issue, 'stopped_by_user')
    assert.equal(f.state(11).state, 'queued')
    release.resolve()
    await next.promise
    f.stop(15)
    assert.equal(secondSignal.aborted, false)
    await until(() => f.state(11)?.state === 'sent')
    assert.equal(runs, 2)
    assert.equal(f.output.filter(row => row.text.startsWith('已请求停止')).length, 1)
    assert.ok(!f.output.some(row => row.text.includes('late final')))
    assert.ok(f.output.some(row => row.text === 'next final'))
  } finally {
    release.resolve()
    f.lifetime.abort()
    await draining
    await Promise.all(f.worker.stopControls)
  }
})

test('a stop during delivery retains a late confirmed receipt and suppresses remaining chunks', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const sent = Promise.withResolvers(), release = Promise.withResolvers()
  f.worker.host.run = async () => ['A'.repeat(1200), 'B'.repeat(1200), 'C'.repeat(1200)].join('\n\n')
  const original = f.api.send
  f.api.send = async (to, text) => {
    if (text.startsWith('A')) {
      f.output.push({ to, text })
      sent.resolve()
      await release.promise
      return '201'
    }
    return original(to, text)
  }
  f.enqueue(20, 'produce long answer')
  const draining = f.worker.drain(f.lifetime.signal).catch(error => {
    if (error.name !== 'AbortError') throw error
  })
  try {
    await sent.promise
    f.stop(21)
    release.resolve()
    await until(() => !f.worker.activeWork)
    assert.equal(f.state(20).state, 'stopped')
    assert.equal(f.state(20).result_id, '201')
    assert.ok(!f.output.some(row => row.text.startsWith('B') || row.text.startsWith('C')))
  } finally {
    release.resolve()
    f.lifetime.abort()
    await draining
    await Promise.all(f.worker.stopControls)
  }
})
