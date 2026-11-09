import { randomUUID } from 'node:crypto'

export const APPROVAL_LIMITS = Object.freeze({ waitMs: 300_000, pending: 8, calls: 64, argumentBytes: 16_384,
  detailChars: 900, detailBytes: 1400 })
export const APPROVAL_CHOICES = Object.freeze({ allow: '仅批准这一次', reject: '拒绝这次操作', cancel: '取消审批' })

const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const toolName = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/u.test(value)
const secretKey = /password|passwd|passphrase|secret|credential|authorization|cookie|privatekey|accesskey|apikey|token/iu
const secretText = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+\S+|\b(?:password|passwd|passphrase|token|api[-_ ]?key|secret|authorization|cookie)\s*(?:[:=]|\s)\s*\S+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+@|[?&](?:sig|signature|x-amz-signature|x-goog-signature)=|\b(?:sk-|bf_|ba_)[a-zA-Z0-9_-]{8,}/iu
const hidden = '[已隐藏敏感内容]'

// Redaction is conservative, not a secret detector for arbitrary prose. Any
// redaction prevents approval; a redacted fragment never authorizes its original.
function displayJson(value) {
  let nodes = 0, bytes = 0, redacted = false
  const visit = (item, depth) => {
    if (++nodes > 512 || depth > 16) throw new Error('approval_arguments_limit')
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item)
      if (bytes > APPROVAL_LIMITS.argumentBytes) throw new Error('approval_arguments_limit')
      if (secretText.test(item)) { redacted = true; return hidden }
      return item
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) {
      if (item.length > 512) throw new Error('approval_arguments_limit')
      return item.map(child => visit(child, depth + 1))
    }
    if (typeof item !== 'object' || !item || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw new Error('approval_arguments_unavailable')
    }
    const keys = Object.keys(item)
    if (keys.length > 512) throw new Error('approval_arguments_limit')
    const copy = Object.create(null)
    for (const key of keys) {
      bytes += Buffer.byteLength(key)
      if (bytes > APPROVAL_LIMITS.argumentBytes) throw new Error('approval_arguments_limit')
      // A sensitive key's entire value is withheld, including nested content.
      if (secretKey.test(key.replace(/[^a-z0-9]/giu, ''))) { copy[key] = hidden; redacted = true }
      else copy[key] = visit(item[key], depth + 1)
    }
    return copy
  }
  const text = JSON.stringify(visit(value, 0), null, 2)
    // Keep bidi/format controls visible, preserving their exact value as JSON escapes.
    .replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  if (Buffer.byteLength(text) > APPROVAL_LIMITS.argumentBytes) throw new Error('approval_arguments_limit')
  return { text, complete: !redacted }
}

function argumentsOf(event) {
  try {
    let args = event.data.arguments
    if (event.type === 'tool/call') {
      if (typeof args !== 'string' || !args.trim() || Buffer.byteLength(args) > APPROVAL_LIMITS.argumentBytes) {
        return { text: '参数缺失或超过读取上限，未展示。', complete: false }
      }
      args = JSON.parse(args)
    }
    return displayJson(args)
  } catch { return { text: '参数无法可靠读取，未展示。', complete: false } }
}

function boundedDetail(text) {
  if (Array.from(text).length <= APPROVAL_LIMITS.detailChars && Buffer.byteLength(text) <= APPROVAL_LIMITS.detailBytes) {
    return { text, complete: true }
  }
  const suffix = '\n【内容已截断；此处不能批准】'
  const budget = APPROVAL_LIMITS.detailBytes - Buffer.byteLength(suffix)
  const chars = APPROVAL_LIMITS.detailChars - Array.from(suffix).length
  let prefix = '', bytes = 0, count = 0
  for (const c of text) {
    const size = Buffer.byteLength(c)
    if (bytes + size > budget || count >= chars) break
    prefix += c; bytes += size; count++
  }
  return { text: prefix + suffix, complete: false }
}

