import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { Accounts } from '../src/accounts.js'
import { resolveConfig, validBotIdentity } from '../src/config.js'
import { channelView, registerWeb } from '../src/web.js'
import { createAccountEditor } from '../src/account-editor.js'
import { createAccountView } from '../src/account-view.js'

const appIdentity = { botUid: 'app_fixture_bot', botKind: 'app', spaceId: null }
const userIdentity = { botUid: 'fixture-user-bot', spaceId: 'fixture-space' }
const token = 'app_fixture_secret'
const rotatedToken = 'app_rotated_secret'
const connectionSecret = 'fixture-private-im-token'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-app-accounts-'))
  const secrets = new Map(), requests = [], logs = [], instances = []
  const services = {
    credentials: {
      resolve: async key => ({ value: secrets.get(key) }),
      set: async (key, value) => { secrets.set(key, value) },
      unset: async key => { secrets.delete(key) },
    },
    workspaceRegistry: { list: () => [{ path: root }] },
    permissionPresets: { names: ['workspace-write'], optionOf: () => ({ name: 'Workspace write' }) },
  }
  const deployment = { apiBase: 'https://octo.invalid/api', stateDir: root, cwd: root, hostPermissions: ['workspace-write'] }
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname
    assert.equal(new URL(url).origin, 'https://octo.invalid')
    requests.push(path)
    if (path === '/api/v1/bot/register') {
      const credential = options.headers.Authorization.slice('Bearer '.length)
      assert.equal(options.method, 'POST')
      assert.equal(options.body, '{}')
      return Response.json({ robot_id: credential === 'app_other_secret' ? 'app_other_bot' : appIdentity.botUid,
        owner_uid: 'fixture-owner', im_token: connectionSecret, ws_url: 'wss://im.octo.invalid/ws?key=private-ws-key' })
    }
    assert.equal(path, '/api/v1/auth/verify-bot', 'unexpected network operation')
    const credential = JSON.parse(options.body).bot_token
    return Response.json({ bot_uid: credential === 'bf_same_uid_secret' ? appIdentity.botUid : userIdentity.botUid,
      space_id: userIdentity.spaceId })
  }
  const make = (fetcher = fetchImpl, env = {}) => {
    const accounts = new Accounts({ get: key => services[key], logger: () => ({
      info: line => logs.push(line), error: line => logs.push(line),
    }) }, deployment, { fetchImpl: fetcher, env })
    instances.push(accounts)
    return accounts
  }
  t.after(async () => {
    for (const account of instances) await account.dispose().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })
  const add = (accounts, changes = {}) => accounts.save(null, { revision: accounts.revision,
    account: { label: 'App fixture', cwd: root, token, enabled: false, ...changes } })
  const edit = (accounts, accountId, changes) => accounts.save(accountId, { revision: accounts.revision, account: changes })
  return { root, secrets, requests, logs, deployment, make, add, edit, file: join(root, 'accounts.json') }
}

test('identity helper accepts only explicit canonical null-space App identities and preserves User identities', () => {
  for (const identity of [appIdentity, userIdentity, { ...userIdentity, botKind: 'user' },
    { ...userIdentity, botUid: appIdentity.botUid }]) assert.equal(validBotIdentity(identity), true)
  for (const identity of [null, {}, { ...appIdentity, botKind: undefined }, { ...appIdentity, botKind: 'user' },
    { ...appIdentity, spaceId: 'invented-space' }, { ...appIdentity, spaceId: undefined },
    { ...appIdentity, botUid: 'ordinary-bot' }, { ...appIdentity, botUid: 'app__bot' },
    { ...appIdentity, botUid: 'app_fixture.other_bot' }, { ...appIdentity, botUid: 'app_' + 'a'.repeat(128) + '_bot' },
    { ...userIdentity, spaceId: '' }, { ...userIdentity, botKind: null }, { ...userIdentity, botKind: 'unknown' }]) {
    assert.equal(validBotIdentity(identity), false, JSON.stringify(identity))
  }
})

