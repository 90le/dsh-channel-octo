import { setTimeout as delay } from 'node:timers/promises'
import { channelSequence, permitsRoute } from './octo.js'

// A channel cursor is not a Bot event cursor. The worker can discover a route
// from live intake or eligible Bot events; history itself is never ACKed.
export class InboxRecovery {
  constructor({ api, store, config, accept, log, questionKey }) {
    Object.assign(this, { api, store, config, accept, log, questionKey })
    this.enabled = typeof api.inboxPage === 'function'
    this.epoch = 0
    this.online = false
  }
  connection(online) {
    if (!this.enabled) return
    this.epoch++
    this.online = online
    if (!online) this.store.blockInbox()
  }
  receive(id, message) {
    if (!this.enabled || !channelSequence(message.messageSeq)) return this.accept(id, message)
    const route = this.store.enrolInbox(message, !this.online)
    if (this.store.inboxSeen(message.messageId)) return
    if (route.blocked) this.store.stageInbox(id, message, true, this.questionKey?.(message) ?? null)
    else this.accept(id, message)
  }
  async sweep(signal) {
    if (!this.enabled || !this.online) return
    const epoch = this.epoch, config = this.config()
    const current = () => this.online && epoch === this.epoch && config === this.config() && !signal.aborted
    for (const route of this.store.dueInbox(Date.now(), 60_000)) {
      if (!current()) return
      const routeCurrent = () => {
        const latest = this.store.inboxRoute(route.channel_type, route.channel_id)
        return current() && latest?.floor_seq === route.floor_seq && latest.since_ms === route.since_ms
          && latest.prefix_until_seq === route.prefix_until_seq && latest.prefix_since_ms === route.prefix_since_ms
          && latest.directory_all === route.directory_all
      }
      this.store.blockInboxRoute(route)
      try {
        const tip = await this.api.inboxPage(config, route, 0, undefined, signal)
        if (!routeCurrent()) return
        // Overlap tolerates delayed publication within a bounded window. The
        // server offers no lossless snapshot; never advertise exactly-once input.
        const floor = route.floor_seq + 1, upper = tip.last
        const pending = () => this.store.pendingInboxDiscoveries(route)
        const missing = pending()
        let start = Math.min(Math.max(floor, route.checkpoint - 127), ...missing.map(row => row.message_seq))
        let completed = !upper || start > upper
        for (let page = 0; !completed && page < 10; page++) {
          const batch = await this.api.inboxPage(config, route, start, upper, signal)
          if (!routeCurrent()) return
          if (batch.skippedThrough != null || !batch.count && batch.scannedThrough != null) {
            const through = batch.skippedThrough ?? batch.scannedThrough
            if (!channelSequence(through) || through < start || through > upper
              || batch.skippedThrough != null && through > route.prefix_until_seq) throw new Error('invalid_inbox_scan_boundary')
            this.store.checkpointInbox(route, through, [])
            completed = through >= upper
            start = through + 1
          } else if (!batch.count) {
            this.store.checkpointInbox(route, upper, [])
            completed = true
          } else {
            this.store.checkpointInbox(route, batch.last, batch.messages, batch.observed, batch.suppressed)
            // A discovered message is a durable obligation, even if the current
            // history snapshot has a hole. Do not let progress slide past it.
            if (pending().some(row => row.message_seq <= batch.last)) throw new Error('inbox_discovery_pending')
            completed = batch.last >= upper
            start = batch.last + 1
          }
        }
        if (!completed) { this.log('octo_inbox_catching_up'); continue }
        if (!routeCurrent()) return
        if (pending().length) throw new Error('inbox_discovery_pending')
        // Durable stage -> ordinary receipt is idempotent across a crash in
        // between these writes. Only actual live input can answer a current ask.
        for (;;) {
          const staged = this.store.stagedInbox(route)
          if (!staged.length) break
          for (const row of staged) {
            if (!routeCurrent()) return
            const message = JSON.parse(row.message)
            if (permitsRoute(config, message.sender, message.channelType, message.channelId)) {
              if (await this.accept(row.event_id, message, { historical: !row.live, delayed: true, questionKey: row.question_key }) === false) return
            }
            this.store.removeStagedInbox(row.message_id)
          }
        }
        // An event may rewind a discovered route while a page/accept awaited.
        // Keep it blocked and let the next sweep start from its new floor.
        if (!routeCurrent()) return
        this.store.releaseInbox(route)
      } catch (error) {
        if (signal.aborted) throw error
        // A denied or unavailable route remains held. Other routes can progress.
        // Never put raw response bodies or channel identifiers into the log.
        this.store.failInbox(route)
        if (!route.failed) this.log('octo_inbox_recovery_unavailable')
      }
    }
  }
  async run(signal) {
    while (!signal.aborted) {
      await this.sweep(signal)
      await delay(3000, undefined, { signal })
    }
  }
}