function requestPresentation(request, cwd) {
  let reason, directory
  try {
    reason = displayJson(request.displayReason?.['zh-CN'] ?? request.displayReason?.zh ?? request.reason ?? request.displayReason?.en ?? '宿主未提供原因')
    directory = displayJson(cwd ?? '宿主未提供会话工作目录')
  } catch {
    reason = { text: '原因或工作目录无法完整展示。', complete: false }
    directory = { text: '未展示。', complete: false }
  }
  return { toolName: toolName(request.toolName) ? request.toolName : undefined, reason, directory }
}

function questionFor(record, request) {
  let complete = !!record?.complete
  const { reason, directory } = request
  const detail = boundedDetail(['工具：' + (request.toolName ?? '无法核实工具名称'),
    '会话工作目录：' + directory.text, '操作参数（JSON）：', record?.text ?? '未找到本轮对应的原生工具参数。',
    '申请原因：' + reason.text].join('\n'))
  complete &&= reason.complete && directory.complete && detail.complete
  const labels = complete ? [APPROVAL_CHOICES.allow, APPROVAL_CHOICES.reject] : [APPROVAL_CHOICES.reject, APPROVAL_CHOICES.cancel]
  return { complete, question: {
    id: 'approval-' + randomUUID(), intent: 'approval', header: 'DSH 工具权限审批',
    question: complete
      ? '是否仅批准下面这一次工具调用？不授权后续调用或整个会话。跳过、取消或超时均不执行。'
      : '操作信息缺失、已脱敏或未完整展示，此处不能批准。拒绝或取消后，请在 DSH 中核对并重新发起。',
    detail: detail.text, multiSelect: false,
    options: labels.map(label => ({ label })),
  } }
}

/**
 * One adapter per Octo run, installed BEFORE agent.prompt()/the first tool event.
 * Verified against local tag dsh-v0.2.1-rc.5:
 *   packages/interaction/user-approval/src/{index,types}.ts
 *   packages/core/agent-loop/src/tool-calls.ts; packages/core/tools/src/{types,ptc}.ts
 * approval/request has no arguments. Capture committed session/event tool/call
 * (JSON string) and tool/ptc-dispatch-start (JSON value) from the EXACT request
 * agent.session. PTC records have no turn: require their live parent/root chain.
 * No snapshotEvents(), cold history, latest-tool fallback, or model-supplied args.
 *
 * Required options:
 * - agent: exact native Agent (and its session) owned/borrowed by this run.
 * - runId/requester: immutable job/run id and original Octo sender, not channel id.
 * - signal: run lifetime, aborted on stop, offline/revocation, or mixed ownership.
 * - getTurn(): claimed native turn number ONLY while this run owns it exclusively;
 *   return undefined before claim, after turn/end, or when authority is mixed.
 * - authorize(scope): synchronous current access check; only literal true allows.
 * - onQuestion(questions, signal, scope): existing QuestionBridge callback result
 *   Promise<{answers:[{id, selected:string[], custom?:string}]}>. Bind its job to
 *   scope.requester, scope.sessionId and the ORIGINAL route; do not select a sender
 *   from the reply. QuestionBridge/worker authenticates callbacks and rechecks
 *   live access. The optional third argument carries immutable binding metadata.
 * - onWaiting(bool): optional RunClock pause/resume; each admitted request gets a
 *   balanced hold, including queue time. Execution timeout is separate from the
 *   bounded approval timeout (timeoutMs, 1..300000, default five minutes).
 *
 * Only exact option selection grants allowed-once. Text aliases, custom answers,
 * skipped questions, partial/redacted displays, failed sends, expired authority,
 * and late/replayed answers cannot grant. No approval policy/preset is changed.
 * Return outcomes to ApprovalService: it owns audit and native tool enforcement.
 * A missing record still offers reject/cancel, never delegates an owned request.
 * Call revoke() immediately on lost access; dispose() on run end/unmount. These
 * abort active UI waits and settle queued requests without waiting for transport.
 * Serialize this callback with ordinary questions/forms at the host if desired;
 * a busy QuestionBridge fails this approval closed. No disk or network I/O here.
 */
export class ApprovalAdapter {
  #agent; #session; #scope; #signal; #getTurn; #authorize; #ask; #waiting; #timeout
  #turn; #closed; #calls = new Map(); #pending = new Set(); #queue = []; #busy = false; #abort

