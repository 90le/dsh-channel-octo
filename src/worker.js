import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute, relative } from 'node:path'
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
import { InboxRecovery } from './inbox.js'

const safeCommand = (config, job) => (job.channel_type === 1
  ? config.dmCommands === 'safe' && (job.sender === config.ownerUid || config.allowed.has(job.sender))
  : config.groupCommands === 'safe' && job.sender === config.ownerUid && !job.ambient)
// Chat admission is separate from tools. Owner identity comes only from verify-bot.
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
    Number.isInteger(part.media) ? (indices.has(part.media) ? { media: indices.get(part.media) } : unavailable) : part) }
}
const cardForm = command => command === 'card'
  ? { title: 'DSH · Octo', text: '这是 Octo 展示卡片。输入 /choose 可以试用带按钮的交互卡片。' }
  : { title: '请选择一个选项', text: '这个选择只在当前会话内确认。', actions: [{ id: 'confirm', label: '确认选择' }],
    choice: { id: 'selection', label: '选项', options: [{ title: '选项 A', value: 'A' }, { title: '选项 B', value: 'B' }] } }
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
  help: '可用命令：/help 帮助、/status 当前会话状态、/new 新会话、/card 展示卡片、/choose 交互卡片。',
  status: 'DSH 已收到这条消息，当前会话可以正常处理消息。',
  new: '已开启新会话，旧会话记录仍可在 DSH 查看。',
}


const hostIssues = new Set(['session_busy', 'session_timeout', 'session_preset_conflict',
  'missing_host_model', 'shared_turn_not_forwarded', 'prompt_discarded', 'no_confirmed_final_text',
  'session_missing', 'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context',
  'missing_scoped_tool_controls', 'missing_host_permission', 'session_requires_owned_writer', 'dsh_attachment_rejected', 'dsh_attachment_storage_unavailable'])

