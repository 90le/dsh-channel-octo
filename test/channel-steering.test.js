import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'
import { admit } from '../src/octo.js'

const group = 'a'.repeat(32), otherGroup = 'b'.repeat(32)
const topic = group + '____' + '1'.repeat(19), otherTopic = group + '____' + '2'.repeat(19)
const cases = [
  { name: 'group', type: 2, id: group },
  { name: 'topic', type: 5, id: topic },
]

function fixture(t, route) {
  const root = mkdtempSync(join(tmpdir(), 'octo-channel-steering-'))
  const store = new Store(root, 'fixture-bot'), stop = new AbortController()
  t.after(() => { stop.abort(); store.close(); rmSync(root, { recursive: true, force: true }) })
  const config = {
    apiBase: 'https://steering.invalid/api', token: 'bf_fixture', botUid: 'bot', spaceId: 'space',
    allowed: new Set(['alice', 'bob']), ownerUid: 'alice', groups: new Set([group, otherGroup]),
    threads: new Set([topic, otherTopic]), toolScope: 'admitted', toolPermission: 'workspace-write',
    transport: 'websocket', sendMode: 'steer', sessionProfile: 'same-session', allowFiles: true,
    mediaDownloadOrigins: ['https://files.invalid'],
  }
  const sends = []
  const api = {
    async rules() { return [] },
    async send(id, text, _signal, type) { sends.push({ id, type, text }); return '800' },
  }
  const worker = new Worker({ api, store, config, host: {}, log() {} })
  function enqueue(id, { actor = 'alice', target = route, text = 'instruction ' + id, payload } = {}) {
    const message = admit({ message: { message_id: id, from_uid: actor,
      channel_type: target.type, channel_id: target.id,
      payload: { ...(payload ?? { type: 1, content: text }), mention: { uids: ['bot'] }, space_id: 'space' },
    } }, config)
    assert.ok(message, 'fixture message must pass actual admission')
    worker.acceptInbound('ws:' + id, message)
  }
  function start(payload) {
    enqueue('1', { text: 'original task', payload })
    const job = store.next(Date.now())
    // Match drain's current-job boundary without draining unrelated queued work.
    worker.currentJob = job
    return worker.process(job, stop.signal)
  }
  function insertOtherMessages() {
    enqueue('2', { actor: 'bob', text: 'another member must stay queued' })
    enqueue('3', { target: { type: 5, id: otherTopic }, text: 'another topic must stay queued' })
    enqueue('4', { target: { type: 2, id: otherGroup }, text: 'another group must stay queued' })
    enqueue('5', { target: { type: 1, id: 'alice' }, text: 'private chat must stay queued' })
  }
  const rows = () => store.db.prepare('SELECT message_id,state,input,result_id,session_id FROM jobs ORDER BY seq').all()
  function assertSeparate() {
    assert.deepEqual(rows().filter(row => ['2', '3', '4', '5'].includes(row.message_id)).map(row => [row.message_id, row.state]),
      [['2', 'queued'], ['3', 'queued'], ['4', 'queued'], ['5', 'queued']])
    assert.ok(rows().filter(row => ['2', '3', '4', '5'].includes(row.message_id)).every(row => row.input.endsWith('must stay queued')))
  }
  function assertCompleted() {
    assertSeparate()
    const merged = rows().filter(row => ['1', '6', '7'].includes(row.message_id))
    assert.deepEqual(merged.map(row => [row.message_id, row.state, row.result_id]),
      [['1', 'sent', '800'], ['6', 'sent', '800'], ['7', 'sent', '800']])
    assert.equal(new Set(merged.map(row => row.session_id)).size, 1)
    assert.ok(merged[0].session_id)
    assert.equal(sends.length, 1)
    assert.equal(sends[0].id, route.id)
    assert.equal(sends[0].type, route.type)
    assert.equal(store.next(Date.now()).message_id, '2', 'other actor is still the next ordinary queued task')
  }
  return { store, worker, config, sends, enqueue, start, insertOtherMessages, rows, assertSeparate, assertCompleted }
}

async function reached(promise, processing) {
  return Promise.race([promise, processing.then(() => { throw new Error('worker ended before the expected phase') })])
}

