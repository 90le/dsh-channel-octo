// Only the opt-in deferred smoke uses this phase file and synthetic SQLite.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { wirePeer } from './wukong-fixture.mjs'

const owner = 'fixture-user', bot = 'fixture-bot', space = 'fixture-space'
const cardId = '820', validId = '9306', phaseName = 'deferred-fixture-phase.json'
const fileName = 'deferred-tool-fixture.txt', fileText = 'written by native DSH after restart: later answer / 7'
const prompt = 'DEFERRED-ORIGINAL-TASK: 发布稍后填写的表单并立即结束本轮；等我提交后，在原会话写文件、展示并完整说明。'
const caption = 'DEFERRED-FINAL\n\n文件：<deferred-tool-fixture.txt>\n\n**完整说明**\n\n'
  + '- 已接收稍后提交的答案：later answer；数量：7。\n- 已在原 DSH 会话的新回合写入并展示文件。\n\n'
  + '保留 Markdown、中文、段落与表情，文件和说明都交付到原私聊。✅\n\nDEFERRED-CAPTION-END'
const form = { title: 'Deferred native fixture', text: '稍后提交后生成文件；本轮无需等待。', inputs: [
  { id: 'note', kind: 'text', label: '说明', required: true },
  { id: 'amount', kind: 'number', label: '数量', required: true },
], actions: [{ id: 'submit', label: '提交' }], expires_minutes: 60 }
const shortReply = receipt => '表单已发布，请稍后填写。有效期至 ' + receipt.expires_at + '。本轮已结束。'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

function isolatedHome(home, state) {
  assert.equal(dirname(realpathSync(home)), realpathSync(tmpdir()), 'fixture home must be a direct temporary child')
  assert.match(basename(home), /^dsh-octo-smoke-/)
  assert.equal(resolve(state), join(realpathSync(home), 'octo-state'))
}

function snapshot(state) {
  const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
  try {
    return {
      jobs: db.prepare('SELECT message_id,event_id,sender,channel_type,channel_id,session_id,state,result_id,input,reply,issue,metadata FROM jobs ORDER BY seq').all(),
      cards: db.prepare('SELECT message_id,claimed,binding,expires_ms FROM card_bindings ORDER BY message_id').all()
        .map(row => ({ ...row, binding: JSON.parse(row.binding) })),
      acks: db.prepare('SELECT event_id FROM pending_card_acks').all(),
    }
  } finally { db.close() }
}

const nativeEvents = output => [...output.matchAll(/FIXTURE_DEFERRED_NATIVE=(\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]))
function assertTurns(output, sessionId) {
  const events = nativeEvents(output)
  assert.deepEqual(events.map(event => event.type), ['turn/start', 'turn/end'], 'exactly one completed native turn per process')
  assert.ok(events.every(event => event.sessionId === sessionId), 'native session identity must match the stored job')
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  assert.ok(child.kill(), 'failed to stop fixture child')
  await Promise.race([closed, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('fixture child did not close') })])
}

