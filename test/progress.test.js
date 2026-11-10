import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
const approvedIcons = new Set(Object.values(JSON.parse(readFileSync(new URL('./fixtures/octo-approved-progress-icons.json', import.meta.url), 'utf8'))))
import { setImmediate } from 'node:timers/promises'
import { OctoClient, OctoError } from '../src/octo.js'
import { cardMode, Progress } from '../src/progress.js'

const job = { message_id: '123', sender: 'member', channel_id: 'thread', channel_type: 5 }
const ref = { id: 'ai.reasoning-process', version: '0.4.1' }
const display = {
  enabled: 1, card_version: '1.5', profiles: ['octo/v1'],
  config: { card_enabled: true, display_enabled: true },
}
const template = {
  ...display,
  config: { ...display.config, reasoning_enabled: true, reasoning_template_ref: ref },
  templating: { supported: true, templates: [
    { ...ref, views: [{ states: ['reasoning', 'answering', 'completed', 'stopped', 'error'] }] },
  ] },
}
const compact = { ...template, elements: ['TextBlock', 'Container', 'ColumnSet', 'Image'], actions: ['Action.ToggleVisibility'] }
const labels = {
  queued: '已收到，等待 DSH 开始处理', running: 'DSH 正在处理', responding: '正在生成回复',
  completed: '回复已发送', error: '本次回复未完成', stopped: '回复发送待确认',
}

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  return async ms => {
    t.mock.timers.tick(ms)
    await setImmediate()
  }
}

function fixture({ profile = () => template, create = () => '456', edit = () => {} } = {}) {
  const calls = [], logs = []
  const api = {
    cardProfile() { calls.push({ type: 'profile' }); return profile() },
    progressCard(route, frame) { calls.push({ type: 'create', route, frame }); return create() },
    editProgress(route, id, frame, seq, transient) {
      calls.push({ type: 'edit', route, id, frame, seq, transient })
      return edit(frame)
    },
    typing(route) { calls.push({ type: 'typing', route }) },
  }
  return { calls, logs, progress: new Progress(api, log => logs.push(log)) }
}

function elements(card) {
  const walk = rows => rows.flatMap(row => [row, ...walk(row.items ?? row.columns ?? [])])
  return walk(card.body)
}

function localCard(card) {
  const rows = elements(card), byId = new Map(rows.filter(row => row.id).map(row => [row.id, row]))
  assert.equal(byId.size, rows.filter(row => row.id).length, 'IDs are unique within the frame')
  for (const row of rows) {
    assert.ok(row.type === 'Column' || compact.elements.includes(row.type))
    if (row.type === 'Image') assert.ok(approvedIcons.has(row.url), 'Image URL must match Octo server approved bytes')
    if (row.isVisible !== undefined) assert.equal(typeof row.isVisible, 'boolean')
    if (!row.selectAction) continue
    assert.equal(row.selectAction.type, 'Action.ToggleVisibility')
    assert.ok(row.selectAction.targetElements.length > 0)
    for (const target of row.selectAction.targetElements) {
      assert.equal(typeof target.isVisible, 'boolean', 'all target states are explicit')
      assert.ok(byId.has(target.elementId), 'target exists: ' + target.elementId)
    }
  }
  return {
    byId,
    click(id) {
      assert.equal(byId.get(id).isVisible, true, 'control is locally visible: ' + id)
      for (const target of byId.get(id).selectAction.targetElements) byId.get(target.elementId).isVisible = target.isVisible
    },
    expanded(id, expected) {
      assert.equal(byId.get(id + '_details').isVisible, expected)
      assert.equal(byId.get(id + '_open').isVisible, !expected)
      assert.equal(byId.get(id + '_close').isVisible, expected)
    },
  }
}

