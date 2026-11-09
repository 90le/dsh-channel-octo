// Opt-in native DSH processes; only synthetic data under a fresh temporary home.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { wirePeer } from './wukong-fixture.mjs'

const owner = 'fixture-user', bot = 'fixture-bot', space = 'fixture-space'
// Decimal int64 IDs deliberately exceed Number.MAX_SAFE_INTEGER. Sequences do not.
const oldEventId = '910000000000000101', typedId = '910000000000000102', eventId = '910000000000000103'
const messageId = '920000000000000001', oldHistoryId = '920000000000000002', oldMessageId = '920000000000000003'
const phaseName = 'event-recovery-fixture-phase.json'
const fileName = 'event-recovery-tool-fixture.txt'
const fileText = 'CORRECT: written by native DSH from current messages/sync after offline discovery.\n中文文件字节 ✅\n'
const prompt = 'CORRECT-EVENT-RECOVERY: 请按当前正文写入 event-recovery-tool-fixture.txt，展示文件，并完整说明恢复过程。'
const stale = 'STALE-EVENT-RECOVERY: 过期事件正文，绝不能交给模型或执行。'
const oldText = 'OLD-BACKLOG-EVENT-RECOVERY: 启用之前的旧任务，绝不能执行。'
const caption = 'EVENT-RECOVERY-FINAL\n\n文件：<event-recovery-tool-fixture.txt>\n\n**完整说明**\n\n'
  + '- 离线新私聊仅通过 Bot/events 发现，正文来自当前 messages/sync。\n'
  + '- 已由原生 DSH 的 write 写入文件，再由 present 展示并交付。\n\n'
  + '保留中文、Markdown、完整段落和表情。CORRECT ✅\n\nEVENT-RECOVERY-CAPTION-END'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function isolatedHome(home, state) {
  assert.equal(dirname(realpathSync(home)), realpathSync(tmpdir()), 'home must be a direct temporary child')
  assert.match(basename(home), /^dsh-octo-smoke-/)
  assert.equal(resolve(state), join(realpathSync(home), 'octo-state'))
}

function snapshot(state) {
  const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
  try {
    db.exec('BEGIN')
    return JSON.parse(JSON.stringify({
      recovery: db.prepare('SELECT * FROM event_recovery WHERE id=1').get(),
      jobs: db.prepare('SELECT message_id,event_id,sender,channel_type,channel_id,message_seq,session_id,state,result_id,input,reply,issue,metadata FROM jobs ORDER BY seq').all(),
      routes: db.prepare('SELECT * FROM inbox_routes ORDER BY channel_type,channel_id').all(),
      discoveries: db.prepare('SELECT * FROM inbox_event_discoveries ORDER BY event_id').all(),
      acks: db.prepare('SELECT event_id,message_id,acked FROM message_event_acks ORDER BY event_id').all(),
      staged: db.prepare('SELECT * FROM inbox_staged ORDER BY message_id').all(),
      seen: db.prepare('SELECT * FROM inbox_seen ORDER BY message_id').all(),
      cardAcks: db.prepare('SELECT * FROM pending_card_acks').all(),
    }))
  } finally { db.close() }
}

const nativeEvents = output => [...output.matchAll(/FIXTURE_EVENT_NATIVE=(\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]))
const marker = (output, name) => output.includes('FIXTURE_EVENT_' + name)
function clean(output) {
  assert.ok(!marker(output, 'FAIL='), output.match(/FIXTURE_EVENT_FAIL=[^\r\n]+/g)?.join('; '))
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  assert.ok(child.kill(), 'failed to stop isolated DSH child')
  await Promise.race([closed, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('DSH child did not close') })])
}

