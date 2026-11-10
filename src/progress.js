import { randomUUID } from 'node:crypto'
import { decimalId, OctoError } from './octo.js'
import { ProgressTimeline } from './progress-timeline.js'
import { safeProgressText } from './progress-events.js'

const labels = {
  queued: '已收到，等待 DSH 开始处理',
  running: 'DSH 正在处理',
  responding: '正在生成回复',
  delivering: '正在发送回复与交付文件',
  tool: '正在执行工具',
  question: '等待你的回答',
  approval: '等待你批准这次操作',
  completed: '回复已发送',
  stopped: '回复发送待确认',
  error: '本次回复未完成，展开查看步骤及原因',
}

const stages = ['queued', 'running', 'responding', 'delivering']
const outcomes = ['completed', 'stopped', 'error']
const wireStates = { queued: 'reasoning', running: 'reasoning', responding: 'answering', delivering: 'answering', tool: 'reasoning', question: 'reasoning', approval: 'reasoning' }
const templateStates = ['reasoning', 'answering', ...outcomes]
const initialDelay = 450
const editInterval = 800
const refreshInterval = 15_000
const typingInterval = 4000
const terminalWaitBudget = 6000

export function cardMode(profile) {
  const config = profile?.config
  if (![true, 1].includes(profile?.enabled) || config?.card_enabled !== true) return undefined
  // Prefer nested local disclosures when the server advertises every element.
  // Column is structurally covered by ColumnSet; the official profile does not list it separately.
  // Registry-only installations retain their official template and local toggles.
  if (config.display_enabled === true && profile.card_version === '1.5'
    && profile.profiles?.includes('octo/v1') && profile.actions?.includes('Action.ToggleVisibility')
    && ['TextBlock', 'Container', 'ColumnSet', 'Image'].every(type => profile.elements?.includes(type))) return 'compact'
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
  ['read_file', '读取文件'], ['write_file', '写入文件'], ['exec_command', '运行工作区命令'],
  ['ask_user_question', '向你提问'], ['octo_inspect', '检查频道状态'], ['octo_members', '查询群成员'],
  ['octo_groups_list', '读取当前群信息'], ['octo_groups_create', '创建群聊'],
  ['octo_members_add', '添加群成员'], ['octo_members_remove', '移除群成员'], ['octo_group_edit', '更新群信息'],
  ['octo_space_members_search', '搜索空间成员'], ['octo_targets_resolve', '识别群与子区'],
  ['octo_rules_read', '读取群规则'], ['octo_rules_edit', '更新群规则'],
  ['octo_threads_list', '查询子区'], ['octo_threads_create', '创建子区'],
  ['octo_thread_read', '读取子区信息'], ['octo_thread_members', '查询子区成员'],
  ['octo_thread_rules_read', '读取子区规则'], ['octo_thread_rules_edit', '更新子区规则'],
  ['octo_thread_join', '加入子区'], ['octo_thread_leave', '退出子区'],
  ['octo_thread_archive', '归档子区'], ['octo_thread_delete', '删除子区'],
  ['octo_messages_read', '读取消息'], ['octo_messages_recent', '读取近期消息'],
  ['octo_messages_search', '搜索消息'], ['octo_messages_search_files', '搜索文件'],
  ['octo_messages_search_media', '搜索图片与视频'], ['octo_messages_search_all', '搜索消息和文件'],
  ['octo_messages_search_around', '读取消息前后文'], ['octo_messages_notify', '发送频道消息'],
  ['octo_messages_search_authorized', '检索已授权频道消息'], ['octo_messages_search_authorized_files', '检索已授权频道文件'],
  ['octo_messages_search_authorized_groups', '整理已授权群摘要'],
  ['octo_messages_resolve_targets', '确认目标群与子区'], ['octo_messages_resolve_people', '查找指定联系人'],
  ['octo_messages_send_target', '向指定会话发送消息'],
  ['octo_messages_send_target_file', '向指定会话交付文件'], ['octo_messages_send_target_card', '向指定会话发送展示卡'],
  ['octo_messages_user_info', '查询会话成员身份'], ['octo_messages_users_batch', '查询会话成员名称'],
  ['octo_webhooks_list', '查询频道 Webhook'], ['octo_webhooks_deliveries', '核对 Webhook 投递'],
  ['octo_webhooks_update', '更新频道 Webhook'], ['octo_webhooks_delete', '移除频道 Webhook'],
  ['octo_webhooks_test', '发送 Webhook 测试'], ['octo_messages_clear_card_revisions', '清理展示卡修订历史'],
  ['octo_messages_edit', '编辑消息'], ['octo_messages_mark_read', '标记已读'],
  ['octo_messages_edit_richtext', '编辑图文消息'], ['octo_messages_edit_display_card', '编辑展示卡片'],
  ['octo_voice_transcribe', '转写语音'], ['octo_voice_context_read', '读取语音词汇'],
  ['octo_voice_context_update', '更新语音词汇'], ['octo_voice_context_delete', '清除语音词汇'],
  ['octo_display_card', '发送展示卡片'],
  ['octo_form', '等待填写表单'],
  ['octo_form_publish', '发布稍后填写的表单'],
  ['octo_form_manage', '管理已发布表单'],
])
const action = (tool, detail, status = 'active') => ({
  tool, detail, statusGlyph: status === 'done' ? '✓' : status === 'failed' ? '!' : '●',
  statusTone: status === 'done' ? 'Good' : status === 'failed' ? 'Attention' : 'Accent',
})