test('nested compact mode requires every advertised capability and retains registry/display fallbacks', () => {
  assert.equal(cardMode(compact), 'compact')
  for (const element of compact.elements) {
    const profile = { ...compact, elements: compact.elements.filter(type => type !== element) }
    assert.deepEqual(cardMode(profile), ref, element)
    assert.equal(cardMode({ ...profile, templating: undefined }), 'display', element)
  }
  assert.deepEqual(cardMode({ ...compact, actions: [] }), ref)
  assert.deepEqual(cardMode({ ...compact, config: { ...compact.config, display_enabled: false } }), ref)
  assert.equal(cardMode({ ...compact, config: { ...compact.config, card_enabled: false } }), undefined)
  assert.equal(cardMode({ ...compact, enabled: 0 }), undefined)
  assert.equal(cardMode({ ...display, profiles: [] }), undefined)
  assert.equal(cardMode({ ...display, card_version: '1.4' }), undefined)
  assert.equal(cardMode(display), 'display')
})

test('native approval has a distinct waiting label and cannot hide the final state', async t => {
  const tick = clock(t), f = fixture()
  const handle = f.progress.start(job, 'auto', new AbortController().signal)
  handle.stage('running')
  handle.trace({ kind: 'tool-start', id: 'write', name: 'write' })
  handle.stage('approval')
  handle.trace({ kind: 'question-open' })
  await tick(450)
  assert.equal(f.calls.find(c => c.type === 'create').frame.data.statusLabel, '等待你批准这次操作')
  handle.trace({ kind: 'question-closed' })
  handle.stage('running')
  await tick(800)
  assert.equal(f.calls.filter(c => c.type === 'edit').at(-1).frame.data.statusLabel, '正在写入文件')
  await handle.finish('completed')
  assert.equal(f.calls.filter(c => c.type === 'edit').at(-1).frame.data.statusLabel, '回复已发送')
})

test('an explicit stop ends a created progress card using the still-authorized service lifetime', async t => {
  const tick = clock(t), f = fixture()
  const task = new AbortController(), service = new AbortController(), checked = []
  const handle = f.progress.start(job, 'auto', task.signal, async signal => {
    checked.push(signal)
    return !signal.aborted
  }, service.signal)
  await tick(450)
  task.abort()
  assert.equal(await handle.finish('stopped', { interrupted: true, detail: '收到 /stop' }), true)
  const edit = f.calls.at(-1)
  assert.equal(edit.frame.state, 'stopped')
  assert.equal(edit.frame.data.statusLabel, '任务已停止')
  assert.equal(edit.frame.data.progressText, '收到 /stop')
  assert.equal(checked.at(-1), service.signal)
  assert.ok(checked.length > 1 && checked.slice(0, -1).every(signal => signal === task.signal))
})

test('type-17 template shows queued, running, responding and confirmed completion', async t => {
  const tick = clock(t)
  const requests = []
  const api = new OctoClient({ apiBase: 'http://127.0.0.1', token: 'test-only', fetchImpl: async (url, init) => {
    const path = new URL(url).pathname
    requests.push([path, init.body && JSON.parse(init.body)])
    if (path === '/v1/bot/card/profile') return Response.json(template)
    return Response.json({ message_id: '456' })
  } })
  const handle = new Progress(api, assert.fail).start(job, 'auto', new AbortController().signal)

  await tick(450)
  handle.stage('running')
  await tick(799)
  assert.equal(requests.length, 2)
  await tick(1)
  handle.stage('responding')
  await tick(800)
  assert.equal(await handle.finish('completed'), true)
  await tick(20_000)

  const [, [createPath, created], ...edits] = requests
  assert.equal(createPath, '/v1/bot/sendMessage')
  assert.equal(created.payload.type, 17)
  assert.deepEqual(created.payload.template_ref, ref)
  assert.equal(created.payload.state, 'reasoning')
  assert.equal(created.payload.data.statusLabel, labels.queued)
  assert.deepEqual(edits.map(([path, body]) => [
    path, body.channel_id, body.channel_type, body.message_id, body.card_seq, body.transient,
    body.state, body.data.statusLabel, body.content_edit,
  ]), [
    ['/v1/bot/message/edit', 'thread', 5, '456', 2, true, 'reasoning', labels.running, undefined],
    ['/v1/bot/message/edit', 'thread', 5, '456', 3, true, 'answering', labels.responding, undefined],
    ['/v1/bot/message/edit', 'thread', 5, '456', 4, undefined, 'completed', labels.completed, undefined],
  ])
})

