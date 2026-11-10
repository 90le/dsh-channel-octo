import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { BOT_COMMANDS, botCommandMenu, setBotCommands } from '../src/bot-commands.js'
import { Accounts } from '../src/accounts.js'
import { registerWeb } from '../src/web.js'
import { createAccountView, createBotCommandMenu } from '../src/account-view.js'
import { parseSafeCommand } from '../src/im-controls.js'

const token = 'bf_synthetic_menu_fixture'
const signal = () => new AbortController().signal
const expected = [
  { command: 'help', description: '查看频道命令帮助' },
  { command: 'status', description: '查看当前会话状态' },
  { command: 'new', description: '开始新会话' },
  { command: 'stop', description: '停止当前频道正在处理的任务' },
]

test('menu is a fixed copy of supported command metadata; only explicit clear yields []', () => {
  assert.deepEqual(botCommandMenu('publish'), expected)
  assert.deepEqual(botCommandMenu('clear'), [])
  const copy = botCommandMenu('publish')
  copy[0].command = 'other'
  copy.pop()
  assert.deepEqual(BOT_COMMANDS, expected)
  assert.ok(Object.isFrozen(BOT_COMMANDS) && BOT_COMMANDS.every(Object.isFrozen))
  for (const action of [undefined, null, '', 'Publish', 'remove', false, [], {}, { commands: [] }]) {
    assert.throws(() => botCommandMenu(action), /^Error: invalid_bot_commands$/)
  }
  for (const { command } of expected) {
    const route = { routeAllowed: true, actorApproved: true, channelType: 1 }
    assert.equal(parseSafeCommand('/' + command, { dmCommands: 'safe' }, route).command, command)
    assert.equal(parseSafeCommand('/' + command, { dmCommands: 'off' }, route).kind, 'blocked')
  }
})

test('official wire contract uses POST setCommands, bearer auth, command names without slashes and explicit empty array', async () => {
  for (const credential of [token, 'bf_synthetic_menu_fixture_other']) {
    for (const action of ['publish', 'clear']) {
      const calls = []
      const result = await setBotCommands({ apiBase: 'https://octo.invalid/api/', token: credential,
        fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ status: 200 }) },
      }, action, signal())
      assert.equal(calls.length, 1)
      const [{ url, init }] = calls
      assert.equal(url, 'https://octo.invalid/api/v1/bot/setCommands')
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'manual')
      assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential })
      assert.deepEqual(JSON.parse(init.body), { commands: action === 'publish' ? expected : [] })
      assert.ok(init.signal instanceof AbortSignal)
      assert.deepEqual(result, { action, count: action === 'publish' ? expected.length : 0 })
    }
  }
})

test('invalid actions, tokens and destinations fail before transport; errors reveal no input', async () => {
  let calls = 0
  const config = { apiBase: 'https://octo.invalid', token, fetchImpl: () => { calls++; throw Error('unexpected') } }
  for (const action of [undefined, null, {}, 'delete']) {
    await assert.rejects(setBotCommands(config, action, signal()), /^Error: invalid_bot_commands$/)
  }
  for (const value of [undefined, '', 'uk_fixture', 'bf_unsafe\nvalue']) {
    await assert.rejects(setBotCommands({ ...config, token: value }, 'publish', signal()), /^Error: invalid_bot_token$/)
  }
  await assert.rejects(setBotCommands({ ...config, token: 'app_synthetic_menu_fixture' }, 'publish', signal()),
    /^Error: app_bot_operation_unavailable$/)
  for (const apiBase of ['http://octo.invalid', 'https://name:secret@octo.invalid', 'https://octo.invalid?secret=x', 'bad-secret-url']) {
    await assert.rejects(setBotCommands({ ...config, apiBase }, 'publish', signal()), /^Error: bot_commands_failed$/)
  }
  const controller = new AbortController()
  controller.abort(Error('secret-reason'))
  await assert.rejects(setBotCommands(config, 'clear', controller.signal), /^Error: bot_commands_failed$/)
  assert.equal(calls, 0)
})

