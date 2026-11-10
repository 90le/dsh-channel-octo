import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProgressEvents, safeProgressText } from '../src/progress-events.js'

const event = (type, data) => ({ type, data: { turn: 1, step: 1, ...data } })
const call = (name, args, callId = 'call-1') => event('tool/call', {
  callId, name, arguments: JSON.stringify(args),
})
const result = (text, extra = {}, toolCallId = 'call-1') => event('tool/result', {
  message: { toolCallId, content: [{ type: 'text', text }] }, ...extra,
})

test('steps retain actual numbers and titles select only public metadata', () => {
  const progress = createProgressEvents()
  assert.deepEqual(progress.extract(event('step/start', { step: 7 })), { kind: 'step', step: 7 })
  assert.deepEqual(progress.extract(event('step/end', { step: 7 })), { kind: 'step-end', step: 7 })
  assert.deepEqual(progress.extract(event('step/start', { step: 0 })), { kind: 'step', step: 0 })
  assert.deepEqual(progress.extract(event('step/end', { step: 0 })), { kind: 'step-end', step: 0 })
  for (const step of [-1, -0, 0.5, Infinity, NaN]) assert.equal(progress.extract(event('step/start', { step })), undefined)
  assert.equal(progress.extract(event('step/start', { step: '7' })), undefined)
  for (const name of ['bash', 'pwsh', 'exec']) {
    assert.deepEqual(progress.extract(call(name, { description: 'Check the build', command: 'PRIVATE COMMAND', password: 'PRIVATE ARG' }, name)),
      { kind: 'tool-start', id: name, name, title: 'Check the build' })
    assert.deepEqual(progress.extract(call(name, { command: 'PRIVATE COMMAND', title: 'NOT SHELL DESCRIPTION', path: '/root/private.txt' }, `${name}-bare`)),
      { kind: 'tool-start', id: `${name}-bare`, name })
  }
  assert.equal(progress.extract(call('read', { file_path: 'C:\\Users\\private\\project\\report.txt', content: 'PRIVATE CONTENT' }, 'read')).title, '读取文件 · report.txt')
  assert.equal(progress.extract(call('edit', { path: '/root/a.md' }, 'edit')).title, '编辑文件 · a.md')
  assert.equal(progress.extract(call('read', { path: '/root/.env' }, 'sensitive')).title, undefined)
  assert.equal(progress.extract(call('search', { title: 'Find references', query: 'PRIVATE QUERY' }, 'search')).title, 'Find references')
  const longTitle = progress.extract(call('bash', { description: '检查'.repeat(200) }, 'long-title')).title
  assert.ok(longTitle.length <= 160)
  assert.match(longTitle, /…（已截断）$/)
})

test('shell failure follows the exact upstream terminal marker, without exposing output', () => {
  for (const name of ['bash', 'pwsh', 'exec']) {
    for (const [text, failed, summary] of [
      ['PRIVATE STDOUT\n[exit code: 17]', true, '退出码：17'],
      ['PRIVATE STDERR\n[killed by signal: PRIVATE SIGNAL]', true, '被信号终止'],
      ['PRIVATE STDOUT\n[exit code: 0]', false, '退出码：0'],
      ['PRIVATE STDOUT', false, undefined],
      ['[exit code: 17]', false, undefined],
      ['PRIVATE\n[exit code: 17]\nmore text', false, undefined],
      ['PRIVATE\n[Exit code: 17]', false, undefined],
      ['PRIVATE\n[exit code: 17]\n', false, undefined],
    ]) {
      const progress = createProgressEvents()
      progress.extract(call(name, { description: 'Run checks' }))
      assert.deepEqual(progress.extract(result(text)), { kind: 'tool-end', id: 'call-1', failed, ...(summary && { summary }) })
    }
  }
  const progress = createProgressEvents()
  progress.extract(call('read', {}))
  assert.deepEqual(progress.extract(result('PRIVATE\n[exit code: 17]')), { kind: 'tool-end', id: 'call-1', failed: false })
})

