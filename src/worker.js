import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute, relative } from 'node:path'
import { admit, decimalId, OctoError, permitsRoute } from './octo.js'
import { receiveRealtime } from './realtime.js'
import { Progress } from './progress.js'
import { downloadAttachment, uploadAttachment } from './octo-media.js'
import { readDeliverable } from './dsh-media.js'
import { createCard, parseCardAction, resolveCardAction, sendCard } from './octo-cards.js'

const safeCommand = (config, job) => (job.channel_type === 1
  ? config.dmCommands === 'safe' && (job.sender === config.ownerUid || config.allowed.has(job.sender))
  : config.groupCommands === 'safe' && job.sender === config.ownerUid && !job.ambient)
// Chat admission is separate from tools. Owner identity comes only from verify-bot.
function authorizedToolDm(config, job) {
  return job.channel_type === 1 && (config.senderPolicy === 'allowlist'
    ? config.allowed.has(job.sender)
    : config.senderPolicy === 'octo' && !!config.ownerUid && job.sender === config.ownerUid)
}
function asksForFile(input) {
  return /(?:发送|发给|发我|回传|传给|交付|附上).{0,14}(?:文件|附件)|(?:文件|附件).{0,14}(?:发送|发给|发我|回传|传给|交付)|\b(?:send|attach|deliver)\b.{0,24}\b(?:file|attachment)\b/iu.test(input)
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

function segments(text) {
  const units = Array.from(text)
  const out = []
  for (let offset = 0; offset < units.length; offset += 1800) out.push(units.slice(offset, offset + 1800).join(''))
  return out
}

const textCommands = {
  help: '可用命令：/help 帮助、/status 当前会话状态、/new 新会话、/card 展示卡片、/choose 交互卡片。',
  status: 'DSH 已收到这条消息，当前会话可以正常处理消息。',
  new: '已开启新会话，旧会话记录仍可在 DSH 查看。',
}


const hostIssues = new Set(['session_busy', 'session_timeout', 'session_preset_conflict',
  'missing_host_model', 'shared_turn_not_forwarded', 'prompt_discarded', 'no_confirmed_final_text',
  'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context',
  'missing_scoped_tool_controls', 'missing_host_permission', 'session_requires_owned_writer', 'dsh_attachment_rejected', 'dsh_attachment_storage_unavailable'])

export class Worker {
  constructor({ api, store, host, config, log, attach, isArchived }) {
    Object.assign(this, { api, store, host, config, log, attach, isArchived })
    this.progress = new Progress(api, log)
    this.cursor = '0'
  }

  async ingest(signal, cardsOnly = false) {
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
        const selection = resolveCardAction(event, binding, this.config)
        if (selection && permitsRoute(this.config, selection.operatorUid, selection.route.channel_type, selection.route.channel_id)) {
          this.store.claimCard(selection, {
            messageId: 'card_action:' + id, sender: selection.operatorUid, channelId: selection.route.channel_id,
            channelType: selection.route.channel_type, text: '', cardAction: { selection: selection.selection },
          })
          await this.api.ack(id, signal)
        } else if (this.store.hasEvent(id)) await this.api.ack(id, signal)
      } else if (!cardsOnly) {
        const message = admit(event, this.config)
        if (message) this.store.add(id, message)
        await this.api.ack(id, signal)
      }
      // In WebSocket mode this poll consumes only this plugin's own card actions.
      // Never backfill old chat messages or ACK events owned by another integration.
      this.cursor = id
    }
  }

  attemptSteering() {
    const active = this.steerActive
    if (!active) return
    const next = this.store.steerCandidate(active.job)
    if (!next || next.sender !== active.job.sender || next.metadata || !next.input) return
    active.offer(next.input, () => {
      this.store.running(next.seq, active.sessionId)
      active.merged.push(next.seq)
    })
  }

  async process(job, signal) {
    const config = { ...this.config }
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
    if (meta.attachment && !config.allowFiles) {
      this.store.discard(job.seq, 'files_disabled')
      return
    }
    let progress
    let merged = meta.merged ?? []
    if (job.state === 'queued') {
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
      const toolsAllowed = authorizedToolDm(config, job)
      const conversation = config.sessionProfile
        ? JSON.stringify([channelType, recipient, inheritance[0] ?? null, config.sessionProfile])
        : channelType === 1 ? job.sender : JSON.stringify([channelType, recipient, ...inheritance])
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
          const attachments = meta.attachment ? [await downloadAttachment(config, meta.attachment, signal)] : []
          let session = this.store.session(conversation, config.idleMinutes)
          if (this.isArchived?.(session.session_id)) session = this.store.session(conversation, config.idleMinutes, Date.now(), true)
          this.store.running(job.seq, session.session_id)
          const authorCard = safeCommand(config, job) && !attachments.length
            && /卡片|\bcard\b/iu.test(job.input)
          reply = await this.host.run(session, job.input, async () => {
            this.store.sessionCreated(conversation)
            await this.attach?.(session.session_id)
          }, signal, rules,
            phase => { if (phase === 'reused') this.log('dsh_session_reused'); else progress.stage(phase) }, config.timeoutMs, toolsAllowed,
            { attachments, authorCard, taskContext: channelType === 1, onTrace: trace => progress.trace(trace),
              ...(toolsAllowed && config.allowFiles && { onDeliverables: files => { deliverables = files } }),
              ...(toolsAllowed && config.transport === 'websocket' && config.sendMode === 'steer' && !attachments.length
                && { onSteer: offer => { this.steerActive = offer ? { job, offer, merged, sessionId: session.session_id } : undefined } }) })
          if (channelType === 1 && asksForFile(job.input) && !deliverables?.length) {
            const issue = !config.allowFiles ? 'files_disabled' : !toolsAllowed || config.toolPermission === 'text-only'
              ? 'file_tools_unavailable' : 'file_not_presented'
            this.store.review(job.seq, issue)
            for (const seq of merged) this.store.review(seq, issue)
            this.log(issue)
            const explanation = issue === 'files_disabled' ? '此账号尚未启用附件。'
              : issue === 'file_tools_unavailable' ? '本次私聊没有工作区工具权限。'
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
        const units = Array.from(reply.trim())
        const bounded = units.length <= 14_400 ? units.join('') : units.slice(0, 14_360).join('') + '\n（其余内容请在 DSH 会话中查看）'
        if (!bounded) throw new Error('empty_reply')
        meta = meta.command || meta.cardAction ? meta : {
          ...(deliverables?.length && { deliverables }), ...(merged.length && { merged }), ...(card && { displayCard: card.form }),
        }
        this.store.ready(job.seq, bounded, meta)
        job = { ...job, reply: bounded }
      } catch (error) {
        const code = error instanceof OctoError ? error.code : hostIssues.has(error?.message) ? error.message
          : error?.name === 'SessionAlreadyOwnedError' ? 'session_busy' : 'agent_run_not_confirmed'
        this.store.review(job.seq, code)
        for (const seq of merged) this.store.review(seq, code)
        this.log(code)
        const notified = await progress?.finish('error')
        if (!signal.aborted && !notified && !job.ambient && config.progress !== undefined) {
          try { await this.api.send(recipient, 'DSH 已收到消息，但本次回复未完成。请稍后重发。', signal, channelType) }
          catch { if (!signal.aborted) this.log('failure_notice_not_confirmed') }
        }
        return
      }
    }
    signal.throwIfAborted()
    this.store.sending(job.seq)
    progress?.stage('delivering')
    let confirmed = false
    try {
      if (meta.deliverables?.length) {
        if (!config.allowFiles || !authorizedToolDm(config, job) || config.toolPermission === 'text-only') throw new Error('files_not_authorized')
        for (const path of meta.deliverables) {
          const file = await readDeliverable(config.cwd, isAbsolute(path) ? relative(config.cwd, path) : path, signal)
          const delivered = await uploadAttachment(config, route, file, signal)
          confirmed = true
          this.store.recordDelivery(job.seq, delivered)
          progress?.trace({ kind: 'file-sent' })
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
        const chunks = segments(job.reply)
        for (const chunk of chunks) {
          const delivered = await this.api.send(recipient, chunk, signal, channelType)
          confirmed = true
          resultId ??= delivered
          if (chunks.length > 1 || meta.deliverables?.length) this.store.recordDelivery(job.seq, resultId)
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
    if (identity?.ownerUid) this.config.ownerUid = identity.ownerUid
    this.log('bot_verified')
    if (this.config.transport === 'websocket') return this.runRealtime(signal)
    let failures = 0
    while (!signal.aborted) {
      const job = this.store.next(Date.now())
      if (job) {
        await this.process(job, signal)
        continue
      }
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

  async runRealtime(lifetime) {
    const stop = new AbortController()
    const signal = AbortSignal.any([lifetime, stop.signal])
    const accept = m => {
      signal.throwIfAborted()
      const candidate = admit({ message: {
        message_id: m.messageId, from_uid: m.fromUid, channel_type: m.channelType,
        channel_id: m.channelId, payload: m.payload,
      } }, this.config)
      if (candidate) {
        this.store.add('ws:' + candidate.messageId, candidate)
        this.attemptSteering()
      }
      // WukongConnection sends RECVACK only after this function returns.
    }
    const receiving = receiveRealtime({ api: this.api, botUid: this.config.botUid, accept, signal, log: this.log })
    const draining = (async () => {
      while (!signal.aborted) {
        const job = this.store.next(Date.now())
        if (job) await this.process(job, signal)
        else await delay(250, undefined, { signal })
      }
    })()
    const cardEvents = (async () => {
      let failures = 0
      while (!signal.aborted) {
        if (!this.store.hasOpenCard()) {
          await delay(500, undefined, { signal })
          continue
        }
        try {
          await this.ingest(signal, true)
          failures = 0
        } catch {
          if (signal.aborted) return
          this.log('card_action_poll_failed')
          await delay(Math.min(30_000, 1000 * 2 ** Math.min(5, ++failures)), undefined, { signal })
        }
      }
    })()
    try {
      await Promise.all([receiving, draining, cardEvents])
    } finally {
      stop.abort()
      await Promise.allSettled([receiving, draining, cardEvents])
    }
  }
}
