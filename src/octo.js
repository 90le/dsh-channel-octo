import { setTimeout as delay } from 'node:timers/promises'
import { validUid, validBotIdentity } from './config.js'
import { randomUUID } from 'node:crypto'
import { ruleScope } from './rules.js'
import { normalizeOctoContent } from './octo-content.js'
import { quoteDisplayName } from './octo-quote.js'
import { parseSafeCommand } from './im-controls.js'
import { ChannelApi, ChannelApiError } from './channel-api.js'
import { createOboSend } from './obo-send.js'
import { parseWebhookChatCommand } from './webhook-chat-command.js'
import { OctoError, readApiError } from './api-errors.js'

export { OctoError } from './api-errors.js'

const maxBody = 1024 * 1024
const flag = (value) => value === 1 || value === true
const directoryGroupId = /^[a-fA-F0-9]{32}$/
const directoryPageSize = 100
const maxDirectoryGroups = 1000
// Local work bound, not an upstream limit. Exceeding it is an error, never EOF.
const maxDirectoryPages = 10_000
const directoryBot = (config, token) => token.startsWith('bf_') && validBotIdentity(config) && config.botKind !== 'app'
const directoryEligible = (config, token) => directoryBot(config, token)
  && config.transport === 'websocket' && config.mentionPolicy === 'octo'
const directoryGroupAllowed = (config, group) => config.channelPolicy === 'joined'
  || config.groups?.has(group) === true
  || [...(config.threads ?? [])].some(id => ruleScope(5, id)?.group === group)
const directoryRange = (route, seq) => route.directory_all === 1
  || !!channelSequence(route.prefix_until_seq) && seq <= route.prefix_until_seq
const recoverySince = (bounds, seq) => Math.max(bounds.since_ms || 0,
  seq <= bounds.prefix_until_seq ? bounds.prefix_since_ms || 0 : 0)
function recoveryBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OctoError('invalid_directory_recovery')
  const bounds = {}
  for (const key of ['since_ms', 'prefix_since_ms', 'prefix_until_seq']) {
    const number = value[key] ?? 0
    if (!Number.isSafeInteger(number) || number < 0 || key === 'prefix_until_seq' && number > 0xffffffff) {
      throw new OctoError('invalid_directory_recovery')
    }
    bounds[key] = number
  }
  return bounds
}
function directoryProvenance(job) {
  let value = job.directoryRecovery
  if (value === undefined && job.metadata) {
    try { value = (typeof job.metadata === 'string' ? JSON.parse(job.metadata) : job.metadata)?.directoryRecovery }
    catch { throw new OctoError('invalid_directory_recovery') }
  }
  return value === undefined ? undefined : recoveryBounds(value)
}
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
  #channelNames = new Map()
  #rememberChannelName(type, address, name) {
    if (typeof name !== 'string') return
    const safe = Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, 100).join('')
    if (!safe) return
    this.#channelNames.set(type + ':' + address, safe)
    if (this.#channelNames.size > 1024) this.#channelNames.delete(this.#channelNames.keys().next().value)
  }

  navigationNames(type, address) {
    const scope = ruleScope(type, address)
    if (!scope) return []
    return [[2, scope.group, this.#channelNames.get('2:' + scope.group)],
      ...(type === 5 ? [[5, address, this.#channelNames.get('5:' + address)]] : [])]
      .filter(([, , name]) => name)
  }

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
      ? new ChannelApi({ config, verifyAccount: signal => this.verify(config.botUid, config.spaceId, signal),
        request: (path, body, signal, options) => this.#request(path, body, signal, options) })
      : undefined
    this.channel?.revoke()
    this.channel = next
  }

  createOboSender(context) {
    return createOboSend({ ...context, request: (path, body, signal, options) => this.#request(path, body, signal, options) })
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

  async #appHuman(sender, signal) {
    const people = await this.#request('/v1/bot/users/batch', JSON.stringify({ uids: [sender] }), signal, { timeout: 5000 })
    return Array.isArray(people?.users) && people.users.length === 1 && Array.isArray(people.missing_uids)
      && people.missing_uids.length === 0 && people.users[0]?.uid === sender
      && people.users[0].status === 1 && people.users[0].robot === 0
  }

  async allowsMessage(config, job, signal) {
    const { sender, channel_type: type, ambient } = job
    const address = job.channel_id ?? sender
    const app = this.#token.startsWith('app_')
    if (app && (type !== 1 || address !== sender || !validUid(sender) || sender.includes('@') || sender === config.botUid)) return false
    if (type === 1) {
      if (config.senderPolicy !== 'octo' && !app) return true
      if (sender.includes('@')) return false // Octo's internal DM channel separator
      if (app && !await this.#appHuman(sender, signal)) return false
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
    const directoryRecovery = directoryProvenance(job)
    if (ambient && config.mentionPolicy !== 'octo') return false
    if ((ambient || directoryRecovery) && !await this.inboxDirectoryAccess(config,
      { channel_type: type, channel_id: address }, signal)) return false
    if (ambient) {
      const pref = await this.#request(root + '/mention_pref', undefined, signal, { timeout: 3000 })
      if ((pref?.group_allow_no_mention !== undefined && !flag(pref.group_allow_no_mention))
        || !flag(pref?.effective ?? pref?.no_mention)) return false
    }
    let directoryGroup
    if (config.channelPolicy === 'joined') {
      const query = new URLSearchParams({ space_id: config.spaceId })
      const groups = memberList(await this.#request('/v1/bot/groups?' + query, undefined, signal, { timeout: 5000 }), 'groups')
      directoryGroup = groups.find(g => g?.group_no === scope.group && g.space_id === config.spaceId)
      if (!directoryGroup) return false
    }
    if (ambient || directoryRecovery || config.senderPolicy === 'octo' || config.channelPolicy === 'joined') {
      const members = memberList(await this.#request(root + '/members', undefined, signal, { timeout: 5000 }), 'members')
      const actor = members.find(m => m?.uid === sender)
      // Do not auto-trigger other bots or unknown member kinds.
      if (!actor || ((ambient || directoryRecovery || config.senderPolicy === 'octo') && actor.robot !== 0 && actor.robot !== false)
        || !members.some(m => m?.uid === config.botUid)) return false
    }
    if (directoryGroup) this.#rememberChannelName(2, scope.group, directoryGroup.name)
    return true
  }

  async refreshNavigation(config, type, address, signal) {
    if (config.botKind === 'app' || ![2, 5].includes(type)) return []
    const scope = ruleScope(type, address)
    if (!scope || (config.channelPolicy === 'allowlist'
      && !(type === 2 ? config.groups : config.threads)?.has(address))) return []
    const query = new URLSearchParams({ space_id: config.spaceId })
    const groups = memberList(await this.#request('/v1/bot/groups?' + query, undefined, signal, { timeout: 3500 }), 'groups')
    const group = groups.find(row => row?.group_no === scope.group && row.space_id === config.spaceId)
    if (!group) return []
    this.#rememberChannelName(2, scope.group, group.name)
    if (type === 5) {
      const root = '/v1/bot/groups/' + encodeURIComponent(scope.group) + '/threads/'
      const detail = await this.#request(root + scope.thread, undefined, signal, { timeout: 3500 })
      if (detail?.group_no === scope.group && detail?.short_id === scope.thread
        && detail?.channel_id === address && detail?.channel_type === 5 && [1, 2].includes(detail.status)) {
        this.#rememberChannelName(5, address, detail.name)
      }
    }
    return this.navigationNames(type, address)
  }

  async inboxDirectoryGroups(config, signal) {
    if (!directoryEligible(config, this.#token)) return []
    return this.#directoryGroups(config, signal)
  }

  async #directoryGroups(config, signal) {
    const query = new URLSearchParams({ space_id: config.spaceId })
    const data = await this.#request('/v1/bot/groups?' + query, undefined, signal, { timeout: 5000 })
    // The official Go slice may encode an empty directory as null. Validate ALL
    // rows before applying the local allowlist, including rows we would omit.
    if (data !== null && !Array.isArray(data) || data?.length > maxDirectoryGroups) throw new OctoError('invalid_directory_response')
    const groups = new Set()
    for (const row of data ?? []) {
      if (!row || typeof row.group_no !== 'string' || !directoryGroupId.test(row.group_no)
        || row.space_id !== config.spaceId) throw new OctoError('invalid_directory_response')
      if (directoryGroupAllowed(config, row.group_no)) groups.add(row.group_no)
    }
    return [...groups].sort()
  }

  async #directoryParent(config, group, signal) {
    if (!(await this.#directoryGroups(config, signal)).includes(group)) return false
    const info = await this.#request('/v1/bot/groups/' + encodeURIComponent(group), undefined, signal, { timeout: 5000 })
    if (info === null) return false
    if (info?.group_no !== group || !Number.isInteger(info.status)) throw new OctoError('invalid_directory_response')
    if (info.status === 1) this.#rememberChannelName(2, group, info.name)
    return info.status === 1
  }

  #directoryThread(row, group) {
    const scope = ruleScope(5, row?.channel_id)
    if (!scope || row.group_no !== group || scope.group !== group || row.short_id !== scope.thread
      || row.channel_type !== 5 || row.status !== 1) throw new OctoError('invalid_directory_response')
    this.#rememberChannelName(5, row.channel_id, row.name)
    return { channel_type: 5, channel_id: row.channel_id }
  }

  async #directoryThreads(group, page, size, signal) {
    const query = new URLSearchParams({ page_index: String(page), page_size: String(size) })
    const data = await this.#request('/v1/bot/groups/' + encodeURIComponent(group) + '/threads?' + query,
      undefined, signal, { timeout: 5000 })
    const offset = (page - 1) * size
    if (!Number.isSafeInteger(data?.count) || data.count < 0 || data.count > maxDirectoryPages * directoryPageSize
      || !Array.isArray(data.list) || data.list.length !== Math.max(0, Math.min(size, data.count - offset))) {
      throw new OctoError('invalid_directory_response')
    }
    const seen = new Set()
    const routes = data.list.map(row => {
      const route = this.#directoryThread(row, group)
      if (seen.has(route.channel_id)) throw new OctoError('invalid_directory_response')
      seen.add(route.channel_id)
      return route
    })
    return { routes, nextPage: offset + data.list.length < data.count ? page + 1 : null }
  }

  async inboxDirectoryAccess(config, route, signal) {
    const type = route?.channel_type, id = route?.channel_id
    const scope = ruleScope(type, id)
    if (!directoryBot(config, this.#token) || !scope || !directoryGroupId.test(scope.group)
      || !(config.channelPolicy === 'joined' || (type === 2 ? config.groups?.has(id) : config.threads?.has(id)))) return false
    if (!await this.#directoryParent(config, scope.group, signal)) return false
    // This Bot endpoint checks active parent membership even when it returns no
    // topics. No user/follow API or missing member-status field is substituted.
    await this.#directoryThreads(scope.group, 1, 1, signal)
    if (type === 5) {
      const detail = await this.#request('/v1/bot/groups/' + encodeURIComponent(scope.group) + '/threads/' + scope.thread,
        undefined, signal, { timeout: 5000 })
      if (detail === null) return false
      if (detail.status !== 1) {
        if (!Number.isInteger(detail.status)) throw new OctoError('invalid_directory_response')
        return false
      }
      if (this.#directoryThread(detail, scope.group).channel_id !== id) throw new OctoError('invalid_directory_response')
    }
    return true
  }

  async #directoryPreference(group, signal) {
    const pref = await this.#request('/v1/bot/groups/' + encodeURIComponent(group) + '/mention_pref', undefined, signal, { timeout: 3000 })
    const effective = pref?.effective ?? pref?.no_mention
    if (!pref || ![true, false, 0, 1].includes(effective)
      || pref.group_allow_no_mention !== undefined && ![true, false, 0, 1].includes(pref.group_allow_no_mention)) {
      throw new OctoError('invalid_directory_response')
    }
    return flag(effective) && (pref.group_allow_no_mention === undefined || flag(pref.group_allow_no_mention))
  }

  async inboxDirectoryPage(config, group, page, signal) {
    if (typeof group !== 'string' || !directoryGroupId.test(group)
      || !Number.isSafeInteger(page) || page < 1 || page > maxDirectoryPages) {
      throw new OctoError('invalid_directory_scope')
    }
    const empty = { routes: [], nextPage: null }
    if (!directoryEligible(config, this.#token) || !directoryGroupAllowed(config, group)) return empty
    if (!await this.#directoryParent(config, group, signal)) return empty
    if (!await this.#directoryPreference(group, signal)) return empty
    // threads.go:22-54 is the active-parent-member gate. It is mandatory even
    // for a main-only allowlist; groups/info/sync alone exclude only deleted members.
    const result = await this.#directoryThreads(group, page, directoryPageSize, signal)
    const routes = result.routes.filter(route => config.channelPolicy === 'joined' || config.threads?.has(route.channel_id) === true)
    if (page === 1 && (config.channelPolicy === 'joined' || config.groups?.has(group) === true)) {
      routes.unshift({ channel_type: 2, channel_id: group })
    }
    return { routes, nextPage: result.nextPage }
  }

  async recentMessages(config, route, before, signal, quoteId) {
    const type = route.channel_type, id = route.channel_id
    if (![1, 2, 5].includes(type) || (type === 1 ? !validUid(id) || id.includes('@') : !ruleScope(type, id))) {
      throw new OctoError('invalid_history_scope')
    }
    const end = channelSequence(before)
    const bounds = ['since_ms', 'prefix_since_ms', 'prefix_until_seq'].some(key => Object.hasOwn(route, key))
      ? recoveryBounds(route) : undefined
    if (config.botKind === 'app' && type !== 1) throw new OctoError('invalid_history_scope')
    if (end === 1) return { rows: [], more: false }
    const data = await this.#request('/v1/bot/messages/sync', JSON.stringify({
      channel_type: type, channel_id: id, start_message_seq: end ? end - 1 : 0, end_message_seq: 0, pull_mode: 0, limit: 20,
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
      const since = bounds ? recoverySince(bounds, seq) : 0
      // Reject old/unknown timestamps before decoding any context or quote body.
      if (since > 0 && (!Number.isSafeInteger(item.timestamp) || item.timestamp <= 0
        || item.timestamp * 1000 > Date.now() + 300000 || item.timestamp * 1000 <= since)) continue
      if (config.botKind === 'app') {
        const verified = await this.channel.appMessage(route, id, messageId, signal)
        if (verified.text.trim()) rows.push({ seq: verified.message_seq, messageId, sender: verified.from_uid,
          text: Array.from(verified.text).slice(0, 280).join(''),
          ...(messageId === quoteId && { quote: { type: verified.type, truncated: Array.from(verified.text).length > 280 } }) })
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
      // Enrich the requested row only after the existing history checks; no
      // additional rows, requests, or attachment bytes enter the result.
      const quote = messageId === quoteId && normalizeOctoContent(payload, { historyQuote: true })
      const quoteText = quote && Array.from(quote.text)
      rows.push({ seq, messageId, sender: validUid(item.from_uid) ? item.from_uid : 'unknown',
        text: Array.from(content.text).slice(0, 280).join(''),
        ...(quote && { quote: { name: quoteDisplayName(item.from_name), type: payload.type, text: quoteText.slice(0, 280).join(''),
          media: quote.media, truncated: quote.truncated || quoteText.length > 280 } }) })
    }
    return { rows: rows.sort((a, b) => a.seq - b.seq).slice(-20), more: flag(data.more) || (data.messages?.length ?? 0) >= 20 }
  }

  async inboxPage(config, route, start, through, signal) {
    const { channel_type: type, channel_id: id } = route
    if (![1, 2, 5].includes(type) || (type === 1 ? !validUid(id) || id.includes('@') : !ruleScope(type, id))
      || !Number.isInteger(start) || start < 0 || start > 0xffffffff
      || through != null && (!channelSequence(through) || start > through)) throw new OctoError('invalid_inbox_scope')
    const app = this.#token.startsWith('app_')
    if (app && (type !== 1 || id === config.botUid || !this.channel
      || !await this.#appHuman(id, signal))) throw new OctoError('app_inbox_access_denied')
    const prefix = channelSequence(route.prefix_until_seq) ?? 0
    const latest = through == null
    const all = type !== 1 && route.directory_all === 1
    const readsPrefix = type !== 1 && !all && !latest && prefix > 0 && start <= prefix
    // A newly authorized prefix gets its own page. The caller's next start can
    // enter the previously accepted upper range without inheriting its pref gate.
    const pageThrough = readsPrefix ? Math.min(through, prefix) : through
    if (all || readsPrefix) {
      const skip = () => ({ last: 0, count: 0, messages: [], observed: [], suppressed: [], skippedThrough: pageThrough })
      if (!directoryEligible(config, this.#token)) {
        if (readsPrefix) return skip()
        throw new OctoError('directory_preference_denied')
      }
      if (!await this.inboxDirectoryAccess(config, route, signal)) {
        if (readsPrefix) return skip()
        throw new OctoError('directory_access_denied')
      }
      if (!await this.#directoryPreference(ruleScope(type, id).group, signal)) {
        if (readsPrefix) return skip()
        throw new OctoError('directory_preference_denied')
      }
    }
    const data = await this.#request('/v1/bot/messages/sync', JSON.stringify({
      channel_type: type, channel_id: id, start_message_seq: latest ? 0 : start,
      end_message_seq: latest || pageThrough === 0xffffffff ? 0 : pageThrough + 1,
      pull_mode: latest ? 0 : 1, limit: latest ? 1 : 100,
    }), signal, { timeout: 8000 })
    if (!data || data.messages !== null && !Array.isArray(data.messages)
      || data.messages?.length > (latest ? 1 : 100)) throw new OctoError('invalid_inbox_response')
    const seen = new Set(), ids = new Set(), messages = [], suppressed = []
    let last = 0
    for (const row of data.messages ?? []) {
      const seq = channelSequence(row?.message_seq), messageId = decimalId(row?.message_id)
      if (!seq || !messageId || seen.has(seq) || ids.has(messageId) || !latest && (seq < start || seq > pageThrough)
        || row.channel_type != null && row.channel_type !== type
        || type !== 1 && row.channel_id != null && row.channel_id !== id
        || type === 1 && row.from_uid !== id && row.from_uid !== config.botUid) throw new OctoError('invalid_inbox_response')
      seen.add(seq); ids.add(messageId); last = Math.max(last, seq)
      if (latest) continue
      const effectiveSince = recoverySince(route, seq)
      if (effectiveSince > 0) {
        if (!Number.isSafeInteger(row.timestamp) || row.timestamp <= 0 || row.timestamp * 1000 > Date.now() + 300000) {
          throw new OctoError('invalid_inbox_timestamp')
        }
        if (row.timestamp * 1000 <= effectiveSince) { suppressed.push(messageId); continue }
      }
      if ([row.revoke, row.revoked, row.is_deleted, row.extra?.revoke, row.message_extra?.revoke].some(flag)) { suppressed.push(messageId); continue }
      let payload = row.message_extra?.content_edit ?? row.extra?.content_edit ?? row.payload
      if (typeof payload === 'string') {
        if (payload.length > 120_000) { suppressed.push(messageId); continue }
        try { payload = readJson(payload.trimStart().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8')) }
        catch { suppressed.push(messageId); continue }
      }
      const m = admit({ message: { message_id: messageId, message_seq: seq, from_uid: row.from_uid,
        channel_type: type, channel_id: id, payload } }, config)
      if (m) {
        // A RECV can share the CONNACK frame and enter recovery before live
        // admission. Sync alone does not enforce the App's server-managed Space.
        if (app) {
          const verified = await this.channel.appMessage({ channel_type: type, channel_id: id }, id, messageId, signal)
          if (verified.message_seq !== seq || verified.from_uid !== row.from_uid) throw new OctoError('invalid_inbox_response')
        }
        if (type !== 1 && directoryRange(route, seq)) m.directoryRecovery = recoveryBounds(route)
        messages.push(m)
      }
      else suppressed.push(messageId)
    }
    // Empty prefix is only EOF for this segment; Inbox must resume at its end,
    // not checkpoint the original upper bound. No synthetic message count/seq.
    return { last, messages: messages.sort((a, b) => a.messageSeq - b.messageSeq), count: seen.size, observed: [...ids], suppressed,
      ...(!latest && pageThrough < through && !seen.size && { scannedThrough: pageThrough }) }
  }

  async events(signal, cursor = '0', options = {}) {
    const started = Date.now()
    if (cursor !== '0' && !decimalId(cursor)) throw new OctoError('invalid_event_id')
    const { wait = this.wait } = options
    if (!Number.isInteger(wait) || wait < 0 || wait > 30) throw new OctoError('invalid_event_wait')
    const result = await this.#request('/v1/bot/events', '{"event_id":' + cursor
      + ',"limit":20,"wait":' + JSON.stringify(wait) + '}', signal, {
      timeout: (wait + 10) * 1000,
    })
    if (result?.status !== 1 || (result.results !== null && !Array.isArray(result.results))) {
      throw new OctoError('invalid_events_response')
    }
    const batch = result.results ?? []
    if (!batch.length && Date.now() - started < 750) await delay(750, undefined, { signal })
    return batch.map(event => {
      const message = event?.message
      // Only ordinary /events DMs omit BOTH channel fields in the official DTO.
      // Preserve typed events and explicit routes (including type-1 wire IDs);
      // partial/null fields must never be repaired into an admitted DM.
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.hasOwn(event, 'event_type') || message.payload?.event != null
        || Object.hasOwn(message, 'channel_type') || Object.hasOwn(message, 'channel_id')
        || !validUid(message.from_uid)) return event
      return { ...event, message: { ...message, channel_type: 1, channel_id: message.from_uid } }
    })
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
  const webhookChat = parseWebhookChatCommand(payload.type === 1 ? payload.content : text, {
    config, sender, channelType, channelId, mention, plain: payload.type === 1 && !attachment && !attachments?.length && !parts,
  })
  if (webhookChat?.kind === 'blocked') return
  if (webhookChat?.kind === 'request') return { messageId, sender, text: '', channelId, channelType, ambient,
    messageSeq, webhookChat, webhookSentAt: message.timestamp }
  const command = payload.type === 1 ? parseSafeCommand(text, config, {
    routeAllowed: true, channelType, hasAttachments: !!(attachment || attachments?.length || parts), botUid: config.botUid, mention,
    actorApproved: sender === config.ownerUid || config.allowed.has(sender), isBotOwner: sender === config.ownerUid,
  }) : { kind: 'text' }
  if (command.kind === 'blocked' || (command.kind === 'command' && payload.type !== 1)) return
  return { messageId, sender, text, channelId, channelType, ambient,
    ...(command.command === 'stop' && Number.isSafeInteger(message.timestamp) && message.timestamp > 0
      && { stopSentAt: message.timestamp }),
    ...(messageSeq && { messageSeq }), ...(quoteId && { quoteId }),
    ...(attachment && { attachment }), ...(attachments && { attachments }), ...(parts && { parts }), ...(command.kind === 'command' && { command: command.command }) }
}
