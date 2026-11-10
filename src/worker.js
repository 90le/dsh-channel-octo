import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { admit, channelSequence, decimalId, OctoError, permitsRoute } from './octo.js'
import { receiveRealtime } from './realtime.js'
import { Progress } from './progress.js'
import { QuestionBridge } from './questions.js'
import { downloadAttachment, prepareAttachment, uploadAttachment } from './octo-media.js'
import { readDeliverable } from './dsh-media.js'
import { createCard, parseCardAction, resolveCardAction, sendCard } from './octo-cards.js'
import { finalMentions, textSegments, hasMarkdown, boundedMarkdown, mentionGuidance } from './outbound-text.js'
import { CHANNEL_API_OPERATIONS as operationSpecs } from './channel-api.js'
import { apiErrorCode } from './api-errors.js'
import { spec as displayCardSpec, sendDisplayCard } from './display-card.js'
import { voiceTool } from './voice-tool.js'
import { formToolSpec } from './form-tool.js'
import { deferredFormSpecs, publishDeferredForm, manageDeferredForm, deferredMessage, flushDeferredFeedback } from './deferred-forms.js'
import { InboxRecovery } from './inbox.js'
import { DirectoryDiscovery } from './directory-discovery.js'
import { OCTO_STOP } from './im-controls.js'
import { octoQuoteFromHistory } from './octo-quote.js'
import { operationAvailable } from './channel-operation-policy.js'
import { OBO_SEND_CONTRACT, OBO_SEND_TOOL } from './obo-send.js'
import { webhookChatReceipt } from './webhook-chat-command.js'

const safeCommand = (config, job) => (job.channel_type === 1
  ? config.dmCommands === 'safe' && (job.sender === config.ownerUid || config.allowed.has(job.sender))
  : config.groupCommands === 'safe' && job.sender === config.ownerUid && !job.ambient)
// Chat admission is separate from tools. Owner identity comes from the Bot's
// official verified identity (User Bot verify-bot; App Bot registration).
export function authorizedTools(config, job) {
  if (config.toolScope === 'admitted') return true // Caller must still pass channel admission.
  if (config.toolScope === 'owner') return !!config.ownerUid && job.sender === config.ownerUid
  return job.channel_type === 1 && (config.senderPolicy === 'allowlist'
    ? config.allowed.has(job.sender)
    : config.senderPolicy === 'octo' && !!config.ownerUid && job.sender === config.ownerUid)
}
function asksForFile(input) {
  return /(?:发送|发给|发我|回传|传给|交付|附上).{0,14}(?:文件|附件)|(?:文件|附件).{0,14}(?:发送|发给|发我|回传|传给|交付)|\b(?:send|attach|deliver)\b.{0,24}\b(?:file|attachment)\b/iu.test(input)
}
// Persist no credentials. Bind prepared output to the context that produced it;
// presentation/queue settings such as label and sendMode are deliberately absent.
const deliveryProfile = (config, job) => createHash('sha256').update(JSON.stringify([
  1, config.apiBase, config.botUid, config.spaceId, config.cwd, config.sessionProfile,
  config.ownerUid, config.toolPermission, config.toolScope, authorizedTools(config, job),
  job.channel_type === 5 ? config.threadRuleMode : null,
])).digest('hex')
const deliveryMediaProfile = config => createHash('sha256').update(JSON.stringify([
  1, [...new Set(config.mediaDownloadOrigins ?? [])].sort(), [...new Set(config.mediaUploadOrigins ?? [])].sort(),
  config.mediaMaxBytes ?? 16 * 1024 * 1024,
])).digest('hex')
async function materializeInput(config, meta, signal) {
  const descriptors = meta.attachments ?? (meta.attachment ? [meta.attachment] : [])
  if (!descriptors.length) return { attachments: [], order: meta.parts }
  const attachments = [], indices = new Map()
  const budget = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  let total = 0
  for (const [i, descriptor] of descriptors.entries()) {
    try {
      budget.throwIfAborted()
      if (total + (descriptor.size ?? 0) > 40 * 1024 * 1024) continue
      const attachment = await downloadAttachment(config, descriptor, budget)
      if (total + attachment.bytes.length > 40 * 1024 * 1024) continue
      total += attachment.bytes.length
      indices.set(i, attachments.length)
      attachments.push(attachment)
    } catch {
      signal.throwIfAborted()
    }
  }
  const unavailable = { text: '【附件未能读取】' }
  if (!meta.parts && !attachments.length) throw new OctoError('attachment_unavailable')
  return { attachments, order: meta.parts?.map(part =>
    Number.isInteger(part.media) ? (indices.has(part.media) ? { ...part, media: indices.get(part.media) } : unavailable) : part) }
}
function authoredCard(reply) {
  const match = /^```octo-card\s*\n([\s\S]{1,2300})\n```$/u.exec(reply.trim())
  if (!match) return
  try {
    const form = JSON.parse(match[1])
    if (!form || typeof form.text !== 'string' || Object.keys(form).some(key => key !== 'title' && key !== 'text')) return
    return { form, fallback: createCard(form).plain }
  } catch {}
}

const textCommands = {
  help: '可用命令：/help 帮助、/status 当前会话状态、/new 新会话、/stop 停止你在当前频道正在处理的任务。',
  status: 'DSH 已收到这条消息，当前会话可以正常处理消息。',
  new: '已开启新会话，旧会话记录仍可在 DSH 查看。',
}


const hostIssues = new Set(['session_busy', 'session_timeout', 'session_preset_conflict',
  'deferred_session_unavailable', 'deferred_configuration_changed',
  'delivery_access_changed',
  'missing_host_model', 'shared_turn_not_forwarded', 'prompt_discarded', 'no_confirmed_final_text',
  'session_missing', 'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context',
  'missing_scoped_tool_controls', 'missing_host_permission', 'session_requires_owned_writer', 'dsh_attachment_rejected', 'dsh_attachment_storage_unavailable'])

const failureDetails = {
  deferred_session_unavailable: '这张表单对应的原会话已不可用，未另开会话执行。请重新发起任务。',
  deferred_configuration_changed: '这张表单发布后的工作区、模型或工具权限已变更，未按新配置执行旧表单。请重新发起。',
  delivery_access_changed: '账号设置或频道权限已变更，剩余交付已停止。请在 DSH 查看已执行的结果。',
  session_busy: '此 DSH 会话正由另一个回合使用，请待当前回合结束后继续。',
  session_timeout: '本次处理超时。可能已有工具执行，请先在 DSH 核对进度再决定是否继续。',
  session_preset_conflict: '当前会话的 Agent 预设与账号设置不一致，请新建会话后继续。',
  missing_host_model: 'DSH 尚未提供可用模型，请在账号设置中选择可用模型。',
  missing_host_permission: '当前 DSH 权限策略不可用，请检查账号权限设置。',
  dsh_attachment_rejected: 'DSH 未接受本条附件，请核对文件格式及模型能力。',
  dsh_attachment_storage_unavailable: 'DSH 附件存储暂不可用，请检查服务状态。',
  attachment_unavailable: '本条附件未能读取，请核对附件是否仍可下载。',
  no_confirmed_final_text: 'DSH 没有提交可确认的最终回复。请先在 DSH 查看执行结果，避免重复操作。',
  shared_turn_not_forwarded: '此回合混入了其他来源的输入，回复保留在 DSH 中，请在那里查看。',
  api_permission_denied: 'Octo 拒绝了此次访问，请检查 Bot 的成员身份和当前频道权限。',
  api_authentication_failed: 'Octo 令牌认证失败，请在账号设置中重新验证令牌。',
  api_disabled: 'Octo 服务端尚未开启此功能，请检查服务配置。',
  api_unavailable: 'Octo 功能服务暂不可用，请先核对服务及已执行操作的状态。',
  api_unsupported: '当前 Octo Bot 类型或服务端不支持此操作。',
  api_rate_limited: 'Octo 暂时限制了请求频率，请先核对处理状态后再继续。',
}
const unknownFailure = '本次回复未完成。请先在 DSH 查看执行状态，再决定是否继续，避免重复操作。'

const jobRoute = job => [job.channel_type, job.channel_id ?? job.sender]
const routeKey = route => JSON.stringify(route)
const messageRoute = message => [message.channelType, message.channelId ?? message.sender]