  constructor({ agent, runId, requester, signal, getTurn, authorize, onQuestion, onWaiting = () => {},
    timeoutMs = APPROVAL_LIMITS.waitMs }) {
    if (!agent?.session || !nonempty(agent.id) || agent.session.id !== agent.id || !nonempty(runId) || !nonempty(requester)
      || !signal?.addEventListener || typeof getTurn !== 'function' || typeof authorize !== 'function'
      || typeof onQuestion !== 'function' || typeof onWaiting !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > APPROVAL_LIMITS.waitMs) {
      throw new TypeError('invalid_approval_adapter_options')
    }
    this.#agent = agent; this.#session = agent.session; this.#signal = signal
    this.#getTurn = getTurn; this.#authorize = authorize; this.#ask = onQuestion; this.#waiting = onWaiting; this.#timeout = timeoutMs
    this.#scope = Object.freeze({ runId, requester, sessionId: agent.session.id })
    this.#abort = () => this.dispose()
    signal.addEventListener('abort', this.#abort, { once: true })
    if (signal.aborted) this.dispose()
  }

  #authorized() {
    try {
      const turn = this.#getTurn()
      return !this.#closed && !this.#signal.aborted && this.#agent.session === this.#session
        && Number.isSafeInteger(turn) && turn >= 0 && (this.#turn === undefined || this.#turn === turn)
        && this.#authorize(this.#scope) === true
    } catch { return false }
  }

  /** Feed only host session/event events, not a worker/model replay or IPC args. */
  observe = (session, event) => {
    if (session !== this.#session || this.#closed) return
    const data = event?.data
    if (event?.type === 'turn/end' && this.#turn !== undefined && data?.turn === this.#turn) { this.dispose(); return }
    if (!this.#authorized() || !data) return
    const turn = this.#getTurn()
    this.#turn ??= turn
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      if (event.type === 'tool/result' && data.turn !== turn) return
      const id = event.type === 'tool/result' ? data.message?.toolCallId : data.subCallId
      for (const [key, record] of this.#calls) {
        if (key === id || record.root === id) {
          this.#calls.delete(key)
          for (const pending of this.#pending) if (pending.callId === key) pending.finish('cancelled')
        }
      }
      return
    }
    const native = event.type === 'tool/call', ptc = event.type === 'tool/ptc-dispatch-start'
    if (!native && !ptc) return
    const id = native ? data.callId : data.subCallId
    if (!nonempty(id) || native && data.turn !== turn) return
    const parent = this.#calls.get(data.parentCallId)
    if (ptc && (!parent || parent.ambiguous || parent.root !== data.rootCallId
      || !this.#calls.has(data.rootCallId) || this.#calls.get(data.rootCallId).ambiguous)) return
    // Ambiguous repeated identities cannot replace the original action awaiting approval.
    if (this.#calls.has(id)) { this.#calls.set(id, { root: id, ambiguous: true, complete: false, text: '调用标识重复，无法核实操作。' }); return }
    if (this.#calls.size >= APPROVAL_LIMITS.calls) return
    this.#calls.set(id, { ...argumentsOf(event), name: toolName(data.name) ? data.name : undefined, root: native ? id : data.rootCallId })
  }

  /** Native waterfall hook: only foreign agents delegate. Owned failures deny. */
  handle = async (request, next) => {
    if (request?.agent !== this.#agent || request.agent.session !== this.#session) return next()
    if (this.#closed) return this.#closed
    if (request.signal?.aborted || this.#signal.aborted) return 'cancelled'
    if (!this.#authorized()) return 'rejected'
    this.#turn ??= this.#getTurn()
    if (this.#queue.length + Number(this.#busy) >= APPROVAL_LIMITS.pending
      || [...this.#pending].some(entry => nonempty(request.callId) && entry.callId === request.callId)) return 'unavailable'
    // Copy presentation metadata now; an external listener cannot retarget a queued ask.
    const captured = { ...requestPresentation(request, this.#session.header?.cwd),
      callId: nonempty(request.callId) ? request.callId : undefined }
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal, this.#signal])
      : AbortSignal.any([controller.signal, this.#signal])
    const response = Promise.withResolvers()
    const entry = { request: captured, callId: captured.callId, signal, settled: false }
    let held = false, timer
    const abort = () => entry.finish('cancelled')
    entry.finish = outcome => {
      if (entry.settled) return
      entry.settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.#pending.delete(entry)
      const index = this.#queue.indexOf(entry)
      if (index >= 0) this.#queue.splice(index, 1)
      controller.abort()
      if (held) { try { this.#waiting(false) } catch { /* A failed clock callback never grants. */ } }
      response.resolve(outcome)
    }
    this.#pending.add(entry)
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(abort, this.#timeout)
    try { held = true; this.#waiting(true) } catch { entry.finish('unavailable') }
    if (signal.aborted) entry.finish('cancelled')
    if (!entry.settled) { this.#queue.push(entry); void this.#drain() }
    return response.promise
  }

  async #drain() {
    if (this.#busy) return
    this.#busy = true
    try {
      while (this.#queue.length) {
        const entry = this.#queue.shift()
        if (entry.settled) continue
        if (!this.#authorized()) { entry.finish(this.#closed ?? 'rejected'); continue }
        const record = this.#calls.get(entry.callId)
        const matching = record && toolName(entry.request.toolName) && record.name === entry.request.toolName
        const { question, complete } = questionFor(matching ? record : undefined, entry.request)
        try {
          const result = await this.#ask([question], entry.signal, this.#scope)
          // Await callback cleanup before showing another card, even if cancellation
          // settled this request sooner. A stuck callback cannot create overlapping UI.
          if (entry.settled) continue
          if (!this.#authorized()) { entry.finish(this.#closed ?? 'rejected'); continue }
          const answer = result?.answers?.length === 1 ? result.answers[0] : undefined
          if (answer?.id !== question.id || !Array.isArray(answer.selected) || answer.custom !== undefined) {
            entry.finish('rejected'); continue
          }
          const selected = answer.selected.length === 1 ? answer.selected[0] : undefined
          if (selected === APPROVAL_CHOICES.reject) entry.finish('rejected')
          else if (selected === APPROVAL_CHOICES.cancel || answer.selected.length === 0) entry.finish('cancelled')
          else if (selected === APPROVAL_CHOICES.allow && complete && this.#calls.get(entry.callId) === record) entry.finish('allowed-once')
          else entry.finish('unavailable')
        } catch { entry.finish(entry.signal.aborted ? 'cancelled' : 'unavailable') }
      }
    } finally { this.#busy = false }
  }

  #close(outcome) {
    if (this.#closed) return
    this.#closed = outcome
    this.#signal.removeEventListener('abort', this.#abort)
    for (const entry of this.#pending) entry.finish(outcome)
    this.#calls.clear()
  }
  revoke() { this.#close('rejected') }
  dispose() { this.#close('cancelled') }
}

/**
 * Host integration (no worker/dsh changes in this module):
 *   const binding = mountApprovalAdapter(agent.ctx, {
 *     agent, runId, requester: job.sender, signal,
 *     getTurn: () => authority.active && !authority.mixed ? claimedTurn : undefined,
 *     authorize: () => liveToolAllowed(job, currentConfig),
 *     onQuestion: extras.onQuestion,
 *     onWaiting: waiting => waiting ? deadline.pause() : deadline.resume(),
 *   })
 * Register before prompt submission, keep through turn settlement, then call
 * binding.dispose(); on access loss call binding.adapter.revoke() immediately.
 * Owned agent scope teardown also cancels waits. Borrowed scopes MUST explicitly
 * dispose this binding when their run settles. No global approval-service patch.
 */
export function mountApprovalAdapter(scoped, options) {
  const adapter = new ApprovalAdapter(options), offs = []
  const dispose = () => { adapter.dispose(); for (const off of offs.splice(0).reverse()) off() }
  try {
    offs.push(scoped.on('session/event', adapter.observe, { global: true }))
    offs.push(scoped.on('approval/request', adapter.handle, { prepend: true }))
    offs.push(scoped.on('dispose', () => adapter.dispose()))
  } catch (error) { dispose(); throw error }
  return { adapter, dispose }
}