test('App config derives its kind, requires WebSocket and DM-only policy without adding tool gates', () => {
  const base = { apiBase: 'https://octo.invalid/api', cwd: process.cwd(), ...appIdentity, senderPolicy: 'octo' }
  const resolve = changes => resolveConfig({ ...base, ...changes }, { DSH_OCTO_BOT_TOKEN: token })
  for (const botKind of [undefined, 'app']) for (const toolScope of ['private', 'owner', 'admitted']) {
    const config = resolve({ botKind, toolScope })
    assert.equal(config.botKind, 'app')
    assert.equal(config.spaceId, null)
    assert.equal(config.transport, 'websocket')
    assert.equal(config.toolScope, toolScope)
    assert.deepEqual([...config.allowed], [])
    assert.equal(channelView(config).botKind, 'app')
    assert.ok(!JSON.stringify(channelView(config)).includes(token))
  }
  assert.equal(resolve({ senderPolicy: 'allowlist', allowedUids: ['fixture-user'] }).allowed.has('fixture-user'), true)
  assert.throws(() => resolve({ transport: 'events' }), /app_bot_requires_websocket/)
  for (const changes of [{ allowedGroupIds: ['fixture-group'] }, { allowedThreadIds: ['a'.repeat(32) + '____123456789012345'] },
    { channelPolicy: 'joined' }, { mentionPolicy: 'octo' }]) {
    assert.throws(() => resolve(changes), /group_and_thread_require_user_bot/)
  }
  for (const changes of [{ botKind: 'user' }, { botKind: null }, { botKind: 'unknown' }]) {
    assert.throws(() => resolve(changes), /bot_identity_mismatch/)
  }
  for (const changes of [{ spaceId: 'invented' }, { spaceId: undefined }, { botUid: 'ordinary-bot' }]) {
    assert.throws(() => resolve(changes), /missing_bot_identity/)
  }
  const user = resolveConfig({ ...base, ...userIdentity, botKind: undefined }, { DSH_OCTO_BOT_TOKEN: 'bf_fixture_secret' })
  assert.equal(user.transport, 'events')
  assert.equal(Object.hasOwn(user, 'botKind'), false)
  assert.equal(Object.hasOwn(channelView(user), 'botKind'), false)
  assert.throws(() => resolveConfig(base, { DSH_OCTO_BOT_TOKEN: 'bf_fixture_secret' }), /bot_identity_mismatch/)
  assert.throws(() => resolveConfig({ ...base, botKind: undefined }, { DSH_OCTO_BOT_TOKEN: 'bf_fixture_secret' }), /missing_bot_identity/)
})

test('App accounts verify, save, edit, rotate and reload without persisting or returning registration secrets', async t => {
  const f = fixture(t)
  let accounts = f.make()
  await accounts.initialize()
  const verified = await accounts.verify(token)
  assert.deepEqual(verified, { ...appIdentity, ownerUid: 'fixture-owner' })
  assert.equal(f.secrets.size, 0)
  const result = await f.add(accounts, { toolScope: 'admitted', permission: 'workspace-write', dmCommands: 'safe' })
  const accountId = result.accountId
  assert.equal(result.accounts[0].botKind, 'app')
  assert.equal(result.accounts[0].spaceId, null)
  assert.equal(result.accounts[0].transport, 'websocket')
  assert.equal(result.accounts[0].config.botKind, 'app')
  assert.equal(result.accounts[0].dmCommands, 'safe')
  await f.edit(accounts, accountId, { label: 'Renamed App', toolScope: 'owner' })
  const before = readFileSync(f.file, 'utf8'), revision = accounts.revision
  await assert.rejects(f.add(accounts), /duplicate_bot/)
  await assert.rejects(f.edit(accounts, accountId, { token: 'app_other_secret' }), /bot_identity_mismatch/)
  await assert.rejects(f.edit(accounts, accountId, { token: 'bf_same_uid_secret' }), /bot_identity_mismatch/)
  assert.equal(readFileSync(f.file, 'utf8'), before)
  assert.equal(accounts.revision, revision)
  assert.equal(f.secrets.size, 1)
  const oldRef = accounts.record(accountId).secretRef
  await f.edit(accounts, accountId, { token: rotatedToken })
  assert.equal(f.secrets.has(oldRef), false)
  assert.equal(f.secrets.get(accounts.record(accountId).secretRef), rotatedToken)
  const runtime = accounts.runtimes.get(accountId)
  const savedRules = await accounts.saveRules(accountId, { revision: runtime.settings.revision(),
    settings: { progress: 'typing', timeoutMs: 5000 } })
  assert.equal(savedRules.config.progress, 'typing')
  assert.equal(savedRules.config.spaceId, null)
  await assert.rejects(accounts.saveRules(accountId, { revision: runtime.settings.revision(),
    settings: { channelPolicy: 'joined' } }), /group_and_thread_require_user_bot/)
  const calls = f.requests.length
  await assert.rejects(accounts.updateBotCommands(accountId, { revision: accounts.revision, action: 'publish' }), /app_bot_operation_unavailable/)
  await assert.rejects(accounts.manageWebhooks(accountId, { revision: accounts.revision, action: 'routes' }), /app_bot_operation_unavailable/)
  assert.equal(f.requests.length, calls, 'known unsupported management must not register or send a request')
  const userId = (await f.add(accounts, { label: 'User fixture', token: 'bf_fixture_secret' })).accountId
  assert.equal(accounts.record(userId).transport, 'websocket')
  assert.equal(Object.hasOwn(accounts.record(userId), 'botKind'), false)
  assert.equal(Object.hasOwn(accounts.publicAccount(accounts.record(userId)), 'botKind'), false)
  const publicData = JSON.stringify([verified, accounts.overview(), savedRules, f.logs])
  const disk = readFileSync(f.file, 'utf8')
  for (const secret of [token, rotatedToken, connectionSecret, 'private-ws-key', 'bf_fixture_secret']) {
    assert.ok(!publicData.includes(secret))
    assert.ok(!disk.includes(secret))
  }
  assert.ok(!publicData.includes('DSH_OCTO_ACCOUNT_'))
  assert.ok(!disk.includes('ownerUid'))
  await accounts.dispose()
  accounts = f.make()
  await accounts.initialize()
  assert.equal(accounts.ready, true)
  const restored = accounts.publicAccount(accounts.record(accountId))
  assert.equal(restored.botKind, 'app')
  assert.equal(restored.spaceId, null)
  assert.equal(restored.label, 'Renamed App')
  assert.equal(restored.toolScope, 'owner')
  assert.equal(restored.permission, 'workspace-write')
  assert.equal(restored.config.progress, 'typing')
  assert.equal(restored.transport, 'websocket')
  assert.deepEqual(await accounts.diagnose(accountId), verified)
  assert.equal(Object.hasOwn(accounts.record(userId), 'botKind'), false)
})

