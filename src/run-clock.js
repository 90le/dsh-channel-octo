// Human interaction has its own bounded wait; only model/tool execution spends
// this budget. Lifetime cancellation still applies while the budget is paused.
export class RunClock {
  constructor(ms) {
    this.remaining = ms
    this.holds = 0
    this.controller = new AbortController()
    this.schedule()
  }
  get signal() { return this.controller.signal }
  schedule() {
    if (this.closed || this.holds || this.signal.aborted) return
    this.started = performance.now()
    this.timer = setTimeout(() => this.controller.abort(new DOMException('Execution timed out', 'TimeoutError')), Math.max(0, this.remaining))
    this.timer.unref?.()
  }
  pause() {
    if (this.holds++ === 0) {
      clearTimeout(this.timer)
      this.remaining -= performance.now() - this.started
    }
  }
  resume() { if (this.holds && --this.holds === 0) this.schedule() }
  close() { this.closed = true; clearTimeout(this.timer) }
}
