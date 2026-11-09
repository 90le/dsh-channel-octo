import { randomUUID } from 'node:crypto'
import { apiEndpoint, validToken, validUid } from './config.js'
import { decimalId, OctoClient, OctoError, readJson } from './octo.js'
import { ruleScope } from './rules.js'

const version = '1.5'
const display = 'octo/v1'
const interaction = 'octo/v2'
const bindingTtl = 15 * 60_000
const payloadLimit = 12 * 1024
const nonceKey = 'dsh_card_nonce'
const bytes = value => Buffer.byteLength(value, 'utf8')
const record = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const shape = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key))
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value)
  && !Object.hasOwn(Object.prototype, value) && value !== 'prototype'
const nonce = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const address = (type, value) => type === 1
  ? validUid(value) && !value.includes('@')
  : !!ruleScope(type, value)
const invalid = () => { throw new OctoError('invalid_card_form') }

function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit || bytes(value) > limit
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || !value.trim()) invalid()
  return value.trim()
}

// Octo TextBlock and Input.label use Markdown. Do not let text supply link syntax or HTML.
const literal = value => value.replace(/[\\[\]<>]/g, '\\$&')

/**
 * A small authoring surface: {title, text?, actions?: [{id, label}],
 * choice?: {id, label, options: [{title, value}]}}. Buttons confirm or submit one choice.
 * No raw Adaptive Card tree, server markers, URLs as actions, or arbitrary submit data.
 */
export function createCard(form) {
  if (!shape(form, ['title', 'text', 'actions', 'choice'])) invalid()
  const title = text(form.title, 160)
  const description = form.text === undefined ? undefined : text(form.text, 2048)
  const actions = form.actions === undefined ? [] : form.actions
  if (!Array.isArray(actions) || actions.length > 4) invalid()
  const used = new Set()
  function takeId(value) {
    if (!id(value) || used.has(value)) invalid()
    used.add(value)
    return value
  }
  const buttons = Array.from(actions, action => {
    if (!shape(action, ['id', 'label'])) invalid()
    return { type: 'Action.Submit', id: takeId(action.id), title: text(action.label, 100) }
  })
  const body = [{ type: 'TextBlock', text: literal(title), weight: 'Bolder', wrap: true }]
  if (description) body.push({ type: 'TextBlock', text: literal(description), wrap: true })
  if (form.choice !== undefined) {
    const choice = form.choice
    if (!buttons.length || !shape(choice, ['id', 'label', 'options']) || !Array.isArray(choice.options)
      || choice.options.length < 2 || choice.options.length > 12) invalid()
    const values = new Set()
    const choices = Array.from(choice.options, option => {
      if (!shape(option, ['title', 'value']) || !id(option.value) || values.has(option.value)) invalid()
      values.add(option.value)
      return { title: text(option.title, 100), value: option.value }
    })
    body.push({
      type: 'Input.ChoiceSet', id: takeId(choice.id), label: literal(text(choice.label, 100)),
      style: 'expanded', isMultiSelect: false, isRequired: true, choices,
    })
  }
  const payload = {
    type: 17, profile: buttons.length ? interaction : display, card_version: version,
    plain: description ? title + '\n' + description : title,
    card: { type: 'AdaptiveCard', version, body, ...(buttons.length && { actions: buttons }) },
  }
  if (bytes(JSON.stringify(payload)) > payloadLimit) invalid()
  return payload
}

/**
 * Decode only Octo's typed bot-poll event. Parsing does not authenticate its source.
 * Unknown additive fields are ignored. Submit data is opaque except for our own marker.
 */
export function parseCardAction(rawEvent) {
  let event = rawEvent
  if (typeof event === 'string') {
    if (bytes(event) > 64 * 1024) return null
    try { event = readJson(event) } catch { return null }
  }
  if (!record(event) || event.event_type !== 'card_action' || event.message != null
    || !record(event.event_data)) return null
  const source = event.event_data
  const eventId = decimalId(event.event_id)
  const messageId = decimalId(source.message_id)
  const { channel_id: channelId, channel_type: channelType, action_id: actionId,
    operator_uid: operatorUid, space_id: spaceId, acted_at: actedAt } = source
  if (!eventId || !messageId || !address(channelType, channelId) || !id(actionId)
    || !validUid(operatorUid) || (channelType === 1 && channelId !== operatorUid)
    || (spaceId !== undefined && !validUid(spaceId))
    || (actedAt !== undefined && (!Number.isSafeInteger(actedAt) || actedAt <= 0))) return null

  const inputs = {}
  // The Go server emits null for a nil inputs map. The normal wire values are
  // strings; accept finite scalars for SDK parity without silently dropping fields.
  if (source.inputs != null) {
    if (!record(source.inputs)) return null
    let count = 0
    for (const key in source.inputs) {
      if (!Object.hasOwn(source.inputs, key)) continue
      const value = source.inputs[key]
      if (++count > 32 || !id(key) || !(typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value)))) return null
      const normalized = String(value)
      if (normalized.length > 4096 || bytes(normalized) > 4096) return null
      inputs[key] = normalized
    }
    if (bytes(JSON.stringify(inputs)) > 16 * 1024) return null
  }
  if (source.data !== undefined && !record(source.data)) return null
  const cardNonce = source.data && Object.hasOwn(source.data, nonceKey) ? source.data[nonceKey] : undefined
  if (cardNonce !== undefined && !nonce(cardNonce)) return null
  return { eventId, messageId, channelId, channelType, actionId, operatorUid, spaceId, actedAt, inputs, cardNonce }
}

