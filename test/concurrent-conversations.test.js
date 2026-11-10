import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const group = 'a'.repeat(32), otherGroup = 'b'.repeat(32)
const topic = group + '____' + '1'.repeat(19)
const rooms = { group: [2, group], other: [2, otherGroup], topic: [5, topic], alice: [1, 'alice'], bob: [1, 'bob'] }

async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('expected worker state was not reached')
}

function fixture(t, run, overrides = {}) {
  const parent = resolve(tmpdir())
  const directory = mkdtempSync(join(parent, 'octo-concurrent-'))
  const store = new Store(directory, 'synthetic-concurrent')
  const lifetime = new AbortController(), sends = []
  const config = {
    botUid: 'bot', spaceId: 'space', ownerUid: 'alice', apiBase: 'https://octo-fixture.invalid/api',
    token: 'bf_fixture', senderPolicy: 'allowlist', channelPolicy: 'allowlist',
    allowed: new Set(['alice', 'bob']), groups: new Set([group, otherGroup]), threads: new Set([topic]),
    toolScope: 'private', toolPermission: 'workspace-write', dmCommands: 'safe', groupCommands: 'safe',
    transport: 'websocket', sendMode: 'steer', progress: 'off', maxConcurrentTurns: 4,
    fetchImpl: async url => {
      assert.equal(new URL(url).hostname, 'octo-fixture.invalid')
      return new Response(null, { status: 404 })
    }, ...overrides,
  }
  const worker = new Worker({ config, store, host: { run }, log() {}, api: {
    async allowsMessage() { return true },
    async rules() { return [] },
    async send(id, text, _signal, type) {
      const messageId = String(800 + sends.length)
      sends.push({ id, type, text, messageId })
      return messageId
    },
  } })
  const draining = worker.drain(lifetime.signal).catch(error => {
    if (error.name !== 'AbortError') throw error
  })
  const send = (id, room, sender, text, opts = {}) => worker.acceptInbound('ws:' + id, {
    messageId: String(id), messageSeq: id, channelType: rooms[room][0], channelId: rooms[room][1], sender, text, ...opts,
  })
  t.after(async () => {
    lifetime.abort()
    await draining
    await Promise.allSettled(worker.stopControls)
    store.close()
    assert.ok(resolve(directory).startsWith(join(parent, 'octo-concurrent-')))
    rmSync(directory, { recursive: true, force: true })
  })
  const row = id => store.db.prepare('SELECT state,result_id,session_id FROM jobs WHERE message_id=?').get(String(id))
  return { worker, send, sends, row }
}

const hold = (promise, signal) => Promise.race([promise, new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})])

test('route turns overlap; current actor steers while another actor’s queued burst waits and enters together', { timeout: 6500 }, async t => {
  const release = Promise.withResolvers(), started = new Map(), offers = []
  const f = fixture(t, async (session, input, created, signal, _rules, stage, _time, tools, extras) => {
    const key = input.split('\n', 1)[0]
    started.set(key, { input, session: session.session_id, tools })
    await created()
    if (key === 'B starts') {
      extras.onSteer((text, reserve) => { reserve(); offers.push(text); return true })
      stage('running')
      await hold(release.promise, signal)
    }
    return 'done ' + key
  })
  f.send(1, 'group', 'bob', 'B starts')
  await until(() => started.has('B starts'))
  f.send(2, 'group', 'alice', 'A one')
  f.send(3, 'group', 'alice', 'A two')
  f.send(4, 'group', 'bob', 'B live supplement')
  f.send(5, 'group', 'alice', 'A three')
  f.send(6, 'alice', 'alice', 'Alice private')
  f.send(7, 'bob', 'bob', 'Bob private')
  f.send(8, 'topic', 'alice', 'Independent topic')
  f.send(9, 'other', 'alice', 'Other group')
  await until(() => [6, 7, 8, 9].every(id => f.row(id)?.state === 'sent'))
  assert.equal(f.row(1).state, 'running')
  assert.deepEqual(offers, ['B live supplement'])
  assert.deepEqual([2, 3, 5].map(id => f.row(id).state), ['queued', 'queued', 'queued'])
  assert.equal(new Set([6, 7, 8, 9].map(id => f.row(id).session_id)).size, 4)
  release.resolve()
  await until(() => [1, 2, 3, 4, 5].every(id => f.row(id)?.state === 'sent'))
  assert.equal(started.get('B starts').session, started.get('A one').session)
  assert.equal(started.get('B starts').tools, false, 'ordinary members can steer without receiving workspace tools')
  assert.match(started.get('A one').input, /A two\nA three/)
  assert.equal(f.row(1).result_id, f.row(4).result_id)
  assert.equal(new Set([2, 3, 5].map(id => f.row(id).result_id)).size, 1)
  assert.notEqual(f.row(1).result_id, f.row(2).result_id)
})

test('concurrent questions in different conversations keep their answers and /stop separate', { timeout: 6500 }, async t => {
  const f = fixture(t, async (_session, input, created, signal, _rules, _stage, _time, _tools, extras) => {
    await created()
    if (!input.startsWith('wait ')) return 'ordinary follow-up'
    const { answers } = await extras.onQuestion([{ id: 'q', question: input }], signal)
    return 'answer: ' + answers[0].custom
  }, { toolScope: 'owner' })
  f.send(10, 'alice', 'alice', 'wait private')
  f.send(11, 'group', 'alice', 'wait group')
  await until(() => f.sends.some(row => row.id === 'alice' && row.text.includes('wait private'))
    && f.sends.some(row => row.id === group && row.text.includes('wait group')))
  f.send(12, 'group', 'bob', 'not the answer to the group question')
  assert.equal(f.row(12).state, 'queued')
  f.send(13, 'alice', 'alice', 'private response')
  await until(() => f.row(10)?.state === 'sent')
  assert.ok(f.sends.some(row => row.id === 'alice' && row.text === 'answer: private response'))
  assert.equal(f.row(11).state, 'running')
  f.send(14, 'group', 'alice', '/stop', { command: 'stop' })
  await until(() => f.row(11).state === 'stopped' && f.row(12).state === 'sent')
  assert.ok(!f.sends.some(row => row.id === group && row.text.startsWith('answer: ')))
  assert.ok(f.sends.some(row => row.id === group && row.text.includes('已请求停止')))
})

test('slot limit and pause drain all active conversations without starting a queued one', { timeout: 6500 }, async t => {
  const release = Promise.withResolvers(), started = new Set()
  const f = fixture(t, async (_session, input, created, signal) => {
    started.add(input)
    await created()
    await hold(release.promise, signal)
    return 'done'
  }, { maxConcurrentTurns: 2, sendMode: 'queue' })
  f.send(20, 'alice', 'alice', 'one')
  f.send(21, 'bob', 'bob', 'two')
  f.send(22, 'group', 'alice', 'three')
  await until(() => started.size === 2)
  assert.deepEqual([...started].sort(), ['one', 'two'])
  const paused = f.worker.pause()
  release.resolve()
  await paused
  assert.equal(f.row(20).state, 'sent')
  assert.equal(f.row(21).state, 'sent')
  assert.equal(f.row(22).state, 'queued')
  assert.equal(f.worker.activeByRoute.size, 0)
})
