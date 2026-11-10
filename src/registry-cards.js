// Verified against octo-server f984d40 (bot_api/card_profile.go,
// card_template_catalog.go, send.go), Gateway ec4ac3e (transport/api/cards.ts)
// and OpenClaw 3cdb7e7 (api-fetch.ts). The Bot API renders and validates inside
// send/edit. Neither a local renderer nor the manager catalog is a Bot preview.
import { isDeepStrictEqual, types } from 'node:util'
import { apiErrorCode, OctoError } from './api-errors.js'
import { validUid } from './config.js'
import { channelSequence, decimalId } from './octo.js'
import { ruleScope } from './rules.js'

const PROFILE = '/v1/bot/card/profile'
const SEND = '/v1/bot/sendMessage'
const EDIT = '/v1/bot/message/edit'
const WIRE = 'template-ref/v1'
const CARD_VERSION = '1.5'
const DISPLAY = 'octo/v1'
const INTERACTIVE = 'octo/v2'
const REASONING = 'ai.reasoning-process'
const MAX_REQUEST_BYTES = 24 * 1024
const MAX_STRING_BYTES = 8 * 1024
const MAX_FRAME_BYTES = 128 * 1024
const MAX_DEPTH = 8
const MAX_NODES = 512
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const plainObject = value => isObject(value) && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const idPattern = /^[a-z][a-z0-9_.-]{0,127}$/
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const dataKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const validVersion = value => typeof value === 'string' && value.length <= 64 && versionPattern.test(value)
const token = value => typeof value === 'string' && tokenPattern.test(value)
const validTemplateId = value => typeof value === 'string' && idPattern.test(value)
const safeSeq = value => Number.isSafeInteger(value) && value >= 0
const sameRef = (left, right) => left?.id === right?.id && left?.version === right?.version
const statusOK = value => value === undefined || [0, 1, 2, 3, 200].includes(value)
const success = raw => isObject(raw) && raw.error == null && raw.ok !== false && statusOK(raw.status)

const reservedKeys = new Set([
  'proto', 'constructor', 'prototype', 'tojson', 'card', 'cardversion', 'profile',
  'renderprofile', 'plain', 'metadata', 'octo', 'template', 'templateref', 'catalogprovenance',
  'provenance', 'principaltype', 'principalid', 'spaceid', 'onbehalfof', 'actualsenderuid',
  'fromuid', 'senderuid', 'robotid', 'botuid', 'channelid', 'channeltype', 'messageid',
  'messageseq', 'clientmsgno', 'cardseq', 'expectedcardseq', 'contentedit', 'transient',
  'reply', 'mention', 'visibles', 'event', 'type', 'action', 'actions', 'actiontype', 'actiondata', 'submit',
  'submitactions', 'selectaction', 'callback', 'scope', 'interactionscope', 'owner',
  'reasoningid', 'runid', 'sessionid', 'grantoruid', 'grantid', 'interactionid',
  'html', 'srcset', 'image', 'icon', 'avatar', 'backgroundimage',
])
const reservedKey = key => {
  const compact = key.toLowerCase().replace(/[_.-]/g, '')
  return !dataKey.test(key) || reservedKeys.has(compact) || compact.startsWith('obo') || compact.startsWith('callback')
    || /(?:url|uri|href|link|src|endpoint|scopes?)$/.test(compact)
}
const linkText = /:\/\/|\/\/|(?:^|[^A-Za-z0-9])(?:https?|ftp|data|javascript|vbscript|file|mailto|tel|blob|sms|about)\s*:|\bwww\.|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|[<][A-Za-z!/?]|\]\s*(?:\(|:)/iu

const hints = {
  invalid_registry_arguments: 'Use an exact discovered template ref and state with bounded, plain JSON data.',
  invalid_registry_context: 'Bind the current Octo account, route and live authority checks.',
  registry_access_denied: 'Current Octo access does not allow this operation.',
  registry_aborted: 'The operation stopped before an Octo write was dispatched.',
  registry_profile_unavailable: 'The server did not advertise a usable Registry card profile.',
  registry_card_not_advertised: 'This exact template version and state are not advertised for this Bot.',
  registry_card_reserved: 'This template is reserved for the Bot’s own progress workflow.',
  registry_card_read_only: 'This view is discovery-only for generic card tools.',
  registry_source_unavailable: 'The current message is not an editable Registry card from this Bot.',
  registry_revision_conflict: 'The card revision changed. Read the current card before requesting another edit.',
  registry_delivery_unconfirmed: 'Octo did not confirm the write. Inspect the conversation before trying again.',
  api_invalid_request: 'Octo rejected the template data or card request.',
  api_authentication_failed: 'Octo could not authenticate this Bot.',
  api_permission_denied: 'Octo refused access to this operation.',
  api_not_found: 'Octo could not find the requested resource.',
  api_method_not_allowed: 'This Octo deployment does not accept the operation.',
  api_conflict: 'Octo rejected the write because the resource changed or is not ready.',
  api_rate_limited: 'Octo rate limited the operation. No retry was attempted.',
  api_disabled: 'Octo disabled this feature.',
  api_unsupported: 'Octo does not support the operation for this Bot.',
  api_server_error: 'Octo could not complete the read.',
  api_unavailable: 'Octo could not provide this read.',
}
export class RegistryCardError extends Error {
  constructor(code) {
    super(Object.hasOwn(hints, code) ? hints[code] : 'Registry card operation failed.')
    this.name = 'RegistryCardError'
    this.code = code
  }
}
const fail = code => { throw new RegistryCardError(code) }

function fields(value, required, optional = [], code = 'invalid_registry_arguments') {
  if (!plainObject(value)) fail(code)
  const keys = Reflect.ownKeys(value)
  if (keys.length > required.length + optional.length) fail(code)
  const copy = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!required.includes(key) && !optional.includes(key) || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail(code)
    copy[key] = descriptor.value
  }
  if (!required.every(key => Object.hasOwn(copy, key))) fail(code)
  return copy
}

