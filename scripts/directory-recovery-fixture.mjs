// Three native DSH processes, one fresh home, no event or WebSocket messages.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { wirePeer } from './wukong-fixture.mjs'

const owner = 'fixture-user', bot = 'fixture-bot', space = 'fixture-space'
const group = '00112233445566778899aabbccddeeff', topic = '123456789012345'
// The official listing contains active topics only. A full first page has no
// messages; the one actionable topic is reachable only on the second page.
const emptyTopics = Array.from({ length: 100 }, (_, i) => String(223456789012345n + BigInt(i)))
const phaseName = 'directory-recovery-phase.json', metricsName = 'directory-recovery-metrics.json'
const routes = ['group', 'topic'].map((name, i) => ({
  name, channel_type: i ? 5 : 2, channel_id: i ? group + '____' + topic : group,
  messageId: '93000000000000000' + (i + 1), oldId: '93000000000000001' + (i + 1),
  backdatedId: '93000000000000002' + (i + 1), resultId: String(852 + i * 10),
  fileName: 'directory-' + name + '-fixture.txt',
  fileText: 'Native DSH directory recovery: ' + name + '\n独立路由、精确文件字节 ✅\n',
  prompt: 'DIRECTORY-' + name.toUpperCase() + '-CURRENT: 请写入并发送 directory-' + name + '-fixture.txt，展示文件并完整说明恢复结果。',
  caption: 'DIRECTORY-' + name.toUpperCase() + '-FINAL\n\n文件：<directory-' + name + '-fixture.txt>\n\n**完整说明**\n\n'
    + '- 新增无 @ 会话通过群与子区目录发现，正文来自当前历史。\n'
    + '- 原生 DSH write 写入独立文件，present 展示并完整交付。\n\n'
    + '保留中文、Markdown、完整段落和表情 ✅\n\nDIRECTORY-' + name.toUpperCase() + '-CAPTION-END',
}))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const nativeEvents = output => [...output.matchAll(/FIXTURE_DIRECTORY_NATIVE=(\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]))
const marker = (output, name) => output.includes('FIXTURE_DIRECTORY_' + name)
function isolatedHome(home, state) {
  assert.equal(dirname(realpathSync(home)), realpathSync(tmpdir()))
  assert.match(basename(home), /^dsh-octo-smoke-/)
  assert.equal(resolve(state), join(realpathSync(home), 'octo-state'))
}
function snapshot(state) {
  const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
  try {
    db.exec('BEGIN')
    return JSON.parse(JSON.stringify({
      recovery: db.prepare('SELECT * FROM directory_recovery WHERE id=1').get(),
      groups: db.prepare('SELECT * FROM directory_groups ORDER BY group_no').all(),
      jobs: db.prepare('SELECT message_id,event_id,sender,ambient,channel_type,channel_id,message_seq,session_id,state,result_id,input,reply,issue,metadata FROM jobs ORDER BY seq').all(),
      routes: db.prepare('SELECT * FROM inbox_routes ORDER BY channel_type,channel_id').all(),
      discoveries: db.prepare('SELECT * FROM inbox_event_discoveries ORDER BY event_id').all(),
      acks: db.prepare('SELECT * FROM message_event_acks ORDER BY event_id').all(),
      staged: db.prepare('SELECT * FROM inbox_staged ORDER BY message_id').all(),
      seen: db.prepare('SELECT * FROM inbox_seen ORDER BY message_id').all(),
      cardAcks: db.prepare('SELECT * FROM pending_card_acks').all(),
    }))
  } finally { db.close() }
}
function clean(output) {
  assert.ok(!marker(output, 'FAIL='), output.match(/FIXTURE_DIRECTORY_FAIL=[^\r\n]+/g)?.join('; '))
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  assert.ok(child.kill(), 'failed to stop isolated DSH child')
  await Promise.race([closed, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('DSH child did not close') })])
}