test('HTTP failures, redirects, malformed/oversized replies and application errors are sanitized and never retried', async () => {
  const responses = [
    () => new Response(token, { status: 401 }), () => new Response(token, { status: 403 }),
    () => new Response(token, { status: 429, headers: { 'retry-after': '2' } }),
    () => new Response(token, { status: 500 }),
    () => new Response(token, { status: 302, headers: { location: 'https://other.invalid' } }),
    () => new Response(null, { status: 204 }), () => new Response('not-json ' + token),
    () => Response.json({ status: 400, msg: token }), () => Response.json({ status: 200, error: token }),
    () => Response.json({ status: 200, ok: false }), () => Response.json({ status: '200' }),
    () => Response.json({}), () => Response.json(null), () => Response.json([]),
    () => Response.json({ status: 200, padding: 'x'.repeat(16384) }),
    () => { throw Error('network error ' + token) },
  ]
  for (const response of responses) {
    let calls = 0
    await assert.rejects(setBotCommands({ apiBase: 'https://octo.invalid', token,
      fetchImpl: async () => { calls++; return response() },
    }, 'publish', signal()), /^Error: bot_commands_failed$/)
    assert.equal(calls, 1)
  }
})

test('abort propagates to the request and a bounded reader cancels oversized/error responses', async () => {
  const controller = new AbortController()
  let cancelled = 0
  for (const status of [200, 500]) {
    await assert.rejects(setBotCommands({ apiBase: 'https://octo.invalid', token,
      fetchImpl: async () => new Response(new ReadableStream({
        pull(c) { c.enqueue(new Uint8Array(16385)) }, cancel() { cancelled++ },
      }), { status }),
    }, 'publish', signal()), /bot_commands_failed/)
  }
  assert.equal(cancelled, 2)
  await assert.rejects(setBotCommands({ apiBase: 'https://octo.invalid', token,
    fetchImpl: async (_url, init) => {
      controller.abort(Error(token))
      assert.equal(init.signal.aborted, true)
      throw init.signal.reason
    },
  }, 'publish', controller.signal), /^Error: bot_commands_failed$/)
})

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-menu-'))
  const secrets = new Map()
  const calls = []
  const state = { reply: () => Response.json({ status: 200 }) }
  const ctx = {
    logger: () => ({ info() {}, error() {} }),
    get: name => name === 'credentials' ? {
      set: async (key, value) => { secrets.set(key, value) },
      resolve: async key => ({ value: secrets.get(key) }),
      unset: async key => { secrets.delete(key) },
    } : undefined,
  }
  const deployment = { apiBase: 'https://octo.invalid/api', stateDir: root, cwd: root }
  const accounts = new Accounts(ctx, deployment, { env: {}, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    if (url === deployment.apiBase + '/v1/auth/verify-bot') {
      const credential = JSON.parse(init.body).bot_token
      return Response.json({ bot_uid: state.botUid ?? (credential === 'bf_second_fixture' ? 'bot-second' : 'bot-fixture'),
        space_id: 'space-fixture', owner_uid: 'owner-fixture' })
    }
    assert.equal(url, deployment.apiBase + '/v1/bot/setCommands', 'all HTTP is intercepted; no live requests')
    return state.reply(init)
  } })
  // Exercise real storage and guards without starting any background transport.
  accounts.start = runtime => { runtime.status = runtime.record.enabled ? 'online' : 'disabled' }
  t.after(async () => {
    await accounts.dispose()
    assert.equal(dirname(root), tmpdir())
    assert.ok(basename(root).startsWith('dsh-octo-menu-'))
    rmSync(root, { recursive: true, force: true })
  })
  await accounts.initialize()
  assert.equal(calls.length, 0, 'initialization does not write the native menu')
  const saved = await accounts.save(null, { revision: accounts.revision,
    account: { token, label: 'Fixture', cwd: root, enabled: false } })
  assert.ok(calls.every(call => call.url.endsWith('/verify-bot')), 'saving an account only verifies identity')
  calls.length = 0
  return { accounts, root, calls, state, secrets, id: saved.accountId }
}