export class Worker {
  constructor({ api, store, host, config, log, attach, isArchived, proposeWebhookChat }) {
    Object.assign(this, { api, store, host, config, log, attach, isArchived, proposeWebhookChat })
    this.progress = new Progress(api, log)
    this.questions = new QuestionBridge({ api, store, log })
    this.cursor = '0'
    this.steering = new Set()
    this.activeByRoute = new Map()
    this.followups = new Map()
    this.appIntakes = new Map()
    this.ambientChecks = new Set()
    this.stopControls = new Set()
    this.inbox = new InboxRecovery({ api, store, log, config: () => this.config,
      questionKey: message => this.questionsFor(message).match(message, { textOnly: true })?.key,
      accept: (id, message, options) => this.acceptInbound(id, message, options) })
  }

  reconfigure(config, host) {
    this.revokeApproval?.()
    this.oboReview?.abort()
    for (const active of this.activeByRoute.values()) {
      active.revokeApproval?.()
      active.oboReview?.abort()
    }
    this.followups.clear()
    config.ownerUid = this.config.ownerUid
    this.api.configureChannel?.(config)
    this.config = config
    this.host = host
  }

  liveToolAllowed(job, config = this.config) {
    return this.config === config && config.toolPermission !== 'text-only' && authorizedTools(config, job)
      && permitsRoute(config, job.sender, job.channel_type, job.channel_id ?? job.sender)
  }

  async liveToolAccess(job, signal) {
    const config = this.config
    const admission = job.deferredForm ? { ...config, senderPolicy: 'octo' } : config
    if (!this.liveToolAllowed(job, config) || !await this.api.allowsMessage(admission, job, signal)
      || !this.liveToolAllowed(job, config)) throw new Error('octo_access_denied')
    return config
  }

  async deliveryAccess(job, profile, signal, { files = false, command = false, tool = false, mediaProfile } = {}) {
    const current = this.config
    const allowed = () => {
      const live = this.config
      return !this.stopIntake && deliveryProfile(live, job) === profile
        && permitsRoute(live, job.sender, job.channel_type, job.channel_id ?? job.sender)
        && (!job.ambient || live.mentionPolicy === 'octo')
        && (!files || live.allowFiles && live.toolPermission !== 'text-only' && authorizedTools(live, job))
        && (!files || deliveryMediaProfile(live) === mediaProfile)
        && (!command || safeCommand(live, job))
        && (!tool || live.toolPermission !== 'text-only')
    }
    signal.throwIfAborted()
    if (!allowed()) throw new Error('delivery_access_changed')
    // Retain the configured admission model. For Octo-managed access, verify
    // the live friendship/membership again after preparation, not just intake.
    try {
      if ((job.directoryRecovery || job.deferredForm || current.botKind === 'app' || job.ambient || current.senderPolicy === 'octo' || job.channel_type !== 1 && current.channelPolicy === 'joined')
        && !await this.api.allowsMessage(job.deferredForm ? { ...current, senderPolicy: 'octo' } : current, job, signal)) throw new Error('delivery_access_changed')
    } catch (error) {
      if (error instanceof OctoError && ['api_authentication_failed', 'api_permission_denied', 'api_not_found', 'api_disabled']
        .includes(apiErrorCode(error))) throw new Error('delivery_access_changed')
      throw error
    }
    signal.throwIfAborted()
    if (!allowed() || this.config.senderPolicy !== current.senderPolicy
      || this.config.channelPolicy !== current.channelPolicy) throw new Error('delivery_access_changed')
    return true
  }

  pause(stopIntake = false) {
    this.paused = true
    this.stopIntake = stopIntake
    const active = [...this.activeByRoute.values()].map(lane => lane.work)
    return active.length ? Promise.allSettled(active) : this.inFlight
  }

  questionsFor(message) {
    return this.activeByRoute.get(routeKey(messageRoute(message)))?.questions ?? this.questions
  }

  acceptInbound(eventId, message, { historical = false, delayed = false, questionKey, appVerified = false } = {}) {
    if (message.webhookChat) {
      if (this.stopIntake) return false
      const first = this.store.rememberAnswer(eventId, message, null)
      const config = this.config
      const signal = this.intakeSignal
      const allowed = () => !!signal && !signal.aborted && !this.stopIntake && !this.paused && config === this.config
        && config.ownerUid === message.sender && config.groupCommands === 'safe'
        && permitsRoute(config, message.sender, message.channelType, message.channelId)
      if (first && !historical && !delayed && this.proposeWebhookChat && allowed()) {
        const work = Promise.resolve().then(async () => {
          if (!allowed()) return
          const outcome = await this.proposeWebhookChat(message, signal)
          if (outcome?.status === 'pending' && allowed()) {
            await this.api.send(message.channelId, webhookChatReceipt, signal, message.channelType)
          }
        }).catch(() => this.log('webhook_chat_receipt_unconfirmed'))
          .finally(() => this.stopControls.delete(work))
        this.stopControls.add(work)
      }
      return true
    }
    if (message.command === 'stop') {
      if (this.stopIntake) return false
      if (this.store.rememberAnswer(eventId, message, null) && !historical && !delayed) this.handleStop(message)
      return true
    }
    if (this.config.botKind === 'app' && !appVerified) {
      // Persist before the synchronous WS ACK. Serialize live authorization so
      // a question answer or steering input cannot skip the server Space guard.
      if (!channelSequence(message.messageSeq)) return this.store.add(eventId, message)
      const capturedQuestion = questionKey ?? this.questionsFor(message).match(message, { textOnly: true })?.key ?? null
      this.store.stageInbox(eventId, message, !historical, capturedQuestion)
      const config = this.config
      const work = async () => {
        try {
          if (config !== this.config || this.stopIntake) return false
          const allowed = await this.api.allowsMessage(config, { message_id: message.messageId,
            sender: message.sender, channel_id: message.channelId, channel_type: message.channelType }, this.intakeSignal)
          if (config !== this.config || this.stopIntake) return false
          if (allowed) this.acceptInbound(eventId, message, { historical, delayed, questionKey: capturedQuestion, appVerified: true })
          else this.store.rememberAnswer(eventId, message, null)
          this.store.removeStagedInbox(message.messageId)
          return true
        } catch {
          this.log('app_intake_access_unconfirmed')
          this.store.blockInboxRoute({ channel_type: message.channelType, channel_id: message.channelId })
          return false
        }
      }
      const key = routeKey(messageRoute(message))
      const request = (this.appIntakes.get(key) ?? Promise.resolve()).then(work, work).finally(() => {
        if (this.appIntakes.get(key) === request) this.appIntakes.delete(key)
      })
      this.appIntakes.set(key, request)
      return request
    }
    const bridge = this.questionsFor(message)
    const question = !historical && !message.attachment && !message.attachments?.length && !message.command && message.text.trim()
      && bridge.match(message, { textOnly: true })
    if (question && (!delayed && !appVerified || question.key === questionKey) && this.config.toolPermission !== 'text-only'
      && permitsRoute(this.config, message.sender, message.channelType, message.channelId)
      && authorizedTools(this.config, { sender: message.sender, channel_type: message.channelType })) {
      if (this.store.rememberAnswer(eventId, message, question.sessionId)) bridge.text(question, message.text)
      return true
    }
    if (this.stopIntake) return false
    const inserted = this.store.add(eventId, message)
    const key = routeKey(messageRoute(message))
    const lane = this.activeByRoute.get(key)
    const active = lane?.job ?? this.steerActive?.job ?? this.currentJob
    if (inserted.changes && !historical && !delayed && !this.paused && this.config.sendMode === 'steer'
      && !message.command && !message.parts && !message.attachment && !message.attachments?.length && !message.quoteId
      && message.text.trim()) {
      const config = this.config
      const register = () => {
        if (this.config !== config || this.paused || this.stopIntake) return
        const sameTurn = active && active.sender === message.sender && routeKey(jobRoute(active)) === key
          && (!lane || this.activeByRoute.get(key) === lane)
        if (config.transport === 'websocket') {
        // Only locally observed live text can be coalesced. Untracked, delayed
        // and replayed messages remain ordinary durable queue entries.
          if (this.followups.size >= 512) this.followups.delete(this.followups.keys().next().value)
          this.followups.set(message.messageId, { anchor: sameTurn ? active.seq : undefined })
        }
        if (sameTurn) {
          if (!lane && this.steering.size < 32) this.steering.add(message.messageId)
          const state = lane ?? this
          state.oboReview?.abort()
          this.attemptSteering(lane)
        }
      }
      if (!message.ambient) register()
      else if (this.intakeSignal && !this.intakeSignal.aborted && this.ambientChecks.size < 8) {
        // An @-triggered turn does not authorize the next unmentioned message.
        // Until the same ambient gate passes, keep it in the regular queue.
        const signal = AbortSignal.any([this.intakeSignal, AbortSignal.timeout(5000)])
        const check = Promise.resolve().then(async () => {
          const [channel_type, channel_id] = messageRoute(message)
          if (await this.api.allowsMessage(config, { sender: message.sender, channel_type, channel_id, ambient: true,
            message_id: message.messageId }, signal) && !signal.aborted) register()
        }).catch(() => {}).finally(() => this.ambientChecks.delete(check))
        this.ambientChecks.add(check)
      }
    }
    return true
  }