test('User to App rotation and cross-kind duplicate IDs are rejected; App tombstones restore the same account', async t => {
  const f = fixture(t), accounts = f.make()
  await accounts.initialize()
  const userId = (await f.add(accounts, { token: 'bf_same_uid_secret' })).accountId
  await assert.rejects(f.edit(accounts, userId, { token }), /bot_identity_mismatch/)
  await assert.rejects(f.add(accounts), /duplicate_bot/)
  await accounts.remove(userId, { revision: accounts.revision })
  await assert.rejects(f.add(accounts), /duplicate_bot/)
  const appId = (await f.add(accounts, { token: 'app_other_secret' })).accountId
  await accounts.remove(appId, { revision: accounts.revision })
  const restored = await f.add(accounts, { token: 'app_other_secret' })
  assert.equal(restored.accountId, appId)
  assert.equal(accounts.record(appId).botKind, 'app')
  assert.equal(accounts.record(appId).spaceId, null)
  assert.equal(accounts.record(appId).transport, 'websocket')
})

test('saved App records fail closed on noncanonical identities, invented spaces, missing kind or events transport', async t => {
  const f = fixture(t)
  let accounts = f.make()
  await accounts.initialize()
  await f.add(accounts)
  const saved = JSON.parse(readFileSync(f.file, 'utf8'))
  await accounts.dispose()
  for (const patch of [{ botKind: undefined }, { botKind: 'user' }, { botKind: null }, { spaceId: 'invented-space' },
    { spaceId: undefined }, { botUid: 'ordinary-bot' }, { transport: 'events' }]) {
    writeFileSync(f.file, JSON.stringify({ ...saved, accounts: [{ ...saved.accounts[0], ...patch }] }), { mode: 0o600 })
    accounts = f.make()
    await accounts.initialize()
    assert.equal(accounts.ready, false, JSON.stringify(patch))
    assert.equal(accounts.status, 'configuration_or_state_error')
    await accounts.dispose()
  }
})

test('malformed or secret-echoing verification responses return only a generic failure', async t => {
  const f = fixture(t)
  for (const response of [{ robot_id: 'ordinary-bot', owner_uid: 'fixture-owner' },
    { robot_id: 'app_' + token + '_bot', owner_uid: 'fixture-owner' },
    { robot_id: appIdentity.botUid, owner_uid: token }]) {
    const accounts = f.make(async () => Response.json({ ...response, im_token: connectionSecret, ws_url: 'wss://im.octo.invalid/ws' }))
    await accounts.initialize()
    await assert.rejects(accounts.verify(token), error => error.message === 'bot_verification_failed')
    assert.equal(f.secrets.size, 0)
    await accounts.dispose()
  }
  assert.ok(!JSON.stringify(f.logs).includes(token))
})