test('configured paused account explicitly publishes/clears; runtime policy and persisted account stay unchanged', async t => {
  const { accounts, calls, id, root } = await fixture(t)
  const record = structuredClone(accounts.record(id))
  const settings = accounts.runtimes.get(id).settings
  const before = readFileSync(join(root, 'accounts.json'), 'utf8')
  for (const action of ['publish', 'clear']) {
    const prior = accounts.revision
    const result = await accounts.updateBotCommands(id, { revision: prior, action })
    assert.notEqual(result.accountRevision, prior)
    assert.deepEqual(result.botCommands, { action, count: action === 'publish' ? expected.length : 0 })
    assert.equal(result.accounts[0].enabled, false)
    assert.equal(result.accounts[0].dmCommands, 'off')
    assert.equal(result.accounts[0].groupCommands, 'off')
    assert.doesNotMatch(JSON.stringify(result), /bf_synthetic|DSH_OCTO_ACCOUNT_/)
    assert.deepEqual(accounts.record(id), record)
    assert.equal(accounts.runtimes.get(id).settings, settings)
  }
  assert.equal(readFileSync(join(root, 'accounts.json'), 'utf8'), before)
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), [
    '/api/v1/auth/verify-bot', '/api/v1/bot/setCommands', '/api/v1/auth/verify-bot', '/api/v1/bot/setCommands',
  ])
  assert.deepEqual(JSON.parse(calls[3].init.body), { commands: [] })
})

test('wrong revision, removed/missing/invalid/transitioning accounts and malformed actions cannot publish', async t => {
  const { accounts, id, calls, secrets } = await fixture(t)
  const input = () => ({ revision: accounts.revision, action: 'publish' })
  await assert.rejects(accounts.updateBotCommands(id, { ...input(), revision: 'old' }), /account_changed/)
  for (const action of [undefined, null, '', false, 'remove', [], {}]) {
    await assert.rejects(accounts.updateBotCommands(id, { ...input(), action }), /invalid_bot_commands/)
  }
  for (const extra of [{ commands: [] }, { token: 'bf_forged' }, { apiBase: 'https://other.invalid' }, { accountId: 'legacy' }]) {
    await assert.rejects(accounts.updateBotCommands(id, { ...input(), ...extra }), /invalid_bot_commands/)
  }
  await assert.rejects(accounts.updateBotCommands('missing', input()), /account_not_found/)
  const runtime = accounts.runtimes.get(id)
  runtime.changing = true
  await assert.rejects(accounts.updateBotCommands(id, input()), /account_transition/)
  runtime.changing = false
  accounts.runtimes.delete(id)
  await assert.rejects(accounts.updateBotCommands(id, input()), /channel_not_configured/)
  accounts.runtimes.set(id, runtime)
  const key = accounts.record(id).secretRef
  secrets.delete(key)
  await assert.rejects(accounts.updateBotCommands(id, input()), /invalid_bot_token/)
  accounts.record(id).removed = true
  await assert.rejects(accounts.updateBotCommands(id, input()), /account_not_found/)
  accounts.ready = false
  await assert.rejects(accounts.updateBotCommands(id, input()), /accounts_unavailable/)
  assert.equal(calls.length, 0)
})