test('truthy errors preserve failure semantics without exposing malformed metadata or reasons', () => {
  for (const [extra, failed] of [
    [{ error: { code: 'E_FAILURE', reason: 'PRIVATE REASON' } }, true],
    [{ message: { toolCallId: 'call-1', isError: true } }, true],
    [{ message: { toolCallId: 'call-1', isError: 'false' } }, false],
    [{ error: {} }, true], [{ error: 'PRIVATE ERROR' }, true],
    [{ error: { code: {} } }, true], [{ error: { code: '' } }, true],
    [{ error: null }, false], [{ error: false }, false],
  ]) {
    const progress = createProgressEvents()
    progress.extract(call('read', {}))
    const item = progress.extract(result('PRIVATE OUTPUT', { meta: { status: 'success', content: 'PRIVATE FILE' }, ...extra }))
    assert.equal(item.failed, failed)
    assert.equal(item.summary, failed ? '工具报告错误' : '状态：成功')
    assert.doesNotMatch(JSON.stringify(item), /PRIVATE/)
  }
})

test('only known error codes yield fixed Chinese diagnoses; raw reasons never enter summaries', () => {
  for (const [code, summary] of [
    ['permission_denied', '工具报告错误（permission_denied）：权限不足'],
    ['TaskTimeout', '工具报告错误（tasktimeout）：任务超时'],
    ['INVALID_ARGS', '工具报告错误（invalid_args）：工具参数不符合要求'],
    ['PRIVATE_RAW_ERROR', '工具报告错误'],
  ]) {
    const progress = createProgressEvents()
    progress.extract(call('read', {}))
    const item = progress.extract(result('PRIVATE OUTPUT', { error: { code, reason: 'PRIVATE REASON bf_secret' } }))
    assert.deepEqual(item, { kind: 'tool-end', id: 'call-1', failed: true, summary })
  }
})

test('structured summaries allow only enum statuses and nonnegative safe integer counts', () => {
  for (const fromMeta of [true, false]) {
    const progress = createProgressEvents()
    progress.extract(call('search', {}))
    const structured = { status: 'completed', count: 3, total: 9, matched: -1, updated: 'PRIVATE',
      created: 1.5, deleted: Number.MAX_SAFE_INTEGER + 1, stdout: 'PRIVATE STDOUT', path: '/root/PRIVATE',
      content: 'PRIVATE FILE', nested: { status: 'PRIVATE' } }
    const item = progress.extract(result(fromMeta ? 'PRIVATE STDOUT' : JSON.stringify(structured), fromMeta ? { meta: structured } : {}))
    assert.deepEqual(item, { kind: 'tool-end', id: 'call-1', failed: false, summary: '状态：已完成；返回数量：3；总数：9' })
  }
  const progress = createProgressEvents()
  progress.extract(call('read', {}))
  assert.equal(progress.extract(result('{bad json', { meta: { status: 'PRIVATE STATUS', count: '3' } })).summary, undefined)
  progress.extract(call('search', {}, 'counts'))
  assert.equal(progress.extract(result('', { meta: { matched: 2, updated: 1, created: 0, deleted: 0 } }, 'counts')).summary,
    '匹配数量：2；更新数量：1；创建数量：0；删除数量：0')
})

test('public assistant text is extracted for the renderer label; interrupted messages, streams and reasoning are excluded', () => {
  const progress = createProgressEvents()
  const data = { message: { content: [
    { type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'thinking', text: 'PRIVATE THINKING' },
    { type: 'text', text: 'Checking the report.' }, { type: 'tool-call', arguments: 'PRIVATE ARGS' },
    { type: 'text', text: 'Next I will compare totals.' },
  ] }, stream: [{ text: 'PRIVATE STREAM' }] }
  assert.deepEqual(progress.extract(event('assistant/message', data)), {
    kind: 'note', text: 'Checking the report. Next I will compare totals.',
  })
  assert.equal(progress.extract(event('assistant/message', { ...data, interrupted: true })), undefined)
  assert.equal(progress.extract(event('assistant/attempt', data)), undefined)
  assert.equal(progress.extract(event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'PRIVATE' }] } })), undefined)
})