test('coalesces a burst during creation and serializes finalization with the in-flight edit', async t => {
  const tick = clock(t)
  const creating = Promise.withResolvers(), editing = Promise.withResolvers()
  const { calls, progress } = fixture({ create: () => creating.promise,
    edit: frame => frame.state === 'answering' ? editing.promise : undefined })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  handle.stage('answering') // compatibility with the existing host callback
  for (let i = 0; i < 100; i++) handle.stage('responding')
  handle.stage('running')
  await tick(20_000)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'create'])
  creating.resolve('456')
  await tick(0)
  await tick(800)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.responding)
  const done = handle.finish('error')
  assert.equal(handle.finish('completed'), done)
  await tick(20_000)
  assert.equal(calls.filter(call => call.type === 'edit').length, 1)
  editing.resolve()
  assert.equal(await done, true)
  await tick(20_000)
  assert.deepEqual(calls.filter(call => call.type === 'edit').map(call => [call.frame.state, call.seq, call.transient]),
    [['answering', 2, true], ['error', 3, false]])
})

test('a rate-limited edit resumes with the latest phase at Retry-After without a new event', async t => {
  const tick = clock(t)
  let attempts = 0
  const { calls, progress } = fixture({ edit() {
    if (++attempts === 1) throw new OctoError('http_429', 429, 7400)
  } })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  await tick(800)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.running)
  handle.stage('responding')
  await tick(7399)
  assert.equal(attempts, 1)
  await tick(1)
  assert.equal(attempts, 2)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.responding)
  assert.equal(calls.at(-1).transient, true)
  assert.equal(await handle.finish('completed'), true)
})

test('retries rate-limited profile and card creation without typing during cooldown', async t => {
  const tick = clock(t)
  let probes = 0, creates = 0
  const rateLimit = new OctoError('http_429', 429, 5000)
  const { calls, progress } = fixture({
    profile() { if (++probes === 1) throw rateLimit; return display },
    create() { if (++creates === 1) throw rateLimit; return '456' },
  })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  await tick(4999)
  assert.deepEqual(calls.map(call => call.type), ['profile'])
  await tick(1)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'profile', 'create'])
  handle.stage('responding')
  await tick(5000)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'profile', 'create', 'create'])
  assert.ok(calls.at(-1).frame.plain.startsWith(labels.responding + ' · '))
  assert.equal(await handle.finish('stopped'), true)
  assert.ok(calls.at(-1).frame.plain.startsWith(labels.stopped + ' · '))
})

test('a terminal retry keeps the same payload and sequence and never replays a transient edit', async t => {
  const tick = clock(t)
  let attempts = 0
  const { calls, progress } = fixture({ edit() {
    if (++attempts === 1) throw new OctoError('http_429', 429, 5000)
  } })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  const done = handle.finish('error')
  await tick(0)
  await tick(4999)
  assert.equal(attempts, 1)
  await tick(1)
  assert.equal(await done, true)
  assert.equal(attempts, 2)
  assert.deepEqual(calls.at(-1), calls.at(-2))
  assert.equal(calls.at(-1).transient, false)
  assert.equal(calls.at(-1).frame.state, 'error')
})

test('a long cooldown leaves finish best effort and also applies to other handles', async t => {
  const tick = clock(t)
  const { calls, progress } = fixture({ edit() { throw new OctoError('http_429', 429, 30_000) } })
  const first = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  const second = progress.start({ ...job, message_id: '987' }, 'auto', new AbortController().signal)
  first.stage('running')
  // Second handle creates after its debounce. First handle's edit then sets the cooldown.
  await tick(450)
  await tick(350)
  assert.equal(await first.finish('error'), false)
  second.stage('responding')
  await tick(29_999)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'create', 'profile', 'create', 'edit'])
  await tick(1)
  assert.equal(calls.at(-1).frame.state, 'answering')
  assert.equal(await second.finish('stopped'), false)
})

test('an uncertain card create falls back to typing instead of risking a duplicate card', async t => {
  const tick = clock(t)
  const { calls, logs, progress } = fixture({ create() {
    throw new OctoError('sensitive server response', 503)
  } })
  const handle = progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  handle.stage('running')
  await tick(4000)
  assert.equal(await handle.finish('error'), false)
  await tick(20_000)
  assert.deepEqual(calls.map(call => call.type), ['profile', 'create', 'typing', 'typing'])
  assert.deepEqual(logs, ['progress_http_503'])
})