test('legacy config derives App kind and WebSocket while preserving implicit User kind and events transport', async t => {
  for (const app of [true, false]) {
    const f = fixture(t)
    Object.assign(f.deployment, app ? appIdentity : userIdentity, { enabled: true, senderPolicy: 'octo' })
    delete f.deployment.botKind
    const accounts = f.make(undefined, { DSH_OCTO_BOT_TOKEN: app ? token : 'bf_fixture_secret' })
    // Legacy installs enable reception at startup; keep this test entirely local.
    accounts.start = runtime => { runtime.status = 'test-paused' }
    await accounts.initialize()
    assert.equal(accounts.ready, true)
    const record = accounts.record('legacy'), config = accounts.runtimes.get('legacy').settings.config
    assert.equal(record.transport, app ? 'websocket' : 'events')
    assert.equal(config.transport, record.transport)
    assert.equal(Object.hasOwn(record, 'botKind'), app)
    assert.equal(Object.hasOwn(config, 'botKind'), app)
    assert.equal(config.spaceId, app ? null : userIdentity.spaceId)
    assert.equal(f.requests.length, 0)
  }
})

const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [node]
const textOf = tree => nodes(tree).filter(value => typeof value === 'string').join('\n')
function renderer() {
  const values = [], effects = []
  let index = 0
  const React = {
    Fragment: 'fragment', useEffect(effect) { effects.push(effect) }, useId: () => 'fixture',
    useState(initial) {
      const key = index++
      if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial
      return [values[key], next => { values[key] = typeof next === 'function' ? next(values[key]) : next }]
    },
    useRef(current) { const key = index++; return values[key] ??= { current } },
    createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children }) : { type, props: props ?? {}, children: children.flat(Infinity) },
  }
  return { React, effects, render(component, props) { index = 0; effects.length = 0; return component(props) } }
}

test('UI accepts a verified null-space App, clears its credential and localizes type and scope', async () => {
  for (const lang of ['zh', 'en']) {
    const ui = renderer(), saved = []
    const Editor = createAccountEditor(ui.React, { Button: 'button', Input: 'input' })
    const props = { lang, allowCredentials: true, options: { workspaces: [{ path: process.cwd() }], policies: [{ id: 'text-only' }] },
      onVerify: async input => { assert.equal(input.token, token); return { ...appIdentity, im_token: connectionSecret } },
      onSave: async fields => { saved.push(fields) } }
    let tree = ui.render(Editor, props)
    assert.match(textOf(tree), lang === 'zh' ? /注册该 Bot 的连接/ : /registers its connection/)
    const input = nodes(tree).find(node => node?.type === 'input' && node.props.type === 'password')
    input.props.ref.current = { value: token }
    await nodes(tree).find(node => node?.type === 'button' && textOf(node) === (lang === 'zh' ? '验证令牌' : 'Verify token')).props.onClick()
    assert.equal(input.props.ref.current.value, '')
    tree = ui.render(Editor, props)
    assert.match(textOf(tree), lang === 'zh' ? /Octo 管理的私聊范围/ : /Octo-managed DM scope/)
    assert.match(textOf(tree), lang === 'zh' ? /应用 Bot/ : /App Bot/)
    assert.doesNotMatch(textOf(tree), /空间 ID|Space ID/)
    assert.ok(!JSON.stringify(tree).includes(token))
    assert.ok(!JSON.stringify(tree).includes(connectionSecret))
    assert.ok(!nodes(tree).some(node => node?.props?.id === 'fixture-group-commands'))
    assert.ok(nodes(tree).some(node => node?.props?.id === 'fixture-dm-commands'))
    nodes(tree).find(node => node?.props?.id === 'fixture-cwd').props.onChange({ target: { value: process.cwd() } })
    tree = ui.render(Editor, props)
    await tree.props.onSubmit({ preventDefault() {} })
    // onSubmit starts the existing async save loop.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(saved.length, 1)
    assert.equal(saved[0].token, token)
    assert.equal(Object.hasOwn(saved[0], 'botKind'), false, 'server verification owns identity fields')
  }
})

