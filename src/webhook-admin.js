import { createHash } from 'node:crypto'
import { validToken, validUid } from './config.js'
import { ruleScope } from './rules.js'
import { apiErrorCode, readApiError } from './api-errors.js'

// Management-only transport. Never registered as a model tool. Contracts pinned
// to octo-server f984d40549f66d56b1e90a048d28315eb12c92df.
const fail = code => { throw new Error(code) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const int64 = value => (typeof value === 'string' || integer(value)) && /^\d{1,19}$/.test(String(value)) && BigInt(value) <= 9223372036854775807n
const webhookId = value => typeof value === 'string' && /^iwh_[a-f0-9]{32}$/.test(value)
const adapters = ['native', 'github', 'gitlab', 'feishu', 'multica', 'octo', 'wecom']
const writeActions = new Set(['create', 'update', 'delete', 'regenerate', 'test'])
export const webhookWrites = action => writeActions.has(action)
export const webhookErrors = {
  invalid_webhook_request: 400, webhook_forbidden: 403, webhook_disabled: 403,
  webhook_not_found: 404, webhook_conflict: 409, webhook_changed: 409,
  webhook_rate_limited: 429, webhook_unavailable: 502, webhook_outcome_unknown: 502,
}
export function validateWebhookInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['revision', 'action', 'route', 'webhookId', 'changes', 'expected', 'confirmed', 'limit', 'page'].includes(key))
    || !['routes', 'threads', 'list', 'deliveries', ...writeActions].includes(input.action)) fail('invalid_webhook_request')
  const allowed = ['revision', 'action']
  if (input.action !== 'routes') allowed.push('route')
  if (['update', 'delete', 'regenerate', 'test', 'deliveries'].includes(input.action)) allowed.push('webhookId')
  if (['create', 'update'].includes(input.action)) allowed.push('changes')
  if (['update', 'delete', 'regenerate', 'test'].includes(input.action)) allowed.push('expected')
  if (['delete', 'regenerate', 'test'].includes(input.action)) allowed.push('confirmed')
  if (input.action === 'deliveries') allowed.push('limit')
  if (input.action === 'threads') allowed.push('page')
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('invalid_webhook_request')
  if (input.action !== 'routes') routeOf(input.route)
  if (allowed.includes('webhookId') && !webhookId(input.webhookId)) fail('invalid_webhook_request')
  if (allowed.includes('expected') && !/^[a-f0-9]{64}$/.test(input.expected ?? '')) fail('invalid_webhook_request')
  if (allowed.includes('confirmed') && input.confirmed !== true) fail('invalid_webhook_request')
  if (allowed.includes('changes')) changesOf(input.changes, input.action)
  if (input.limit !== undefined && (!integer(input.limit) || input.limit < 1 || input.limit > 100)) fail('invalid_webhook_request')
  if (input.page !== undefined && (!integer(input.page) || input.page < 1 || input.page > 1_000_000)) fail('invalid_webhook_request')
}

function routeOf(route) {
  if (!object(route) || Object.keys(route).some(key => !['type', 'address'].includes(key))) fail('invalid_webhook_request')
  const scope = ruleScope(route.type, route.address)
  if (!scope) fail('invalid_webhook_request')
  return scope
}

function changesOf(changes, action) {
  const keys = ['name', 'avatar', 'allow_mention_all', 'allow_mention_bots', 'mention_uids', ...(action === 'update' ? ['status'] : [])]
  if (!object(changes) || Object.keys(changes).some(key => !keys.includes(key))) fail('invalid_webhook_request')
  const result = { ...changes }
  if ('name' in result) {
    if (typeof result.name !== 'string') fail('invalid_webhook_request')
    // Go strings.TrimSpace uses Unicode White_Space (not JS trim's BOM rule).
    result.name = result.name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
    if (!text(result.name, 64) || Buffer.byteLength(result.name) > 64 || (action === 'update' && !result.name)) fail('invalid_webhook_request')
  }
  if ('avatar' in result && !text(result.avatar)) fail('invalid_webhook_request')
  for (const key of ['allow_mention_all', 'allow_mention_bots']) if (key in result && typeof result[key] !== 'boolean') fail('invalid_webhook_request')
  if ('status' in result && ![0, 1].includes(result.status)) fail('invalid_webhook_request')
  if ('mention_uids' in result && (!Array.isArray(result.mention_uids) || result.mention_uids.some(uid => !validUid(uid))
    || new Set(result.mention_uids).size !== result.mention_uids.length || Buffer.byteLength(JSON.stringify(result.mention_uids)) > 4096)) fail('invalid_webhook_request')
  return result
}

function endpointOf(base) {
  const url = new URL(base)
  // This is the deployment-pinned API base, never a browser/model argument.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error()
  return url.href.replace(/\/+$/, '')
}

