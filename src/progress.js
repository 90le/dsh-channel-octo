import { OctoError } from './octo.js'

const labels = {
  reasoning: '已收到，正在等待 DSH',
  answering: '正在生成回复',
  completed: '回复已发送',
  stopped: '回复发送待确认',
  error: '本次回复未完成，请稍后重发',
}

export function cardMode(profile) {
  const config = profile?.config
  if (![true, 1].includes(profile?.enabled) || config?.card_enabled !== true) return undefined
  const ref = config.reasoning_template_ref
  if (config.reasoning_enabled === true && ref?.id === 'ai.reasoning-process'
    && /^(0\.[1-3]\.0|0\.4\.[01])$/.test(ref.version) && profile.templating?.supported === true
    && profile.templating?.templates?.some?.(item => item.id === ref.id && item.version === ref.version
      && Object.keys(labels).every(state => item.views?.some?.(view => view.states?.includes?.(state))))) {
    return { id: ref.id, version: ref.version }
  }
  if (config.display_enabled === true && profile.card_version === '1.5' && profile.profiles?.includes?.('octo/v1')) return 'display'
}

function frame(mode, messageId, state, seconds) {
  const label = labels[state]
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
    reasoningId: 'dsh-octo-' + messageId, state, title: 'DSH 回复进度', statusLabel: label, statusTone: tone,
    timerText: elapsed, traceExpanded: false, traceCollapsed: true, collapsedSummary: label,
    progressText: label + ' · ' + elapsed,
    phases: [{ thought: label, actions: [{ tool: 'DSH', detail: elapsed, statusGlyph: '●',
      statusTone: tone === 'Warning' ? 'Accent' : tone }] }],
    ...(state === 'error' && { errorTitle: '回复未完成', errorMessage: label }),
  } }
}

export class Progress {
  #retryAt = 0
  constructor(api, log) { Object.assign(this, { api, log }) }

  start(job, mode, signal) {
    if (!mode || mode === 'off') return { stage() {}, async finish() { return false } }
    const route = { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }
    const started = Date.now()
    let state = 'reasoning', closed = false, timer, flight, id, format, seq = 1, first = true
    const elapsed = () => Math.floor((Date.now() - started) / 1000)
    const safe = async (fn) => {
      if (signal.aborted || this.#retryAt > Date.now()) return false
      try { await fn(); return true } catch (error) {
        if (!signal.aborted) {
          if (error instanceof OctoError && error.status === 429) {
            this.#retryAt = Date.now() + Math.max(5000, error.retryAfterMs)
          }
          this.log('progress_' + (error instanceof OctoError ? error.code : 'unavailable'))
        }
        return false
      }
    }
    const tick = () => {
      if (closed || signal.aborted) return
      flight = (async () => {
        if (first) {
          first = false
          if (mode === 'auto') await safe(async () => { format = cardMode(await this.api.cardProfile(signal)) })
          if (closed || signal.aborted) return
          if (format) await safe(async () => {
            id = await this.api.progressCard(route, frame(format, job.message_id, state, elapsed()), signal)
          })
        } else if (id) {
          await safe(() => this.api.editProgress(route, id, frame(format, job.message_id, state, elapsed()), ++seq, true, signal))
        }
        if (!id && !closed) await safe(() => this.api.typing(route, signal))
      })().finally(() => { if (!closed && !signal.aborted) timer = setTimeout(tick, id ? 5500 : 4000) })
    }
    timer = setTimeout(tick, 450)
    return {
      stage(next) { if (next === 'answering') state = next },
      finish: async (outcome) => {
        closed = true
        clearTimeout(timer)
        await flight
        if (!id) return false
        return safe(() => this.api.editProgress(route, id, frame(format, job.message_id, outcome, elapsed()), ++seq, false, signal))
      },
    }
  }
}
