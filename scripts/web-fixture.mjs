import { wirePeer } from './wukong-fixture.mjs'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

let received = 0
let sent = 0
let openedCard = false
const ownerSmoke = process.env.DSH_OCTO_FIXTURE_OWNER === '1'
const deleteSmoke = process.env.DSH_OCTO_FIXTURE_DELETE === '1'
let ownerStep = 0, uploaded = false, questionAnswered = false
const browserReady = process.env.DSH_OCTO_BROWSER_READY
const group = '00112233445566778899aabbccddeeff'
const thread = '123456789012345678'
const routes = [
  [1, 'fixture-user'], [1, 'fixture-user'],
  [2, group], [5, group + '____' + thread], [2, group],
  ...(deleteSmoke ? [[1, 'fixture-user']] : []),
]
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
    if (url.pathname.endsWith('/messages/sync')) {
      const request = JSON.parse(init.body)
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
    if (url.pathname.endsWith('/groups/' + group + '/members')) {
      return json([{ uid: 'fixture-bot', robot: 1 }, { uid: 'fixture-user', robot: 0 }])
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
    if (url.pathname.endsWith('/ack')) return json({ status: 200 })
    if (url.pathname.endsWith('/card/profile')) return json({
      enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'], inputs: ['Input.ChoiceSet'],
      config: { card_enabled: true, display_enabled: true, interaction_enabled: true, reasoning_enabled: true,
        reasoning_template_ref: { id: 'ai.reasoning-process', version: '0.4.1' } },
      templating: { supported: true, templates: [{ id: 'ai.reasoning-process', version: '0.4.1',
        views: [{ states: ['reasoning', 'answering', 'completed', 'stopped', 'error'] }] }] },
    })
    if (url.pathname.endsWith('/message/edit')) {
      const body = JSON.parse(init.body)
      if (body.message_id !== '200' || body.channel_type !== 1 || body.channel_id !== 'fixture-user'
        || body.template_ref?.id !== 'ai.reasoning-process' || body.data.state !== body.state
        || body.state === 'answering' && body.transient !== true
        || body.state === 'completed' && body.transient === true) {
        console.error('FIXTURE_CARD_EDIT_MISMATCH')
        return new Response(null, { status: 400 })
      }
      console.log('FIXTURE_CARD=' + body.state + ':' + body.card_seq)
      return json({})
    }
    if (ownerSmoke && url.pathname.endsWith('/upload/presigned')) return json({
      method: 'PUT', uploadUrl: 'https://storage-fixture.invalid/fixture.txt?signature=fixture',
      downloadUrl: 'https://files-fixture.invalid/fixture.txt', contentType: 'text/plain',
    })
    if (url.pathname.endsWith('/sendMessage')) {
      const body = JSON.parse(init.body)
      if (ownerSmoke && body.payload.type === 8) {
        if (!uploaded || body.channel_type !== 1 || body.channel_id !== 'fixture-user') return new Response(null, { status: 400 })
        console.log('FIXTURE_FILE_OK')
        return json({ message_id: 300 })
      }
      if (ownerSmoke && body.payload.profile === 'octo/v2') {
        if (body.channel_id !== 'fixture-user' || body.channel_type !== 1) return new Response(null, { status: 400 })
        setTimeout(() => peer.send({ messageId: '901', sender: 'fixture-user', channelType: 1,
          channelId: 'fixture-user', payload: { type: 1, content: '1' } }), 300).unref()
        console.log('FIXTURE_QUESTION_SENT')
        return json({ message_id: 299 })
      }
      if (body.payload.type === 17) {
        if (openedCard || received !== 1 || body.channel_type !== 1 || body.channel_id !== 'fixture-user'
          || body.payload.template_ref?.id !== 'ai.reasoning-process' || body.payload.data.state !== body.payload.state) {
          console.error('FIXTURE_CARD_OPEN_MISMATCH')
          return new Response(null, { status: 400 })
        }
        openedCard = true
        console.log('FIXTURE_CARD_OPEN')
        return json({ message_id: 200 })
      }
      const [type, address] = routes[sent] ?? []
      if (body.channel_id !== address || body.channel_type !== type || body.payload.content !== 'fixture response ' + (sent + 1)
        || type >= 2 && body.payload.reply?.message_id !== String(sent + 1)) {
        console.error('FIXTURE_REPLY_MISMATCH')
        return new Response(null, { status: 400 })
      }
      sent++
      if (deleteSmoke && sent === 1) removeFirstFixtureSession()
      console.log('FIXTURE_REPLY_OK=' + sent)
      return json({ message_id: 100 + sent })
    }
    if (url.pathname.endsWith('/events')) {
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
        questionAnswered = history.includes('Fixture answer one')
        if (!questionAnswered) return new Response(null, { status: 400 })
        console.log('FIXTURE_QUESTION_ANSWERED')
      }
      const tool = ['ask_user_question', 'write', 'present'][step]
      const args = [
        { questions: [{ id: 'fixture-choice', question: 'Which test file?', options: [
          { label: 'Fixture answer one', description: 'Text file' }, { label: 'Other answer', description: 'Another option' },
        ] }] },
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
    if (round && ((body.tools ?? []).length !== 0 && !(ownerSmoke && round <= 2)
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
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:round ? 'fixture response '+round : 'Fixture title'}},
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
