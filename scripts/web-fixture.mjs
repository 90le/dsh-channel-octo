let received = 0
let sent = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const json = value => Response.json(value)
  if (url.hostname === 'octo-fixture.invalid') {
    if (url.pathname.endsWith('/verify-bot')) return json({ bot_uid: 'fixture-bot', space_id: 'fixture-space' })
    if (url.pathname.endsWith('/ack')) return json({ status: 200 })
    if (url.pathname.endsWith('/sendMessage')) {
      const body = JSON.parse(init.body)
      if (body.channel_id !== 'fixture-user' || body.payload.content !== 'fixture response ' + (sent + 1)) {
        console.error('FIXTURE_REPLY_MISMATCH')
        return new Response(null, { status: 400 })
      }
      sent++
      console.log('FIXTURE_REPLY_OK=' + sent)
      return json({ message_id: 100 + sent })
    }
    if (url.pathname.endsWith('/events')) {
      if (received < 2 && received === sent) {
        received++
        return json({status:1, results:[{event_id:received, message:{
          message_id:received, from_uid:'fixture-user', channel_type:1,
          payload:{ type:1, content:'fixture prompt ' + received },
        }}]})
      }
      return json({ status: 1, results: [] })
    }
  }
  if (url.hostname === 'model-fixture.invalid' && url.pathname.endsWith('/messages')) {
    const body = JSON.parse(init.body)
    const history = JSON.stringify(body.messages)
    const tail = JSON.stringify(body.messages.at(-1))
    const round = tail.includes('fixture prompt 2') ? 2 : tail.includes('fixture prompt 1') ? 1 : 0
    if (round && ((body.tools ?? []).length !== 0 || (round === 2 && !history.includes('fixture response 1')))) {
      console.error('FIXTURE_MODEL_CONTEXT_OR_TOOLS_WRONG round=' + round + ' tools=' + (body.tools ?? []).length + ' prior=' + history.includes('fixture response 1'))
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
