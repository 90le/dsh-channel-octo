import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'
import { OctoClient } from '../src/octo.js'

// Every request is answered in memory. Only these generated private SQLite
// directories are written; this suite never reads account settings or tokens.
const dm = { channel_type: 1, channel_id: 'human' }
const message = (seq, extra = {}) => ({ messageId: String(seq), messageSeq: seq,
  sender: 'human', channelType: 1, channelId: 'human', text: 'synthetic ' + seq, ...extra })
const wire = (seq, extra = {}) => ({ message_id: String(seq), message_seq: seq,
  from_uid: 'human', channel_type: 1, channel_id: 'synthetic-private-route',
  payload: { type: 1, content: 'synthetic ' + seq }, ...extra })

function fixture(t, rows = []) {
  const dir = mkdtempSync(join(tmpdir(), 'octo-inbox-regression-'))
  const store = new Store(dir, 'synthetic-inbox-review'), stop = new AbortController()
  const config = { botUid: 'bot', spaceId: 'synthetic-space', allowed: new Set(['human', 'other']),
    ownerUid: 'human', transport: 'websocket', toolScope: 'admitted', toolPermission: 'workspace-write' }
  const state = { rows, requests: [], logs: [] }
  const api = new OctoClient({ ...config, apiBase: 'https://inbox-regression.invalid/api', token: 'bf_synthetic_only',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://inbox-regression.invalid/api/v1/bot/messages/sync')
      const req = JSON.parse(options.body)
      state.requests.push(req)
      const respond = () => {
        const ordered = state.rows.filter(row => req.channel_type !== 1 || row.from_uid === req.channel_id || row.from_uid === 'bot')
          .sort((a, b) => a.message_seq - b.message_seq)
        return Response.json({ messages: req.pull_mode === 0 ? ordered.slice(-1)
          : ordered.filter(row => row.message_seq >= req.start_message_seq
            && (!req.end_message_seq || row.message_seq < req.end_message_seq)).slice(0, req.limit) })
      }
      return state.respond ? state.respond(req, respond) : respond()
    } })
  // Question fallback sends are synthetic too; no socket or worker loop is started.
  api.send = async () => '900001'
  const worker = new Worker({ api, store, config, host: {}, log: line => state.logs.push(line) })
  t.after(() => {
    stop.abort()
    store.close()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    assert.ok(basename(dir).startsWith('octo-inbox-regression-'))
    rmSync(dir, { recursive: true, force: true })
  })
  return { worker, inbox: worker.inbox, api, config, store, state, signal: stop.signal, stop, dir }
}

function seed(f, seq = 10) {
  f.inbox.connection(true)
  f.inbox.receive('ws:' + seq, message(seq))
  f.store.sent(f.store.next(Date.now()).seq, 'synthetic-reply')
  f.inbox.connection(false)
}

async function openQuestion(f, id, label = 'Approve') {
  const stop = new AbortController()
  const waiting = f.worker.questions.ask([{ id, question: 'Synthetic decision ' + id,
    options: [{ label }] }], {
    sender: 'human', channel_type: 1, channel_id: 'human', session_id: 'synthetic-in-flight-session',
  }, f.config, AbortSignal.any([f.signal, stop.signal]), () => {})
  void waiting.catch(() => {})
  for (let i = 0; i < 8 && !f.worker.questions.current?.ready; i++) await Promise.resolve()
  assert.equal(f.worker.questions.current?.ready, true, 'fixture must reach an actual native question wait')
  return { stop, waiting, current: f.worker.questions.current }
}

test('mixed sequenced history and unsequenced card jobs cannot create a queue dependency cycle', t => {
  const f = fixture(t)
  f.store.add('ws:20', message(20))
  f.store.add('1000', message(undefined, { messageId: 'card_action:1000', text: 'synthetic card action' }))
  f.store.add('history:10', message(10))
  const drained = []
  for (let i = 0; i < 3; i++) {
    const job = f.store.next(Date.now())
    assert.ok(job, 'queued work must make progress with sequence 20, card action, recovered sequence 10')
    drained.push(job.message_seq)
    f.store.sent(job.seq, 'synthetic-reply')
  }
  assert.deepEqual(drained.filter(seq => seq !== null), [10, 20])
})

