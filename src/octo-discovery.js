import { apiErrorCode, officialApiErrorCode } from './api-errors.js'
import { validBotIdentity, validUid } from './config.js'

// octo-server f984d405: bot_api/{groups,threads,resolve_targets,space_principal,
// obo_generic_self}.go. This module handles directory metadata only. It is
// called on demand with the current account's authenticated bot transport.
const groupID = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value)
const shortID = value => typeof value === 'string' && /^\d{15,20}$/.test(value)
const pathUid = value => validUid(value) && value !== '.' && value !== '..'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const label = value => Array.from(value.slice(0, 200)).slice(0, 100).join('')
  .replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
const maxGroups = 1000
const maxPage = 1000
const maxLimit = 20
const defaultLimit = 10
const kinds = ['all', 'group', 'thread']
const grantStates = ['ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED']
const page = { type: 'integer', minimum: 1, maximum: maxPage }
const limit = { type: 'integer', minimum: 1, maximum: maxLimit }
const keyword = { type: 'string', minLength: 1, maxLength: 64 }
const group = { type: 'string', pattern: '^[a-fA-F0-9]{32}$' }
const uid = { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,128}$' }
const kind = { type: 'string', enum: kinds }
const spec = (name, description, properties = {}, required = []) => ({
  name, description: 'Verified User Bot owner in their own admitted DM only. ' + description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
  available: true, mutating: false, privateOnly: true, ownerOnly: true, dmAvailable: true,
})
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

export const octoDiscoverySpecs = freeze([
  spec('spaces.current', 'Confirm the account’s configured Octo Space. This is not a list of Spaces.'),
  spec('space.members.list', 'List one page of eligible humans and User Bots in this Space. An optional keyword filters names. '
    + 'A filtered page can be short or empty while more source rows remain. Does not establish friendship or channel access.',
  { page, limit, keyword }),
  spec('space.principals.get', 'Check one exact UID for current eligibility as a human or User Bot in this Space. '
    + 'No profile, contact information, or channel access is implied.', { uid }, ['uid']),
  spec('groups.list_joined', 'List one page of ordinary groups the Bot can access in this Space and the account allows. '
    + 'Pages are checked live and can be short; this is Bot metadata, not the requester’s own group list.', { page, limit }),
  spec('groups.info_joined', 'Read the name and notice of one exact active group in the Bot’s Space. Both the Bot and the requester must be members; the requester must be a current group owner or manager.', { group_no: group }, ['group_no']),
  spec('groups.members_joined', 'Read one page of members of one exact active group in the Bot’s Space. Requires current group owner or manager authority. Returns only UID, display name, role and bot flag.', { group_no: group, page, limit }, ['group_no']),
  spec('groups.resolve_targets', 'Find named group/topic candidates within the Bot’s current Space and route policy. '
    + 'Results can be partial; refine the name or ask the user to disambiguate. Does not authorize sending or message reads.',
  { name: keyword, kind, limit }, ['name']),
  spec('groups.threads.list', 'List one page of topic metadata for an exact parent group in the Bot’s current Space. '
    + 'Includes archived topics when visible. Use the returned channel ID and type to identify a topic.',
  { group_no: group, page, limit }, ['group_no']),
  spec('obo.scopes.list', 'Read this Bot’s own generic delegation scope status. ALL is an advisory policy binding, '
    + 'not a list of authorized channels or proof that legacy message search is permitted.'),
])
const definitions = new Map(octoDiscoverySpecs.map(item => [item.name, item]))
export const isOctoDiscoveryOperation = name => definitions.has(name)

export class OctoDiscoveryError extends Error {
  constructor(code) {
    super(code)
    this.name = 'OctoDiscoveryError'
    this.code = code
  }
}
const fail = code => { throw new OctoDiscoveryError(code) }
const invalid = () => fail('invalid_discovery_response')
const array = (value, max) => {
  if (!Array.isArray(value) || value.length > max) invalid()
  return value
}
const routeKey = row => row.channel_type + ':' + row.channel_id
const unique = (seen, key) => {
  if (seen.has(key)) invalid()
  seen.add(key)
}
const errors = 'err.server.bot_api.'
const unavailableGroup = new Set([errors + 'not_group_member', errors + 'group_not_found', errors + 'group_disbanded'])
const unavailablePrincipal = new Set([errors + 'user_not_found'])
const groupRoot = id => '/v1/bot/groups/' + id
const query = (path, params) => path + '?' + new URLSearchParams(params)