test('UI rejects null-space User and malformed App verification while preserving valid User verification', async () => {
  const cases = [
    [token, appIdentity, true],
    [token, { ...appIdentity, botKind: undefined }, false],
    [token, { ...appIdentity, botUid: 'ordinary-bot' }, false],
    [token, { ...appIdentity, spaceId: 'invented-space' }, false],
    ['bf_fixture_secret', { ...userIdentity, spaceId: null }, false],
    ['bf_fixture_secret', appIdentity, false],
    [token, userIdentity, false],
    ['bf_fixture_secret', userIdentity, true],
    ['bf_fixture_secret', { ...userIdentity, botKind: 'user' }, true],
    [token, { ...appIdentity, botUid: 'app_' + token + '_bot' }, false],
  ]
  for (const [credential, identity, accepted] of cases) {
    const ui = renderer(), Editor = createAccountEditor(ui.React, { Button: 'button', Input: 'input' })
    const props = { lang: 'en', allowCredentials: true, onVerify: async () => identity }
    let tree = ui.render(Editor, props)
    nodes(tree).find(node => node?.props?.type === 'password').props.ref.current = { value: credential }
    await nodes(tree).find(node => node?.type === 'button' && textOf(node) === 'Verify token').props.onClick()
    tree = ui.render(Editor, props)
    assert.equal(textOf(tree).includes('Token verified'), accepted, JSON.stringify(identity))
    assert.ok(!JSON.stringify(tree).includes(credential))
  }
})

test('token replacement distinguishes a valid foreign Bot from failure and saves only a matching Bot', async () => {
  for (const [result, message] of [
    [new Error('bot_identity_mismatch'), 'does not match the Bot linked'],
    [{ ...userIdentity, botUid: 'foreign-bot' }, 'does not match the Bot linked'],
    [new Error('bot_verification_failed'), 'could not confirm the token'],
    [userIdentity, 'Token verified'],
  ]) {
    const ui = renderer(), Editor = createAccountEditor(ui.React, { Button: 'button', Input: 'input' })
    const saved = []
    const props = { account: { ...userIdentity, id: 'legacy', cwd: process.cwd(), label: 'Fixture' }, lang: 'en',
      allowCredentials: true, options: { workspaces: [{ path: process.cwd() }] },
      onVerify: async () => { if (result instanceof Error) throw result; return result },
      onSave: async fields => { saved.push(fields) } }
    const button = (tree, label) => nodes(tree).find(node => node?.type === 'button' && textOf(node) === label)
    let tree = ui.render(Editor, props)
    button(tree, 'Replace bot token').props.onClick()
    tree = ui.render(Editor, props)
    const field = nodes(tree).find(node => node?.props?.type === 'password')
    field.props.ref.current = { value: 'bf_rotate_fixture' }
    await button(tree, 'Verify token').props.onClick()
    assert.equal(field.props.ref.current.value, '')
    tree = ui.render(Editor, props)
    assert.ok(textOf(tree).includes(message))
    const save = button(tree, 'Save new token')
    assert.equal(Boolean(save), result === userIdentity)
    if (save) {
      await save.props.onClick()
      assert.deepEqual(saved, [{ token: 'bf_rotate_fixture' }])
    } else assert.deepEqual(saved, [])
  }
})

test('App management modal hides native menu and Webhooks while retaining DM shortcuts and all tool scopes', async () => {
  for (const app of [true, false]) {
    const ui = renderer(), account = { id: 'fixture', label: 'Fixture', cwd: process.cwd(),
      ...(app ? appIdentity : userIdentity), config: {}, enabled: false }
    const View = createAccountView(ui.React, { Button: 'button', Input: 'input', Switch: 'switch' }, {
      request: async () => ({}), status: () => null, label: () => '',
    })
    const props = { data: { accounts: [account], canManage: true, credentialAvailable: true }, lang: 'en', choose() {} }
    let tree = ui.render(View, props)
    nodes(tree).find(node => node?.props?.['aria-label'] === 'Settings · Fixture').props.onClick()
    tree = ui.render(View, props)
    // Account management now renders inside the editor after loading options.
    nodes(tree).find(node => node?.type === 'dialog').props.ref.current = { open: true }
    ui.effects.at(-1)()
    await new Promise(resolve => setImmediate(resolve))
    tree = ui.render(View, props)
    assert.equal(textOf(tree).includes('Octo command menu'), !app)
    assert.equal(textOf(tree).includes('Manage webhooks'), !app)
    const editorUI = renderer(), Editor = createAccountEditor(editorUI.React, { Button: 'button', Input: 'input' })
    tree = editorUI.render(Editor, { account, lang: 'en' })
    assert.equal(nodes(tree).some(node => node?.props?.id === 'fixture-group-commands'), !app)
    assert.ok(nodes(tree).some(node => node?.props?.id === 'fixture-dm-commands'))
    const scopes = nodes(tree).find(node => node?.props?.id === 'fixture-tool-scope')
    assert.deepEqual(scopes.children.filter(node => node?.type === 'option').map(node => node.props.value), ['private', 'owner', 'admitted'])
  }
})