for (const [name, flags] of [['revoked', { message_extra: { revoke: 1 } }], ['deleted', { is_deleted: 1 }]]) {
  test(`${name} history cannot release an older live-staged copy for execution`, async t => {
    const f = fixture(t, [wire(10), wire(11, flags)])
    seed(f)
    f.inbox.receive('ws:11', message(11))
    assert.equal(f.store.stagedInbox(dm).length, 1)
    f.inbox.connection(true)
    await f.inbox.sweep(f.signal)
    assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('11'), undefined,
      'the authoritative revocation/deletion must suppress the previously staged payload')
    assert.equal(f.store.stagedInbox(dm).length, 0)
  })
}

test('pause with stopIntake during an awaited history page cannot lose a durable staged message', async t => {
  const f = fixture(t, [wire(10), wire(11)])
  seed(f)
  f.inbox.receive('ws:11', message(11))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.state.respond = async (req, respond) => {
    if (req.pull_mode === 1) { entered.resolve(); await release.promise }
    return respond()
  }
  f.inbox.connection(true)
  const sweeping = f.inbox.sweep(f.signal)
  await entered.promise
  f.worker.pause(true)
  release.resolve()
  await sweeping
  const receipt = f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('11')
  const staged = f.store.stagedInbox(dm).find(row => row.message_id === '11')
  assert.ok(receipt || staged, 'an ACKed staged message must retain a receipt or recoverable stage when intake is paused')
})

test('live input staged before a native question opens cannot answer that later question', async t => {
  const f = fixture(t, [wire(10), wire(11, { payload: { type: 1, content: '1' } })])
  seed(f)
  // An existing in-flight job can open its native question while recovery is
  // holding this earlier socket message. Its origin being "live" is insufficient.
  f.inbox.receive('ws:11', message(11, { text: '1' }))
  const waiting = f.worker.questions.ask([{ id: 'later-question', question: 'Approve the later action?',
    options: [{ label: 'Approve' }] }], {
    sender: 'human', channel_type: 1, channel_id: 'human', session_id: 'synthetic-in-flight-session',
  }, f.config, f.signal, () => {})
  void waiting.catch(() => {})
  try {
    for (let i = 0; i < 8 && !f.worker.questions.current?.ready; i++) await Promise.resolve()
    assert.equal(f.worker.questions.current?.ready, true, 'fixture must reach an actual native question wait')
    f.inbox.connection(true)
    await f.inbox.sweep(f.signal)
    assert.equal(f.worker.questions.current?.ready, true,
      'text sent before the question existed must not be consumed as its approval')
    assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('11')?.state, 'queued')
  } finally {
    f.stop.abort()
    await waiting.catch(() => {})
  }
})

test('a staged live answer still resolves the original ready question exactly once', async t => {
  const f = fixture(t, [wire(10), wire(11, { payload: { type: 1, content: '1' } })])
  seed(f)
  const question = await openQuestion(f, 'original-question')
  try {
    f.inbox.receive('ws:11', message(11, { text: '1' }))
    assert.equal(f.store.stagedInbox(dm)[0].question_key, question.current.key)
    f.inbox.connection(true)
    await f.inbox.sweep(f.signal)
    assert.notEqual(f.worker.questions.current?.ready, true, 'the matching original question must receive its answer')
    assert.deepEqual(await question.waiting, { answers: [{ id: 'original-question', selected: ['Approve'] }] })
    f.inbox.receive('ws:11', message(11, { text: '1' }))
    const receipts = f.store.db.prepare('SELECT state,session_id FROM jobs WHERE message_id=?').all('11')
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].state, 'ignored')
    assert.equal(receipts[0].session_id, 'synthetic-in-flight-session')
    assert.equal(f.store.stagedInbox(dm).length, 0)
  } finally {
    question.stop.abort()
    await question.waiting.catch(() => {})
  }
})

test('a staged answer bound to a closed question cannot answer its replacement or steer its job', async t => {
  const f = fixture(t, [wire(10), wire(11, { payload: { type: 1, content: '1' } })])
  seed(f)
  const original = await openQuestion(f, 'closed-question')
  let replacement
  try {
    f.inbox.receive('ws:11', message(11, { text: '1' }))
    assert.equal(f.store.stagedInbox(dm)[0].question_key, original.current.key)
    original.stop.abort()
    await assert.rejects(original.waiting, { name: 'AbortError' })
    replacement = await openQuestion(f, 'replacement-question')
    assert.notEqual(replacement.current.key, original.current.key)
    f.config.sendMode = 'steer'
    f.worker.currentJob = { seq: 1, sender: 'human', channel_type: 1, channel_id: 'human' }
    f.worker.attemptSteering = () => assert.fail('releasing an earlier staged message must not steer a later job')
    f.inbox.connection(true)
    await f.inbox.sweep(f.signal)
    assert.equal(f.worker.questions.current, replacement.current)
    assert.equal(replacement.current.ready, true)
    assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('11')?.state, 'queued')
    assert.equal(f.worker.steering.size, 0)
    assert.equal(f.store.stagedInbox(dm).length, 0)
  } finally {
    original.stop.abort()
    replacement?.stop.abort()
    await Promise.allSettled([original.waiting, replacement?.waiting])
  }
})

