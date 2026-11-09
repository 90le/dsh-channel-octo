import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { ruleScope } from './rules.js'

const maxBody = 1024 * 1024
const flag = (value) => value === 1 || value === true
const memberList = (value, field) => {
  if (Array.isArray(value) || value === null) return value ?? []
  if (Array.isArray(value?.[field])) return value[field]
  throw new OctoError('invalid_access_response')
}

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

  async register(botUid, signal) {
    const data = await this.#request('/v1/bot/register', '{}', signal)
    if (data?.robot_id !== botUid || typeof data.im_token !== 'string' || !data.im_token
      || typeof data.ws_url !== 'string') throw new OctoError('invalid_bot_registration')
    const url = URL.parse(data.ws_url)
    const loopback = url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (!url || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))
      || url.username || url.password || url.hash) throw new OctoError('invalid_ws_url')
    return { robot_id: botUid, im_token: data.im_token, ws_url: url.href }
  }

  async allowsMessage(config, job, signal) {
    const { sender, channel_type: type, ambient } = job
    const address = job.channel_id ?? sender
    if (type === 1) {
      if (config.senderPolicy !== 'octo') return true
      if (sender.includes('@')) return false // Octo's internal DM channel separator
      // Use the bot's ordinary history gate: it enforces friend/owner policy
      // without OBO. Request at most one record and never use its content.
      const result = await this.#request('/v1/bot/messages/sync', JSON.stringify({
        channel_id: sender, channel_type: 1, start_message_seq: 0, end_message_seq: 0, limit: 1, pull_mode: 0,
      }), signal, { timeout: 5000 })
      if (result?.messages !== null && !Array.isArray(result?.messages)) throw new OctoError('invalid_access_response')
      return true
    }
    const scope = ruleScope(type, address)
    if (!scope) return false
    const root = '/v1/bot/groups/' + encodeURIComponent(scope.group)
    if (ambient) {
      if (config.mentionPolicy !== 'octo') return false
      const pref = await this.#request(root + '/mention_pref', undefined, signal, { timeout: 3000 })
      if ((pref?.group_allow_no_mention !== undefined && !flag(pref.group_allow_no_mention))
        || !flag(pref?.effective ?? pref?.no_mention)) return false
    }
    if (config.channelPolicy === 'joined') {
      const query = new URLSearchParams({ space_id: config.spaceId })
      const groups = memberList(await this.#request('/v1/bot/groups?' + query, undefined, signal, { timeout: 5000 }), 'groups')
      if (!groups.some(g => g?.group_no === scope.group && g.space_id === config.spaceId)) return false
    }
    if (ambient || config.senderPolicy === 'octo' || config.channelPolicy === 'joined') {
      const members = memberList(await this.#request(root + '/members', undefined, signal, { timeout: 5000 }), 'members')
      const actor = members.find(m => m?.uid === sender)
      // Do not auto-trigger other bots or unknown member kinds.
      if (!actor || ((ambient || config.senderPolicy === 'octo') && actor.robot !== 0 && actor.robot !== false)
        || !members.some(m => m?.uid === config.botUid)) return false
    }
    return true
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

  async cardProfile(signal) {
    return this.#request('/v1/bot/card/profile', undefined, signal, { timeout: 2000 })
  }

  async typing(route, signal) {
    await this.#request('/v1/bot/typing', JSON.stringify(route), signal, { timeout: 2000 })
  }

  async progressCard(route, frame, signal) {
    const result = await this.#request('/v1/bot/sendMessage', JSON.stringify({
      ...route, client_msg_no: randomUUID().replaceAll('-', ''), payload: { type: 17, ...frame },
    }), signal, { timeout: 2500 })
    const id = decimalId(result?.message_id)
    if (!id) throw new OctoError('card_send_unconfirmed')
    return id
  }

  async editProgress(route, id, frame, seq, transient, signal) {
    const update = { card_seq: seq, ...(transient ? { transient: true } : {}) }
    await this.#request('/v1/bot/message/edit', JSON.stringify({
      ...route, message_id: id, ...(frame.template_ref
        ? { ...frame, ...update }
        : { content_edit: JSON.stringify({ type: 17, ...frame, ...update }) }),
    }), signal, { timeout: 2500 })
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
  if (typeof sender !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(sender) || sender === config.botUid
    || (config.senderPolicy !== 'octo' && !config.allowed.has(sender))) return false
  if (channelType === 1) return channelId === sender
  if (config.channelPolicy === 'joined') return !!ruleScope(channelType, channelId)
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
  if (!messageId || event.event_type || message.payload?.type !== 1 || message.payload?.event != null
    || !permitsRoute(config, sender, channelType, channelId)
    || (message.payload.space_id != null && message.payload.space_id !== config.spaceId)
    || !text || text.startsWith('/') || Buffer.byteLength(text, 'utf8') > 8000) return
  let ambient = false
  if (channelType !== 1) {
    const mention = message.payload.mention
    if (mention != null && (typeof mention !== 'object' || Array.isArray(mention))) return
    if ([mention?.all, mention?.ais, mention?.humans].some(flag)) return
    if (mention?.uids != null && !Array.isArray(mention.uids)) return
    const targets = mention?.uids ?? []
    if (!targets.includes(config.botUid)) {
      if (config.mentionPolicy !== 'octo' || targets.length || /(?:^|\s)[@＠]\S/u.test(text)) return
      ambient = true
    }
  }
  // For a DM the raw channel ID is not necessarily the recipient's UID. Group
  // and topic replies use the original channel address, never the sender UID.
  return { messageId, sender, text, channelId, channelType, ambient }
}
