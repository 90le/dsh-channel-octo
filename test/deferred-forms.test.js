import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'
import { OctoClient } from '../src/octo.js'
import { QuestionBridge } from '../src/questions.js'
import { manageDeferredForm, flushDeferredFeedback } from '../src/deferred-forms.js'

const form = { title: '稍后填写', text: '填写完成后继续原任务', inputs: [
  { id: 'note', kind: 'text', label: '说明', required: true },
], actions: [{ id: 'submit', label: '提交' }], expires_minutes: 1440 }
const manifest = { enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'], elements: ['TextBlock'],
  inputs: ['Input.Text'], config: { card_enabled: true, display_enabled: true, interaction_enabled: true } }

async function fixture(t, type = 1, app = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-deferred-fixture-'))
  const group = 'a'.repeat(32), route = { channel_type: type, channel_id: type === 1 ? 'alice' : group + (type === 5 ? '____123456789012345678' : '') }
  const f = { directory, route, sent: [], edits: [], acks: [], events: [], runs: [], exists: true, allowed: true,
    modelPolicy: 'a'.repeat(64) }
  f.config = { apiBase: 'https://deferred.invalid/api', token: app ? 'app_secretfixture' : 'bf_fixture',
    botUid: app ? 'app_fixture_bot' : 'bot', spaceId: app ? null : 'space', ...(app && { botKind: 'app' }),
    ownerUid: 'alice', cwd: directory, sessionProfile: 'fixture-model', toolPermission: 'workspace-write',
    toolScope: 'admitted', senderPolicy: 'allowlist', allowed: new Set(['alice']), channelPolicy: 'allowlist',
    groups: new Set([group]), threads: new Set([group + '____123456789012345678']), dmCommands: 'safe',
    groupCommands: 'safe', allowFiles: true, progress: 'off', transport: 'websocket', threadRuleMode: 'thread',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname, body = init.body && JSON.parse(init.body)
      if (path.endsWith('/card/profile')) return Response.json(manifest)
      if (path.endsWith('/sendMessage')) {
        const id = String(700 + f.sent.length)
        f.sent.push({ id, ...body })
        return Response.json({ message_id: id })
      }
      if (path.endsWith('/message/edit')) { f.edits.push(body); return Response.json({ status: 200 }) }
      if (path.endsWith('/users/batch')) return Response.json({ users: [{ uid: 'alice', robot: 0, status: 1 }], missing_uids: [] })
      if (path.endsWith('/messages/sync')) return Response.json({ messages: [] })
      if (path.includes('/messages/person/alice/')) {
        const id = path.split('/').at(-1), card = f.sent.find(row => row.id === id)
        if (!f.allowed) return Response.json({ status: 403 }, { status: 403 })
        return Response.json({ message_id: id, message_seq: 1, from_uid: card ? f.config.botUid : 'alice',
          ...route, payload: card?.payload ?? { type: 1, content: 'publish' } })
      }
      assert.fail('unexpected request ' + path)
    } }
  f.api = new OctoClient(f.config)
  if (!app) f.api.allowsMessage = async () => f.allowed
  f.api.events = async () => f.events
  f.api.ack = async id => { if (f.ackFails) throw new Error('temporary ACK failure'); f.acks.push(id) }
  f.api.readReceipt = undefined
  f.api.rules = async () => ({ current: '' })
  f.api.channel.members = async () => [{ uid: 'alice', name: 'Alice', robot: 0, role: 1 }, { uid: f.config.botUid, name: 'Bot', robot: 1 }]
  f.host = {
    exists: async () => f.exists,
    modelProfile: () => f.modelPolicy,
    async run(session, input, created, signal, rules, stage, timeout, toolsAllowed, extras) {
      f.runs.push({ session: session.session_id, input, toolsAllowed })
      await created()
      f.extras = extras
      if (f.runs.length === 1) {
        f.published = await extras.channelTools.execute('octo_form_publish', structuredClone(form), signal,
          { policy: f.modelPolicy, effective: f.modelPolicy })
        assert.equal(extras.channelTools.waitNames.includes('octo_form_publish'), false)
        return '表单已发布，可以稍后填写。'
      }
      return '已在原会话完成后续处理。'
    },
  }
  const open = () => {
    f.store = new Store(directory, 'synthetic-deferred')
    f.worker = new Worker({ api: f.api, config: f.config, store: f.store, host: f.host, log() {} })
  }
  open()
  f.signal = t.signal
  f.restart = async () => {
    f.store.close(); open()
    await new QuestionBridge({ api: f.api, store: f.store, log() {} }).closeInterrupted(t.signal)
  }
  f.ingest = async events => { f.events = events; await f.worker.ingest(t.signal, true) }
  f.submit = (id = '900', change = {}) => {
    const binding = f.store.deferredCard(f.published.message_id)
    return { event_id: id, event_type: 'card_action', event_data: {
      message_id: binding.messageId, ...route, operator_uid: 'alice', action_id: 'submit',
      space_id: app ? 'server-space' : 'space', data: { dsh_card_nonce: binding.cardNonce }, inputs: { note: '稍后的回答' }, ...change,
    } }
  }
  f.process = () => f.worker.process(f.store.next(Date.now()), t.signal)
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }) })
  f.store.add('1', { messageId: '1', sender: 'alice', channelType: type, channelId: route.channel_id, text: '请发一张稍后填写的表单' })
  await f.process()
  assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'pending')
  assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE message_id=?').get('1').state, 'sent')
  return f
}

