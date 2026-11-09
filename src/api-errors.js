// Local source contract: octo-server f984d40549f66d56b1e90a048d28315eb12c92df,
// pkg/httperr/respond.go, pkg/i18n/{renderer.go,codes/shared.go}, and
// pkg/errcode/{bot_api,messages_search,incomingwebhook,ai_team,server}.go.
// These are exact code/status pairs, never prefix or prose-based matches.
const official = new Map()
function codes(prefix, status, apiCode, names) {
  for (const name of names.split(' ')) official.set(prefix + name, { status, apiCode })
}
codes('err.shared.', 401, 'api_authentication_failed', 'auth.required auth.token_missing auth.token_invalid auth.token_expired')
codes('err.shared.', 403, 'api_permission_denied', 'auth.forbidden')
codes('err.shared.', 400, 'api_invalid_request', 'param.invalid')
codes('err.shared.', 404, 'api_not_found', 'not_found')
codes('err.shared.', 429, 'api_rate_limited', 'rate.limited')
codes('err.shared.', 500, 'api_server_error', 'internal')
codes('err.server.bot_api.', 400, 'api_invalid_request', 'request_invalid limit_exceeded content_too_large file_too_large member_not_human thread_channel_not_accepted obo_reserved_field card_invalid')
codes('err.server.bot_api.', 413, 'api_invalid_request', 'payload_too_large')
codes('err.server.bot_api.', 400, 'api_unsupported', 'file_type_unsupported obo_mode_unsupported card_edit_forbidden')
codes('err.server.bot_api.', 400, 'api_disabled', 'card_disabled')
codes('err.server.bot_api.', 400, 'api_unavailable', 'bot_not_provisioned')
codes('err.server.bot_api.', 400, 'api_permission_denied', 'card_obo_forbidden')
codes('err.server.bot_api.', 401, 'api_authentication_failed', 'auth_failed')
codes('err.server.bot_api.', 403, 'api_permission_denied', 'not_group_member group_disbanded not_group_admin cannot_remove_privileged not_space_member app_bot_dm_only not_friend conversation_not_started message_edit_forbidden obo_not_authorized card_revision_clear_forbidden')
codes('err.server.bot_api.', 403, 'api_unsupported', 'app_bot_unsupported')
codes('err.server.bot_api.', 403, 'api_unavailable', 'bot_unavailable')
codes('err.server.bot_api.', 404, 'api_not_found', 'group_not_found message_not_found user_not_found bot_not_registered obo_grant_not_found obo_scope_not_found obo_channel_not_found')
codes('err.server.bot_api.', 409, 'api_conflict', 'obo_grant_exists obo_scope_exists message_not_delivered card_seq_conflict')
codes('err.server.bot_api.', 500, 'api_server_error', 'query_failed store_failed send_failed upload_failed im_token_failed auth_check_failed obo_internal')
codes('err.server.bot_api.', 502, 'api_unavailable', 'upstream_failed')
codes('err.server.messages_search.', 400, 'api_invalid_request', 'validation_failed')
codes('err.server.messages_search.', 400, 'api_search_depth_exceeded', 'depth_exceeded')
codes('err.server.messages_search.', 404, 'api_search_not_found', 'not_found')
codes('err.server.messages_search.', 429, 'api_rate_limited', 'rate_limited')
codes('err.server.messages_search.', 500, 'api_server_error', 'internal')
codes('err.server.messages_search.', 503, 'api_unavailable', 'upstream_unavailable')
codes('err.server.messages_search.', 503, 'api_disabled', 'disabled')
codes('err.server.incomingwebhook.', 400, 'api_invalid_request', 'mgmt_request_invalid')
codes('err.server.incomingwebhook.', 403, 'api_permission_denied', 'mgmt_forbidden')
codes('err.server.incomingwebhook.', 403, 'api_disabled', 'mgmt_disabled')
codes('err.server.incomingwebhook.', 404, 'api_not_found', 'mgmt_group_not_found mgmt_thread_not_found mgmt_not_found')
codes('err.server.incomingwebhook.', 409, 'api_conflict', 'mgmt_quota_exceeded mgmt_creator_quota_exceeded mgmt_total_quota_exceeded mgmt_creator_left')
codes('err.server.incomingwebhook.', 500, 'api_server_error', 'mgmt_query_failed mgmt_operation_failed')
codes('err.server.ai_team.', 403, 'api_permission_denied', 'container_protected')
codes('err.server.thread.', 400, 'api_invalid_request', 'group_no_invalid short_id_invalid request_invalid name_invalid source_message_invalid status_invalid creator_cannot_leave group_md_content_empty group_md_content_too_large setting_invalid')
codes('err.server.thread.', 403, 'api_permission_denied', 'not_group_member group_disbanded permission_denied')
codes('err.server.thread.', 404, 'api_not_found', 'not_found group_md_not_found')
codes('err.server.thread.', 410, 'api_not_found', 'deleted')
codes('err.server.thread.', 409, 'api_conflict', 'not_active status_changed')
codes('err.server.thread.', 500, 'api_server_error', 'store_failed')

