import { randomUUID } from 'node:crypto'
import { validToken, validUid } from './config.js'
import { channelSequence, decimalId, permitsRoute } from './octo.js'
import { officialApiErrorCode } from './api-errors.js'
import { ruleScope } from './rules.js'

// A host opt-in for a verified deployment, never a probe or a model argument.
export const OBO_SEND_CONTRACT = 'octo-server:f984d40549f66d56b1e90a048d28315eb12c92df'
export const OBO_SEND_TOOL = Object.freeze({
  name: 'octo_messages_send_on_behalf_of',
  description: 'Propose a plain-text send as the verified human in this private chat to one exact Octo group or thread. Requires a new human approval for the full text and destination. Never retry an uncertain send.',
  mutating: true,
  privateOnly: true,
  parameters: Object.freeze({
    type: 'object', additionalProperties: false,
    required: ['channel_type', 'channel_id', 'text'],
    properties: {
      channel_type: { type: 'integer', enum: [2, 5] },
      channel_id: { type: 'string', minLength: 32, maxLength: 56 },
      text: { type: 'string', minLength: 1, maxLength: 600 },
    },
  }),
})

const sendPath = '/v1/bot/sendMessage'
const grantPath = '/v1/bot/obo-grant'
const prefix = 'err.server.bot_api.'
const approvalMs = 120_000
const readbackDelays = [0, 250, 750]
const definitiveRejection = new Map([
  ['err.shared.rate.limited', 'rate_limited'],
  ...Object.entries({
    obo_not_authorized: 'grant_or_scope_denied', obo_internal: 'grant_check_failed',
    auth_failed: 'bot_authentication_failed', bot_unavailable: 'bot_unavailable',
    group_not_found: 'destination_not_allowed', group_disbanded: 'destination_not_allowed',
    not_group_member: 'destination_not_allowed', thread_channel_not_accepted: 'destination_not_allowed',
    request_invalid: 'send_request_rejected',
  }).map(([code, reason]) => [prefix + code, reason]),
])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const humanUid = value => validUid(value) && !/[:@]/u.test(value) && !value.includes('____')
  && !['.', '..', 'all', 'all_bots', '-1', '-2', '-3'].includes(value.toLowerCase())