export async function assertDirectoryRecoverySmoke({ home, state, packagePath, child, output, restart }) {
  isolatedHome(home, state)
  const logs = process.env.DSH_OCTO_SMOKE_LOG_DIR ? resolve(process.env.DSH_OCTO_SMOKE_LOG_DIR)
    : mkdtempSync(join(realpathSync(tmpdir()), 'dsh-octo-directory-evidence-'))
  const outside = relative(home, logs)
  assert.ok(isAbsolute(outside) || outside === '..' || outside.startsWith('..\\') || outside.startsWith('../'), 'logs must survive home cleanup')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  console.log('DIRECTORY_RECOVERY_LOG_DIR=' + logs)
  const runs = [{ child, output }], phaseFile = join(home, phaseName)
  const patch = join(home, 'profiles', 'web', 'cordis.patch.yml'), accounts = join(state, 'accounts.json')
  const patchHash = hash(patch), accountHash = hash(accounts), packageSha256 = hash(packagePath)
  const waitFor = async (run, label, check) => {
    // Directory discovery deliberately retains its ordinary 60s scan cadence.
    const deadline = Date.now() + 100_000
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
  const archive = index => {
    save(join(logs, 'process-' + index + '-metrics.json'), readJson(join(home, metricsName)))
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
    console.log('DIRECTORY_RECOVERY_RESTART=' + JSON.stringify({ phase: phase.phase, home, pid: next.pid }))
    return run
  }
  const noEvents = s => {
    for (const key of ['discoveries', 'acks', 'staged', 'cardAcks']) assert.deepEqual(s[key], [], key)
  }
  const healthyRoutes = (s, startedAt) => {
    assert.equal(s.recovery.ready, 1)
    assert.equal(s.recovery.failed, 0)
    assert.equal(s.recovery.started_at, startedAt)
    assert.equal(s.groups.length, 1)
    assert.equal(s.groups[0].group_no, group)
    assert.equal(s.groups[0].page, 2)
    assert.equal(s.groups[0].done, 1)
    assert.equal(s.groups[0].failed, 0)
    assert.equal(s.routes.length, 102, 'main route plus all 101 active topics')
    for (const r of routes) {
      const stored = s.routes.find(row => row.channel_id === r.channel_id)
      assert.equal(stored.channel_type, r.channel_type)
      assert.equal(stored.floor_seq, 0)
      assert.equal(stored.since_ms, startedAt)
      assert.equal(stored.directory_at, startedAt)
      assert.equal(stored.checkpoint, 11)
      assert.equal(stored.failed, 0)
      assert.ok([0, 1].includes(stored.blocked), 'graceful shutdown may block routes')
      for (const messageId of [r.oldId, r.backdatedId, r.messageId]) assert.ok(s.seen.some(row => row.message_id === messageId))
    }
    for (const short of emptyTopics) {
      const stored = s.routes.find(row => row.channel_id === group + '____' + short)
      assert.equal(stored.channel_type, 5)
      assert.equal(stored.floor_seq, 0)
      assert.equal(stored.checkpoint, 0)
      assert.equal(stored.since_ms, startedAt)
      assert.equal(stored.directory_at, startedAt)
      assert.equal(stored.failed, 0)
    }
    noEvents(s)
  }
  let passed = false
  try {
    await waitFor(runs[0], 'empty catalog activated and ready', (s, text) => s.recovery.started_at > 0 && s.recovery.ready === 1
      && ['WS_ONLINE', 'CATALOG_EMPTY', 'EVENTS_EMPTY'].every(name => marker(text, name)))
    await delay(1200)
    await stop(child)
    clean(output())
    const first = snapshot(state), initialMetrics = readJson(join(home, metricsName))
    assert.equal(first.recovery.failed, 0)
    assert.ok(first.recovery.started_at >= initialMetrics.installedAt, 'activation starts at the first actual native run')
    for (const key of ['groups', 'jobs', 'routes', 'seen']) assert.deepEqual(first[key], [])
    noEvents(first)
    assert.deepEqual(nativeEvents(output()), [])
    for (const r of routes) assert.ok(!existsSync(join(home, r.fileName)))
    archive(1)
    save(join(logs, 'first-ready-empty.json'), first)
    console.log('PASS: first native process activated an empty directory; WS online, empty events, zero jobs/routes/turns.')

    await delay(Math.max(0, Math.floor(first.recovery.started_at / 1000) * 1000 + 1000 - Date.now()))
    const timestamp = Math.floor(Date.now() / 1000)
    assert.ok(timestamp * 1000 > first.recovery.started_at)
    const phase = { phase: 'recover', home: realpathSync(home), firstPid: child.pid, startedAt: first.recovery.started_at, timestamp }
    const second = launchPhase(phase)
    await waitFor(second, 'two independent native history recoveries', (s, text) => s.jobs.length === 2
      && s.jobs.every(job => job.state === 'sent') && s.recovery.ready === 1 && s.recovery.failed === 0
      && s.routes.length === 102 && s.routes.every(route => route.blocked === 0 && route.failed === 0)
      && ['TOPIC_PAGE_1', 'TOPIC_PAGE_2', ...routes.flatMap(r => ['HISTORY_', 'WRITE_', 'PRESENT_', 'UPLOAD_', 'FILE_', 'FULL_CAPTION_'].map(prefix => prefix + r.name))]
        .every(name => marker(text, name)) && nativeEvents(text).filter(event => event.type === 'turn/end').length === 2)
    save(join(logs, 'second-online-sent.json'), snapshot(state))
    await stop(second.child)
    clean(second.output())
    const after = snapshot(state)
    healthyRoutes(after, phase.startedAt)
    assert.equal(new Set(after.jobs.map(job => job.session_id)).size, 2)
    for (const r of routes) {
      const job = after.jobs.find(job => job.message_id === r.messageId)
      assert.equal(job.event_id, 'history:' + r.messageId)
      assert.equal(job.sender, owner)
      assert.equal(job.ambient, 1, 'the trigger must have no mention')
      assert.equal(job.channel_type, r.channel_type)
      assert.equal(job.channel_id, r.channel_id)
      assert.equal(job.message_seq, 10)
      assert.equal(job.result_id, r.resultId)
      assert.equal(job.state, 'sent')
      assert.equal(job.input, '')
      assert.equal(job.reply, null)
      assert.equal(job.issue, null)
      assert.match(job.session_id, /^session-[a-f0-9-]{36}$/)
      const events = nativeEvents(second.output()).filter(event => event.sessionId === job.session_id)
      assert.deepEqual(events.map(event => event.type), ['turn/start', 'turn/end'])
      const running = readJson(join(home, 'directory-running-' + r.name + '.json'))
      assert.equal(running.state, 'running')
      assert.equal(running.session_id, job.session_id)
      assert.equal(running.input, r.prompt)
      assert.equal(running.ambient, 1)
      assert.ok(readFileSync(join(home, r.fileName)).equals(Buffer.from(r.fileText)))
      save(join(logs, 'running-' + r.name + '.json'), running)
      writeFileSync(join(logs, r.fileName), readFileSync(join(home, r.fileName)), { mode: 0o600 })
    }
    assert.equal(nativeEvents(second.output()).length, 4)
    assert.equal((second.output().match(/FIXTURE_DIRECTORY_NATIVE_TOOL_OK\b/g) ?? []).length, 4)
    archive(2)
    save(join(logs, 'second-sent.json'), after)
    console.log('PASS: second native process discovered unknown group/topic through paginated directory only; two no-@ history jobs and isolated sessions.')
    console.log('PASS: native write/present twice; two exact files, exact upload bytes, complete per-route Markdown caption/final; old history suppressed.')

    const third = launchPhase({ ...phase, phase: 'replay', secondPid: second.child.pid, sessions: after.jobs.map(job => job.session_id) })
    await waitFor(third, 'unchanged directory and history replay', (s, text) => s.recovery.ready === 1
      && s.routes.every(route => route.blocked === 0 && route.failed === 0)
      && ['WS_ONLINE', 'EVENTS_EMPTY', 'TOPIC_PAGE_1', 'TOPIC_PAGE_2', ...routes.map(r => 'HISTORY_' + r.name)]
        .every(name => marker(text, name)))
    await delay(4500)
    save(join(logs, 'third-online-replay.json'), snapshot(state))
    await stop(third.child)
    clean(third.output())
    const replay = snapshot(state)
    healthyRoutes(replay, phase.startedAt)
    assert.deepEqual(replay.jobs, after.jobs)
    assert.deepEqual(replay.seen, after.seen)
    assert.deepEqual(nativeEvents(third.output()), [])
    assert.equal((third.output().match(/FIXTURE_DIRECTORY_NATIVE_TOOL_OK\b/g) ?? []).length, 0)
    assert.equal(hash(patch), patchHash)
    assert.equal(hash(accounts), accountHash)
    for (const r of routes) assert.ok(readFileSync(join(home, r.fileName)).equals(Buffer.from(r.fileText)))
    archive(3)
    save(join(logs, 'third-replayed.json'), replay)
    const metrics = [1, 2, 3].map(i => readJson(join(logs, 'process-' + i + '-metrics.json')))
    for (const m of metrics) {
      assert.equal(m.wsMessages, 0)
      assert.equal(m.wsAcks, 0)
      assert.equal(m.eventMessages, 0)
      assert.equal(m.eventAcks, 0)
    }
    assert.deepEqual(metrics.map(m => m.modelCalls), [0, 6, 0])
    assert.deepEqual(metrics.map(m => m.deliveries), [0, 4, 0])
    assert.deepEqual(metrics.map(m => m.uploads), [0, 2, 0])
    for (const m of metrics.slice(1)) {
      assert.ok(m.parentProbes > 0 && m.topicDetails > 0, 'current active parent and exact topic gates must run')
      assert.ok([1, 2].every(page => m.pages.includes(page)))
    }
    save(join(logs, 'result.json'), { passed: true, home, pids: runs.map(run => run.child.pid), startedAt: phase.startedAt,
      timestamp, nativeTurns: 2, nativeToolResults: 4, sentJobs: 2, events: 0, wsMessages: 0, replayExtraTurns: 0,
      patchHash, accountHash, packageSha256, routes: routes.map(r => ({ channel_type: r.channel_type, channel_id: r.channel_id,
        messageId: r.messageId, fileName: r.fileName, fileSha256: hash(join(home, r.fileName)), fullCaption: r.caption })) })
    passed = true
    console.log('PASS: third real process reread unchanged directory/history; no extra native turn/tool/upload/delivery; activation boundary unchanged.')
  } catch (error) {
    save(join(logs, 'result.json'), { passed: false, error: error.stack, home, packageSha256, pids: runs.map(run => run.child.pid) })
    throw error
  } finally {
    try { for (const run of runs) await stop(run.child) } finally {
      for (const [i, run] of runs.entries()) writeFileSync(join(logs, 'process-' + (i + 1) + '.log'),
        run.output().replace(/https?:\/\/\S+/g, '[fixture-url]'), { mode: 0o600 })
      try { save(join(logs, 'last-snapshot.json'), snapshot(state)) } catch {}
      for (const name of [phaseName, metricsName, ...routes.map(r => 'directory-running-' + r.name + '.json')]) {
        if (existsSync(join(home, name))) save(join(logs, name), readJson(join(home, name)))
      }
      console.log((passed ? 'PASS' : 'FAIL') + ': directory recovery evidence saved at ' + logs)
    }
  }
}

export async function installDirectoryRecoveryFixture() {
  const home = realpathSync(process.env.DSH_HOME), state = process.env.DSH_OCTO_FIXTURE_STATE
  isolatedHome(home, state)
  const phase = existsSync(join(home, phaseName)) ? readJson(join(home, phaseName)) : { phase: 'bootstrap' }
  assert.ok(['bootstrap', 'recover', 'replay'].includes(phase.phase))
  const bootstrap = phase.phase === 'bootstrap', replay = phase.phase === 'replay'
  const metrics = { installedAt: Date.now(), pid: process.pid, phase: phase.phase, wsMessages: 0, wsAcks: 0,
    eventMessages: 0, eventAcks: 0, modelCalls: 0, titleCalls: 0, uploads: 0, deliveries: 0, catalog: 0,
    parentProbes: 0, topicDetails: 0, pages: [], history: [] }
  const persist = () => save(join(home, metricsName), metrics)
  const mark = name => console.log('FIXTURE_DIRECTORY_' + name)
  const fail = reason => { mark('FAIL=' + reason); return new Response(null, { status: 400 }) }
  persist()
  if (!bootstrap) {
    assert.equal(phase.home, home)
    assert.notEqual(phase.firstPid, process.pid)
    assert.notEqual(phase.secondPid, process.pid)
    const restored = snapshot(state)
    assert.equal(restored.recovery.ready, 1)
    assert.equal(restored.recovery.started_at, phase.startedAt)
    assert.ok(Number.isSafeInteger(phase.timestamp) && phase.timestamp * 1000 > phase.startedAt && phase.timestamp <= Date.now() / 1000)
    assert.equal(restored.jobs.length, replay ? 2 : 0)
    assert.equal(restored.routes.length, replay ? 102 : 0)
    if (replay) assert.deepEqual(restored.jobs.map(job => job.session_id), phase.sessions)
  }
  const peer = await wirePeer()
  let send
  Object.defineProperty(peer, 'send', {
    get: () => send,
    set: value => { send = value && (() => {
      metrics.wsMessages++; persist(); mark('FAIL=WS_MESSAGE')
      throw new Error('Directory fixture must never inject a WebSocket message')
    }) },
  })
  let online = false
  // Authentication/keepalive only. Never call peer.send, even during replay.
  setInterval(() => {
    if (!online && peer.send) { online = true; mark('WS_ONLINE') }
    if (peer.acked.length) { metrics.wsAcks = peer.acked.length; persist(); mark('FAIL=UNEXPECTED_WS_ACK') }
  }, 50).unref()
  const progress = new Map(routes.map(r => [r.name, { step: 0, uploaded: false, file: false, caption: false, history: false }]))
  const operations = r => [['write', { file_path: r.fileName, content: r.fileText }], ['present', { files: [{ path: r.fileName }] }]]
  const oldTimestamp = Math.floor((phase.startedAt ?? Date.now()) / 1000) - 3600
  const messages = r => [
    [r.oldId, 1, 'OLD-DIRECTORY-' + r.name, oldTimestamp],
    [r.messageId, 10, r.prompt, phase.timestamp],
    [r.backdatedId, 11, 'OLD-DIRECTORY-BACKDATED-' + r.name, oldTimestamp],
  ].map(([message_id, message_seq, content, timestamp]) => ({ message_id, message_seq, from_uid: owner,
    channel_type: r.channel_type, channel_id: r.channel_id, timestamp, payload: { type: 1, content, space_id: space } }))
  const threadDTO = short => ({ group_no: group, short_id: short, channel_id: group + '____' + short,
    channel_type: 5, name: short === topic ? 'Directory topic' : 'Empty active topic', creator_uid: owner, status: 1 })
  const stream = (body, content, tool, id) => {
    const frames = [
      { type: 'message_start', message: { id: 'directory-fixture', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: tool, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(content) } : { type: 'text_delta', text: content } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
      { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const realFetch = globalThis.fetch, root = '/api/v1/bot/groups/' + group
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
        if (method !== 'POST' || body.limit !== 20) return fail('EVENT_REQUEST')
        mark('EVENTS_EMPTY')
        return json({ status: 1, results: [] })
      }
      if (/\/events\/[^/]+\/ack$/.test(path)) { metrics.eventAcks++; persist(); return fail('EVENT_ACK') }
      if (path === '/api/v1/bot/groups') {
        if (method !== 'GET' || url.searchParams.size !== 1 || url.searchParams.get('space_id') !== space) return fail('CATALOG_SPACE')
        metrics.catalog++; persist()
        mark(bootstrap ? 'CATALOG_EMPTY' : 'CATALOG_RECORDS')
        return json(bootstrap ? [] : [{ group_no: group, space_id: space, name: 'Directory group', status: 1 }])
      }
      if (path.startsWith(root) && bootstrap) return fail('GROUP_BEFORE_CREATION')
      if (path === root && method === 'GET') return json({ group_no: group, space_id: space, name: 'Directory group', notice: '', status: 1 })
      if (path === root + '/mention_pref' && method === 'GET') return json({ effective: true, group_allow_no_mention: true })
      if (path === root + '/members' && method === 'GET') return json([
        { uid: bot, name: 'Fixture Bot', robot: 1, role: 2 }, { uid: owner, name: 'Fixture Owner', robot: 0, role: 1 },
      ])
      if (path === root + '/threads' && method === 'GET') {
        const page = Number(url.searchParams.get('page_index')), size = url.searchParams.get('page_size')
        if (url.searchParams.size !== 2) return fail('TOPIC_QUERY')
        // Native active-parent membership probe, separate from directory pages.
        if (size === '1' && page === 1) {
          metrics.parentProbes++; persist()
          return json({ count: 101, list: [threadDTO(emptyTopics[0])] })
        }
        if (size !== '100' || ![1, 2].includes(page)) return fail('TOPIC_PAGINATION')
        if (page === 2 && !metrics.pages.includes(1)) return fail('TOPIC_PAGE_ORDER')
        metrics.pages.push(page); persist(); mark('TOPIC_PAGE_' + page)
        return json({ count: 101, list: page === 1
          ? emptyTopics.map(short => threadDTO(short)) : [threadDTO(topic)] })
      }
      if (path.startsWith(root + '/threads/') && method === 'GET'
        && [topic, ...emptyTopics].includes(path.split('/').at(-1))) {
        metrics.topicDetails++; persist()
        return json(threadDTO(path.split('/').at(-1)))
      }
      if (path === root + '/threads/' + topic + '/members' && method === 'GET') return json([{ uid: owner, role: 1 }, { uid: bot, role: 0 }])
      if (path === root + '/md' && method === 'GET') return json({ content: 'DIRECTORY-PARENT-RULE', version: 1 })
      if (path === root + '/threads/' + topic + '/md' && method === 'GET') return json({ content: 'DIRECTORY-TOPIC-RULE', version: 2 })
      if (path.startsWith('/api/v1/bot/space/principals/') && method === 'GET') {
        const uid = path.split('/').at(-1)
        if (![owner, bot].includes(uid) || url.searchParams.size !== 1 || url.searchParams.get('space_id') !== space) return fail('PRINCIPAL_SCOPE')
        return json({ uid, principal_type: uid === bot ? 'user_bot' : 'human' })
      }
      if (path === '/api/v1/bot/messages/sync') {
        if (!bootstrap && method === 'POST' && body?.channel_type === 5 && emptyTopics.some(short => body.channel_id === group + '____' + short)
          && body.limit === 1 && body.pull_mode === 0 && body.start_message_seq === 0 && body.end_message_seq === 0) {
          return json({ messages: [] })
        }
        const r = routes.find(r => r.channel_type === body?.channel_type && r.channel_id === body.channel_id)
        if (bootstrap || method !== 'POST' || !r) return fail('SYNC_SCOPE')
        const saved = snapshot(state).routes.find(row => row.channel_id === r.channel_id)
        if (!saved || saved.floor_seq !== 0 || saved.since_ms !== phase.startedAt) return fail('HISTORY_BEFORE_DIRECTORY')
        if (body.limit === 1 && body.pull_mode === 0 && body.start_message_seq === 0 && body.end_message_seq === 0) return json({ messages: messages(r).slice(-1) })
        // Ordinary context lookup is separate from authoritative inbox recovery.
        if (body.limit === 20 && body.pull_mode === 0 && body.start_message_seq === 9 && body.end_message_seq === 0) return json({ messages: [] })
        if (body.limit !== 100 || body.pull_mode !== 1 || body.start_message_seq !== 1 || body.end_message_seq !== 12) return fail('HISTORY_RANGE')
        progress.get(r.name).history = true
        metrics.history.push(r.name); persist(); mark('HISTORY_' + r.name)
        return json({ messages: messages(r) })
      }
      if (path === '/api/v1/bot/upload/presigned') {
        const r = routes.find(r => r.fileName === url.searchParams.get('filename'))
        if (bootstrap || replay || method !== 'GET' || !r || progress.get(r.name).step !== 3
          || url.searchParams.get('fileSize') !== String(Buffer.byteLength(r.fileText))) return fail('PRESIGN')
        return json({ method: 'PUT', uploadUrl: 'https://storage-fixture.invalid/' + r.name + '.txt?signature=fixture',
          downloadUrl: 'https://files-fixture.invalid/' + r.name + '.txt', contentType: 'text/plain' })
      }
      if (path === '/api/v1/bot/sendMessage') {
        const r = routes.find(r => r.channel_type === body?.channel_type && r.channel_id === body.channel_id), payload = body?.payload
        if (bootstrap || replay || method !== 'POST' || !r || !payload || payload.mention) return fail('SEND_SCOPE')
        if (!isDeepStrictEqual(payload.reply, { message_id: r.messageId, message_seq: 10, from_uid: owner,
          from_name: 'Fixture Owner', payload: { type: 1, content: Array.from(r.prompt).slice(0, 160).join('') } })) return fail('REPLY_SCOPE')
        const p = progress.get(r.name)
        if (p.step !== 3) return fail('SEND_BEFORE_FINAL')
        if (payload.type === 8) {
          if (!p.uploaded || p.file || payload.name !== r.fileName || payload.size !== Buffer.byteLength(r.fileText)
            || payload.url !== 'https://files-fixture.invalid/' + r.name + '.txt') return fail('FILE_' + r.name)
          p.file = true; metrics.deliveries++; persist(); mark('FILE_' + r.name)
          return json({ message_id: String(Number(r.resultId) - 1) })
        }
        if (payload.type === 1) {
          if (!p.file || p.caption || payload.content !== r.caption) return fail('FULL_CAPTION_' + r.name)
          p.caption = true; metrics.deliveries++; persist(); mark('FULL_CAPTION_' + r.name)
          return json({ message_id: r.resultId })
        }
        return fail('UNEXPECTED_DELIVERY')
      }
      return fail('API_PATH:' + method + ':' + path)
    }
    if (url.hostname === 'storage-fixture.invalid') {
      const r = routes.find(r => path === '/' + r.name + '.txt'), p = r && progress.get(r.name)
      if (bootstrap || replay || !r || p.uploaded || p.step !== 3 || method !== 'PUT'
        || !Buffer.from(init.body).equals(Buffer.from(r.fileText))) return fail('UPLOAD_BYTES')
      p.uploaded = true; metrics.uploads++; persist(); mark('UPLOAD_' + r.name)
      return new Response(null, { status: 200 })
    }
    if (url.hostname === 'model-fixture.invalid' && path.endsWith('/messages')) {
      const body = JSON.parse(init.body), history = JSON.stringify(body.messages), tail = JSON.stringify(body.messages.at(-1))
      if (bootstrap || replay) return fail('MODEL_DURING_' + phase.phase.toUpperCase())
      if (history.includes('OLD-DIRECTORY-')) return fail('OLD_MODEL_BODY')
      if (tail.includes('Generate the session title from this JSON array of human messages:')) {
        metrics.titleCalls++; persist(); return stream(body, 'Directory recovery fixture title')
      }
      const selected = routes.filter(r => history.includes(r.prompt))
      if (selected.length !== 1) return fail('MODEL_ROUTE_ISOLATION')
      const r = selected[0], p = progress.get(r.name), ops = operations(r)
      const allText = JSON.stringify(body)
      if (!p.history || !metrics.pages.includes(r.channel_type === 5 ? 2 : 1)
        || !allText.includes('DIRECTORY-PARENT-RULE') || (r.channel_type === 5) !== allText.includes('DIRECTORY-TOPIC-RULE')) return fail('MODEL_CONTEXT')
      if (!ops.every(([name]) => body.tools?.some(tool => tool.name === name))) return fail('NATIVE_TOOLS_MISSING')
      if (p.step > ops.length) return fail('EXTRA_MODEL_RUN')
      if (p.step === 0) {
        const job = snapshot(state).jobs.find(job => job.message_id === r.messageId)
        if (job?.event_id !== 'history:' + r.messageId || job.state !== 'running' || job.input !== r.prompt || job.ambient !== 1) return fail('RUNNING_HISTORY_JOB')
        save(join(home, 'directory-running-' + r.name + '.json'), job)
      } else {
        const id = 'toolu_directory_' + r.name + '_' + (p.step - 1)
        const parts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        const call = parts.find(part => part.type === 'tool_use' && part.id === id)
        const result = parts.find(part => part.type === 'tool_result' && part.tool_use_id === id)
        if (call?.name !== ops[p.step - 1][0] || !result || result.is_error) return fail('NATIVE_TOOL_RESULT_' + r.name)
        assert.deepEqual(call.input, ops[p.step - 1][1])
        if (!existsSync(join(home, r.fileName)) || !readFileSync(join(home, r.fileName)).equals(Buffer.from(r.fileText))) return fail('NATIVE_WRITE_BYTES')
        mark((p.step === 1 ? 'WRITE_' : 'PRESENT_') + r.name)
      }
      metrics.modelCalls++; persist()
      if (p.step < ops.length) {
        const id = 'toolu_directory_' + r.name + '_' + p.step, [name, args] = ops[p.step++]
        return stream(body, args, name, id)
      }
      p.step++
      return stream(body, r.caption)
    }
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init)
    return fail('EXTERNAL_REQUEST:' + url.hostname)
  }
}
