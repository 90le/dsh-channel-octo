import { randomUUID } from 'node:crypto'
import { decimalId, OctoError } from './octo.js'

const labels = {
  queued: '已收到，等待 DSH 开始处理',
  running: 'DSH 正在处理',
  responding: '正在生成回复',
  delivering: '正在发送回复与交付文件',
  tool: '正在执行工具',
  completed: '回复已发送',
  stopped: '回复发送待确认',
  error: '本次回复未完成，请稍后重发',
}

const stages = ['queued', 'running', 'responding', 'delivering']
const outcomes = ['completed', 'stopped', 'error']
const wireStates = { queued: 'reasoning', running: 'reasoning', responding: 'answering', delivering: 'answering', tool: 'reasoning' }
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

const toolLabels = new Map([
  ['shell', '运行工作区命令'], ['bash', '运行工作区命令'], ['exec', '运行工作区命令'],
  ['read', '读取文件'], ['write', '写入文件'], ['edit', '修改文件'],
  ['apply_patch', '修改文件'], ['present', '准备交付文件'], ['run_code', '执行工具程序'],
])
const action = (tool, detail, status = 'active') => ({
  tool, detail, statusGlyph: status === 'done' ? '✓' : status === 'failed' ? '!' : '●',
  statusTone: status === 'done' ? 'Good' : status === 'failed' ? 'Attention' : 'Accent',
})

function frame(mode, reasoningId, phase, seconds, stats, detail) {
  const terminal = outcomes.includes(phase)
  const actual = !terminal && phase !== 'delivering' && stats.active > 0 ? 'tool' : phase
  const label = labels[actual]
  const state = wireStates[actual] ?? actual
  const elapsed = '已用时 ' + seconds + ' 秒'
  const counts = stats.steps + ' 步 · ' + stats.calls + ' 次工具' + (stats.files ? ' · 已发 ' + stats.files + ' 个文件' : '')
  const summary = elapsed + ' · ' + counts
  const descriptions = [...stats.recent.values()].slice(-4).map(row =>
    action(row.label, row.status === 'done' ? '已完成' : row.status === 'failed' ? '未完成' : terminal ? '未确认结束' : '执行中', row.status))
  const note = detail || (stats.failed ? stats.failed + ' 次工具未成功' : '')
  const phases = []
  if (descriptions.length) phases.push({ thought: '工具执行', actions: descriptions })
  if (stats.files) phases.push({ thought: '文件交付', actions: [action('Octo 附件', '已确认发送 ' + stats.files + ' 个文件', 'done')] })
  if (!phases.length) phases.push({ thought: stats.steps ? '会话处理' : '请求已接收',
    actions: [action('DSH', stats.steps ? '已进入 ' + stats.steps + ' 个处理步骤' : '等待模型开始', terminal ? 'done' : 'active')] })
  if (mode === 'display') return {
    profile: 'octo/v1', card_version: '1.5', plain: label + ' · ' + summary,
    card: { type: 'AdaptiveCard', version: '1.5', body: [
      { type: 'TextBlock', text: 'DSH 回复进度', weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: label + ' · ' + summary, wrap: true },
      ...descriptions.map(item => ({ type: 'TextBlock', text: item.statusGlyph + ' ' + item.tool + '：' + item.detail, wrap: true })),
      ...(note ? [{ type: 'TextBlock', text: note, wrap: true }] : []),
    ] },
  }
  const tone = state === 'error' ? 'Attention' : state === 'completed' ? 'Good' : state === 'stopped' ? 'Warning' : 'Accent'
  const expanded = !terminal && descriptions.length > 0
  return { template_ref: mode, state, data: {
    reasoningId, state, title: 'DSH 回复进度', statusLabel: label, statusTone: tone,
    timerText: elapsed, traceExpanded: expanded, traceCollapsed: !expanded, collapsedSummary: summary,
    progressText: note || (terminal ? summary : label + ' · ' + summary),
    phases,
    ...(state === 'error' && { errorTitle: '回复未完成', errorMessage: detail || label }),
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
    if (!mode || mode === 'off') return { stage() {}, trace() {}, async finish() { return false } }
    const route = { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }
    const reasoningId = 'dsh-octo-' + (decimalId(job.message_id) ?? randomUUID())
    const started = Date.now()
    let revision = 0
    const stats = { steps: 0, calls: 0, files: 0, active: 0, failed: 0, recent: new Map(), pending: new Set() }
    let phase = 'queued', shown, closed = false, timer, flight, finishing, id, format, seq = 1
    let tryCard = mode === 'auto', probeAt = started, dueAt = started + initialDelay
    let editAt, refreshAt, scheduledAt
    const active = () => !closed && !signal.aborted
    const render = (state, detail) => frame(format, reasoningId, state, Math.max(0, Math.floor((Date.now() - started) / 1000)), stats, detail)
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
    const editDue = () => revision === shown ? refreshAt : editAt
    const flush = async () => {
      if (!active()) return
      if (id) {
        const snapshot = revision
        const result = await this.#request(() => this.api.editProgress(route, id, render(phase), ++seq, true, signal), signal)
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
        const snapshot = revision
        const result = await this.#request(() => this.api.progressCard(route, render(phase), signal), signal)
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
    const finish = async (outcome, { detail } = {}) => {
      closed = true
      clearTimer()
      signal.removeEventListener('abort', clearTimer)
      await flight
      if (!id || signal.aborted || !outcomes.includes(outcome)) return false
      const deadline = Date.now() + terminalWaitBudget
      const payload = render(outcome, detail)
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
    const changed = () => {
      revision++
      if (id && !flight) {
        dueAt = Math.min(dueAt, editDue())
        schedule()
      }
    }
    return {
      stage(next) {
        if (next === 'answering') next = 'responding'
        if (!active() || stages.indexOf(next) <= stages.indexOf(phase)) return
        phase = next
        changed()
      },
      trace(event) {
        if (!active()) return
        if (event?.kind === 'step') stats.steps = Math.min(999, stats.steps + 1)
        else if (event?.kind === 'tool-start' && typeof event.id === 'string' && event.id.length <= 256 && !stats.pending.has(event.id)
          && stats.pending.size < 128) {
          stats.calls = Math.min(999, stats.calls + 1)
          stats.pending.add(event.id)
          stats.active = stats.pending.size
          stats.recent.set(event.id, { label: toolLabels.get(event.name) ?? '调用工具', status: 'active' })
          if (stats.recent.size > 4) stats.recent.delete(stats.recent.keys().next().value)
        } else if (event?.kind === 'tool-end' && stats.pending.delete(event.id)) {
          stats.active = stats.pending.size
          if (event.failed) stats.failed = Math.min(999, stats.failed + 1)
          const row = stats.recent.get(event.id)
          if (row) row.status = event.failed ? 'failed' : 'done'
        } else if (event?.kind === 'file-sent') stats.files = Math.min(5, stats.files + 1)
        else return
        changed()
      },
      finish: (outcome, options) => finishing ??= finish(outcome, options),
    }
  }
}