function ref(value, code) {
  const { id, version } = fields(value, ['id', 'version'], [], code)
  if (!validTemplateId(id) || !validVersion(version)) fail(code ?? 'invalid_registry_arguments')
  return { id, version }
}

function normalizeData(input, state) {
  const invalid = () => fail('invalid_registry_arguments')
  let nodes = 0, bytes = 0
  function spend(value) {
    // Count actual serialized string bytes (including escapes). Check code
    // units first so even a huge string is rejected before scanning it.
    if (typeof value === 'string' && (value.length > MAX_STRING_BYTES
      || Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES)) invalid()
    bytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > MAX_REQUEST_BYTES) invalid()
  }
  function copy(value, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid()
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && (!Number.isFinite(value)
        || Number.isInteger(value) && !Number.isSafeInteger(value))) invalid()
      spend(value)
      return value
    }
    if (typeof value === 'string') {
      spend(value)
      if (!value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
        || linkText.test(value)) invalid()
      return value
    }
    if (types.isProxy(value)) invalid()
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_NODES - nodes
        || Reflect.ownKeys(value).length !== value.length + 1) invalid()
      const out = []
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        out.push(copy(descriptor.value, depth + 1))
      }
      return out
    }
    if (!plainObject(value)) invalid()
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_NODES - nodes) invalid()
    const out = Object.create(null)
    for (const key of keys) {
      if (typeof key !== 'string' || reservedKey(key)) invalid()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
      spend(key)
      out[key] = copy(descriptor.value, depth + 1)
    }
    return out
  }
  if (!plainObject(input)) invalid()
  const data = copy(input, 0)
  // Both official clients require the mirrored state, even though the
  // generic server wrapper delegates its presence to the template schema.
  if (!Object.hasOwn(data, 'state') || data.state !== state) invalid()
  return data
}

