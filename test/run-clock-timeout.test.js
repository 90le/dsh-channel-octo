import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RunClock } from '../src/run-clock.js'

const nodeMaxDelay = 2 ** 31 - 1

function fakeTimers(t) {
  let now = 0
  const pending = new Map()
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.ok(delay > 0 && delay <= nodeMaxDelay)
    const timer = { unref() {} }
    pending.set(timer, { callback, delay })
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => pending.delete(timer))
  return {
    advance: ms => { now += ms },
    delays: () => [...pending.values()].map(entry => entry.delay),
    wake() {
      assert.equal(pending.size, 1)
      const [timer, { callback }] = pending.entries().next().value
      pending.delete(timer)
      callback()
    },
  }
}

test('multi-chunk deadlines charge actual monotonic time even when a callback is late', t => {
  const time = fakeTimers(t)
  const clock = new RunClock(2 * nodeMaxDelay + 300)
  assert.deepEqual(time.delays(), [nodeMaxDelay])
  time.advance(nodeMaxDelay + 40)
  time.wake()
  assert.equal(clock.signal.aborted, false)
  assert.deepEqual(time.delays(), [nodeMaxDelay])
  time.advance(nodeMaxDelay)
  time.wake()
  assert.equal(clock.signal.aborted, false)
  assert.deepEqual(time.delays(), [260])
  time.advance(259)
  time.wake()
  assert.deepEqual(time.delays(), [1])
  assert.equal(clock.signal.aborted, false)
  time.advance(1)
  time.wake()
  assert.equal(clock.signal.reason.name, 'TimeoutError')
  assert.deepEqual(time.delays(), [])
})

test('nested waits suspend a long budget; close clears the resumed timer permanently', t => {
  const time = fakeTimers(t)
  const clock = new RunClock(nodeMaxDelay + 50)
  time.advance(nodeMaxDelay)
  time.wake()
  time.advance(20)
  clock.pause()
  clock.pause()
  time.advance(nodeMaxDelay)
  assert.deepEqual(time.delays(), [])
  clock.resume()
  assert.deepEqual(time.delays(), [])
  clock.resume()
  assert.deepEqual(time.delays(), [30])
  clock.close()
  clock.pause()
  clock.resume()
  assert.deepEqual(time.delays(), [])
  assert.equal(clock.signal.aborted, false)
})

test('a wait starting after the deadline cannot defer an overdue timeout', t => {
  const time = fakeTimers(t)
  const clock = new RunClock(1000)
  time.advance(1001)
  clock.pause()
  assert.equal(clock.signal.reason.name, 'TimeoutError')
  clock.resume()
  assert.deepEqual(time.delays(), [])
})

test('unlimited allocates no timer before or after waits, and lifetime can still cancel', t => {
  const time = fakeTimers(t)
  const clock = new RunClock('unlimited')
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, clock.signal])
  clock.pause()
  time.advance(3 * nodeMaxDelay)
  clock.resume()
  assert.equal(signal.aborted, false)
  assert.deepEqual(time.delays(), [])
  lifetime.abort(new Error('service stopped'))
  assert.equal(signal.reason, lifetime.signal.reason)
  assert.equal(clock.signal.aborted, false)
  clock.close()
  assert.equal(globalThis.setTimeout.mock.callCount(), 0)
})
