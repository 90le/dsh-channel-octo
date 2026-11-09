import { randomUUID } from 'node:crypto'
import { decimalId, OctoError } from './octo.js'

const labels = {
  queued: '已收到，等待 DSH 开始处理',
  running: 'DSH 正在处理',
  responding: '正在生成回复',
  completed: '回复已发送',
  stopped: '回复发送待确认',
  error: '本次回复未完成，请稍后重发',
}

const stages = ['queued', 'running', 'responding']
const outcomes = ['completed', 'stopped', 'error']
const wireStates = { queued: 'reasoning', running: 'reasoning', responding: 'answering' }
const templateStates = ['reasoning', 'answering', ...outcomes]
const initialDelay = 450
const editInterval = 800
const refreshInterval = 5500
const typingInterval = 4000
const terminalWaitBudget = 6000

export function cardMode(profile) {
  const config = profile?.config
  if (![true, 1].includes(profile?.enabled) || config?.card_enabled !== true) return undefined
  const ref = config.reasoning_template_ref
  const templates = profile.templating?.templates
  if (config.reasoning_enabled === true && ref?.id === 'ai.reasoning-process'
    && typeof ref.version === 'string' && /^(0\.[1-3]\.0|0\.4\.[01])$/.test(ref.version)
    && profile.templating?.supported === true && Array.isArray(templates)
    && templates.some(item => item?.id === ref.id && item.version === ref.version && Array.isArray(item.views)
      && templateStates.every(state => item.views.some(view => Array.isArray(view?.states) && view.states.includes(state))))) {
    return { id: ref.id, version: ref.version }
  }
  if (config.display_enabled === true && profile.card_version === '1.5'
    && Array.isArray(profile.profiles) && profile.profiles.includes('octo/v1')) return 'display'
}

function frame(mode, reasoningId, phase, seconds) {
  const label = labels[phase]
  const state = wireStates[phase] ?? phase
  const elapsed = '已用时 ' + seconds + ' 秒'
  if (mode === 'display') return {
    profile: 'octo/v1', card_version: '1.5', plain: label,
    card: { type: 'AdaptiveCard', version: '1.5', body: [
      { type: 'TextBlock', text: 'DSH 回复进度', weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: label + ' · ' + elapsed, wrap: true },
    ] },
  }
  const tone = state === 'error' ? 'Attention' : state === 'completed' ? 'Good' : state === 'stopped' ? 'Warning' : 'Accent'
  return { template_ref: mode, state, data: {
    reasoningId, state, title: 'DSH 回复进度', statusLabel: label, statusTone: tone,
    timerText: elapsed, traceExpanded: false, traceCollapsed: true, collapsedSummary: label,
    progressText: label + ' · ' + elapsed,
    phases: [{ thought: label, actions: [{ tool: 'DSH', detail: elapsed, statusGlyph: '●',
      statusTone: tone === 'Warning' ? 'Accent' : tone }] }],
    ...(state === 'error' && { errorTitle: '回复未完成', errorMessage: label }),
  } }
}

