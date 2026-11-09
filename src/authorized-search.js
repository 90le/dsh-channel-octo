import { validUid } from './config.js'
import { ruleScope } from './rules.js'

// octo-server f984d405 modules/messages_search/search_global_{messages,files,groups}.go.
// This module handles only schemas and response projection. Its caller must bind
// the authenticated human principal and authorize every explicit target first.
export const authorizedSearchEndpoints = Object.freeze({
  'messages.search_authorized': '/v1/bot/messages/_search_global_messages',
  'messages.search_authorized_files': '/v1/bot/messages/_search_global_files',
  'messages.search_authorized_groups': '/v1/bot/messages/_search_global_groups',
})

export function authorizedSearchSpecs({ spec, schema, uid, searchPage, searchKeyword, searchFilters }) {
  const targets = { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true,
    items: schema({ channel_id: uid, channel_type: { type: 'integer', minimum: 2, maximum: 5, enum: [2, 5] } }, ['channel_id', 'channel_type']) }
  const filters = { ...searchFilters.properties,
    member_uids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: uid } }
  // The official mixed-search single-channel fast path drops content_types,
  // and its message_kind cannot distinguish rich text/image/plain text. Do not
  // advertise a filter whose semantics we cannot verify in the returned DTO.
  const messageFilters = schema(filters)
  const { cursor: _wireCursor, ...pagination } = searchPage
  pagination.continuation = { type: 'string', pattern: '^ocs_[a-f0-9]{32}$', maxLength: 36,
    description: 'Use the returned continuation with exactly the same targets and query. Bound to this account and requesting user; expires after five minutes.' }
  const fileFilters = schema({ ...filters,
    file_exts: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', enum:
      ['doc', 'docx', 'xls', 'xlsx', 'pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'html', 'htm', 'txt', 'md', 'gif', 'mp4', 'avi', 'mov', 'mkv', 'webm'] } },
    file_size_min: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    file_size_max: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  })
  const common = 'Only in the requesting human\'s own admitted private conversation, using their existing Octo delegated search authorization. '
    + 'Explicit group/topic targets must belong to this account\'s configured Space and route policy. No identity override, grant creation, bot-identity fallback, other-person DM search, or automatic pagination. '
    + 'Results are bounded authorized search excerpts, not full message history or downloadable attachments. Parent targets do not return unselected subtopics. For another page repeat the exact query with its returned continuation. '
  return [
    spec('messages.search_authorized', common + 'Search mixed message/file excerpts across selected targets.',
      schema({ targets, keyword: searchKeyword, ...pagination, filters: messageFilters }, ['targets'])),
    spec('messages.search_authorized_files', common + 'Search file names and indexed excerpts, with file type/size filters.',
      schema({ targets, keyword: searchKeyword, ...pagination, filters: fileFilters }, ['targets'])),
    spec('messages.search_authorized_groups', common + 'Summarize channels with visible matching excerpts. This endpoint may truncate groups and has no continuation. It is not a complete directory or an exact count of readable messages.',
      schema({ targets, keyword: searchKeyword, filters: messageFilters }, ['targets'])),
  ].map(item => ({ ...item, privateOnly: true }))
}