export async function assertEventRecoverySmoke({ home, state, child, output, restart }) {
  isolatedHome(home, state)
  const logs = process.env.DSH_OCTO_SMOKE_LOG_DIR ? resolve(process.env.DSH_OCTO_SMOKE_LOG_DIR)
    : mkdtempSync(join(realpathSync(tmpdir()), 'dsh-octo-event-evidence-'))
  const outside = relative(home, logs)
  assert.ok(isAbsolute(outside) || outside === '..' || outside.startsWith('..\\') || outside.startsWith('../'), 'logs must survive home cleanup')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  console.log('EVENT_RECOVERY_LOG_DIR=' + logs)
  const runs = [{ child, output }]
  const phaseFile = join(home, phaseName), patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
  const patchHash = hash(patch), accountHash = hash(join(state, 'accounts.json'))
  const waitFor = async (run, label, check, timeout = 70_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      clean(run.output())
      assert.ok(run.child.exitCode === null && run.child.signalCode === null, label + ': native child exited')
      let current
      try { current = snapshot(state) } catch (error) {
        if (!/unable to open|no such table|locked|busy/i.test(error.message)) throw error
      }
      if (current && check(current, run.output())) return current
      await delay(100)
    }
    throw new Error(label + ': timed out; inspect private process logs and SQLite snapshot')
  }
  const launchPhase = phase => {
    save(phaseFile, phase)
    save(join(logs, phase.phase + '-phase.json'), phase)
    const next = restart()
    let text = ''
    for (const stream of [next.stdout, next.stderr]) stream.on('data', chunk => { text += chunk })
    assert.ok(runs.every(run => run.child.pid !== next.pid), 'restart must create a new OS process')
    const run = { child: next, output: () => text }
    runs.push(run)
    console.log('EVENT_RECOVERY_RESTART=' + JSON.stringify({ phase: phase.phase, home, pid: next.pid }))
    return run
  }
  let passed = false
  try {
    let first = await waitFor(runs[0], 'bootstrap ready with WS online', (s, text) => s.recovery.ready === 1
      && ['WS_ONLINE', 'BOOTSTRAP_QUEUE', 'BOOTSTRAP_REVISIT'].every(name => marker(text, name)))
    await delay(1200)
    await stop(child)
    first = snapshot(state)
    clean(output())
    assert.equal(first.recovery.ready, 1)
    assert.equal(first.recovery.failed, 0)
    assert.equal(first.recovery.baseline, typedId)
    for (const key of ['jobs', 'routes', 'discoveries', 'acks', 'staged', 'seen', 'cardAcks']) assert.deepEqual(first[key], [], key + ' before offline message')
    assert.deepEqual(nativeEvents(output()), [])
    assert.ok(!existsSync(join(home, fileName)))
    assert.ok(!marker(output(), 'WS_DUPLICATE_SENT'))
    save(join(logs, 'first-ready-empty.json'), first)
    console.log('PASS: first DSH process WS online, old ordinary/typed queue scanned, ready=1; zero jobs, routes, ACKs and native turns.')

    // The only new message is published while the first OS process is gone.
    // Unix seconds must be strictly later than SQLite's millisecond boundary.
    await delay(Math.max(0, Math.floor(first.recovery.started_at / 1000) * 1000 + 1000 - Date.now()))
    const timestamp = Math.floor(Date.now() / 1000)
    assert.ok(timestamp > first.recovery.started_at / 1000)
    const phase = { phase: 'recover', home: realpathSync(home), firstPid: child.pid,
      startedAt: first.recovery.started_at, timestamp }
    const second = launchPhase(phase)
    await waitFor(second, 'current history and one native file delivery', (s, text) => s.jobs.length === 1 && s.jobs[0].state === 'sent'
      && s.routes.length === 1 && s.routes[0].blocked === 0 && s.routes[0].failed === 0
      && ['WS_ONLINE', 'EVENT_ONLY_DISCOVERY', 'DURABLE_ACK', 'HISTORY_CURRENT', 'WRITE_OK', 'PRESENT_OK',
        'UPLOAD_OK', 'FILE_OK', 'FULL_CAPTION_OK'].every(name => marker(text, name))
      && nativeEvents(text).some(event => event.type === 'turn/end'))
    const onlineSent = snapshot(state)
    assert.equal(onlineSent.routes[0].blocked, 0)
    save(join(logs, 'second-online-sent.json'), onlineSent)
    await stop(second.child)
    const after = snapshot(state)
    clean(second.output())
    assert.equal(after.recovery.ready, 1)
    assert.equal(after.recovery.failed, 0)
    assert.equal(after.recovery.started_at, first.recovery.started_at)
    assert.equal(after.recovery.baseline, first.recovery.baseline)
    assert.equal(after.jobs.length, 1)
    const job = after.jobs[0]
    assert.equal(job.message_id, messageId)
    assert.equal(job.event_id, 'history:' + messageId, 'the task must originate in current history, never the event body')
    assert.equal(job.sender, owner)
    assert.equal(job.channel_type, 1)
    assert.equal(job.channel_id, owner)
    assert.equal(job.message_seq, 10)
    assert.equal(job.state, 'sent')
    assert.equal(job.result_id, '842')
    assert.equal(job.input, '')
    assert.equal(job.reply, null)
    assert.equal(job.issue, null)
    assert.match(job.session_id, /^session-[a-f0-9-]{36}$/)
    assert.equal(after.routes.length, 1)
    assert.equal(after.routes[0].channel_id, owner)
    assert.equal(after.routes[0].floor_seq, 9)
    assert.equal(after.routes[0].checkpoint, 11)
    assert.equal(after.routes[0].since_ms, first.recovery.started_at)
    // Linux graceful shutdown deliberately blocks known routes for the next
    // reconnect. The online snapshot above must have been fully released.
    assert.ok([0, 1].includes(after.routes[0].blocked))
    assert.equal(after.routes[0].failed, 0)
    assert.deepEqual(after.discoveries, [{ event_id: eventId, message_id: messageId, channel_type: 1, channel_id: owner, message_seq: 10 }])
    assert.deepEqual(after.acks, [{ event_id: eventId, message_id: messageId, acked: 1 }])
    assert.deepEqual(after.staged, [])
    assert.deepEqual(after.cardAcks, [])
    assert.ok(after.seen.some(row => row.message_id === oldHistoryId), 'backdated history must be durably suppressed')
    const turns = nativeEvents(second.output())
    assert.deepEqual(turns.map(event => event.type), ['turn/start', 'turn/end'])
    assert.ok(turns.every(event => event.sessionId === job.session_id))
    assert.equal((second.output().match(/FIXTURE_EVENT_NATIVE_TOOL_OK\b/g) ?? []).length, 2)
    assert.ok(!marker(second.output(), 'WS_DUPLICATE_SENT'), 'recovery cannot be triggered by WS')
    const running = readJson(join(home, 'event-recovery-running-job.json'))
    assert.equal(running.state, 'running')
    assert.equal(running.session_id, job.session_id)
    assert.equal(running.input, prompt)
    assert.equal(readFileSync(join(home, fileName), 'utf8'), fileText)
    save(join(logs, 'second-sent.json'), after)
    save(join(logs, 'running-job.json'), running)
    console.log('PASS: same home restarted; Bot/events alone discovered unknown DM; history: receipt used CORRECT current body and suppressed old history.')
    console.log('PASS: one native turn, real write/present results, exact uploaded file bytes, complete Markdown caption/final, original event durable ACK.')

    // Reset the consumer's volatile cursor by a real restart, not by tampering
    // with worker internals or SQLite. The same event is actually consumed again.
    const third = launchPhase({ ...phase, phase: 'replay', secondPid: second.child.pid, sessionId: job.session_id })
    await waitFor(third, 'replayed event and duplicate WS packet acknowledged', (_s, text) =>
      ['WS_ONLINE', 'REPLAY_EVENT', 'REPLAY_ACK', 'WS_DUPLICATE_SENT', 'WS_DUPLICATE_ACK'].every(name => marker(text, name)))
    await delay(4500) // Includes an inbox sweep and several event polls.
    await stop(third.child)
    const replay = snapshot(state)
    clean(third.output())
    assert.deepEqual(nativeEvents(third.output()), [], 'replay must not start a native turn')
    assert.deepEqual(replay.jobs, after.jobs)
    assert.deepEqual(replay.discoveries, after.discoveries)
    assert.deepEqual(replay.acks, after.acks)
    assert.deepEqual(replay.recovery, after.recovery)
    assert.deepEqual(replay.staged, [])
    assert.equal(replay.routes.length, 1)
    assert.equal(replay.routes[0].since_ms, phase.startedAt)
    assert.equal(replay.routes[0].checkpoint, 11)
    assert.equal(replay.routes[0].failed, 0)
    assert.equal(readFileSync(join(home, fileName), 'utf8'), fileText)
    assert.equal(hash(patch), patchHash, 'the installed profile cannot change between processes')
    assert.equal(hash(join(state, 'accounts.json')), accountHash)
    save(join(logs, 'third-replayed.json'), replay)
    for (const name of ['event-recovery-ack-before.json', 'event-recovery-replay-ack-before.json']) save(join(logs, name), readJson(join(home, name)))
    writeFileSync(join(logs, fileName), readFileSync(join(home, fileName)), { mode: 0o600 })
    save(join(logs, 'result.json'), { passed: true, home, pids: runs.map(run => run.child.pid),
      startedAt: phase.startedAt, timestamp, eventId, messageId, sessionId: job.session_id,
      nativeTurns: 1, nativeToolResults: 2, sentJobs: 1, recoveredBody: prompt, fullCaption: caption,
      originalEventAcked: true, externalTypedAcked: false, oldBacklogExecuted: false,
      eventReplay: true, wsDuplicateAcked: true, patchHash, fileSha256: hash(join(home, fileName)) })
    passed = true
    console.log('PASS: third real process consumed the original event and WS duplicate; no extra job/turn/tool/delivery; external typed event never ACKed.')
  } catch (error) {
    save(join(logs, 'result.json'), { passed: false, error: error.stack, home, pids: runs.map(run => run.child.pid) })
    throw error
  } finally {
    try { for (const run of runs) await stop(run.child) } finally {
      for (const [i, run] of runs.entries()) writeFileSync(join(logs, 'process-' + (i + 1) + '.log'),
        run.output().replace(/https?:\/\/\S+/g, '[fixture-url]'), { mode: 0o600 })
      try { save(join(logs, 'last-snapshot.json'), snapshot(state)) } catch {}
      for (const name of [phaseName, 'event-recovery-running-job.json', 'event-recovery-ack-before.json', 'event-recovery-replay-ack-before.json']) {
        if (existsSync(join(home, name))) save(join(logs, name), readJson(join(home, name)))
      }
      console.log((passed ? 'PASS' : 'FAIL') + ': event recovery evidence saved at ' + logs)
    }
  }
}

