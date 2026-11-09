import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunClock } from '../src/run-clock.js'
import { Store } from '../src/store.js'
import { QuestionBridge } from '../src/questions.js'

test('answer time pauses the remaining execution budget; lifetime cancellation remains effective', t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tick = ms => { now += ms; t.mock.timers.tick(ms) }
  const clock = new RunClock(100)
  tick(30)
  clock.pause()
  tick(10_000)
  assert.equal(clock.signal.aborted, false)
  clock.resume()
  tick(69)
  assert.equal(clock.signal.aborted, false)
  tick(1)
  assert.equal(clock.signal.reason.name, 'TimeoutError')
  clock.close()
  const live = new AbortController(), another = new RunClock(100)
  another.pause()
  const combined = AbortSignal.any([another.signal, live.signal])
  live.abort()
  assert.equal(combined.aborted, true)
  another.close()
})

for (const interrupted of [false, true]) test('question card shows ' + (interrupted ? 'restart closure once without replaying the task' : 'accepted answer and removes submission controls'), async t => {
  const root = mkdtempSync(join(tmpdir(), 'octo-question-feedback-'))
  const store = new Store(root, 'fixture')
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const controller = new AbortController(), edits = []
  const config = { apiBase: 'https://fixture.invalid/api', botUid: 'fixture-bot', spaceId: 'fixture-space', token: 'bf_fixture',
    fetchImpl: async url => new URL(url).pathname.endsWith('/card/profile') ? Response.json({
      enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'], inputs: ['Input.ChoiceSet'],
      config: { card_enabled: true, display_enabled: true, interaction_enabled: true },
    }) : Response.json({ message_id: '700' }) }
  const api = { async editProgress(route, id, frame) { edits.push({ route, id, frame }) },
    async send() { assert.fail('Confirmed edits need no extra messages') } }
  const make = () => new QuestionBridge({ api, store, log() {} })
  const bridge = make()
  const ask = bridge.ask([{ id: 'q', question: 'Choose', options: [{ label: 'First' }, { label: 'Second' }] }],
    { sender: 'alice', channel_id: 'alice', channel_type: 1, session_id: 'session-fixture' }, config, controller.signal, () => {})
  void ask.catch(() => {})
  while (!bridge.current?.ready) await new Promise(resolve => setImmediate(resolve))
  if (interrupted) {
    controller.abort(new Error('service stopped'))
    await assert.rejects(ask, /service stopped/)
    assert.equal(edits.length, 0)
    await make().closeInterrupted(new AbortController().signal)
    assert.match(edits[0].frame.plain, /已结束/)
  } else {
    assert.equal(bridge.text(bridge.current, '2'), true)
    assert.deepEqual(await ask, { answers: [{ id: 'q', selected: ['Second'] }] })
    assert.match(edits[0].frame.plain, /已选择：Second/)
  }
  assert.equal(edits.length, 1)
  assert.equal(edits[0].id, '700')
  assert.equal(edits[0].route.channel_id, 'alice')
  assert.equal(edits[0].frame.card.actions, undefined)
  assert.equal(store.cardBinding('700'), null)
  await make().closeInterrupted(new AbortController().signal)
  assert.equal(edits.length, 1)
})
