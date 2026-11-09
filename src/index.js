import { resolveConfig } from './config.js'
import { DshHost } from './dsh.js'
import { OctoClient, OctoError } from './octo.js'
import { Store } from './store.js'
import { Worker } from './worker.js'

export const name = 'dsh-channel-octo'
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'tools', 'systemPrompt']

export function apply(ctx, settings = {}) {
  if (settings.enabled !== true) return
  const log = ctx.logger(name)
  let config
  try {
    config = resolveConfig(settings)
  } catch {
    log.error('invalid_configuration: check API URL, Bot/Space, UID allowlist, token environment and directories')
    return
  }
  ctx.effect(() => {
    const lifetime = new AbortController()
    const identity = JSON.stringify([config.apiBase, config.spaceId, config.botUid])
    let store
    try {
      store = new Store(config.stateDir, identity)
    } catch {
      log.error('state_open_failed: check private directory, Bot binding and single worker')
      return () => {}
    }
    const worker = new Worker({
      api: new OctoClient(config), store,
      host: new DshHost(ctx, config.cwd, config.timeoutMs),
      config, log: (line) => log.info(line),
    })
    const stopped = worker.run(lifetime.signal).catch((error) => {
      if (!lifetime.signal.aborted) log.error('worker_stopped: ' + (error instanceof OctoError ? error.code : 'internal_error'))
    }).finally(() => store.close())
    void stopped.catch(() => log.error('state_close_failed'))
    return async () => { lifetime.abort(); await stopped.catch(() => {}) }
  }, 'dsh-channel-octo.worker')
}