export async function installEventRecoveryFixture() {
  const home = realpathSync(process.env.DSH_HOME), state = process.env.DSH_OCTO_FIXTURE_STATE
  isolatedHome(home, state)
  const phase = existsSync(join(home, phaseName)) ? readJson(join(home, phaseName)) : { phase: 'bootstrap' }
  assert.ok(['bootstrap', 'recover', 'replay'].includes(phase.phase))
  const bootstrap = phase.phase === 'bootstrap', replay = phase.phase === 'replay'
  const mark = name => console.log('FIXTURE_EVENT_' + name)
  const fail = reason => { mark('FAIL=' + reason); return new Response(null, { status: 400 }) }
  if (!bootstrap) {
    assert.equal(phase.home, home)
    assert.notEqual(phase.firstPid, process.pid)
    assert.notEqual(phase.secondPid, process.pid)
    const restored = snapshot(state)
    assert.equal(restored.recovery.ready, 1)
    assert.equal(restored.recovery.started_at, phase.startedAt)
    assert.ok(Number.isSafeInteger(phase.timestamp) && phase.timestamp > phase.startedAt / 1000 && phase.timestamp <= Date.now() / 1000)
    assert.equal(restored.jobs.length, replay ? 1 : 0)
    assert.equal(restored.routes.length, replay ? 1 : 0)
    if (replay) {
      assert.equal(restored.jobs[0].state, 'sent')
      assert.equal(restored.jobs[0].session_id, phase.sessionId)
      assert.deepEqual(restored.acks, [{ event_id: eventId, message_id: messageId, acked: 1 }])
    }
  }
  const oldTimestamp = Math.floor((phase.startedAt ?? Date.now()) / 1000) - 3600
  const message = (id, seq, text, timestamp, sender = owner) => ({ message_id: id, message_seq: seq,
    from_uid: sender, channel_type: 1, channel_id: sender, timestamp, payload: { type: 1, content: text } })
  const old = { event_id: oldEventId, message: message(oldMessageId, 1, oldText, oldTimestamp, 'fixture-old-user') }
  const typed = { event_id: typedId, event_type: 'external_task', event_data: { marker: 'EXTERNAL-TYPED-DO-NOT-ACK' } }
  const valid = !bootstrap && { event_id: eventId, message: message(messageId, 10, stale, phase.timestamp) }
  // Official ordinary DM events omit both channel fields (history does not).
  delete old.message.channel_type; delete old.message.channel_id
  if (valid) { delete valid.message.channel_type; delete valid.message.channel_id }
  const current = !bootstrap && message(messageId, 10, prompt, phase.timestamp)
  const backdated = !bootstrap && message(oldHistoryId, 11, oldText, oldTimestamp)
  for (const id of [oldEventId, typedId, eventId, messageId, oldHistoryId, oldMessageId]) {
    assert.ok(/^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n)
  }
  let step = 0, eventReleased = false, acked = false, online = false, duplicateSent = false, duplicateAcked = false
  let uploaded = false, fileSent = false, captionSent = false, initialPage = false, revisit = false, historyRead = false
  const peer = await wirePeer()
  setInterval(() => {
    if (!online && peer.send) { online = true; mark('WS_ONLINE') }
    // No WS message of any kind is sent in bootstrap or recovery. The replay
    // process may send only the already-completed message, after event replay.
    if (replay && peer.send && acked && !duplicateSent) {
      peer.send({ messageId, sender: owner, channelId: owner, channelType: 1, seq: 10, payload: { type: 1, content: stale } })
      duplicateSent = true
      mark('WS_DUPLICATE_SENT')
    }
    if (duplicateSent && !duplicateAcked && peer.acked.includes(messageId)) { duplicateAcked = true; mark('WS_DUPLICATE_ACK') }
  }, 50).unref()
  const stream = (body, content, tool) => {
    const frames = [
      { type: 'message_start', message: { id: 'event-recovery-fixture', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool
        ? { type: 'tool_use', id: 'toolu_event_' + (step - 1), name: tool, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(content) } : { type: 'text_delta', text: content } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
      { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const operations = [['write', { file_path: fileName, content: fileText }], ['present', { files: [{ path: fileName }] }]]
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
      if (path === '/api/v1/bot/events') {
        if (method !== 'POST' || body?.limit !== 20) return fail('EVENT_REQUEST')
        // The official request contains a raw JSON int64 number: parsing it as a
        // JS Number would round the cursor and invalidate the replay evidence.
        const raw = String(init.body).match(/"event_id"\s*:\s*(\d+)\s*[,}]/)?.[1]
        if (!raw) return fail('EVENT_CURSOR')
        const cursor = BigInt(raw), saved = snapshot(state)
        if (oldTimestamp * 1000 >= saved.recovery.started_at) return fail('OLD_TIMESTAMP')
        if (bootstrap && !initialPage) {
          if (cursor !== 0n || saved.recovery.ready !== 0) return fail('BOOTSTRAP_START')
          initialPage = true
          mark('BOOTSTRAP_QUEUE')
        }
        if (bootstrap && saved.recovery.ready === 1 && cursor === 0n && !revisit) {
          revisit = true
          mark('BOOTSTRAP_REVISIT')
        }
        if (!bootstrap && !eventReleased) {
          if (saved.recovery.ready !== 1 || saved.jobs.length !== (replay ? 1 : 0)
            || saved.routes.length !== (replay ? 1 : 0) || peer.acked.length || duplicateSent) return fail('DISCOVERY_NOT_EVENT_ONLY')
          eventReleased = true
          mark(replay ? 'REPLAY_EVENT' : 'EVENT_ONLY_DISCOVERY')
        }
        await delay(80)
        // Successful ACK removes this event from the synthetic server queue.
        // The replay process explicitly re-publishes it on its first scan.
        return json({ status: 1, results: [old, typed, ...(bootstrap || acked ? [] : [valid])].filter(event => BigInt(event.event_id) > cursor) })
      }
      if (/^\/api\/v1\/bot\/events\/\d+\/ack$/.test(path)) {
        if (bootstrap || method !== 'POST' || path !== '/api/v1/bot/events/' + eventId + '/ack') return fail('OLD_OR_EXTERNAL_EVENT_ACK:' + path)
        if (!eventReleased || acked) return fail('UNEXPECTED_ACK')
        const saved = snapshot(state)
        if (saved.acks.length !== 1 || saved.acks[0].event_id !== eventId || saved.acks[0].message_id !== messageId
          || saved.acks[0].acked !== (replay ? 1 : 0) || saved.discoveries.length !== 1
          || saved.discoveries[0].event_id !== eventId || saved.routes.length !== 1
          || saved.routes[0].since_ms !== phase.startedAt || !replay && saved.jobs.length) return fail('ACK_WITHOUT_DURABLE_DISCOVERY')
        save(join(home, replay ? 'event-recovery-replay-ack-before.json' : 'event-recovery-ack-before.json'), saved)
        acked = true
        mark(replay ? 'REPLAY_ACK' : 'DURABLE_ACK')
        return json({ status: 200 })
      }
      if (path === '/api/v1/bot/messages/sync') {
        if (bootstrap || method !== 'POST' || body?.channel_id !== owner || body.channel_type !== 1 || !eventReleased) return fail('SYNC_SCOPE')
        const saved = snapshot(state)
        if (saved.routes.length !== 1 || saved.routes[0].since_ms !== phase.startedAt) return fail('SYNC_BEFORE_ROUTE')
        if (body.limit === 1 && body.pull_mode === 0 && body.start_message_seq === 0 && body.end_message_seq === 0) {
          return json({ messages: [backdated] })
        }
        if (body.limit !== 100 || body.pull_mode !== 1 || body.start_message_seq !== 10 || body.end_message_seq !== 12) return fail('HISTORY_RANGE')
        historyRead = true
        mark('HISTORY_CURRENT')
        return json({ messages: [current, backdated] })
      }
      if (path === '/api/v1/bot/upload/presigned') {
        if (bootstrap || replay || step !== 3 || method !== 'GET' || url.searchParams.get('filename') !== fileName
          || url.searchParams.get('fileSize') !== String(Buffer.byteLength(fileText))) return fail('PRESIGN')
        return json({ method: 'PUT', uploadUrl: 'https://storage-fixture.invalid/event.txt?signature=fixture',
          downloadUrl: 'https://files-fixture.invalid/event.txt', contentType: 'text/plain' })
      }
      if (path === '/api/v1/bot/sendMessage') {
        const payload = body?.payload
        if (bootstrap || replay || method !== 'POST' || body.channel_id !== owner || body.channel_type !== 1
          || step !== 3 || !payload || payload.reply || payload.mention) return fail('SEND_SCOPE')
        if (payload.type === 8) {
          if (!uploaded || fileSent || payload.name !== fileName || payload.size !== Buffer.byteLength(fileText)
            || payload.url !== 'https://files-fixture.invalid/event.txt') return fail('FILE')
          fileSent = true
          mark('FILE_OK')
          return json({ message_id: '841' })
        }
        if (payload.type === 1) {
          if (!fileSent || captionSent || payload.content !== caption) return fail('FULL_CAPTION')
          captionSent = true
          mark('FULL_CAPTION_OK')
          return json({ message_id: '842' })
        }
        return fail('UNEXPECTED_DELIVERY')
      }
      return fail('API_PATH:' + method + ':' + path)
    }
    if (url.hostname === 'storage-fixture.invalid') {
      if (bootstrap || replay || uploaded || step !== 3 || method !== 'PUT' || path !== '/event.txt'
        || !Buffer.from(init.body).equals(Buffer.from(fileText))) return fail('UPLOAD_BYTES')
      uploaded = true
      mark('UPLOAD_OK')
      return new Response(null, { status: 200 })
    }
    if (url.hostname === 'model-fixture.invalid' && path.endsWith('/messages')) {
      const body = JSON.parse(init.body), history = JSON.stringify(body.messages), tail = JSON.stringify(body.messages.at(-1))
      if (bootstrap || replay) return fail('MODEL_DURING_' + phase.phase.toUpperCase())
      if (history.includes('STALE-EVENT-RECOVERY') || history.includes('OLD-BACKLOG-EVENT-RECOVERY')) return fail('STALE_OR_OLD_MODEL_BODY')
      if (tail.includes('Generate the session title from this JSON array of human messages:')) return stream(body, 'Event recovery fixture title')
      if (!eventReleased || !historyRead || duplicateSent || !history.includes(prompt)) return fail('CURRENT_MODEL_BODY')
      if (!operations.every(([name]) => body.tools?.some(tool => tool.name === name))) return fail('NATIVE_TOOLS_MISSING')
      if (step > operations.length) return fail('EXTRA_MODEL_RUN')
      if (step === 0) {
        const saved = snapshot(state), job = saved.jobs[0]
        if (saved.jobs.length !== 1 || job.message_id !== messageId || job.event_id !== 'history:' + messageId
          || job.state !== 'running' || job.input !== prompt) return fail('RUNNING_HISTORY_JOB')
        save(join(home, 'event-recovery-running-job.json'), job)
      } else {
        const id = 'toolu_event_' + (step - 1)
        const parts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        const call = parts.find(part => part.type === 'tool_use' && part.id === id)
        const result = parts.find(part => part.type === 'tool_result' && part.tool_use_id === id)
        if (call?.name !== operations[step - 1][0] || !result || result.is_error) return fail('NATIVE_TOOL_RESULT:' + operations[step - 1][0])
        assert.deepEqual(call.input, operations[step - 1][1])
        if (!existsSync(join(home, fileName)) || !readFileSync(join(home, fileName)).equals(Buffer.from(fileText))) return fail('NATIVE_WRITE_BYTES')
        mark(step === 1 ? 'WRITE_OK' : 'PRESENT_OK')
      }
      if (step < operations.length) {
        const [name, args] = operations[step++]
        return stream(body, args, name)
      }
      step++
      return stream(body, caption)
    }
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init)
    return fail('EXTERNAL_REQUEST:' + url.hostname)
  }
}