export function registryCardParameters({ edit = false } = {}) {
  const template_ref = { type: 'object', additionalProperties: false, required: ['id', 'version'],
    properties: { id: { type: 'string', maxLength: 128 }, version: { type: 'string', maxLength: 64 } } }
  const properties = {
    template_ref,
    state: { type: 'string', maxLength: 128 },
    data: { type: 'object', additionalProperties: true, required: ['state'],
      properties: { state: { type: 'string', maxLength: 128 } } },
    ...(edit && { message_id: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
      expected_card_seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
  }
  return { type: 'object', additionalProperties: false, properties,
    required: ['template_ref', 'state', 'data', ...(edit ? ['message_id'] : [])] }
}

function normalizeArgs(args, edit) {
  const input = fields(args, registryCardParameters({ edit }).required, edit ? ['expected_card_seq'] : [])
  const template_ref = ref(input.template_ref)
  if (template_ref.id === REASONING) fail('registry_card_reserved')
  if (!token(input.state)) fail('invalid_registry_arguments')
  const frame = { template_ref, state: input.state, data: normalizeData(input.data, input.state) }
  if (!edit) return { frame }
  if (typeof input.message_id !== 'string' || !decimalId(input.message_id)
    || Object.hasOwn(input, 'expected_card_seq') && !safeSeq(input.expected_card_seq)) fail('invalid_registry_arguments')
  return { frame, messageId: input.message_id, expectedSeq: input.expected_card_seq }
}

function currentRoute(route) {
  const code = 'invalid_registry_context'
  const { channel_id, channel_type } = fields(route, ['channel_id', 'channel_type'], [], code)
  if (!(channel_type === 1 ? validUid(channel_id) && !channel_id.includes('@')
    && !['.', '..'].includes(channel_id) : ruleScope(channel_type, channel_id))) fail(code)
  return { channel_id, channel_type }
}

function begin(call, authorize, signal) {
  if (typeof call !== 'function' || typeof authorize !== 'function'
    || signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid_registry_context')
  const timeout = AbortSignal.timeout(15_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function check(authorize, signal) {
  if (signal.aborted) fail('registry_aborted')
  let allowed
  try { allowed = await authorize(signal) } catch { /* Discard untrusted detail. */ }
  if (signal.aborted) fail('registry_aborted')
  if (allowed !== true) fail('registry_access_denied')
}

const readErrors = new Set([
  'api_invalid_request', 'api_authentication_failed', 'api_permission_denied', 'api_not_found',
  'api_method_not_allowed', 'api_rate_limited', 'api_disabled', 'api_unsupported',
  'api_unavailable', 'api_server_error',
])
const refused = new Set([...readErrors, 'api_conflict'])
refused.delete('api_unavailable')
refused.delete('api_server_error')
const errorCode = error => error instanceof OctoError ? apiErrorCode(error) : error?.code

const unavailable = () => ({ available: false, templates: [] })
const tokenList = (value, limit) => Array.isArray(value) && value.length <= limit
  && value.every(token) && new Set(value).size === value.length

function profileCatalog(raw) {
  if (!success(raw) || raw.available !== undefined && raw.available !== true
    || ![true, 1].includes(raw.enabled) || raw.card_version !== CARD_VERSION) return unavailable()
  const { config, templating, profiles } = raw
  if (!isObject(config) || config.card_enabled !== true || typeof config.display_enabled !== 'boolean'
    || typeof config.interaction_enabled !== 'boolean' || config.interaction_enabled && !config.display_enabled
    || typeof config.reasoning_enabled !== 'boolean'
    || !Array.isArray(profiles) || profiles.length > 16 || new Set(profiles).size !== profiles.length
    || profiles.some(value => typeof value !== 'string' || !/^[a-z0-9_.-]{1,32}\/[a-z0-9_.-]{1,32}$/i.test(value))
    || !isObject(templating) || templating.supported !== true || templating.wire !== WIRE
    || !Array.isArray(templating.templates) || templating.templates.length > 64) return unavailable()
  let reasoningRef
  try {
    if (config.reasoning_enabled) reasoningRef = ref(config.reasoning_template_ref)
    else if (config.reasoning_template_ref !== null) return unavailable()
  } catch { return unavailable() }
  const limit = raw.limits?.max_payload_bytes
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) return unavailable()
  const seenRefs = new Set(), idCounts = new Map(), templates = []
  for (const template of templating.templates) {
    if (!isObject(template) || !validTemplateId(template.id) || !validVersion(template.version)
      || template.available !== undefined && typeof template.available !== 'boolean'
      || !Array.isArray(template.views) || !template.views.length || template.views.length > 16) return unavailable()
    const { id, version } = template
    const key = id + '@' + version
    if (seenRefs.has(key)) return unavailable()
    seenRefs.add(key)
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
    const reserved = id === REASONING || id === reasoningRef?.id
    const available = template.available !== false
    const seenNames = new Set(), seenStates = new Set(), views = []
    for (const view of template.views) {
      if (!isObject(view) || !token(view.name) || seenNames.has(view.name)
        || typeof view.wire_profile !== 'string' || view.wire_profile.length > 64
        || !tokenList(view.states, 32) || !view.states.length || view.states.some(state => seenStates.has(state))
        || !tokenList(view.submit_actions, 32)) return unavailable()
      seenNames.add(view.name)
      view.states.forEach(state => seenStates.add(state))
      const writable = available && !reserved && config.display_enabled && profiles.includes(DISPLAY)
        && view.wire_profile === DISPLAY && view.submit_actions.length === 0
      // Unknown wire profiles can never grant writes. Omit them from tool
      // discovery rather than reflect arbitrary upstream text.
      if ([DISPLAY, INTERACTIVE].includes(view.wire_profile)) views.push({
        name: view.name, states: [...view.states], wire_profile: view.wire_profile,
        submit_actions: [...view.submit_actions], writable,
      })
    }
    templates.push({ id, version, available, reserved, views })
  }
  // The reviewed server's AdvertisedRef refuses to choose between two
  // versions of the same ID. List them for discovery, but do not write either.
  for (const template of templates) {
    if (idCounts.get(template.id) > 1) for (const view of template.views) view.writable = false
  }
  if (reasoningRef && !templates.some(template => sameRef(template, reasoningRef))) return unavailable()
  const catalog = { available: true, wire: WIRE, templates,
    max_request_bytes: Math.min(limit ?? MAX_REQUEST_BYTES, MAX_REQUEST_BYTES) }
  return Buffer.byteLength(JSON.stringify(catalog), 'utf8') <= MAX_REQUEST_BYTES ? catalog : unavailable()
}

async function readProfile(call, signal) {
  let raw
  try { raw = await call(PROFILE, undefined, signal) } catch (error) {
    if (signal.aborted) fail('registry_aborted')
    const code = errorCode(error)
    if (code === 'api_not_found') return unavailable()
    fail(readErrors.has(code) ? code : 'registry_profile_unavailable')
  }
  if (signal.aborted) fail('registry_aborted')
  return profileCatalog(raw)
}

function requireWritable(catalog, frame) {
  if (!catalog.available) fail('registry_profile_unavailable')
  const template = catalog.templates.find(item => sameRef(item, frame.template_ref))
  if (template?.reserved) fail('registry_card_reserved')
  const view = template?.views.find(item => item.states.includes(frame.state))
  if (!template?.available || !view) fail('registry_card_not_advertised')
  if (!view.writable) fail('registry_card_read_only')
  return view
}

function checkBody(body, catalog) {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > catalog.max_request_bytes) fail('invalid_registry_arguments')
}

// call is the current Bot's authenticated JSON transport, with fixed paths
// and redirects/retries disabled. authorize must check live tool + route
// access; writes additionally require write permission and group edits admin.
export async function discoverRegistryCards({ call, authorize, signal } = {}) {
  const active = begin(call, authorize, signal)
  await check(authorize, active)
  const catalog = await readProfile(call, active)
  await check(authorize, active)
  return catalog
}

async function write(call, path, body, signal) {
  if (signal.aborted) fail('registry_aborted')
  try { return await call(path, body, signal) } catch (error) {
    const code = errorCode(error)
    if (refused.has(code)) fail(code)
    // Dispatch may have succeeded even after an abort, 5xx, invalid JSON or
    // transport failure. Never retry, fall back to raw, or claim rejection.
    fail('registry_delivery_unconfirmed')
  }
}

export async function sendRegistryCard({ call, authorize, route, args, signal } = {}) {
  const active = begin(call, authorize, signal)
  const target = currentRoute(route)
  const { frame } = normalizeArgs(args, false)
  await check(authorize, active)
  const catalog = await readProfile(call, active)
  requireWritable(catalog, frame)
  const body = { ...target, payload: { type: 17, ...frame } }
  checkBody(body, catalog)
  await check(authorize, active)
  const raw = await write(call, SEND, body, active)
  const message_id = success(raw) && decimalId(raw.message_id)
  if (!message_id) fail('registry_delivery_unconfirmed')
  return { ok: true, message_id, card_seq: 0, requiresFinalSummary: true,
    ...(active.aborted || raw.authority_changed === true ? { authority_changed: true } : {}) }
}

function readFrame(value, original = false) {
  // The trusted host transport has already capped and decoded the response.
  // Cap each frame further and take a detached snapshot for the later compare.
  try {
    let text = typeof value === 'string' ? value : JSON.stringify(value)
    if (typeof text !== 'string' || text.length > MAX_FRAME_BYTES
      || Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) fail('registry_source_unavailable')
    if (original && typeof value === 'string' && !text.trimStart().startsWith('{')) {
      if (text.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail('registry_source_unavailable')
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'base64'))
    }
    const frame = JSON.parse(text)
    if (isObject(frame)) return frame
  } catch { /* No server content or decoder details in errors. */ }
  fail('registry_source_unavailable')
}

function sourceFrame(value, wanted, botUid) {
  const code = 'registry_source_unavailable'
  const marker = ref(value.template_ref, code)
  const metadata = value.card?.metadata?.octo
  if (value.type !== 17 || value.card_version !== CARD_VERSION || value.profile !== DISPLAY
    || value.card?.type !== 'AdaptiveCard' || !sameRef(marker, wanted)
    || !sameRef(ref(metadata?.template, code), marker) || value.event != null
    || value.transient !== undefined && value.transient !== false
    || value.space_id != null && (!validUid(value.space_id) || value.space_id.trim() !== value.space_id)) fail(code)
  if (Object.hasOwn(value, 'catalog_provenance')) {
    const prov = fields(value.catalog_provenance, ['version', 'principal_type', 'principal_id', 'space_id'], [], code)
    if (prov.version !== 1 || prov.principal_type !== 'bot' || prov.principal_id !== botUid
      || typeof prov.space_id !== 'string' || prov.space_id !== '' && prov.space_id !== value.space_id) fail(code)
  }
  return value
}

function sourceSnapshot(raw, route, botUid, messageId, templateRef) {
  const code = 'registry_source_unavailable'
  const { channel_id: channel, channel_type: type } = route
  const ids = type === 1 ? [channel, channel + '@' + botUid, botUid + '@' + channel] : [channel]
  if (!isObject(raw) || decimalId(raw.message_id) !== messageId || !channelSequence(raw.message_seq)
    || raw.channel_type !== type || !ids.includes(raw.channel_id) || raw.from_uid !== botUid) fail(code)
  const edits = []
  for (const part of [raw, raw.extra, raw.message_extra]) {
    if (part == null) continue
    if (!isObject(part) || ['revoke', 'revoked', 'is_deleted', 'is_mutual_deleted']
      .some(key => part[key] != null && part[key] !== false && part[key] !== 0)) fail(code)
    if (part !== raw && part.content_edit != null && part.content_edit !== '') edits.push(readFrame(part.content_edit))
  }
  const original = sourceFrame(readFrame(raw.payload, true), templateRef, botUid)
  if (Object.hasOwn(original, 'card_seq')) fail(code)
  if (edits.length > 1 && !isDeepStrictEqual(edits[0], edits[1])) fail(code)
  const effective = edits.length ? sourceFrame(edits[0], templateRef, botUid) : original
  if (effective.space_id !== original.space_id || edits.length && (!safeSeq(effective.card_seq) || effective.card_seq < 1
    || effective.visibles != null)) fail(code)
  return { messageSeq: raw.message_seq, cardSeq: edits.length ? effective.card_seq : 0, original, effective }
}

// readSource(messageId, signal) returns the original raw row from the scoped
// Bot message GET after the host checks its current Space and visibility.
// We verify the raw and effective identities independently and never pass
// any field from either envelope back to Octo as editable content.
export async function editRegistryCard({ call, authorize, readSource, route, botUid, args, signal } = {}) {
  const active = begin(call, authorize, signal)
  const target = currentRoute(route)
  if (typeof readSource !== 'function' || !validUid(botUid) || botUid === target.channel_id) fail('invalid_registry_context')
  const { frame, messageId, expectedSeq } = normalizeArgs(args, true)
  const snapshot = async () => {
    let raw
    try { raw = await readSource(messageId, active) } catch (error) {
      if (active.aborted) fail('registry_aborted')
      const code = errorCode(error)
      fail(readErrors.has(code) ? code : 'registry_source_unavailable')
    }
    if (active.aborted) fail('registry_aborted')
    return sourceSnapshot(raw, target, botUid, messageId, frame.template_ref)
  }

  await check(authorize, active)
  requireWritable(await readProfile(call, active), frame)
  const before = await snapshot()
  if (expectedSeq !== undefined && before.cardSeq !== expectedSeq || before.cardSeq >= Number.MAX_SAFE_INTEGER)
    fail('registry_revision_conflict')
  // Registry edit accepts some historical refs and does not rerun the
  // per-Bot send policy. Recheck live advertisement and role at write time.
  await check(authorize, active)
  const latest = await snapshot()
  if (!isDeepStrictEqual(before, latest)) fail('registry_revision_conflict')
  const catalog = await readProfile(call, active)
  requireWritable(catalog, frame)
  const card_seq = before.cardSeq + 1
  const body = { ...target, message_id: messageId, ...frame, card_seq }
  checkBody(body, catalog)
  await check(authorize, active)
  const raw = await write(call, EDIT, body, active)
  if (!success(raw) || raw.status !== 200) fail('registry_delivery_unconfirmed')
  return { ok: true, message_id: messageId, card_seq, requiresFinalSummary: true,
    ...(active.aborted || raw.authority_changed === true ? { authority_changed: true } : {}) }
}
