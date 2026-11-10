import { DEFAULT_REPLY_TIMEOUT_MS, UNLIMITED_REPLY_TIMEOUT } from './reply-timeout.js'

// Larger delays overflow Node's timer and fire after 1 ms.
const maxTimerDelayMs = 2 ** 31 - 1

// Human interaction has its own bounded wait; only execution spends this
// budget. Lifetime cancellation still applies while paused or unlimited.
export class RunClock {
  #remaining
  #started
  #timer
  #holds = 0
  #closed = false
  #controller = new AbortController()

  constructor(ms) {
    this.#remaining = ms ?? DEFAULT_REPLY_TIMEOUT_MS
    if (this.#remaining === UNLIMITED_REPLY_TIMEOUT) return
    if (!Number.isSafeInteger(this.#remaining) || this.#remaining < 0) throw new Error('invalid_timeouts')
    this.#start()
  }

  get signal() { return this.#controller.signal }

  #start() {
    this.#started = performance.now()
    this.#arm()
  }

  #left() { return this.#remaining - (performance.now() - this.#started) }

  #expire() { this.#controller.abort(new DOMException('Execution timed out', 'TimeoutError')) }

  #arm() {
    const left = this.#left()
    if (left <= 0) return this.#expire()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      // Recheck elapsed time at each wakeup, including after a delayed callback.
      this.#arm()
    }, Math.min(maxTimerDelayMs, Math.ceil(left)))
    this.#timer.unref?.()
  }

  #clearTimer() {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  pause() {
    if (this.#remaining === UNLIMITED_REPLY_TIMEOUT || this.#closed || this.signal.aborted) return
    if (this.#holds++ !== 0) return
    this.#remaining = this.#left()
    this.#clearTimer()
    if (this.#remaining <= 0) this.#expire()
  }

  resume() {
    if (this.#closed || this.signal.aborted) return
    if (this.#holds && --this.#holds === 0) this.#start()
  }

  close() { this.#closed = true; this.#clearTimer() }
}
