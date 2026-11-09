import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OctoClient } from '../src/octo.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'octo-test-'))
  return dir
}
const config = { botUid: 'bot', spaceId: 'space', allowed: new Set(['alice']) }
const signal = new AbortController().signal
const event = (overrides = {}) => ({
  event_id: '9223372036854775805',
  message: {
    message_id: '9223372036854775806', from_uid: 'alice', channel_id: 'different-wire-dm-id',
    channel_type: 1, payload: { type: 1, content: '你好' }, ...overrides,
  },
})
const next = store => store.next(Date.now())

test('HTTP round trip persists before ACK, gates inputs, preserves IDs, and dedupes replay', async t => {
  const dir = database()
  const store = new Store(dir, 'test-bot')
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const captured = []
  const errors = []
  let runs = 0, polls = 0
  const e = event()
  const wire = JSON.stringify({ status: 1, results: [
    e,
    { ...event({ channel_type: 2, message_id: '3' }), event_id: '4' },
    { ...event({ from_uid: 'mallory', message_id: '5' }), event_id: '6' },
    { ...event({ payload: { type: 1, content: '/bash' }, message_id: '7' }), event_id: '8' },
    { ...event({ from_uid: 'bot', message_id: '9' }), event_id: '10' },
    { ...event({ message_id: '11' }), event_id: '12', event_type: 'bot_task' },
  ] }).replace(/"(922337203685477580[56])"/g, '$1')
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      captured.push([req.url, body])
      assert.equal(req.method, 'POST')
      const json = value => res.end(JSON.stringify(value))
      if (req.url === '/api/v1/auth/verify-bot') {
        assert.equal(req.headers.authorization, undefined)
        assert.equal(body.bot_token, 'app_fixture')
        json({ bot_uid: 'bot', space_id: 'space' })
        return
      }
      assert.equal(req.headers.authorization, 'Bearer app_fixture')
      if (req.url === '/api/v1/bot/events') {
        assert.deepEqual(body, { event_id: polls++ ? Number(e.event_id) : 0, limit: 20, wait: 15 })
        res.end(wire)
      } else if (req.url.endsWith('/ack')) {
        if (req.url.includes(e.event_id)) {
          assert.equal(store.db.prepare('SELECT message_id FROM jobs').get().message_id, e.message.message_id)
        }
        json({ status: 200 })
      } else if (req.url === '/api/v1/bot/sendMessage') {
        assert.deepEqual(body, { channel_id: 'alice', channel_type: 1, payload: { type: 1, content: '你好，Alice', reply: { message_id: e.message.message_id } } })
        res.end('{"message_id":9223372036854775807,"message_seq":4}')
      } else throw new Error('unexpected route')
    } catch (error) {
      errors.push(error)
      res.writeHead(500).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const api = new OctoClient({ apiBase: 'http://127.0.0.1:' + server.address().port + '/api', token: 'app_fixture', waitSeconds: 15 })
  const host = { async run(session, text, created) {
    runs++
    assert.match(session.session_id, /^session-/)
    assert.equal(text, '你好')
    created()
    return '你好，Alice'
  } }
  const worker = new Worker({ api, store, host, config, log() {} })
  await api.verify('bot', 'space', signal)
  await assert.rejects(api.verify('wrong', 'space', signal), /bot_identity_mismatch/)
  await worker.ingest(signal)
  await worker.process(next(store), signal)
  await worker.ingest(signal)
  assert.equal(next(store), undefined)
  assert.equal(runs, 1)
  assert.equal(captured.filter(([route]) => route.endsWith('/ack')).length, 6)
  assert.equal(captured.filter(([route]) => route.endsWith('/sendMessage')).length, 1)
  const row = store.db.prepare('SELECT state,result_id,input,reply FROM jobs').get()
  assert.deepEqual({ ...row }, { state: 'sent', result_id: '9223372036854775807', input: '', reply: null })
  assert.deepEqual(errors, [])
})

test('reopen preserves pending jobs, retains conversation and holds ambiguous work', async t => {
  const dir = database()
  let store = new Store(dir, 'test-bot')
  assert.throws(() => new Store(dir, 'test-bot'), /locked/)
  for (let i = 1; i <= 3; i++) store.add(String(i), { messageId: String(i), sender: 'alice', text: 'text' })
  const sessionId = store.session('alice').session_id
  store.sessionCreated('alice')
  store.running(1)
  store.ready(2, 'answer')
  store.sending(2)
  store.close()
  assert.throws(() => new Store(dir, 'other-bot'), /state_bound_to_another_bot/)
  store = new Store(dir, 'test-bot')
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal(store.session('alice').session_id, sessionId)
  assert.equal(store.session('alice').created, 1)
  assert.deepEqual(store.db.prepare('SELECT issue FROM jobs WHERE state=\'review\' ORDER BY seq').all().map(r => r.issue),
    ['interrupted_running', 'interrupted_sending'])
  assert.equal(next(store).seq, 3)
})

