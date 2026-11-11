import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RunInbox } from '../src/run-inbox.js'

function fixture() {
  const events = new EventEmitter(), live = new Map(), log = [], claims = []
  const ctx = { agents: { list: () => [...live.values()], get: id => live.get(id) },
    on(name, fn) { events.on(name, fn); return () => events.off(name, fn) } }
  const make = (id, parent) => {
    const state = { 'next-turn': [], 'next-step': [] }
    const agent = { id, session: { header: { parentSession: parent } }, wakes: 0,
      dispatch: { emit: (name, payload) => { claims.push(payload.message.id); events.emit(name, { agent, ...payload }) } },
      kick() {}, wakeDriver() { this.wakes++ }, send(message, target = 'next-turn', wakeup = true) {
        this.inbox.mutate(target, Infinity, 0, [message], true)
        if (wakeup) this.wakeDriver()
      }, inbox: {
        get nextTurn() { return state['next-turn'] }, get nextStep() { return state['next-step'] },
        get hasPending() { return this.nextTurn.length + this.nextStep.length > 0 },
        locate(id) { for (const target of Object.keys(state)) { const index = state[target].findIndex(m => m.id === id); if (index >= 0) return { target, index } } },
        mutate(target, start, count, inserted, discarded) {
          const removed = state[target].splice(start, count, ...inserted)
          log.push({ target, removed: removed.map(m => m.id), inserted: inserted.map(m => m.id), discarded })
          for (const message of inserted) events.emit('agent/inbox/inserted', { agent, message })
          return removed
        },
      } }
    live.set(id, agent); events.emit('agent/created', { agent }); return agent
  }
  const root = make('root'), unrelated = make('other')
  const gate = new RunInbox(ctx, root, (_agent, m) => m.id.startsWith('octo'))
  events.on('agent/inbox/inserted', p => gate.admit(p.agent, p.message))
  return { root, unrelated, gate, make, log, claims, events }
}

test('Web input remains durably pending while only Octo messages are claimed', () => {
  const f = fixture(), before = f.root.inbox
  f.root.send({ id: 'web-1' }, 'next-step')
  f.root.send({ id: 'web-2' })
  assert.equal(f.root.wakes, 0)
  f.root.send({ id: 'octo-1' })
  assert.deepEqual(f.root.inbox.claim('next-turn', 1).map(m => m.id), ['octo-1'])
  assert.deepEqual(f.claims, ['octo-1'])
  assert.equal(f.root.inbox.hasPending, true, 'Web must see its durable queue')
  assert.equal(f.gate.execution.run(f.root, () => f.root.inbox.hasPending), false)
  assert.equal(f.gate.deferred, true)
  assert.ok(f.log.every(e => !e.removed.some(id => id.startsWith('web'))))
  f.gate.release()
  assert.notEqual(f.root.inbox, before)
  assert.deepEqual(f.root.inbox.nextStep.map(m => m.id), ['web-1'])
  assert.deepEqual(f.root.inbox.nextTurn.map(m => m.id), ['web-2'])
  assert.equal(f.root.wakes, 2)
  f.gate.release(); assert.equal(f.root.wakes, 2)
})

test('other sessions run concurrently; direct child foreign input fails before acknowledgement', () => {
  const f = fixture(), child = f.make('child', 'root')
  f.unrelated.send({ id: 'web-parallel' }); assert.equal(f.unrelated.wakes, 1)
  assert.throws(() => child.send({ id: 'web-child' }), /主对话/)
  assert.ok(!f.log.some(e => e.inserted.includes('web-child')))
  child.send({ id: 'octo-child' }); assert.equal(child.wakes, 1)
  child.inbox.claim('next-turn', 1)
  f.gate.release()
  child.send({ id: 'web-child' }); assert.equal(child.wakes, 2)
  assert.equal(f.events.listenerCount('agent/created'), 0)
})

test('later execution context cannot adopt an earlier foreign message or an edited version', () => {
  const f = fixture()
  f.root.send({ id: 'web-1', text: 'foreign' })
  // A queue read during an unrelated active execution must not re-run admission.
  f.gate.accepts = () => true
  assert.deepEqual(f.gate.execution.run(f.root, () => f.root.inbox.nextTurn), [])
  f.root.send({ id: 'octo-1', text: 'original' })
  const location = f.root.inbox.locate('octo-1')
  f.root.inbox.mutate(location.target, location.index, 1, [{ id: 'octo-1', text: 'Web edit' }], true)
  assert.deepEqual(f.gate.execution.run(f.root, () => f.root.inbox.nextTurn), [])
  f.gate.release()
  assert.equal(f.root.inbox.nextTurn.length, 2)
  assert.equal(f.root.inbox.nextTurn[1].text, 'Web edit')
})
