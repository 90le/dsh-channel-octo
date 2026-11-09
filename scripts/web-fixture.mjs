import { wirePeer } from './wukong-fixture.mjs'

let received = 0
let sent = 0
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
      type: 1, content: 'fixture prompt ' + received,
      ...(!peer || received === 3 ? { mention: { uids: ['fixture-bot'] } } : {}),
    },
  }
}
if (peer) setInterval(() => {
  if (peer.send && received < routes.length && received === sent) peer.send(nextMessage())
}, 50).unref()
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const json = value => Response.json(value)
  if (url.hostname === 'octo-fixture.invalid') {
    if (url.pathname.endsWith('/verify-bot')) return json({ bot_uid: 'fixture-bot', space_id: 'fixture-space' })
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
    if (url.pathname.endsWith('/sendMessage')) {
      const body = JSON.parse(init.body)
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
    const round = titleRequest ? 0 : Number(Array.from(tail.matchAll(/fixture prompt ([1-5])/g)).at(-1)?.[1] ?? 0)
    const snapshot = body.messages.filter(m => m.role === 'user').flatMap(m =>
      typeof m.content === 'string' ? [m.content] : m.content.map(c => c.text ?? ''),
    ).filter(text => text.includes('Octo 当前会话规则快照')).at(-1) ?? ''
    const rulesOk = round <= 2 ? !snapshot
      : round === 3 ? snapshot.includes('PARENT-FIXTURE {{leave_literal}}') && !snapshot.includes('THREAD-FIXTURE')
        : round === 4 ? snapshot.includes('PARENT-FIXTURE {{leave_literal}}') && snapshot.includes('THREAD-FIXTURE')
          : snapshot.includes('"status":"empty"') && !snapshot.includes('PARENT-FIXTURE') && !snapshot.includes('THREAD-FIXTURE')
    if (round && ((body.tools ?? []).length !== 0
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
    return new Response(frames.map(f => 'event: ' + f.type + '\ndata: ' + JSON.stringify(f) + '\n\n').join(''), {
      headers: {'Content-Type':'text/event-stream'},
    })
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init)
  return new Response(null, {status: 503})
}