const hidden = /[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/u
const ok = (value, status = 200) => object(value) && value.error == null && value.ok !== false
  && (value.status === undefined || value.status === status)
const availableMessage = value => ok(value) && [value, value.message_extra, value.extra].every(row => row == null
  || (object(row) && ['revoke', 'revoked', 'is_deleted', 'is_mutual_deleted']
    .every(key => row[key] == null || row[key] === 0 || row[key] === false)))

class Block extends Error {}
function block(code) { throw new Block(code) }
const result = (status, reason, receipt) => ({ ok: status === 'confirmed', status,
  ...(reason && { reason }), ...receipt, retry_safe: false })
const notSent = reason => result('not_sent', reason)

function parseAction(args) {
  if (!object(args) || Object.keys(args).length !== 3
    || !['channel_type', 'channel_id', 'text'].every(key => own(args, key))) block('invalid_arguments')
  const { channel_type, channel_id, text } = args
  const scope = ruleScope(channel_type, channel_id)
  if (!scope || !/^[a-fA-F0-9]{32}$/u.test(scope.group)) block('unsupported_destination')
  if (typeof text !== 'string' || !text || text.trim() !== text || !text.isWellFormed()
    || hidden.test(text) || Array.from(text).length > 600 || Buffer.byteLength(text) > 1800) block('invalid_text')
  const groupPath = '/v1/bot/groups/' + scope.group
  return { route: Object.freeze({ channel_type, channel_id }), text, ...scope, groupPath,
    targetPath: scope.thread ? groupPath + '/threads/' + scope.thread : groupPath }
}

function member(rows, uid, predicate = () => true) {
  if (!Array.isArray(rows) || rows.length > 1000) return false
  const matches = rows.filter(row => row?.uid === uid)
  return matches.length === 1 && predicate(matches[0])
}

// The callback gets a trusted challenge, never a model-supplied decision. Bound
// the wait even if the host fails to settle, and detach on every exit.
async function waitFor(promise, signal) {
  signal.throwIfAborted()
  let abort
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

/**
 * One instance per admitted, exclusive DSH turn. Host-only inputs:
 * - config + request: same verified User Bot account/Space and authenticated
 *   OctoClient transport (no redirects/retries; preserves int64 IDs).
 * - origin: the admitted human DM's canonical job, never tool arguments.
 * - isActive: synchronous account, run and write-policy gate; revoke signal
 *   must also cover stop, configuration change, steering and run disposal.
 * - authorize(signal): fresh host admission/write check for that exact origin.
 * - confirm(review, signal): display exact text as literal data plus identity
 *   and route. Only return {id, operatorUid, decision:'allow'|'deny'|'cancel'}
 *   from an authenticated, human-operated response bound to this review.
 *   Unverified text replies, model output and unrelated approvals are invalid.
 * - verifiedContract: set by trusted host integration after verification of
 *   the deployed send/marker/readback contract, including all serving nodes.
 */
export function createOboSend({ config, origin, request, isActive, authorize, confirm, verifiedContract, signal } = {}) {
  const botUid = config?.botUid, spaceId = config?.spaceId
  const token = config?.token, apiBase = config?.apiBase
  const userBot = () => [undefined, 'user'].includes(config?.botKind) && validToken(token) && token.startsWith('bf_')
  const sender = origin?.sender, originId = decimalId(origin?.message_id), originSeq = channelSequence(origin?.message_seq)
  const direct = origin?.channel_type === 1 && origin?.channel_id === sender
  let busy = false, unresolved = false

  return async function sendOnBehalfOf(args, toolSignal) {
    if (verifiedContract !== OBO_SEND_CONTRACT) return notSent('server_contract_unverified')
    if (!userBot() || !validUid(botUid) || botUid.includes('@') || !validUid(spaceId)) {
      return notSent('verified_user_bot_required')
    }
    if (!direct || !humanUid(sender) || sender === botUid || !originId || !originSeq) return notSent('verified_human_dm_required')
    if (!signal || ![request, isActive, authorize, confirm].every(fn => typeof fn === 'function')) {
      return notSent('trusted_confirmation_unavailable')
    }
    if (unresolved) return notSent('previous_send_unresolved')
    if (busy) return notSent('approval_pending')
    const activeSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
    busy = true
    let dispatchStarted = false, receipt
    const active = () => !activeSignal.aborted && isActive() === true
    function check(action) {
      if (!active() || config.botUid !== botUid || config.spaceId !== spaceId || config.token !== token
        || config.apiBase !== apiBase || !userBot() || ['read-only', 'text-only'].includes(config.toolPermission)
        || !permitsRoute(config, sender, 1, sender)) block('access_changed')
      // A joined policy alone would authorize every visible group for this
      // higher-impact operation. Require an exact local route allowlist.
      const allowlist = action.route.channel_type === 2 ? config.groups : config.threads
      if (config.channelPolicy !== 'allowlist' || !allowlist?.has(action.route.channel_id)) block('destination_not_allowed')
    }
    async function read(action, path, body, reason) {
      check(action)
      let response
      try {
        response = await request(path, body === undefined ? undefined : JSON.stringify(body), activeSignal,
          { method: body === undefined ? 'GET' : 'POST', timeout: 5000 })
      } catch { block(reason) }
      check(action)
      return response
    }
    async function preflight(action) {
      check(action)
      if (await authorize(activeSignal) !== true) block('access_changed')
      const identity = await read(action, '/v1/bot/users/batch', { uids: [sender] }, 'human_identity_unverified')
      if (!ok(identity) || identity.missing_uids?.length !== 0 || identity.users?.length !== 1
        || !member(identity.users, sender, row => row.robot === 0 && row.status === 1)) block('human_identity_unverified')
      const source = await read(action, '/v1/bot/messages/person/' + encodeURIComponent(sender) + '/' + originId,
        undefined, 'human_origin_unverified')
      const payload = source?.payload
      if (!availableMessage(source) || decimalId(source.message_id) !== originId || source.message_seq !== originSeq
        || source.from_uid !== sender || source.channel_type !== 1
        || ![sender + '@' + botUid, botUid + '@' + sender].includes(source.channel_id)
        || !object(payload) || payload.space_id !== spaceId
        || Object.keys(payload).some(key => key === 'actual_sender_uid' || key.startsWith('__obo_') || key.startsWith('obo_'))) {
        block('human_origin_unverified')
      }
      const groups = await read(action, '/v1/bot/groups?' + new URLSearchParams({ space_id: spaceId }), undefined,
        'destination_unverified')
      const matches = Array.isArray(groups) && groups.length <= 1000 ? groups.filter(row => row?.group_no === action.group) : []
      if (matches.length !== 1 || matches[0].space_id !== spaceId) block('destination_unverified')
      const group = await read(action, action.groupPath, undefined, 'destination_unverified')
      if (!ok(group, 1) || group.group_no !== action.group || group.status !== 1) block('destination_unverified')
      const roster = await read(action, action.groupPath + '/members', undefined, 'destination_unverified')
      if (!member(roster, sender, row => row.robot === 0) || !member(roster, botUid, row => row.robot === 1)) {
        block('destination_membership_unverified')
      }
      if (action.thread) {
        const thread = await read(action, action.targetPath, undefined, 'destination_unverified')
        if (!ok(thread, 1) || thread.group_no !== action.group || thread.short_id !== action.thread || thread.status !== 1
          || thread.channel_type !== 5 || thread.channel_id !== action.route.channel_id) block('destination_unverified')
        const subscribers = await read(action, action.targetPath + '/members', undefined, 'destination_unverified')
        if (!member(subscribers, sender) || !member(subscribers, botUid)) block('destination_membership_unverified')
      }
    }
    async function freshGrant(action) {
      check(action)
      let grant
      try { grant = await request(grantPath, undefined, activeSignal, { method: 'GET', timeout: 5000 }) }
      catch (error) {
        block(error?.status === 404 && officialApiErrorCode(error) === prefix + 'obo_grant_not_found'
          ? 'no_usable_grant' : 'grant_endpoint_unverified')
      }
      check(action)
      // The endpoint lists only the first usable legacy grant for this bot.
      // A mismatch is lack of proof, never permission to switch grantors.
      if (!ok(grant) || grant.grantor_uid !== sender || grant.active !== true || grant.global_enabled !== true) {
        block('matching_enabled_grant_unverified')
      }
    }

    try {
      const action = parseAction(args)
      await preflight(action)
      await freshGrant(action)
      const review = Object.freeze({ id: randomUUID(), operatorUid: sender, botUid, spaceId,
        originMessageId: originId, destination: action.route, text: action.text })
      const consentSignal = AbortSignal.any([activeSignal, AbortSignal.timeout(approvalMs)])
      let decision
      try {
        consentSignal.throwIfAborted()
        decision = await waitFor(Promise.resolve().then(() => {
          consentSignal.throwIfAborted()
          return confirm(review, consentSignal)
        }), consentSignal)
      } catch { block('approval_unavailable') }
      if (consentSignal.aborted || !object(decision) || decision.id !== review.id || decision.operatorUid !== sender) {
        block('approval_unverified')
      }
      if (decision.decision !== 'allow') block(decision.decision === 'deny' ? 'approval_denied' : 'approval_not_given')
      await preflight(action)
      await freshGrant(action)
      check(action)
      if (consentSignal.aborted) block('approval_expired')
      const body = JSON.stringify({ ...action.route, on_behalf_of: sender, payload: { type: 1, content: action.text } })
      let raw
      // The only dispatch. The pinned Go DTO does not accept client_msg_no;
      // a timeout, lost response or abort after starting is not retryable.
      dispatchStarted = true
      try { raw = await request(sendPath, body, activeSignal, { method: 'POST', timeout: 15_000 }) }
      catch (error) {
        const reason = definitiveRejection.get(officialApiErrorCode(error))
        if (reason) return result('rejected', reason)
        unresolved = true
        return result('uncertain', 'send_outcome_unverified')
      }
      const id = ok(raw) && decimalId(raw.message_id), seq = ok(raw) && channelSequence(raw.message_seq)
      if (!id || !seq) {
        unresolved = true
        return result('uncertain', 'send_receipt_unverified', id ? { message_id: id } : undefined)
      }
      receipt = { message_id: id, message_seq: seq }
      for (const ms of readbackDelays) {
        try {
          check(action)
          if (ms) await waitFor(new Promise(resolve => setTimeout(resolve, ms)), activeSignal)
          const row = await read(action, action.targetPath + '/messages/' + id, undefined, 'sender_readback_unavailable')
          if (!availableMessage(row) || decimalId(row.message_id) !== id || row.message_seq !== seq
            || row.channel_type !== action.route.channel_type || row.channel_id !== action.route.channel_id
            || (raw.client_msg_no && row.client_msg_no !== raw.client_msg_no)
            || row.payload?.type !== 1 || row.payload.content !== action.text) continue
          if (row.from_uid === sender && row.payload.__obo_processed__ === true && row.payload.actual_sender_uid === botUid) {
            return result('confirmed', undefined, { ...receipt, from_uid: sender, actual_sender_uid: botUid })
          }
          if (row.from_uid === botUid) {
            unresolved = true
            return result('sender_mismatch', 'sent_as_bot', { ...receipt, from_uid: botUid })
          }
        } catch {
          if (activeSignal.aborted) break
        }
      }
      unresolved = true
      return result('acknowledged', 'sender_unverified', receipt)
    } catch (error) {
      if (dispatchStarted) {
        unresolved = true
        return receipt ? result('acknowledged', 'sender_unverified', receipt) : result('uncertain', 'send_outcome_unverified')
      }
      return notSent(error instanceof Block ? error.message : 'authorization_unavailable')
    } finally { busy = false }
  }
}