for (const route of cases) {
  test(`${route.name}: active steering merges only the same actor and exact channel, skipping earlier foreign jobs`, { timeout: 5000 }, async t => {
    const f = fixture(t, route), entered = Promise.withResolvers(), release = Promise.withResolvers(), offers = []
    let runs = 0
    f.worker.host.run = async (_session, _input, created, _signal, _rules, phase, _timeout, _tools, extras) => {
      runs++
      await created()
      extras.onSteer((text, reserve) => { offers.push(text); reserve() })
      entered.resolve()
      phase('running')
      try { await release.promise; return 'completed with inserted instructions' }
      finally { extras.onSteer(undefined) }
    }
    const processing = f.start()
    try {
      await reached(entered.promise, processing)
      f.insertOtherMessages()
      f.assertSeparate()
      assert.deepEqual(offers, [])
      f.enqueue('6', { text: 'first inserted instruction' })
      f.enqueue('6', { text: 'first inserted instruction' }) // WS redelivery
      f.enqueue('7', { text: 'second inserted instruction' })
      assert.deepEqual(offers, ['first inserted instruction', 'second inserted instruction'])
      f.assertSeparate()
      assert.deepEqual(f.rows().filter(row => ['6', '7'].includes(row.message_id)).map(row => row.state), ['running', 'running'])
    } finally {
      release.resolve()
      await processing
    }
    assert.equal(runs, 1)
    f.assertCompleted()
  })

  test(`${route.name}: attachment supplement includes only same-actor same-channel text and retains foreign jobs`, { timeout: 5000 }, async t => {
    const f = fixture(t, route), downloading = Promise.withResolvers(), release = Promise.withResolvers(), runs = []
    const bytes = Buffer.from('synthetic attachment for the current task')
    f.config.fetchImpl = async (url, request) => {
      assert.equal(url, 'https://files.invalid/input.txt')
      assert.equal(request.headers.Authorization, undefined)
      downloading.resolve()
      await release.promise
      return new Response(bytes, { headers: { 'Content-Type': 'text/plain' } })
    }
    f.worker.host.run = async (_session, input, created, _signal, _rules, _phase, _timeout, tools, extras) => {
      runs.push({ input, tools, attachments: extras.attachments, order: extras.order })
      await created()
      return 'attachment summary complete'
    }
    const processing = f.start({ type: 8, name: 'input.txt', url: 'https://files.invalid/input.txt' })
    try {
      await reached(downloading.promise, processing)
      f.insertOtherMessages()
      f.enqueue('6', { text: 'summarize this attachment' })
      f.enqueue('6', { text: 'summarize this attachment' })
      f.enqueue('7', { text: 'include the total' })
      f.assertSeparate()
    } finally {
      release.resolve()
      await processing
    }
    assert.equal(runs.length, 1)
    assert.equal(runs[0].tools, true)
    assert.equal(runs[0].input, '\n\n【同一用户补充的要求】\nsummarize this attachment\ninclude the total')
    assert.deepEqual(runs[0].attachments, [{ name: 'input.txt', mime: 'text/plain', bytes }])
    assert.deepEqual(runs[0].order, [{ media: 0 }, { text: runs[0].input }])
    f.assertCompleted()
  })
}

test('steering candidate also distinguishes identical address strings with different channel types and preserves legacy DM fallback', t => {
  const f = fixture(t, cases[0])
  f.store.add('1', { messageId: '1', sender: 'alice', text: 'active', channelType: 5, channelId: topic })
  const job = f.store.next(Date.now())
  f.store.running(job.seq)
  f.store.add('2', { messageId: '2', sender: 'alice', text: 'wrong type', channelType: 2, channelId: topic })
  f.store.add('3', { messageId: '3', sender: 'bob', text: 'wrong actor', channelType: 5, channelId: topic })
  f.store.add('4', { messageId: '4', sender: 'alice', text: 'correct', channelType: 5, channelId: topic })
  assert.equal(f.store.steerCandidate(job).message_id, '4')
  assert.deepEqual(f.rows().slice(1).map(row => row.state), ['queued', 'queued', 'queued'])
  f.store.add('5', { messageId: '5', sender: 'alice', text: 'DM active' })
  const dm = f.store.db.prepare("SELECT * FROM jobs WHERE message_id='5'").get()
  f.store.running(dm.seq)
  f.store.add('6', { messageId: '6', sender: 'bob', channelId: 'alice', text: 'wrong DM actor' })
  f.store.add('7', { messageId: '7', sender: 'alice', text: 'legacy DM supplement' })
  f.store.db.prepare("UPDATE jobs SET channel_id=NULL WHERE message_id IN ('5','7')").run()
  assert.equal(f.store.steerCandidate({ ...dm, channel_id: null }).message_id, '7')
})
