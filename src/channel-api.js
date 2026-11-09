import { validUid } from './config.js'
import { ruleScope } from './rules.js'
import { normalizeOctoContent } from './octo-content.js'

// Bot-token contracts: octo-server f984d405, modules/bot_api/{groups,threads,
// sync,send,search_route}.go; modules/message/api_message_get.go. This module
// accepts only the authenticated transport, never a URL or credentials. The
// optional fourth argument selects an explicit, internally fixed HTTP method.
const MAX_MEMBERS = 1000
const MAX_ROWS = 50
const flag = value => value === 1 || value === true
const admin = member => member?.role === 1 || member?.role === 2
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const shortID = { type: 'string', pattern: '^[0-9]{15,20}$' }
const messageID = { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }
const uid = { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,128}$' }
const memberTargets = { type: 'array', items: uid, minItems: 1, maxItems: 10, uniqueItems: true }
const text = { type: 'string', minLength: 1, maxLength: 4000 }
const limit = { type: 'integer', minimum: 1, maximum: MAX_ROWS }
const threadArgs = { short_id: shortID }
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
// octo-server f984d405 modules/messages_search/{validate,util,search_*}.go.
// Explicit endpoint map: model input never participates in routing.
const searchEndpoints = Object.freeze({
  'messages.search': '/v1/bot/messages/_search',
  'messages.search_files': '/v1/bot/messages/_search_files',
  'messages.search_media': '/v1/bot/messages/_search_media',
  'messages.search_all': '/v1/bot/messages/_search_all',
  'messages.search_around': '/v1/bot/messages/_search_around',
})
const searchTimePattern = '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?:T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d))?$'
const searchTime = { type: 'string', maxLength: 35, pattern: searchTimePattern,
  description: 'RFC3339 with timezone, or YYYY-MM-DD (Asia/Shanghai start/end of day).' }
const searchFilters = schema({
  sender_ids: { type: 'array', items: uid, minItems: 1, maxItems: 50, uniqueItems: true },
  sent_at_from: searchTime, sent_at_to: searchTime,
})
const searchLimit = { type: 'integer', minimum: 1, maximum: 10 }
const searchPage = { filters: searchFilters, limit: searchLimit, cursor: { type: 'string', maxLength: 4096 },
  sort: { type: 'string', enum: ['time_desc', 'time_asc', 'relevance'] } }