test('short, disabled, and aborted runs stop without leaving progress work behind', async t => {
  const tick = clock(t)
  const { calls, progress } = fixture()
  const controller = new AbortController()
  assert.equal(await progress.start(job, 'off', controller.signal).finish('completed'), false)
  assert.equal(await progress.start(job, 'auto', controller.signal).finish('completed'), false)
  const handle = progress.start(job, 'typing', controller.signal)
  await tick(450)
  assert.deepEqual(calls, [{ type: 'typing', route: { channel_id: 'thread', channel_type: 5 } }])
  controller.abort()
  await tick(20_000)
  assert.equal(await handle.finish('error'), false)
  assert.equal(calls.length, 1)
})

test('progress only renders fixed labels, even if inputs contain private content', async t => {
  const tick = clock(t)
  const { calls, logs, progress } = fixture()
  const handle = progress.start({ ...job, message_id: 'private-id', input: 'private-prompt' },
    'auto', new AbortController().signal)
  handle.stage('private-partial-text')
  handle.stage({ type: 'reasoning-delta', text: 'private-reasoning' })
  await tick(450)
  assert.equal(calls.at(-1).frame.data.statusLabel, labels.queued)
  handle.stage('running', 'private-tool-result')
  await tick(800)
  await handle.finish('error', new Error('private-error'))
  assert.equal(calls.at(-1).frame.data.errorMessage, labels.error)
  assert.doesNotMatch(JSON.stringify([calls, logs]), /private-/)
})

test('progress shows verified tools and delivered files without exposing tool inputs', async t => {
  const tick = clock(t)
  const { calls, progress } = fixture()
  const handle = progress.start(job, 'auto', new AbortController().signal)
  handle.stage('running')
  handle.trace({ kind: 'step' })
  handle.trace({ kind: 'tool-start', name: 'write', id: 'call-fixture', arguments: { secret: 'never-show' } })
  await tick(450)
  assert.equal(calls.at(-1).frame.data.traceExpanded, false)
  assert.equal(calls.at(-1).frame.data.phases[0].actions[0].tool, '写入文件')
  handle.trace({ kind: 'tool-end', id: 'call-fixture' })
  handle.stage('delivering')
  handle.trace({ kind: 'file-sent' })
  assert.equal(await handle.finish('completed'), true)
  const terminal = calls.at(-1)
  assert.equal(terminal.frame.data.traceCollapsed, true)
  assert.match(terminal.frame.data.collapsedSummary, /已发 1 个文件/)
  assert.doesNotMatch(JSON.stringify(calls), /never-show|call-fixture/)
})