for (const [type, app] of [[1, false], [2, false], [5, false], [1, true]]) {
  test('deferred form survives completed turn and restart, then continues exact session ' + type + '/' + app, async t => {
    const f = await fixture(t, type, app), session = f.runs[0].session
    assert.equal(f.runs.length, 1)
    await f.restart()
    assert.equal(f.edits.length, 0, 'restart must not retire a deferred form as an interrupted native ask')
    await f.ingest([f.submit()])
    assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'submitted')
    assert.deepEqual(f.acks, ['900'])
    await f.restart()
    await f.process()
    assert.equal(f.runs.length, 2)
    assert.equal(f.runs[1].session, session)
    assert.match(f.runs[1].input, /稍后的回答/)
    assert.equal(f.runs[1].toolsAllowed, true)
    await f.ingest([f.submit(), f.submit('901')])
    assert.equal(f.store.next(Date.now()), undefined)
    assert.equal(f.runs.length, 2)
    await f.worker.deferredFeedback(t.signal)
    assert.ok(f.edits.some(edit => !JSON.parse(edit.content_edit).card.actions))
  })
}

test('a late form resumes its original historical session after /new without stealing the new mapping', async t => {
  const f = await fixture(t), binding = f.store.deferredCard(f.published.message_id)
  const fresh = f.store.session(binding.deferred.conversation, 0, Date.now(), true)
  f.store.sessionCreated(binding.deferred.conversation)
  await f.ingest([f.submit()])
  await f.process()
  assert.equal(f.runs[1].session, binding.deferred.sessionId)
  assert.equal(f.store.session(binding.deferred.conversation).session_id, fresh.session_id)
})

test('wrong operator, route, nonce and unknown message cannot consume the form', async t => {
  const f = await fixture(t)
  for (const change of [{ operator_uid: 'bob' }, { channel_id: 'bob' }, { message_id: '888' },
    { data: { dsh_card_nonce: '0'.repeat(32) } }]) await f.ingest([f.submit('900', change)])
  assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'pending')
  assert.equal(f.store.next(Date.now()), undefined)
  assert.deepEqual(f.acks, [])
  await f.restart()
  await f.ingest([f.submit('901')])
  assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'submitted')
})