const statusCodes = new Map([[400, 'api_invalid_request'], [401, 'api_authentication_failed'], [403, 'api_permission_denied'],
  [404, 'api_not_found'], [405, 'api_method_not_allowed'], [409, 'api_conflict'], [413, 'api_invalid_request'], [429, 'api_rate_limited']])
const statusCode = status => statusCodes.get(status)
  ?? (Number.isInteger(status) && status >= 500 && status <= 599 ? 'api_server_error' : 'api_request_failed')
const classified = new WeakMap()

// Keep the existing constructor and import from octo.js compatible. In particular,
// status/code ALWAYS describe the wire, never error.http_status from a body.
export class OctoError extends Error {
  constructor(code, status = 0, retryAfterMs = 0) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

// Reporting only: api_rate_limited is NOT permission to retry a write. Existing
// delivery callers must continue to check OctoError.status === 429 exclusively.
// WeakMap branding prevents arbitrary error.apiCode strings from being reflected.
export function apiErrorCode(error) {
  return classified.get(error) ?? statusCode(error?.status)
}

const maxErrorBytes = 16 * 1024
const errorReadMs = 1000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function cancel(stream) {
  try { Promise.resolve(stream?.cancel()).catch(() => {}) } catch { /* Never retain stream errors. */ }
}

async function errorBody(response, signal) {
  let reader, timer, onAbort
  try {
    if (!response.body || signal?.aborted) return null
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) > maxErrorBytes) return null
    reader = response.body.getReader()
    // Bound time as well as bytes; cancellation itself can hang on a bad stream.
    const stopped = new Promise(resolve => {
      onAbort = () => resolve(null)
      timer = setTimeout(onAbort, errorReadMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const deadline = Date.now() + errorReadMs
    let total = 0, chunks = 0, content = ''
    for (;;) {
      // Empty chunks must not create an unbounded microtask loop or starve timers.
      if (++chunks > maxErrorBytes + 1 || signal?.aborted || Date.now() >= deadline) return null
      const chunk = await Promise.race([reader.read(), stopped])
      if (!chunk) return null
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxErrorBytes) return null
      content += decoder.decode(chunk.value, { stream: true })
    }
    content += decoder.decode()
    return JSON.parse(content)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    cancel(reader ?? response.body)
  }
}

function retryAfter(response) {
  // No body value, including details.retry_after, can grant retry permission.
  if (response.status !== 429) return 0
  const header = response.headers.get('retry-after')
  if (header === null || header.length > 128) return 0
  const ms = /^\d{1,10}$/.test(header) ? Number(header) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)
      ? Date.parse(header) - Date.now() : 0
  return Number.isFinite(ms) ? Math.max(0, ms) : 0
}

export async function readApiError(response, signal) {
  const status = response.status
  const error = new OctoError('http_' + status, status, retryAfter(response))
  error.apiCode = statusCode(status)
  // Redirects never follow Location and never lend their body authority.
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const body = await errorBody(response, signal)
    const detail = object(body) && object(body.error) ? body.error : null
    const match = detail && typeof detail.code === 'string' ? official.get(detail.code) : undefined
    // The official renderer always sets top-level status to the wire status.
    // Accept only canonical status or the documented legacy wire-400 divergence.
    if (match && body.status === status && detail.http_status === match.status
      && (status === 400 || status === match.status)) {
      error.officialCode = detail.code
      error.semanticStatus = match.status
      error.apiCode = match.apiCode
    }
  } else cancel(response.body)
  classified.set(error, error.apiCode)
  return error
}