test('malformed and oversized metadata is safe, calls are paired, bounded and cleared', () => {
  const progress = createProgressEvents()
  for (const data of [null, {}, [], { name: {}, callId: 'x' }, { name: 'bash', callId: {} }]) {
    assert.equal(progress.extract({ type: 'tool/call', data }), undefined)
  }
  for (const [i, args] of ['{bad', 'null', '[]', '"string"', 'x'.repeat(17000), { description: 'not JSON' }].entries()) {
    assert.deepEqual(progress.extract(event('tool/call', { callId: `bad-${i}`, name: 'bash', arguments: args })),
      { kind: 'tool-start', id: `bad-${i}`, name: 'bash' })
  }
  progress.clear()
  assert.equal(progress.extract(result('unpaired')), undefined)
  for (let i = 0; i < 256; i++) assert.ok(progress.extract(call('bash', {}, `call-${i}`)))
  assert.equal(progress.extract(call('bash', {}, 'overflow')), undefined)
  assert.equal(progress.extract(call('read', {}, 'call-1')), undefined)
  assert.equal(progress.extract(result('private\n[exit code: 9]')).failed, true)
  assert.equal(progress.extract(result('duplicate')), undefined)
  assert.ok(progress.extract(call('read', {}, 'next')))
  progress.clear()
  assert.equal(progress.extract(result('late', {}, 'next')), undefined)
  assert.equal(createProgressEvents().extract(result('foreign')), undefined)
  // This is a pending-call cap, not a lifetime cap: long tasks retain titles.
  for (let i = 0; i < 600; i++) {
    const id = `long-${i}`
    assert.equal(progress.extract(call('bash', { description: `检查 ${i}` }, id)).title, `检查 ${i}`)
    assert.ok(progress.extract(result('private', {}, id)))
  }
})

test('public text scrubber removes known credentials, private paths, code and active markup', () => {
  const text = [
    'A useful public update.', '```sh\nPRIVATE COMMAND\n```', '~~~text\nPRIVATE FILE\n~~~',
    'Bearer abcdef.123456', 'sk-abcdefgh12345678', 'ghp_abcdefgh12345678',
    'bf_private_fixture app_private_fixture bf_x app_x',
    'api_key="PRIVATE API KEY" password=PRIVATE_PASSWORD {"token":"PRIVATE_TOKEN"}',
    '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE KEY BODY\n-----END RSA PRIVATE KEY-----',
    'C:\\Users\\Private\\.ssh\\id_rsa /home/private/.env /etc/secret ~/secret \\\\server\\private',
    '[public label](javascript:bad) ![image](https://bad.invalid/secret)', '<https://bad.invalid>', '**bold** `inline` # heading',
  ].join('\n')
  const clean = safeProgressText(text, 2000)
  assert.match(clean, /A useful public update/)
  assert.match(clean, /public label/)
  assert.doesNotMatch(clean, /PRIVATE|abcdef|Users|\/home|\/etc|server|javascript:|https:|bf_|app_|private_fixture|[\[\]()`*<>\\]/)
  assert.equal(safeProgressText(null), '')
  assert.equal(safeProgressText({ text: 'do not stringify' }), '')
  assert.equal(safeProgressText('hello', 0), '')
  assert.equal(safeProgressText('hello', -1), '')
  assert.equal(safeProgressText('hello', NaN), 'hello')
  assert.ok(safeProgressText('x'.repeat(1000)).length <= 400)
  assert.match(safeProgressText('x'.repeat(20000)), /…（已截断）$/)
  assert.equal(safeProgressText('x'.repeat(100), 2), '……')
  assert.doesNotMatch(safeProgressText('Before\n```sh\nPRIVATE UNCLOSED'), /PRIVATE/)
  assert.doesNotMatch(safeProgressText('-----BEGIN PRIVATE KEY-----\nPRIVATE UNCLOSED'), /PRIVATE/)
})