  handleStop(message) {
    const key = routeKey(messageRoute(message))
    const active = this.activeByRoute.get(key), config = this.config
    const request = { sender: message.sender, channel_type: message.channelType, channel_id: message.channelId,
      message_id: message.messageId, ambient: message.ambient }
    const authorized = () => this.config === config && !this.stopIntake && safeCommand(config, request)
      && permitsRoute(config, request.sender, request.channel_type, request.channel_id)
    if (!authorized() || this.stopControls.size >= 16) return
    const budget = AbortSignal.timeout(8000)
    const signal = this.intakeSignal ? AbortSignal.any([budget, this.intakeSignal]) : budget
    const work = (async () => {
      signal.throwIfAborted()
      // App Bots must verify the exact triggering message against the App's
      // Space grant before acting. User Bot controls use the verified sender
      // and can only stop work that already belongs to that same sender.
      if (config.botKind === 'app' && !await this.api.allowsMessage(config, request, signal)) return
      signal.throwIfAborted()
      if (!authorized()) return
      const target = active?.job
      const matching = target && request.sender === target.sender && request.channel_type === target.channel_type
        && request.channel_id === (target.channel_id ?? target.sender)
        && (!message.stopSentAt || message.stopSentAt * 1000 + 999 >= active.startedAt)
        && (!message.messageSeq || !target.message_seq || message.messageSeq > target.message_seq)
      let stopped = false
      if (matching && this.activeByRoute.get(key) === active && !active.controller.signal.aborted
        && this.store.stopWork(target.seq, active.merged)) {
        active.question = active.questions.current?.binding
        active.controller.abort(OCTO_STOP)
        this.log('stopped_by_user')
        stopped = true
      }
      await this.api.send(request.channel_id, stopped
        ? '已请求停止当前任务，后续回复和文件交付将停止。已完成的操作不会撤销。'
        : '当前频道没有可由你停止的正在处理的任务。', signal, request.channel_type)
    })().catch(() => { if (!signal.aborted) this.log('stop_control_unconfirmed') })
    this.stopControls.add(work)
    void work.finally(() => this.stopControls.delete(work))
  }

  sessionRemoved(sessionId) {
    for (const active of this.activeByRoute.values()) {
      if ((active.sessionId ?? active.job.session_id) !== sessionId || active.controller.signal.aborted) continue
      active.deleted = true
      for (const seq of [active.job.seq, ...active.merged]) this.store.discard(seq, 'session_missing', 'review')
      active.controller.abort(OCTO_STOP)
    }
  }

  async drain(signal) {
    const shutdown = new AbortController()
    const lifetime = AbortSignal.any([signal, shutdown.signal])
    let failed = false, failure
    try {
      while (!lifetime.aborted && !failed) {
        const cap = this.config.maxConcurrentTurns ?? 4
        while (!this.paused && !failed && !lifetime.aborted && this.activeByRoute.size < cap) {
          const job = this.store.next(Date.now(), [...this.activeByRoute.values()].map(active => jobRoute(active.job)))
          if (!job) break
          const key = routeKey(jobRoute(job))
          if (this.activeByRoute.has(key)) throw new Error('octo_lane_already_active')
          const active = { job, key, config: this.config, controller: new AbortController(),
            startedAt: Date.now(), terminalSignal: lifetime, merged: [],
            questions: new QuestionBridge({ api: this.api, store: this.store, log: this.log }) }
          this.activeByRoute.set(key, active)
          this.followups.delete(job.message_id)
          active.work = Promise.resolve().then(async () => {
            try { await this.process(job, AbortSignal.any([lifetime, active.controller.signal]), active) }
            catch (error) {
              if (!(active.controller.signal.reason === OCTO_STOP && error === OCTO_STOP) && !lifetime.aborted && !failed) {
                failed = true
                failure = error
              }
            } finally {
              if (active.controller.signal.reason === OCTO_STOP && !active.deleted && !lifetime.aborted) {
                try {
                  if (active.question && await active.authorizeTerminal?.()) {
                    await active.questions.closeCard(active.question, '任务已停止，旧卡片不能继续提交。', lifetime)
                  }
                  await active.progress?.finish('stopped', { interrupted: true, detail: '收到 /stop，已停止本次任务。' })
                } catch { this.log('stop_feedback_unconfirmed') }
              }
              this.activeByRoute.delete(key)
            }
          })
        }
        if (!failed) await delay(150, undefined, { signal: lifetime })
      }
      if (failed) throw failure
    } finally {
      shutdown.abort()
      await Promise.allSettled([...this.activeByRoute.values()].map(active => active.work))
    }
  }

  async ackCardEvent(id, signal) {
    if (!this.store.queueCardAck(id)) return
    signal.throwIfAborted()
    await this.api.ack(id, signal)
    // A failed/ambiguous ACK keeps the durable obligation, never reruns the action.
    this.store.cardAcked(id)
  }

  async flushCardAcks(signal) {
    for (const id of this.store.pendingCardAcks()) await this.ackCardEvent(id, signal)
  }

  async deferredAccess(binding, signal, resume = false) {
    const config = this.config
    const job = { sender: binding.operatorUid, ...binding.route, message_id: binding.messageId, deferredForm: true }
    if (resume && (deliveryProfile(config, job) !== binding.deferred.profile
      || !binding.deferred.model?.policy || this.host.modelProfile?.() !== binding.deferred.model.policy)) throw new Error('deferred_configuration_changed')
    await this.liveToolAccess(job, signal)
    if (config !== this.config) throw new Error('deferred_configuration_changed')
    if (resume && (!this.store.boundSession(binding.deferred.conversation, binding.deferred.sessionId)
      || this.isArchived?.(binding.deferred.sessionId)
      || await this.host.exists?.(binding.deferred.sessionId, signal) === false)) throw new Error('deferred_session_unavailable')
    if (config !== this.config) throw new Error('deferred_configuration_changed')
  }

  async acceptDeferred(binding, selection, signal) {
    const empty = { messageId: 'card_action:' + selection.eventId, sender: selection.operatorUid,
      channelId: selection.route.channel_id, channelType: selection.route.channel_type, text: '' }
    let issue = selection.invalidInputs ? 'invalid' : undefined
    if (!issue) {
      try { await this.deferredAccess(binding, signal, true) }
      catch (error) {
        signal.throwIfAborted()
        // Known loss retires this submission. Transient API failures leave the
        // durable card open and the event unACKed for a later check.
        if (error instanceof OctoError && ![401, 403, 404].includes(error.status)) throw error
        if (error?.code && !['api_permission_denied', 'api_authentication_failed', 'api_not_found',
          'message_unavailable', 'message_outside_channel', 'account_configuration_changed'].includes(error.code)) throw error
        if (!(error instanceof OctoError) && !error?.code && !['octo_access_denied',
          'deferred_configuration_changed', 'deferred_session_unavailable'].includes(error?.message)) throw error
        issue = 'unavailable'
      }
    }
    const recorded = issue ? this.store.rejectDeferredCard(selection, empty, issue, issue === 'invalid'
      ? '本次表单答案格式无效，未触发任务。请重新请求一张表单。'
      : '表单的原会话、账号配置或访问权限已不可用，答案未触发任务。请重新发起。')
      : this.store.claimDeferredCard(selection, deferredMessage(binding, selection))
    if (!recorded) {
      // Cancellation/expiry may win while a live authorization query is in
      // flight. Persist a terminal receipt rather than losing its ACK obligation.
      this.store.expireDeferredCards(Date.now())
      this.store.acknowledgeDeferredEvent(selection, empty)
    }
    await this.ackCardEvent(selection.eventId, signal)
  }

  async deferredFeedback(signal) {
    if (!this.store.deferredFeedback || Date.now() < (this.deferredFeedbackAt ?? 0)) return
    this.deferredFeedbackAt = Date.now() + 30000
    await flushDeferredFeedback({ api: this.api, store: this.store, signal, log: this.log,
      authorize: binding => this.deferredAccess(binding, signal) })
  }