test('compact progress keeps three visible lines, resets each frame, and edits the same card', async t => {
  const tick = clock(t)
  const f = fixture({ profile: () => compact })
  const handle = f.progress.start(job, 'auto', new AbortController().signal)
  handle.stage('running')
  await tick(450)
  const initial = f.calls.at(-1).frame
  assert.equal(initial.template_ref, undefined)
  assert.doesNotMatch(initial.plain, /0 次工具|0 步/)
  const root = initial.card.body[0], body = root.items
  assert.equal(root.type, 'Container')
  assert.equal(root.style, 'emphasis')
  assert.equal(root.bleed, true)
  assert.equal(root.spacing, 'None')
  assert.equal(body.filter(row => row.isVisible !== false).length, 3)
  assert.equal(body[0].columns[0].items[0].text, 'DSH 回复进度')
  assert.equal(body[1].text, labels.running)
  assert.match(body[2].text, /^已用时 /)
  assert.equal(body[0].selectAction, undefined, 'bulk control has no enclosing click handler')
  assert.equal(body[0].columns.at(-1).items[0].id, 'dsh_progress_all_open')
  assert.equal(body[0].columns.at(-1).items[0].items[0].width, '14px')
  const local = localCard(initial.card)
  local.expanded('dsh_progress', false)
  local.expanded('dsh_progress_session', false)
  // Execute precisely the declared client-local actions without a Bot callback.
  local.click('dsh_progress_all_open')
  local.expanded('dsh_progress', true)
  local.expanded('dsh_progress_session', true)
  handle.trace({ kind: 'tool-start', id: 'read', name: 'read', arguments: 'private-data' })
  await tick(800)
  const editing = f.calls.at(-1)
  assert.equal(editing.type, 'edit')
  assert.equal(editing.id, '456')
  assert.match(editing.frame.plain, /正在读取文件/)
  assert.match(JSON.stringify(editing.frame.card), /执行中/)
  const edited = localCard(editing.frame.card)
  edited.expanded('dsh_progress', false)
  edited.expanded('dsh_progress_item_1', false)
  handle.trace({ kind: 'tool-end', id: 'read' })
  handle.trace({ kind: 'file-sent' })
  await tick(3_600_000)
  await handle.finish('completed')
  const final = f.calls.at(-1).frame
  assert.match(final.plain, /回复已发送 · 已用时 1 小时 0 分 · 已发 1 个文件/)
  localCard(final.card).expanded('dsh_progress', false)
  localCard(final.card).expanded('dsh_progress_files', false)
  assert.doesNotMatch(JSON.stringify(f.calls), /private-data/)
  assert.equal(f.calls.filter(row => row.type === 'create').length, 1)
})

test('outer and group arrows preserve siblings while bulk arrows set every disclosure explicitly', async t => {
  const tick = clock(t), f = fixture({ profile: () => compact })
  const handle = f.progress.start(job, 'auto', new AbortController().signal)
  handle.trace({ kind: 'tool-start', id: 'private-call', name: 'read', arguments: 'private-args' })
  handle.trace({ kind: 'file-sent' })
  await tick(450)
  const frame = f.calls.at(-1).frame, local = localCard(frame.card), count = f.calls.length
  const outer = 'dsh_progress', tools = outer + '_item_1', files = outer + '_files'
  for (const id of [outer, tools, files]) local.expanded(id, false)
  const details = local.byId.get('dsh_progress_details')
  assert.match(JSON.stringify(details), /读取文件.*文件交付/)
  local.click(outer + '_open')
  local.expanded(tools, false)
  local.expanded(files, false)
  local.click(tools + '_open')
  local.expanded(tools, true)
  local.expanded(files, false)
  const childState = JSON.stringify(details.items)
  local.click(outer + '_close')
  local.click(outer + '_open')
  assert.equal(JSON.stringify(details.items), childState, 'outer actions do not touch children')
  local.click(files + '_open')
  local.click(tools + '_close')
  local.expanded(files, true)
  local.expanded(tools, false)
  local.click(outer + '_all_open')
  for (const id of [outer, tools, files]) local.expanded(id, true)
  local.click(files + '_close')
  local.click(outer + '_close')
  local.click(outer + '_all_close')
  for (const id of [outer, tools, files]) local.expanded(id, false)
  local.click(outer + '_open')
  for (const id of [tools, files]) local.expanded(id, false)
  assert.equal(f.calls.length, count, 'local toggles never call the server')
  assert.doesNotMatch(JSON.stringify(frame), /private-/)
  await handle.finish('completed')
})

