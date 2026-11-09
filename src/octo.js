import { setTimeout as delay } from 'node:timers/promises'
import { ruleScope } from './rules.js'

const maxBody = 1024 * 1024

export class OctoError extends Error {
  constructor(code, status = 0, retryAfterMs = 0) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function decimalId(value) {
  const s = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  return /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n ? s : undefined
}

export function readJson(text) {
  // Octo sends Go int64 IDs as JSON numbers. Preserve the original digits.
  return JSON.parse(text, (key, value, context) => {
    if (['event_id', 'message_id'].includes(key) && typeof value === 'number') return context.source
    return value
  })
}

async function boundedJson(response) {
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0, content = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBody) throw new OctoError('response_too_large')
      content += decoder.decode(value, { stream: true })
    }
    content += decoder.decode()
    return content ? readJson(content) : null
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export class OctoClient {
  #token
  constructor({ apiBase, token, waitSeconds, fetchImpl = fetch }) {
    this.base = apiBase
    this.#token = token
    this.wait = waitSeconds
    this.fetch = fetchImpl
  }

  async #request(path, body, signal, { timeout = 15_000, auth = true } = {}) {
    try {
      const response = await this.fetch(this.base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(auth && { Authorization: 'Bearer ' + this.#token }) },
        body, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        const header = response.headers.get('retry-after')
        const seconds = header === null ? 0 : Number(header)
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
        throw new OctoError('http_' + response.status, response.status, Number.isFinite(ms) ? Math.max(0, ms) : 0)
      }
      return await boundedJson(response)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof OctoError) throw error
      throw new OctoError('transport_or_invalid_response')
    }
  }

  async verify(botUid, spaceId, signal) {
    const result = await this.#request('/v1/auth/verify-bot', JSON.stringify({ bot_token: this.#token }), signal, { auth: false })
    if (result?.bot_uid !== botUid || result?.space_id !== spaceId) throw new OctoError('bot_identity_mismatch')
  }

  async events(signal) {
    const started = Date.now()
    const result = await this.#request('/v1/bot/events', JSON.stringify({ event_id: 0, limit: 20, wait: this.wait }), signal, {
      timeout: (this.wait + 10) * 1000,
    })
    if (result?.status !== 1 || (result.results !== null && !Array.isArray(result.results))) {
      throw new OctoError('invalid_events_response')
    }
    const batch = result.results ?? []
    if (!batch.length && Date.now() - started < 750) await delay(750, undefined, { signal })
    return batch
  }

  async ack(id, signal) {
    if (!decimalId(id)) throw new OctoError('invalid_event_id')
    const result = await this.#request('/v1/bot/events/' + id + '/ack', '{}', signal)
    if (result?.status !== 200) throw new OctoError('invalid_ack_response')
  }

  async send(recipient, text, signal, channelType = 1) {
    if (![1, 2, 5].includes(channelType)) throw new OctoError('invalid_channel_type')
    const result = await this.#request('/v1/bot/sendMessage', JSON.stringify({
      channel_id: recipient, channel_type: channelType, payload: { type: 1, content: text },
    }), signal)
    const id = decimalId(result?.message_id)
    if (!id) throw new OctoError('send_result_unconfirmed')
    return id
  }

  async rules(type, address, threadRuleMode, signal) {
    const scope = ruleScope(type, address)
    if (!scope) throw new OctoError('invalid_rule_scope')
    const root = '/v1/bot/groups/' + encodeURIComponent(scope.group)
    const read = async (kind, path) => {
      const doc = await this.#request(path, undefined, signal, { timeout: 8000 })
      if (typeof doc?.content !== 'string' || !Number.isSafeInteger(doc.version) || doc.version < 0
        || Buffer.byteLength(doc.content, 'utf8') > 10_240) throw new OctoError('invalid_rule_document')
      const markdown = doc.content.trim() ? doc.content : ''
      return { kind, version: doc.version, status: markdown ? 'present' : 'empty', markdown }
    }
    if (!scope.thread) return [await read('group', root + '/md')]
    // Verify the topic endpoint first; a failure must not fall back to parent rules.
    const thread = await read('thread', root + '/threads/' + scope.thread + '/md')
    return threadRuleMode === 'inherit-group'
      ? [await read('group', root + '/md'), thread]
      : [thread]
  }
}

export function permitsRoute(config, sender, channelType, channelId) {
  if (sender === config.botUid || !config.allowed.has(sender)) return false
  if (channelType === 1) return channelId === sender
  if (channelType === 2) return config.groups?.has(channelId) === true
  if (channelType === 5) return config.threads?.has(channelId) === true
  return false
}

export function admit(event, config) {
  const message = event?.message
  const sender = message?.from_uid
  const text = typeof message?.payload?.content === 'string' ? message.payload.content.trim() : ''
  const messageId = decimalId(message?.message_id)
  const channelType = message?.channel_type
  const channelId = channelType === 1 ? sender : message?.channel_id
  if (!messageId || event.event_type || message.payload?.type !== 1
    || !permitsRoute(config, sender, channelType, channelId)
    || (message.payload.space_id != null && message.payload.space_id !== config.spaceId)
    || !text || text.startsWith('/') || Buffer.byteLength(text, 'utf8') > 8000) return
  if (channelType !== 1) {
    const mention = message.payload.mention
    const broadcast = [mention?.all, mention?.ais, mention?.humans].some(flag => flag === 1 || flag === true)
    if (broadcast || !Array.isArray(mention?.uids) || !mention.uids.includes(config.botUid)) return
  }
  // For a DM the raw channel ID is not necessarily the recipient's UID. Group
  // and topic replies use the original channel address, never the sender UID.
  return { messageId, sender, text, channelId, channelType }
}
