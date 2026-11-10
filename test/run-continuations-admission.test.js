import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RunContinuations } from '../src/run-continuations.js'

function fixture() {
  const events = new EventEmitter(), scoped = new EventEmitter(), live = new Map()
  const agent = { id: 'root', ctx: { on(name, fn) { scoped.on(name, fn); return () => scoped.off(name, fn) } } }
  live.set(agent.id, agent)
  const ctx = { agents: { get: id => live.get(id) }, on(name, fn) {
    events.on(name, fn); return () => events.off(name, fn)
  } }
  let active = true
  const observer = new RunContinuations(ctx, agent, () => active, false, new Set(['our-call']))
  const child = (id, parentSession = agent.id) => {
    const receiver = { id, session: { header: { parentSession } } }
    live.set(id, receiver); return receiver
  }
  const exec = (changes = {}) => ({ agent, name: 'send_message', callId: 'our-call', rootCallId: 'our-call', token: Symbol('execution'), ...changes })
  const insert = (receiver, id = 'message', sender = agent.id) => observer.inserted({ agent: receiver,
    message: { id, source: { kind: 'agent-message', senderSessionId: sender } } })
  const dispatch = (execution, body) => events.listeners('tools/execute')[0](execution, body)
  return { observer, agent, child, exec, insert, dispatch, events, scoped, deactivate() { active = false } }
}

test('admission records the exact message and execution before tool result, across awaits', async () => {
  const f = fixture(), receiver = f.child('resident'), execution = f.exec()
  const result = await f.dispatch(execution, async () => {
    await Promise.resolve()
    f.insert(receiver, 'admitted-id')
    assert.deepEqual(f.observer.admissions.get('admitted-id'), {
      sender: 'root', receiver: 'resident', callId: 'our-call', rootCallId: 'our-call', token: execution.token,
    })
    assert.equal(f.observer.accepts({ source: { kind: 'agent-message', senderSessionId: receiver.id } }), true)
    return { sent: true }
  })
  assert.deepEqual(result, { sent: true })
  assert.deepEqual([...f.observer.directChildren], ['resident'])
  f.observer.dispose(); assert.equal(f.events.eventNames().length, 0)
})

test('historical and concurrent Web insertions cannot inherit a pending tool execution', async () => {
  const f = fixture(), ours = f.child('ours'), foreign = f.child('web')
  f.insert(foreign, 'old-id')
  const gate = Promise.withResolvers()
  const running = f.dispatch(f.exec(), async () => { await gate.promise; f.insert(ours, 'our-id') })
  f.insert(foreign, 'new-web-id')
  gate.resolve(); await running
  assert.deepEqual([...f.observer.children], ['ours'])
  assert.deepEqual([...f.observer.admissions.keys()], ['our-id'])
  f.observer.dispose()
})

test('unrelated nested tools mask the outer sender and detached work expires with the body', async () => {
  const f = fixture(), receiver = f.child('resident'), gate = Promise.withResolvers()
  let late
  await f.dispatch(f.exec(), async () => {
    await f.dispatch(f.exec({ name: 'list_agents' }), async () => f.insert(receiver, 'nested'))
    late = gate.promise.then(() => f.insert(receiver, 'detached'))
  })
  gate.resolve(); await late
  assert.equal(f.observer.children.size, 0)
  f.observer.dispose()
})

test('rejects foreign calls, stale agents, wrong senders and unrelated roots', async () => {
  const f = fixture(), receiver = f.child('resident'), otherRoot = f.child('elsewhere', 'other-root')
  for (const execution of [f.exec({ callId: 'web', rootCallId: 'web' }), f.exec({ agent: { id: 'root' } })])
    await f.dispatch(execution, async () => f.insert(receiver))
  await f.dispatch(f.exec(), async () => {
    f.insert({ ...receiver }, 'stale')
    f.insert(receiver, 'forged-sender', 'other-root')
    f.insert(otherRoot, 'wrong-tree')
  })
  assert.equal(f.observer.children.size, 0)
  f.deactivate()
  await f.dispatch(f.exec(), async () => f.insert(receiver, 'inactive'))
  assert.equal(f.observer.admissions.size, 0)
  f.observer.dispose()
})

test('nested call ids correlate through rootCallId and teammate sends preserve direct-parent cleanup', async () => {
  const f = fixture(), child = f.child('first'), peer = f.child('peer')
  await f.dispatch(f.exec({ callId: 'nested-call' }), async () => f.insert(child, 'nested-message'))
  await f.dispatch(f.exec({ agent: child, callId: 'child-call', rootCallId: 'child-call' }), async () => f.insert(peer, 'peer-message', child.id))
  assert.deepEqual([...f.observer.directChildren], ['first', 'peer'])
  assert.equal(f.observer.admissions.get('peer-message').sender, child.id)
  f.observer.dispose()
})

test('throwing executions propagate errors and expire detached admission contexts', async () => {
  const f = fixture(), receiver = f.child('resident'), gate = Promise.withResolvers()
  let late
  const error = new Error('native tool failed')
  await assert.rejects(f.dispatch(f.exec(), async () => {
    late = gate.promise.then(() => f.insert(receiver))
    throw error
  }), value => value === error)
  gate.resolve(); await late
  assert.equal(f.observer.children.size, 0)
  f.observer.dispose()
})

test('native start and catalog require a live owned execution, including awaited provider startup', async () => {
  const f = fixture(), gate = Promise.withResolvers()
  const start = id => f.scoped.emit('subagent/start', { id, runId: 'run-' + id })
  const catalog = (id, parent = 'root') => f.observer.observe({ id: parent }, { type: 'subagent/catalog', data: { childId: id } })
  const running = f.dispatch(f.exec({ name: 'spawn_teammate' }), async () => {
    await gate.promise
    start('ours'); catalog('ours')
  })
  start('web'); catalog('web')
  gate.resolve(); await running
  start('late'); catalog('late')
  assert.deepEqual([...f.observer.children], ['ours'])
  const child = f.child('ours')
  await f.dispatch(f.exec({ agent: child, name: 'subagent', callId: 'child-spawn' }), async () => catalog('grandchild', child.id))
  assert.deepEqual([...f.observer.children], ['ours', 'grandchild'])
  assert.deepEqual([...f.observer.directChildren], ['ours'])
  f.observer.dispose()
})

test('an unrelated nested execution cannot publish a child using the outer call ownership', async () => {
  const f = fixture()
  await f.dispatch(f.exec({ name: 'spawn_teammate' }), async () => {
    await f.dispatch(f.exec({ callId: 'web', rootCallId: 'web' }), async () => {
      f.scoped.emit('subagent/start', { id: 'web-child' })
      f.observer.observe({ id: 'root' }, { type: 'subagent/catalog', data: { childId: 'web-child' } })
    })
  })
  assert.equal(f.observer.children.size, 0)
  f.observer.dispose()
})
