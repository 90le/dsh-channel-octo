import { setTimeout as delay } from 'node:timers/promises'
import { validUid } from './config.js'
import { randomUUID } from 'node:crypto'
import { ruleScope } from './rules.js'
import { normalizeOctoContent } from './octo-content.js'
import { parseSafeCommand } from './im-controls.js'

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

export function channelSequence(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : undefined
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

  async identify(signal) {
    const result = await this.#request('/v1/auth/verify-bot', JSON.stringify({ bot_token: this.#token }), signal,
      { auth: false, timeout: 8000 })
    if (!validUid(result?.bot_uid) || !validUid(result?.space_id)
      || result.bot_uid.includes(this.#token) || result.space_id.includes(this.#token)) {
      throw new OctoError('invalid_bot_identity')
    }
    return { botUid: result.bot_uid, spaceId: result.space_id,
      ...(validUid(result.owner_uid) && result.owner_uid !== result.bot_uid && { ownerUid: result.owner_uid }) }
  }

  async verify(botUid, spaceId, signal) {
    const result = await this.identify(signal)
    if (result.botUid !== botUid || result.spaceId !== spaceId) throw new OctoError('bot_identity_mismatch')
    return result
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

  async recentMessages(config, route, before, signal) {
    const type = route.channel_type, id = route.channel_id
    if (![1, 2, 5].includes(type) || (type === 1 ? !validUid(id) || id.includes('@') : !ruleScope(type, id))) {
      throw new OctoError('invalid_history_scope')
    }
    const end = channelSequence(before)
    if (end === 1) return { rows: [], more: false }
    const data = await this.#request('/v1/bot/messages/sync', JSON.stringify({
      ...route, start_message_seq: end ? end - 1 : 0, end_message_seq: 0, pull_mode: 0, limit: 20,
    }), signal, { timeout: 4500 })
    if (data?.messages !== null && !Array.isArray(data?.messages)) throw new OctoError('invalid_history_response')
    const rows = []
    const seenSeq = new Set(), seenId = new Set()
    for (const item of (data.messages ?? []).slice(0, 60)) {
      const seq = channelSequence(item?.message_seq), messageId = decimalId(item?.message_id)
      if (!seq || end && seq >= end || !messageId || seenId.has(messageId) || seenSeq.has(seq)
        || item.channel_type != null && item.channel_type !== type
        || type !== 1 && item.channel_id != null && item.channel_id !== id
        || type === 1 && item.from_uid !== id && item.from_uid !== config.botUid
        || [item.revoke, item.revoked, item.is_deleted, item.extra?.revoke, item.message_extra?.revoke].some(flag)) continue
      let payload = item.payload
      if (typeof payload === 'string') {
        if (payload.length > 120_000) continue
        try {
          payload = readJson(payload.trimStart().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8'))
        } catch { continue }
      }
      if (!payload || payload.event != null || (payload.space_id != null && payload.space_id !== config.spaceId)) continue
      const content = normalizeOctoContent(payload)
      if (!content?.text?.trim()) continue
      seenSeq.add(seq)
      seenId.add(messageId)
      rows.push({ seq, messageId, sender: validUid(item.from_uid) ? item.from_uid : 'unknown',
        text: Array.from(content.text).slice(0, 280).join('') })
    }
    return { rows: rows.sort((a, b) => a.seq - b.seq).slice(-20), more: flag(data.more) || (data.messages?.length ?? 0) >= 20 }
  }

  async events(signal, cursor = '0') {
    const started = Date.now()
    if (cursor !== '0' && !decimalId(cursor)) throw new OctoError('invalid_event_id')
    const result = await this.#request('/v1/bot/events', '{"event_id":' + cursor
      + ',"limit":20,"wait":' + JSON.stringify(this.wait) + '}', signal, {
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

  async send(recipient, text, signal, channelType = 1, replyTo) {
    return this.sendPayload({ channel_id: recipient, channel_type: channelType }, { type: 1, content: text }, signal, replyTo)
  }

  async sendPayload(route, payload, signal, replyTo) {
    if (![1, 2, 5].includes(route.channel_type)) throw new OctoError('invalid_channel_type')
    const id = decimalId(replyTo)
    const result = await this.#request('/v1/bot/sendMessage', JSON.stringify({
      channel_id: route.channel_id, channel_type: route.channel_type,
      payload: id ? { ...payload, reply: { message_id: id } } : payload,
    }), signal)
    const sent = decimalId(result?.message_id)
    if (!sent) throw new OctoError('send_result_unconfirmed')
    return sent
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
  const payload = message?.payload
  const messageId = decimalId(message?.message_id)
  const channelType = message?.channel_type
  const channelId = channelType === 1 ? sender : message?.channel_id
  if (!messageId || event.event_type || payload?.event != null
    || !permitsRoute(config, sender, channelType, channelId)
    || !payload || (payload.space_id != null && payload.space_id !== config.spaceId)) return
  const content = normalizeOctoContent(payload, config)
  if (!content) return
  const { text, attachment, attachments, parts } = content
  const messageSeq = channelSequence(message.message_seq)
  const quoteId = !Number.isInteger(payload.reply?.payload?.type) ? decimalId(payload.reply?.message_id) : undefined
  let ambient = false
  let mention = payload.mention
  if (channelType !== 1) {
    if (mention != null && (typeof mention !== 'object' || Array.isArray(mention))) return
    if ([mention?.all, mention?.ais, mention?.humans].some(flag)) return
    if (mention?.uids != null && !Array.isArray(mention.uids)
      || mention?.entities != null && !Array.isArray(mention.entities)) return
    // New Octo clients carry the targeted UIDs in UTF-16 mention entities.
    // Like the official adapter, prefer valid entities and fall back to uids.
    const entities = (mention?.entities ?? []).slice(0, 100).flatMap(entry => validUid(entry?.uid) ? [entry.uid] : [])
    const targets = [...new Set(entities.length ? entities : (mention?.uids ?? []).slice(0, 100))]
    if (mention) mention = { ...mention, uids: targets }
    if (!targets.includes(config.botUid)) {
      if (config.mentionPolicy !== 'octo' || targets.length || /(?:^|\s)[@＠]\S/u.test(text)) return
      ambient = true
    }
  }
  // For a DM the raw channel ID is not necessarily the recipient's UID. Group
  // and topic replies use the original channel address, never the sender UID.
  const command = payload.type === 1 ? parseSafeCommand(text, config, {
    routeAllowed: true, channelType, hasAttachments: !!(attachment || attachments?.length || parts), botUid: config.botUid, mention,
    actorApproved: sender === config.ownerUid || config.allowed.has(sender), isBotOwner: sender === config.ownerUid,
  }) : { kind: 'text' }
  if (command.kind === 'blocked' || (command.kind === 'command' && payload.type !== 1)) return
  return { messageId, sender, text, channelId, channelType, ambient,
    ...(messageSeq && { messageSeq }), ...(quoteId && { quoteId }),
    ...(attachment && { attachment }), ...(attachments && { attachments }), ...(parts && { parts }), ...(command.kind === 'command' && { command: command.command }) }
}