function duration(seconds) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24
  const minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分`
    : minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

const text = (value, extra = {}) => ({ type: 'TextBlock', text: value, size: 'Default', wrap: true, spacing: 'Small', ...extra })
const column = (width, items) => ({ type: 'Column', width, spacing: 'Small', verticalContentAlignment: 'Center', items })
const visibility = (elementId, isVisible) => ({ elementId, isVisible })
const disclosureTargets = (id, expanded) => [
  visibility(id + '_details', expanded), visibility(id + '_open', !expanded), visibility(id + '_close', expanded),
]

function chevrons(id, label, targets, double = false) {
  return [false, true].map(expanded => {
    const title = (expanded ? '收起' : '展开') + label
    // Octo's server only accepts these exact official icon bytes; visually
    // equivalent SVGs (including a custom double-chevron) reject the whole card.
    const path = expanded ? 'm18 15l-6-6l-6 6' : 'm6 9l6 6l6-6'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="#a1a6ab" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${path}"/></svg>`
    const icon = { type: 'Image', url: 'data:image/svg+xml,' + encodeURIComponent(svg),
      altText: title, size: 'Small', width: '14px', height: double ? '8px' : '14px', spacing: 'None' }
    return { ...(double ? { type: 'Container', spacing: 'None', items: [{ ...icon }, { ...icon }] } : icon),
      id: id + (expanded ? '_close' : '_open'), isVisible: !expanded,
      selectAction: { type: 'Action.ToggleVisibility', title, targetElements: targets(!expanded) } }
  })
}

function compactBody(status, summary, tone, phases, stats, note) {
  // Semantic group IDs remain stable when the recent tools window or phase order changes.
  const groups = phases.map(group => ({ ...group,
    id: group.id ?? 'dsh_progress_' + (group.thought === '工具执行' ? 'tools' : group.thought === '文件交付' ? 'files' : 'session') }))
  const outer = 'dsh_progress', all = 'dsh_progress_all'
  const allTargets = expanded => [
    ...[outer, ...groups.map(group => group.id)].flatMap(id => disclosureTargets(id, expanded)),
    visibility(all + '_open', !expanded), visibility(all + '_close', expanded),
  ]
  return [{ type: 'Container', style: 'emphasis', bleed: true, spacing: 'None', items: [
    { type: 'ColumnSet', spacing: 'None', columns: [
      column('auto', [text('DSH 回复进度', { weight: 'Bolder', size: 'Medium', spacing: 'None' })]),
      // Only these three outer targets change: child visibility survives an outer close/open in this frame.
      column('auto', chevrons(outer, '详情', expanded => disclosureTargets(outer, expanded))),
      column('stretch', []),
      column('auto', chevrons(all, '全部详情', allTargets, true)),
    ] },
    text(status, { color: tone, spacing: 'None' }),
    text(summary, { isSubtle: true, size: 'Small' }),
    { type: 'Container', id: outer + '_details', isVisible: false, separator: true, spacing: 'Small', items: [
      ...(stats.steps ? [text('已进入 ' + stats.steps + ' 个处理步骤；工具返回不等于目标已完成', { isSubtle: true })] : []),
      ...groups.map(group => ({ type: 'Container', spacing: 'Small', items: [
        { type: 'ColumnSet', spacing: 'None', columns: [
          column('stretch', [text(group.thought, { spacing: 'None' })]),
          column('auto', chevrons(group.id, group.thought, expanded => disclosureTargets(group.id, expanded))),
        ] },
        ...(group.summary ? [text(group.summary, { isSubtle: true })] : []),
        { type: 'Container', id: group.id + '_details', isVisible: false, spacing: 'Small', items: [
          ...group.actions.map((item, index) => ({ type: 'Container', spacing: index === 0 ? 'None' : 'Small', items: [
            text(item.statusGlyph + ' ' + item.tool, { color: item.statusTone, spacing: 'None', weight: 'Bolder' }),
            text(item.detail, { isSubtle: true, spacing: 'Small' }),
          ] })),
        ] },
      ] })),
      ...(note ? [text(note, { color: stats.failed ? 'Warning' : tone })] : []),
    ] },
  ] }]
}