  async ingest(signal, cardsOnly = false) {
    await this.flushCardAcks(signal)
    if (cardsOnly === 'recover') this.store.activateEventRecovery()
    const recovery = cardsOnly === 'recover' ? this.store.eventRecovery() : undefined
    if (recovery) {
      for (const id of this.store.pendingMessageEventAcks()) {
        await this.ackMessageEvent(id, signal)
      }
      if (!this.eventRecoveryStarted) {
        this.cursor = recovery.ready ? '0' : recovery.bootstrapCursor
        this.eventRecoveryStarted = true
        this.eventRescanAt = Date.now() + 60000
        this.eventBootstrapPages = 0
      }
    }
    // Alternate a fixed older prefix with forward pages. A continuously busy
    // tail must not starve late lower IDs, nor should revisits starve that tail.
    if (recovery?.ready && !this.eventRevisit && Date.now() >= this.eventRescanAt) {
      this.eventRevisit = { cursor: '0', upper: this.cursor }
      this.eventRevisitTurn = true
    }
    const revisit = recovery?.ready && this.eventRevisitTurn ? this.eventRevisit : undefined
    if (this.eventRevisit) this.eventRevisitTurn = !revisit
    const events = await this.api.events(signal, revisit?.cursor ?? this.cursor, recovery ? { wait: 0 } : undefined)
    const ordered = events.slice().sort((a, b) => {
      const aa = BigInt(decimalId(a?.event_id) ?? 0), bb = BigInt(decimalId(b?.event_id) ?? 0)
      return aa < bb ? -1 : aa > bb ? 1 : 0
    })
    for (const event of ordered) {
      signal.throwIfAborted()
      const id = decimalId(event?.event_id)
      if (!id) throw new OctoError('invalid_event_id')
      if (revisit && BigInt(id) > BigInt(revisit.upper)) { revisit.cursor = revisit.upper; break }
      if (BigInt(id) <= BigInt(revisit?.cursor ?? this.cursor)) continue
      const action = parseCardAction(event)
      if (action) {
        const binding = this.store.cardBinding(action.messageId) ?? this.store.deferredCard?.(action.messageId)
        const terminalForm = binding?.deferred && (binding.deferred.state !== 'pending' || binding.expiresAt <= Date.now())
        // Terminal forms still recognize their own callbacks for durable ACK,
        // but never dispatch them. Expiry relaxation is ONLY for that receipt.
        const selection = resolveCardAction(event, binding, this.config,
          terminalForm ? Math.min(Date.now(), binding.expiresAt - 1) : Date.now(),
          { reportInvalidInputs: !!binding?.questionKey || !!binding?.deferred })
        if (selection && terminalForm) {
          this.store.expireDeferredCards(Date.now())
          this.store.acknowledgeDeferredEvent(selection, {
            messageId: 'card_action:' + selection.eventId, sender: selection.operatorUid,
            channelId: selection.route.channel_id, channelType: selection.route.channel_type, text: '',
          })
          await this.ackCardEvent(id, signal)
        } else if (selection && binding.deferred) {
          await this.acceptDeferred(binding, selection, signal)
          this.deferredFeedbackAt = 0
        } else if (selection && permitsRoute(this.config, selection.operatorUid, selection.route.channel_type, selection.route.channel_id)) {
          const message = {
            messageId: 'card_action:' + id, sender: selection.operatorUid, channelId: selection.route.channel_id,
            channelType: selection.route.channel_type, text: '', cardAction: { selection: selection.selection,
              ...(this.config.botKind === 'app' && { sourceMessageId: action.messageId }) },
          }
          if (this.config.botKind === 'app' && !await this.api.allowsMessage(this.config, {
            sender: selection.operatorUid, ...selection.route, message_id: action.messageId,
          }, signal)) {
            this.store.rememberAnswer(id, message, null)
            await this.ackCardEvent(id, signal)
            this.cursor = id
            continue
          }
          if (binding.questionKey) {
            const bridge = this.questionsFor(message)
            const pending = bridge.match(message)
            if (pending?.key === binding.questionKey && this.config.toolPermission !== 'text-only'
              && authorizedTools(this.config, { sender: message.sender, channel_type: message.channelType })) {
              if (this.store.claimCard(selection, message, pending.sessionId ?? null)) {
                if (selection.invalidInputs) await bridge.rejectCard(pending)
                else bridge.card(pending, binding.questionKey, selection.selection, selection)
              }
            } else if (this.store.claimCard(selection, message, null)) {
              // A restart or completed wait must visibly retire the old form.
              await this.questions.closeCard(binding, '这次提问的等待已结束，答案未交给 DSH。请重新发起提问。', signal)
            }
          } else this.store.claimCard(selection, message)
          await this.ackCardEvent(id, signal)
        } else if (this.store.hasEvent(id)) await this.ackCardEvent(id, signal)
      } else if (recovery?.ready && !this.stopIntake) {
        const message = admit(event, this.config)
        if (message) {
          // Events only discover a route. Fetch current history before creating
          // work so queued old/edited/revoked bodies cannot bypass recovery.
          // Existing routes retain WS question/steering ownership and their own
          // sequence checkpoints; the event consumer does not inject live text.
          const timestamp = event.message.timestamp
          const known = this.store.inboxRoute(message.channelType, message.channelId)
          if ((!known || known.since_ms > 0 && message.messageSeq <= known.floor_seq
            || known.directory_all === 1 || message.messageSeq <= known.prefix_until_seq)
            && channelSequence(message.messageSeq) && this.inbox.enabled
            && Number.isSafeInteger(timestamp) && timestamp * 1000 > recovery.startedAt
            && timestamp * 1000 <= Date.now() + 300000) {
            this.store.seedInboxEvent(id, message)
          }
          if (this.store.queueMessageEventAck(id, message.messageId)) {
            await this.ackMessageEvent(id, signal)
          }
        }
      } else if (!cardsOnly) {
        const message = admit(event, this.config)
        if (message && !this.stopIntake) this.inbox.receive(id, message)
        await this.api.ack(id, signal)
      }
      // Typed events without this plugin's binding remain owned by their caller.
      // Message event ACKs require a durable inbox/discovery receipt.
      if (revisit) revisit.cursor = id
      else this.cursor = id
      if (recovery && !recovery.ready) this.store.advanceEventBootstrap(id)
    }
    if (recovery) {
      if (!recovery.ready && (!events.length || ++this.eventBootstrapPages >= 20)) {
        // Initialization is bounded even if the queue stays busy. The activation
        // timestamp, never this scan baseline, rejects pre-activation commands.
        this.store.finishEventBootstrap()
        this.cursor = '0'
        this.eventRescanAt = Date.now() + 60000
      } else if (revisit && (!events.length || BigInt(revisit.cursor) >= BigInt(revisit.upper))) {
        this.eventRevisit = undefined
        this.eventRescanAt = Date.now() + 60000
      }
      this.store.eventRecoveryFailed(false)
      if (events.length) await delay(250, undefined, { signal })
    }
  }

  async ackMessageEvent(id, signal) {
    if (!this.store.messageEventAckDue(id)) return
    try {
      await this.api.ack(id, signal)
      this.store.messageEventAcked(id)
    } catch (error) {
      signal.throwIfAborted()
      this.store.messageEventAckFailed(id)
      this.log('octo_message_ack_retry')
    }
  }

  attemptSteering(lane) {
    const state = lane ?? this
    const active = state.steerActive
    if (!active || this.paused || this.config.sendMode !== 'steer' || state.questions.current
      || this.config.sessionProfile !== active.profile
      || lane && (lane.config !== this.config || lane.controller.signal.aborted || this.activeByRoute.get(lane.key) !== lane)
      || !permitsRoute(this.config, active.job.sender, ...jobRoute(active.job))) return
    for (let i = 0; i < 4; i++) {
      const next = this.store.steerCandidate(active.job)
      if (!next || next.sender !== active.job.sender || next.metadata || !next.input
        || !(lane ? this.followups.get(next.message_id)?.anchor === lane.job.seq : this.steering.has(next.message_id))) return
      let reserved = false
      const accepted = active.offer(next.input, () => {
        this.store.running(next.seq, active.sessionId)
        active.merged.push(next.seq)
        this.followups.delete(next.message_id)
        this.steering.delete(next.message_id)
        reserved = true
      })
      if (!reserved || accepted === false) return
    }
  }