const fail = () => { throw new Error('invalid_authorized_search_response') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const messageID = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const text = (value, max, optional = false) => {
  if (value === undefined && optional) return ''
  if (typeof value !== 'string') fail()
  return Array.from(value.slice(0, max * 2)).slice(0, max).join('')
    .replace(/<\/?mark>/gi, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
const timestamp = value => {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail()
  return value
}
const keyOf = route => route.channel_type + ':' + route.channel_id

export function boundAuthorizedSearchResult(result) {
  // Measure the complete encoded result, including continuation and JSON
  // escaping. Leave space for the native host's tool-result wrapper.
  const budget = 63 * 1024
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8')
  if (size() <= budget) return result
  result.excerpts_truncated = true
  const entries = result.entries ?? result.groups.flatMap(group => group.preview)
  for (const entry of entries) {
    const runes = Array.from(entry.excerpt)
    let low = 0, high = runes.length
    entry.excerpt = ''
    if (size() > budget) continue
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      entry.excerpt = runes.slice(0, mid).join('')
      if (size() <= budget) low = mid
      else high = mid - 1
    }
    entry.excerpt = runes.slice(0, low).join('')
    break
  }
  if (size() > budget) fail()
  return result
}

export function projectAuthorizedSearch(operation, raw, args) {
  const grouped = operation === 'messages.search_authorized_groups'
  const files = operation === 'messages.search_authorized_files'
  if (!Object.hasOwn(authorizedSearchEndpoints, operation) || !object(raw?.pagination)
    || typeof raw.pagination.has_more !== 'boolean' || typeof raw.pagination.next_cursor !== 'string'
    || raw.pagination.next_cursor.length > 4096
    || (grouped ? raw.pagination.next_cursor !== '' : raw.pagination.has_more && !raw.pagination.next_cursor)) fail()
  const exact = new Set(args.targets.map(keyOf))
  const expandedParents = new Set(args.targets.filter(row => row.channel_type === 2).map(row => row.channel_id))
  let filtered = false
  const inScope = row => {
    if (!object(row) || !ruleScope(row.channel_type, row.channel_id)) fail()
    if (exact.has(keyOf(row))) return true
    // The official global API expands a selected group to its subtopics. Do not
    // expose those unless the caller separately selected that exact topic.
    const scope = ruleScope(row.channel_type, row.channel_id)
    if (scope.thread && expandedParents.has(scope.group)) { filtered = true; return false }
    fail()
  }
  const seen = new Set()
  const hit = (row, kind, excerptLimit = 1200) => {
    if (!object(row) || !messageID(row.message_id) || !Number.isSafeInteger(row.message_seq)
      || row.message_seq < 1 || row.message_seq > 0xffffffff || !validUid(row.sender_id)
      || seen.has(row.message_id)) fail()
    seen.add(row.message_id)
    if (!inScope(row)) return null
    const result = { channel_id: row.channel_id, channel_type: row.channel_type,
      message_id: row.message_id, message_seq: row.message_seq, sender_id: row.sender_id,
      sender_name: text(row.sender_name, 100, true), sent_at: timestamp(row.sent_at), result_type: kind }
    if (kind === 'file') {
      if (row.file_size_bytes !== undefined && !integer(row.file_size_bytes)) fail()
      return { ...result, file_name: text(row.file_name, 200), file_ext: text(row.file_ext, 20, true),
        ...(row.file_size_bytes !== undefined && { file_size_bytes: row.file_size_bytes }),
        excerpt: text(row.content_snippet, excerptLimit, true) }
    }
    return { ...result, message_kind: text(row.message_kind, 40), excerpt: text(row.snippet, excerptLimit, true) }
  }
  let content
  if (grouped) {
    if (!object(raw.data) || !integer(raw.data.sequence) || !integer(raw.data.total_groups)
      || typeof raw.data.total_groups_approx !== 'boolean' || !Array.isArray(raw.data.groups) || raw.data.groups.length > 1000) fail()
    const groups = [], seenGroups = new Set()
    for (const row of raw.data.groups) {
      const include = inScope(row)
      if (seenGroups.has(keyOf(row))) fail()
      seenGroups.add(keyOf(row))
      if (!include) continue
      const scope = ruleScope(row.channel_type, row.channel_id)
      if (row.parent_group_no !== undefined && row.parent_group_no !== scope.group
        || scope.thread && row.thread_id !== row.channel_id
        || !integer(row.match_count) || typeof row.match_count_approx !== 'boolean'
        || !Array.isArray(row.preview) || row.preview.length > 1000) fail()
      const preview = row.preview.slice(0, 3).map(item => {
        if (keyOf(item) !== keyOf(row)) fail()
        return hit(item, 'message', 320)
      })
      groups.push({ channel_id: row.channel_id, channel_type: row.channel_type,
        group_name: text(row.group_name, 100), ...(scope.thread && { thread_name: text(row.thread_name, 100), thread_id: scope.thread }),
        latest_at: timestamp(row.latest_at), preview, preview_truncated: row.preview.length > 3 })
    }
    // The original total also includes expanded subtopics; never present it as
    // an exact count of the selected routes or the human's readable messages.
    content = { groups, returned_groups: groups.length, counts: 'visible_returned_groups_only' }
  } else {
    if (!Array.isArray(raw.data) || raw.data.length > (args.limit ?? 10)) fail()
    const entries = raw.data.map(row => {
      if (files) return hit(row, 'file')
      if (!object(row) || !['message', 'file'].includes(row.result_type)
        || Object.hasOwn(row, row.result_type === 'file' ? 'message' : 'file')) fail()
      return hit(row[row.result_type], row.result_type)
    }).filter(Boolean)
    content = { entries }
  }
  return { ...content, scope: 'exact_requested_routes', projection: 'authorized_search_excerpts',
    filtered_expanded_topics: filtered, more: raw.pagination.has_more,
    ...(!grouped && { next_cursor: raw.pagination.next_cursor }) }
}