test('unsupported App management has a bounded HTTP error without network or registration side effects', async t => {
  const f = fixture(t), accounts = f.make()
  await accounts.initialize()
  const accountId = (await f.add(accounts)).accountId
  let route
  registerWeb({ get: () => ({ requestRejection: () => undefined }), webServer: { register: value => { route = value } } }, accounts)
  const requestCount = f.requests.length
  for (const [suffix, action] of [['commands', 'publish'], ['webhooks', 'routes']]) {
    const req = Readable.from([Buffer.from(JSON.stringify({ revision: accounts.revision, action }))])
    Object.assign(req, { method: 'POST', url: '/api/dsh-channel-octo/accounts/' + accountId + '/' + suffix,
      headers: { 'content-type': 'application/json', 'x-dsh-octo-client': '1' } })
    let status, body
    await route.handler(req, { writeHead: code => { status = code }, end: value => { body = JSON.parse(value) } })
    assert.equal(status, 400)
    assert.deepEqual(body, { error: 'app_bot_operation_unavailable' })
  }
  assert.equal(f.requests.length, requestCount)
})

test('channel settings keep App response controls usable and omit hidden group settings when saving', async () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  for (const app of [true, false]) {
    const ui = renderer(), requests = []
    const config = channelView(resolveConfig({ apiBase: 'https://octo.invalid/api', cwd: process.cwd(), senderPolicy: 'octo',
      ...(app ? appIdentity : userIdentity) }, { DSH_OCTO_BOT_TOKEN: app ? token : 'bf_fixture_secret' }))
    const data = { accounts: [{ id: 'fixture', label: 'Fixture', config, revision: 'original' }] }
    ui.React.useSyncExternalStore = (_subscribe, get) => typeof get() === 'string' ? get() : data
    let plugin, Settings
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => name === 'react' ? ui.React
        : { Button: 'button', Input: 'input', SegmentedTabs: 'tabs' }) } } },
      document: { baseURI: 'https://dsh.invalid/' }, URL,
      fetch: async (url, options) => {
        assert.equal(url.href, 'https://dsh.invalid/api/dsh-channel-octo/accounts/fixture/settings')
        requests.push(JSON.parse(options.body))
        return Response.json({ config: { ...config, progress: 'typing', timeoutMs: 6000 }, revision: 'next' })
      },
    })
    plugin.apply({ locale: { getSnapshot: () => ({ active: 'en' }) }, effect() {}, slots: {
      inject: (_name, callback) => callback(),
      register: (slot, component) => { if (slot.name === 'settings.section') Settings = component },
    } })
    let tree = ui.render(Settings, {})
    for (const key of ['channelPolicy', 'mentionPolicy', 'threadRuleMode', 'allowedGroupIds', 'allowedThreadIds']) {
      assert.equal(nodes(tree).some(node => node?.props?.id === 'dsho-' + key), !app, key)
    }
    if (app) assert.match(textOf(tree), /Octo-managed DM scope/)
    nodes(tree).find(node => node?.props?.id === 'dsho-progress').props.onChange({ target: { value: 'typing' } })
    nodes(tree).find(node => node?.props?.id === 'dsho-timeout').props.onChange({ target: { value: '6' } })
    nodes(tree).find(node => node?.props?.id === 'dsho-maxConcurrentTurns').props.onChange({ target: { value: '3' } })
    tree = ui.render(Settings, {})
    await nodes(tree).find(node => node?.type === 'form' && node.props['aria-label'] === 'Message rules').props.onSubmit({ preventDefault() {} })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].revision, 'original')
    if (app) assert.deepEqual(requests[0].settings, { progress: 'typing', timeoutMs: 6000, maxConcurrentTurns: 3 })
    else assert.deepEqual(requests[0].settings, { progress: 'typing', timeoutMs: 6000, maxConcurrentTurns: 3, channelPolicy: 'allowlist',
      mentionPolicy: 'required', threadRuleMode: 'thread-only', allowedGroupIds: [], allowedThreadIds: [] })
  }
})