  async channelContext(config, route, job, meta, signal) {
    const group = route.channel_type === 2 || route.channel_type === 5
    const before = channelSequence(job.message_seq)
    const source = group ? (route.channel_type === 2 ? '当前群主区' : '当前子区') : '当前私聊'
    if (!group && !meta.quoteId) return
    let members = []
    if (group && this.api.channel?.members) {
      try { members = await this.api.channel.members(route, signal) }
      catch { signal.throwIfAborted(); this.log('channel_members_unavailable') }
    }
    // Only the originating route is ever queried. Never resolve group history
    // from a DM or substitute the parent channel for a topic.
    let result
    if ((before || meta.quoteId) && typeof this.api.recentMessages === 'function') {
      try { result = await this.api.recentMessages(config, { ...route, ...(meta.directoryRecovery ?? {}) }, before, signal, meta.quoteId) }
      catch { signal.throwIfAborted(); this.log('channel_history_unavailable') }
    }
    const quote = meta.quoteId && result?.rows.find(row => row.messageId === meta.quoteId)
    const quotedMessageId = meta.parts?.[0]?.octoQuote?.messageId ?? meta.quoteId
    let rows = group && before ? (result?.rows ?? []).filter(row =>
      row.seq < before && row.messageId !== job.message_id && row.messageId !== quotedMessageId && row.sender !== config.botUid) : []
    rows = rows.slice(-12)
    return {
      source, status: !group ? 'quote-only' : !before ? 'position-unavailable' : !result ? 'unavailable'
        : rows.length ? 'recent-only' : 'empty',
      ...(quote && { quote: octoQuoteFromHistory(quote, members.find(m => m.uid === quote.sender)?.name) }),
      ...(group && { history: rows.map(({ seq, sender, text }) => ({ seq, sender, text,
        ...(members.find(m => m.uid === sender)?.name && { name: members.find(m => m.uid === sender).name }) })),
        members: members.slice(0, 80).map(({ uid, name, robot, role }) => ({ uid, name, robot, role })),
        membersTruncated: members.length > 80, requester: job.sender }),
    }
  }