test('invalid submitted inputs retire the consumed action with a receipt and never start DSH', async t => {
  const f = await fixture(t)
  await f.ingest([f.submit('900', { inputs: {} })])
  assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'invalid')
  assert.deepEqual(f.acks, ['900'])
  assert.equal(f.store.next(Date.now()), undefined)
  await f.worker.deferredFeedback(t.signal)
  assert.match(f.edits.at(-1).content_edit, /格式无效/)
})

for (const kind of ['permission', 'model', 'deleted', 'archived', 'api']) {
  test('late submit does not execute after ' + kind + ' changes', async t => {
    const f = await fixture(t), binding = f.store.deferredCard(f.published.message_id)
    if (kind === 'permission') f.worker.config = { ...f.config, toolPermission: 'text-only' }
    if (kind === 'model') f.worker.config = { ...f.config, sessionProfile: 'new-model' }
    if (kind === 'deleted') f.store.forgetSession(binding.deferred.sessionId)
    if (kind === 'archived') f.worker.isArchived = () => true
    if (kind === 'api') f.allowed = false
    await f.ingest([f.submit()])
    assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'unavailable')
    assert.equal(f.store.next(Date.now()), undefined)
    assert.equal(f.runs.length, 1)
    assert.deepEqual(f.acks, ['900'])
  })
}

test('queued continuation rechecks session deletion and never creates a replacement', async t => {
  const f = await fixture(t), binding = f.store.deferredCard(f.published.message_id)
  await f.ingest([f.submit()])
  f.store.forgetSession(binding.deferred.sessionId)
  await f.process()
  assert.equal(f.runs.length, 1)
  assert.equal(f.store.knownSessions().length, 0)
  assert.equal(f.store.db.prepare('SELECT issue FROM jobs WHERE message_id=?').get('card_action:900').issue, 'deferred_session_unavailable')
})

test('deletion between exists and resume cannot redirect a deferred answer into a new current session', async t => {
  const f = await fixture(t), binding = f.store.deferredCard(f.published.message_id)
  const fresh = f.store.session(binding.deferred.conversation, 0, Date.now(), true)
  f.store.sessionCreated(binding.deferred.conversation)
  await f.ingest([f.submit()])
  const attempted = []
  f.host.run = async session => { attempted.push(session.session_id); throw new Error('session_missing') }
  await f.process()
  assert.deepEqual(attempted, [binding.deferred.sessionId])
  assert.equal(f.store.session(binding.deferred.conversation).session_id, fresh.session_id)
  assert.equal(f.store.db.prepare('SELECT issue FROM jobs WHERE message_id=?').get('card_action:900').issue,
    'deferred_session_unavailable')
})

test('changing the followed host default model rejects old forms before acceptance or queued execution', async t => {
  for (const queued of [false, true]) await t.test(String(queued), async t => {
    const f = await fixture(t)
    if (queued) await f.ingest([f.submit()])
    f.modelPolicy = 'b'.repeat(64) // Account sessionProfile is intentionally unchanged.
    if (queued) {
      await f.process()
      assert.equal(f.store.db.prepare('SELECT issue FROM jobs WHERE message_id=?').get('card_action:900').issue,
        'deferred_configuration_changed')
    } else {
      await f.ingest([f.submit()])
      assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'unavailable')
    }
    assert.equal(f.runs.length, 1)
  })
})

test('production card poll ACKs late terminal events after the last form is closed, with no new run', async t => {
  const f = await fixture(t), stop = new AbortController()
  f.events = [f.submit()]
  f.store.closeDeferredCard(f.published.message_id, 'cancelled', '已取消')
  assert.equal(f.store.hasOpenCard(), false)
  const ack = f.api.ack
  f.api.ack = async id => { await ack(id); stop.abort() }
  await f.worker.pollCardEvents(AbortSignal.any([t.signal, stop.signal, AbortSignal.timeout(3000)]))
  assert.deepEqual(f.acks, ['900'])
  assert.equal(f.store.next(Date.now()), undefined)
  assert.equal(f.runs.length, 1)
  assert.ok(f.worker.lateCardPollAt > Date.now(), 'terminal-only polling is rate limited')
})