test('identity mismatch blocks replacement and upstream failure does not report success or leak secrets', async t => {
  const { accounts, id, calls, state } = await fixture(t)
  const revision = accounts.revision
  state.botUid = 'wrong-bot'
  await assert.rejects(accounts.updateBotCommands(id, { revision, action: 'publish' }), /bot_identity_mismatch/)
  assert.equal(calls.length, 1)
  state.botUid = undefined
  state.reply = () => { throw Error(token) }
  await assert.rejects(accounts.updateBotCommands(id, { revision, action: 'clear' }), /^Error: bot_commands_failed$/)
  assert.equal(accounts.revision, revision)
  assert.equal(calls.length, 3)
})

test('existing legacy account uses its pinned identity and synthetic environment token; pause never clears its menu', async t => {
  const { accounts, id, calls } = await fixture(t)
  // Reuse a fully validated runtime to model the deployment-owned legacy record.
  // Initialization of this path is already exercised by the account regression suite.
  const runtime = accounts.runtimes.get(id)
  const record = { ...accounts.record(id), id: 'legacy', secretRef: undefined }
  accounts.records.delete(id)
  accounts.runtimes.delete(id)
  accounts.records.set('legacy', record)
  accounts.runtimes.set('legacy', runtime)
  runtime.record = record
  accounts.env.DSH_OCTO_BOT_TOKEN = token
  await accounts.setEnabled('legacy', { revision: accounts.revision, enabled: true })
  assert.equal(calls.length, 0)
  const invoke = web(accounts)
  assert.equal((await invoke({ body: { revision: accounts.revision, action: 'publish' } })).status, 200)
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + token)
  calls.length = 0
  await accounts.setEnabled('legacy', { revision: accounts.revision, enabled: false })
  assert.equal(calls.length, 0)
  assert.equal((await invoke({ body: { revision: accounts.revision, action: 'clear' } })).status, 200)
  assert.deepEqual(JSON.parse(calls[1].init.body), { commands: [] })
})

test('startup, saves, pause, reconnect and removal never replace or clear the menu; account identity is isolated', async t => {
  const { accounts, id, calls, root } = await fixture(t)
  await accounts.save(id, { revision: accounts.revision, account: { dmCommands: 'safe', label: 'Renamed' } })
  await accounts.setEnabled(id, { revision: accounts.revision, enabled: true })
  await accounts.reconnect(id, { revision: accounts.revision })
  await accounts.setEnabled(id, { revision: accounts.revision, enabled: false })
  const other = await accounts.save(null, { revision: accounts.revision,
    account: { token: 'bf_second_fixture', label: 'Other', cwd: root, enabled: false } })
  assert.ok(calls.every(c => c.url.endsWith('/verify-bot')))
  calls.length = 0
  await accounts.updateBotCommands(other.accountId, { revision: accounts.revision, action: 'publish' })
  assert.equal(calls[1].init.headers.Authorization, 'Bearer bf_second_fixture')
  calls.length = 0
  await accounts.remove(id, { revision: accounts.revision })
  await accounts.remove(other.accountId, { revision: accounts.revision })
  assert.equal(calls.length, 0)
  await assert.rejects(accounts.updateBotCommands(id, { revision: accounts.revision, action: 'clear' }), /account_not_found/)
})

test('account lock serializes replacements and rejects a second click with the previous revision', async t => {
  const { accounts, id, calls, state } = await fixture(t)
  let release, started
  const reached = new Promise(resolve => { started = resolve })
  state.reply = () => { started(); return new Promise(resolve => { release = resolve }) }
  const revision = accounts.revision
  const first = accounts.updateBotCommands(id, { revision, action: 'publish' })
  await reached
  const second = accounts.updateBotCommands(id, { revision, action: 'clear' })
  const rejected = assert.rejects(second, /account_changed/)
  release(Response.json({ status: 200 }))
  await first
  await rejected
  assert.equal(calls.filter(c => c.url.endsWith('/setCommands')).length, 1)
})