  async process(job, signal, activeWork) {
    const state = activeWork ?? this
    const bridge = state.questions
    signal.throwIfAborted()
    const sourceConfig = this.config
    const sourceChannel = this.api.channel
    const config = { ...sourceConfig }
    const host = this.host
    const channelType = job.channel_type
    const recipient = job.channel_id ?? job.sender
    let meta = job.metadata ? JSON.parse(job.metadata) : {}
    if (['stop', 'card', 'choose'].includes(meta.command)) {
      this.store.discard(job.seq, 'inactive_command')
      return
    }
    if (meta.directoryRecovery) job = { ...job, directoryRecovery: meta.directoryRecovery }
    if (!permitsRoute(config, job.sender, channelType, recipient)) {
      this.store.review(job.seq, 'route_not_allowed')
      return
    }
    if (job.directoryRecovery || config.botKind === 'app' || job.ambient || config.senderPolicy === 'octo' || (channelType !== 1 && config.channelPolicy === 'joined')) {
      try {
        const allowed = await this.api.allowsMessage(config, job, signal)
        signal.throwIfAborted()
        if (!allowed) {
          this.store.discard(job.seq, 'octo_access_denied')
          return
        }
      } catch (error) {
        if (signal.reason === OCTO_STOP) throw OCTO_STOP
        if (signal.aborted) return
        const issue = 'access_' + (error instanceof OctoError ? error.code : 'internal_error')
        this.store.discard(job.seq, issue, 'review')
        this.log(issue)
        return
      }
    }
    const route = { channel_id: recipient, channel_type: channelType }
    const names = this.api.navigationNames?.(channelType, recipient)
    if (names?.length) {
      try { this.store.rememberNavigationNames(names) } catch { this.log('channel_navigation_names_unavailable') }
    }
    if (meta.deferredForm) job = { ...job, deferredForm: true }
    if (job.state !== 'queued' && (!/^[a-f0-9]{64}$/.test(meta.deliveryProfile ?? '')
      || meta.deliverables?.length && !/^[a-f0-9]{64}$/.test(meta.deliveryMediaProfile ?? ''))) {
      this.store.review(job.seq, 'delivery_profile_unavailable')
      for (const seq of meta.merged ?? []) this.store.review(seq, 'delivery_profile_unavailable')
      this.log('delivery_profile_unavailable')
      return
    }
    const profile = meta.deliveryProfile ?? deliveryProfile(sourceConfig, job)
    const mediaProfile = meta.deliveryMediaProfile ?? deliveryMediaProfile(sourceConfig)
    const authorizeDelivery = (options, active = signal) => this.deliveryAccess(job, profile, active, { ...options, mediaProfile })
    if ((meta.command || meta.cardAction) && !safeCommand(config, job)) {
      this.store.discard(job.seq, 'command_not_allowed')
      return
    }
    if ((meta.attachment || meta.attachments?.length) && !config.allowFiles) {
      this.store.discard(job.seq, 'files_disabled')
      return
    }
    let progress
    let merged = meta.merged ?? []
    if (activeWork) {
      activeWork.merged = merged
      activeWork.authorizeTerminal = () => authorizeDelivery({}, activeWork.terminalSignal)
    }
    if (job.state === 'queued') {
      if (this.api.readReceipt && decimalId(job.message_id)) {
        try { await this.api.readReceipt(route, job.message_id, signal) }
        catch { if (!signal.aborted) this.log('read_receipt_unavailable') }
      }
      let rules
      if (channelType !== 1 && !meta.command && !meta.cardAction) {
        try {
          rules = await this.api.rules(channelType, recipient, config.threadRuleMode, signal)
        } catch (error) {
          if (signal.reason === OCTO_STOP) throw OCTO_STOP
          if (signal.aborted) return // still queued; a clean restart can fetch rules
          const code = error instanceof OctoError ? error.code : 'internal_error'
          this.store.review(job.seq, 'rules_' + code)
          this.log('rules_' + code)
          return
        }
      }
      signal.throwIfAborted()
      // Keep the old mappings in thread-only mode. An inherited thread may
      // retain parent rules in its history, so keep it in a separate session.
      const inheritance = channelType === 5 && config.threadRuleMode === 'inherit-group' ? ['inherit-group'] : []
      const toolsAllowed = authorizedTools(config, job)
      const capability = channelType !== 1 ? ['channel-v1', toolsAllowed ? 'dsh' : 'octo'] : []
      const conversation = config.sessionProfile
        ? JSON.stringify([channelType, recipient, inheritance[0] ?? null, config.sessionProfile, ...capability])
        : channelType === 1 ? job.sender : JSON.stringify([channelType, recipient, ...inheritance, ...capability])
      this.store.running(job.seq)
      let deliverables, card, targetFileAttempted = false
      try {
        let reply
        if (meta.command) {
          if (meta.command === 'new') this.store.session(conversation, config.idleMinutes, Date.now(), true)
          reply = textCommands[meta.command]
        } else if (meta.cardAction) {
          reply = meta.cardAction.selection === 'A' || meta.cardAction.selection === 'B'
            ? '已确认：选项 ' + meta.cardAction.selection + '。' : '已确认。'
        } else {
          progress = this.progress.start(job, config.progress, signal, active => authorizeDelivery({}, active), activeWork?.terminalSignal)
          if (activeWork) activeWork.progress = progress
          const [material, channelContext] = await Promise.all([
            materializeInput(config, meta, signal),
            this.channelContext(config, route, job, meta, signal),
          ])
          const { attachments, order } = material
          const voice = config.allowFiles && config.botKind !== 'app' ? voiceTool(this.api, attachments) : undefined
          if (meta.deferredForm && (meta.deferredForm.profile !== profile || meta.deferredForm.conversation !== conversation
            || !toolsAllowed || !meta.deferredForm.model?.policy
            || host.modelProfile?.() !== meta.deferredForm.model.policy)) throw new Error('deferred_configuration_changed')
          if (meta.deferredForm) await this.liveToolAccess(job, signal)
          let session = meta.deferredForm
            ? this.store.boundSession(conversation, meta.deferredForm.sessionId)
            : this.store.session(conversation, config.idleMinutes)
          if (!session) throw new Error('deferred_session_unavailable')
          if (session.created && await host.exists?.(session.session_id, signal) === false) {
            if (meta.deferredForm) throw new Error('deferred_session_unavailable')
            this.store.forgetSession(session.session_id)
            session = this.store.session(conversation)
          }
          if (this.isArchived?.(session.session_id)) {
            if (meta.deferredForm) throw new Error('deferred_session_unavailable')
            session = this.store.session(conversation, config.idleMinutes, Date.now(), true)
          }
          if (activeWork) activeWork.sessionId = session.session_id
          this.store.running(job.seq, session.session_id)
          const isFileOnly = attachments.length > 0 && !job.input.trim()
          const canMerge = () => !meta.deferredForm && config.transport === 'websocket' && !this.paused && this.config.sendMode === 'steer'
            && this.config === sourceConfig && permitsRoute(this.config, job.sender, channelType, recipient)
          const nextSupplement = () => {
            // Collect only adjacent same-sender jobs at startup. Text sent
            // while a file-only turn is downloading can guide that turn.
            const head = activeWork ? this.store.followupHead(job) : this.store.steerCandidate(job)
            if (!activeWork) return head && this.steering.has(head.message_id) ? head : undefined
            if (head?.state === 'queued' && head.sender === job.sender && this.followups.has(head.message_id)) return head
            if (!isFileOnly) return
            const next = this.store.steerCandidate(job)
            if (next && this.followups.get(next.message_id)?.anchor === activeWork.job.seq) return next
          }
          // A file sent without a caption is often followed by its instructions
          // in a separate message. Give that text a short chance to join.
          if (isFileOnly && canMerge() && !nextSupplement()) await delay(1000, undefined, { signal })
          const instructions = []
          if (canMerge()) {
            for (let i = 0; i < 4; i++) {
              const next = nextSupplement()
              if (!next || next.sender !== job.sender || next.metadata || !next.input) break
              this.store.running(next.seq, session.session_id)
              this.steering.delete(next.message_id)
              this.followups.delete(next.message_id)
              merged.push(next.seq)
              instructions.push(next.input)
            }
          }
          const supplement = instructions.length ? '\n\n【同一用户补充的要求】\n' + instructions.join('\n') : ''
          const input = job.input + supplement
          const inputOrder = supplement ? [
            ...(order ?? [...(job.input.trim() ? [{ text: job.input }] : []), ...attachments.map((_, media) => ({ media }))]),
            { text: supplement },
          ] : order
          const authorCard = safeCommand(config, job) && !attachments.length
            && /卡片|\bcard\b/iu.test(input)
          const availableOperation = spec => operationAvailable(spec, { config, job, channel: sourceChannel, toolsAllowed })
          const oboActive = () => !signal.aborted && !this.stopIntake
            && (activeWork ? this.activeByRoute.get(activeWork.key) === activeWork : this.currentJob === job)
            && this.config === sourceConfig && this.api.channel === sourceChannel
            && this.liveToolAllowed(job, sourceConfig) && this.config.toolPermission !== 'read-only'
          const oboSend = channelType === 1 && !meta.deferredForm && config.botKind !== 'app'
            && config.ownerUid === job.sender && toolsAllowed && config.toolPermission !== 'read-only'
            && config.toolPermission !== 'text-only' && config.channelPolicy === 'allowlist'
            && (config.groups?.size || config.threads?.size) && config.oboSendContract === OBO_SEND_CONTRACT
            && decimalId(job.message_id) && channelSequence(job.message_seq)
            && this.api.createOboSender?.({ config: sourceConfig, origin: { ...job, ...route }, signal,
              verifiedContract: config.oboSendContract, isActive: oboActive,
              authorize: async active => {
                await this.liveToolAccess(job, active)
                await authorizeDelivery({ tool: true }, active)
                return !active.aborted && oboActive()
              },
              confirm: async (review, active) => {
                if (!oboActive()) throw new Error('octo_access_denied')
                const controller = new AbortController()
                state.oboReview = controller
                try {
                  const answer = await bridge.form({
                    title: '确认以你的 Octo 身份发送',
                    text: ['发送者：' + review.operatorUid, '目标（频道类型 / ID）：' + review.destination.channel_type
                      + ' / ' + review.destination.channel_id, '消息原文（JSON 字符串）：', JSON.stringify(review.text)].join('\n'),
                    inputs: [{ id: 'confirm', kind: 'toggle', label: '我已核对发送者、目标和完整正文', required: true }],
                    actions: [{ id: 'allow', label: '确认代发' }, { id: 'cancel', label: '取消' }],
                  }, { ...job, session_id: session.session_id }, sourceConfig, AbortSignal.any([active, controller.signal]),
                  waiting => progress.trace({ kind: waiting ? 'question-open' : 'question-closed' }), oboActive, { cardOnly: true })
                  const decision = answer.action === 'allow' && answer.values?.confirm === true ? 'allow' : 'cancel'
                  return { id: review.id, operatorUid: review.operatorUid, decision }
                } finally { if (state.oboReview === controller) state.oboReview = undefined }
              } })
          const run = async () => {
            if (job.directoryRecovery) await authorizeDelivery()
            // A topic mode change can occur while rules or attachments are
            // being fetched. Never send a now-disabled parent rule to DSH.
            if (rules && channelType === 5 && this.config.threadRuleMode !== config.threadRuleMode) {
              throw new Error('delivery_access_changed')
            }
            return host.run(session, input, async () => {
            if (!meta.deferredForm && this.store.sessionCreated(conversation, session.session_id) === false) {
              throw new Error('session_missing')
            }
            await this.attach?.(session.session_id, config.cwd)
          }, signal, rules,
            phase => {
              if (phase === 'reused') this.log('dsh_session_reused')
              else progress.stage(phase)
              if (phase === 'running') queueMicrotask(() => this.attemptSteering(activeWork))
            }, config.timeoutMs, toolsAllowed,
            { attachments, order: inputOrder, authorCard, channelContext, taskContext: true, onTrace: trace => progress.trace(trace),
              ...((channelType !== 1 || toolsAllowed) && config.toolPermission !== 'text-only' && this.api.channel && { channelTools: {
                specs: [...operationSpecs.filter(availableOperation).map(spec => ({
                  name: 'octo_' + spec.name.replaceAll('.', '_'), description: spec.description, parameters: spec.parameters,
                })),
                  displayCardSpec, ...(voice ? [voice.spec] : []), ...(toolsAllowed ? [formToolSpec, ...deferredFormSpecs] : []),
                  ...(oboSend ? [OBO_SEND_TOOL] : [])],
                waitNames: toolsAllowed ? [formToolSpec.name, ...(oboSend ? [OBO_SEND_TOOL.name] : [])] : [],
                execute: (name, args, toolSignal, model) => {
                  if (name === OBO_SEND_TOOL.name && oboSend) return oboSend(args, toolSignal).then(result => {
                    const receipt = decimalId(result.message_id)
                    if (receipt) this.store.recordDelivery(job.seq, receipt)
                    return result
                  })
                  if (name === 'octo_form_publish') {
                    const detached = structuredClone(args)
                    const publish = () => publishDeferredForm({ config: sourceConfig, store: this.store, job,
                      session, conversation, profile, model, args: detached, signal: toolSignal,
                      authorize: async () => {
                        await this.liveToolAccess(job, toolSignal)
                        await authorizeDelivery({ tool: true }, toolSignal)
                        if (host.modelProfile?.() !== model?.policy) throw new Error('deferred_configuration_changed')
                      } })
                    const result = (this.deferredPublishing ?? Promise.resolve()).then(publish, publish)
                    this.deferredPublishing = result.catch(() => {})
                    return result
                  }
                  if (name === 'octo_form_manage') return manageDeferredForm({ store: this.store, job,
                    args: structuredClone(args), authorize: () => this.liveToolAccess(job, toolSignal) })
                  if (name === formToolSpec.name) return (async () => {
                    const current = await this.liveToolAccess(job, toolSignal)
                    const answer = await bridge.form(args, { ...job, session_id: session.session_id }, current, toolSignal,
                      waiting => progress.trace({ kind: waiting ? 'question-open' : 'question-closed' }), () => this.liveToolAllowed(job, current))
                    await this.liveToolAccess(job, toolSignal)
                    return answer
                  })()
                  if (name === voice?.spec.name) return (async () => {
                    if (!this.config.allowFiles || this.config.toolPermission === 'text-only'
                      || !await this.api.allowsMessage(this.config, job, toolSignal)) throw new Error('octo_access_denied')
                    return voice.execute(args, toolSignal)
                  })()
                  if (name === displayCardSpec.name) return (async () => {
                    const receipt = await sendDisplayCard({ api: this.api, route, args, signal: toolSignal,
                      authorize: active => authorizeDelivery({ tool: true }, active) })
                    this.store.recordDelivery(job.seq, receipt.messageId)
                    return receipt
                  })()
                  const operation = operationSpecs.find(spec => 'octo_' + spec.name.replaceAll('.', '_') === name)
                  if (!availableOperation(operation)) throw new Error('octo_operation_unavailable')
                  return (async () => {
                    const allowed = () => this.config === sourceConfig && this.api.channel === sourceChannel
                      && this.config.toolPermission !== 'text-only'
                      && (this.config.toolPermission !== 'read-only' || !operation.mutating)
                      && (!(operation.privateOnly || operation.requiresHostTools) || this.liveToolAllowed(job, sourceConfig))
                      && (!operation.requiresFiles || this.config.allowFiles && this.liveToolAllowed(job, sourceConfig))
                      && permitsRoute(this.config, job.sender, channelType, recipient)
                    const check = async () => {
                      toolSignal?.throwIfAborted()
                      if (!allowed() || !await this.api.allowsMessage(sourceConfig, job, toolSignal) || !allowed()) {
                        throw new Error('octo_access_denied')
                      }
                    }
                    await check()
                    const runtime = {
                      ...(operation.sharedTopicSend && channelType !== 1 && { authorizeSharedSend: () => !toolSignal?.aborted && allowed() }),
                      ...(operation.name.startsWith('cards.registry.') && {
                        registryActive: () => !toolSignal?.aborted && allowed(),
                        authorizeRegistry: async active => !active.aborted && allowed()
                          && await this.api.allowsMessage(sourceConfig, job, active) && !active.aborted && allowed(),
                      }),
                      ...(operation.name === 'messages.send_richtext' && {
                        richtextActive: () => !toolSignal?.aborted && allowed(),
                        authorizeRichtext: async active => !active.aborted && allowed()
                          && await this.api.allowsMessage(sourceConfig, job, active) && !active.aborted && allowed(),
                      }),
                      ...(operation.requiresFiles && { prepareFile: async (path, authorize, mediaSignal) => {
                      await check()
                      const file = await readDeliverable(config.cwd, path, mediaSignal)
                      return prepareAttachment(config, file, mediaSignal, { authorize: async () => {
                        await check()
                        await authorize()
                        mediaSignal.throwIfAborted()
                        if (!allowed()) throw new Error('octo_access_denied')
                      } })
                    } }) }
                    // A failed/uncertain target tool already supplies a specific
                    // result to DSH. Do not replace its final explanation with
                    // the unrelated "present was not called" heuristic.
                    if (operation.requiresFiles) targetFileAttempted = true
                    const result = await sourceChannel.dispatch(route, job.sender, operation.name, args, toolSignal, runtime)
                    const acknowledgedTarget = (operation.name.startsWith('messages.send_target')
                      || operation.name === 'cards.registry.send' || operation.name === 'messages.send_richtext')
                      && decimalId(result?.message_id)
                    if (acknowledgedTarget) {
                      // Preserve mutation evidence before a later admission
                      // check can throw. A completed send cannot be undone by
                      // withholding the result of a subsequent read.
                      this.store.recordDelivery(job.seq, acknowledgedTarget)
                      if (operation.requiresFiles) progress.trace({ kind: 'file-sent' })
                    }
                    // Do not leak in-flight reads from an account configuration
                    // that changed while the server was answering the request.
                    try { await check() } catch (error) {
                      if (!acknowledgedTarget) throw error
                      // Only return evidence of this mutation, with no stale
                      // channel names, caption text, URLs or member metadata.
                      // Scope disposal/config changes can still revoke the
                      // host adapter; the durable receipt remains available.
                      return { ok: false, message_id: acknowledgedTarget, delivery_confirmed: true, access_changed: true,
                        partial: result.partial === true, retry_whole_delivery: false, requiresFinalSummary: true,
                        ...(operation.requiresFiles && { caption_status: result.caption_message_id ? 'confirmed'
                          : result.caption_status === 'unconfirmed' ? 'unconfirmed'
                            : result.caption_status === 'not_sent' ? 'not_sent' : 'not_requested' }) }
                    }
                    return result
                  })()
                }, guidance: mentionGuidance,
              } }),
              ...(toolsAllowed && { approval: { runId: String(job.seq), requester: job.sender },
                authorizeTools: () => this.liveToolAllowed(job, sourceConfig),
                onApprovalControl: revoke => { state.revokeApproval = revoke },
                onQuestion: async (questions, askSignal) => {
                const current = await this.liveToolAccess(job, askSignal)
                const answer = await bridge.ask(questions, { ...job, session_id: session.session_id }, current, askSignal,
                  waiting => progress.trace({ kind: waiting ? 'question-open' : 'question-closed' }), () => this.liveToolAllowed(job, current))
                await this.liveToolAccess(job, askSignal)
                return answer
              } }),
              ...(meta.deferredForm && { expectedModel: meta.deferredForm.model }),
              ...(toolsAllowed && config.allowFiles && { onDeliverables: files => { deliverables = files } }),
              ...(!meta.deferredForm && config.transport === 'websocket'
                && { onSteer: offer => { state.steerActive = offer ? { job, offer, merged, sessionId: session.session_id, profile: config.sessionProfile } : undefined } }) })
          }
          try { reply = await run() }
          catch (error) {
            // The native session can be deleted between stat and resume. Only
            // this explicit pre-run failure permits creating a new session.
            if (error?.message !== 'session_missing') throw error
            if (meta.deferredForm) throw new Error('deferred_session_unavailable')
            this.store.forgetSession(session.session_id)
            session = this.store.session(conversation)
            if (activeWork) activeWork.sessionId = session.session_id
            for (const seq of [job.seq, ...merged]) this.store.running(seq, session.session_id)
            reply = await run()
          }
          await authorizeDelivery()
          if (asksForFile(input) && !deliverables?.length && !targetFileAttempted) {
            const issue = !config.allowFiles ? 'files_disabled' : !toolsAllowed || config.toolPermission === 'text-only'
              ? 'file_tools_unavailable' : 'file_not_presented'
            this.store.review(job.seq, issue)
            for (const seq of merged) this.store.review(seq, issue)
            this.log(issue)
            const explanation = issue === 'files_disabled' ? '此账号尚未启用附件。'
              : issue === 'file_tools_unavailable' ? '本次会话没有工作区工具权限。请检查账号的工具使用范围和权限策略。'
                : 'DSH 没有交付可发送的文件。'
            const notified = await progress.finish('error', { detail: explanation })
            if (!notified && !signal.aborted) {
              try {
                await authorizeDelivery()
                await this.api.send(recipient, '文件未发送：' + explanation, signal, channelType)
              }
              catch { if (!signal.aborted) this.log('failure_notice_not_confirmed') }
            }
            return
          }
          if (authorCard) {
            card = authoredCard(reply)
            if (card) reply = card.fallback
          }
        }
        const bounded = boundedMarkdown(reply)
        if (!bounded) throw new Error('empty_reply')
        meta = meta.command || meta.cardAction ? meta : {
          ...(meta.deferredForm && { deferredForm: meta.deferredForm }),
          ...(meta.directoryRecovery && { directoryRecovery: meta.directoryRecovery }),
          ...(deliverables?.length && { deliverables }), ...(merged.length && { merged }), ...(card && { displayCard: card.form }),
        }
        meta.deliveryProfile = profile
        if (meta.deliverables?.length) meta.deliveryMediaProfile = mediaProfile
        this.store.ready(job.seq, bounded, meta)
        job = { ...job, reply: bounded }
      } catch (error) {
        if (signal.reason === OCTO_STOP) throw OCTO_STOP
        const code = error instanceof OctoError ? (error.status ? apiErrorCode(error) : error.code) : hostIssues.has(error?.message) ? error.message
          : error?.name === 'SessionAlreadyOwnedError' ? 'session_busy' : 'agent_run_not_confirmed'
        this.store.review(job.seq, code)
        for (const seq of merged) this.store.review(seq, code)
        this.log(code)
        const detail = failureDetails[code] ?? unknownFailure
        const notified = await progress?.finish('error', { detail })
        if (!signal.aborted && !notified && !job.ambient && config.progress !== undefined) {
          try {
            await authorizeDelivery()
            await this.api.send(recipient, 'DSH 已收到消息。' + detail, signal, channelType)
          }
          catch { if (!signal.aborted) this.log('failure_notice_not_confirmed') }
        }
        return
      }
    }
    signal.throwIfAborted()
    this.store.sending(job.seq)
    progress?.stage('delivering')
    let confirmed = false
    let members = []
    if (channelType !== 1 && this.api.channel?.members) {
      try { members = await this.api.channel.members(route, signal) }
      catch { signal.throwIfAborted(); this.log('channel_members_unavailable') }
    }
    const replyTo = channelType !== 1 && decimalId(job.message_id) && channelSequence(job.message_seq) && job.input.trim()
      ? { message_id: job.message_id, message_seq: job.message_seq, from_uid: job.sender,
        from_name: members.find(member => member.uid === job.sender)?.name || '群成员',
        payload: { type: 1, content: Array.from(job.input).slice(0, 160).join('') } } : undefined
    const markMedia = (id, count = 1) => {
      confirmed = true
      this.store.recordDelivery(job.seq, id)
      for (let i = 0; i < count; i++) progress?.trace({ kind: 'file-sent' })
    }
    try {
      await authorizeDelivery({ files: !!meta.deliverables?.length, command: !!meta.command || !!meta.cardAction })
      const images = []
      if (meta.deliverables?.length) {
        if (!config.allowFiles || !authorizedTools(config, job) || config.toolPermission === 'text-only') throw new Error('files_not_authorized')
        for (const path of meta.deliverables) {
          await authorizeDelivery({ files: true })
          const file = await readDeliverable(config.cwd, isAbsolute(path) ? relative(config.cwd, path) : path, signal)
          if (typeof this.api.sendPayload !== 'function') {
            markMedia(await uploadAttachment(config, route, file, signal, { authorize: () => authorizeDelivery({ files: true }) }))
            continue
          }
          const payload = await prepareAttachment(config, file, signal, { authorize: () => authorizeDelivery({ files: true }) })
          if (!meta.displayCard && payload.type === 2 && payload.width > 0 && payload.height > 0) images.push(payload)
          else {
            await authorizeDelivery({ files: true })
            markMedia(await this.api.sendPayload(route, payload, signal, replyTo))
          }
        }
      }
      let resultId
      if (meta.displayCard && safeCommand(config, job)) {
        try {
          const result = await sendCard(config, { ...route, operatorUid: job.sender }, meta.displayCard, signal,
            () => !this.stopIntake && safeCommand(this.config, job), () => authorizeDelivery({ command: true, files: !!meta.deliverables?.length }))
          resultId = result.messageId
          confirmed = true
          this.store.recordDelivery(job.seq, resultId)
          if (result.binding) this.store.bindCard(result.binding)
        } catch (error) {
          if (!(error instanceof OctoError) || error.code !== 'card_profile_unavailable') throw error
        }
      }
      if (!resultId) {
        const chunks = textSegments(job.reply)
        if (images.length && chunks.length && !hasMarkdown(job.reply) && !job.reply.includes('@[')) {
          const payload = { type: 14, content: [{ type: 'text', text: chunks[0] },
            ...images.map(({ url, width, height }) => ({ type: 'image', url, width, height }))] }
          if (Buffer.byteLength(JSON.stringify(payload)) <= 48 * 1024) {
            try {
              await authorizeDelivery({ files: true })
              resultId = await this.api.sendPayload(route, payload, signal, replyTo)
              chunks.shift()
              markMedia(resultId, images.length)
              images.length = 0
            } catch (error) {
              // A definitive unsupported/invalid response can downgrade to native
              // images without re-uploading. An ambiguous response is never replayed.
              if (!(error instanceof OctoError) || !(error.status === 400
                ? apiErrorCode(error) === 'api_invalid_request' : [415, 422].includes(error.status))) throw error
            }
          }
        }
        for (const image of images) {
          await authorizeDelivery({ files: true })
          markMedia(await this.api.sendPayload(route, image, signal, replyTo))
        }
        for (const chunk of chunks) {
          const outbound = finalMentions(chunk, members)
          await authorizeDelivery({ files: !!meta.deliverables?.length, command: !!meta.command || !!meta.cardAction })
          const delivered = await this.api.send(recipient, outbound.text, signal, channelType, replyTo, outbound.mention)
          confirmed = true
          resultId ??= delivered
          if (signal.aborted || chunks.length > 1 || meta.deliverables?.length) this.store.recordDelivery(job.seq, delivered)
        }
      }
      signal.throwIfAborted()
      this.store.sent(job.seq, resultId, merged)
      await progress?.finish('completed')
    } catch (error) {
      if (signal.reason === OCTO_STOP) throw OCTO_STOP
      // Do not replay a text/card or any already sent file if delivery failed mid-batch.
      if (!confirmed && !meta.deliverables?.length && !merged.length && error instanceof OctoError && error.status === 429 && job.attempts < 3) {
        this.store.retry(job.seq, Date.now() + Math.max(error.retryAfterMs, 3000 * (2 ** job.attempts)))
      } else {
        const issue = error?.message === 'delivery_access_changed' ? 'delivery_access_changed'
          : meta.deliverables?.length ? 'file_delivery_not_confirmed' : confirmed ? 'partial_delivery' : 'delivery_not_confirmed'
        this.store.review(job.seq, issue)
        for (const seq of merged) this.store.review(seq, issue)
        this.log(issue)
      }
      await progress?.finish('stopped', error?.message === 'delivery_access_changed'
        ? { detail: '账号设置或频道权限已变更，剩余交付已停止' }
        : meta.deliverables?.length ? { detail: '文件或正文尚未确认全部送达' } : undefined)
    }
  }

