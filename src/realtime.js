import { setTimeout as delay } from 'node:timers/promises'
import { OctoError } from './octo.js'
import { WukongConnection } from './wukong.js'

const codeOf = (error) => {
  if (error instanceof OctoError) return error.code
  return /^IM_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'connection_failed'
}

export async function receiveRealtime({ api, botUid, accept, signal, log, makeConnection, pause = delay }) {
  let failures = 0
  while (!signal.aborted) {
    let ended
    const disconnected = new Promise(resolve => { ended = resolve })
    const conn = makeConnection?.(accept, ended) ?? new WukongConnection(accept, ended)
    const stop = () => { ended(); void conn.close() }
    signal.addEventListener('abort', stop, { once: true })
    let backoff = 0
    try {
      const registration = await api.register(botUid, signal)
      signal.throwIfAborted()
      await conn.connect(registration)
      const connectedAt = Date.now()
      log('octo_ws_connected')
      const error = await disconnected
      if (signal.aborted) break
      if (Date.now() - connectedAt >= 30_000) failures = 0
      throw error ?? new Error('IM_DISCONNECTED')
    } catch (error) {
      if (signal.aborted) break
      if (error?.retryable === false || (error instanceof OctoError && (
        [401, 403].includes(error.status) || ['invalid_bot_registration', 'invalid_ws_url'].includes(error.code)
      ))) throw new OctoError('ws_' + codeOf(error))
      failures++
      backoff = Math.max(error?.retryAfterMs ?? 0, Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)))
      log('octo_ws_retry_' + codeOf(error))
    } finally {
      signal.removeEventListener('abort', stop)
      await conn.close()
    }
    if (!signal.aborted) await pause(backoff, undefined, { signal })
  }
}