// Same identity boundary as the channel store. Tokens are never part of a receipt.
function accountScope(config) {
  if (!validUid(config?.botUid) || !validUid(config?.spaceId) || typeof config?.apiBase !== 'string') return
  try { return JSON.stringify([apiEndpoint(config.apiBase), config.spaceId, config.botUid]) } catch {}
}

function supports(profile, payload, choice) {
  const { card } = payload
  const policy = profile?.config
  const fits = (key, count) => {
    const limit = profile.limits?.[key]
    return limit === undefined || (Number.isSafeInteger(limit) && count <= limit)
  }
  return (profile?.enabled === true || profile?.enabled === 1)
    && profile.available !== false && (profile.limits === undefined || record(profile.limits))
    && profile.card_version === version && Array.isArray(profile.profiles) && profile.profiles.includes(payload.profile)
    && policy?.card_enabled === true && policy.display_enabled === true
    && (payload.profile !== interaction || policy.interaction_enabled === true)
    && (profile.elements === undefined || (Array.isArray(profile.elements) && profile.elements.includes('TextBlock')))
    && (!choice || (Array.isArray(profile.inputs) && profile.inputs.includes('Input.ChoiceSet')))
    && fits('max_nodes', card.body.length + (card.actions?.length ?? 0))
    && fits('max_depth', 1) && fits('max_payload_bytes', bytes(JSON.stringify(payload)))
}

/**
 * Send as the already verified Bot account. The caller chooses an admitted route
 * {channel_id, channel_type, operatorUid?}; groups and topics require an explicit
 * operator for interaction. Returns {messageId, binding}; save only a confirmed
 * binding in trusted local state. A display card returns binding: null.
 */
export async function sendCard(config, route, form, signal = new AbortController().signal) {
  const payload = createCard(form)
  const account = accountScope(config)
  const { token, fetchImpl } = config ?? {}
  if (!account || !validToken(token) || (fetchImpl !== undefined && typeof fetchImpl !== 'function')) {
    throw new OctoError('invalid_card_account')
  }
  const [apiBase, spaceId, botUid] = JSON.parse(account)
  if (!shape(route, ['channel_id', 'channel_type', 'operatorUid'])
    || !address(route.channel_type, route.channel_id)
    || (route.channel_type === 1 && route.channel_id === botUid)) throw new OctoError('invalid_card_route')
  const target = { channel_id: route.channel_id, channel_type: route.channel_type }
  if (token.startsWith('app_') && target.channel_type !== 1) throw new OctoError('card_app_bot_dm_only')
  const choice = payload.card.body.find(element => element.type === 'Input.ChoiceSet')
  const buttons = payload.card.actions
  const operatorUid = route.operatorUid ?? (target.channel_type === 1 ? target.channel_id : undefined)
  let frameNonce
  if (buttons) {
    if (!validUid(operatorUid) || operatorUid === botUid
      || (target.channel_type === 1 && operatorUid !== target.channel_id)) throw new OctoError('invalid_card_operator')
    frameNonce = randomUUID().replaceAll('-', '')
    for (const button of buttons) button.data = { [nonceKey]: frameNonce }
  }
  if (bytes(JSON.stringify(payload)) > payloadLimit) invalid()
  signal.throwIfAborted()
  const api = new OctoClient({ apiBase, token, fetchImpl })
  const profile = await api.cardProfile(signal)
  if (!supports(profile, payload, choice)) throw new OctoError('card_profile_unavailable')
  signal.throwIfAborted()
  // This existing client method is the raw type-17 send path used by progress too.
  const { type: _type, ...frame } = payload
  const messageId = await api.progressCard(target, frame, signal)
  const binding = buttons ? Object.freeze({
    account, spaceId, messageId, route: Object.freeze(target), operatorUid, cardNonce: frameNonce,
    actionIds: Object.freeze(buttons.map(button => button.id)),
    choice: choice ? Object.freeze({ id: choice.id, values: Object.freeze(choice.choices.map(item => item.value)) }) : null,
    expiresAt: Date.now() + bindingTtl,
  }) : null
  return { messageId, binding }
}

/**
 * Match a poll event from verifiedAccount to the trusted send binding. Return a
 * selection for the original conversation. Persist/atomically claim cardKey
 * with the enqueue before ACK to consume at most one selection per card.
 */
export function resolveCardAction(rawEvent, binding, verifiedAccount, now = Date.now()) {
  const action = parseCardAction(rawEvent)
  const account = accountScope(verifiedAccount)
  if (!action || !account || !binding || account !== binding.account
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(binding.expiresAt) || now >= binding.expiresAt
    || !action.cardNonce || action.cardNonce !== binding.cardNonce
    || action.messageId !== binding.messageId || action.spaceId !== verifiedAccount.spaceId
    || action.spaceId !== binding.spaceId
    || action.channelId !== binding.route?.channel_id || action.channelType !== binding.route?.channel_type
    || action.operatorUid !== binding.operatorUid || !Array.isArray(binding.actionIds)) return null
  const actionId = binding.actionIds.find(value => value === action.actionId)
  if (!actionId) return null

  const keys = Object.keys(action.inputs)
  let selection
  if (binding.choice !== null) {
    if (!record(binding.choice) || keys.length !== 1 || keys[0] !== binding.choice.id
      || !Array.isArray(binding.choice.values)) return null
    selection = binding.choice.values.find(value => value === action.inputs[binding.choice.id])
    if (selection === undefined) return null
  } else if (keys.length) return null

  return {
    cardKey: JSON.stringify([account, binding.messageId]), eventId: action.eventId,
    messageId: binding.messageId, operatorUid: binding.operatorUid, actionId,
    route: { channel_id: binding.route.channel_id, channel_type: binding.route.channel_type },
    ...(selection !== undefined && { selection }),
  }
}