function transport({ apiBase, token, fetchImpl = fetch, signal }) {
  return async (path, method = 'GET', body) => {
    let reader
    const writing = method !== 'GET'
    try {
      if (!validToken(token)) throw Error()
      const base = endpointOf(apiBase)
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)])
      requestSignal.throwIfAborted()
      const response = await fetchImpl(base + path, {
        method, redirect: 'manual', signal: requestSignal,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const error = await readApiError(response, requestSignal)
        const code = apiErrorCode(error)
        const mapped = { api_authentication_failed: 'webhook_forbidden', api_permission_denied: 'webhook_forbidden',
          api_unsupported: 'webhook_forbidden', api_not_found: 'webhook_not_found', api_disabled: 'webhook_disabled',
          api_conflict: 'webhook_conflict', api_invalid_request: 'invalid_webhook_request', api_rate_limited: 'webhook_rate_limited' }[code]
        if (mapped && response.status >= 400 && response.status < 500) fail(mapped)
        throw Error()
      }
      reader = response.body?.getReader()
      if (!reader) throw Error()
      let size = 0
      const chunks = []
      for (let count = 0; ; count++) {
        if (count > 16384) throw Error()
        let onAbort
        const chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
          onAbort = () => reject(Error())
          requestSignal.addEventListener('abort', onAbort, { once: true })
          if (requestSignal.aborted) onAbort()
        })]).finally(() => requestSignal.removeEventListener('abort', onAbort))
        const { done, value } = chunk
        if (done) break
        size += value.byteLength
        if (size > 1_048_576) throw Error()
        chunks.push(value)
      }
      requestSignal.throwIfAborted()
      // JSON.parse's source context preserves official int64 message IDs.
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), (_key, value, context) =>
        typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value)
      if (data?.error != null || data?.ok === false) throw Error()
      if (response.status !== 200) throw Error()
      return data
    } catch (error) {
      if (Object.hasOwn(webhookErrors, error?.message)) throw error
      fail(writing ? 'webhook_outcome_unknown' : 'webhook_unavailable')
    } finally { try { Promise.resolve(reader?.cancel()).catch(() => {}) } catch {} }
  }
}

// Only these fields can reach nonsecret result paths. Never forward a server
// object, even when the documented endpoint promises not to return secrets.
function metadata(value, scope) {
  if (!object(value) || !webhookId(value.webhook_id) || value.group_no !== scope.group
    || (value.thread_short_id || '') !== (scope.thread || '') || !validUid(value.creator_uid)
    || ![0, 1].includes(value.status) || ![0, 1].includes(value.allow_mention_all) || ![0, 1].includes(value.allow_mention_bots)
    || !text(value.name) || !text(value.avatar) || !Array.isArray(value.mention_uids) || value.mention_uids.some(uid => !validUid(uid))
    || ![value.last_used_at, value.call_count, value.created_at].every(integer)) throw Error()
  const result = Object.fromEntries(['webhook_id', 'group_no', 'name', 'avatar', 'creator_uid', 'status',
    'allow_mention_all', 'allow_mention_bots', 'mention_uids', 'last_used_at', 'call_count', 'created_at'].map(key => [key, value[key]]))
  result.thread_short_id = scope.thread || ''
  // Delivery counters change independently; confirmation concerns configuration.
  const { last_used_at, call_count, ...configuration } = result
  result.version = createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
  return result
}

function secretResult(value, webhook, apiBase) {
  if (!/^[a-f0-9]{64}$/.test(value.token ?? '') || !object(value.urls) || !Array.isArray(value.adapter_examples)) throw Error()
  const prefix = '/v1/incoming-webhooks/' + webhook.webhook_id + '/' + value.token
  if (value.url !== prefix) throw Error()
  const base = endpointOf(apiBase)
  const urls = {}
  for (const [key, path] of Object.entries(value.urls)) {
    if (!adapters.includes(key) || path !== prefix + (key === 'native' ? '' : '/' + key)) throw Error()
    urls[key] = base + path
  }
  if (urls.native !== base + prefix) throw Error()
  const examples = value.adapter_examples.map(item => {
    if (!object(item) || !adapters.includes(item.key) || item.url !== value.urls[item.key]
      || !text(item.title) || !text(item.description) || !text(item.content_type, 128)
      || !Array.isArray(item.steps) || item.steps.length > 32 || item.steps.some(step => !text(step, 16_384))
      || !object(item.auth) || !['url_token', 'url_token_and_header'].includes(item.auth.type)) throw Error()
    const auth = { type: item.auth.type }
    for (const key of ['header', 'value_source']) if (item.auth[key] !== undefined) {
      if (!text(item.auth[key], 128)) throw Error()
      auth[key] = item.auth[key]
    }
    return { key: item.key, title: item.title, description: item.description, url: base + item.url,
      content_type: item.content_type, auth, steps: [...item.steps] }
  })
  return { token: value.token, url: base + prefix, urls, adapter_examples: examples }
}

