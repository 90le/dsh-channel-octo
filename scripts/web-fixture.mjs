import { wirePeer } from './wukong-fixture.mjs'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

let received = 0
let sent = 0
const ownerSmoke = process.env.DSH_OCTO_FIXTURE_OWNER === '1'
const groupToolsSmoke = process.env.DSH_OCTO_FIXTURE_GROUP_TOOLS === '1'
const delegatedSmoke = process.env.DSH_OCTO_FIXTURE_DELEGATED_SEARCH === '1'
let delegatedStep = 0
const ownerCaption = 'fixture response 1\n\n文件：<fixture_summary.md>\n\n**摘要结构**\n\n- 第一项：文件已生成。\n- 第二项：说明随文件完整交付。\n\n可继续修改 ✅'
const deleteSmoke = process.env.DSH_OCTO_FIXTURE_DELETE === '1'
let ownerStep = 0, uploaded = false, questionAnswered = false
let questionIndex = 0
let groupStep = 0
let groupQuestion
let groupDisplaySent = false, groupDisplayReceipt = false
let groupFormAnswered = false, groupFormFeedback = false
let approvalSent = false, approvalFeedback = false
let groupDisplayPayload
const adminOperations = ['octo_webhooks_update', 'octo_webhooks_test', 'octo_webhooks_delete', 'octo_messages_clear_card_revisions']
const adminCompleted = new Set()
const fixtureHookId = 'iwh_' + 'a'.repeat(32)
let fixtureHook = { webhook_id: fixtureHookId, group_no: '00112233445566778899aabbccddeeff',
  creator_uid: 'fixture-bot', name: 'Build fixture', status: 1, allow_mention_all: 0, allow_mention_bots: 0,
  mention_uids: [], last_used_at: 0, call_count: 0, created_at: 1 }