function readArgs(operation, input) {
  const { properties, required } = definitions.get(operation).parameters
  if (!object(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid_arguments')
  const args = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (!Object.hasOwn(properties, key) || !Object.hasOwn(field, 'value')) fail('invalid_arguments')
    const value = field.value
    if (key === 'page' || key === 'limit') {
      if (!Number.isSafeInteger(value) || value < 1 || value > properties[key].maximum) fail('invalid_arguments')
    } else if (key === 'uid') {
      if (!pathUid(value)) fail('invalid_arguments')
    } else if (key === 'group_no') {
      if (!groupID(value)) fail('invalid_arguments')
    } else if (key === 'kind') {
      if (!kinds.includes(value)) fail('invalid_arguments')
    } else {
      if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 64
        || /[\p{Cc}\p{Cf}]/u.test(value)) fail('invalid_arguments')
    }
    args[key] = key === 'name' || key === 'keyword' ? value.trim() : value
  }
  if (required.some(key => !Object.hasOwn(args, key))) fail('invalid_arguments')
  return args
}

function projectThread(row, parent, expected) {
  if (!object(row) || row.group_no !== parent || !shortID(row.short_id)
    || row.channel_type !== 5 || row.channel_id !== parent + '____' + row.short_id
    || expected !== undefined && row.short_id !== expected
    || typeof row.name !== 'string' || ![1, 2].includes(row.status)) invalid()
  return { kind: 'thread', channel_id: row.channel_id, channel_type: 5, group_no: parent,
    short_id: row.short_id, name: label(row.name), status: row.status }
}

export class OctoDiscovery {
  #request
  #verifyAccount
  #config
  #owner
  #revoked = false

