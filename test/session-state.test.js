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
