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
    const heartbeatStop = new AbortController()
    const heartbeatSignal = AbortSignal.any([signal, heartbeatStop.signal])
    let heartbeat
    const stop = () => { heartbeatStop.abort(); ended(); void conn.close() }
    signal.addEventListener('abort', stop, { once: true })
    let backoff = 0
    try {
      const registration = await api.register(botUid, signal)
      signal.throwIfAborted()
      await conn.connect(registration)
      const connectedAt = Date.now()
      log('octo_ws_connected')
      // REST presence is separate from socket PING/PONG. A failed beat must not
      // tear down a working connection, and a disconnected socket must not beat.
      if (typeof api.heartbeat === 'function') heartbeat = (async () => {
        while (!heartbeatSignal.aborted) {
          if (conn.connected === false) break
          try { await api.heartbeat(heartbeatSignal) }
          catch { if (!heartbeatSignal.aborted) log('octo_heartbeat_unavailable') }
          try { await delay(30_000, undefined, { signal: heartbeatSignal }) } catch { break }
        }
      })()
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
      heartbeatStop.abort()
      await heartbeat
      signal.removeEventListener('abort', stop)
      await conn.close()
    }
    if (!signal.aborted) await pause(backoff, undefined, { signal })
  }
}
