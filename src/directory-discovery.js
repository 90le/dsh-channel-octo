import { setTimeout as delay } from 'node:timers/promises'
import { ruleScope } from './rules.js'

export function directoryRecoveryEnabled(config) {
  return config.botKind !== 'app' && config.transport === 'websocket' && config.mentionPolicy === 'octo'
    && (config.channelPolicy === 'joined' || config.groups?.size > 0 || config.threads?.size > 0)
}

function permits(config, group, route) {
  const scope = ruleScope(route?.channel_type, route?.channel_id)
  return scope?.group === group && (config.channelPolicy === 'joined'
    || (scope.thread ? config.threads?.has(route.channel_id) : config.groups?.has(group)))
}

function retryAt(error, now) {
  const wait = Math.max(30_000, Number.isFinite(error?.retryAfterMs) ? Math.ceil(error.retryAfterMs) : 0)
  // Ignore invalid/overflowing hints, while honoring every representable delay.
  return now + (Number.isSafeInteger(now + wait) ? wait : 30_000)
}

// A directory names candidates, never executable messages. The inbox reads
// retained history with a fixed time boundary and applies ordinary admission.
export class DirectoryDiscovery {
  constructor({ api, store, config, online, paused, log }) {
    Object.assign(this, { api, store, config, online, paused, log })
    this.available = typeof api.inboxDirectoryGroups === 'function' && typeof api.inboxDirectoryPage === 'function'
      && typeof store.activateDirectoryRecovery === 'function'
  }

  async sweep(signal) {
    const config = this.config()
    if (!this.available || !directoryRecoveryEnabled(config) || this.paused()) return
    this.store.activateDirectoryRecovery()
    if (!this.online()) return
    const current = () => !signal.aborted && this.config() === config && this.online() && !this.paused()
    const listedAt = this.store.directoryListedAt()
    // Catalog freshness does not depend on all groups reaching EOF. Merge it
    // without resetting pending page/retry state, even during prolonged denial.
    if ((!listedAt || Date.now() >= listedAt + 60_000) && Date.now() >= (this.retryAt ?? 0)) {
      try {
        const candidates = await this.api.inboxDirectoryGroups(config, signal)
        if (!current()) return
        if (!this.store.mergeDirectoryScan(candidates)) throw new Error('invalid_directory_candidates')
        this.retryAt = 0
      } catch (error) {
        signal.throwIfAborted()
        if (!current()) return
        this.store.directoryRecoveryFailed(true)
        this.retryAt = retryAt(error, Date.now())
        this.log('octo_directory_recovery_unavailable')
      }
    }
    if (!current()) return
    let group
    try {
      group = this.store.nextDirectoryGroup()
      if (!group) return
      const page = await this.api.inboxDirectoryPage(config, group.group_no, group.page, signal)
      if (!current()) return
      if (!Array.isArray(page?.routes) || page.routes.length > 101
        || page.routes.some(route => !permits(config, group.group_no, route))
        || page.nextPage !== null && page.nextPage !== group.page + 1) throw new Error('invalid_directory_page')
      for (const route of page.routes) this.store.seedDirectoryRoute(route.channel_type, route.channel_id)
      this.store.completeDirectoryStep(group.group_no, page.nextPage)
      if (this.retryAt) this.store.directoryRecoveryFailed(true)
    } catch (error) {
      signal.throwIfAborted()
      if (!current()) return
      const now = Date.now()
      if (group) this.store.retryDirectoryStep(group.group_no, retryAt(error, now), now)
      else this.store.directoryRecoveryFailed(true)
      this.log('octo_directory_recovery_unavailable')
    }
  }

  async run(signal) {
    while (!signal.aborted) {
      await this.sweep(signal)
      await delay(1000, undefined, { signal })
    }
  }
}