test('ambiguous send is held; an explicit 429 retries only the delivery', async t => {
  const dir = database()
  const store = new Store(dir, 'test-bot')
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let runs = 0, sends = 0
  const api = { async send() {
    sends++
    if (sends === 1) {
      const { OctoError } = await import('../src/octo.js')
      throw new OctoError('http_429', 429)
    }
    throw new Error('network lost after request')
  } }
  const host = { async run() { runs++; return 'answer' } }
  const worker = new Worker({ api, store, host, config, log() {} })
  store.add('1', { messageId: '1', sender: 'alice', text: 'text' })
  await worker.process(next(store), signal)
  assert.equal(next(store), undefined)
  await worker.process(store.next(Date.now() + 10_000), signal)
  assert.equal(next(store), undefined)
  assert.equal(runs, 1)
  assert.equal(sends, 2)
  assert.equal(store.db.prepare('SELECT state FROM jobs').get().state, 'review')
})

test('only directed, opted-in User Bot group and topic text reaches its original route', async t => {
  const dir = database()
  const store = new Store(dir, 'test-bot')
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const accepted = { ...config, groups: new Set(['group']), threads: new Set(['group____topic']) }
  const channel = (id, type, channelId, sender = 'alice', mention = { uids: ['bot'] }, space = 'space') => ({
    event_id: String(id), message: {
      message_id: String(id), channel_id: channelId, channel_type: type, from_uid: sender,
      payload: { type: 1, content: 'hello', space_id: space, mention },
    },
  })
  const source = [
    channel(1, 2, 'group'), channel(2, 5, 'group____topic'), channel(3, 1, 'wire-dm-id'),
    channel(4, 5, 'group____other'), channel(5, 2, 'group', 'alice', {}),
    channel(6, 2, 'group', 'alice', { uids: ['bot'], ais: 1 }),
    channel(7, 2, 'group', 'alice', { uids: ['bot'] }, 'other-space'),
    channel(8, 2, 'group', 'mallory'),
  ]
  const sends = [], sessions = []
  const api = {
    async events() { return source }, async ack() {},
    async rules() { return [] },
    async send(address, _text, _signal, type) { sends.push([type, address]); return String(sends.length) },
  }
  const host = { async run(session, _text, created) { sessions.push(session.session_id); created(); return 'answer' } }
  const worker = new Worker({ api, store, host, config: accepted, log() {} })
  await worker.ingest(signal)
  for (let i = 0; i < 3; i++) await worker.process(next(store), signal)
  assert.equal(next(store), undefined)
  assert.deepEqual(sends, [[2, 'group'], [5, 'group____topic'], [1, 'alice']])
  assert.equal(new Set(sessions).size, 3)
  source.splice(0, source.length, channel(9, 2, 'group'), channel(10, 5, 'group____topic'))
  await worker.ingest(signal)
  await worker.process(next(store), signal)
  assert.equal(sessions[3], sessions[0])
  accepted.threads.clear()
  await worker.process(next(store), signal)
  assert.equal(store.db.prepare('SELECT issue FROM jobs WHERE message_id=?').get('10').issue, 'route_not_allowed')
  assert.equal(sends.length, 4)
})

test('existing v0.1 jobs retain their DM address and session after upgrade', async t => {
  const dir = database()
  const old = new DatabaseSync(join(dir, 'channel.sqlite'))
  old.exec(`
    CREATE TABLE jobs (
      seq INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL,
      sender TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      reply TEXT, result_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL DEFAULT 0, issue TEXT
    );
    CREATE TABLE conversations (sender TEXT PRIMARY KEY, session_id TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0);
    INSERT INTO jobs (message_id,event_id,sender,input) VALUES ('1','2','alice','old input');
    INSERT INTO conversations VALUES ('alice','session-old',1);
  `)
  old.close()
  const store = new Store(dir, 'test-bot')
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const api = { async send(address, text, _signal, type) {
    assert.deepEqual([address, text, type], ['alice', 'reply', 1]); return '3'
  } }
  const host = { async run(session, text) {
    assert.equal(session.session_id, 'session-old'); assert.equal(session.created, 1); assert.equal(text, 'old input'); return 'reply'
  } }
  await new Worker({ api, store, host, config, log() {} }).process(next(store), signal)
  assert.equal(store.db.prepare('SELECT state FROM jobs').get().state, 'sent')
})