  // verifyAccount(signal) reuses OctoClient.verify with this transport's own
  // bot token; neither the verifier nor the transport accepts model identity.
  constructor({ request, verifyAccount, config }) {
    if (typeof request !== 'function' || typeof verifyAccount !== 'function' || !validBotIdentity(config)) {
      fail('invalid_discovery_config')
    }
    const { botUid, botKind, spaceId, channelPolicy = 'joined', senderPolicy = 'octo' } = config
    if (!['joined', 'allowlist'].includes(channelPolicy) || !['octo', 'allowlist'].includes(senderPolicy)) fail('invalid_discovery_config')
    this.#request = request
    this.#verifyAccount = verifyAccount
    this.#config = { botUid, botKind, spaceId, channelPolicy, senderPolicy,
      allowed: new Set(config.allowed ?? []), groups: new Set(config.groups ?? []), threads: new Set(config.threads ?? []) }
    // The host sets the verified owner on the account config. Never infer
    // ownership from model args, labels, or the legacy OBO grant.
    this.#owner = () => config.ownerUid
  }

  revoke() { this.#revoked = true }

  #active(sender, signal) {
    if (this.#revoked) fail('account_configuration_changed')
    if (signal.aborted) fail('aborted')
    const { botUid, botKind, senderPolicy, allowed } = this.#config
    if (botKind === 'app') fail('api_unsupported')
    if (!pathUid(sender) || sender.includes('@') || sender === botUid || this.#owner() !== sender
      || senderPolicy === 'allowlist' && !allowed.has(sender)) fail('owner_dm_required')
  }

  async #get(path, ctx, expectedErrors) {
    const { sender, signal } = ctx
    this.#active(sender, signal)
    let result
    try { result = await this.#request(path, undefined, signal, { method: 'GET' }) }
    catch (error) {
      this.#active(sender, signal)
      if (expectedErrors?.has(officialApiErrorCode(error))) return undefined
      fail(apiErrorCode(error))
    }
    this.#active(sender, signal)
    if (result === undefined || object(result) && (result.error != null || result.ok === false
      || Number.isInteger(result.status) && result.status >= 400)) invalid()
    return result
  }

  async #principal(uid, ctx) {
    const raw = await this.#get(query('/v1/bot/space/principals/' + encodeURIComponent(uid), { space_id: this.#config.spaceId }),
      ctx, unavailablePrincipal)
    if (raw === undefined) return null
    if (!object(raw) || raw.uid !== uid || !['human', 'user_bot'].includes(raw.principal_type)) invalid()
    return { uid, principal_type: raw.principal_type }
  }

  async #verifyAccess(ctx) {
    const { sender, signal } = ctx
    this.#active(sender, signal)
    let identity
    try { identity = await this.#verifyAccount(signal) } catch {
      this.#active(sender, signal)
      fail('discovery_account_unverified')
    }
    this.#active(sender, signal)
    if (identity?.botUid !== this.#config.botUid || identity.spaceId !== this.#config.spaceId
      || identity.ownerUid !== sender || identity.botKind === 'app') fail('discovery_account_unverified')
    if ((await this.#principal(ctx.sender, ctx))?.principal_type !== 'human'
      || (await this.#principal(this.#config.botUid, ctx))?.principal_type !== 'user_bot') fail('discovery_space_access_denied')
  }

  async #members(args, ctx) {
    const page = args.page ?? 1, limit = args.limit ?? defaultLimit
    const raw = array(await this.#get(query('/v1/bot/space/members', { space_id: this.#config.spaceId, page, limit,
      ...(args.keyword && { keyword: args.keyword }) }), ctx), limit)
    const seen = new Set(), members = []
    for (const row of raw) {
      if (!object(row) || !pathUid(row.uid) || typeof row.name !== 'string' || ![0, 1].includes(row.robot)) invalid()
      unique(seen, row.uid.toLowerCase())
      // The broad list LEFT JOINs the user table. Do not trust its robot
      // flag alone or emit stale rows, app bots, or names of ineligible UIDs.
      const principal = await this.#principal(row.uid, ctx)
      if (principal && (principal.principal_type === 'user_bot') === (row.robot === 1)) {
        members.push({ ...principal, name: label(row.name) || row.uid })
      }
    }
    return { members, page, more: raw.length === limit && page < maxPage }
  }

  #allows(type, id) {
    const { channelPolicy, groups, threads } = this.#config
    return channelPolicy === 'joined' || (type === 2 ? groups : threads).has(id)
  }

  async #groups(ctx) {
    const { spaceId } = this.#config
    const raw = await this.#get(query('/v1/bot/groups', { space_id: spaceId }), ctx)
    // Go may serialize an empty directory as null.
    const result = new Set(), seen = new Set()
    for (const row of array(raw === null ? [] : raw, maxGroups)) {
      if (!object(row) || !pathUid(row.group_no) || row.space_id !== spaceId || typeof row.name !== 'string') invalid()
      unique(seen, row.group_no.toLowerCase())
      // The stricter active-member endpoint only accepts native hex group IDs.
      if (groupID(row.group_no)) result.add(row.group_no)
    }
    return result
  }

  async #group(id, ctx, notice = false) {
    const raw = await this.#get(groupRoot(id), ctx, unavailableGroup)
    if (raw === undefined) return null
    if (!object(raw) || raw.group_no !== id || typeof raw.name !== 'string' || ![0, 1, 2].includes(raw.status)) invalid()
    if (raw.status !== 1) return null
    return { kind: 'group', channel_id: id, channel_type: 2, group_no: id, name: label(raw.name),
      ...(notice && { notice: typeof raw.notice === 'string'
        ? raw.notice.slice(0, 4000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu, '') : '' }) }
  }

  async #groupRoster(id, ctx) {
    const raw = await this.#get(groupRoot(id) + '/members', ctx, unavailableGroup)
    if (raw == null) fail('discovery_target_not_allowed')
    const seen = new Set(), rows = []
    for (const row of array(raw, maxGroups)) {
      if (!object(row) || !pathUid(row.uid) || typeof row.name !== 'string'
        || ![0, 1, 2].includes(row.role) || ![0, 1].includes(row.robot)) invalid()
      unique(seen, row.uid.toLowerCase())
      if (row.status !== undefined && row.status !== 1
        || row.is_deleted !== undefined && row.is_deleted !== 0 && row.is_deleted !== false) continue
      rows.push({ uid: row.uid, name: label(row.name) || row.uid, role: row.role, robot: row.robot })
    }
    if (!rows.some(row => row.uid === this.#config.botUid && row.robot === 1)
      || !rows.some(row => row.uid === ctx.sender && row.robot === 0 && [1, 2].includes(row.role))) {
      fail('discovery_target_not_allowed')
    }
    return rows
  }

  async #inspectGroup(args, ctx, roster) {
    const id = args.group_no
    if (!this.#allows(2, id) || !(await this.#groups(ctx)).has(id)) fail('discovery_target_not_allowed')
    await this.#groupRoster(id, ctx)
    const group = await this.#group(id, ctx, !roster)
    if (!group || !(await this.#groups(ctx)).has(id)) fail('discovery_target_not_allowed')
    const fresh = await this.#groupRoster(id, ctx)
    if (!roster) return { group }
    // Use the final roster; never expose owner metadata or creation timestamps.
    const page = args.page ?? 1, limit = args.limit ?? defaultLimit
    return { group_no: id, members: fresh.slice((page - 1) * limit, page * limit), page, more: page * limit < fresh.length }
  }

  async #threadPage(id, page, size, ctx) {
    // Unlike groups and resolve/targets, the thread list requires an active
    // parent-group membership (including the Bot blacklist check). Its DTO
    // also has message previews and counters: never return those.
    const raw = await this.#get(query(groupRoot(id) + '/threads', { page_index: page, page_size: size }), ctx, unavailableGroup)
    if (raw === undefined) return null
    if (!object(raw) || !Number.isSafeInteger(raw.count) || raw.count < 0) invalid()
    const seen = new Set()
    const rows = array(raw.list, size).map(row => {
      const thread = projectThread(row, id)
      unique(seen, routeKey(thread))
      return thread
    })
    return { rows, more: page * size < raw.count }
  }

  async #thread(id, short, ctx) {
    const raw = await this.#get(groupRoot(id) + '/threads/' + short, ctx, unavailableGroup)
    return raw === undefined ? null : projectThread(raw, id, short)
  }

  async #joined(args, ctx) {
    const page = args.page ?? 1, size = args.limit ?? defaultLimit
    const ids = [...await this.#groups(ctx)].filter(id => this.#allows(2, id)).sort()
      .slice((page - 1) * size, page * size)
    const groups = []
    for (const id of ids) {
      const group = await this.#group(id, ctx)
      if (group && await this.#threadPage(id, 1, 1, ctx)) groups.push(group)
    }
    const fresh = await this.#groups(ctx)
    return { groups: groups.filter(row => fresh.has(row.group_no)), page }
  }

  async #resolve(args, ctx) {
    const groups = await this.#groups(ctx)
    const kind = args.kind ?? 'all', limit = args.limit ?? defaultLimit
    const raw = await this.#get(query('/v1/bot/resolve/targets', { name: args.name, kind, limit }), ctx)
    const max = kind === 'all' ? limit * 2 : limit
    if (!object(raw) || typeof raw.truncated !== 'boolean') invalid()
    const rows = array(raw.candidates, max)
    if (raw.total !== rows.length) invalid()
    const seen = new Set(), parents = new Map(), candidates = []
    for (const row of rows) {
      if (!object(row) || !['group', 'thread'].includes(row.kind) || kind !== 'all' && row.kind !== kind
        || typeof row.name !== 'string'
        || (row.kind === 'group' ? row.channel_type !== 2 || !pathUid(row.group_no) || row.channel_id !== row.group_no
          : row.channel_type !== 5 || !groupID(row.group_no) || !shortID(row.short_id)
            || row.channel_id !== row.group_no + '____' + row.short_id)) invalid()
      unique(seen, routeKey(row).toLowerCase())
      // The resolver has NO Space selector and caps each kind before we can
      // filter it. Never return its counts, truncation, or parent-name fields.
      if (candidates.length >= limit || !groups.has(row.group_no) || !this.#allows(row.channel_type, row.channel_id)) continue
      if (!parents.has(row.group_no)) parents.set(row.group_no, await this.#group(row.group_no, ctx))
      const parent = parents.get(row.group_no)
      if (!parent) continue
      const candidate = row.kind === 'group'
        ? await this.#threadPage(row.group_no, 1, 1, ctx) && parent
        : await this.#thread(row.group_no, row.short_id, ctx)
      if (candidate && candidate.name === label(row.name)) candidates.push(candidate)
    }
    const fresh = await this.#groups(ctx)
    return { candidates: candidates.filter(row => fresh.has(row.group_no)) }
  }

  async #threads(args, ctx) {
    const id = args.group_no, page = args.page ?? 1, size = args.limit ?? defaultLimit
    const allowlist = this.#config.channelPolicy === 'allowlist'
    const prefix = id + '____'
    const allowed = allowlist ? [...this.#config.threads].filter(address => typeof address === 'string'
      && address.startsWith(prefix) && shortID(address.slice(prefix.length))).sort() : []
    if (allowlist && !this.#allows(2, id) && !allowed.length) fail('discovery_target_not_allowed')
    const selected = allowlist ? allowed.slice((page - 1) * size, page * size) : []
    if (allowlist && !selected.length) return { threads: [], page, more: false }
    if (!(await this.#groups(ctx)).has(id) || !await this.#group(id, ctx)) fail('discovery_target_not_allowed')
    let result
    if (allowlist) {
      const rows = []
      // Check only exact local routes. The detail handler enforces active
      // Bot membership without fetching other topics or their counts.
      for (const address of selected) {
        const row = await this.#thread(id, address.slice(prefix.length), ctx)
        if (row) rows.push(row)
      }
      result = { rows, more: page * size < allowed.length }
    } else {
      result = await this.#threadPage(id, page, size, ctx)
      if (!result) fail('discovery_target_not_allowed')
    }
    if (!(await this.#groups(ctx)).has(id)) fail('discovery_target_not_allowed')
    return { threads: result.rows, page, more: result.more && page < maxPage }
  }

  async #scopes(ctx) {
    const raw = array(await this.#get(query('/v1/bot/obo-grants/self', { space_id: this.#config.spaceId }), ctx), 1)
    if (!raw.length) return { grant: null }
    const [row] = raw
    if (!object(row) || row.grantor_uid !== ctx.sender || !grantStates.includes(row.grant_state)
      || typeof row.global_enabled !== 'boolean' || array(row.scopes, 1).some(scope => scope !== 'ALL')) invalid()
    return { grant: { state: row.grant_state, global_enabled: row.global_enabled, scopes: [...row.scopes] } }
  }

  async dispatch(route, sender, operation, input = {}, signal = new AbortController().signal) {
    if (!isOctoDiscoveryOperation(operation)) fail('unknown_operation')
    if (!(signal instanceof AbortSignal)) fail('invalid_arguments')
    this.#active(sender, signal)
    if (!object(route) || route.channel_type !== 1 || route.channel_id !== sender) fail('owner_dm_required')
    const args = readArgs(operation, input)
    const ctx = { sender, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }
    await this.#verifyAccess(ctx)
    if (operation === 'spaces.current') return { space_id: this.#config.spaceId }
    let result
    switch (operation) {
      case 'space.members.list': result = await this.#members(args, ctx); break
      case 'space.principals.get': result = { principal: await this.#principal(args.uid, ctx) }; break
      case 'groups.list_joined': result = await this.#joined(args, ctx); break
      case 'groups.info_joined': result = await this.#inspectGroup(args, ctx, false); break
      case 'groups.members_joined': result = await this.#inspectGroup(args, ctx, true); break
      case 'groups.resolve_targets': result = await this.#resolve(args, ctx); break
      case 'groups.threads.list': result = await this.#threads(args, ctx); break
      case 'obo.scopes.list': result = await this.#scopes(ctx); break
    }
    await this.#verifyAccess(ctx)
    this.#active(sender, ctx.signal)
    return result
  }
}