  async run(signal) {
    const identity = await this.api.verify(this.config.botUid, this.config.spaceId, signal)
    this.config.ownerUid = identity?.ownerUid
    // Accounts creates OctoClient from a connection config copy. Refresh its
    // scoped API only AFTER identity verification, and remove any stale owner.
    this.api.configureChannel?.(this.config)
    this.log('bot_verified')
    await this.questions.closeInterrupted(signal)
    if (this.config.transport === 'websocket') return this.runRealtime(signal)
    const stop = new AbortController()
    const lifetime = AbortSignal.any([signal, stop.signal])
    this.intakeSignal = lifetime
    this.inbox.connection(false)
    this.inbox.connection(true)
    const draining = this.drain(lifetime)
    const receiving = this.poll(lifetime)
    const recovery = this.inbox.run(lifetime)
    try { await Promise.all([receiving, draining, recovery]) }
    finally {
      stop.abort()
      await Promise.allSettled([receiving, draining, recovery, ...this.stopControls, ...this.appIntakes.values(), ...this.ambientChecks])
    }
  }

  async poll(signal) {
    let failures = 0
    while (!signal.aborted) {
      try {
        await this.deferredFeedback(signal)
        await this.ingest(signal)
        if (failures || !this.pollReady) this.log('octo_poll_ok')
        this.pollReady = true
        failures = 0
      } catch (error) {
        if (signal.aborted) return
        if (!(error instanceof OctoError) || [401, 403].includes(error.status)) throw error
        failures++
        this.log('octo_poll_' + error.code)
        await delay(Math.max(error.retryAfterMs, Math.min(30_000, 1000 * (2 ** Math.min(5, failures)))), undefined, { signal })
      }
    }
  }