function web(accounts, rejection = request => request.headers.authorization === 'fixture-owner-session' ? undefined : 401) {
  let handler
  registerWeb({ get: () => ({ requestRejection: rejection }),
    webServer: { register(route) { handler = route.handler } },
  }, accounts)
  return async ({ id = 'legacy', method = 'POST', headers = {}, body = {}, raw } = {}) => {
    const request = Readable.from([Buffer.from(raw ?? JSON.stringify(body))])
    Object.assign(request, { method, url: '/api/dsh-channel-octo/accounts/' + id + '/commands', headers: {
      authorization: 'fixture-owner-session', 'content-type': 'application/json', 'x-dsh-octo-client': '1', ...headers,
    } })
    let status, responseHeaders, data
    await handler(request, { writeHead(code, fields) { status = code; responseHeaders = fields }, end(value) { data = JSON.parse(value) } })
    return { status, headers: responseHeaders, data }
  }
}

test('HTTP owner-session gate, CSRF headers, method, revision and account guards protect the menu route', async t => {
  const { accounts, id, calls } = await fixture(t)
  const invoke = web(accounts)
  const body = { revision: accounts.revision, action: 'publish' }
  for (const headers of [{ authorization: '' }, { authorization: 'other-session' }]) {
    assert.equal((await invoke({ id, body, headers })).status, 401)
  }
  for (const headers of [{ 'x-dsh-octo-client': '' }, { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await invoke({ id, body, headers })).status, 403)
  }
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await invoke({ id, body, method })).status, 404)
  assert.equal((await invoke({ id: 'bad-id', body })).status, 404)
  assert.equal((await invoke({ id, body: { ...body, revision: 'old' } })).status, 409)
  assert.equal((await invoke({ id, body: { ...body, commands: [] } })).status, 400)
  assert.equal((await invoke({ id, raw: '{invalid' })).status, 400)
  assert.equal((await invoke({ id, raw: 'x'.repeat(16385) })).status, 400)
  assert.equal((await invoke({ body })).status, 404)
  assert.equal(calls.length, 0)
  const result = await invoke({ id, body, headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(result.status, 200)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.deepEqual(result.data.botCommands, { action: 'publish', count: 4 })
  assert.equal(calls.length, 2)
  assert.equal((await web(accounts, () => 403)({ id, body })).status, 403)
  assert.equal(calls.length, 2)
})

test('HTTP response maps upstream failures to sanitized 502 and fails closed without host authentication', async t => {
  const { accounts, id, state } = await fixture(t)
  state.reply = () => Response.json({ status: 500, msg: token })
  const response = await web(accounts)({ id, body: { revision: accounts.revision, action: 'clear' } })
  assert.equal(response.status, 502)
  assert.deepEqual(response.data, { error: 'bot_commands_failed' })
  assert.equal((await web(accounts, null)({ id })).status, 503)
})

function renderer(factory) {
  const slots = []
  let index = 0
  const React = {
    useEffect() {}, useId: () => 'fixture',
    useState(initial) {
      const key = index++
      if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial
      return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next }]
    },
    useRef(current) { const key = index++; return slots[key] ??= { current } },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  }
  const Component = factory(React)
  return props => { index = 0; return Component(props) }
}
const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [node]
const button = (tree, text) => nodes(tree).find(node => node?.type === 'button' && node.children.includes(text))
const textOf = tree => nodes(tree).filter(node => typeof node === 'string').join('\n')