function frame(mode, reasoningId, phase, seconds, stats, detail, interrupted, pageIndex = 0) {
  const terminal = outcomes.includes(phase)
  const actual = !terminal && stats.approval ? 'approval' : !terminal && stats.waiting ? 'question'
    : !terminal && phase !== 'delivering' && stats.active > 0 ? 'tool' : phase
  const label = interrupted ? '任务已停止' : labels[actual]
  const state = wireStates[actual] ?? actual
  const elapsed = '已用时 ' + duration(seconds)
  const summary = pageIndex ? '步骤记录 · 后续进度见最新卡片' : [elapsed, stats.calls && stats.calls + ' 次工具', stats.files && '已发 ' + stats.files + ' 个文件']
    .filter(Boolean).join(' · ')
  const descriptions = [...stats.recent.values()].slice(-4).map(row =>
    action(row.label, row.status === 'done' ? '已完成' : row.status === 'failed' ? '未完成' : terminal ? '未确认结束' : '执行中', row.status))
  const note = safeProgressText(detail, 500) || (stats.failed ? stats.failed + ' 次工具未成功，请展开查看对应步骤；工具返回不等于目标完成。' : '')
  const phases = stats.timeline?.groups(pageIndex, terminal, interrupted, safeProgressText) ?? []
  if (!stats.timeline?.pages.length && descriptions.length) phases.push({ thought: '工具执行', actions: descriptions })
  if (stats.files && pageIndex === 0) phases.push({ thought: '文件交付', actions: [action('Octo 附件', '已确认发送 ' + stats.files + ' 个文件', 'done')] })
  if (!phases.length) phases.push({ thought: stats.steps ? '会话处理' : '请求已接收',
    actions: [action('DSH', terminal ? phase === 'completed' ? '处理已结束' : interrupted ? '已停止执行' : '未确认完成'
      : stats.steps ? '已进入 ' + stats.steps + ' 个处理步骤' : '等待模型开始',
      phase === 'completed' ? 'done' : terminal ? 'failed' : 'active')] })
  const tone = state === 'error' ? 'Attention' : state === 'completed' ? 'Good' : state === 'stopped' ? 'Warning' : 'Accent'
  const current = actual === 'tool' && [...stats.recent.values()].reverse().find(row => row.status === 'active')
  const status = pageIndex && !terminal ? '步骤详情' : current ? '正在' + current.label : label
  if (mode === 'compact' || mode === 'display') {
    const pageLabel = (stats.timeline?.pages.length ?? 0) > 1 ? ` · 第 ${pageIndex + 1} 页` : ''
    const body = mode === 'compact' ? compactBody(status, summary, tone, phases, stats, note) : [
      text('DSH 回复进度', { weight: 'Bolder' }), text(status, { color: tone }), text(summary, { isSubtle: true, size: 'Small' }),
      ...phases.flatMap(group => [text(group.thought, { weight: 'Bolder' }), ...(group.summary ? [text(group.summary)] : []),
        ...group.actions.map(a => text(a.statusGlyph + ' ' + a.tool + '：' + a.detail))]),
      ...(note ? [text(note)] : []),
    ]
    if (mode === 'compact') body[0].items[0].columns[0].items[0].text += pageLabel
    else body[0].text += pageLabel
    return { profile: 'octo/v1', card_version: '1.5', plain: status + ' · ' + summary + (note ? ' · ' + note : ''),
      card: { type: 'AdaptiveCard', version: '1.5', body } }
  }
  const expanded = false
  return { template_ref: mode, state, data: {
    reasoningId, state, title: 'DSH 回复进度', statusLabel: status, statusTone: tone,
    timerText: elapsed, traceExpanded: expanded, traceCollapsed: !expanded, collapsedSummary: summary,
    progressText: note || (terminal ? summary : label + ' · ' + summary),
    phases: phases.map(({ thought, summary, actions }) => ({ thought: thought + (summary ? ' · ' + summary : ''), actions })),
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

  start(job, mode, signal, authorize, terminalSignal = signal) {
    if (!mode || mode === 'off') return { stage() {}, trace() {}, async finish() { return false } }
    const route = { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }
    const reasoningId = 'dsh-octo-' + (decimalId(job.message_id) ?? randomUUID())
    const started = Date.now()
    let revision = 0
    const stats = { steps: 0, calls: 0, files: 0, active: 0, failed: 0, waiting: false, recent: new Map(), pending: new Set(), timeline: new ProgressTimeline() }
    let phase = 'queued', shown, closed = false, blocked = false, timer, flight, finishing, id, format, seq = 1
    let tryCard = mode === 'auto', probeAt = started, dueAt = started + initialDelay
    let editAt, refreshAt, scheduledAt
    const active = () => !closed && !blocked && !signal.aborted
    const render = (state, detail, interrupted, page = 0) => frame(format, reasoningId + (page ? '-page-' + page : ''), state,
      Math.max(0, Math.floor((Date.now() - started) / 1000)), stats, detail, interrupted, page)
    const pageCards = new Map()
    let pageIssue = false
    const clearTimer = () => {
      clearTimeout(timer)
      timer = scheduledAt = undefined
    }
    const request = (fn, terminal = false, requestSignal = signal) => this.#request(async () => {
      if (authorize) {
        try {
          if (await authorize(requestSignal) !== true) throw new Error('progress_access_denied')
        } catch (error) {
          if (!requestSignal.aborted) blocked = true
          clearTimer()
          throw error
        }
      }
      if (blocked || requestSignal.aborted || (!terminal && closed)) throw new Error('progress_closed')
      return fn()
    }, requestSignal)
    const syncPages = async (state, detail, interrupted, terminal = false, requestSignal = signal) => {
      let okay = true
      for (let page = 1; page < stats.timeline.pages.length; page++) {
        if (requestSignal.aborted || blocked || (!terminal && closed)) return false
        let entry = pageCards.get(page)
        if (entry?.uncertain) { okay = false; continue }
        const payload = render(state, detail, interrupted, page)
        const serialized = stats.timeline.stamp(page, terminal) + ':' + (terminal ? state : 'active') + ':' + !!interrupted + ':' + (detail ?? '')
        if (entry?.serialized === serialized) continue
        let result
        if (entry?.id) result = await request(() => this.api.editProgress(route, entry.id, payload, ++entry.seq, !terminal, requestSignal), terminal, requestSignal)
        else result = await request(() => this.api.progressCard(route, payload, requestSignal), terminal, requestSignal)
        if (result.ok) {
          if (!entry) { entry = { id: result.value, seq: 1 }; pageCards.set(page, entry) }
          entry.serialized = serialized
        } else {
          okay = false; pageIssue = true
          if (!entry && result.status !== 429) pageCards.set(page, { uncertain: true })
          if (result.status === 429) break
        }
      }
      return okay
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
        const result = await request(() => this.api.editProgress(route, id, render(phase), ++seq, true, signal))
        if (result.ok) { shown = snapshot; await syncPages(phase) }
        refreshAt = mayRetry(result.status) ? Date.now() + refreshInterval : Infinity
        editAt = result.ok || result.status === 429 ? Date.now() + editInterval : refreshAt
        // Keep the latest stage pending if a newer one arrived during this request.
        dueAt = result.status === 429 ? Date.now() : editDue()
        return
      }
      if (tryCard && !format && Date.now() >= probeAt) {
        const result = await request(() => this.api.cardProfile(signal))
        if (result.ok) format = cardMode(result.value)
        if ((result.ok && !format) || !mayRetry(result.status)) tryCard = false
        if (!result.ok && result.status !== 429) probeAt = Date.now() + 10_000
      }
      if (active() && tryCard && format) {
        const snapshot = revision
        const result = await request(() => this.api.progressCard(route, render(phase), signal))
        if (result.ok && result.value) {
          id = result.value
          await syncPages(phase)
          shown = snapshot
          editAt = Date.now() + editInterval
          refreshAt = Date.now() + refreshInterval
          dueAt = editDue()
          return
        }
        // A definitive validation rejection did not create a message. Retain a
        // useful card on older servers without retrying an uncertain delivery.
        if (result.status === 400 && format === 'compact') {
          format = 'display'
          dueAt = Date.now()
          return
        }
        // A rejected 429 can be retried. An uncertain create may already have posted a card.
        if (result.status !== 429) tryCard = false
      }
      if (active()) await request(() => this.api.typing(route, signal))
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
    const finish = async (outcome, { detail, interrupted } = {}) => {
      closed = true
      clearTimer()
      signal.removeEventListener('abort', clearTimer)
      await flight
      const finishSignal = interrupted && outcome === 'stopped' ? terminalSignal : signal
      if (!id || blocked || finishSignal.aborted || !outcomes.includes(outcome)) return false
      const deadline = Date.now() + terminalWaitBudget
      const pagesOkay = await syncPages(outcome, detail, interrupted, true, finishSignal)
      const warning = pageIssue ? '部分步骤卡未确认送达，记录可能不完整。' : ''
      const payload = render(outcome, [detail, warning].filter(Boolean).join(' '), interrupted)
      const terminalSeq = ++seq
      for (let attempt = 0; attempt < 2; attempt++) {
        let when = Math.max(this.#retryAt, attempt ? Date.now() + editInterval : 0)
        while (when > Date.now() && !finishSignal.aborted) {
          if (when > deadline) return false
          await waitFor(when - Date.now(), finishSignal)
          when = Math.max(when, this.#retryAt)
        }
        if (finishSignal.aborted) return false
        // Identical payload and sequence make a retry safe if the previous edit landed.
        const result = await request(() => this.api.editProgress(route, id, payload, terminalSeq, false, finishSignal), true, finishSignal)
        if (result.ok) return pagesOkay
        if (blocked) return false
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
        if (!active()) return
        if (next === 'approval') { if (!stats.approval) { stats.approval = true; changed() }; return }
        if (next === 'running' && stats.approval) { stats.approval = false; changed() }
        if (next === 'answering') next = 'responding'
        if (!active() || stages.indexOf(next) <= stages.indexOf(phase)) return
        phase = next
        changed()
      },
      trace(event) {
        if (!active()) return
        if (event?.kind === 'note') {
          const value = safeProgressText(event.text, 800)
          if (!value) return
          stats.timeline.observe({ ...event, text: value }); changed(); return
        }
        if (event?.kind === 'step-end') { stats.timeline.observe(event); changed(); return }
        if (event?.kind === 'step') stats.steps = Math.min(999, stats.steps + 1)
        else if (event?.kind === 'question-open' || event?.kind === 'question-closed') {
          const waiting = event.kind === 'question-open'
          if (stats.waiting === waiting) return
          stats.waiting = waiting
        }
        else if (event?.kind === 'tool-start' && typeof event.id === 'string' && event.id.length <= 256 && !stats.pending.has(event.id)
          && stats.pending.size < 128) {
          stats.calls = Math.min(999, stats.calls + 1)
          stats.pending.add(event.id)
          stats.active = stats.pending.size
          stats.recent.set(event.id, { label: safeProgressText(event.title, 100) || toolLabels.get(event.name) || '调用工具', status: 'active' })
          if (stats.recent.size > 4) stats.recent.delete(stats.recent.keys().next().value)
        } else if (event?.kind === 'tool-end' && stats.pending.delete(event.id)) {
          stats.active = stats.pending.size
          if (event.failed) stats.failed = Math.min(999, stats.failed + 1)
          const row = stats.recent.get(event.id)
          if (row) row.status = event.failed ? 'failed' : 'done'
        } else if (event?.kind === 'file-sent') stats.files = Math.min(5, stats.files + 1)
        else return
        stats.timeline.observe(event, safeProgressText(event.title, 100) || toolLabels.get(event.name) || '调用工具')
        changed()
      },
      finish: (outcome, options) => finishing ??= finish(outcome, options),
    }
  }
}
