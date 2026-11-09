import { setTimeout as delay } from 'node:timers/promises'
import { admit, decimalId, OctoError, permitsRoute } from './octo.js'
import { receiveRealtime } from './realtime.js'
import { Progress } from './progress.js'

const hostIssues = new Set(['session_busy', 'session_timeout', 'session_preset_conflict',
  'missing_host_model', 'shared_turn_not_forwarded', 'prompt_discarded', 'no_confirmed_final_text',
  'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context',
  'missing_scoped_tool_controls'])

export class Worker {
  constructor({ api, store, host, config, log, attach }) {
    Object.assign(this, { api, store, host, config, log, attach })
    this.progress = new Progress(api, log)
  }

  async ingest(signal) {
    const events = await this.api.events(signal)
    for (const event of events) {
      signal.throwIfAborted()
      const id = decimalId(event?.event_id)
      if (!id) throw new OctoError('invalid_event_id')
      const message = admit(event, this.config)
      if (message) this.store.add(id, message)
      // This worker owns a dedicated Bot. Discard out-of-scope events without storing them.
      await this.api.ack(id, signal)
    }
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
    let progress
    if (job.state === 'queued') {
      let rules
      if (channelType !== 1) {
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
      const conversation = channelType === 1 ? job.sender : JSON.stringify([channelType, recipient, ...inheritance])
      const session = this.store.session(conversation)
      this.store.running(job.seq)
      progress = this.progress.start(job, config.progress, signal)
      try {
        const reply = await this.host.run(session, job.input, async () => {
          this.store.sessionCreated(conversation)
          await this.attach?.(session.session_id)
        }, signal, rules,
          phase => { if (phase === 'reused') this.log('dsh_session_reused'); else progress.stage(phase) }, config.timeoutMs)
        const bounded = Array.from(reply.trim()).slice(0, 1800).join('')
        if (!bounded) throw new Error('empty_reply')
        this.store.ready(job.seq, bounded)
        job = { ...job, reply: bounded }
      } catch (error) {
        const code = hostIssues.has(error?.message) ? error.message
          : error?.name === 'SessionAlreadyOwnedError' ? 'session_busy' : 'agent_run_not_confirmed'
        this.store.review(job.seq, code)
        this.log(code)
        const notified = await progress.finish('error')
        if (!signal.aborted && !notified && !job.ambient && config.progress !== undefined) {
          try { await this.api.send(recipient, 'DSH 已收到消息，但本次回复未完成。请稍后重发。', signal, channelType) }
          catch { if (!signal.aborted) this.log('failure_notice_not_confirmed') }
        }
        return
      }
    }
    signal.throwIfAborted()
    this.store.sending(job.seq)
    try {
      const resultId = await this.api.send(recipient, job.reply, signal, channelType)
      this.store.sent(job.seq, resultId)
      await progress?.finish('completed')
    } catch (error) {
      if (error instanceof OctoError && error.status === 429 && job.attempts < 3) {
        this.store.retry(job.seq, Date.now() + Math.max(error.retryAfterMs, 3000 * (2 ** job.attempts)))
      } else {
        this.store.review(job.seq, 'delivery_not_confirmed')
        this.log('delivery_not_confirmed')
      }
      await progress?.finish('stopped')
    }
  }

  async run(signal) {
    await this.api.verify(this.config.botUid, this.config.spaceId, signal)
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
      if (candidate) this.store.add('ws:' + candidate.messageId, candidate)
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
    try {
      await Promise.all([receiving, draining])
    } finally {
      stop.abort()
      await Promise.allSettled([receiving, draining])
    }
  }
}
