import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Accounts } from '../src/accounts.js'
import { Worker } from '../src/worker.js'
import { sessionExists } from '../src/session-state.js'

const signal = new AbortController().signal
function storeFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'octo-deleted-session-'))
  const store = new Store(root, 'fixture')
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return store
}
test('deleted native sessions disappear from current and historical mappings; failures and live writers remain', async t => {
  const store = storeFor(t)
  const old = store.session('alice'); store.sessionCreated('alice')
  const live = store.session('alice', 0, Date.now(), true); store.sessionCreated('alice')
  const lost = store.session('bob'); store.sessionCreated('bob')
  store.add('1', { messageId: '1', sender: 'bob', text: 'old' })
  store.running(1, lost.session_id); store.sent(1, '100')
  const ctx = { agents: { get: id => id === live.session_id ? {} : undefined },
    get: () => ({ stat: async () => undefined }), logger: () => ({ info() {} }) }
  const accounts = new Accounts(ctx, {})
  const runtime = { record: { id: 'fixture' }, store }
  accounts.runtimes.set('fixture', runtime)
  await accounts.reconcileSessions()
  assert.deepEqual(store.knownSessions(), [live.session_id])
  assert.equal(store.overview().conversations.length, 1)
  assert.equal(store.db.prepare('SELECT result_id FROM jobs').get().result_id, '100')
  assert.equal(store.add('1', { messageId: '1', sender: 'bob', text: 'replay' }).changes, 0)
  assert.notEqual(store.session('bob').session_id, lost.session_id)
  assert.notEqual(store.session('alice').session_id, old.session_id)
  ctx.agents.get = () => undefined
  ctx.get = () => ({ stat: async () => { throw new Error('storage unavailable') } })
  await accounts.reconcileSessions()
  assert.ok(store.knownSessions().includes(live.session_id))
  await assert.rejects(sessionExists(ctx, live.session_id, signal), /storage unavailable/)
})

for (const race of [false, true]) test('new input creates a fresh native session after deletion' + (race ? ' during resume' : ''), async t => {
  const store = storeFor(t)
  const old = store.session('alice'); store.sessionCreated('alice')
  let calls = 0, prompts = 0, attached
  const config = { botUid: 'bot', spaceId: 'space', allowed: new Set(['alice']) }
  const host = {
    async exists() { return race },
    async run(session, text, created) {
      calls++
      if (session.session_id === old.session_id) {
        assert.ok(race)
        throw new Error('session_missing')
      }
      assert.equal(session.created, 0)
      assert.equal(text, 'new message')
      prompts++
      await created()
      return 'new answer'
    },
  }
  store.add('2', { messageId: '2', sender: 'alice', text: 'new message' })
  const worker = new Worker({ store, config, host, log() {},
    attach: id => { attached = id },
    api: { send: async (_to, text) => { assert.equal(text, 'new answer'); return '102' } } })
  await worker.process(store.next(Date.now()), signal)
  const row = store.db.prepare('SELECT state,session_id FROM jobs').get()
  assert.equal(row.state, 'sent')
  assert.equal(row.session_id, attached)
  assert.notEqual(row.session_id, old.session_id)
  assert.equal(prompts, 1)
  assert.equal(calls, race ? 2 : 1)
  assert.deepEqual(store.overview().conversations.map(row => row.id), [attached])
})

test('native disposal preserves durable records; permanent deletion invalidates live work and an old ready reply', async t => {
  const store = storeFor(t)
  const old = store.session('alice'); store.sessionCreated('alice', old.session_id)
  const other = store.session('bob'); store.sessionCreated('bob', other.session_id)
  store.add('7', { messageId: '7', sender: 'alice', text: 'first' })
  store.add('8', { messageId: '8', sender: 'alice', text: 'second' })
  store.running(1, old.session_id)
  store.running(2, old.session_id); store.ready(2, 'pending text', {})
  const worker = new Worker({ api: {}, store, config: {}, log() {} })
  const controller = new AbortController(), bystander = new AbortController()
  worker.activeByRoute.set('alice', { job: { seq: 1 }, sessionId: old.session_id, controller, merged: [] })
  worker.activeByRoute.set('bob', { job: { seq: 3 }, sessionId: other.session_id, controller: bystander, merged: [] })
  let durable = true
  const ctx = { agents: { get: () => ({ stale: true }) }, sessions: { get: () => undefined },
    get: () => ({ stat: async () => durable ? { id: old.session_id } : undefined }), logger: () => ({ info() {} }) }
  const accounts = new Accounts(ctx, {})
  accounts.runtimes.set('fixture', { record: { id: 'fixture' }, store, worker })
  await accounts.nativeSessionRemoved(old.session_id)
  assert.equal(store.hasSession(old.session_id), true)
  assert.equal(controller.signal.aborted, false)
  durable = false
  await accounts.nativeSessionRemoved(old.session_id)
  assert.equal(controller.signal.aborted, true)
  assert.equal(bystander.signal.aborted, false)
  assert.equal(store.hasSession(old.session_id), false)
  assert.equal(store.hasSession(other.session_id), true)
  assert.equal(store.add('7', { messageId: '7', sender: 'alice', text: 'retry' }).changes, 0)
  assert.deepEqual(store.db.prepare('SELECT state,issue,reply FROM jobs ORDER BY seq').all().map(row => [...Object.values(row)]),
    [['review', 'session_missing', null], ['review', 'session_missing', null]])
  const replacement = store.session('alice')
  assert.equal(store.sessionCreated('alice', old.session_id), false)
  assert.equal(store.hasSession(replacement.session_id), false)
})

test('channel ownership includes archived-age history beyond the recent status limit', t => {
  const store = storeFor(t)
  const parent = 'd'.repeat(32), address = parent + '____123456789012345'
  const topic = store.session(JSON.stringify([5, address]), 0, 1); store.sessionCreated(JSON.stringify([5, address]))
  store.rememberNavigationNames([[2, parent, 'Fixture group'], [5, address, 'Fixture topic']])
  for (let i = 0; i < 251; i++) {
    store.session('dm' + i, 0, i + 2); store.sessionCreated('dm' + i)
  }
  const accounts = new Accounts({ logger: () => ({ info() {} }) }, {})
  const record = { id: 'fixture', label: 'Fixture' }
  accounts.records.set(record.id, record)
  accounts.runtimes.set(record.id, { record, store, settings: { config: { allowed: new Set(), groups: new Set(), threads: new Set() }, revision: () => 'r' } })
  const snapshot = accounts.overview()
  assert.equal(snapshot.conversations.some(row => row.id === topic.session_id), false)
  const row = snapshot.sessionRoutes.find(row => row.id === topic.session_id)
  assert.equal(row.group, parent)
  assert.equal(row.groupName, 'Fixture group')
  assert.equal(row.name, 'Fixture topic')
  assert.equal(row.accountId, 'fixture')
})