export async function assertDeferredSmoke({ home, state, child, output, restart }) {
  isolatedHome(home, state)
  const logs = process.env.DSH_OCTO_SMOKE_LOG_DIR
    ? resolve(process.env.DSH_OCTO_SMOKE_LOG_DIR) : mkdtempSync(join(realpathSync(tmpdir()), 'dsh-octo-deferred-evidence-'))
  const logRelative = relative(home, logs)
  assert.ok(isAbsolute(logRelative) || logRelative === '..' || logRelative.startsWith('..\\') || logRelative.startsWith('../'), 'evidence must survive home cleanup')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  console.log('DEFERRED_LOG_DIR=' + logs)
  let second, secondOutput = '', first, after, failure
  const waitFor = async (processChild, getOutput, label, check, timeout = 70_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (getOutput().includes('FIXTURE_DEFERRED_FAIL=')) throw new Error(label + ': ' + getOutput().match(/FIXTURE_DEFERRED_FAIL=[^\r\n]+/g).join('; '))
      if (processChild.exitCode !== null || processChild.signalCode !== null) throw new Error(label + ': native child exited')
      let current
      try { current = snapshot(state) } catch (error) {
        if (!/unable to open|no such table|locked|busy/i.test(error.message)) throw error
      }
      if (current && check(current)) return current
      await delay(100)
    }
    throw new Error(label + ': timed out; see private process log and SQLite snapshot')
  }
  try {
    first = await waitFor(child, output, 'first sent=1 and pending binding', current =>
      current.jobs.length === 1 && current.jobs[0].state === 'sent'
      && current.cards.length === 1 && current.cards[0].binding.deferred?.state === 'pending'
      && output().includes('FIXTURE_DEFERRED_FIRST_SENT') && output().includes('FIXTURE_DEFERRED_WIRE_ACK')
      && nativeEvents(output()).some(event => event.type === 'turn/end'))
    const job = first.jobs[0], card = first.cards[0], receipt = readJson(join(home, 'deferred-publish-receipt.json'))
    assert.equal(job.message_id, '1')
    assert.equal(job.result_id, '821')
    assert.equal(job.reply, null, 'sent jobs clear their transient final text')
    assert.equal(card.claimed, 0)
    assert.equal(card.binding.deferred.sessionId, job.session_id)
    assert.equal(card.binding.deferred.sourceMessageId, '1')
    assert.equal(card.binding.messageId, cardId)
    assert.equal(card.binding.operatorUid, owner)
    assert.deepEqual(card.binding.route, { channel_id: owner, channel_type: 1 })
    assert.equal(card.binding.spaceId, space)
    assert.equal(card.binding.account, JSON.stringify(['https://octo-fixture.invalid/api', space, bot]))
    assert.match(card.binding.cardNonce, /^[a-f0-9]{32}$/)
    assert.equal(Date.parse(receipt.expires_at), card.expires_ms)
    assert.equal(card.expires_ms - card.binding.deferred.createdAt, 60 * 60_000)
    assert.deepEqual(first.acks, [])
    assert.ok(!existsSync(join(home, fileName)), 'no continuation file before callback')
    assert.ok(!output().includes('FIXTURE_DEFERRED_CALLBACK'), 'no card action before restart')
    assertTurns(output(), job.session_id)
    save(join(logs, 'first-sent-pending.json'), first)
    console.log('PASS: first native publish returned pending/expiry, short final sent=1, turn ended without a callback or waiting tool.')

    const firstPid = child.pid
    const patchHash = createHash('sha256').update(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'))).digest('hex')
    await stop(child)
    // This is the only phase mutation; never reinstall, reset the DB, or replace DSH_HOME.
    assert.deepEqual(snapshot(state), first, 'stopping first process changed its durable evidence')
    save(join(home, phaseName), { phase: 'resume', home: realpathSync(home), sessionId: job.session_id, firstPid })
    second = restart()
    assert.notEqual(second.pid, firstPid)
    for (const stream of [second.stdout, second.stderr]) stream.on('data', chunk => { secondOutput += chunk })
    console.log('DEFERRED_RESTART=' + JSON.stringify({ home, firstPid, secondPid: second.pid, sessionId: job.session_id }))
    after = await waitFor(second, () => secondOutput, 'resumed sent=2 with full file/caption', current =>
      current.jobs.filter(row => row.state === 'sent').length === 2
      && ['RESTORED_PENDING', 'INVALID_CALLBACKS_IGNORED', 'DUPLICATES_RELEASED', 'CALLBACK_ACK', 'TERMINAL_ACK',
        'MANAGE_STATUS_OK', 'WRITE_OK', 'PRESENT_OK', 'UPLOAD_OK', 'FILE_OK', 'FULL_CAPTION_OK', 'FEEDBACK_OK']
        .every(marker => secondOutput.includes('FIXTURE_DEFERRED_' + marker))
      && nativeEvents(secondOutput).some(event => event.type === 'turn/end'))
    // Give queued duplicate callbacks and any accidental extra turn a chance to surface.
    await delay(1500)
    await stop(second)
    after = snapshot(state)
    assert.ok(!secondOutput.includes('FIXTURE_DEFERRED_FAIL='), secondOutput)
    assert.equal(after.jobs.length, 3, 'only two tasks and one ignored terminal-event receipt may exist')
    assert.deepEqual(after.jobs.map(row => row.state), ['sent', 'sent', 'ignored'])
    const response = after.jobs[1]
    assert.equal(response.message_id, 'card_action:' + validId)
    assert.equal(response.event_id, validId)
    assert.equal(response.session_id, job.session_id)
    assert.equal(response.sender, owner)
    assert.equal(response.channel_type, 1)
    assert.equal(response.channel_id, owner)
    assert.equal(response.result_id, '823')
    assert.equal(response.reply, null)
    assert.equal(response.input, '')
    assert.equal(response.metadata, null)
    const running = readJson(join(home, 'deferred-running-job.json'))
    assert.equal(running.message_id, response.message_id)
    assert.equal(running.session_id, job.session_id)
    assert.equal(running.state, 'running')
    assert.ok(running.input.includes('later answer') && !running.input.includes('REJECTED-ANSWER'))
    const metadata = JSON.parse(running.metadata)
    assert.equal(metadata.deferredForm.sourceMessageId, cardId)
    assert.equal(metadata.deferredForm.sessionId, job.session_id)
    assert.equal(after.cards.length, 1)
    assert.equal(after.cards[0].claimed, 1)
    assert.equal(after.cards[0].binding.deferred.state, 'submitted')
    assert.equal(after.cards[0].binding.deferred.responseId, response.message_id)
    assert.equal(after.cards[0].binding.deferred.feedback, true)
    const duplicate = after.jobs[2]
    assert.equal(duplicate.message_id, 'card_action:9307')
    assert.equal(duplicate.session_id, null)
    assert.equal(duplicate.input, '')
    assert.equal(duplicate.result_id, null)
    assert.deepEqual(after.acks, [])
    assert.equal((secondOutput.match(/FIXTURE_DEFERRED_CALLBACK_ACK\b/g) ?? []).length, 1)
    assert.equal((secondOutput.match(/FIXTURE_DEFERRED_TERMINAL_ACK\b/g) ?? []).length, 1)
    assertTurns(secondOutput, job.session_id)
    assert.equal(readFileSync(join(home, fileName), 'utf8'), fileText)
    save(join(logs, 'resumed-running-job.json'), running)
    writeFileSync(join(logs, fileName), fileText)
    assert.equal(createHash('sha256').update(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'))).digest('hex'), patchHash)
    save(join(logs, 'result.json'), { passed: true, home, firstPid, secondPid: second.pid, sessionId: job.session_id,
      nativeTurns: 2, sentJobs: 2, validAcks: 1, terminalCleanupAcks: 1, invalidCallbacks: 5, duplicateCallbacks: 2, patchHash })
    console.log('PASS: stopped/restarted the same installed DSH_HOME; original native session resumed in exactly one new turn.')
    console.log('PASS: wrong operator/route/message/nonce/Space ignored; exact replay and new-event duplicate caused no extra run; one valid ACK plus one ignored terminal-event cleanup ACK.')
    console.log('PASS: native manage(status), write and present; exact uploaded bytes, file receipt and complete Markdown final delivered.')
  } catch (error) {
    failure = error
    save(join(logs, 'result.json'), { passed: false, error: error.stack, home })
    throw error
  } finally {
    try { await stop(second ?? child) } finally {
      const scrub = value => value.replace(/https?:\/\/\S+/g, '[fixture-url]')
      writeFileSync(join(logs, 'first-process.log'), scrub(output()))
      writeFileSync(join(logs, 'second-process.log'), scrub(secondOutput))
      try { save(join(logs, 'last-snapshot.json'), snapshot(state)) } catch {}
      console.log((failure ? 'FAIL' : 'PASS') + ': deferred evidence saved at ' + logs)
    }
  }
}

export async function installDeferredFixture() {
  const home = realpathSync(process.env.DSH_HOME), state = process.env.DSH_OCTO_FIXTURE_STATE
  isolatedHome(home, state)
  const phase = existsSync(join(home, phaseName)) ? readJson(join(home, phaseName)) : { phase: 'publish' }
  assert.ok(['publish', 'resume'].includes(phase.phase))
  const resumed = phase.phase === 'resume'
  let binding, valid, receipt, step = 0, sent = false, released = false, uploaded = false, fileSent = false, feedback = false, acks = 0, terminalAcks = 0
  const mark = name => console.log('FIXTURE_DEFERRED_' + name)
  const fail = reason => { mark('FAIL=' + reason); return new Response(null, { status: 400 }) }
  if (resumed) {
    assert.equal(phase.home, home)
    assert.notEqual(phase.firstPid, process.pid)
    const saved = snapshot(state)
    assert.equal(saved.jobs.length, 1)
    assert.equal(saved.jobs[0].state, 'sent')
    assert.equal(saved.jobs[0].session_id, phase.sessionId)
    assert.equal(saved.cards.length, 1)
    binding = saved.cards[0].binding
    assert.equal(binding.deferred.state, 'pending')
    assert.equal(binding.deferred.sessionId, phase.sessionId)
    assert.equal(saved.cards[0].claimed, 0)
    valid = { event_id: validId, event_type: 'card_action', event_data: {
      message_id: binding.messageId, channel_id: binding.route.channel_id, channel_type: binding.route.channel_type,
      operator_uid: binding.operatorUid, space_id: binding.spaceId, action_id: binding.actionIds[0],
      data: { dsh_card_nonce: binding.cardNonce }, inputs: { note: 'later answer', amount: '7' },
    } }
    mark('RESTORED_PENDING')
  }
  const peer = await wirePeer()
  let delivered = false, wireAcked = false
  if (!resumed) setInterval(() => {
    if (!delivered && peer.send) {
      peer.send({ messageId: '1', sender: owner, channelId: owner, channelType: 1, seq: 1, payload: { type: 1, content: prompt } })
      delivered = true
    }
    if (!wireAcked && peer.acked.includes('1')) { wireAcked = true; mark('WIRE_ACK') }
  }, 50).unref()
  const stream = (body, content, tool) => {
    const frames = [
      { type: 'message_start', message: { id: 'deferred-fixture', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool
        ? { type: 'tool_use', id: 'toolu_deferred_' + phase.phase + '_' + (step - 1), name: tool, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(content) } : { type: 'text_delta', text: content } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
      { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const operations = resumed ? [
    ['octo_form_manage', { action: 'status', message_id: cardId }],
    ['write', { file_path: fileName, content: fileText }],
    ['present', { files: [{ path: fileName }] }],
  ] : [['octo_form_publish', form]]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), path = url.pathname
    const method = init?.method ?? 'GET', json = value => Response.json(value)
    if (url.hostname === 'octo-fixture.invalid') {
      const body = init?.body ? JSON.parse(init.body) : undefined
      if (path === '/api/v1/auth/verify-bot') {
        if (method !== 'POST' || body?.bot_token !== 'bf_fixture') return fail('VERIFY')
        return json({ bot_uid: bot, space_id: space, owner_uid: owner })
      }
      if (new Headers(init?.headers).get('authorization') !== 'Bearer bf_fixture') return fail('AUTH')
      if (path === '/api/v1/bot/register') return json({ robot_id: bot, im_token: 'fixture-im-secret', ws_url: peer.wsUrl })
      if (['/api/v1/bot/heartbeat', '/api/v1/bot/readReceipt'].includes(path)) return json({})
      if (path === '/api/v1/bot/messages/sync') {
        if (body?.channel_id !== owner || body.channel_type !== 1 || body.limit !== 1) return fail('FRIEND_SCOPE')
        return json({ messages: [] })
      }
      if (path === '/api/v1/bot/card/profile') return json({ enabled: true, card_version: '1.5', profiles: ['octo/v1', 'octo/v2'],
        inputs: ['Input.Text', 'Input.Number'], elements: ['TextBlock'],
        config: { card_enabled: true, display_enabled: true, interaction_enabled: true, reasoning_enabled: false } })
      if (path === '/api/v1/bot/events') {
        if (method !== 'POST') return fail('EVENT_METHOD')
        await delay(80)
        if (!resumed) return json({ status: 1, results: [] })
        const cursor = BigInt(body.event_id)
        if (cursor < 9305n) {
          const bad = [
            { operator_uid: 'fixture-other' },
            { channel_id: '00112233445566778899aabbccddeeff', channel_type: 2 },
            { message_id: '829' },
            { data: { dsh_card_nonce: binding.cardNonce === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32) } },
            { space_id: 'fixture-wrong-space' },
          ].map((patch, i) => ({ ...valid, event_id: String(9301 + i), event_data: {
            ...valid.event_data, inputs: { note: 'REJECTED-ANSWER', amount: '999' }, ...patch,
          } }))
          return json({ status: 1, results: bad.filter(event => BigInt(event.event_id) > cursor) })
        }
        if (!released) {
          const saved = snapshot(state)
          if (step || acks || saved.jobs.length !== 1 || saved.cards[0].claimed !== 0) return fail('INVALID_CALLBACK_ACCEPTED')
          mark('INVALID_CALLBACKS_IGNORED')
          released = true
          mark('DUPLICATES_RELEASED')
          // Both replay of the same event and a different event for an already-claimed card.
          return json({ status: 1, results: [valid, structuredClone(valid), { ...valid, event_id: '9307' }] })
        }
        return json({ status: 1, results: [] })
      }
      if (/^\/api\/v1\/bot\/events\/\d+\/ack$/.test(path)) {
        if (!resumed || !released || method !== 'POST') return fail('ACK_PHASE')
        if (path === '/api/v1/bot/events/9307/ack') {
          const duplicate = snapshot(state).jobs.find(row => row.message_id === 'card_action:9307')
          if (++terminalAcks !== 1 || duplicate?.state !== 'ignored' || duplicate.session_id !== null) return fail('TERMINAL_ACK_WITHOUT_IGNORED_RECEIPT')
          mark('TERMINAL_ACK')
          return json({ status: 200 })
        }
        if (path !== '/api/v1/bot/events/' + validId + '/ack' || ++acks !== 1) return fail('ACK_COUNT_OR_ID:' + path)
        mark('CALLBACK_ACK')
        return json({ status: 200 })
      }
      if (path === '/api/v1/bot/message/edit') {
        const frame = body?.content_edit && JSON.parse(body.content_edit)
        if (!resumed || !released || method !== 'POST' || body.message_id !== cardId || body.channel_id !== owner || body.channel_type !== 1
          || !frame || frame.card?.actions?.length
          || !/答案已收到，(?:已加入原会话的处理流程。请查看后续结果。|原会话的处理结果已发送。)/.test(frame.plain ?? '')) return fail('FEEDBACK')
        feedback = true
        mark('FEEDBACK_OK')
        return json({})
      }
      if (path === '/api/v1/bot/upload/presigned') {
        if (!resumed || step !== 4 || method !== 'GET' || url.searchParams.get('filename') !== fileName
          || url.searchParams.get('fileSize') !== String(Buffer.byteLength(fileText))) return fail('PRESIGN')
        return json({ method: 'PUT', uploadUrl: 'https://storage-fixture.invalid/deferred.txt?signature=fixture',
          downloadUrl: 'https://files-fixture.invalid/deferred.txt', contentType: 'text/plain' })
      }
      if (path === '/api/v1/bot/sendMessage') {
        const payload = body?.payload
        if (method !== 'POST' || body.channel_id !== owner || body.channel_type !== 1 || !payload || payload.reply || payload.mention) return fail('SEND_SCOPE')
        if (!resumed && payload.type === 17) {
          if (binding || step !== 1 || payload.profile !== 'octo/v2' || payload.card_version !== '1.5'
            || payload.card?.actions?.length !== 1 || payload.card.actions[0].id !== 'submit'
            || !/^[a-f0-9]{32}$/.test(payload.card.actions[0].data?.dsh_card_nonce ?? '')
            || payload.card.body.filter(node => node.type.startsWith('Input.')).map(node => node.id).join(',') !== 'note,amount') return fail('PUBLISH_CARD')
          binding = { cardNonce: payload.card.actions[0].data.dsh_card_nonce }
          mark('PUBLISH_CARD')
          return json({ message_id: cardId })
        }
        if (!resumed && payload.type === 1) {
          if (sent || step !== 2 || !receipt || payload.content !== shortReply(receipt)) return fail('FIRST_FINAL')
          sent = true
          mark('FIRST_SENT')
          return json({ message_id: '821' })
        }
        if (resumed && payload.type === 8) {
          if (!uploaded || fileSent || step !== 4 || payload.name !== fileName || payload.size !== Buffer.byteLength(fileText)
            || payload.url !== 'https://files-fixture.invalid/deferred.txt') return fail('FILE')
          fileSent = true
          mark('FILE_OK')
          return json({ message_id: '822' })
        }
        if (resumed && payload.type === 1) {
          if (sent || !fileSent || !feedback || step !== 4 || payload.content !== caption) return fail('FULL_CAPTION')
          sent = true
          mark('FULL_CAPTION_OK')
          return json({ message_id: '823' })
        }
        return fail('UNEXPECTED_DELIVERY')
      }
      return fail('API_PATH:' + method + ':' + path)
    }
    if (url.hostname === 'storage-fixture.invalid') {
      if (!resumed || uploaded || step !== 4 || method !== 'PUT' || path !== '/deferred.txt'
        || Buffer.from(init.body).toString() !== fileText) return fail('UPLOAD')
      uploaded = true
      mark('UPLOAD_OK')
      return new Response(null, { status: 200 })
    }
    if (url.hostname === 'model-fixture.invalid' && path.endsWith('/messages')) {
      const body = JSON.parse(init.body), history = JSON.stringify(body.messages), tail = JSON.stringify(body.messages.at(-1))
      if (tail.includes('Generate the session title from this JSON array of human messages:')) return stream(body, 'Deferred fixture title')
      const names = (body.tools ?? []).map(tool => tool.name)
      if (!['octo_form_publish', 'octo_form_manage', 'write', 'present'].every(name => names.includes(name))) return fail('NATIVE_TOOLS_MISSING')
      if (!history.includes(prompt) || history.includes('REJECTED-ANSWER')) return fail('ORIGINAL_TASK_OR_INVALID_ANSWER')
      if (resumed && (!released || !history.includes('later answer') || !history.includes(shortReply(readJson(join(home, 'deferred-publish-receipt.json')))))) return fail('RESUMED_HISTORY')
      if (resumed && step === 0) {
        const running = snapshot(state).jobs.find(row => row.message_id === 'card_action:' + validId)
        if (running?.state !== 'running' || running.session_id !== binding.deferred.sessionId) return fail('RUNNING_SESSION')
        save(join(home, 'deferred-running-job.json'), running)
      }
      if (step > operations.length) return fail('EXTRA_MODEL_RUN')
      if (step) {
        const id = 'toolu_deferred_' + phase.phase + '_' + (step - 1)
        const parts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        const call = parts.find(part => part.type === 'tool_use' && part.id === id)
        const result = parts.find(part => part.type === 'tool_result' && part.tool_use_id === id)
        if (call?.name !== operations[step - 1][0] || !result || result.is_error) return fail('TOOL_RESULT:' + operations[step - 1][0])
        assert.deepEqual(call.input, operations[step - 1][1])
        const text = typeof result.content === 'string' ? result.content : (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
        if (!resumed) {
          try { receipt = JSON.parse(text) } catch { return fail('PUBLISH_RESULT_JSON') }
          if (receipt.message_id !== cardId || receipt.state !== 'pending' || !Number.isFinite(Date.parse(receipt.expires_at))) return fail('PUBLISH_RECEIPT')
          save(join(home, 'deferred-publish-receipt.json'), receipt)
          mark('PUBLISH_RETURNED')
        } else if (step === 1) {
          let status; try { status = JSON.parse(text) } catch { return fail('MANAGE_JSON') }
          if (status.message_id !== cardId || status.state !== 'submitted' || status.cancelled !== false
            || text.includes('later answer') || Date.parse(status.expires_at) !== binding.expiresAt) return fail('MANAGE_STATUS')
          mark('MANAGE_STATUS_OK')
        } else mark(step === 2 ? 'WRITE_OK' : 'PRESENT_OK')
      }
      if (step < operations.length) {
        const [name, args] = operations[step++]
        return stream(body, args, name)
      }
      step++
      return stream(body, resumed ? caption : shortReply(receipt))
    }
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init)
    return fail('EXTERNAL_REQUEST:' + url.hostname)
  }
}
