import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectAuthorizedSearch } from '../src/authorized-search.js'

const group = '00112233445566778899aabbccddeeff'
const second = 'ffeeddccbbaa99887766554433221100'
const short = '123456789012345678'
const main = { channel_type: 2, channel_id: group }
const topic = { channel_type: 5, channel_id: group + '____' + short }
const args = { targets: [main, topic], limit: 10 }
const pagination = { has_more: false, next_cursor: '' }
const message = (route = main, extra = {}) => ({ ...route, message_id: '9223372036854775806', message_seq: 10,
  sender_id: 'human', sender_name: '张三', sent_at: '2026-11-09T01:02:03Z', message_kind: 'text', snippet: '授权<mark>摘要</mark>', ...extra })
const mixed = (rows, page = pagination) => ({ data: rows.map(row => ({ result_type: 'message', sorted_at: row.sent_at, message: row })), pagination: page })
const file = (route = main, extra = {}) => ({ ...message(route), file_name: '说明.pdf', file_size_bytes: 123, file_ext: 'pdf',
  content_snippet: '文件正文摘要', download_url: 'https://private.invalid/NEVER_RETURN', preview_url: 'NEVER_RETURN', ...extra })
const bucket = (route = main, extra = {}) => ({ ...route, parent_group_no: group, group_name: '测试群',
  ...(route.channel_type === 5 && { thread_id: route.channel_id, thread_name: '子区' }),
  match_count: 50, match_count_approx: true, latest_at: '2026-11-09T01:02:03Z', preview: [message(route)], ...extra })
const grouped = groups => ({ data: { sequence: 0, query_id: 'private-audit-id', total_groups: 400,
  total_groups_approx: true, groups }, pagination })
const rejects = fn => assert.throws(fn, /^Error: invalid_authorized_search_response$/)

test('delegated search returns only explicit excerpts and int64 strings, never linked/media/unknown data', () => {
  const payload = mixed([message(main, { sender_avatar_url: 'NEVER_RETURN', rich_text: { body: 'NEVER_RETURN' }, token: 'NEVER_RETURN' }),
    message(topic, { message_id: '100' })])
  payload.data.push({ result_type: 'file', file: file(main, { message_id: '101' }) })
  const result = projectAuthorizedSearch('messages.search_authorized', payload, args)
  assert.equal(result.entries[0].message_id, '9223372036854775806')
  assert.equal(result.entries[0].excerpt, '授权摘要')
  assert.equal(result.entries[1].channel_id, topic.channel_id)
  assert.equal(result.entries[2].file_name, '说明.pdf')
  assert.equal(result.projection, 'authorized_search_excerpts')
  assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN|rich_text|download_url|preview_url|token/)
  const files = projectAuthorizedSearch('messages.search_authorized_files', { data: [file()], pagination }, args)
  assert.equal(files.entries[0].excerpt, '文件正文摘要')
})

test('server parent expansion cannot disclose an unselected topic, but pagination remains visible', () => {
  const page = { has_more: true, next_cursor: 'cursor-next-page' }
  const result = projectAuthorizedSearch('messages.search_authorized', mixed([message(topic)], page), { targets: [main] })
  assert.deepEqual(result.entries, [])
  assert.equal(result.filtered_expanded_topics, true)
  assert.equal(result.more, true)
  assert.equal(result.next_cursor, page.next_cursor)
  for (const other of [{ channel_id: second, channel_type: 2 }, { channel_id: 'other-person', channel_type: 1 }, main]) {
    rejects(() => projectAuthorizedSearch('messages.search_authorized', mixed([message(other)]), { targets: [topic] }))
  }
})

test('group aggregation uses composite server thread_id and flags approximate/truncated previews', () => {
  const many = Array.from({ length: 20 }, (_, i) => message(topic, { message_id: String(100 + i), snippet: '🚀'.repeat(4000) }))
  const result = projectAuthorizedSearch('messages.search_authorized_groups', grouped([bucket(topic, { preview: many })]), args)
  assert.equal(result.groups[0].thread_id, short)
  assert.equal(result.groups[0].preview.length, 3)
  assert.equal(Array.from(result.groups[0].preview[0].excerpt).length, 320)
  assert.equal(result.groups[0].preview_truncated, true)
  assert.ok(!('match_count' in result.groups[0]) && !('match_count_approx' in result.groups[0]))
  assert.equal(result.counts, 'visible_returned_groups_only')
  assert.equal(result.returned_groups, 1)
  assert.ok(!('total_groups' in result) && !('query_id' in result) && !('next_cursor' in result))
  rejects(() => projectAuthorizedSearch('messages.search_authorized_groups', grouped([bucket(topic, { thread_id: short })]), args))
  rejects(() => projectAuthorizedSearch('messages.search_authorized_groups', grouped([bucket(topic, { preview: [message(main)] })]), args))
})

test('malformed or misleading search projections never partially escape', async t => {
  const bad = [
    mixed([message(main, { message_id: 123 })]), mixed([message(main, { message_id: '9223372036854775808' })]),
    mixed([message(main, { message_seq: 0 })]), mixed([message(main, { message_seq: 2 ** 32 })]),
    mixed([message(main, { sent_at: 'yesterday' })]), mixed([message(main, { sender_id: '' })]),
    mixed([message(), message()]), mixed([message()], { has_more: true, next_cursor: '' }),
    mixed([message()], { has_more: false, next_cursor: 'x'.repeat(4097) }),
    { data: [{ result_type: 'message', message: message(), file: file() }], pagination },
    { data: [{ result_type: 'other', message: message() }], pagination },
    { data: [{ result_type: 'file', file: file(main, { file_size_bytes: -1 }) }], pagination },
    { data: [{ result_type: 'file', file: file(main, { file_size_bytes: '123' }) }], pagination },
  ]
  for (const [i, value] of bad.entries()) await t.test('invalid projection ' + i, () => rejects(() => projectAuthorizedSearch('messages.search_authorized', value, args)))
  rejects(() => projectAuthorizedSearch('messages.search_authorized', mixed([message(), message(main, { message_id: '101' })]), { ...args, limit: 1 }))
  rejects(() => projectAuthorizedSearch('messages.search_authorized_groups', { ...grouped([]), pagination: { has_more: true, next_cursor: 'not-supported' } }, args))
})