test('Chinese UI previews the four commands, requires explicit confirmation and sends no request on render/cancel', async () => {
  const render = renderer(React => createBotCommandMenu(React, { Button: 'button' }))
  const calls = []
  const props = { lang: 'zh', perform: async action => { calls.push(action) } }
  let tree = render(props)
  assert.match(textOf(tree), /发布会替换此 Bot 的全部现有菜单/)
  assert.match(textOf(tree), /命令权限仍按当前设置/)
  assert.match(textOf(tree), /\/help · \/status · \/new · \/stop/)
  assert.equal(calls.length, 0)
  button(tree, '发布菜单').props.onClick()
  tree = render(props)
  assert.match(textOf(tree), /确认替换现有菜单/)
  button(tree, '取消').props.onClick()
  tree = render(props)
  assert.equal(button(tree, '确认'), undefined)
  assert.equal(calls.length, 0)
  for (const [label, action, notice] of [['发布菜单', 'publish', '命令菜单已发布'], ['清空菜单', 'clear', '命令菜单已清空']]) {
    button(tree, label).props.onClick()
    tree = render(props)
    await button(tree, '确认').props.onClick()
    tree = render(props)
    assert.equal(calls.at(-1), action)
    assert.match(textOf(tree), new RegExp(notice))
  }
  assert.deepEqual(calls, ['publish', 'clear'])
})

test('UI prevents duplicate submits, disables unavailable/busy accounts and sanitizes arbitrary errors', async () => {
  const render = renderer(React => createBotCommandMenu(React, { Button: 'button' }))
  let resolve, calls = 0
  const props = { lang: 'zh', perform: () => { calls++; return new Promise(done => { resolve = done }) } }
  for (const state of [{ disabled: true }, { busy: true }]) {
    const tree = render({ ...props, ...state })
    assert.equal(button(tree, '发布菜单').props.disabled, true)
    assert.equal(button(tree, '清空菜单').props.disabled, true)
    button(tree, '发布菜单').props.onClick()
    assert.equal(button(render(props), '确认'), undefined)
  }
  button(render(props), '发布菜单').props.onClick()
  const confirm = button(render(props), '确认').props.onClick
  const pending = confirm()
  await confirm()
  assert.equal(calls, 1)
  assert.equal(button(render(props), '清空菜单').props.disabled, true)
  resolve()
  await pending
  const bad = { ...props, perform: async () => { throw Error(token) } }
  button(render(bad), '清空菜单').props.onClick()
  await button(render(bad), '确认').props.onClick()
  const tree = render(bad)
  assert.match(textOf(tree), /操作未完成/)
  assert.doesNotMatch(textOf(tree), new RegExp(token))
  assert.ok(nodes(tree).some(node => node?.props?.role === 'alert'))
})

test('account modal connects menu to the authenticated request helper with current account and revision', async () => {
  const requests = []
  let published
  const services = { request: async (suffix, options) => {
    requests.push({ suffix, options })
    return { accounts: [], accountRevision: 'next-revision' }
  }, status: () => null, label: () => '' }
  const render = renderer(React => createAccountView(React, { Button: 'button', Switch: 'switch' }, services))
  const account = { id: 'legacy', label: 'Fixture', enabled: false, config: {} }
  const props = { lang: 'zh', data: { accounts: [account], canManage: true, accountRevision: 'original' },
    choose() {}, publish: next => { published = next }, refresh() {} }
  button(render(props), '设置').props.onClick()
  const modalNode = nodes(render(props)).find(node => typeof node?.type === 'function' && node.type.name === 'Modal')
  assert.ok(modalNode)
  const renderModal = renderer(() => modalNode.type)
  const modal = renderModal(modalNode.props)
  const menu = nodes(modal).find(node => typeof node?.type === 'function' && node.type.name === 'BotCommandMenu')
  assert.ok(menu)
  assert.equal(menu.props.disabled, false, 'paused configured account can still manage its menu')
  assert.equal(requests.length, 0)
  await menu.props.perform('publish')
  await menu.props.perform('clear')
  assert.equal(published.accountRevision, 'next-revision')
  assert.deepEqual(requests.map(r => [r.suffix, r.options.method, JSON.parse(r.options.body)]), [
    ['/accounts/legacy/commands', 'POST', { action: 'publish', revision: 'original' }],
    ['/accounts/legacy/commands', 'POST', { action: 'clear', revision: 'next-revision' }],
  ])
  assert.deepEqual(requests[0].options.headers, { 'Content-Type': 'application/json', 'x-dsh-octo-client': '1' })
})