const typedForm = { title: 'Fixture typed form', inputs: [
  { id: 'note', kind: 'text', label: '说明', required: true },
  { id: 'amount', kind: 'number', label: '数量', required: true },
  { id: 'date', kind: 'date', label: '日期', required: true },
  { id: 'time', kind: 'time', label: '时间', required: true },
  { id: 'flag', kind: 'toggle', label: '开关', required: true },
  { id: 'pick', kind: 'choice', label: '多选', required: true, multi: true, options: [{ title: '甲', value: 'a' }, { title: '乙', value: 'b' }] },
], actions: [{ id: 'submit', label: '提交' }] }
const groupDisplayForm = { title: 'Fixture summary', blocks: [
  { type: 'text', text: 'Group work completed.' },
  { type: 'facts', items: [{ label: 'Status', value: 'Ready' }] },
  { type: 'table', rows: [
    { cells: [{ text: 'Item' }, { text: 'Result' }] },
    { cells: [{ text: 'Group file' }, { text: 'Written' }] },
  ] },
  { type: 'columns', columns: [
    { blocks: [{ type: 'text', text: 'Left detail' }] },
    { blocks: [{ type: 'text', text: 'Right detail' }] },
  ] },
] }
const questionEvents = new Map()
const browserReady = process.env.DSH_OCTO_BROWSER_READY
const group = '00112233445566778899aabbccddeeff'
const thread = '123456789012345678'
const routes = [
  [1, 'fixture-user'], [1, 'fixture-user'],
  [2, group], [5, group + '____' + thread], [2, group],
  ...(deleteSmoke ? [[1, 'fixture-user']] : []),
]
const progressCards = new Map([
  ['200', { turn: 1, type: 1, address: 'fixture-user', seq: 1 }],
  ...(delegatedSmoke ? [['202', { turn: 2, type: 1, address: 'fixture-user', seq: 1 }]] : []),
  ...(groupToolsSmoke ? [['201', { turn: 3, type: 2, address: group, seq: 1 }]] : []),
])
function removeFirstFixtureSession() {
  const root = resolve(process.env.DSH_HOME)
  if (!/^dsh-octo-smoke-/.test(basename(root))) throw new Error('Not an isolated fixture home')
  const db = new DatabaseSync(join(process.env.DSH_OCTO_FIXTURE_STATE, 'channel.sqlite'), { readOnly: true })
  let id
  try { id = db.prepare("SELECT session_id FROM jobs WHERE message_id='1'").get()?.session_id } finally { db.close() }
  if (!/^session-[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Missing fixture identity')
  const dirs = readdirSync(join(root, 'sessions'), { withFileTypes: true }).filter(row => row.isDirectory())
  const source = dirs.map(row => resolve(root, 'sessions', row.name, id)).find(dir => existsSync(dir))
  const destination = resolve(root, 'removed-fixture-session')
  if (!source || [source, destination].some(dir => {
    const path = relative(root, dir)
    return !path || isAbsolute(path) || path.startsWith('..')
  })) throw new Error('Fixture session is outside its isolated home')
  // Preserve the synthetic log outside the host's session root to reproduce
  // the durable result of deletion without erasing any data.
  renameSync(source, destination)
  console.log('FIXTURE_SESSION_REMOVED')
}
const peer = process.env.DSH_OCTO_FIXTURE_WIRE === '1' ? await wirePeer() : null
function nextMessage() {
  const [type, address] = routes[received]
  received++
  return {
    messageId: String(received), sender: 'fixture-user', channelType: type, channelId: address, seq: 10 * received,
    payload: ownerSmoke && received === 1 ? { type: 8, url: 'file/preview/chat/fixture/note.txt', name: 'note.txt' }
      : received === 3 || deleteSmoke && received === 2 ? {
        type: 14,
        content: [{ type: 'text', text: 'fixture prompt ' + received }, { type: 'image', url: '/api/v1/file/preview/chat/fixture/test.png' }],
        mention: { entities: [{ uid: 'fixture-bot', offset: 0, length: 3 }] },
      } : {
      type: 1, content: 'fixture prompt ' + received,
      ...(!peer ? { mention: { uids: ['fixture-bot'] } } : {}),
      ...(received === 4 && { reply: { message_id: '605' } }),
    },
  }
}
if (peer) setInterval(() => {
  if (peer.send && received < routes.length && received === sent
    && (!browserReady || received !== 1 || existsSync(browserReady + '.owned'))) peer.send(nextMessage())
}, 50).unref()
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const json = value => Response.json(value)
  if (ownerSmoke && url.hostname === 'storage-fixture.invalid') {
    uploaded = init.method === 'PUT' && Buffer.from(init.body).toString() === 'written by native DSH'
    return new Response(null, { status: uploaded ? 200 : 400 })
  }
  if (url.hostname === 'octo-fixture.invalid') {
    if (url.pathname.endsWith('/verify-bot')) {
      const { bot_token: token } = JSON.parse(init.body)
      if (token === 'bf_fixture_second' || token === 'bf_fixture_second_rotated') return json({ bot_uid: 'fixture-bot-second', space_id: 'fixture-space' })
      return json({ bot_uid: 'fixture-bot', space_id: 'fixture-space', ...(ownerSmoke && { owner_uid: 'fixture-user' }) })
    }
    if (url.pathname.endsWith('/register') && peer) {
      return json({ robot_id: 'fixture-bot', im_token: 'fixture-im-secret', ws_url: peer.wsUrl })
    }
    if (url.pathname.endsWith('/v1/bot/heartbeat')) return json({})
    if (url.pathname.endsWith('/v1/bot/readReceipt')) return json({})
    if (url.pathname.endsWith('/messages/sync')) {
      const request = JSON.parse(init.body)
      if (request.limit === 1 && request.pull_mode === 0 && routes.some(([type,id]) => type === request.channel_type && id === request.channel_id)) return json({ messages: [] })
      if (request.channel_type === 1 && request.channel_id === 'fixture-user' && request.limit === 1) return json({ messages: [] })
      const [type, id] = routes[received - 1] ?? []
      if (type < 2 || request.channel_id !== id || request.channel_type !== type
        || request.start_message_seq !== received * 10 - 1 || request.pull_mode !== 0 || request.limit !== 20) {
        console.error('FIXTURE_SYNC_SCOPE_WRONG')
        return new Response(null, { status: 403 })
      }
      const row = (msgId, seq, content, channelId = id) => ({ message_id: msgId, message_seq: seq,
        from_uid: 'history-user', channel_id: channelId, channel_type: type,
        payload: Buffer.from(JSON.stringify({ type: 1, content })).toString('base64') })
      return json({ messages: [
        row('601', received * 10 - 1, type === 2 ? 'GROUP-HISTORY-FIXTURE' : 'TOPIC-HISTORY-FIXTURE'),
        ...(type === 5 ? [row('605', received * 10 - 2, 'TOPIC-QUOTE-FIXTURE')] : []),
        row('603', received * 10, 'FUTURE-HISTORY-FIXTURE'),
        row('604', received * 10 - 3, 'WRONG-ROUTE-FIXTURE', type === 5 ? group : group + '____' + thread),
      ] })
    }
    if (ownerSmoke && url.pathname.endsWith('/file/download/chat/fixture/note.txt')) {
      setTimeout(() => peer.send({ messageId: '902', sender: 'fixture-user', channelType: 1,
        channelId: 'fixture-user', payload: { type: 1, content: 'fixture prompt 1 send a file' } }), 100).unref()
      await delay(450)
      return new Response('INPUT-FILE-FIXTURE', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (url.pathname.endsWith('/file/download/chat/fixture/test.png')) {
      console.log('FIXTURE_RICH_IMAGE_DOWNLOADED')
      if (deleteSmoke && received === 2) console.log('FIXTURE_POST_DELETE_IMAGE')
      return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQMgkDAAD4AJ3MaiF4AAAAAElFTkSuQmCC', 'base64'),
        { headers: { 'Content-Type': 'image/png' } })
    }
    if (url.pathname.endsWith('/groups') && url.searchParams.get('space_id') === 'fixture-space') {
      return json([{ group_no: group, space_id: 'fixture-space' }])
    }
    if (delegatedSmoke && url.pathname.includes('/v1/bot/space/principals/')) {
      const uid = url.pathname.split('/').at(-1)
      if (!['fixture-user', 'fixture-bot'].includes(uid) || url.searchParams.get('space_id') !== 'fixture-space') return new Response(null, { status: 403 })
      return json({ uid, principal_type: uid === 'fixture-user' ? 'human' : 'user_bot' })
    }
    if (delegatedSmoke && url.pathname.endsWith('/v1/bot/resolve/targets')) {
      if (url.searchParams.get('name') !== 'Fixture') return new Response(null, { status: 400 })
      return json({ total: 1, truncated: false, candidates: [{ channel_id: group, channel_type: 2, kind: 'group', group_no: group, name: 'Fixture Group' }] })
    }
    if (delegatedSmoke && url.pathname.endsWith('/groups/' + group + '/threads/' + thread)) {
      return json({ group_no: group, short_id: thread, channel_id: group + '____' + thread, channel_type: 5,
        name: 'Fixture Topic', status: 1, creator_uid: 'fixture-user' })
    }
    if (delegatedSmoke && url.pathname.includes('/v1/bot/messages/_search_global_')) {
      const body = JSON.parse(init.body)
      if (body.on_behalf_of === 'fixture-bot' && body.keyword === 'x'.repeat(65) && Object.keys(body).length === 2) {
        return Response.json({ status: 403, error: { code: 'err.server.bot_api.obo_not_authorized', http_status: 403 } }, { status: 403 })
      }
      if (received !== 2 || body.on_behalf_of !== 'fixture-user' || body.keyword !== 'fixture'
        || JSON.stringify(body.filters.channel_ids) !== JSON.stringify([{ channel_id: group, channel_type: 2 }])) {
        console.error('FIXTURE_DELEGATED_SCOPE_MISMATCH')
        return new Response(null, { status: 403 })
      }
      const row = { message_id: '888', message_seq: 8, sender_id: 'fixture-user', sender_name: 'Fixture User',
        channel_id: group, channel_type: 2, sent_at: '2026-11-09T01:02:03Z', message_kind: 'text', snippet: 'AUTHORIZED-SEARCH-EXCERPT' }
      const file = { ...row, file_name: 'authorized.md', file_ext: 'md', file_size_bytes: 42, content_snippet: 'AUTHORIZED-FILE-EXCERPT', download_url: 'NEVER_RETURN_WIRE_SECRET' }
      if (url.pathname.endsWith('_search_global_groups')) return json({ data: { sequence: 0, total_groups: 1, total_groups_approx: true,
        groups: [{ channel_id: group, channel_type: 2, parent_group_no: group, group_name: 'Authorized group',
          match_count: 10, match_count_approx: true, latest_at: row.sent_at, preview: [row] }] }, pagination: { has_more: false, next_cursor: '' } })
      if (url.pathname.endsWith('_search_global_files')) return json({ data: [file], pagination: { has_more: false, next_cursor: '' } })
      if (body.cursor !== undefined && body.cursor !== 'NEVER_RETURN_WIRE_CURSOR') return new Response(null, { status: 400 })
      return json({ data: [{ result_type: 'message', message: { ...row, snippet: body.cursor ? 'AUTHORIZED-PAGE-TWO' : row.snippet } }],
        pagination: { has_more: !body.cursor, next_cursor: body.cursor ? '' : 'NEVER_RETURN_WIRE_CURSOR' } })
    }
    if (url.pathname.endsWith('/groups/' + group) && init.method === 'GET') {
      return json({ group_no: group, name: 'Fixture Group', notice: '', status: 1 })
    }
    if (url.pathname.endsWith('/groups/' + group + '/members')) {
      return json([{ uid: 'fixture-bot', name: 'Fixture Bot', robot: 1, role: 2 },
        { uid: 'fixture-user', name: 'Fixture User', robot: 0, role: 1 }])
    }
    const hooksRoot = '/api/v1/bot/groups/' + group + '/incoming-webhooks'
    if (groupToolsSmoke && url.pathname === hooksRoot && init.method === 'GET') return json({ list: fixtureHook ? [fixtureHook] : [] })
    if (groupToolsSmoke && url.pathname.startsWith(hooksRoot + '/' + fixtureHookId)) {
      if (received !== 3 || !fixtureHook) return new Response(null, { status: 404 })
      if (url.pathname === hooksRoot + '/' + fixtureHookId && init.method === 'PUT') {
        const body = JSON.parse(init.body)
        if (JSON.stringify(body) !== JSON.stringify({ name: 'Updated fixture', status: 0 })) return new Response(null, { status: 400 })
        fixtureHook = { ...fixtureHook, ...body }
        return json(fixtureHook)
      }
      if (url.pathname === hooksRoot + '/' + fixtureHookId + '/test' && init.method === 'POST') return json({ status: 0, message_id: '701' })
      if (url.pathname === hooksRoot + '/' + fixtureHookId && init.method === 'DELETE') {
        fixtureHook = undefined
        return json({ status: 200 })
      }
      return new Response(null, { status: 400 })
    }
    if (groupToolsSmoke && url.pathname === '/api/v1/bot/groups/' + group + '/messages/700') {
      if (!groupDisplayPayload) return new Response(null, { status: 404 })
      return json({ message_id: '700', message_seq: 35, from_uid: 'fixture-bot', channel_type: 2, channel_id: group,
        payload: groupDisplayPayload })
    }
    if (groupToolsSmoke && url.pathname === '/api/v1/bot/message/card/revisions/clear' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      if (received !== 3 || body.message_id !== '700' || body.channel_type !== 2 || body.channel_id !== group
        || !groupDisplayPayload) return new Response(null, { status: 400 })
      return json({ cleared: 2 })
    }
    if (url.pathname.endsWith('/groups/' + group + '/mention_pref')) {
      const enabled = received === 4 || received === 5
      return json({ effective: enabled, group_allow_no_mention: enabled })
    }
    if (init.method === 'GET' && url.pathname.endsWith('/groups/' + group + '/md')) {
      return received === 5
        ? json({ content: '', version: 2 })
        : json({ content: 'PARENT-FIXTURE {{leave_literal}}', version: 1 })
    }
    if (init.method === 'GET' && url.pathname.endsWith('/groups/' + group + '/threads/' + thread + '/md')) {
      return json({ content: 'THREAD-FIXTURE', version: 8 })
    }
    if (url.pathname.endsWith('/ack')) {
      if (groupToolsSmoke && /\/events\/(904|905)\/ack$/.test(url.pathname)) {
        groupQuestion.invalidAccepted = true
        console.error('FIXTURE_GROUP_INVALID_CALLBACK_ACCEPTED')
      }
      return json({ status: 200 })
    }
    if (url.pathname.endsWith('/card/profile')) return json({
      enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'], inputs: ['Input.Text', 'Input.Number', 'Input.Date', 'Input.Time', 'Input.Toggle', 'Input.ChoiceSet'],
      elements: ['TextBlock', 'FactSet', 'Table', 'TableRow', 'TableCell'],
      config: { card_enabled: true, display_enabled: true, interaction_enabled: true, reasoning_enabled: true,
        reasoning_template_ref: { id: 'ai.reasoning-process', version: '0.4.1' } },
      templating: { supported: true, templates: [{ id: 'ai.reasoning-process', version: '0.4.1',
        views: [{ states: ['reasoning', 'answering', 'completed', 'stopped', 'error'] }] }] },
    })
    if (url.pathname.endsWith('/message/edit')) {
      const body = JSON.parse(init.body)
      if (groupToolsSmoke && body.message_id === '506' && body.content_edit) {
        const frame = JSON.parse(body.content_edit)
        if (!approvalSent || body.channel_id !== group || body.channel_type !== 2 || frame.card.actions?.length
          || !frame.plain.includes('仅批准这一次')) return new Response(null, { status: 400 })
        approvalFeedback = true
        console.log('FIXTURE_APPROVAL_FEEDBACK')
        return json({})
      }
      if (groupToolsSmoke && body.message_id === '505' && body.content_edit) {
        const frame = JSON.parse(body.content_edit)
        if (body.channel_id !== group || body.channel_type !== 2 || frame.card.actions?.length || !frame.plain.includes('表单答案已交给 DSH')) return new Response(null, { status: 400 })
        groupFormFeedback = true
        console.log('FIXTURE_TYPED_FORM_FEEDBACK')
        return json({})
      }
      if (ownerSmoke && body.content_edit && Number(body.message_id) >= 501
        && Number(body.message_id) <= (groupToolsSmoke ? 504 : 503)) {
        const frame = JSON.parse(body.content_edit)
        const inGroup = String(body.message_id) === '504'
        if (frame.card.actions?.length || !frame.plain.includes('已收到第')
          || body.channel_type !== (inGroup ? 2 : 1) || body.channel_id !== (inGroup ? group : 'fixture-user')
          || inGroup && (!groupQuestion?.validSent || !frame.plain.includes('Fixture group answer'))) {
          console.error('FIXTURE_QUESTION_FEEDBACK_MISMATCH')
          return new Response(null, { status: 400 })
        }
        if (inGroup) groupQuestion.feedback = true
        console.log('FIXTURE_ANSWER_FEEDBACK=' + body.message_id)
        return json({})
      }
      const card = progressCards.get(body.message_id)
      const terminal = ['completed', 'stopped', 'error'].includes(body.state)
      if (!card?.opened || card.terminal || body.channel_type !== card.type || body.channel_id !== card.address
        || body.template_ref?.id !== 'ai.reasoning-process' || body.data?.state !== body.state
        || body.data?.reasoningId !== 'dsh-octo-' + card.turn
        || !['reasoning', 'answering', 'completed', 'stopped', 'error'].includes(body.state)
        || !Number.isSafeInteger(body.card_seq) || body.card_seq <= card.seq
        || !terminal && body.transient !== true || terminal && body.transient === true) {
        console.error('FIXTURE_CARD_EDIT_MISMATCH')
        return new Response(null, { status: 400 })
      }
      card.seq = body.card_seq
      card.terminal = terminal
      console.log('FIXTURE_CARD=' + body.message_id + ':' + body.state + ':' + body.card_seq)
      return json({})
    }
    if (ownerSmoke && url.pathname.endsWith('/upload/presigned')) return json({
      method: 'PUT', uploadUrl: 'https://storage-fixture.invalid/fixture.txt?signature=fixture',
      downloadUrl: 'https://files-fixture.invalid/fixture.txt', contentType: 'text/plain',
    })
    if (url.pathname.endsWith('/sendMessage')) {
      const body = JSON.parse(init.body)
      if (delegatedSmoke && body.payload.content?.startsWith('EXPLICIT-TARGET-FIXTURE')) {
        const topicSend = body.channel_type === 5
        if (received !== 2 || body.channel_id !== (topicSend ? group + '____' + thread : group)
          || ![2, 5].includes(body.channel_type) || body.on_behalf_of || body.payload.reply
          || body.payload.type !== 1 || body.payload.mention?.uids?.[0] !== 'fixture-user'
          || !body.payload.content.includes('@Fixture User')) return new Response(null, { status: 400 })
        console.log('FIXTURE_PROACTIVE_SENT=' + body.channel_type)
        return json({ message_id: topicSend ? '779' : '778' })
      }
      if (ownerSmoke && body.payload.type === 8) {
        if (!uploaded || body.channel_type !== 1 || body.channel_id !== 'fixture-user') return new Response(null, { status: 400 })
        console.log('FIXTURE_FILE_OK')
        return json({ message_id: 300 })
      }
      if (ownerSmoke && body.payload.profile === 'octo/v2') {
        const inGroup = groupToolsSmoke && received === 3
        if (body.channel_id !== (inGroup ? group : 'fixture-user') || body.channel_type !== (inGroup ? 2 : 1)
          || !body.payload.card.actions?.[0]?.data) return new Response(null, { status: 400 })
        if (inGroup && body.payload.plain?.startsWith('DSH 等待你的批准\n')) {
          if (approvalSent || groupStep !== 3 || !JSON.stringify(body.payload).includes('group-tool-fixture.txt')
            || !JSON.stringify(body.payload).includes('仅批准这一次')) return new Response(null, { status: 400 })
          approvalSent = true
          setTimeout(() => questionEvents.set('907', { event_id: '907', event_type: 'card_action', event_data: {
            message_id: '506', action_id: 'answer', space_id: 'fixture-space', operator_uid: 'fixture-user',
            channel_id: group, channel_type: 2, data: body.payload.card.actions[0].data, inputs: { selection: 'q1' },
          } }), 300).unref()
          console.log('FIXTURE_APPROVAL_CARD')
          return json({ message_id: 506 })
        }
        const index = ++questionIndex, id = 500 + index, eventId = String(900 + index)
        if (inGroup && body.payload.plain === typedForm.title) {
          if (index !== 5 || groupStep !== 5 || body.payload.card.body.filter(n => n.type.startsWith('Input.')).length !== 6) return new Response(null, { status: 400 })
          setTimeout(() => questionEvents.set('908', { event_id: '908', event_type: 'card_action', event_data: {
            message_id: '505', action_id: 'submit', space_id: 'fixture-space', operator_uid: 'fixture-user',
            channel_id: group, channel_type: 2, data: body.payload.card.actions[0].data,
            inputs: { note: 'typed answer', amount: '2.5', date: '2028-02-29', time: '12:30', flag: 'true', pick: 'a,b' },
          } }), 300).unref()
          console.log('FIXTURE_TYPED_FORM_SENT')
          return json({ message_id: id })
        }
        const event = { event_id: eventId, event_type: 'card_action', event_data: {
          message_id: String(id), action_id: 'answer', space_id: 'fixture-space', operator_uid: 'fixture-user',
          channel_id: body.channel_id, channel_type: body.channel_type,
          inputs: { selection: 'q1' }, data: body.payload.card.actions[0].data,
        } }
        if (inGroup) {
          if (index !== 4 || groupStep !== 2 || groupQuestion) return new Response(null, { status: 400 })
          groupQuestion = { valid: { ...event, event_id: '906' }, validSent: false, invalidAccepted: false }
          // Give the bridge time to bind the card. Send only invalid callbacks
          // first; the next poll cursor must pass both before releasing q1.
          setTimeout(() => {
            for (const [badId, patch] of [['904', { operator_uid: 'fixture-other' }],
              ['905', { channel_id: group + '____' + thread, channel_type: 5 }]]) {
              questionEvents.set(badId, { ...event, event_id: badId, event_data: {
                ...event.event_data, ...patch, inputs: { selection: 'q2' },
              } })
            }
          }, 300).unref()
          console.log('FIXTURE_GROUP_QUESTION_SENT')
        } else {
          setTimeout(() => questionEvents.set(eventId, event), 300).unref()
          console.log('FIXTURE_QUESTION_SENT')
        }
        return json({ message_id: id })
      }
      if (body.payload.profile === 'octo/v1') {
        const { payload } = body
        const blocks = payload.card?.body ?? []
        const table = blocks.find(block => block.type === 'Table')
        const cells = table?.rows?.map(row => row.cells?.map(cell => cell.items?.map(item => item.text).join('')))
        const plain = 'Fixture summary\nGroup work completed.\nStatus：Ready\nItem | Result\nGroup file | Written\nLeft detail\n|\nRight detail'
        if (!groupToolsSmoke || received !== 3 || groupStep !== 4 || !groupQuestion?.writeCompleted || groupDisplaySent
          || body.channel_type !== 2 || body.channel_id !== group || payload.type !== 17
          || payload.card_version !== '1.5' || payload.card?.type !== 'AdaptiveCard' || payload.card?.version !== '1.5'
          || payload.plain !== plain || payload.card?.actions?.length
          || blocks.map(block => block.type).join(',') !== 'TextBlock,TextBlock,FactSet,Table,TextBlock'
          || blocks[0].text !== 'Fixture summary' || blocks[1].text !== 'Group work completed.'
          || JSON.stringify(blocks[2].facts) !== JSON.stringify([{ title: 'Status', value: 'Ready' }])
          || JSON.stringify(cells) !== JSON.stringify([['Item', 'Result'], ['Group file', 'Written']])
          || table.rows.some(row => row.type !== 'TableRow' || row.cells.some(cell => cell.type !== 'TableCell'))
          || blocks[4].text !== 'Left detail\n|\nRight detail') {
          console.error('FIXTURE_GROUP_DISPLAY_CARD_MISMATCH')
          return new Response(null, { status: 400 })
        }
        groupDisplaySent = true
        groupDisplayPayload = structuredClone(payload)
        console.log('FIXTURE_GROUP_DISPLAY_CARD_OK=700')
        return json({ message_id: 700 })
      }
      if (body.payload.type === 17) {
        const entry = [...progressCards].find(([, card]) => body.payload.data?.reasoningId === 'dsh-octo-' + card.turn)
        const [id, card] = entry ?? []
        if (!card || card.opened || received !== card.turn || body.channel_type !== card.type || body.channel_id !== card.address
          || body.payload.template_ref?.id !== 'ai.reasoning-process' || body.payload.data?.state !== body.payload.state
          || !['reasoning', 'answering'].includes(body.payload.state)) {
          console.error('FIXTURE_CARD_OPEN_MISMATCH')
          return new Response(null, { status: 400 })
        }
        card.opened = true
        console.log('FIXTURE_CARD_OPEN=' + [id, card.type, card.address, body.payload.state, card.seq].join(':'))
        return json({ message_id: Number(id) })
      }
      const [type, address] = routes[sent] ?? []
      const expectedText = ownerSmoke && sent === 0 ? ownerCaption : 'fixture response ' + (sent + 1)
      if (body.channel_id !== address || body.channel_type !== type || body.payload.content !== expectedText
        || type === 1 && body.payload.reply !== undefined
        || type >= 2 && (body.payload.reply?.message_id !== String(sent + 1)
          || body.payload.reply.message_seq !== 10 * (sent + 1) || body.payload.reply.payload?.type !== 1)) {
        console.error('FIXTURE_REPLY_MISMATCH')
        return new Response(null, { status: 400 })
      }
      if (groupToolsSmoke && sent === 2 && (!groupQuestion?.answered || !groupQuestion?.writeCompleted
        || !groupDisplaySent || !groupDisplayReceipt || !groupFormAnswered || adminCompleted.size !== 4)) {
        console.error('FIXTURE_GROUP_FINAL_BEFORE_TOOLS')
        return new Response(null, { status: 400 })
      }
      sent++
      if (groupToolsSmoke && sent === 3) console.log('FIXTURE_GROUP_FINAL_OK')
      if (ownerSmoke && sent === 1) console.log('FIXTURE_FILE_CAPTION_OK')
      if (deleteSmoke && sent === 1) removeFirstFixtureSession()
      console.log('FIXTURE_REPLY_OK=' + sent)
      return json({ message_id: 100 + sent })
    }
    if (url.pathname.endsWith('/events')) {
      if (ownerSmoke && peer) {
        await delay(80)
        const cursor = BigInt(JSON.parse(init.body).event_id)
        // Keep the group question open until its progress card exists; fast
        // local model responses must not make progress coverage timing-dependent.
        if (groupQuestion && !groupQuestion.validSent && cursor >= 905n && progressCards.get('201')?.opened) {
          if (groupQuestion.invalidAccepted || groupQuestion.feedback || groupStep !== 2) {
            console.error('FIXTURE_GROUP_INVALID_CALLBACK_ACCEPTED')
            return new Response(null, { status: 400 })
          }
          groupQuestion.validSent = true
          questionEvents.set('906', groupQuestion.valid)
          console.log('FIXTURE_GROUP_INVALID_CALLBACKS_IGNORED')
        }
        return json({ status: 1, results: [...questionEvents.values()].filter(event => BigInt(event.event_id) > cursor) })
      }
      if (peer) return new Response(null, { status: 403 })
      if (received < routes.length && received === sent) {
        const m = nextMessage()
        return json({status:1, results:[{event_id:received, message:{
          message_id:m.messageId, message_seq:m.seq, from_uid:m.sender, channel_type:m.channelType, channel_id:m.channelId,
          payload:m.payload,
        }}]})
      }
      return json({ status: 1, results: [] })
    }
  }
  if (url.hostname === 'model-fixture.invalid' && url.pathname.endsWith('/messages')) {
    const body = JSON.parse(init.body)
    const history = JSON.stringify(body.messages)
    const tail = JSON.stringify(body.messages.at(-1))
    const titleRequest = tail.includes('Generate the session title from this JSON array of human messages:')
    const round = titleRequest ? 0 : Number(Array.from((ownerSmoke ? history : tail).matchAll(/fixture prompt ([1-6])/g)).at(-1)?.[1] ?? 0)
    if (delegatedSmoke && round === 2) {
      if (delegatedStep === 0) {
        const until = Date.now() + 6000
        while (!progressCards.get('202').opened && Date.now() < until) await delay(50)
        if (!progressCards.get('202').opened) throw new Error('FIXTURE_SECOND_PROGRESS_MISSING')
      }
      const names = (body.tools ?? []).map(tool => tool.name)
      const operations = ['octo_messages_search_authorized', 'octo_messages_search_authorized', 'octo_messages_search_authorized_files', 'octo_messages_search_authorized_groups',
        'octo_messages_resolve_targets', 'octo_messages_send_target', 'octo_messages_send_target']
      if (operations.some(name => !names.includes(name)) || history.includes('NEVER_RETURN_WIRE_')) return new Response(null, { status: 400 })
      let prior
      if (delegatedStep) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_delegated_' + (delegatedStep - 1))
        const text = typeof result?.content === 'string' ? result.content : (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        try { prior = JSON.parse(text) } catch {}
        const expected = ['AUTHORIZED-SEARCH-EXCERPT', 'AUTHORIZED-PAGE-TWO', 'AUTHORIZED-FILE-EXCERPT', 'Authorized group',
          'Fixture Group', 'EXPLICIT-TARGET-FIXTURE', 'Fixture Topic'][delegatedStep - 1]
        if (!prior || result.is_error || !text.includes(expected) || delegatedStep === 1 && !/^ocs_[a-f0-9]{32}$/.test(prior.continuation)
          || delegatedStep === 4 && ('match_count' in prior.groups[0] || 'total_groups' in prior)) return new Response(null, { status: 400 })
        console.log('FIXTURE_DELEGATED_TOOL_OK=' + delegatedStep)
      }
      if (delegatedStep < operations.length) {
        const step = delegatedStep++, name = operations[step]
        const args = step === 4 ? { name: 'Fixture' } : step >= 5 ? {
          target: { channel_id: step === 5 ? group : group + '____' + thread, channel_type: step === 5 ? 2 : 5 },
          text: 'EXPLICIT-TARGET-FIXTURE', uids: ['fixture-user'], confirm_send: true,
        } : { targets: [{ channel_id: group, channel_type: 2 }], keyword: 'fixture',
          ...(step === 1 && { continuation: prior.continuation }), ...(step === 2 && { filters: { file_exts: ['md'] } }) }
        const frames = [
          { type: 'message_start', message: { id: 'delegated-' + step, model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_delegated_' + step, name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
        ]
        return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
      }
    }
    if (ownerSmoke && round === 3) {
      const names = (body.tools ?? []).map(tool => tool.name)
      if (!names.includes('octo_members') || (groupToolsSmoke
        ? !names.includes('write') || !names.includes('ask_user_question') || !names.includes('octo_display_card')
        : names.some(name => !name.startsWith('octo_')))) {
        console.error('FIXTURE_GROUP_TOOL_SCOPE_WRONG')
        return new Response(null, { status: 400 })
      }
      if (groupStep > 0) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_group_members')
        if (result?.is_error || !JSON.stringify(result?.content).includes('Fixture User')) return new Response(null, { status: 400 })
        console.log('FIXTURE_GROUP_MEMBERS_OK')
      }
      if (groupToolsSmoke && groupStep >= 2) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_group_ask_user_question')
        const text = typeof result?.content === 'string' ? result.content
          : (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        let answers
        try { answers = JSON.parse(text)?.answers } catch {}
        if (result?.is_error || !groupQuestion?.validSent || !groupQuestion?.feedback || answers?.length !== 1
          || answers[0].id !== 'fixture-group-choice' || answers[0].selected?.length !== 1
          || answers[0].selected[0] !== 'Fixture group answer') {
          console.error('FIXTURE_GROUP_QUESTION_ANSWER_WRONG')
          return new Response(null, { status: 400 })
        }
        if (!groupQuestion.answered) console.log('FIXTURE_GROUP_QUESTION_ANSWERED')
        groupQuestion.answered = true
      }
      if (groupToolsSmoke && groupStep >= 3) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_group_write')
        if (!result || result.is_error || !approvalSent || !approvalFeedback) return new Response(null, { status: 400 })
        if (!groupQuestion.writeCompleted) console.log('FIXTURE_GROUP_WRITE_OK')
        groupQuestion.writeCompleted = true
      }
      if (groupToolsSmoke && groupStep >= 4) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_group_octo_display_card')
        const text = typeof result?.content === 'string' ? result.content
          : (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        let receipt
        try { receipt = JSON.parse(text) } catch {}
        if (result?.is_error || !groupDisplaySent || receipt?.messageId !== '700' || receipt?.format !== 'display_card'
          || receipt?.requiresFinalSummary !== true || JSON.stringify(receipt?.fallbackBlocks) !== '["columns"]') {
          console.error('FIXTURE_GROUP_DISPLAY_RECEIPT_WRONG')
          return new Response(null, { status: 400 })
        }
        groupDisplayReceipt = true
        console.log('FIXTURE_GROUP_DISPLAY_RECEIPT_OK')
      }
      if (groupToolsSmoke && groupStep === 5) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_group_octo_form')
        const text = typeof result?.content === 'string' ? result.content : (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        let answer; try { answer = JSON.parse(text) } catch {}
        if (result?.is_error || !groupFormFeedback || answer?.action !== 'submit' || answer.values?.note !== 'typed answer'
          || answer.values.amount !== 2.5 || answer.values.flag !== true || answer.values.date !== '2028-02-29'
          || answer.values.time !== '12:30' || JSON.stringify(answer.values.pick) !== '["a","b"]') return new Response(null, { status: 400 })
        groupFormAnswered = true
        console.log('FIXTURE_TYPED_FORM_ANSWERED')
      }
      if (groupToolsSmoke && groupStep >= 6) {
        const name = adminOperations[groupStep - 6]
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_group_' + name)
        const text = typeof result?.content === 'string' ? result.content : (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        let receipt; try { receipt = JSON.parse(text) } catch {}
        if (result?.is_error || receipt?.ok !== true
          || name === 'octo_webhooks_update' && receipt.webhook?.status !== 0
          || name === 'octo_webhooks_test' && receipt.message_id !== '701'
          || name === 'octo_webhooks_delete' && receipt.deleted !== true
          || name === 'octo_messages_clear_card_revisions' && receipt.cleared !== 2) return new Response(null, { status: 400 })
        adminCompleted.add(name)
        console.log('FIXTURE_ADMIN_TOOL_OK=' + name)
      }
      if (groupStep < (groupToolsSmoke ? 9 : 1)) {
        const step = groupStep++
        const name = ['octo_members', 'ask_user_question', 'write', 'octo_display_card', 'octo_form', ...adminOperations][step]
        const id = 'toolu_fixture_group_' + (step === 0 ? 'members' : name)
        const args = [{}, { questions: [{ id: 'fixture-group-choice', question: 'Continue with the group file?', options: [
          { label: 'Fixture group answer', description: 'Write the group file' },
          { label: 'Wrong callback answer', description: 'Must not be accepted' },
        ] }] }, { file_path: 'group-tool-fixture.txt', content: 'group native tools executed' }, groupDisplayForm, typedForm,
          { webhook_id: fixtureHookId, name: 'Updated fixture', enabled: false },
          { webhook_id: fixtureHookId, confirm_send: true }, { webhook_id: fixtureHookId },
          { message_id: '700', confirm_clear: true }][step]
        const frames = [
          { type: 'message_start', message: { id: 'fixture-group-tool', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]
        return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
          { headers: { 'Content-Type': 'text/event-stream' } })
      }
    }
    if (ownerSmoke && round === 1 && ownerStep < 3) {
      const names = (body.tools ?? []).map(tool => tool.name)
      if (!names.includes('write') || !names.includes('present') || !names.includes('ask_user_question')) {
        console.error('FIXTURE_OWNER_TOOLS_MISSING')
        return new Response(null, { status: 400 })
      }
      const step = ownerStep++
      if (step === 0 && (!history.includes('INPUT-FILE-FIXTURE') || !history.includes('同一用户补充的要求'))) {
        console.error('FIXTURE_STEER_INPUT_MISSING')
        return new Response(null, { status: 400 })
      }
      if (step === 1) {
        const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result' && part.tool_use_id === 'toolu_fixture_ask_user_question')
        const text = typeof result?.content === 'string' ? result.content
          : (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        let answers
        try { answers = JSON.parse(text)?.answers } catch {}
        questionAnswered = answers?.length === 3 && answers.every((answer, i) =>
          answer.id === 'fixture-choice-' + (i + 1) && answer.selected?.length === 1 && answer.selected[0] === 'Fixture answer ' + (i + 1))
        if (!questionAnswered) return new Response(null, { status: 400 })
        console.log('FIXTURE_QUESTION_ANSWERED')
      }
      const tool = ['ask_user_question', 'write', 'present'][step]
      const args = [
        { questions: [1, 2, 3].map(i => ({ id: 'fixture-choice-' + i, question: 'Question ' + i, options: [
          { label: 'Fixture answer ' + i, description: 'Text file' }, { label: 'Other answer', description: 'Another option' },
        ] })) },
        { file_path: 'octo-tool-fixture.txt', content: 'written by native DSH' },
        { files: [{ path: 'octo-tool-fixture.txt' }] },
      ][step]
      const frames = [
        { type: 'message_start', message: { id: 'fixture-tool', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture_' + tool, name: tool, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
        { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const snapshot = body.messages.filter(m => m.role === 'user').flatMap(m =>
      typeof m.content === 'string' ? [m.content] : m.content.map(c => c.text ?? ''),
    ).filter(text => text.includes('Octo 当前会话规则快照')).at(-1) ?? ''
    const rulesOk = round <= 2 || round === 6 ? !snapshot
      : round === 3 ? snapshot.includes('PARENT-FIXTURE {{leave_literal}}') && !snapshot.includes('THREAD-FIXTURE')
        : round === 4 ? snapshot.includes('PARENT-FIXTURE {{leave_literal}}') && snapshot.includes('THREAD-FIXTURE')
          : snapshot.includes('"status":"empty"') && !snapshot.includes('PARENT-FIXTURE') && !snapshot.includes('THREAD-FIXTURE')
    const historyOk = round <= 2 || round === 6 ? !/GROUP-HISTORY-FIXTURE|TOPIC-HISTORY-FIXTURE/.test(history)
      : round === 4 ? history.includes('TOPIC-HISTORY-FIXTURE') && history.includes('TOPIC-QUOTE-FIXTURE') && !history.includes('GROUP-HISTORY-FIXTURE')
        : history.includes('GROUP-HISTORY-FIXTURE') && !history.includes('TOPIC-HISTORY-FIXTURE')
    if (round && ((body.tools ?? []).length !== 0 && !ownerSmoke
      || !rulesOk || !historyOk || /FUTURE-HISTORY-FIXTURE|WRONG-ROUTE-FIXTURE/.test(history)
      || JSON.stringify(body.system ?? '').includes('PARENT-FIXTURE')
      || (round === 2 && (deleteSmoke ? history.includes('fixture response 1') : !history.includes('fixture response 1')))
      || (round >= 3 && round !== 6 && /fixture (prompt|response) [1-2]/.test(history))
      || (round === 6 && (!history.includes('fixture response 2') || history.includes('fixture response 1')))
      || (round === 4 && /fixture (prompt|response) 3/.test(history))
      || (round === 5 && (!history.includes('fixture response 3') || /fixture (prompt|response) 4/.test(history))))) {
      console.error('FIXTURE_MODEL_CONTEXT_OR_TOOLS_WRONG round=' + round + ' rules=' + rulesOk + ' tools=' + (body.tools ?? []).length)
      return new Response(null, { status: 400 })
    }
    const frames = [
      {type:'message_start', message:{id:'fixture',model:body.model,usage:{input_tokens:3,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:round ? ownerSmoke && round === 1 ? ownerCaption : 'fixture response '+round : 'Fixture title'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}},
      {type:'message_stop'},
    ]
    const encode = items => items.map(f => 'event: ' + f.type + '\ndata: ' + JSON.stringify(f) + '\n\n').join('')
    const bodyStream = round === 1 ? new ReadableStream({
      async start(controller) {
        await delay(4500)
        controller.enqueue(new TextEncoder().encode(encode(frames.slice(0, 3))))
        await delay(1600)
        controller.enqueue(new TextEncoder().encode(encode(frames.slice(3))))
        controller.close()
      },
    }) : encode(frames)
    return new Response(bodyStream, { headers: {'Content-Type':'text/event-stream'} })
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init)
  return new Response(null, {status: 503})
}