const failureDetails = {
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

export class Worker {
  constructor({ api, store, host, config, log, attach, isArchived }) {
    Object.assign(this, { api, store, host, config, log, attach, isArchived })
    this.progress = new Progress(api, log)
    this.questions = new QuestionBridge({ api, store, log })
    this.cursor = '0'
    this.steering = new Set()
    this.inbox = new InboxRecovery({ api, store, log, config: () => this.config,
      questionKey: message => this.questions.match(message)?.key,
      accept: (id, message, options) => this.acceptInbound(id, message, options) })
  }

  reconfigure(config, host) {
    this.revokeApproval?.()
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
    if (!this.liveToolAllowed(job, config) || !await this.api.allowsMessage(config, job, signal)
      || !this.liveToolAllowed(job, config)) throw new Error('octo_access_denied')
    return config
  }

  pause(stopIntake = false) {
    this.paused = true
    this.stopIntake = stopIntake
    return this.inFlight
  }

  acceptInbound(eventId, message, { historical = false, delayed = false, questionKey } = {}) {
    const question = !historical && !message.attachment && !message.attachments?.length && !message.command && message.text.trim() && this.questions.match(message)
    if (question && (!delayed || question.key === questionKey) && this.config.toolPermission !== 'text-only'
      && permitsRoute(this.config, message.sender, message.channelType, message.channelId)
      && authorizedTools(this.config, { sender: message.sender, channel_type: message.channelType })) {
      if (this.store.rememberAnswer(eventId, message, question.sessionId)) this.questions.text(question, message.text)
      return true
    }
    if (this.stopIntake) return false
    const inserted = this.store.add(eventId, message)
    const active = this.steerActive?.job ?? this.currentJob
    if (inserted.changes && !historical && !delayed && !this.paused && active && this.config.sendMode === 'steer'
      && message.channelType === active.channel_type && message.sender === active.sender
      && message.channelId === (active.channel_id ?? active.sender)
      && !message.command && !message.parts && !message.attachment && !message.attachments?.length
      && message.text.trim() && this.steering.size < 32) {
      this.steering.add(message.messageId)
      this.attemptSteering()
    }
    return true
  }

  async drain(signal) {
    while (!signal.aborted) {
      const job = !this.paused && this.store.next(Date.now())
      if (!job) { await delay(150, undefined, { signal }); continue }
      this.currentJob = job
      const work = this.process(job, signal)
      this.inFlight = work
      try { await work } finally {
        this.currentJob = undefined
        this.steering.clear()
        if (this.inFlight === work) this.inFlight = undefined
      }
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

  async ingest(signal, cardsOnly = false) {
    await this.flushCardAcks(signal)
    const events = await this.api.events(signal, this.cursor)
    const ordered = events.slice().sort((a, b) => {
      const aa = BigInt(decimalId(a?.event_id) ?? 0), bb = BigInt(decimalId(b?.event_id) ?? 0)
      return aa < bb ? -1 : aa > bb ? 1 : 0
    })
    for (const event of ordered) {
      signal.throwIfAborted()
      const id = decimalId(event?.event_id)
      if (!id) throw new OctoError('invalid_event_id')
      if (BigInt(id) <= BigInt(this.cursor)) continue
      const action = parseCardAction(event)
      if (action) {
        const binding = this.store.cardBinding(action.messageId)
        const selection = resolveCardAction(event, binding, this.config, Date.now(), { reportInvalidInputs: !!binding?.questionKey })
        if (selection && permitsRoute(this.config, selection.operatorUid, selection.route.channel_type, selection.route.channel_id)) {
          const message = {
            messageId: 'card_action:' + id, sender: selection.operatorUid, channelId: selection.route.channel_id,
            channelType: selection.route.channel_type, text: '', cardAction: { selection: selection.selection },
          }
          if (binding.questionKey) {
            const pending = this.questions.match(message)
            if (pending?.key === binding.questionKey && this.config.toolPermission !== 'text-only'
              && authorizedTools(this.config, { sender: message.sender, channel_type: message.channelType })) {
              if (this.store.claimCard(selection, message, pending.sessionId ?? null)) {
                if (selection.invalidInputs) await this.questions.rejectCard(pending)
                else this.questions.card(pending, binding.questionKey, selection.selection, selection)
              }
            } else if (this.store.claimCard(selection, message, null)) {
              // A restart or completed wait must visibly retire the old form.
              await this.questions.closeCard(binding, '这次提问的等待已结束，答案未交给 DSH。请重新发起提问。', signal)
            }
          } else this.store.claimCard(selection, message)
          await this.ackCardEvent(id, signal)
        } else if (this.store.hasEvent(id)) await this.ackCardEvent(id, signal)
      } else if (!cardsOnly) {
        const message = admit(event, this.config)
        if (message && !this.stopIntake) this.inbox.receive(id, message)
        await this.api.ack(id, signal)
      }
      // In WebSocket mode this poll consumes only this plugin's own card actions.
      // Never backfill old chat messages or ACK events owned by another integration.
      this.cursor = id
    }
  }

  attemptSteering() {
    const active = this.steerActive
    if (!active || this.config.sendMode !== 'steer' || this.questions.current
      || this.config.sessionProfile !== active.profile
      || !authorizedTools(this.config, active.job)) return
    const next = this.store.steerCandidate(active.job)
    if (!next || !this.steering.has(next.message_id) || next.sender !== active.job.sender || next.metadata || !next.input) return
    active.offer(next.input, () => {
      this.store.running(next.seq, active.sessionId)
      active.merged.push(next.seq)
      this.steering.delete(next.message_id)
    })
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
      try { result = await this.api.recentMessages(config, route, before, signal) }
      catch { signal.throwIfAborted(); this.log('channel_history_unavailable') }
    }
    const quote = meta.quoteId && result?.rows.find(row => row.messageId === meta.quoteId)
    let rows = group && before ? (result?.rows ?? []).filter(row =>
      row.seq < before && row.messageId !== job.message_id && row.messageId !== meta.quoteId && row.sender !== config.botUid) : []
    rows = rows.slice(-12)
    return {
      source, status: !group ? 'quote-only' : !before ? 'position-unavailable' : !result ? 'unavailable'
        : rows.length ? 'recent-only' : 'empty',
      ...(quote && { quote: { sender: quote.sender, text: quote.text,
        ...(members.find(m => m.uid === quote.sender)?.name && { name: members.find(m => m.uid === quote.sender).name }) } }),
      ...(group && { history: rows.map(({ seq, sender, text }) => ({ seq, sender, text,
        ...(members.find(m => m.uid === sender)?.name && { name: members.find(m => m.uid === sender).name }) })),
        members: members.slice(0, 80).map(({ uid, name, robot, role }) => ({ uid, name, robot, role })),
        membersTruncated: members.length > 80, requester: job.sender }),
    }
  }

  async process(job, signal) {
    const sourceConfig = this.config
    const config = { ...sourceConfig }
    const host = this.host
    const channelType = job.channel_type
    const recipient = job.channel_id ?? job.sender
    if (!permitsRoute(config, job.sender, channelType, recipient)) {
      this.store.review(job.seq, 'route_not_allowed')
      return
    }
    if (job.ambient || config.senderPolicy === 'octo' || (channelType !== 1 && config.channelPolicy === 'joined')) {
      try {
        if (!await this.api.allowsMessage(config, job, signal)) {
          this.store.discard(job.seq, 'octo_access_denied')
          return
        }
      } catch (error) {
        if (signal.aborted) return
        const issue = 'access_' + (error instanceof OctoError ? error.code : 'internal_error')
        this.store.discard(job.seq, issue, 'review')
        this.log(issue)
        return
      }
    }
    const route = { channel_id: recipient, channel_type: channelType }
    let meta = job.metadata ? JSON.parse(job.metadata) : {}
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
      let deliverables, card
      try {
        let reply
        if (meta.command === 'card' || meta.command === 'choose') {
          reply = '当前 Octo 客户端或部署未开启所需的卡片类型。'
        } else if (meta.command) {
          if (meta.command === 'new') this.store.session(conversation, config.idleMinutes, Date.now(), true)
          reply = textCommands[meta.command]
        } else if (meta.cardAction) {
          reply = meta.cardAction.selection === 'A' || meta.cardAction.selection === 'B'
            ? '已确认：选项 ' + meta.cardAction.selection + '。' : '已确认。'
        } else {
          progress = this.progress.start(job, config.progress, signal)
          const [material, channelContext] = await Promise.all([
            materializeInput(config, meta, signal),
            this.channelContext(config, route, job, meta, signal),
          ])
          const { attachments, order } = material
          const voice = config.allowFiles ? voiceTool(this.api, attachments) : undefined
          let session = this.store.session(conversation, config.idleMinutes)
          if (session.created && await host.exists?.(session.session_id, signal) === false) {
            this.store.forgetSession(session.session_id)
            session = this.store.session(conversation)
          }
          if (this.isArchived?.(session.session_id)) session = this.store.session(conversation, config.idleMinutes, Date.now(), true)
          this.store.running(job.seq, session.session_id)
          const isFileOnly = attachments.length > 0 && !job.input.trim()
          const canMerge = () => config.transport === 'websocket' && !this.paused && this.config.sendMode === 'steer'
            && this.config.sessionProfile === config.sessionProfile && authorizedTools(this.config, job)
          // A file sent without a caption is often followed by its instructions
          // in a separate message. Give that text a short chance to join.
          if (isFileOnly && canMerge() && !this.steering.size) await delay(1000, undefined, { signal })
          const instructions = []
          if (canMerge()) {
            for (let i = 0; i < 4; i++) {
              const next = this.store.steerCandidate(job)
              if (!next || next.sender !== job.sender || next.metadata || !this.steering.has(next.message_id)) break
              this.store.running(next.seq, session.session_id)
              this.steering.delete(next.message_id)
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
          const run = () => host.run(session, input, async () => {
            this.store.sessionCreated(conversation)
            await this.attach?.(session.session_id, config.cwd)
          }, signal, rules,
            phase => {
              if (phase === 'reused') this.log('dsh_session_reused')
              else progress.stage(phase)
              if (phase === 'running') queueMicrotask(() => this.attemptSteering())
            }, config.timeoutMs, toolsAllowed,
            { attachments, order: inputOrder, authorCard, channelContext, taskContext: true, onTrace: trace => progress.trace(trace),
              ...((channelType !== 1 || toolsAllowed) && config.toolPermission !== 'text-only' && this.api.channel && { channelTools: {
                specs: [...operationSpecs.filter(spec => spec.available && (config.toolPermission !== 'read-only' || !spec.mutating)
                  && (channelType !== 1 ? !spec.name.startsWith('voice.context.')
                    : spec.name === 'inspect' || spec.name.startsWith('messages.')
                      || job.sender === config.ownerUid && (spec.name.startsWith('voice.context.')
                        || ['space.members.search', 'groups.create'].includes(spec.name)))).map(spec => ({
                  name: 'octo_' + spec.name.replaceAll('.', '_'), description: spec.description, parameters: spec.parameters,
                })),
                  displayCardSpec, ...(voice ? [voice.spec] : []), ...(toolsAllowed ? [formToolSpec] : [])],
                waitNames: toolsAllowed ? [formToolSpec.name] : [],
                execute: (name, args, toolSignal) => {
                  if (name === formToolSpec.name) return (async () => {
                    const current = await this.liveToolAccess(job, toolSignal)
                    return this.questions.form(args, { ...job, session_id: session.session_id }, current, toolSignal,
                      waiting => progress.trace({ kind: waiting ? 'question-open' : 'question-closed' }), () => this.liveToolAllowed(job, current))
                  })()
                  if (name === voice?.spec.name) return (async () => {
                    if (!this.config.allowFiles || this.config.toolPermission === 'text-only'
                      || !await this.api.allowsMessage(this.config, job, toolSignal)) throw new Error('octo_access_denied')
                    return voice.execute(args, toolSignal)
                  })()
                  if (name === displayCardSpec.name) return (async () => {
                    if (!await this.api.allowsMessage(this.config, job, toolSignal)) throw new Error('octo_access_denied')
                    const receipt = await sendDisplayCard({ api: this.api, route, args, signal: toolSignal })
                    this.store.recordDelivery(job.seq, receipt.messageId)
                    return receipt
                  })()
                  const operation = operationSpecs.find(spec => 'octo_' + spec.name.replaceAll('.', '_') === name)
                  if (!operation?.available || config.toolPermission === 'read-only' && operation.mutating) throw new Error('octo_operation_unavailable')
                  return this.api.channel.dispatch(route, job.sender, operation.name, args, toolSignal)
                }, guidance: mentionGuidance,
              } }),
              ...(toolsAllowed && { approval: { runId: String(job.seq), requester: job.sender },
                authorizeTools: () => this.liveToolAllowed(job, sourceConfig),
                onApprovalControl: revoke => { this.revokeApproval = revoke },
                onQuestion: async (questions, askSignal) => {
                const current = await this.liveToolAccess(job, askSignal)
                const answer = await this.questions.ask(questions, { ...job, session_id: session.session_id }, current, askSignal,
                  waiting => progress.trace({ kind: waiting ? 'question-open' : 'question-closed' }), () => this.liveToolAllowed(job, current))
                await this.liveToolAccess(job, askSignal)
                return answer
              } }),
              ...(toolsAllowed && config.allowFiles && { onDeliverables: files => { deliverables = files } }),
              ...(toolsAllowed && config.transport === 'websocket'
                && { onSteer: offer => { this.steerActive = offer ? { job, offer, merged, sessionId: session.session_id, profile: config.sessionProfile } : undefined } }) })
          try { reply = await run() }
          catch (error) {
            // The native session can be deleted between stat and resume. Only
            // this explicit pre-run failure permits creating a new session.
            if (error?.message !== 'session_missing') throw error
            this.store.forgetSession(session.session_id)
            session = this.store.session(conversation)
            for (const seq of [job.seq, ...merged]) this.store.running(seq, session.session_id)
            reply = await run()
          }
          if (asksForFile(input) && !deliverables?.length) {
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
              try { await this.api.send(recipient, '文件未发送：' + explanation, signal, channelType) }
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
          ...(deliverables?.length && { deliverables }), ...(merged.length && { merged }), ...(card && { displayCard: card.form }),
        }
        this.store.ready(job.seq, bounded, meta)
        job = { ...job, reply: bounded }
      } catch (error) {
        const code = error instanceof OctoError ? (error.status ? apiErrorCode(error) : error.code) : hostIssues.has(error?.message) ? error.message
          : error?.name === 'SessionAlreadyOwnedError' ? 'session_busy' : 'agent_run_not_confirmed'
        this.store.review(job.seq, code)
        for (const seq of merged) this.store.review(seq, code)
        this.log(code)
        const detail = failureDetails[code] ?? unknownFailure
        const notified = await progress?.finish('error', { detail })
        if (!signal.aborted && !notified && !job.ambient && config.progress !== undefined) {
          try { await this.api.send(recipient, 'DSH 已收到消息。' + detail, signal, channelType) }
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
      const images = []
      if (meta.deliverables?.length) {
        if (!config.allowFiles || !authorizedTools(config, job) || config.toolPermission === 'text-only') throw new Error('files_not_authorized')
        for (const path of meta.deliverables) {
          const file = await readDeliverable(config.cwd, isAbsolute(path) ? relative(config.cwd, path) : path, signal)
          if (typeof this.api.sendPayload !== 'function') {
            markMedia(await uploadAttachment(config, route, file, signal))
            continue
          }
          const payload = await prepareAttachment(config, file, signal)
          if (!meta.displayCard && payload.type === 2 && payload.width > 0 && payload.height > 0) images.push(payload)
          else markMedia(await this.api.sendPayload(route, payload, signal, replyTo))
        }
      }
      let resultId
      if (meta.command === 'card' || meta.command === 'choose' || (meta.displayCard && safeCommand(config, job))) {
        try {
          const result = await sendCard(config, { ...route, operatorUid: job.sender }, meta.displayCard ?? cardForm(meta.command), signal)
          resultId = result.messageId
          confirmed = true
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
              resultId = await this.api.sendPayload(route, payload, signal, replyTo)
              chunks.shift()
              markMedia(resultId, images.length)
              images.length = 0
            } catch (error) {
              // A definitive unsupported/invalid response can downgrade to native
              // images without re-uploading. An ambiguous response is never replayed.
              if (!(error instanceof OctoError) || ![400, 415, 422].includes(error.status)) throw error
            }
          }
        }
        for (const image of images) markMedia(await this.api.sendPayload(route, image, signal, replyTo))
        for (const chunk of chunks) {
          const outbound = finalMentions(chunk, members)
          const delivered = await this.api.send(recipient, outbound.text, signal, channelType, replyTo, outbound.mention)
          confirmed = true
          resultId ??= delivered
          if (chunks.length > 1 || meta.deliverables?.length) this.store.recordDelivery(job.seq, delivered)
        }
      }
      this.store.sent(job.seq, resultId, merged)
      await progress?.finish('completed')
    } catch (error) {
      // Do not replay a text/card or any already sent file if delivery failed mid-batch.
      if (!confirmed && !meta.deliverables?.length && !merged.length && error instanceof OctoError && error.status === 429 && job.attempts < 3) {
        this.store.retry(job.seq, Date.now() + Math.max(error.retryAfterMs, 3000 * (2 ** job.attempts)))
      } else {
        const issue = meta.deliverables?.length ? 'file_delivery_not_confirmed' : confirmed ? 'partial_delivery' : 'delivery_not_confirmed'
        this.store.review(job.seq, issue)
        for (const seq of merged) this.store.review(seq, issue)
        this.log(issue)
      }
      await progress?.finish('stopped', meta.deliverables?.length ? { detail: '文件或正文尚未确认全部送达' } : undefined)
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
    this.inbox.connection(false)
    this.inbox.connection(true)
    const draining = this.drain(lifetime)
    const receiving = this.poll(lifetime)
    const recovery = this.inbox.run(lifetime)
    try { await Promise.all([receiving, draining, recovery]) }
    finally { stop.abort(); await Promise.allSettled([receiving, draining, recovery]) }
  }

  async poll(signal) {
    let failures = 0
    while (!signal.aborted) {
      try {
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
        if (this.store.hasOpenCard()) await this.ingest(signal, true)
        else {
          // The last claim closes its form before ACK. Retry by exact receipt ID
          // even with no forms left, after expiry, or in a newly started worker.
          await this.flushCardAcks(signal)
          await delay(500, undefined, { signal })
        }
        failures = 0
      } catch (error) {
        if (signal.aborted) return
        this.log('card_action_poll_failed')
        await delay(Math.max(error?.retryAfterMs ?? 0, Math.min(30_000, 1000 * 2 ** Math.min(5, ++failures))), undefined, { signal })
      }
    }
  }

  async runRealtime(lifetime) {
    const stop = new AbortController()
    const signal = AbortSignal.any([lifetime, stop.signal])
    const accept = m => {
      signal.throwIfAborted()
      const candidate = admit({ message: {
        message_id: m.messageId, message_seq: m.messageSeq, from_uid: m.fromUid, channel_type: m.channelType,
        channel_id: m.channelId, payload: m.payload,
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
      await Promise.all([receiving, draining, cardEvents, recovery])
    } finally {
      stop.abort()
      await Promise.allSettled([receiving, draining, cardEvents, recovery])
    }
  }
}