function waitFor(ms, signal) {
  if (ms <= 0 || signal.aborted) return
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

const mayRetry = status => !status || status === 429 || status >= 500

export class Progress {
  #retryAt = 0
  constructor(api, log) { Object.assign(this, { api, log }) }

  async #request(fn, signal) {
    if (signal.aborted) return { ok: false }
    if (Date.now() < this.#retryAt) return { ok: false, status: 429 }
    try { return { ok: true, value: await fn() } } catch (error) {
      const status = error instanceof OctoError && Number.isInteger(error.status) ? error.status : 0
      if (status === 429) {
        const delay = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0
        this.#retryAt = Math.max(this.#retryAt, Date.now() + Math.max(5000, delay))
      }
      if (!signal.aborted) this.log(status ? 'progress_http_' + status : 'progress_unavailable')
      return { ok: false, status }
    }
  }

  start(job, mode, signal) {
    if (!mode || mode === 'off') return { stage() {}, async finish() { return false } }
    const route = { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }
    const reasoningId = 'dsh-octo-' + (decimalId(job.message_id) ?? randomUUID())
    const started = Date.now()
    let phase = 'queued', shown, closed = false, timer, flight, finishing, id, format, seq = 1
    let tryCard = mode === 'auto', probeAt = started, dueAt = started + initialDelay
    let editAt, refreshAt, scheduledAt
    const active = () => !closed && !signal.aborted
    const render = state => frame(format, reasoningId, state, Math.max(0, Math.floor((Date.now() - started) / 1000)))
    const clearTimer = () => {
      clearTimeout(timer)
      timer = scheduledAt = undefined
    }
    const schedule = () => {
      if (!active() || flight) return
      const when = Math.max(dueAt, this.#retryAt)
      if (when === scheduledAt) return
      clearTimer()
      if (!Number.isFinite(when)) return
      scheduledAt = when
      timer = setTimeout(tick, Math.min(2 ** 31 - 1, Math.max(0, when - Date.now())))
      timer.unref?.()
    }
    const editDue = () => phase === shown ? refreshAt : editAt
    const flush = async () => {
      if (!active()) return
      if (id) {
        const snapshot = phase
        const result = await this.#request(() => this.api.editProgress(route, id, render(snapshot), ++seq, true, signal), signal)
        if (result.ok) shown = snapshot
        refreshAt = mayRetry(result.status) ? Date.now() + refreshInterval : Infinity
        editAt = result.ok || result.status === 429 ? Date.now() + editInterval : refreshAt
        // Keep the latest stage pending if a newer one arrived during this request.
        dueAt = result.status === 429 ? Date.now() : editDue()
        return
      }
      if (tryCard && !format && Date.now() >= probeAt) {
        const result = await this.#request(() => this.api.cardProfile(signal), signal)
        if (result.ok) format = cardMode(result.value)
        if ((result.ok && !format) || !mayRetry(result.status)) tryCard = false
        if (!result.ok && result.status !== 429) probeAt = Date.now() + 10_000
      }
      if (active() && tryCard && format) {
        const snapshot = phase
        const result = await this.#request(() => this.api.progressCard(route, render(snapshot), signal), signal)
        if (result.ok && result.value) {
          id = result.value
          shown = snapshot
          editAt = Date.now() + editInterval
          refreshAt = Date.now() + refreshInterval
          dueAt = editDue()
          return
        }
        // A rejected 429 can be retried. An uncertain create may already have posted a card.
        if (result.status !== 429) tryCard = false
      }
      if (active()) await this.#request(() => this.api.typing(route, signal), signal)
      dueAt = Date.now() + (this.#retryAt > Date.now() ? 0 : typingInterval)
    }
    const tick = () => {
      clearTimer()
      if (!active()) return
      if (Date.now() < Math.max(dueAt, this.#retryAt)) return schedule()
      flight = Promise.resolve().then(flush).finally(() => {
        flight = undefined
        schedule()
      })
    }
    const finish = async outcome => {
      closed = true
      clearTimer()
      signal.removeEventListener('abort', clearTimer)
      await flight
      if (!id || signal.aborted || !outcomes.includes(outcome)) return false
      const deadline = Date.now() + terminalWaitBudget
      const payload = render(outcome)
      const terminalSeq = ++seq
      for (let attempt = 0; attempt < 2; attempt++) {
        let when = Math.max(this.#retryAt, attempt ? Date.now() + editInterval : 0)
        while (when > Date.now() && !signal.aborted) {
          if (when > deadline) return false
          await waitFor(when - Date.now(), signal)
          when = Math.max(when, this.#retryAt)
        }
        if (signal.aborted) return false
        // Identical payload and sequence make a retry safe if the previous edit landed.
        const result = await this.#request(() => this.api.editProgress(route, id, payload, terminalSeq, false, signal), signal)
        if (result.ok) return true
        if (!mayRetry(result.status)) return false
      }
      return false
    }
    if (!signal.aborted) signal.addEventListener('abort', clearTimer, { once: true })
    schedule()
    return {
      stage(next) {
        if (next === 'answering') next = 'responding'
        if (!active() || stages.indexOf(next) <= stages.indexOf(phase)) return
        phase = next
        if (id && !flight) {
          dueAt = Math.min(dueAt, editDue())
          schedule()
        }
      },
      finish: outcome => finishing ??= finish(outcome),
    }
  }
}
