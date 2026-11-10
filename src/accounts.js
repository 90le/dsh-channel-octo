import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apiEndpoint, privateStateDir, validBotIdentity, validToken, validToolScope, validUid } from './config.js'
import { DshHost } from './dsh.js'
import { OctoClient, OctoError } from './octo.js'
import { Store } from './store.js'
import { channelView, loadSettings } from './web.js'
import { normalizeImControls } from './im-controls.js'
import { Worker } from './worker.js'
import { sessionExists } from './session-state.js'
import { ruleScope } from './rules.js'
import { botCommandMenu, setBotCommands } from './bot-commands.js'
import { administerWebhooks, validateWebhookInput, webhookWrites } from './webhook-admin.js'
import { createWebhookChat, isWebhookChatAction, validateWebhookChatInput } from './webhook-chat.js'
import { directoryRecoveryEnabled } from './directory-discovery.js'

const legacy = 'legacy'
const textOnly = 'text-only'
import { assistantId, assistantRuntime, assistantRuntimeKeys, assistantDocKeys, legacyAssistant, validAssistantDoc } from './assistants.js'

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const refPattern = /^DSH_OCTO_ACCOUNT_[0-9A-F]{32}$/
const inputKeys = new Set(['label', 'token', 'cwd', 'provider', 'model', 'reasoningEffort',
  'permission', 'agentPreset', 'toolScope', 'enabled', 'senderPolicy', 'allowedUids', 'idleMinutes', 'sendMode', 'dmCommands', 'groupCommands', 'allowFiles'])
const idleOptions = [0, 15, 30, 60, 120]
const fail = code => { throw new Error(code) }
const str = (v, max = 200) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)
const sameBot = (a, b) => a?.botUid === b?.botUid && a?.spaceId === b?.spaceId
  && (a?.botKind ?? 'user') === (b?.botKind ?? 'user')
const id = () => randomUUID()

function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    fail('accounts_unavailable')
  }
}

function savedRecords(path, endpoint) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 3_000_000 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      fail('accounts_unavailable')
    }
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    if (saved?.version !== 1 || saved.endpoint !== endpoint || !Array.isArray(saved.accounts) || saved.accounts.length > 32) {
      fail('accounts_unavailable')
    }
    const ids = new Set(), bots = new Set()
    for (const item of saved.accounts) {
      const bot = item?.botUid
      if ((!idPattern.test(item?.id ?? '') && item?.id !== legacy) || !validBotIdentity(item)
        || ids.has(item.id) || bots.has(bot) || (item.secretRef != null && !refPattern.test(item.secretRef))
        || (item.id !== legacy && !item.secretRef && !item.removed)
        || !str(item.label, 80) || !str(item.cwd, 1024) || !isAbsolute(item.cwd)
        || !['events', 'websocket'].includes(item.transport) || (item.botKind === 'app' && item.transport !== 'websocket')
        || typeof item.enabled !== 'boolean'
        || (item.toolScope !== undefined && !validToolScope(item.toolScope))) fail('accounts_unavailable')
      item.toolScope ??= 'private'
      ids.add(item.id); bots.add(bot)
    }
    const profiles = new Map()
    if (saved.assistants !== undefined && (!Array.isArray(saved.assistants) || saved.assistants.length > 64)) fail('accounts_unavailable')
    for (const profile of saved.assistants ?? []) {
      if ((!idPattern.test(profile?.id ?? '') && profile?.id !== legacy) || profiles.has(profile.id)
        || !str(profile.name, 80) || !str(profile.cwd, 1024) || !isAbsolute(profile.cwd)
        || assistantDocKeys.some(key => !validAssistantDoc(profile[key] ?? ''))
        || assistantRuntimeKeys.filter(key => key !== 'cwd').some(key => profile[key] !== undefined && !str(profile[key]))
        || (profile.toolScope !== undefined && !validToolScope(profile.toolScope))) fail('accounts_unavailable')
      profiles.set(profile.id, { id: profile.id, name: profile.name, ...assistantRuntime(profile),
        agentsMd: profile.agentsMd ?? '', soulMd: profile.soulMd ?? '' })
    }
    const bound = new Set()
    for (const record of saved.accounts) {
      const key = assistantId(record)
      if ((!idPattern.test(key) && key !== legacy) || (!record.removed && bound.has(key))) fail('accounts_unavailable')
      if (record.assistantId !== undefined && !profiles.has(key)) fail('accounts_unavailable')
      if (!record.removed) bound.add(key)
    }
    return { accounts: saved.accounts, assistants: profiles }
  } catch (error) {
    if (error?.code === 'ENOENT') return { accounts: [], assistants: new Map() }
    throw error
  }
}

export class Accounts {
  #webhookChat = createWebhookChat()

  constructor(ctx, deployment, { fetchImpl = fetch, env = process.env } = {}) {
    Object.assign(this, { ctx, deployment, fetchImpl, env })
    this.log = ctx.logger('dsh-channel-octo')
    this.records = new Map()
    this.assistants = new Map()
    this.runtimes = new Map()
    this.revision = id()
    this.lifetime = new AbortController()
    this.ops = Promise.resolve()
    this.status = 'disabled'

  }

  get vault() { return this.ctx.get('credentials') }
  get canStore() { return typeof this.vault?.set === 'function' && typeof this.vault?.resolve === 'function' }