test('a restarted interrupted continuation reports review instead of promising automatic execution', async t => {
  const f = await fixture(t)
  await f.ingest([f.submit()])
  f.store.running(f.store.next(Date.now()).seq, f.runs[0].session)
  await f.restart()
  assert.equal(f.store.deferredCard(f.published.message_id).responseState, 'review')
  await f.worker.deferredFeedback(t.signal)
  assert.match(f.edits.at(-1).content_edit, /不会自动重跑/)
  assert.doesNotMatch(f.edits.at(-1).content_edit, /将在原会话继续处理|已加入原会话的处理流程/)
  assert.equal(f.store.next(Date.now()), undefined)
})

test('cancel or expiry is terminal even when a previously queued Octo event arrives later', async t => {
  for (const expired of [false, true]) await t.test(String(expired), async t => {
    const f = await fixture(t), event = f.submit()
    if (expired) f.store.expireDeferredCards(Date.now() + 2 * 86400000)
    else {
      const result = await manageDeferredForm({ store: f.store, job: { sender: 'alice', ...f.route },
        args: { action: 'cancel', message_id: f.published.message_id }, authorize: async () => {} })
      assert.equal(result.state, 'cancelled')
    }
    await f.restart()
    await f.ingest([event])
    assert.deepEqual(f.acks, ['900'])
    assert.equal(f.store.next(Date.now()), undefined)
    assert.equal(f.runs.length, 1)
  })
})

test('lost callback ACK remains durable across restart and cannot run the continuation twice', async t => {
  const f = await fixture(t)
  f.ackFails = true
  await assert.rejects(f.ingest([f.submit()]), /ACK failure/)
  assert.deepEqual(f.store.pendingCardAcks(), ['900'])
  await f.restart(); f.ackFails = false
  await f.worker.flushCardAcks(t.signal)
  await f.ingest([f.submit()])
  await f.process()
  assert.equal(f.runs.length, 2)
  assert.equal(f.store.next(Date.now()), undefined)
})

test('cancel wins an in-flight authorization check and the raced event is still durably ACKed', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers()
  f.api.allowsMessage = async () => { entered.resolve(); return gate.promise }
  const pending = f.ingest([f.submit()])
  await entered.promise
  f.store.closeDeferredCard(f.published.message_id, 'cancelled', '已取消')
  gate.resolve(true)
  await pending
  assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'cancelled')
  assert.deepEqual(f.acks, ['900'])
  assert.equal(f.store.next(Date.now()), undefined)
})

test('transient access failure leaves the form and event recoverable without starting DSH', async t => {
  const f = await fixture(t)
  const prior = f.api.allowsMessage
  f.api.allowsMessage = async () => { throw new Error('temporary host lookup failed') }
  await assert.rejects(f.ingest([f.submit()]), /temporary host/)
  assert.equal(f.store.deferredCard(f.published.message_id).deferred.state, 'pending')
  assert.deepEqual(f.acks, [])
  f.api.allowsMessage = prior
  await f.ingest([f.submit()])
  await f.process()
  assert.equal(f.runs.length, 2)
})

test('unavailable terminal cards cannot starve other form receipts or retry in a tight loop', async t => {
  const f = await fixture(t), original = f.store.deferredCard(f.published.message_id)
  for (const id of ['801', '802', '803', '804']) {
    f.store.bindCard({ ...original, messageId: id })
    f.store.closeDeferredCard(id, 'cancelled', 'cancelled')
  }
  const attempted = []
  const flush = () => flushDeferredFeedback({ api: f.api, store: f.store, signal: t.signal, log() {},
    authorize: async binding => { attempted.push(binding.messageId); if (binding.messageId !== '804') throw new Error('unavailable') } })
  await flush()
  assert.deepEqual(attempted, ['801', '802', '803'])
  await flush()
  assert.deepEqual(attempted, ['801', '802', '803', '804'])
  assert.equal(f.store.deferredCard('804').deferred.feedback, true)
})
