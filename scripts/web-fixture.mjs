import { wirePeer } from './wukong-fixture.mjs'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

let received = 0
let sent = 0
let openedCard = false
const ownerSmoke = process.env.DSH_OCTO_FIXTURE_OWNER === '1'
let ownerStep = 0, uploaded = false, questionAnswered = false
const browserReady = process.env.DSH_OCTO_BROWSER_READY
const group = '00112233445566778899aabbccddeeff'
const thread = '123456789012345678'
const routes = [
  [1, 'fixture-user'], [1, 'fixture-user'],
  [2, group], [5, group + '____' + thread], [2, group],
]
const peer = process.env.DSH_OCTO_FIXTURE_WIRE === '1' ? await wirePeer() : null
function nextMessage() {
  const [type, address] = routes[received]
  received++
  return {
    messageId: String(received), sender: 'fixture-user', channelType: type, channelId: address,
    payload: {
      type: 1, content: 'fixture prompt ' + received + (ownerSmoke && received === 1 ? ' send a file' : ''),
      ...(!peer || received === 3 ? { mention: { uids: ['fixture-bot'] } } : {}),
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
      return request.channel_id === 'fixture-user' && request.channel_type === 1 && request.limit === 1
        ? json({ messages: [] }) : new Response(null, { status: 403 })
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
      if (body.channel_id !== address || body.channel_type !== type || body.payload.content !== 'fixture response ' + (sent + 1)) {
        console.error('FIXTURE_REPLY_MISMATCH')
        return new Response(null, { status: 400 })
      }
      sent++
      console.log('FIXTURE_REPLY_OK=' + sent)
      return json({ message_id: 100 + sent })
    }
    if (url.pathname.endsWith('/events')) {
      if (peer) return new Response(null, { status: 403 })
      if (received < routes.length && received === sent) {
        const m = nextMessage()
        return json({status:1, results:[{event_id:received, message:{
          message_id:m.messageId, from_uid:m.sender, channel_type:m.channelType, channel_id:m.channelId,
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
    const round = titleRequest ? 0 : Number(Array.from((ownerSmoke ? history : tail).matchAll(/fixture prompt ([1-5])/g)).at(-1)?.[1] ?? 0)
    if (ownerSmoke && round === 1 && ownerStep < 3) {
      const names = (body.tools ?? []).map(tool => tool.name)
      if (!names.includes('write') || !names.includes('present') || !names.includes('ask_user_question')) {
        console.error('FIXTURE_OWNER_TOOLS_MISSING')
        return new Response(null, { status: 400 })
      }
      const step = ownerStep++
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
    const rulesOk = round <= 2 ? !snapshot
      : round === 3 ? snapshot.includes('PARENT-FIXTURE {{leave_literal}}') && !snapshot.includes('THREAD-FIXTURE')
        : round === 4 ? snapshot.includes('PARENT-FIXTURE {{leave_literal}}') && snapshot.includes('THREAD-FIXTURE')
          : snapshot.includes('"status":"empty"') && !snapshot.includes('PARENT-FIXTURE') && !snapshot.includes('THREAD-FIXTURE')
    if (round && ((body.tools ?? []).length !== 0 && !(ownerSmoke && round <= 2)
      || !rulesOk || JSON.stringify(body.system ?? '').includes('PARENT-FIXTURE')
      || (round === 2 && !history.includes('fixture response 1'))
      || (round >= 3 && /fixture (prompt|response) [1-2]/.test(history))
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