  async initialize() {
    // Old installs already declare an API endpoint. Fresh installs must pin it
    // server-side before this surface can ever accept an Octo credential.
    if (!this.deployment.apiBase) return
    this.status = 'connecting'
    try {
      this.endpoint = apiEndpoint(this.deployment.apiBase)
      this.root = privateStateDir(this.deployment, this.env)
      if (!isAbsolute(this.root)) fail('accounts_unavailable')
      privateDir(this.root)
      this.lease = new DatabaseSync(join(this.root, 'accounts-lease.sqlite'))
      this.lease.exec('BEGIN IMMEDIATE')
      this.file = join(this.root, 'accounts.json')
      const saved = savedRecords(this.file, this.endpoint)
      this.assistants = saved.assistants
      for (const record of saved.accounts) this.records.set(record.id, record)
      const { botUid, spaceId, cwd, mentionPolicy } = this.deployment
      const botKind = this.deployment.botKind === undefined && this.env.DSH_OCTO_BOT_TOKEN?.startsWith('app_')
        ? 'app' : this.deployment.botKind
      const identity = { botUid, spaceId, botKind }
      if (this.deployment.enabled === true && validBotIdentity(identity) && isAbsolute(cwd ?? '')) {
        const existing = this.records.get(legacy)
        if (existing && !sameBot(existing, identity)) fail('bot_identity_mismatch')
        if (!existing) this.records.set(legacy, {
          id: legacy, botUid, spaceId, cwd, label: 'Octo Bot', enabled: true, permission: textOnly, toolScope: 'private',
          ...(identity.botKind === 'app' && { botKind: 'app' }),
          transport: this.deployment.transport ?? (identity.botKind === 'app' || mentionPolicy === 'octo' ? 'websocket' : 'events'),
        })
      }
      for (const record of this.records.values()) {
        const key = assistantId(record)
        if (!record.removed && !this.assistants.has(key)) this.assistants.set(key, legacyAssistant(record))
      }
      this.status = this.records.size ? 'connecting' : 'disabled'
      for (const record of this.records.values()) {
        if (record.removed || this.lifetime.signal.aborted) continue
        try {
          const token = await this.tokenFor(record)
          if (!this.lifetime.signal.aborted) {
            const runtime = this.open(record, token)
            this.runtimes.set(record.id, runtime)
            this.start(runtime, true)
          }
        } catch {
          this.log.error('state_open_failed: account settings or credentials unavailable')
        }
      }
      this.ready = true
    } catch {
      this.ready = false
      this.status = 'configuration_or_state_error'
      this.log.error('state_open_failed: account registry unavailable')
    }
  }