test('an authoritative edit replaces staged text and cannot answer even its original question', async t => {
  const f = fixture(t, [wire(10), wire(11, { payload: { type: 1, content: '1' },
    message_extra: { content_edit: { type: 1, content: 'revised synthetic instruction' } } })])
  seed(f)
  const question = await openQuestion(f, 'question-before-edit')
  try {
    f.inbox.receive('ws:11', message(11, { text: '1' }))
    assert.equal(f.store.stagedInbox(dm)[0].question_key, question.current.key)
    f.inbox.connection(true)
    await f.inbox.sweep(f.signal)
    assert.equal(f.worker.questions.current, question.current)
    assert.equal(question.current.ready, true, 'an edited historical payload is not a fresh answer')
    const job = f.store.db.prepare('SELECT state,input FROM jobs WHERE message_id=?').get('11')
    assert.equal(job?.state, 'queued')
    assert.equal(job?.input, 'revised synthetic instruction')
    assert.equal(f.store.stagedInbox(dm).length, 0)
  } finally {
    question.stop.abort()
    await question.waiting.catch(() => {})
  }
})

test('failed oldest routes do not permanently starve the 101st healthy recovery route', async t => {
  const f = fixture(t)
  for (let i = 0; i < 101; i++) {
    const sender = 'synthetic' + i
    f.config.allowed.add(sender)
    f.store.enrolInbox(message(1, { messageId: String(i + 1), sender, channelId: sender }), true)
    f.store.db.prepare('UPDATE inbox_routes SET checked_ms=? WHERE channel_id=?').run(i, sender)
  }
  f.state.respond = req => req.channel_id === 'synthetic100'
    ? Response.json({ messages: [] }) : new Response(null, { status: 403 })
  f.inbox.connection(true)
  for (let i = 0; i < 3; i++) await f.inbox.sweep(f.signal)
  assert.ok(f.state.requests.some(req => req.channel_id === 'synthetic100'),
    'repeated bounded sweeps must eventually visit healthy routes beyond the first 100 failures')
  assert.equal(f.store.inboxRoute(1, 'synthetic100').blocked, 0)
})

test('a failed SQLite page commit rolls back both observations and staged rows', t => {
  const f = fixture(t)
  seed(f)
  f.store.db.exec(`CREATE TRIGGER synthetic_checkpoint_failure BEFORE UPDATE OF checkpoint ON inbox_routes
    BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END`)
  assert.throws(() => f.store.checkpointInbox(dm, 12, [message(11), message(12)], ['11', '12']),
    /synthetic checkpoint failure/)
  assert.equal(f.store.inboxRoute(1, 'human').checkpoint, 9)
  assert.equal(f.store.stagedInbox(dm).length, 0)
  assert.equal(f.store.inboxSeen('11'), false)
  assert.equal(f.store.inboxSeen('12'), false)
})

for (const change of ['disconnect', 'config']) {
  test(`${change} during an awaited page cannot advance the checkpoint or release the route`, async t => {
    const f = fixture(t, [wire(10), wire(11)])
    seed(f)
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    f.state.respond = async (req, respond) => {
      if (req.pull_mode === 1) { entered.resolve(); await release.promise }
      return respond()
    }
    f.inbox.connection(true)
    const sweeping = f.inbox.sweep(f.signal)
    await entered.promise
    if (change === 'disconnect') f.inbox.connection(false)
    else f.worker.reconfigure({ ...f.config, allowed: new Set() }, {})
    release.resolve()
    await sweeping
    assert.equal(f.store.inboxRoute(1, 'human').checkpoint, 9)
    assert.equal(f.store.inboxRoute(1, 'human').blocked, 1)
    assert.equal(f.store.stagedInbox(dm).length, 0)
    assert.equal(f.store.inboxSeen('11'), false)
  })
}