test('group IDs stay stable, all six tools remain visible, and idle refresh remains 15 seconds', async t => {
  const tick = clock(t), f = fixture({ profile: () => compact })
  const handle = f.progress.start(job, 'auto', new AbortController().signal)
  handle.trace({ kind: 'file-sent' })
  await tick(450)
  const fileIds = [...localCard(f.calls.at(-1).frame.card).byId.keys()].filter(id => id.includes('_files_'))
  for (const [i, name] of ['read', 'write', 'shell', 'edit', 'present', 'private-tool'].entries()) {
    handle.trace({ kind: 'tool-start', id: 'private-call-' + i, name, arguments: 'private-input' })
    handle.trace({ kind: 'tool-end', id: 'private-call-' + i, failed: i === 5, result: 'private-result' })
  }
  handle.stage({ type: 'reasoning-delta', text: 'private-reasoning' })
  await tick(800)
  const frame = f.calls.at(-1).frame, local = localCard(frame.card)
  assert.deepEqual([...local.byId.keys()].filter(id => id.includes('_files_')), fileIds)
  const items = local.byId.get('dsh_progress_details').items
  assert.equal([...local.byId.keys()].filter(id => /^dsh_progress_item_\d+_details$/.test(id)).length, 6)
  assert.match(JSON.stringify(items), /未成功/)
  assert.match(JSON.stringify(items), /读取文件/)
  assert.match(JSON.stringify(items), /写入文件/)
  assert.doesNotMatch(JSON.stringify(f.calls), /private-/)
  const ids = [...local.byId.keys()]
  local.click('dsh_progress_all_open')
  const count = f.calls.filter(c => c.type === 'edit').length
  await tick(14_999)
  assert.equal(f.calls.filter(c => c.type === 'edit').length, count)
  await tick(1)
  const refreshed = localCard(f.calls.at(-1).frame.card)
  assert.equal(f.calls.filter(c => c.type === 'edit').length, count + 1)
  assert.deepEqual([...refreshed.byId.keys()], ids)
  for (const id of ['dsh_progress', 'dsh_progress_item_1', 'dsh_progress_files']) refreshed.expanded(id, false)
  await handle.finish('error')
  assert.equal(f.calls.at(-1).frame.card.body[0].items[1].color, 'Attention')
})