  async dispose() {
    this.lifetime.abort()
    await this.ops.catch(() => {})
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.transition))
    await Promise.allSettled([...this.runtimes.values()].map(async runtime => {
      await this.stop(runtime)
      runtime.store.close()
    }))
    this.runtimes.clear()
    this.lease?.close()
  }

  tokenFor(record) {
    return record.secretRef
      ? Promise.resolve(this.vault?.resolve?.(record.secretRef)).then(result => result?.value)
      : Promise.resolve(record.id === legacy ? this.env.DSH_OCTO_BOT_TOKEN : undefined)
  }

  privatePolicy(record) {
    if (!record.permission || record.permission === textOnly) return
    // The host can restore accounts before permissionPresets has loaded.
    // Check the deployment policy now; edits check the live catalog and
    // DshHost requires a live permission service before granting any tools.
    if (!Array.isArray(this.deployment.hostPermissions) || !this.deployment.hostPermissions.includes(record.permission)) {
      fail('permission_unavailable')
    }
  }

  settingsFor(record, token) {
    if (!validToken(token)) fail('invalid_bot_token')
    const stateDir = record.id === legacy ? this.root : join(this.root, 'bots', record.id)
    const base = {
      ...(record.id === legacy ? this.deployment : {
        senderPolicy: 'octo', channelPolicy: 'allowlist', mentionPolicy: 'required',
        mediaDownloadOrigins: this.deployment.mediaDownloadOrigins, mediaUploadOrigins: this.deployment.mediaUploadOrigins,
        mediaMaxBytes: this.deployment.mediaMaxBytes, mediaTimeoutMs: this.deployment.mediaTimeoutMs,
      }),
      apiBase: this.endpoint, stateDir, cwd: record.cwd, botUid: record.botUid, spaceId: record.spaceId, transport: record.transport,
      ...(record.botKind === 'app' && { botKind: 'app' }),
      toolScope: record.toolScope ?? 'private',
    }
    const admission = record.senderPolicy ? { senderPolicy: record.senderPolicy, allowedUids: record.allowedUids ?? [] } : {}
    return loadSettings(base, stateDir, token, () => this.privatePolicy(record), admission)
  }

  open(record, token) {
    const stateDir = record.id === legacy ? this.root : join(this.root, 'bots', record.id)
    if (record.id !== legacy) privateDir(join(this.root, 'bots'))
    const settings = this.settingsFor(record, token)
    const store = new Store(stateDir, JSON.stringify([this.endpoint, record.spaceId, record.botUid]))
    return { record, settings, store, status: 'disabled' }
  }

  runtimeConfig(record, config) {
    const toolScope = record.toolScope ?? 'private'
    if (assistantId(record) !== record.id || record.id !== legacy || record.cwd !== this.deployment.cwd || record.provider || record.reasoningEffort
      || (record.permission && record.permission !== textOnly) || (record.agentPreset && record.agentPreset !== 'octo-text')
      || toolScope !== 'private') {
      config.sessionProfile = createHash('sha256').update(JSON.stringify([
        record.cwd, record.provider, record.model, record.reasoningEffort, record.permission, record.agentPreset,
        ...(toolScope === 'private' ? [] : [toolScope]),
        ...(assistantId(record) !== record.id ? ['assistant', assistantId(record)] : []),
      ])).digest('hex').slice(0, 24)
    }
    else delete config.sessionProfile
    config.idleMinutes = record.idleMinutes ?? 0
    config.toolPermission = record.permission ?? textOnly
    config.toolScope = toolScope
    Object.assign(config, normalizeImControls({ ...this.deployment, ...record }), { fetchImpl: this.fetchImpl })
    return config
  }

  start(runtime, attachExisting = false) {
    const { record, settings, store } = runtime
    if (this.lifetime.signal.aborted || !record.enabled) { runtime.status = 'disabled'; return }
    const config = this.runtimeConfig(record, settings.config)
    const signaler = new AbortController()
    runtime.controller = signaler
    const signal = AbortSignal.any([signaler.signal, this.lifetime.signal])
    runtime.status = 'connecting'
    const workspaces = new Map()
    const attach = async (sessionId, cwd = config.cwd) => {
      try {
        const registry = this.ctx.get('workspaceRegistry')
        if (!registry || registry.archivedSessionIds?.includes(sessionId)) return
        let opening = workspaces.get(cwd)
        if (!opening) {
          opening = Promise.resolve().then(() => registry.create(cwd, 'Octo')).catch(error => {
            if (workspaces.get(cwd) === opening) workspaces.delete(cwd)
            throw error
          })
          workspaces.set(cwd, opening)
        }
        const workspace = await opening
        await workspace.attachSession(sessionId)
      } catch { this.log.info('workspace_attach_failed') }
    }
    const worker = runtime.worker = new Worker({
      api: new OctoClient({ ...config, fetchImpl: this.fetchImpl }), store,
      host: this.hostFor(record, config),
      config, attach, isArchived: sessionId => this.ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(sessionId),
      proposeWebhookChat: (message, requestSignal) => this.#proposeWebhookChat(runtime, worker, message, requestSignal),
      log: (line) => {
        if (runtime.changing) return
        if (line === 'octo_ws_connected' || line === 'octo_poll_ok') {
          const justConnected = runtime.status !== 'online'
          runtime.status = 'online'
          if (justConnected) queueMicrotask(() => this.refreshNavigation())
        }
        else if (line.startsWith('octo_ws_retry_') || line.startsWith('octo_poll_')) runtime.status = 'reconnecting'
        if (line !== 'octo_poll_ok') this.log.info(line)
      },
    })
    runtime.stopped = (async () => {
      await this.reconcileSessions(runtime)
      if (attachExisting && record.id === legacy && !config.sessionProfile) {
        for (const row of store.overview().conversations) {
          signal.throwIfAborted()
          await attach(row.id)
        }
      }
      await worker.run(signal)
    })().catch(error => {
      if (!signal.aborted) {
        runtime.status = 'worker_stopped'
        this.log.error('worker_stopped: ' + (error instanceof OctoError ? error.code : 'internal_error'))
      }
    })
  }

  async stop(runtime) {
    runtime.controller?.abort()
    await runtime.stopped
    runtime.controller = undefined
    runtime.stopped = undefined
    runtime.worker = undefined
    runtime.status = 'disabled'
  }

  async changeConnection(runtime, { removing = false, priorSecret } = {}) {
    if (runtime.changing) fail('account_transition')
    runtime.changing = true
    runtime.status = runtime.record.enabled ? 'reconnecting' : 'disconnecting'
    const inFlight = runtime.worker?.pause(removing || !runtime.record.enabled)
    const operation = (async () => {
      try {
        await inFlight?.catch(() => {})
        await this.stop(runtime)
        if (removing) {
          runtime.store.retirePending()
          runtime.store.close()
          this.runtimes.delete(runtime.record.id)
        } else {
          runtime.changing = false
          this.start(runtime)
        }
        if (priorSecret) await this.vault?.unset?.(priorSecret).catch(() => {})
      } catch {
        runtime.status = 'worker_stopped'
        this.log.error('account_connection_transition_failed')
      } finally {
        runtime.changing = false
        runtime.transition = undefined
      }
    })()
    runtime.transition = operation
    if (!inFlight) await operation
  }

  async nativeSessionRemoved(sessionId) {
    if (typeof sessionId !== 'string' || this.lifetime.signal.aborted) return
    const runtimes = [...this.runtimes.values()].filter(runtime => runtime.store.hasSession?.(sessionId))
    if (!runtimes.length) return
    try {
      if (await sessionExists(this.ctx, sessionId, this.lifetime.signal, { removed: true }) !== false) return
      for (const runtime of runtimes) {
        if (this.runtimes.get(runtime.record.id) !== runtime) continue
        runtime.store.forgetSession(sessionId)
        runtime.worker?.sessionRemoved(sessionId)
      }
    } catch {
      if (!this.lifetime.signal.aborted) this.log.info('session_inventory_unavailable')
    }
  }

  async reconcileSessions(onlyRuntime) {
    if (onlyRuntime) return this.reconcileSessionRuntimes([onlyRuntime])
    if (!this.sessionReconciliation) {
      this.sessionReconciliation = this.reconcileSessionRuntimes([...this.runtimes.values()])
        .finally(() => { this.sessionReconciliation = undefined })
    }
    return this.sessionReconciliation
  }

  async reconcileSessionRuntimes(runtimes) {
    for (const runtime of runtimes) {
      for (const sessionId of runtime.store.knownSessions()) {
        try {
          if (await sessionExists(this.ctx, sessionId, this.lifetime.signal) === false
            && this.runtimes.get(runtime.record.id) === runtime) {
            runtime.store.forgetSession(sessionId)
            runtime.worker?.sessionRemoved(sessionId)
          }
        } catch {
          if (!this.lifetime.signal.aborted) this.log.info('session_inventory_unavailable')
          break
        }
      }
    }
  }

  refreshNavigation() {
    if (this.lifetime.signal.aborted) return
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      const worker = runtime.worker, config = worker?.config
      if (runtime.status !== 'online' || runtime.changing || !config || config.botKind === 'app'
        || !runtime.controller || runtime.controller.signal.aborted
        || typeof worker.api.refreshNavigation !== 'function'
        || runtime.navigationFlight || (runtime.navigationNext ?? 0) > now) continue
      const names = runtime.store.navigationNames()
      runtime.navigationAttempts ??= new Map()
      const candidates = []
      for (const row of runtime.store.sessionRoutes()) {
        if (!row.route.startsWith('[')) continue
        let route
        try { route = JSON.parse(row.route) } catch { continue }
        if (!Array.isArray(route)) continue
        const [type, address] = route
        if (![2,5].includes(type) || !ruleScope(type, address)
          || (config.channelPolicy === 'allowlist' && !(type === 2 ? config.groups : config.threads)?.has(address))) continue
        const key = type + ':' + address
        if ((runtime.navigationAttempts.get(key) ?? 0) > now) continue
        candidates.push({ type, address, key })
        if (!names.has(key)) break
      }
      const target = candidates.at(-1)
      if (!target) { runtime.navigationNext = now + 15_000; continue }
      runtime.navigationAttempts.set(target.key, now + 5 * 60_000)
      for (const [key, until] of runtime.navigationAttempts) if (until <= now) runtime.navigationAttempts.delete(key)
      runtime.navigationNext = now + 2500
      const signal = AbortSignal.any([this.lifetime.signal, runtime.controller.signal, AbortSignal.timeout(8000)])
      runtime.navigationFlight = worker.api.refreshNavigation(config, target.type, target.address, signal)
        .then(rows => {
          if (!signal.aborted && !runtime.changing && runtime.record.enabled && worker.config === config
            && this.runtimes.get(runtime.record.id) === runtime) runtime.store.rememberNavigationNames(rows)
        }).catch(() => {}).finally(() => { runtime.navigationFlight = undefined })
    }
  }

  publicAccount(record) {
    const runtime = this.runtimes.get(record.id)
    const overview = runtime?.store.overview()
    const config = channelView(runtime?.settings.config)
    const waiting = new Set([...(runtime?.worker?.activeByRoute?.values() ?? [])]
      .filter(active => active.questions?.current).map(active => active.sessionId))
    const eventRecovery = record.enabled && runtime?.settings.config.transport === 'websocket'
      && runtime.settings.config.botKind !== 'app' ? runtime.store.eventRecovery?.() : undefined
    const directoryRecovery = record.enabled && runtime && directoryRecoveryEnabled(runtime.settings.config)
      ? runtime.store.directoryRecovery?.() : undefined
    return {
      id: record.id, legacy: record.id === legacy, label: record.label, enabled: record.enabled,
      assistantId: assistantId(record), assistantName: this.assistants.get(assistantId(record))?.name ?? record.label,
      botUid: record.botUid, spaceId: record.spaceId, cwd: record.cwd, transport: record.transport,
      ...(record.botKind === 'app' && { botKind: 'app' }),
      provider: record.provider ?? '', model: record.model ?? '', reasoningEffort: record.reasoningEffort ?? '',
      permission: record.permission ?? textOnly, agentPreset: record.agentPreset ?? 'octo-text', idleMinutes: record.idleMinutes ?? 0,
      toolScope: record.toolScope ?? 'private',
      senderPolicy: config?.senderPolicy ?? record.senderPolicy ?? 'octo', allowedUids: config?.allowedUids ?? record.allowedUids ?? [],
      status: runtime?.status ?? (record.enabled ? 'invalid_configuration' : 'disabled'),
      ...normalizeImControls({ ...this.deployment, ...record }),
      config, revision: runtime?.settings.revision(), counts: overview?.counts ?? [], recentIssues: overview?.recentIssues ?? [], inbox: overview?.inbox,
      ...(eventRecovery && { eventRecovery: { ready: eventRecovery.ready, failed: eventRecovery.failed } }),
      ...(directoryRecovery && { directoryRecovery: { ready: directoryRecovery.ready, failed: directoryRecovery.failed,
        pendingGroups: directoryRecovery.pendingGroups } }),
      conversations: (overview?.conversations ?? []).map(row => ({ ...row,
        ...(waiting.has(row.id) && { state: 'waiting' }), accountId: record.id, accountLabel: record.label,
      })),
    }
  }

  overview() {
    const rows = [...this.records.values()].filter(record => !record.removed).map(record => this.publicAccount(record))
    const accounts = rows.map(({ conversations, ...account }) => account)
    const selected = accounts[0]
    return {
      accounts, assistants: [...this.assistants.values()].map(({ agentsMd, soulMd, ...assistant }) => ({
        ...assistant, boundAccountId: accounts.find(account => account.assistantId === assistant.id)?.id,
      })),
      channelWorkspacePaths: [...new Set(accounts.map(account => account.cwd))],
      accountRevision: this.revision, canManage: this.ready === true, credentialAvailable: this.ready && this.canStore,
      status: selected?.status ?? this.status, config: selected?.config ?? null, revision: selected?.revision,
      counts: selected?.counts ?? [], conversations: rows.flatMap(account => account.conversations).slice(0, 1000),
      sessionRoutes: rows.flatMap(account => {
        const store = this.runtimes.get(account.id)?.store
        const names = store?.navigationNames?.()
        return (store?.sessionRoutes?.() ?? []).flatMap(row => {
          let route
          try { route = row.route.startsWith('[') ? JSON.parse(row.route) : [1, row.route] } catch { return [] }
          if (!Array.isArray(route) || ![1, 2, 5].includes(route[0]) || typeof route[1] !== 'string') return []
          const [type, address] = route
          const group = ruleScope(type, address)?.group
          return [{ id: row.id, type, address, group, name: names?.get(type + ':' + address),
            groupName: group && names?.get('2:' + group), updatedAt: row.updatedAt,
            accountId: account.id, accountLabel: account.label }]
        })
      }),
    }
  }

  workspaces() {
    const map = new Map()
    const available = this.ctx.get('workspaceRegistry')?.list?.() ?? []
    for (const ws of available) if (typeof ws.path === 'string' && isAbsolute(ws.path)) {
      map.set(ws.path, { id: ws.id ?? ws.path, path: ws.path, title: ws.title ?? basename(ws.path) })
    }
    for (const path of [this.deployment.cwd, ...[...this.records.values()].filter(r => !r.removed).map(r => r.cwd)]) {
      if (typeof path === 'string' && isAbsolute(path) && !map.has(path)) {
        map.set(path, { id: path, path, title: basename(path) })
      }
    }
    return [...map.values()]
  }

  policies() {
    const service = this.ctx.get('permissionPresets')
    const allowed = Array.isArray(this.deployment.hostPermissions) ? this.deployment.hostPermissions : []
    return [{ id: textOnly, label: '仅文字（无工具）' }, ...(service?.names ?? []).map(name => {
      const option = service.optionOf?.(name)
      return { id: name, label: str(option?.name) ? option.name : name, disabled: !allowed.includes(name) }
    })]
  }

  async presets() {
    const service = this.ctx.get('agentPresets')
    try {
      const rows = await service?.compositionInventory?.()
      const result = new Map([['octo-text', { id: 'octo-text', label: 'Octo 文字模式' }]])
      for (const row of rows ?? []) {
        const key = row.id ?? row.presetId
        if (str(key, 128) && key && !row.broken && !result.has(key)) result.set(key, { id: key, label: row.name ?? row.label ?? key })
      }
      return [...result.values()]
    } catch { return [{ id: 'octo-text', label: 'Octo 文字模式' }] }
  }

  async models() {
    const llm = this.ctx.get('llm')
    const providers = (llm?.listProviders?.() ?? []).slice(0, 24)
    const sets = await Promise.all(providers.map(async provider => {
      try {
        const models = (await llm.listModels(provider.id)).slice(0, 160)
        return await Promise.all(models.map(async model => {
          // Catalog rows can omit adapter-resolved reasoning metadata. DSH
          // resolves it without making a completion request.
          const detail = model.reasoning ? model : await llm.resolveModelInfo?.(provider.id, model.id).catch(() => undefined)
          return { provider: provider.id, model: model.id, label: model.name ?? model.id,
            reasoningEfforts: (detail?.reasoning?.efforts ?? []).map(effort => effort.id) }
        }))
      } catch { return [] }
    }))
    const result = sets.flat()
    const selected = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selected?.provider && selected.model && !result.some(m => m.provider === selected.provider && m.model === selected.model)) {
      result.push({ provider: selected.provider, model: selected.model, label: selected.model, reasoningEfforts: [] })
    }
    return result
  }

  async options() {
    if (!this.catalog || this.catalogExpires <= Date.now()) {
      this.catalogExpires = Date.now() + 60_000
      this.catalog = this.models()
    }
    const [models, agentPresets] = await Promise.all([this.catalog, this.presets()])
    return { models, agentPresets, workspaces: this.workspaces(), policies: this.policies() }
  }

  async verify(token) {
    if (!this.ready) fail('accounts_unavailable')
    if (!this.canStore) fail('credential_provider_unavailable')
    if (!validToken(token)) fail('invalid_bot_token')
    return this.identify(token)
  }

  async identify(token, signal = this.lifetime.signal) {
    try {
      const api = new OctoClient({ apiBase: this.endpoint, token, fetchImpl: this.fetchImpl })
      const identity = await api.identify(signal)
      if (!validBotIdentity(identity) || (identity.botKind === 'app') !== token.startsWith('app_')
        || [identity.botUid, identity.spaceId, identity.ownerUid].some(value => typeof value === 'string' && value.includes(token))) {
        fail('bot_verification_failed')
      }
      return { botUid: identity.botUid, spaceId: identity.spaceId,
        ...(identity.botKind === 'app' && { botKind: 'app' }),
        ...(validUid(identity.ownerUid) && identity.ownerUid !== identity.botUid && { ownerUid: identity.ownerUid }) }
    } catch { fail('bot_verification_failed') }
  }

  locked(work) {
    const next = this.ops.then(() => {
      if (!this.ready || this.lifetime.signal.aborted) fail('accounts_unavailable')
      return work()
    })
    // The sequencing promise must not retain one-time management secrets.
    this.ops = next.then(() => undefined, () => undefined)
    return next
  }

  checkRevision(input) {
    if (input?.revision !== this.revision) fail('account_changed')
  }

  record(accountId) {
    const record = this.records.get(accountId)
    if (!record || record.removed) fail('account_not_found')
    return record
  }

  persist(record, assistants = this.assistants) {
    const pending = this.file + '.' + id()
    const records = new Map(this.records)
    if (record) records.set(record.id, record)
    try {
      writeFileSync(pending, JSON.stringify({ version: 1, endpoint: this.endpoint, accounts: [...records.values()], assistants: [...assistants.values()] }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx', flush: true })
      renameSync(pending, this.file)
    } finally { try { unlinkSync(pending) } catch {} }
    this.records = records
    this.assistants = assistants
    this.revision = id()
  }

  hostFor(record, config) {
    const assistant = this.assistants.get(assistantId(record))
    return new DshHost(this.ctx, config.cwd, config.timeoutMs, { ...record,
      agentsMd: assistant?.agentsMd, soulMd: assistant?.soulMd })
  }

  assistantDetail(key) {
    const profile = this.assistants.get(key)
    if (!profile) fail('assistant_not_found')
    const record = [...this.records.values()].find(item => !item.removed && assistantId(item) === key)
    return { ...profile, boundAccountId: record?.id }
  }

  saveAssistant(key, input) {
    return this.locked(async () => {
      this.checkRevision(input)
      const old = key ? this.assistantDetail(key) : undefined
      const data = input?.assistant
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data)
        .some(name => !['name', ...assistantRuntimeKeys, ...assistantDocKeys].includes(name))
        || !str(data.name, 80) || !data.name.trim() || (!old && this.assistants.size >= 64)) fail('invalid_assistant')
      const docs = Object.fromEntries(assistantDocKeys.map(name => [name, data[name] ?? old?.[name] ?? '']))
      if (Object.values(docs).some(value => !validAssistantDoc(value))) fail('invalid_assistant')
      if (old?.boundAccountId && input.accountId && old.boundAccountId !== input.accountId) fail('assistant_bound')
      const recordId = old?.boundAccountId ?? input.accountId
      const record = recordId ? this.record(recordId) : undefined
      const runtime = record && this.runtimes.get(record.id)
      if (runtime?.changing) fail('account_transition')
      const validationBase = old && { id: 'assistant', label: old.name, ...assistantRuntime(old) }
      const fields = await this.editFields({ ...assistantRuntime(data), label: data.name }, validationBase)
      const selected = assistantRuntime(fields)
      // Virtual migration preserves absent legacy fields: an instructions-only
      // save must not change a pre-existing session fingerprint.
      if (old) for (const name of assistantRuntimeKeys) {
        if (!Object.hasOwn(old, name) && selected[name] === ({ agentPreset: 'octo-text',
          permission: textOnly, toolScope: 'private', provider: '', model: '', reasoningEffort: '' })[name]) delete selected[name]
      }
      const profile = { id: old?.id ?? id(), name: fields.label, ...selected, ...docs }
      const next = record && { ...record, assistantId: profile.id }
      if (next) for (const name of assistantRuntimeKeys) {
        if (Object.hasOwn(profile, name)) next[name] = profile[name]
        else delete next[name]
      }
      const profiles = new Map(this.assistants).set(profile.id, profile)
      const candidate = runtime && this.settingsFor(next, await this.tokenFor(next))
      if (next) this.privatePolicy(next)
      this.persist(next, profiles)
      if (runtime) {
        runtime.record = next
        runtime.settings = candidate
        if (runtime.worker) {
          const config = this.runtimeConfig(next, candidate.config)
          runtime.worker.reconfigure(config, this.hostFor(next, config))
        }
      }
      return { assistantId: profile.id, ...this.overview() }
    })
  }

  async editFields(data, old) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !inputKeys.has(key))) fail('invalid_account')
    const prior = old && this.publicAccount(old)
    const fields = { ...prior, ...data }
    const { label, cwd, provider = '', model = '', reasoningEffort = '', permission = textOnly,
      agentPreset: requestedPreset = 'octo-text', toolScope = 'private', enabled = true, idleMinutes = 0 } = fields
    const agentPreset = requestedPreset || 'octo-text'
    const im = normalizeImControls({ ...this.deployment, ...old, ...data })
    for (const key of Object.keys(im)) if (Object.hasOwn(data, key) && im[key] !== data[key]) fail('invalid_account')
    if (!str(label, 80) || !str(cwd, 1024) || !str(provider, 128) || !str(model) || !str(reasoningEffort, 64)
      || !str(permission, 128) || !str(agentPreset, 128) || typeof enabled !== 'boolean' || !idleOptions.includes(idleMinutes)
      || !validToolScope(toolScope)
      || (!!provider !== !!model) || (reasoningEffort && !model)) fail('invalid_account')
    if (!this.workspaces().some(row => row.path === cwd)) fail('workspace_unavailable')
    if (provider && (!old || provider !== prior.provider || model !== prior.model || reasoningEffort !== prior.reasoningEffort)) {
      const { models } = await this.options()
      const item = models.find(m => m.provider === provider && m.model === model)
      if (!item && (old?.provider !== provider || old?.model !== model || old?.reasoningEffort !== reasoningEffort)) fail('model_unavailable')
      if (item && reasoningEffort && !item.reasoningEfforts.includes(reasoningEffort)) {
        const detail = await this.ctx.get('llm')?.resolveModelInfo?.(provider, model)
        if (!detail?.reasoning?.efforts?.some(value => value.id === reasoningEffort)) fail('reasoning_unavailable')
      }
    }
    if ((!old || agentPreset !== prior.agentPreset) && !(await this.presets()).some(row => row.id === agentPreset)) fail('invalid_account')
    if ((!old || permission !== prior.permission) && !this.policies().some(row => row.id === permission && !row.disabled)) fail('permission_unavailable')
    const senderPolicy = data.senderPolicy ?? this.runtimes.get(old?.id)?.settings.config.senderPolicy ?? old?.senderPolicy ?? 'octo'
    const rawUids = data.allowedUids ?? [...(this.runtimes.get(old?.id)?.settings.config.allowed ?? old?.allowedUids ?? [])]
    if (!['octo', 'allowlist'].includes(senderPolicy) || !Array.isArray(rawUids) || rawUids.length > 20
      || rawUids.some(uid => !validUid(uid)) || (senderPolicy === 'allowlist' && !rawUids.length)) fail('invalid_account')
    const allowedUids = senderPolicy === 'allowlist' ? [...new Set(rawUids)] : []
    return { label: label.trim() || 'Octo Bot', cwd, provider, model, reasoningEffort,
      permission, agentPreset, toolScope, enabled, senderPolicy, allowedUids, idleMinutes, ...im }
  }

  save(accountId, input) {
    return this.locked(async () => {
      this.checkRevision(input)
      const old = accountId ? this.record(accountId) : null
      const payload = input.account
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid_account')
      const docs = Object.fromEntries(assistantDocKeys.filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]))
      if (Object.values(docs).some(value => !validAssistantDoc(value))) fail('invalid_assistant')
      const data = Object.fromEntries(Object.entries(payload).filter(([key]) => !assistantDocKeys.includes(key)))
      const fields = await this.editFields(data, old)
      const changedToken = Object.hasOwn(data, 'token')
      if (!old && !changedToken) fail('invalid_bot_token')
      if (changedToken && !this.canStore) fail('credential_provider_unavailable')
      const token = changedToken ? data.token : await this.tokenFor(old)
      if (!validToken(token)) fail('invalid_bot_token')
      const identity = changedToken ? await this.identify(token) : old
      if (old && !sameBot(old, identity)) fail('bot_identity_mismatch')
      const existing = [...this.records.values()].find(record => record.botUid === identity.botUid)
      if (existing && existing.id !== old?.id && !existing.removed) fail('duplicate_bot')
      if (existing?.removed && !sameBot(existing, identity)) fail('duplicate_bot')
      if (!old && !existing && this.records.size >= 32) fail('invalid_account')
      const newRef = changedToken ? 'DSH_OCTO_ACCOUNT_' + id().replaceAll('-', '').toUpperCase() : old?.secretRef
      const record = {
        ...fields, id: old?.id ?? existing?.id ?? id(), botUid: identity.botUid, spaceId: identity.spaceId, secretRef: newRef,
        ...(identity.botKind === 'app' && { botKind: 'app' }),
        transport: old?.transport ?? 'websocket',
      }
      const selectedAssistant = assistantId(old ?? record)
      record.assistantId = selectedAssistant
      const profile = this.assistants.get(selectedAssistant) ?? legacyAssistant(record)
      if (!this.assistants.has(selectedAssistant) && this.assistants.size >= 64) fail('invalid_assistant')
      const profiles = new Map(this.assistants).set(selectedAssistant, { ...profile, name: record.label, ...assistantRuntime(record), ...docs })
      const active = this.runtimes.get(record.id)
      if (active?.changing) fail('account_transition')
      const rotate = !!active && (changedToken || active.record.enabled !== record.enabled)
      let candidate
      try {
        candidate = active ? this.settingsFor(record, token) : this.open(record, token)
        if (changedToken) await this.vault.set(newRef, token)
        this.persist(record, profiles)
      } catch (error) {
        if (!active) candidate?.store.close()
        if (changedToken) await this.vault?.unset?.(newRef).catch(() => {})
        throw error
      }
      if (active) {
        active.record = record; active.settings = candidate
        if (rotate) await this.changeConnection(active, { priorSecret: changedToken ? old?.secretRef : undefined })
        else if (active.worker) {
          const config = this.runtimeConfig(record, candidate.config)
          active.worker.reconfigure(config, this.hostFor(record, config))
        }
      } else {
        this.runtimes.set(record.id, candidate)
        this.start(candidate)
      }
      if (!active && changedToken && old?.secretRef) await this.vault?.unset?.(old.secretRef).catch(() => {})
      return { accountId: record.id, ...this.overview() }
    })
  }

  saveRules(accountId, input) {
    return this.locked(() => {
      const record = accountId ? this.record(accountId) : [...this.records.values()].find(item => !item.removed)
      const runtime = this.runtimes.get(record?.id)
      if (!runtime) fail('channel_not_configured')
      if (runtime.changing) fail('account_transition')
      const next = { ...input?.settings }
      // The account editor owns sender admission after that field is edited.
      if (record.senderPolicy) { delete next.senderPolicy; delete next.allowedUids }
      runtime.settings.save(next, input?.revision)
      if (runtime.worker) {
        const config = this.runtimeConfig(record, runtime.settings.config)
        runtime.worker.reconfigure(config, this.hostFor(record, config))
      }
      return { config: channelView(runtime.settings.config), revision: runtime.settings.revision(), overview: this.overview() }
    })
  }

  setEnabled(accountId, input) {
    return this.locked(async () => {
      this.checkRevision(input)
      if (typeof input.enabled !== 'boolean') fail('invalid_account')
      const record = this.record(accountId)
      const runtime = this.runtimes.get(accountId)
      if (!runtime) fail('channel_not_configured')
      if (record.enabled === input.enabled) return this.overview()
      if (runtime.changing) fail('account_transition')
      const next = { ...record, enabled: input.enabled }
      this.persist(next)
      runtime.record = next
      await this.changeConnection(runtime)
      return this.overview()
    })
  }

  updateBotCommands(accountId, input) {
    return this.locked(async () => {
      this.checkRevision(input)
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['revision', 'action'].includes(key))) fail('invalid_bot_commands')
      botCommandMenu(input.action)
      const record = this.record(accountId)
      if (record.botKind === 'app') fail('app_bot_operation_unavailable')
      const runtime = this.runtimes.get(accountId)
      if (!runtime?.settings?.config) fail('channel_not_configured')
      if (runtime.changing) fail('account_transition')
      // Pausing reception does not remove the native menu. Both operations
      // remain explicit and available for a configured, paused account.
      let token
      try { token = await this.tokenFor(record) } catch { fail('invalid_bot_token') }
      if (!validToken(token)) fail('invalid_bot_token')
      const identity = await this.identify(token)
      if (!sameBot(identity, record)) fail('bot_identity_mismatch')
      const botCommands = await setBotCommands({ apiBase: this.endpoint, token, fetchImpl: this.fetchImpl },
        input.action, this.lifetime.signal)
      this.revision = id()
      return { ...this.overview(), botCommands }
    })
  }

  async diagnose(accountId) {
    const record = this.record(accountId)
    const token = await this.tokenFor(record)
    if (!validToken(token)) fail('invalid_bot_token')
    const identity = await this.identify(token)
    if (!sameBot(identity, record)) fail('bot_identity_mismatch')
    return identity
  }

  #webhookChatContext(runtime, worker, signal, authorized) {
    const { record, controller, settings } = runtime
    const config = worker?.config
    const revision = this.revision
    const settingsRevision = settings.revision()
    const token = config?.token
    const isActive = () => this.ready === true && !signal.aborted && !!controller && !controller.signal.aborted
      && !runtime.changing && runtime.status !== 'worker_stopped' && !!worker && !worker.paused && !worker.stopIntake
      && this.revision === revision && settings.revision() === settingsRevision && this.records.get(record.id) === record
      && record.enabled && this.runtimes.get(record.id) === runtime && runtime.record === record
      && runtime.controller === controller && runtime.worker === worker && worker.config === config
      && !!config && config.token === token && authorized() === true
    return { apiBase: this.endpoint, fetchImpl: this.fetchImpl, record, config, revision, settingsRevision, token, signal, isActive }
  }

  async #proposeWebhookChat(runtime, worker, message, requestSignal) {
    if (!(requestSignal instanceof AbortSignal) || !runtime.controller) return { status: 'ignored' }
    const signal = AbortSignal.any([requestSignal, runtime.controller.signal, this.lifetime.signal])
    const context = this.#webhookChatContext(runtime, worker, signal, () => true)
    try {
      const { config, token } = context
      if (!context.isActive() || message?.webhookChat?.kind !== 'request' || message.ambient !== false
        || !validUid(config.ownerUid) || message.sender !== config.ownerUid
        || config.groupCommands !== 'safe' || ['text-only', 'read-only'].includes(config.toolPermission)
        || !validToken(token) || !token.startsWith('bf_')) return { status: 'ignored' }
      const identity = await this.identify(token, signal)
      return await this.#webhookChat.propose({ ...context, identity }, message, { live: true })
    } catch {
      // Neither the credential nor an upstream error is a chat result.
      return { status: signal.aborted ? 'ignored' : 'unavailable' }
    }
  }

  manageWebhooks(accountId, input, requestSignal, requestAuthorized) {
    return this.locked(async () => {
      this.checkRevision(input)
      const chat = isWebhookChatAction(input?.action)
      if (chat) validateWebhookChatInput(input)
      else validateWebhookInput(input)
      const record = this.record(accountId)
      if (record.botKind === 'app') fail('app_bot_operation_unavailable')
      const runtime = this.runtimes.get(accountId)
      if (!runtime?.settings?.config) fail('channel_not_configured')
      if (runtime.changing) fail('account_transition')
      const signal = AbortSignal.any([this.lifetime.signal, ...(requestSignal ? [requestSignal] : [])])
      const context = chat && this.#webhookChatContext(runtime, runtime.worker, signal, () => requestAuthorized?.() === true)
      if (chat && !context.isActive()) fail('webhook_proposal_unavailable')
      let token
      try { token = await this.tokenFor(record) } catch { fail('invalid_bot_token') }
      if (!validToken(token)) fail('invalid_bot_token')
      if (chat && token !== context.token) fail('bot_identity_mismatch')
      const identity = await this.identify(token, signal)
      if (!sameBot(identity, record)) fail('bot_identity_mismatch')
      signal.throwIfAborted()
      const writing = input.action === 'chat_approve' || webhookWrites(input.action)
      let result
      try {
        result = chat ? await this.#webhookChat.manage({ ...context, identity }, input)
          : await administerWebhooks({ apiBase: this.endpoint, token, fetchImpl: this.fetchImpl,
            signal, record, conversations: runtime.store.overview().conversations }, input)
      } catch (error) {
        // An ambiguous direct settings write also invalidates chat approvals:
        // an upstream rotation is invisible in the webhook metadata version.
        if (writing && error?.message === 'webhook_outcome_unknown') this.revision = id()
        throw error
      }
      if (writing) this.revision = id()
      signal.throwIfAborted()
      // Deliberately no overview(), persistence, logger, vault writes or worker
      // publication. Only the authenticated HTTP caller gets this result.
      return { accountId, accountRevision: this.revision, ...result }
    })
  }

  reconnect(accountId, input) {
    return this.locked(async () => {
      this.checkRevision(input)
      const record = this.record(accountId)
      const runtime = this.runtimes.get(accountId)
      if (!record.enabled || !runtime) fail('channel_not_configured')
      await this.changeConnection(runtime)
      return this.overview()
    })
  }

  remove(accountId, input) {
    return this.locked(async () => {
      this.checkRevision(input)
      const record = this.record(accountId)
      const runtime = this.runtimes.get(accountId)
      if (runtime?.changing) fail('account_transition')
      const tombstone = { ...record, removed: true, enabled: false, secretRef: undefined }
      this.persist(tombstone)
      if (runtime) {
        runtime.record = tombstone
        await this.changeConnection(runtime, { removing: true, priorSecret: record.secretRef })
      } else if (record.secretRef) await this.vault?.unset?.(record.secretRef).catch(() => {})
      return this.overview()
    })
  }
}
