import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RunContinuations } from '../src/run-continuations.js'

function fixture(owned = false, previous = []) {
  const events = new EventEmitter(), children = new EventEmitter(), executions = new EventEmitter(), killed = []
  const agent = { id: 'parent', ctx: { on(name, fn) { children.on(name, fn); return () => children.off(name, fn) } } }
  const jobs = { list: () => previous, events: { subscribe(filter, fn) {
    assert.equal(filter.owner, agent.id); events.on('job', fn); return () => events.off('job', fn)
  } }, wait() { assert.fail('must not consume job completion') }, read() { assert.fail('must not consume job result') }, kill(id) { killed.push(id) } }
  const live = new Map([[agent.id, agent]])
  const ctx = { get: () => jobs, agents: { get: id => live.get(id) }, on(name, fn) {
    executions.on(name, fn); return () => executions.off(name, fn)
  } }
  const observer = new RunContinuations(ctx, agent, () => true, owned, new Set(['our-call']))
  const run = (name, body, sender = agent) => executions.listeners('tools/execute')[0](
    { agent: sender, name, callId: 'our-call', rootCallId: 'our-call', token: Symbol(name) }, body)
  const child = id => {
    const receiver = { id, session: { header: { parentSession: agent.id } } }
    live.set(id, receiver); return receiver
  }
  return { observer, events, children, agent, killed, run, child }
}

test('borrowed jobs require an owned tool call; unrelated work is neither joined nor stopped', async () => {
  const f = fixture()
  const event = (id, call) => ({ type: 'job/registered', data: { owner: f.agent.id, jobId: id, toolCall: { callId: call } } })
  f.observer.observe(f.agent, event('ours', 'our-call'))
  f.events.emit('job', { type: 'registered', job: { id: 'ours', owner: f.agent.id } })
  f.observer.observe(f.agent, event('foreign', 'their-call'))
  f.events.emit('job', { type: 'registered', job: { id: 'foreign', owner: f.agent.id } })
  assert.equal(f.observer.accepts({ source: { kind: 'tool-jobs' } }), false)
  f.observer.stop(); assert.deepEqual(f.killed, ['ours'])
  let done = false
  const joined = f.observer.waitForJobs(new AbortController().signal).then(value => { done = true; return value })
  f.events.emit('job', { type: 'settled', job: { id: 'foreign', owner: f.agent.id } })
  await Promise.resolve(); assert.equal(done, false)
  f.events.emit('job', { type: 'settled', job: { id: 'ours', owner: f.agent.id } })
  assert.equal(await joined, true)
  f.observer.dispose(); assert.equal(f.events.listenerCount('job'), 0)
})

test('scoped child start and descendant catalog recognize only the request family', async () => {
  const f = fixture(true)
  await f.run('subagent', () => f.children.emit('subagent/start', { id: 'child' }))
  f.observer.observe({ id: 'unrelated' }, { type: 'subagent/catalog', data: { childId: 'foreign' } })
  await f.run('subagent', () => f.observer.observe({ id: 'child' }, { type: 'subagent/catalog', data: { childId: 'grandchild' } }), f.child('child'))
  for (const sender of ['child', 'grandchild']) assert.equal(f.observer.accepts({ source: { kind: 'subagent-settled', senderSessionId: sender } }), true)
  assert.equal(f.observer.accepts({ source: { kind: 'agent-message', senderSessionId: 'foreign' } }), false)
  assert.deepEqual([...f.observer.directChildren], ['child'])
  f.observer.dispose(); assert.equal(f.children.eventNames().length, 0)
})

test('passive job joins abort without retaining waiters', async () => {
  const f = fixture(true), controller = new AbortController()
  await f.run('bash', () => f.events.emit('job', { type: 'registered', job: { id: 'ours', owner: f.agent.id } }))
  const joined = f.observer.waitForJobs(controller.signal)
  controller.abort(new Error('stopped'))
  await assert.rejects(joined, /stopped/)
  assert.equal(f.observer.waiters.size, 0)
  f.observer.dispose()
})

test('an existing teammate joins only when new input is admitted from this request family', async () => {
  const f = fixture()
  const reply = { source: { kind: 'agent-message', senderSessionId: 'resident' } }
  assert.equal(f.observer.accepts(reply), false)
  f.observer.inserted({ agent: { id: 'foreign' }, message: { source: { kind: 'agent-message', senderSessionId: 'another-root' } } })
  const inserted = { agent: f.child('resident'), message: { id: 'new-message', source: { kind: 'agent-message', senderSessionId: f.agent.id } } }
  f.observer.inserted(inserted)
  assert.equal(f.observer.accepts(reply), false)
  await f.run('send_message', () => f.observer.inserted(inserted))
  assert.equal(f.observer.accepts(reply), true)
  assert.equal(f.observer.children.has('foreign'), false)
  assert.deepEqual([...f.observer.directChildren], ['resident'])
  f.observer.dispose()
})

test('quiet parked completions are detected without bypassing the host wake budget', async () => {
  const f = fixture(true)
  await f.run('subagent', () => f.children.emit('subagent/start', { id: 'child' }))
  f.agent.status = 'idle'
  f.agent.inbox = { nextStep: [{ id: 'parked', source: { kind: 'subagent-settled', senderSessionId: 'child' } }],
    remove() { assert.fail('must not mutate native quiet delivery') } }
  f.agent.followup = () => assert.fail('must not override native wake budget')
  assert.equal(f.observer.hasParkedReply(), true)
  f.observer.dispose()
})

test('owned root does not adopt external jobs without execution or call-id proof', async () => {
  const f = fixture(true)
  f.observer.observe(f.agent, { type: 'job/registered', data: { jobId: 'web', owner: f.agent.id } })
  f.events.emit('job', { type: 'registered', job: { id: 'web', owner: f.agent.id } })
  assert.equal(f.observer.pendingJobs, false)
  assert.equal(await f.observer.waitForJobs(new AbortController().signal), false)
  f.observer.stop(); assert.deepEqual(f.killed, [])
  await f.run('bash', () => {
    f.observer.observe(f.agent, { type: 'job/registered', data: { jobId: 'ours', owner: f.agent.id } })
    f.events.emit('job', { type: 'registered', job: { id: 'ours', owner: f.agent.id } })
  })
  assert.deepEqual([...f.observer.jobs.keys()], ['ours'])
  assert.equal(f.observer.accepts({ source: { kind: 'tool-jobs' } }), false)
  f.observer.stop(); assert.deepEqual(f.killed, ['ours'])
  f.observer.dispose()
})
