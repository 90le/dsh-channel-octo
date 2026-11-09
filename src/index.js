import { resolveConfig } from './config.js'
import { DshHost } from './dsh.js'
import { OctoClient, OctoError } from './octo.js'
import { Store } from './store.js'
import { Worker } from './worker.js'
import { loadSettings, registerWeb } from './web.js'

export const name = 'dsh-channel-octo'
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'tools', 'systemPrompt']

export function apply(ctx, settings = {}) {
  const status = { status: 'disabled' }
  ctx.inject(['webServer'], (web) => { web.effect(() => registerWeb(web, status)) })
  if (settings.enabled !== true) return
  const log = ctx.logger(name)
  let config
  try {
    config = resolveConfig(settings)
  } catch {
    status.status = 'invalid_configuration'
    log.error('invalid_configuration: check API URL, Bot/Space, UID allowlist, token environment and directories')
    return
  }
  ctx.effect(() => {
    const lifetime = new AbortController()
    const identity = JSON.stringify([config.apiBase, config.spaceId, config.botUid])
    let store
    status.status = 'connecting'
    try {
      store = new Store(config.stateDir, identity)
      status.settings = loadSettings({ ...settings, transport: config.transport }, config.stateDir)
      status.store = store
    } catch {
      store?.close()
      status.status = 'configuration_or_state_error'
      log.error('state_open_failed: check private directory, web settings, Bot binding and single worker')
      return () => {}
    }
    let workspace
    const attach = async id => {
      try {
        const registry = ctx.get('workspaceRegistry')
        if (!registry || registry.archivedSessionIds?.includes(id)) return
        workspace ??= await registry.create(config.cwd, 'Octo')
        await workspace.attachSession(id)
      } catch { log.info('workspace_attach_failed') }
    }
    const worker = new Worker({
      api: new OctoClient(config), store,
      host: new DshHost(ctx, config.cwd, config.timeoutMs),
      config: status.settings.config,
      attach,
      log: (line) => {
        if (line === 'octo_ws_connected' || line === 'octo_poll_ok') status.status = 'online'
        else if (line.startsWith('octo_ws_retry_') || line.startsWith('octo_poll_')) status.status = 'reconnecting'
        if (line !== 'octo_poll_ok') log.info(line)
      },
    })
    const stopped = (async () => {
      for (const row of store.overview().conversations) {
        if (lifetime.signal.aborted) return
        await attach(row.id)
      }
      await worker.run(lifetime.signal)
    })().catch((error) => {
      if (!lifetime.signal.aborted) {
        status.status = 'worker_stopped'
        log.error('worker_stopped: ' + (error instanceof OctoError ? error.code : 'internal_error'))
      }
    }).finally(() => { status.store = null; store.close() })
    void stopped.catch(() => log.error('state_close_failed'))
    return async () => { lifetime.abort(); await stopped.catch(() => {}) }
  }, 'dsh-channel-octo.worker')
}