// Optional upstream contract check: use an existing octo-web checkout without copying it into this repo.
test('compact frames pass the official Octo InteractiveCard validator', {
  skip: !process.env.OCTO_PROGRESS_VALIDATOR_DIR,
}, async t => {
  const { readFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const { stripTypeScriptTypes } = await import('node:module')
  const directory = process.env.OCTO_PROGRESS_VALIDATOR_DIR
  const sourceModule = async (file, imports = {}) => {
    let source = stripTypeScriptTypes(await readFile(resolve(directory, file), 'utf8'), { mode: 'transform' })
    for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll('"' + specifier + '"', '"' + url + '"')
    return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  }
  const types = await sourceModule('types.ts')
  const guards = await sourceModule('guards.ts', { './types': types })
  const security = await sourceModule('../../Utils/security.ts')
  const { validateCardForOcto } = await import(await sourceModule('validateCardForOcto.ts', {
    './guards': guards, '../../Utils/security': security,
  }))
  const tick = clock(t)
  for (const outcome of ['completed', 'stopped', 'error']) {
    const f = fixture({ profile: () => compact })
    const handle = f.progress.start(job, 'auto', new AbortController().signal)
    await tick(450)
    handle.trace({ kind: 'file-sent' })
    await tick(800)
    for (let i = 0; i < 8; i++) {
      handle.trace({ kind: 'step' })
      handle.trace({ kind: 'tool-start', id: 'tool-' + i, name: 'read' })
      handle.trace({ kind: 'tool-end', id: 'tool-' + i, failed: i === 0 })
    }
    await tick(800)
    handle.trace({ kind: 'question-open' })
    await tick(800)
    handle.stage('approval')
    await tick(800)
    await handle.finish(outcome)
    for (const { frame } of f.calls.filter(call => call.frame)) {
      assert.deepEqual(validateCardForOcto(frame.card), { ok: true })
      const local = localCard(frame.card)
      local.click('dsh_progress_all_open')
      assert.deepEqual(validateCardForOcto(frame.card), { ok: true })
      local.click('dsh_progress_all_close')
      assert.deepEqual(validateCardForOcto(frame.card), { ok: true })
    }
  }
})

test('idle cards refresh less often, while questions and completion update promptly', async t => {
  const tick = clock(t), f = fixture()
  const handle = f.progress.start(job, 'auto', new AbortController().signal)
  await tick(450)
  await tick(14_999)
  assert.equal(f.calls.filter(row => row.type === 'edit').length, 0)
  await tick(1)
  assert.equal(f.calls.filter(row => row.type === 'edit').length, 1)
  handle.trace({ kind: 'question-open' })
  await tick(800)
  assert.equal(f.calls.at(-1).frame.data.statusLabel, '等待你的回答')
  const count = f.calls.length
  handle.trace({ kind: 'question-open' })
  await tick(800)
  assert.equal(f.calls.length, count)
  await handle.finish('completed')
  assert.equal(f.calls.at(-1).frame.data.statusLabel, '回复已发送')
})

// A confirmed validation rejection is safe to retry as a plain card. Network
// uncertainty still follows the existing no-duplicate typing fallback test.
test('a rejected compact card falls back to a basic card and continues editing it', async t => {
  const tick = clock(t); let attempts = 0
  const f = fixture({ profile: () => compact, create: () => {
    if (++attempts === 1) throw new OctoError('http_400', 400)
    return '456'
  } })
  const handle = f.progress.start(job, 'auto', new AbortController().signal)
  await tick(450); await tick(1)
  const creates = f.calls.filter(c => c.type === 'create')
  assert.equal(creates.length, 2)
  assert.ok(elements(creates[0].frame.card).some(e => e.type === 'Image'))
  assert.ok(creates[1].frame.card.body.every(e => e.type === 'TextBlock'))
  assert.equal(f.calls.filter(c => c.type === 'typing').length, 0)
  assert.equal(await handle.finish('completed'), true)
  assert.equal(f.calls.at(-1).id, '456')
  assert.ok(f.calls.at(-1).frame.card.body.every(e => e.type === 'TextBlock'))
})


test('long runs use one bounded card, retain failures, and omit final body', async t => {
  const tick = clock(t), f = fixture({ profile: () => compact })
  const h = f.progress.start(job, 'auto', new AbortController().signal)
  for (let i=0;i<180;i++) {
    h.trace({kind:'note',text:'先检查项目 '+i})
    h.trace({kind:'tool-start',id:''+i,name:'read',title:'检查项目 '+i})
    h.trace({kind:'tool-end',id:''+i,failed:i===0,summary:i===0?'退出码：2':'返回数量：1'})
  }
  h.trace({kind:'note',text:'FINAL_BODY_ONLY | full answer | table'})
  await tick(450)
  assert.equal(await h.finish('completed'),true)
  assert.equal(f.calls.filter(c=>c.type==='create').length,1)
  const frame=f.calls.at(-1).frame, serialized=JSON.stringify(frame)
  assert.match(serialized,/检查项目 0/)
  assert.match(serialized,/检查项目 179/)
  assert.match(serialized,/已收拢/)
  assert.doesNotMatch(serialized,/FINAL_BODY_ONLY|工具返回不等于|已进入|第 1 步|第 2 页/)
  assert.ok(elements(frame.card).length<200)
  assert.equal(frame.card.body[0].items[1].color,'Good', 'recovered tool failures do not recolor final success')
  localCard(frame.card).click('dsh_progress_all_open')
})

test('late parallel results update the same card and stopped operations are not called complete', async t=>{
 const tick=clock(t), f=fixture({profile:()=>compact})
 const h=f.progress.start(job,'auto',new AbortController().signal)
 for(let i=0;i<4;i++)h.trace({kind:'tool-start',id:''+i,name:'read',title:'检查 '+i})
 await tick(450)
 h.trace({kind:'tool-end',id:'0',summary:'返回数量：1'})
 await h.finish('stopped',{interrupted:true})
 const frame=f.calls.at(-1).frame
 assert.match(JSON.stringify(frame),/返回数量：1/)
 assert.match(JSON.stringify(frame),/已停止/)
 assert.equal(f.calls.filter(c=>c.type==='create').length,1)
})

test('many failures stay within one card and disclose omitted failures', async t=>{
 const tick=clock(t), f=fixture({profile:()=>compact})
 const h=f.progress.start(job,'auto',new AbortController().signal)
 for(let i=0;i<180;i++) {
  h.trace({kind:'tool-start',id:''+i,name:'read'})
  h.trace({kind:'tool-end',id:''+i,failed:true})
 }
 await tick(450);await h.finish('error')
 assert.equal(f.calls.filter(c=>c.type==='create').length,1)
 assert.match(JSON.stringify(f.calls.at(-1).frame),/172 条未成功操作/)
 assert.ok(elements(f.calls.at(-1).frame.card).length<200)
})
