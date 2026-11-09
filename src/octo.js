import { setTimeout as delay } from 'node:timers/promises'
import { validUid, validBotIdentity } from './config.js'
import { randomUUID } from 'node:crypto'
import { ruleScope } from './rules.js'
import { normalizeOctoContent } from './octo-content.js'
import { parseSafeCommand } from './im-controls.js'
import { ChannelApi, ChannelApiError } from './channel-api.js'
import { OctoError, readApiError } from './api-errors.js'

export { OctoError } from './api-errors.js'

const maxBody = 1024 * 1024
const flag = (value) => value === 1 || value === true
const memberList = (value, field) => {
  if (Array.isArray(value) || value === null) return value ?? []
  if (Array.isArray(value?.[field])) return value[field]
  throw new OctoError('invalid_access_response')
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
  #appRegistration
  constructor(config) {
    const { apiBase, token, waitSeconds, fetchImpl = fetch } = config
    this.base = apiBase
    this.#token = token
    this.wait = waitSeconds
    this.fetch = fetchImpl
    this.configureChannel(config)
  }

  configureChannel(config) {
    const next = validBotIdentity(config)
      ? new ChannelApi({ config, request: (path, body, signal, options) => this.#request(path, body, signal, options) })
      : undefined
    this.channel?.revoke()
    this.channel = next
  }

  async #request(path, body, signal, { timeout = 15_000, auth = true, method, multipart = false,
    invalidResponseCode = 'invalid_api_response' } = {}) {
    try {
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)])
      const response = await this.fetch(this.base + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
        headers: { ...(body !== undefined && !multipart && { 'Content-Type': 'application/json' }), ...(auth && { Authorization: 'Bearer ' + this.#token }) },
        body, signal: requestSignal,
      })
      if (!response.ok) throw await readApiError(response, requestSignal)
      const result = await boundedJson(response)
      // The reviewed official facade does not emit errors on HTTP 200. Reject
      // error-shaped successes generically, without granting their body authority.
      if (result && !Array.isArray(result) && (result.error != null || result.ok === false
        || Number.isInteger(result.status) && result.status >= 400)) {
        throw new OctoError(invalidResponseCode, response.status)
      }
      return result
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error instanceof OctoError) throw error
      throw new OctoError('transport_or_invalid_response')
    }
  }

  async transcribe(attachment, mode, signal) {
    if (!this.#token.startsWith('bf_')) throw new OctoError('voice_requires_user_bot')
    if (!['append', 'edit'].includes(mode) || !(attachment?.bytes instanceof Uint8Array)
      || !attachment.bytes.byteLength || attachment.bytes.byteLength > 16 * 1024 * 1024
      || !/^audio\/[a-z0-9][a-z0-9.+_-]{0,70}$/i.test(attachment.mime ?? '')) throw new OctoError('invalid_voice_attachment')
    const name = typeof attachment.name === 'string' ? attachment.name.split(/[/\\]/).at(-1)
      .replace(/[\x00-\x1f\x7f"<>]/g, '_').slice(0, 160) : 'recording'
    const form = new FormData()
    // Bot adapter forwards multipart keys unchanged. The actual speech service
    // requires "audio"; its proxy unit fixture's "file" key is not sufficient.
    form.set('audio', new Blob([attachment.bytes], { type: attachment.mime }), name || 'recording')
    form.set('mode', mode)
    const result = await this.#request('/v1/bot/voice/transcribe', form, signal, {
      multipart: true, timeout: 60_000, invalidResponseCode: 'invalid_voice_transcript',
    })
    if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 24_000
      || result.status != null && result.status !== 200) throw new OctoError('invalid_voice_transcript')
    return { text: result.text, mode }
  }

  async identify(signal) {
    if (this.#token.startsWith('app_')) {
      const data = await this.#registration(signal)
      if (!validBotIdentity({ botUid: data.robot_id, botKind: 'app', spaceId: null })
        || !validUid(data.owner_uid) || data.owner_uid === data.robot_id
        || data.owner_uid.includes(this.#token)) throw new OctoError('invalid_bot_identity')
      // App Bot registration is the official identity/WS bootstrap. It does not
      // disclose its platform/Space scope. Never manufacture a verified Space.
      this.#appRegistration = data
      return { botUid: data.robot_id, botKind: 'app', spaceId: null, ownerUid: data.owner_uid }
    }
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

  async #registration(signal) {
    const data = await this.#request('/v1/bot/register', '{}', signal)
    if (!validUid(data?.robot_id) || data.robot_id.includes(this.#token) || typeof data.im_token !== 'string' || !data.im_token
      || typeof data.ws_url !== 'string') throw new OctoError('invalid_bot_registration')
    const url = URL.parse(data.ws_url)
    const loopback = url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (!url || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))
      || url.username || url.password || url.hash) throw new OctoError('invalid_ws_url')
    return { robot_id: data.robot_id, im_token: data.im_token, ws_url: url.href, owner_uid: data.owner_uid }
  }

  async register(botUid, signal) {
    signal?.throwIfAborted()
    const data = this.#appRegistration ?? await this.#registration(signal)
    this.#appRegistration = undefined
    if (data.robot_id !== botUid) throw new OctoError('invalid_bot_registration')
    return { robot_id: botUid, im_token: data.im_token, ws_url: data.ws_url }
  }

  async allowsMessage(config, job, signal) {
    const { sender, channel_type: type, ambient } = job
    const address = job.channel_id ?? sender
    const app = this.#token.startsWith('app_')
    if (app && (type !== 1 || address !== sender || !validUid(sender) || sender.includes('@') || sender === config.botUid)) return false
    if (type === 1) {
      if (config.senderPolicy !== 'octo' && !app) return true
      if (sender.includes('@')) return false // Octo's internal DM channel separator
      if (app) {
        const people = await this.#request('/v1/bot/users/batch', JSON.stringify({ uids: [sender] }), signal, { timeout: 5000 })
        if (!Array.isArray(people?.users) || people.users.length !== 1 || !Array.isArray(people.missing_uids)
          || people.missing_uids.length || people.users[0]?.uid !== sender
          || people.users[0].status !== 1 || people.users[0].robot !== 0) return false
      }
      // Use the bot's ordinary history gate: it enforces friend/owner policy
      // without OBO. Request at most one record and never use its content.
      const result = await this.#request('/v1/bot/messages/sync', JSON.stringify({
        channel_id: sender, channel_type: 1, start_message_seq: 0, end_message_seq: 0, limit: 1, pull_mode: 0,
      }), signal, { timeout: 5000 })
      if (result?.messages !== null && !Array.isArray(result?.messages)) throw new OctoError('invalid_access_response')
      if (app) {
        let sourceId = decimalId(job.message_id)
        if (!sourceId && job.metadata) {
          try {
            const meta = JSON.parse(job.metadata)
            sourceId = decimalId((meta.cardAction ?? meta.deferredForm)?.sourceMessageId)
          } catch {}
        }
        if (!sourceId || !this.channel) return false
        try { await this.channel.appMessage({ channel_id: sender, channel_type: 1 }, sender, sourceId, signal) }
        catch (error) {
          if (error instanceof ChannelApiError && ['api_permission_denied', 'api_not_found', 'message_unavailable',
            'message_outside_channel'].includes(error.code)) return false
          throw error
        }
      }
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
    if (config.botKind === 'app' && type !== 1) throw new OctoError('invalid_history_scope')
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
      if (config.botKind === 'app') {
        const verified = await this.channel.appMessage(route, id, messageId, signal)
        if (verified.text.trim()) rows.push({ seq: verified.message_seq, messageId, sender: verified.from_uid,
          text: Array.from(verified.text).slice(0, 280).join('') })
        seenSeq.add(seq); seenId.add(messageId)
        continue
      }
      let payload = item.payload
      if (typeof payload === 'string') {
        if (payload.length > 120_000) continue
        try {
          payload = readJson(payload.trimStart().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8'))
        } catch { continue }
      }
      if (!payload || payload.event != null || !matchesMessageSpace(config, payload)) continue
      const content = normalizeOctoContent(payload)
      if (!content?.text?.trim()) continue
      seenSeq.add(seq)
      seenId.add(messageId)
      rows.push({ seq, messageId, sender: validUid(item.from_uid) ? item.from_uid : 'unknown',
        text: Array.from(content.text).slice(0, 280).join('') })
    }
    return { rows: rows.sort((a, b) => a.seq - b.seq).slice(-20), more: flag(data.more) || (data.messages?.length ?? 0) >= 20 }
  }

  async inboxPage(config, route, start, through, signal) {
    const { channel_type: type, channel_id: id } = route
    if (![1, 2, 5].includes(type) || (type === 1 ? !validUid(id) || id.includes('@') : !ruleScope(type, id))
      || !Number.isInteger(start) || start < 0 || start > 0xffffffff
      || through != null && (!channelSequence(through) || start > through)) throw new OctoError('invalid_inbox_scope')
    const latest = through == null
    const data = await this.#request('/v1/bot/messages/sync', JSON.stringify({
      channel_type: type, channel_id: id, start_message_seq: latest ? 0 : start,
      end_message_seq: latest || through === 0xffffffff ? 0 : through + 1,
      pull_mode: latest ? 0 : 1, limit: latest ? 1 : 100,
    }), signal, { timeout: 8000 })
    if (!data || data.messages !== null && !Array.isArray(data.messages)
      || data.messages?.length > (latest ? 1 : 100)) throw new OctoError('invalid_inbox_response')
    const seen = new Set(), ids = new Set(), messages = [], suppressed = []
    let last = 0
    for (const row of data.messages ?? []) {
      const seq = channelSequence(row?.message_seq), messageId = decimalId(row?.message_id)
      if (!seq || !messageId || seen.has(seq) || ids.has(messageId) || !latest && (seq < start || seq > through)
        || row.channel_type != null && row.channel_type !== type
        || type !== 1 && row.channel_id != null && row.channel_id !== id
        || type === 1 && row.from_uid !== id && row.from_uid !== config.botUid) throw new OctoError('invalid_inbox_response')
      seen.add(seq); ids.add(messageId); last = Math.max(last, seq)
      if (latest) continue
      if ([row.revoke, row.revoked, row.is_deleted, row.extra?.revoke, row.message_extra?.revoke].some(flag)) { suppressed.push(messageId); continue }
      let payload = row.message_extra?.content_edit ?? row.extra?.content_edit ?? row.payload
      if (typeof payload === 'string') {
        if (payload.length > 120_000) { suppressed.push(messageId); continue }
        try { payload = readJson(payload.trimStart().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8')) }
        catch { suppressed.push(messageId); continue }
      }
      const m = admit({ message: { message_id: messageId, message_seq: seq, from_uid: row.from_uid,
        channel_type: type, channel_id: id, payload } }, config)
      if (m) messages.push(m)
      else suppressed.push(messageId)
    }
    return { last, messages: messages.sort((a, b) => a.messageSeq - b.messageSeq), count: seen.size, observed: [...ids], suppressed }
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

  async send(recipient, text, signal, channelType = 1, replyTo, mention) {
    return this.sendPayload({ channel_id: recipient, channel_type: channelType },
      { type: 1, content: text, ...(mention && { mention }) }, signal, replyTo)
  }

  async sendPayload(route, payload, signal, replyTo) {
    if (![1, 2, 5].includes(route.channel_type)) throw new OctoError('invalid_channel_type')
    // Web/Electron renders any reply object as a quotation. An ID alone leaves
    // an empty bar and an undefined navigation target. Only send a usable quote.
    const reply = replyTo && typeof replyTo === 'object' && decimalId(replyTo.message_id)
      && channelSequence(replyTo.message_seq) && validUid(replyTo.from_uid)
      && typeof replyTo.from_name === 'string' && replyTo.from_name.trim()
      && replyTo.payload?.type === 1 && typeof replyTo.payload.content === 'string' && replyTo.payload.content.trim()
      ? replyTo : undefined
    const result = await this.#request('/v1/bot/sendMessage', JSON.stringify({
      channel_id: route.channel_id, channel_type: route.channel_type,
      payload: reply ? { ...payload, reply } : payload,
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

  async heartbeat(signal) {
    await this.#request('/v1/bot/heartbeat', '{}', signal, { timeout: 5000 })
  }

  async readReceipt(route, messageId, signal) {
    if (!decimalId(messageId)) return
    await this.#request('/v1/bot/readReceipt', JSON.stringify({ ...route, message_ids: [messageId] }), signal, { timeout: 2000 })
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
  if (config.botKind === 'app') return false
  if (config.channelPolicy === 'joined') return !!ruleScope(channelType, channelId)
  if (channelType === 2) return config.groups?.has(channelId) === true
  if (channelType === 5) return config.threads?.has(channelId) === true
  return false
}

// App Bot scope is enforced by Octo; the register DTO does not attest a Space.
// The existing User Bot binding remains pinned to its verified Space.
function matchesMessageSpace(config, payload) {
  return config.botKind === 'app'
    ? payload.space_id == null || validUid(payload.space_id)
    : payload.space_id == null || payload.space_id === config.spaceId
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
    || !payload || !matchesMessageSpace(config, payload)) return
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