const searchKeyword = { type: 'string', maxLength: 64 }
const spec = (name, description, parameters = schema(), mutating = false, unavailableReason) => ({
  name, description, parameters, mutating, available: !unavailableReason,
  ...(unavailableReason && { unavailableReason }),
})
const freeze = value => {
  if (object(value) || Array.isArray(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/** Ordinary JSON schemas; callers should mount only available operations. */
export const CHANNEL_API_OPERATIONS = freeze([
  spec('inspect', 'Inspect the current channel and its parent group permissions.'),
  spec('groups.list', 'Return only the current parent group, never other groups.'),
  spec('members', 'List current parent-group members with authoritative numeric roles.', schema({ limit })),
  spec('members.add', 'Add explicitly requested human UIDs from the configured Space to the current parent group; requester must be group owner/admin.',
    schema({ uids: memberTargets }, ['uids']), true),
  spec('members.remove', 'Remove explicitly requested current members with role 0 from the current parent group. Requester must be group owner/admin; server requires bot_admin. Octo may also remove their bots and thread memberships.',
    schema({ uids: memberTargets }, ['uids']), true),
  spec('space.members.search', 'Resolve an explicitly requested person by name in the configured Space. Requires requester live Space membership; no blank directory listing.',
    schema({ keyword: { type: 'string', minLength: 1, maxLength: 64 }, limit,
      page: { type: 'integer', minimum: 1, maximum: 10000 } }, ['keyword'])),
  spec('targets.resolve', 'Resolve a group/thread name only within the current parent group. A thread session resolves only its current thread and parent. Searches one bounded page; never routes to another group.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 100 }, limit,
      page: { type: 'integer', minimum: 1, maximum: 10000 } }, ['name'])),
  // Creation is the explicit scope exception: verified bot owner only, fixed
  // Space, no automatic routing, messaging or admission of the new group.
  spec('groups.create', 'Create a group in the configured Space, only for the verified bot owner in an admitted chat. Resolve explicit human recipients with space.members.search; exact Space eligibility is rechecked for every UID. Returns the new group without messaging it.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 50 }, uids: memberTargets }, ['name', 'uids']), true),
  // Global discovery/resolution additionally needs per-group requester
  // visibility checks; a group admin role cannot authorize other groups.
  spec('groups.discover', 'Cross-group discovery requires a separate owner context with requester visibility checks.', schema(), false, 'separate_owner_context_required'),
  spec('rules.read', 'Read the current parent group rules.'),
  spec('rules.edit', 'Update/clear parent group rules; requester must be group owner/admin and server must grant bot_admin.',
    schema({ content: { type: 'string', maxLength: 10240 } }, ['content']), true),
  spec('group.edit', 'Update parent group name/notice; requester must be group owner/admin and server must grant bot_admin.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 50 }, notice: { type: 'string', maxLength: 4000 } }), true),
  spec('threads.list', 'List one bounded page of threads in the current parent group.',
    schema({ page: { type: 'integer', minimum: 1, maximum: 10000 }, limit })),
  spec('threads.create', 'Create a bot-owned thread in the current parent group; requester must be owner/admin.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 100 } }, ['name']), true),
  spec('thread.read', 'Read a thread in this group. In a thread session only the current thread is allowed.', schema(threadArgs)),
  spec('thread.members', 'List current thread participants; thread role 1 means creator, not group admin.', schema({ ...threadArgs, limit })),
  spec('thread.rules.read', 'Read the selected/current thread rules.', schema(threadArgs)),
  spec('thread.rules.edit', 'Update nonempty thread rules; requester must be group owner/admin and server must grant bot_admin.',
    schema({ ...threadArgs, content: { type: 'string', minLength: 1, maxLength: 10240 } }, ['content']), true),
  spec('thread.rename', 'Rename a thread; no bot-token rename endpoint in the reviewed server.',
    schema({ ...threadArgs, name: { type: 'string', minLength: 1, maxLength: 100 } }, ['name']), true, 'unsupported_bot_endpoint'),
  spec('thread.join', 'Join the selected/current thread as the bot, not as the requester.', schema(threadArgs), true),
  spec('thread.leave', 'Leave the selected/current thread as the bot.', schema(threadArgs), true),
  spec('thread.archive', 'Archive a thread; requester must be group admin and bot must be creator or group admin.', schema(threadArgs), true),
  spec('thread.delete', 'Delete a thread; requester must be group admin and bot must be creator or group admin.', schema(threadArgs), true),
  spec('messages.recent', 'Read one bounded page of current-channel history; before_seq is exclusive.',
    schema({ limit, before_seq: { type: 'integer', minimum: 1, maximum: 0xffffffff } })),
  spec('messages.read', 'Read one message from the current channel.', schema({ message_id: messageID }, ['message_id'])),
  spec('messages.search', 'Search current-channel messages as a User Bot with server search enabled. Supply a keyword or sender/time filter. One page, at most 10 verified hits; no global or OBO search.',
    schema({ keyword: searchKeyword, ...searchPage })),
  spec('messages.search_files', 'Search/list files in the current channel as a User Bot with server search enabled. Keyword optional; one page of at most 10 verified messages and attachment metadata, without downloads or indexed snippets.',
    schema({ keyword: searchKeyword, ...searchPage })),
  spec('messages.search_media', 'List images/videos in the current channel as a User Bot with server search enabled. Sender/time filters only, no keyword or relevance sort. One page of at most 10 verified messages; no media downloads.',
    schema({ ...searchPage, sort: { type: 'string', enum: ['time_desc', 'time_asc'] } })),
  spec('messages.search_all', 'Search messages and files together in the current channel as a User Bot with server search enabled. Supply a keyword or sender/time filter. One page of at most 10 individually verified hits; no cross-channel search.',
    schema({ keyword: searchKeyword, ...searchPage })),
  spec('messages.search_around', 'Read context around a visible current-channel message as a User Bot with server search enabled. limit is per side (default 5, max 10): at most 21 verified messages including the anchor. Sender/time filters affect neighbors, not the anchor. No cursor or automatic paging.',
    schema({ anchor_message_id: messageID, filters: searchFilters, limit: searchLimit }, ['anchor_message_id'])),
  spec('messages.notify', 'Send text with visible native @name mentions for current member UIDs. Explicit all=true requires a current requester group owner/admin and notifies humans, never all bots.',
    schema({ text, uids: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,128}$' }, maxItems: 10, uniqueItems: true },
      all: { type: 'boolean' } }, ['text']), true),
  spec('messages.edit', 'Edit a bot-authored plain text message in this channel; group requester must be owner/admin.',
    schema({ message_id: messageID, text }, ['message_id', 'text']), true),
  spec('messages.mark_read', 'Mark specified current-channel messages as read by the bot and clear the bot unread count; does not act as the requester.',
    schema({ message_ids: { type: 'array', items: messageID, minItems: 1, maxItems: 10, uniqueItems: true } }, ['message_ids']), true),
  spec('voice.context.read', 'Owner DM only: read personal voice-correction context in the bot server-selected primary Space, not group/thread settings.'),
  spec('voice.context.update', 'Owner DM only: replace personal voice-correction context in the bot server-selected primary Space.',
    schema({ context: { type: 'string', minLength: 1, maxLength: 10000 } }, ['context']), true),
  spec('voice.context.delete', 'Owner DM only: delete personal voice-correction context in the bot server-selected primary Space.', schema(), true),
  ...['react', 'pin', 'delete'].map(action => spec('messages.' + action,
    'Unavailable: no reviewed bot-token endpoint for this message mutation.',
    schema({ message_id: messageID }, ['message_id']), true, 'unsupported_bot_endpoint')),
])
const specs = new Map(CHANNEL_API_OPERATIONS.map(value => [value.name, value]))
const errorHints = Object.freeze({
  api_permission_denied: 'Octo denied this bot credential. Check current membership/status and the group-specific bot_admin grant for rule/group-info edits or member removal.',
  api_authentication_failed: 'Reconnect with a valid bot credential.',
  api_invalid_request: 'Octo rejected the request. Check arguments and the server API version.',
  api_not_found: 'The endpoint or resource is unavailable. Check the server version and current-channel resource.',
  api_method_not_allowed: 'This server does not support the required HTTP method for this endpoint.',
  api_conflict: 'Refresh the resource before making another change.',
  api_rate_limited: 'Octo rate-limited this request. Wait before retrying; no automatic retry was attempted.',
  api_server_error: 'Octo reported a server failure. Check the resource state before retrying a mutation.',
  api_request_failed: 'The request failed. Check connectivity/API support and inspect the resource before retrying a mutation.',
  requester_admin_required: 'The requesting member must be this group owner or administrator; bot ownership grants no extra authority.',
  separate_owner_context_required: 'This operation is outside the admitted current-parent scope. It needs a separate owner context with explicit Space and requester visibility checks.',
  owner_dm_required: 'Personal voice context is available only in a verified bot-owner DM; group administrator status is not owner authority.',
  owner_identity_required: 'The host must first verify the bot owner identity before using this owner-only operation.',
  requester_owner_required: 'Only the verified bot owner can create a group; current group administrator status does not grant bot-owner authority.',
  human_member_required: 'Only live human members of the configured Space can be added through this operation.',
  protected_member: 'This operation cannot remove the calling bot or a group owner/administrator.',
  bot_permission_required: 'The bot must be the thread creator or a current group owner/administrator.',
  mutation_permission_changed: 'Live membership or role changed during this operation. No mutation was sent.',
  mutation_unconfirmed: 'The server did not return the required success acknowledgement. Inspect the resource before retrying.',
  unsupported_bot_endpoint: 'The reviewed official server has no bot-token endpoint for this operation.',
  unsafe_mention_label: 'A selected member name resembles a broadcast or embeds another @. Use a safe member display name before sending a native mention.',
  invalid_mention_target: 'Broadcast sentinel UIDs cannot be used as individual mention targets. Use the explicit all option with group administrator authority.',
})
const statusErrors = new Map([[400, 'api_invalid_request'], [401, 'api_authentication_failed'], [403, 'api_permission_denied'],
  [404, 'api_not_found'], [405, 'api_method_not_allowed'], [409, 'api_conflict'], [413, 'api_invalid_request'], [429, 'api_rate_limited']])
const statusError = status => statusErrors.get(status)
  ?? (Number.isInteger(status) && status >= 500 && status <= 599 ? 'api_server_error' : 'api_request_failed')

export class ChannelApiError extends Error {
  constructor(code, hint = '') {
    super(code + (errorHints[code] ? ': ' + errorHints[code] : '') + (hint ? ' ' + hint : ''))
    this.name = 'ChannelApiError'
    this.code = code
  }
}
const fail = code => { throw new ChannelApiError(code) }
const id = value => {
  const s = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  return /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n ? s : undefined
}
const seq = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff
function searchTimeSeconds(value, endOfDay = false) {
  // Date.parse alone accepts impossible dates such as February 30. Check the
  // calendar independently, then mirror Go's seconds precision and +08 day bounds.
  if (!new RegExp(searchTimePattern).test(value)) fail('invalid_arguments')
  const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) fail('invalid_arguments')
  const time = value.length === 10 ? day / 1000 - 8 * 3600 + (endOfDay ? 86399 : 0) : Math.floor(Date.parse(value) / 1000)
  if (!Number.isFinite(time)) fail('invalid_arguments')
  return time
}
function validateSearch(operation, args) {
  const filters = args.filters ?? {}
  const from = filters.sent_at_from === undefined ? undefined : searchTimeSeconds(filters.sent_at_from)
  const to = filters.sent_at_to === undefined ? undefined : searchTimeSeconds(filters.sent_at_to, true)
  if (from !== undefined && to !== undefined && from > to) fail('invalid_arguments')
  if (['messages.search', 'messages.search_all'].includes(operation)
    && !args.keyword?.trim() && !filters.sender_ids?.length && from === undefined && to === undefined) fail('invalid_arguments')
  if (args.sort === 'relevance' && !args.keyword?.trim()) fail('invalid_arguments')
  if (operation === 'messages.search_around' && !id(args.anchor_message_id)) fail('invalid_arguments')
}
const boundedText = (value, max) => typeof value === 'string'
  ? Array.from(value.slice(0, max * 2)).slice(0, max).join('').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') : ''
const messageText = value => {
  // Budget JSON-encoded bytes, including escapes: even 50 worst-case message
  // snippets and their identifiers fit the host's 64 KiB tool-result boundary.
  let result = '', bytes = 0
  for (const rune of boundedText(value, 2000)) {
    bytes += Buffer.byteLength(JSON.stringify(rune), 'utf8') - 2
    if (bytes > 800) break
    result += rune
  }
  return result
}
function notificationPayload(text, uids, rows = [], all = false) {
  // sendMessage passes flags through without a bot_admin requirement. Explicit
  // all maps to humans for current clients; retain all for legacy clients.
  if (all) return { type: 1, content: text + '\n@所有人 ', mention: { all: 1, humans: 1 } }
  if (!uids.length) return { type: 1, content: text }
  const members = new Map(rows.map(row => [row.uid, row]))
  let content = text + '\n'
  const entities = []
  for (const uid of uids) {
    if (['all', '-1', '-2', '-3'].includes(uid.toLowerCase())) fail('invalid_mention_target')
    const member = members.get(uid)
    if (!member) fail('mention_not_member')
    const name = member.name.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim()
    const canonical = name.normalize('NFKC').toLowerCase()
    // Like the official render guard, reject broadcast-like names even when
    // their UID is a member: older clients tokenize display labels themselves.
    if (!name || canonical.includes('@') || /^(?:所有人|所有ai|all)(?:$|[^\p{L}\p{N}])/u.test(canonical)) fail('unsafe_mention_label')
    const label = '@' + name
    // JS lengths are UTF-16 code units, exactly the official entity contract.
    entities.push({ uid, offset: content.length, length: label.length })
    content += label + ' '
  }
  return { type: 1, content, mention: { uids, entities } }
}
const list = (value, max) => {
  if (value === null) return [] // Go nil slices are encoded as null.
  if (!Array.isArray(value)) fail('invalid_api_response')
  if (value.length > max) fail('response_limit_exceeded')
  return value
}

// Validate again in-process: a host's schema validation is not an access gate.
function validate(value, def) {
  if (def.type === 'object') {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_arguments')
    if (Object.keys(value).some(key => !Object.hasOwn(def.properties, key))
      || def.required.some(key => !Object.hasOwn(value, key))) fail('invalid_arguments')
    for (const [key, item] of Object.entries(value)) validate(item, def.properties[key])
  } else if (def.type === 'string') {
    if (typeof value !== 'string' || value.length > (def.maxLength ?? 4096) * 2
      || Array.from(value).length > (def.maxLength ?? 4096)
      || (def.minLength && !value.trim()) || (def.pattern && !new RegExp(def.pattern).test(value))
      || (def.enum && !def.enum.includes(value))) fail('invalid_arguments')
  } else if (def.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < def.minimum || value > def.maximum) fail('invalid_arguments')
  } else if (def.type === 'boolean') {
    if (typeof value !== 'boolean') fail('invalid_arguments')
  } else if (def.type === 'array') {
    if (!Array.isArray(value) || value.length < (def.minItems ?? 0)
      || value.length > def.maxItems || new Set(value).size !== value.length) fail('invalid_arguments')
    for (const item of value) validate(item, def.items)
  }
}

function memberRows(raw) {
  const seen = new Set()
  return list(raw, MAX_MEMBERS).flatMap(row => {
    if (!object(row) || !validUid(row.uid) || seen.has(row.uid)
      || ![0, 1, 2].includes(row.role) || ![0, 1].includes(row.robot)) fail('invalid_member_response')
    seen.add(row.uid)
    // The reviewed bot endpoint omits status/bot_admin. Do not invent them.
    // If a future server supplies status, removed/blacklisted rows fail closed.
    if (row.is_deleted !== undefined && row.is_deleted !== 0 && row.is_deleted !== false
      || row.status !== undefined && row.status !== 1) return []
    return [{ uid: row.uid, name: boundedText(row.name, 100) || row.uid, robot: row.robot, role: row.role }]
  })
}

/** route and sender MUST come from the admitted event, never model arguments.
 * members() is trusted metadata plumbing; it cannot authorize a requester.
 * No cached membership, retries, pagination loops, OBO, or user-token fallback.
 */
export class ChannelApi {
  #request
  #config
  #ownerUid
  constructor({ request, config }) {
    if (typeof request !== 'function' || !validUid(config?.botUid) || !validUid(config?.spaceId)) fail('invalid_channel_api_config')
    this.#request = request
    // The host fills ownerUid from verified identity after constructing its
    // client. Read that trusted field at call time; never accept it in args.
    this.#ownerUid = () => config.ownerUid
    this.#config = {
      botUid: config.botUid, spaceId: config.spaceId,
      senderPolicy: config.senderPolicy ?? 'octo', channelPolicy: config.channelPolicy ?? 'joined',
      allowed: new Set(config.allowed ?? []), groups: new Set(config.groups ?? []), threads: new Set(config.threads ?? []),
    }
    if (!['octo', 'allowlist'].includes(this.#config.senderPolicy)
      || !['joined', 'allowlist'].includes(this.#config.channelPolicy)) fail('invalid_channel_api_config')
  }

  async #call(path, body, signal, method = body === undefined ? 'GET' : 'POST') {
    if (signal?.aborted) fail('aborted')
    let result
    try { result = await this.#request(path, body === undefined ? undefined : JSON.stringify(body), signal, { method }) }
    catch (error) {
      if (signal?.aborted) fail('aborted')
      // OctoClient discards HTTP error bodies. Preserve only known status classes.
      fail(statusError(error?.status))
    }
    if (signal?.aborted) fail('aborted')
    // Never expose a transport exception, HTTP body, nested error, or credentials.
    if (Number.isInteger(result?.status) && result.status >= 400) fail(statusError(result.status))
    if (object(result) && (result.error != null || result.ok === false
      || result.status !== undefined && ![0, 1, 2, 3, 200].includes(result.status))) fail('api_request_failed')
    return result
  }

  #scope(route) {
    if (!object(route)) fail('invalid_route')
    const { channel_id, channel_type } = route
    const fixed = { channel_id, channel_type }
    if (channel_type === 1 && validUid(channel_id) && !channel_id.includes('@') && channel_id !== this.#config.botUid) {
      return { route: fixed }
    }
    const scope = ruleScope(channel_type, channel_id)
    if (!scope) fail('invalid_route')
    if (this.#config.channelPolicy === 'allowlist'
      && !(channel_type === 2 ? this.#config.groups : this.#config.threads).has(channel_id)) fail('route_not_allowed')
    return { ...scope, route: fixed, root: '/v1/bot/groups/' + encodeURIComponent(scope.group) }
  }

  async #membership(scope, signal) {
    // Pin the parent to the configured Space, including allowlisted routes.
    const groups = list(await this.#call('/v1/bot/groups?' + new URLSearchParams({ space_id: this.#config.spaceId }), undefined, signal), 1000)
    if (!groups.some(row => row?.group_no === scope.group && row.space_id === this.#config.spaceId)) fail('group_access_denied')
    const rows = memberRows(await this.#call(scope.root + '/members', undefined, signal))
    if (!rows.some(row => row.uid === this.#config.botUid && row.robot === 1)) fail('bot_not_member')
    return rows
  }

  async members(route, signal = new AbortController().signal) {
    const scope = this.#scope(route)
    if (!scope.group) fail('group_required')
    return this.#membership(scope, signal)
  }

  #requireOwnerDM(scope, sender) {
    const owner = this.#ownerUid()
    if (!validUid(owner) || owner === this.#config.botUid) fail('owner_identity_required')
    if (scope.route.channel_type !== 1 || scope.route.channel_id !== owner || sender !== owner) fail('owner_dm_required')
  }

  #requireOwner(sender) {
    const owner = this.#ownerUid()
    if (!validUid(owner) || owner === this.#config.botUid) fail('owner_identity_required')
    if (sender !== owner) fail('requester_owner_required')
  }

  async #principal(target, signal) {
    const raw = await this.#call('/v1/bot/space/principals/' + encodeURIComponent(target)
      + '?' + new URLSearchParams({ space_id: this.#config.spaceId }), undefined, signal)
    if (raw?.uid !== target || !['human', 'user_bot'].includes(raw.principal_type)) fail('invalid_principal_response')
    return raw.principal_type
  }

  async #threads(scope, page, size, signal) {
    const raw = await this.#call(scope.root + '/threads?' + new URLSearchParams({ page_index: page, page_size: size }), undefined, signal)
    if (!Number.isSafeInteger(raw?.count) || raw.count < 0) fail('invalid_thread_response')
    return { threads: list(raw.list, size).map(row => this.#thread(row, scope)), total: raw.count, more: page * size < raw.count }
  }

  async #access(scope, sender, mutating, signal) {
    if (!validUid(sender) || sender === this.#config.botUid
      || this.#config.senderPolicy === 'allowlist' && !this.#config.allowed.has(sender)) fail('requester_not_allowed')
    if (!scope.group) {
      if (scope.route.channel_id !== sender) fail('requester_not_allowed')
      // Also used before DM mutations: ordinary sync checks owner/friend access.
      const data = await this.#call('/v1/bot/messages/sync', { ...scope.route, start_message_seq: 0, end_message_seq: 0, limit: 1, pull_mode: 0 }, signal)
      if (!object(data)) fail('invalid_api_response')
      list(data.messages, 1)
      return {}
    }
    const rows = await this.#membership(scope, signal)
    const actor = rows.find(row => row.uid === sender)
    if (!actor || actor.robot !== 0) fail('requester_not_member')
    const bot = rows.find(row => row.uid === this.#config.botUid)
    const raw = await this.#call(scope.root, undefined, signal)
    if (raw?.group_no !== scope.group || ![0, 1, 2].includes(raw.status)) fail('invalid_group_response')
    if (mutating && raw.status !== 1) fail('group_not_active')
    const group = { group_no: scope.group, name: boundedText(raw.name, 100), notice: boundedText(raw.notice, 4000), status: raw.status }
    return { rows, actor, bot, group }
  }

  #threadPath(scope, args) {
    if (!scope.group || !/^[a-fA-F0-9]{32}$/.test(scope.group)) fail('invalid_thread_scope')
    const selected = args.short_id ?? scope.thread
    if (typeof selected !== 'string' || !/^[0-9]{15,20}$/.test(selected)) fail('thread_required')
    if (scope.thread && scope.thread !== selected) fail('current_thread_only')
    return { path: scope.root + '/threads/' + selected, selected }
  }

  #thread(raw, scope, selected) {
    if (!object(raw) || raw.group_no !== scope.group || typeof raw.short_id !== 'string' || !/^[0-9]{15,20}$/.test(raw.short_id)
      || selected && raw.short_id !== selected || raw.channel_id !== scope.group + '____' + raw.short_id
      || raw.channel_type !== 5 || !validUid(raw.creator_uid) || ![1, 2].includes(raw.status)) fail('invalid_thread_response')
    return { group_no: scope.group, short_id: raw.short_id, channel_id: raw.channel_id, channel_type: 5,
      name: boundedText(raw.name, 100), creator_uid: raw.creator_uid, status: raw.status }
  }

  async #rules(path, signal) {
    const raw = await this.#call(path + '/md', undefined, signal)
    if (typeof raw?.content !== 'string' || Buffer.byteLength(raw.content, 'utf8') > 10240
      || !Number.isSafeInteger(raw.version) || raw.version < 0) fail('invalid_rule_response')
    return { content: raw.content, version: raw.version }
  }

  async #editRules(path, content, signal) {
    // The server checks IsBotAdmin (bot_admin=1), NOT member.role. That bit is
    // not published by GET /members. Never substitute owner/admin role, a
    // config flag, or the bot owner's role for this atomic server-side check.
    const raw = await this.#call(path + '/md', { content }, signal, 'PUT')
    if (!Number.isSafeInteger(raw?.version) || raw.version < 1) fail('mutation_unconfirmed')
    return { ok: true, version: raw.version }
  }

  #message(raw, scope, sender, details = false) {
    if (!object(raw) || !id(raw.message_id) || !seq(raw.message_seq) || !validUid(raw.from_uid)
      || raw.channel_type !== scope.route.channel_type) fail('invalid_message_response')
    const channel = scope.route.channel_id
    // WuKong sorts DM peers by CRC32, not lexically. Either order is the
    // exact same two-party conversation; no third participant is accepted.
    const dmIDs = [channel, channel + '@' + this.#config.botUid, this.#config.botUid + '@' + channel]
    if (scope.group ? raw.channel_id !== channel : !dmIDs.includes(raw.channel_id)
      || ![channel, this.#config.botUid].includes(raw.from_uid)) fail('message_outside_channel')
    if ([raw, raw.extra, raw.message_extra].some(extra => extra && [extra.revoke, extra.revoked, extra.is_deleted].some(flag))) fail('message_unavailable')
    let payload = raw.payload
    if (typeof payload === 'string' && payload.length <= 120000) {
      try { payload = JSON.parse(payload.trimStart().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8')) }
      catch { fail('invalid_message_response') }
    }
    if (!object(payload) || payload.event != null || payload.space_id != null && payload.space_id !== this.#config.spaceId) fail('message_unavailable')
    if (payload.visibles != null && (!Array.isArray(payload.visibles)
      || payload.visibles.length > 0 && !payload.visibles.includes(sender))) fail('message_unavailable')
    const edited = raw.message_extra?.content_edit ?? raw.extra?.content_edit
    if (edited) {
      if (typeof edited !== 'string' || edited.length > 120000) fail('invalid_message_response')
      try { payload = JSON.parse(edited) } catch { payload = { type: 1, content: edited } }
      if (!object(payload) || payload.visibles != null || payload.event != null) fail('invalid_message_response')
    }
    const normalized = normalizeOctoContent(payload, { allowFiles: details })
    const attachments = normalized?.attachment ? [normalized.attachment] : normalized?.attachments ?? []
    return { message_id: id(raw.message_id), message_seq: raw.message_seq, from_uid: raw.from_uid,
      type: payload.type, text: messageText(normalized?.text),
      // Metadata comes from the live, visibility-checked message, not the index.
      // No URLs, indexed file-body excerpts, downloads, or unbounded attachments.
      ...(details && attachments.length && { attachments: attachments.slice(0, 2).map(item => ({
        kind: item.kind, name: boundedText(item.name, 80), mime: boundedText(item.mime, 100),
        ...(item.size !== undefined && { size: item.size }),
      })), attachments_truncated: attachments.length > 2 }) }
  }

  async #readMessage(scope, sender, messageId, signal, details = false) {
    if (!id(messageId)) fail('invalid_arguments')
    const base = scope.group ? scope.root + (scope.thread ? '/threads/' + scope.thread : '')
      : '/v1/bot/messages/person/' + encodeURIComponent(scope.route.channel_id)
    const path = scope.group ? base + '/messages/' + messageId : base + '/' + messageId
    const result = this.#message(await this.#call(path, undefined, signal), scope, sender, details)
    if (result.message_id !== messageId) fail('message_outside_channel')
    return result
  }

  async #search(scope, sender, operation, args, signal) {
    const around = operation === 'messages.search_around'
    const size = args.limit ?? (around ? 5 : 10)
    // A bot-visible anchor need not be visible to the requester. Verify it BEFORE
    // asking for its neighbors, and again after the search to catch changed visibility.
    if (around) await this.#readMessage(scope, sender, args.anchor_message_id, signal)
    const body = { ...scope.route, page_size: size, ...(args.filters && { filters: args.filters }),
      ...(around ? { anchor_message_id: args.anchor_message_id }
        : { sort: args.sort ?? 'time_desc', ...(args.keyword !== undefined && { keyword: args.keyword.trim() }),
          ...(args.cursor && { cursor: args.cursor }) }) }
    let raw
    try { raw = await this.#call(searchEndpoints[operation], body, signal) }
    catch (error) {
      if (error instanceof ChannelApiError && error.code.startsWith('api_')) {
        throw new ChannelApiError(error.code, 'Search requires a User Bot, an enabled server search backend, and current channel access. No retry or identity fallback was attempted.')
      }
      throw error
    }
    const rows = value => {
      if (!Array.isArray(value)) fail('invalid_search_response')
      if (value.length > size) fail('response_limit_exceeded')
      return value
    }
    const seen = new Set()
    const hit = (row, kind, channelRequired = true) => {
      if (!object(row) || typeof row.message_id !== 'string' || !id(row.message_id) || !seq(row.message_seq)
        || !validUid(row.sender_id) || seen.has(row.message_id)
        || (channelRequired || Object.hasOwn(row, 'channel_id')) && row.channel_id !== scope.route.channel_id
        || Object.hasOwn(row, 'channel_type') && row.channel_type !== scope.route.channel_type) fail('invalid_search_response')
      seen.add(row.message_id)
      return { row, kind }
    }
    let entries, before, anchor, after
    if (around) {
      if (!object(raw) || typeof raw.has_more_before !== 'boolean' || typeof raw.has_more_after !== 'boolean'
        || raw.anchor?.message_id !== args.anchor_message_id) fail('invalid_search_response')
      anchor = hit(raw.anchor)
      before = rows(raw.before).map(row => hit(row))
      after = rows(raw.after).map(row => hit(row))
      entries = [anchor, ...before, ...after]
    } else {
      if (!object(raw?.pagination) || typeof raw.pagination.has_more !== 'boolean'
        || typeof raw.pagination.next_cursor !== 'string' || raw.pagination.next_cursor.length > 4096
        || raw.pagination.has_more && !raw.pagination.next_cursor) fail('invalid_search_response')
      entries = rows(raw.data).map(row => {
        if (operation === 'messages.search_all') {
          if (!object(row) || !['message', 'file'].includes(row.result_type)
            || Object.hasOwn(row, row.result_type === 'file' ? 'message' : 'file')) fail('invalid_search_response')
          return hit(row[row.result_type], row.result_type)
        }
        if (operation === 'messages.search_media') {
          if (!['image', 'video'].includes(row?.media_kind)) fail('invalid_search_response')
          return hit(row, row.media_kind, false)
        }
        return hit(row, operation === 'messages.search_files' ? 'file' : undefined, operation !== 'messages.search_files')
      })
    }
    for (const entry of entries) {
      const { row, kind } = entry
      const message = await this.#readMessage(scope, sender, row.message_id, signal, true)
      if (!Number.isInteger(message.type) || message.type < 1 || message.type >= 99
        || message.message_seq !== row.message_seq || message.from_uid !== row.sender_id
        || kind === 'file' && message.type !== 8 || kind === 'message' && message.type === 8
        || kind === 'image' && message.type !== 2 || kind === 'video' && message.type !== 5) fail('invalid_search_response')
      entry.value = { ...message, name: boundedText(row.sender_name, 100), ...(kind && { result_type: kind }) }
    }
    // Search and verification may take time; membership loss during either must
    // prevent returning even an otherwise valid page. No cursor traversal/retries.
    await this.#access(scope, sender, false, signal)
    return around ? { before: before.map(entry => entry.value), anchor: anchor.value, after: after.map(entry => entry.value),
      has_more_before: raw.has_more_before, has_more_after: raw.has_more_after }
      : { messages: entries.map(entry => entry.value), more: raw.pagination.has_more, next_cursor: raw.pagination.next_cursor }
  }

  async dispatch(route, sender, operation, args = {}, signal = new AbortController().signal) {
    const definition = specs.get(operation)
    if (!definition) fail('unknown_operation')
    validate(args, definition.parameters)
    // Copy admitted inputs before the first await; do not retain mutable model args.
    args = JSON.parse(JSON.stringify(args))
    const search = Object.hasOwn(searchEndpoints, operation)
    if (search) validateSearch(operation, args)
    if (['rules.edit', 'thread.rules.edit'].includes(operation) && Buffer.byteLength(args.content, 'utf8') > 10240) fail('invalid_arguments')
    if (operation === 'group.edit' && !Object.keys(args).length) fail('invalid_arguments')
    const scope = this.#scope(route)
    if (!definition.available) fail(definition.unavailableReason)
    const voice = operation.startsWith('voice.context.')
    if (voice) this.#requireOwnerDM(scope, sender)
    if (operation === 'groups.create') this.#requireOwner(sender)
    if (!scope.group && !voice && !search && !['inspect', 'messages.recent', 'messages.read', 'messages.edit', 'messages.notify',
      'messages.mark_read', 'space.members.search', 'groups.create'].includes(operation)) fail('group_required')
    const thread = operation.startsWith('thread.') ? this.#threadPath(scope, args) : undefined
    const access = await this.#access(scope, sender, definition.mutating, signal)
    const requireAdmin = () => { if (scope.group && !admin(access.actor)) fail('requester_admin_required') }

    if (operation === 'inspect') return { ...scope.route, ...(access.group && { group: access.group }),
      requester_group_admin: admin(access.actor), bot_group_admin: admin(access.bot),
      bot_rules_admin: 'unknown', bot_rules_admin_reason: 'bot_members_endpoint_omits_bot_admin',
      broadcast_available: !!scope.group && admin(access.actor) && access.group.status === 1 }
    if (operation === 'groups.list') return [access.group]
    if (operation === 'members') return { members: access.rows.slice(0, args.limit ?? MAX_ROWS), total: access.rows.length,
      truncated: access.rows.length > (args.limit ?? MAX_ROWS) }
    if (operation === 'space.members.search') {
      if (await this.#principal(sender, signal) !== 'human') fail('requester_not_allowed')
      const size = args.limit ?? 20, page = args.page ?? 1
      const raw = await this.#call('/v1/bot/space/members?' + new URLSearchParams({ space_id: this.#config.spaceId,
        keyword: args.keyword.trim(), limit: size, page }), undefined, signal)
      const seen = new Set()
      const members = list(raw, size).map(row => {
        if (!validUid(row?.uid) || ![0, 1].includes(row.robot) || seen.has(row.uid)) fail('invalid_member_response')
        seen.add(row.uid)
        return { uid: row.uid, name: boundedText(row.name, 100) || row.uid, robot: row.robot }
      })
      return { members, page, more: members.length === size }
    }
    if (operation === 'groups.create') {
      // Name search is only discovery: its one-page LIKE results are not an
      // authorization cache. This exact lookup is mandatory for the owner and
      // every recipient, even when a previous search resolved their names.
      for (const target of new Set([sender, ...args.uids])) {
        if (await this.#principal(target, signal) !== 'human') fail('human_member_required')
      }
      await this.#access(scope, sender, true, signal)
      this.#requireOwner(sender)
      const raw = await this.#call('/v1/bot/createGroup', {
        name: args.name.trim(), members: args.uids, creator: sender, space_id: this.#config.spaceId,
      }, signal)
      if (typeof raw?.group_no !== 'string' || !/^[a-fA-F0-9]{32}$/.test(raw.group_no)
        || raw.group_no === scope.group || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200) fail('mutation_unconfirmed')
      const skipped = raw.skipped_members === undefined ? [] : list(raw.skipped_members, args.uids.length)
      if (skipped.some(target => !args.uids.includes(target)) || new Set(skipped).size !== skipped.length) fail('invalid_member_response')
      return { group_no: raw.group_no, name: boundedText(raw.name, 100), space_id: this.#config.spaceId,
        ...(skipped.length && { skipped_members: skipped }) }
    }
    if (operation === 'members.add' || operation === 'members.remove') {
      requireAdmin()
      const adding = operation === 'members.add'
      if (adding) {
        // Exact-Space eligibility prevents bot membership in some other Space
        // from turning a guessed UID into an invitation to this group.
        for (const target of args.uids) {
          if (await this.#principal(target, signal) !== 'human') fail('human_member_required')
        }
      }
      const fresh = await this.#access(scope, sender, true, signal)
      if (!admin(fresh.actor)) fail('mutation_permission_changed')
      if (!adding) {
        for (const target of args.uids) {
          const member = fresh.rows.find(row => row.uid === target)
          if (!member) fail('target_not_member')
          if (target === this.#config.botUid || member.role !== 0) fail('protected_member')
        }
      }
      // Add requires bot membership; remove additionally has an atomic
      // IsBotAdmin + privileged-target guard in groups.go. No role substitution.
      const action = adding ? 'add' : 'remove', countKey = adding ? 'added' : 'removed'
      const raw = await this.#call(scope.root + '/members/' + action, { members: args.uids }, signal)
      if (raw?.ok !== true || !Number.isSafeInteger(raw[countKey]) || raw[countKey] < 0
        || raw[countKey] > (adding ? args.uids.length : MAX_MEMBERS)) fail('mutation_unconfirmed')
      const skipped = adding && raw.skipped_bots !== undefined ? list(raw.skipped_bots, args.uids.length) : []
      if (skipped.some(target => !args.uids.includes(target)) || new Set(skipped).size !== skipped.length) fail('invalid_member_response')
      return { ok: true, group_no: scope.group, [countKey]: raw[countKey], ...(skipped.length && { skipped_bots: skipped }) }
    }
    if (voice) {
      if (await this.#principal(sender, signal) !== 'human') fail('requester_not_allowed')
      this.#requireOwnerDM(scope, sender)
      // This official endpoint deliberately selects the bot's primary active
      // Space. It has no channel/Space override; report its true scope explicitly.
      const voiceScope = 'bot_owner_primary_space'
      if (operation === 'voice.context.read') {
        const raw = await this.#call('/v1/bot/voice/context', undefined, signal)
        if (raw?.status !== 200 || typeof raw.has_context !== 'boolean' || typeof raw.context !== 'string'
          || raw.context.length > 20000 || Array.from(raw.context).length > 10000) fail('invalid_voice_response')
        this.#requireOwnerDM(scope, sender)
        return { scope: voiceScope, has_context: raw.has_context, context: raw.context, updated_at: boundedText(raw.updated_at, 100) }
      }
      const update = operation === 'voice.context.update'
      await this.#access(scope, sender, true, signal)
      this.#requireOwnerDM(scope, sender)
      const raw = await this.#call('/v1/bot/voice/context', update ? { context: args.context.trim() } : undefined, signal, update ? 'PUT' : 'DELETE')
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, scope: voiceScope }
    }
    if (operation === 'targets.resolve') {
      const query = args.name.trim().toLowerCase(), size = args.limit ?? 20
      const candidates = []
      if (access.group.name.toLowerCase().includes(query)) candidates.push({ kind: 'group', ...access.group, channel_id: scope.group, channel_type: 2 })
      let threads, more = false
      if (scope.thread) {
        if ((args.page ?? 1) !== 1) fail('invalid_arguments')
        threads = [this.#thread(await this.#call(scope.root + '/threads/' + scope.thread, undefined, signal), scope, scope.thread)]
      } else {
        const page = await this.#threads(scope, args.page ?? 1, size, signal)
        threads = page.threads; more = page.more
      }
      for (const row of threads) if (row.name.toLowerCase().includes(query)) candidates.push({ kind: 'thread', ...row })
      return { candidates: candidates.slice(0, size), searched_threads: threads.length, more: more || candidates.length > size }
    }
    if (operation === 'rules.read') return this.#rules(scope.root, signal)
    if (operation === 'rules.edit') {
      requireAdmin()
      return this.#editRules(scope.root, args.content, signal)
    }
    if (operation === 'group.edit') {
      requireAdmin()
      const raw = await this.#call(scope.root + '/info', args, signal, 'PUT')
      if (raw?.ok !== true) fail('mutation_unconfirmed')
      return { ok: true, group_no: scope.group }
    }
    if (operation === 'threads.list') {
      return this.#threads(scope, args.page ?? 1, args.limit ?? 20, signal)
    }
    if (operation === 'threads.create') {
      requireAdmin()
      if (!/^[a-fA-F0-9]{32}$/.test(scope.group)) fail('invalid_thread_scope')
      // No source_message_id or on_behalf_of: no cross-channel copying/grant escalation.
      const result = this.#thread(await this.#call(scope.root + '/threads', { name: args.name }, signal), scope)
      if (result.creator_uid !== this.#config.botUid) fail('mutation_unconfirmed')
      return result
    }
    if (thread) {
      const detail = this.#thread(await this.#call(thread.path, undefined, signal), scope, thread.selected)
      if (operation === 'thread.read') return detail
      if (operation === 'thread.rules.read') return this.#rules(thread.path, signal)
      if (operation === 'thread.members') {
        const rows = list(await this.#call(thread.path + '/members', undefined, signal), MAX_MEMBERS)
          .map(row => {
            if (!validUid(row?.uid) || ![0, 1].includes(row.role)) fail('invalid_member_response')
            return { uid: row.uid, name: boundedText(row.name, 100) || row.uid, role: row.role }
          })
        return { members: rows.slice(0, args.limit ?? MAX_ROWS), total: rows.length, truncated: rows.length > (args.limit ?? MAX_ROWS) }
      }
      const managed = ['thread.archive', 'thread.delete'].includes(operation)
      if (managed || operation === 'thread.rules.edit') requireAdmin()
      if (managed) {
        if (detail.creator_uid !== this.#config.botUid && !admin(access.bot)) fail('bot_permission_required')
      }
      if (operation === 'thread.leave' && detail.creator_uid === this.#config.botUid) fail('thread_creator_cannot_leave')
      if (operation === 'thread.join' && detail.status !== 1) fail('thread_not_active')
      // Membership is re-read after the target lookup, immediately before writing.
      const fresh = await this.#access(scope, sender, true, signal)
      if ((managed || operation === 'thread.rules.edit') && !admin(fresh.actor)) fail('mutation_permission_changed')
      if (managed && detail.creator_uid !== this.#config.botUid && !admin(fresh.bot)) fail('mutation_permission_changed')
      if (operation === 'thread.rules.edit') return this.#editRules(thread.path, args.content, signal)
      const result = operation === 'thread.delete'
        ? await this.#call(thread.path, undefined, signal, 'DELETE')
        : await this.#call(thread.path + '/' + operation.split('.')[1], {}, signal)
      if (result?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, short_id: thread.selected, actor_uid: this.#config.botUid }
    }
    if (operation === 'messages.read') return this.#readMessage(scope, sender, args.message_id, signal)
    if (operation === 'messages.recent') {
      if (args.before_seq === 1) return { messages: [], more: false }
      const size = args.limit ?? 20
      const raw = await this.#call('/v1/bot/messages/sync', { ...scope.route, limit: size, pull_mode: 0,
        start_message_seq: args.before_seq ? args.before_seq - 1 : 0, end_message_seq: 0 }, signal)
      if (!object(raw)) fail('invalid_api_response')
      const rows = list(raw.messages, size), messages = [], seen = new Set()
      for (const row of rows) {
        try {
          const message = this.#message(row, scope, sender)
          if ((!args.before_seq || message.message_seq < args.before_seq) && !seen.has(message.message_id)) {
            seen.add(message.message_id); messages.push(message)
          }
        } catch (error) {
          if (!(error instanceof ChannelApiError)) throw error
          // Hidden, revoked, malformed and foreign records never become model context.
        }
      }
      return { messages: messages.sort((a, b) => a.message_seq - b.message_seq), more: flag(raw.more) || rows.length === size }
    }
    if (search) return this.#search(scope, sender, operation, args, signal)
    if (operation === 'messages.notify') {
      const uids = args.uids ?? []
      if (args.all && uids.length) fail('invalid_arguments')
      if (!scope.group && (args.all || uids.length)) fail('group_required')
      if (args.all) {
        requireAdmin()
        // The reviewed send API requires bot membership, not bot_admin, for
        // mention flags. The requester admin requirement is our explicit
        // broadcast policy; do not add a nonexistent platform bot-role gate.
      }
      if (uids.some(uid => !access.rows?.some(row => row.uid === uid))) fail('mention_not_member')
      const payload = notificationPayload(args.text, uids, access.rows, args.all)
      const raw = await this.#call('/v1/bot/sendMessage', { ...scope.route, payload }, signal)
      if (!id(raw?.message_id)) fail('mutation_unconfirmed')
      return { ok: true, message_id: id(raw.message_id), ...scope.route, text: payload.content,
        ...(payload.mention && { mention: payload.mention }) }
    }
    if (operation === 'messages.edit') {
      requireAdmin()
      const message = await this.#readMessage(scope, sender, args.message_id, signal)
      if (message.from_uid !== this.#config.botUid) fail('bot_message_required')
      if (message.type !== 1) fail('plain_text_message_required')
      const fresh = await this.#access(scope, sender, true, signal)
      if (scope.group && !admin(fresh.actor)) fail('mutation_permission_changed')
      const raw = await this.#call('/v1/bot/message/edit', { ...scope.route, message_id: args.message_id,
        content_edit: JSON.stringify({ type: 1, content: args.text }) }, signal)
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, message_id: args.message_id }
    }
    if (operation === 'messages.mark_read') {
      for (const messageId of args.message_ids) await this.#readMessage(scope, sender, messageId, signal)
      await this.#access(scope, sender, true, signal)
      const raw = await this.#call('/v1/bot/readReceipt', { ...scope.route, message_ids: args.message_ids }, signal)
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, actor_uid: this.#config.botUid, message_ids: args.message_ids }
    }
    fail('unknown_operation')
  }
}