export async function administerWebhooks(context, input) {
  validateWebhookInput(input)
  const request = transport(context)
  const { record, conversations = [] } = context
  try {
    const principal = await request('/v1/bot/space/principals/' + encodeURIComponent(record.botUid) + '?space_id=' + encodeURIComponent(record.spaceId))
    if (principal?.uid !== record.botUid || principal.principal_type !== 'user_bot') fail('webhook_forbidden')
    const groups = await request('/v1/bot/groups?space_id=' + encodeURIComponent(record.spaceId))
    if (groups !== null && !Array.isArray(groups)) throw Error()
    const joined = (groups || []).filter(group => validUid(group?.group_no) && group.space_id === record.spaceId && text(group.name))
    const groupRoute = group => ({ type: 2, address: group.group_no, name: group.name })
    if (input.action === 'routes') {
      const routes = new Map(joined.map(group => [group.group_no, groupRoute(group)]))
      for (const row of conversations) {
        const scope = ruleScope(row.type, row.address)
        if (scope?.thread && joined.some(group => group.group_no === scope.group)) routes.set(row.address,
          { type: 5, address: row.address, name: row.address })
      }
      return { routes: [...routes.values()] }
    }
    const scope = routeOf(input.route)
    const group = joined.find(group => group.group_no === scope.group)
    if (!group) fail('webhook_forbidden')
    const groupPath = '/v1/bot/groups/' + encodeURIComponent(scope.group)
    const base = groupPath + (scope.thread ? '/threads/' + encodeURIComponent(scope.thread) : '') + '/incoming-webhooks'
    // The authoritative management list rechecks internal active membership and
    // protected-container policy. Group/member display DTOs cannot prove these.
    const current = await request(base)
    if (!Array.isArray(current?.list)) throw Error()
    const list = current.list.map(item => metadata(item, scope))
    if (new Set(list.map(item => item.webhook_id)).size !== list.length) throw Error()
    // Existing scoped webhooks remain cleanable even after a thread is deleted.
    // For an empty selection or creation, verify the actual discovered thread.
    if (scope.thread && (input.action === 'create' || input.action === 'list' && !list.length)) {
      const thread = await request(groupPath + '/threads/' + encodeURIComponent(scope.thread))
      if (thread?.group_no !== scope.group || thread.short_id !== scope.thread || ![1, 2].includes(thread.status)) fail('webhook_not_found')
    }
    if (input.action === 'threads') {
      if (scope.thread) fail('invalid_webhook_request')
      const page = input.page ?? 1
      const result = await request(groupPath + '/threads?page_index=' + page + '&page_size=100')
      if (!Array.isArray(result?.list) || !integer(result.count)) throw Error()
      const routes = result.list.map(thread => {
        const address = scope.group + '____' + thread.short_id
        if (thread.group_no !== scope.group || !ruleScope(5, address) || !text(thread.name)) throw Error()
        return { type: 5, address, name: group.name + ' / ' + thread.name }
      })
      return { routes, page, more: page * 100 < result.count }
    }
    if (input.action === 'list') return { list }
    const item = input.webhookId && list.find(row => row.webhook_id === input.webhookId)
    if (input.action !== 'create' && !item) fail('webhook_not_found')
    if (input.expected && input.expected !== item.version) fail('webhook_changed')
    const target = base + (item ? '/' + encodeURIComponent(item.webhook_id) : '')
    if (input.action === 'deliveries') {
      const result = await request(target + '/deliveries?limit=' + (input.limit ?? 50))
      if (!Array.isArray(result?.list)) throw Error()
      return { deliveries: result.list.map(row => {
        if (![1, 2, 3].includes(row?.status) || !text(row.reason, 128) || !/^[a-z0-9_]*$/.test(row.reason)
          || !text(row.adapter, 64) || !/^[a-z0-9_]*$/.test(row.adapter)
          || ![row.http_status, row.byte_size, row.created_at].every(integer) || !int64(row.message_id)) throw Error()
        return Object.fromEntries(['status', 'reason', 'http_status', 'adapter', 'byte_size', 'created_at'].map(key => [key, row[key]])
          .concat([['message_id', String(row.message_id)]]))
      }) }
    }
    // The server enforces creator-or-admin, admin-only avatar, mention roster,
    // group/thread lifecycle and feature gates on each operation. DSH's operator
    // is its authenticated administrator, never an asserted IM sender/owner.
    const method = input.action === 'update' ? 'PUT' : input.action === 'delete' ? 'DELETE' : 'POST'
    const suffix = ['regenerate', 'test'].includes(input.action) ? '/' + input.action : ''
    const body = ['create', 'update'].includes(input.action) ? changesOf(input.changes, input.action) : undefined
    const result = await request(target + suffix, method, body)
    // Once submitted, invalid success bodies are ambiguous too: never replay.
    try {
      if (input.action === 'delete') {
        if (result?.status !== 200) throw Error()
        return { deleted: item.webhook_id }
      }
      if (input.action === 'test') {
        if (result?.status !== 0 || !int64(result.message_id)) throw Error()
        return { test: { message_id: String(result.message_id) } }
      }
      const webhook = metadata(result, scope)
      if (item && webhook.webhook_id !== item.webhook_id) throw Error()
      return { webhook, ...(['create', 'regenerate'].includes(input.action) && { secret: secretResult(result, webhook, context.apiBase) }) }
    } catch { fail('webhook_outcome_unknown') }
  } catch (error) {
    if (Object.hasOwn(webhookErrors, error?.message)) throw error
    fail('webhook_unavailable')
  }
}