  async pollCardEvents(signal) {
    let failures = 0
    while (!signal.aborted) {
      try {
        await this.deferredFeedback(signal)
        const late = Date.now() >= (this.lateCardPollAt ?? 0) && this.store.hasDeferredCards?.()
        const recover = this.config.botKind !== 'app' && typeof this.api.events === 'function'
          && this.inbox.enabled && typeof this.store.eventRecovery === 'function'
        if (recover) await this.ingest(signal, 'recover')
        else if (this.store.hasOpenCard() || late) {
          this.lateCardPollAt = Date.now() + 30000
          await this.ingest(signal, true)
        }
        else {
          // The last claim closes its form before ACK. Retry by exact receipt ID
          // even with no forms left, after expiry, or in a newly started worker.
          await this.flushCardAcks(signal)
          await delay(500, undefined, { signal })
        }
        failures = 0
      } catch (error) {
        if (signal.aborted) return
        if (this.config.botKind !== 'app') this.store.eventRecoveryFailed?.(true)
        this.log('card_action_poll_failed')
        await delay(Math.max(error?.retryAfterMs ?? 0, Math.min(30_000, 1000 * 2 ** Math.min(5, ++failures))), undefined, { signal })
      }
    }
  }

  async runRealtime(lifetime) {
    const stop = new AbortController()
    const signal = AbortSignal.any([lifetime, stop.signal])
    this.intakeSignal = signal
    if (this.config.botKind !== 'app' && this.inbox.enabled) this.store.activateEventRecovery?.()
    const discovery = new DirectoryDiscovery({ api: this.api, store: this.store, config: () => this.config,
      online: () => this.inbox.online, paused: () => this.stopIntake, log: this.log }).run(signal)
    const accept = m => {
      signal.throwIfAborted()
      const candidate = admit({ message: {
        message_id: m.messageId, message_seq: m.messageSeq, from_uid: m.fromUid, channel_type: m.channelType,
        channel_id: m.channelId, timestamp: m.timestamp, payload: m.payload,
      } }, this.config)
      if (candidate && !this.stopIntake) this.inbox.receive('ws:' + candidate.messageId, candidate)
      // WukongConnection sends RECVACK only after this function returns.
    }
    const receiving = receiveRealtime({ api: this.api, botUid: this.config.botUid, accept, signal, log: this.log,
      connection: online => this.inbox.connection(online) })
    const draining = this.drain(signal)
    const cardEvents = this.pollCardEvents(signal)
    const recovery = this.inbox.run(signal)
    try {
      await Promise.all([receiving, draining, cardEvents, recovery, discovery])
    } finally {
      stop.abort()
      await Promise.allSettled([receiving, draining, cardEvents, recovery, discovery, ...this.stopControls])
      await Promise.allSettled([...this.appIntakes.values(), ...this.ambientChecks])
    }
  }
}
