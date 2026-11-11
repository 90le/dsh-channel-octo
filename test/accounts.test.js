import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Accounts } from '../src/accounts.js'
import { registerWeb } from '../src/web.js'
import { createServer } from 'node:http'
import { Store } from '../src/store.js'
import { resolveConfig } from '../src/config.js'
import { accountFields, createAccountEditor } from '../src/account-editor.js'

test('Bot credentials stay out of account JSON, rotation keeps identity and account queues are separate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-accounts-'))
  const secrets = new Map()
  const requests = []
  const vault = {
    resolve: async key => ({ value: secrets.get(key) }),
    set: async (key, token) => { secrets.set(key, token) },
    unset: async key => { secrets.delete(key) },
  }
  const services = {
    credentials: vault,
    workspaceRegistry: { list: () => [{ id: 'ws', title: 'Test', path: root }] },
    agentPresets: { compositionInventory: async () => [{ id: 'standard', name: 'Standard' }] },
    permissionPresets: { names: ['workspace-write'], optionOf: () => ({ name: 'Workspace write' }) },
    llm: {
      listProviders: () => [{ id: 'fixture' }],
      listModels: async () => [{ id: 'fixture-model', name: 'Fixture Model', reasoning: { efforts: [{ id: 'high' }] } }],
    },
  }
  const ctx = { get: name => services[name], logger: () => ({ info() {}, error() {} }) }
  const config = { apiBase: 'https://octo.invalid/api', stateDir: root, cwd: root }
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://octo.invalid')
    requests.push(parsed.pathname)
    assert.ok(parsed.pathname.endsWith('/verify-bot'))
    const token = JSON.parse(options.body).bot_token
    return Response.json({ bot_uid: token === 'bf_other_fixture' ? 'bot-other' : 'bot-fixture', space_id: 'fixture-space' })
  }
  const make = () => new Accounts(ctx, config, { fetchImpl, env: {} })
  let accounts = make()
  const defaults = { label: 'Fixture', cwd: root, provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high',
    permission: 'text-only', agentPreset: 'standard', enabled: false, senderPolicy: 'octo', allowedUids: [], idleMinutes: 15 }
  const save = (id, changes) => accounts.save(id, { revision: accounts.overview().accountRevision,
    account: { ...defaults, ...changes } })
  try {
    await accounts.initialize()
    assert.deepEqual(await accounts.verify('bf_first_fixture'), { botUid: 'bot-fixture', spaceId: 'fixture-space' })
    assert.equal(secrets.size, 0)
    await assert.rejects(save(null, { token: 'bf_first_fixture', permission: 'workspace-write' }), /permission_unavailable/)
    const first = await save(null, { token: 'bf_first_fixture' })
    const firstId = first.accountId
    assert.equal(first.accounts[0].reasoningEffort, 'high')
    assert.equal(first.accounts[0].idleMinutes, 15)
    assert.equal(first.accounts[0].toolScope, 'private')
    const beforeVerify = accounts.revision
    assert.equal((await accounts.verify('bf_rotated_fixture', firstId)).botUid, 'bot-fixture')
    assert.equal((await accounts.verify('bf_other_fixture')).botUid, 'bot-other')
    await assert.rejects(accounts.verify('bf_other_fixture', firstId), /bot_identity_mismatch/)
    assert.equal(secrets.size, 1, 'verification does not change credentials')
    assert.equal(accounts.revision, beforeVerify)

    await assert.rejects(save(null, { token: 'bf_first_fixture' }), /duplicate_bot/)
    await assert.rejects(save(firstId, { token: 'bf_other_fixture' }), /bot_identity_mismatch/)
    config.hostPermissions = ['workspace-write']
    await save(firstId, { label: 'Renamed', token: 'bf_rotated_fixture', permission: 'workspace-write' })
    assert.equal(accounts.overview().accounts.find(row => row.id === firstId).senderPolicy, 'octo')
    const prior = accounts.record(firstId)
    for (const toolScope of ['private', 'owner', 'admitted']) {
      const updated = await accounts.save(firstId, { revision: accounts.overview().accountRevision, account: { toolScope } })
      assert.equal(updated.accounts.find(row => row.id === firstId).toolScope, toolScope)
      assert.equal(accounts.runtimes.get(firstId).settings.config.toolScope, toolScope)
      assert.deepEqual(accounts.record(firstId), { ...prior, toolScope })
      const saved = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8'))
      assert.equal(saved.accounts.find(row => row.id === firstId).toolScope, toolScope)
    }
    const savedBeforeInvalid = readFileSync(join(root, 'accounts.json'), 'utf8')
    const revisionBeforeInvalid = accounts.overview().accountRevision
    for (const toolScope of [null, '', 'all', 'Owner', true, 1, [], {}]) {
      await assert.rejects(accounts.save(firstId, { revision: revisionBeforeInvalid, account: { toolScope } }), /invalid_account/)
      await assert.rejects(save(null, { token: 'bf_other_fixture', toolScope }), /invalid_account/)
    }
    assert.equal(readFileSync(join(root, 'accounts.json'), 'utf8'), savedBeforeInvalid)
    assert.equal(accounts.overview().accountRevision, revisionBeforeInvalid)
    const secondId = (await save(null, { label: 'Second', token: 'bf_other_fixture' })).accountId
    assert.equal(accounts.record(secondId).toolScope, 'private')
    for (const progressExpansion of ['list', 'all']) {
      await accounts.save(firstId, { revision: accounts.revision, account: { progressExpansion } })
      assert.equal(accounts.record(firstId).progressExpansion, progressExpansion)
      assert.equal(accounts.overview().accounts.find(row => row.id === firstId).progressExpansion, progressExpansion)
      assert.equal(accounts.runtimes.get(firstId).settings.config.progressExpansion, progressExpansion)
      assert.equal(accounts.overview().accounts.find(row => row.id === secondId).progressExpansion, 'collapsed')
    }
    await assert.rejects(accounts.save(firstId, { revision: accounts.revision, account: { progressExpansion: 'invalid' } }), /invalid_account/)
    assert.notEqual(firstId, secondId)
    assert.equal(secrets.size, 2)
    const initialStore = accounts.runtimes.get(secondId).store
    const existing = initialStore.session('fixture-user')
    initialStore.sessionCreated('fixture-user')
    const unbound = await accounts.saveAssistant(null, { revision: accounts.revision, assistant: {
      name: 'Independent assistant', cwd: root, agentPreset: 'standard',
    } })
    const aid = unbound.assistantId
    assert.equal(unbound.assistants.find(item => item.id === aid).boundAccountId, undefined)
    const profile = accounts.assistantDetail(aid)
    const { id: _id, boundAccountId, agentsMd, soulMd, ...assistant } = profile
    await accounts.saveAssistant(aid, { revision: accounts.revision, accountId: secondId, assistant })
    assert.equal(accounts.record(secondId).assistantId, aid)
    assert.equal(accounts.runtimes.get(secondId).store, initialStore)
    assert.ok(initialStore.knownSessions().includes(existing.session_id))
    const instructions = accounts.workspaceInstructions(aid)
    assert.equal(instructions.files['AGENTS.md'].state, 'missing')
    const file = await accounts.saveWorkspaceInstruction(aid, 'AGENTS.md', {
      cwd: root, revision: instructions.files['AGENTS.md'].revision, text: 'FIXTURE WORKSPACE RULES',
    })
    assert.equal(file.state, 'present')
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'FIXTURE WORKSPACE RULES')
    assert.equal(accounts.workspaceInstructions(accounts.record(firstId).assistantId).files['AGENTS.md'].text, 'FIXTURE WORKSPACE RULES')
    assert.ok(!JSON.stringify(accounts.overview()).includes('FIXTURE WORKSPACE RULES'))
    await assert.rejects(accounts.saveAssistant(aid, { revision: accounts.revision, accountId: firstId, assistant }), /assistant_bound/)
    const publicAndDisk = JSON.stringify(accounts.overview()) + readFileSync(join(root, 'accounts.json'), 'utf8')
    for (const secret of ['bf_first_fixture', 'bf_other_fixture', 'bf_rotated_fixture']) {
      assert.ok(!publicAndDisk.includes(secret))
    }
    assert.ok(!JSON.stringify(accounts.overview()).includes('DSH_OCTO_ACCOUNT_'))
    await accounts.dispose()
    // Simulate a deployment upgrading from an account with old inline text.
    const stateFile = join(root, 'accounts.json')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.assistants.find(item => item.id === aid).agentsMd = 'ARCHIVED OLD RULES'
    writeFileSync(stateFile, JSON.stringify(state))
    accounts = make()
    await accounts.initialize()
    const restored = accounts.overview().accounts.find(row => row.id === firstId)
    assert.equal(restored.progressExpansion, 'all')
    assert.equal(restored.label, 'Renamed')
    assert.equal(restored.permission, 'workspace-write')
    assert.equal(restored.senderPolicy, 'octo')
    assert.equal(restored.toolScope, 'admitted')
    assert.equal(accounts.overview().accounts.find(row => row.id === secondId).toolScope, 'private')
    assert.equal(accounts.assistantDetail(aid).boundAccountId, secondId)
    const beforeDocsProfile = accounts.runtimeConfig(accounts.record(secondId), {}).sessionProfile
    await accounts.save(secondId, { revision: accounts.revision, account: { label: 'Second renamed' } })
    assert.equal(accounts.record(secondId).assistantId, aid)
    const current = accounts.workspaceInstructions(aid).files['AGENTS.md']
    assert.equal(current.text, 'FIXTURE WORKSPACE RULES')
    assert.equal(current.legacy, 'ARCHIVED OLD RULES')
    assert.equal(accounts.hostFor(accounts.record(secondId), { cwd: root }).profile.agentsMd, undefined)
    assert.equal(accounts.runtimeConfig(accounts.record(secondId), {}).sessionProfile, beforeDocsProfile)
    assert.ok(!JSON.stringify(accounts.overview()).includes('ARCHIVED OLD RULES'))
    await assert.rejects(accounts.save(secondId, { revision: accounts.revision, account: { soulMd: 'duplicate source' } }), /invalid_account/)
    await assert.rejects(accounts.saveWorkspaceInstruction(aid, 'AGENTS.md', { cwd: root + '-other',
      revision: current.revision, text: 'WRONG WORKSPACE' }), /instruction_changed/)

    assert.ok(accounts.runtimes.get(secondId).store.knownSessions().includes(existing.session_id))
    assert.deepEqual(await accounts.diagnose(firstId), { botUid: 'bot-fixture', spaceId: 'fixture-space' })
    await accounts.remove(secondId, { revision: accounts.overview().accountRevision })
    assert.equal(accounts.overview().accounts.length, 1)
    assert.equal(secrets.size, 1)
    assert.ok(requests.every(path => path.endsWith('/verify-bot')))
  } finally {
    await accounts.dispose().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('authenticated HTTP can manage credentials; forged origins and anonymous requests cannot', async () => {
  let route, verified = 0
  const ctx = {
    webServer: { register(value) { route = value; return () => {} } },
    get: () => ({ requestRejection: request => request.headers.authorization === 'fixture-session' ? undefined : 401 }),
  }
  let writes = 0
  registerWeb(ctx, { workspaceInstructions(id) {
    assert.equal(id, 'legacy')
    return { files: { 'AGENTS.md': { text: 'private test instructions' } } }
  }, async saveWorkspaceInstruction(id, name, input) {
    assert.deepEqual([id, name, input], ['legacy', 'SOUL.md', { cwd: '/fixture', revision: 'missing', text: 'role' }])
    writes++
    return { text: 'role' }
  }, async verify(token, accountId) {
    verified++
    assert.equal(token, 'bf_synthetic')
    if (accountId === 'legacy') throw new Error('bot_identity_mismatch')
    assert.equal(accountId, undefined)
    return { botUid: 'fixture' }
  } })
  const server = createServer(route.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const headers = { authorization: 'fixture-session', 'content-type': 'application/json', 'x-dsh-octo-client': '1' }
    const base = 'http://127.0.0.1:' + server.address().port
    const post = (fields, accountId) => fetch(base + '/api/dsh-channel-octo/accounts/verify', {
      method: 'POST', headers: fields, body: JSON.stringify({ token: 'bf_synthetic', accountId }),
    })
    assert.equal((await post({ ...headers, 'sec-fetch-site': 'same-site' })).status, 403)
    assert.equal((await post({ ...headers, authorization: 'wrong' })).status, 401)
    const result = await post({ ...headers, origin: base, 'sec-fetch-site': 'same-origin' })
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { botUid: 'fixture' })
    const mismatch = await post({ ...headers, origin: base, 'sec-fetch-site': 'same-origin' }, 'legacy')
    assert.equal(mismatch.status, 400)
    assert.deepEqual(await mismatch.json(), { error: 'bot_identity_mismatch' })
    assert.equal(verified, 2)
    const files = base + '/api/dsh-channel-octo/assistants/legacy/instructions'
    assert.equal((await fetch(files, { headers: { 'x-dsh-octo-client': '1' } })).status, 401)
    assert.equal((await fetch(files, { headers: { authorization: 'fixture-session' } })).status, 403)
    assert.equal((await fetch(files, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 403)
    const loaded = await fetch(files, { headers })
    assert.equal(loaded.headers.get('cache-control'), 'no-store')
    assert.equal((await loaded.json()).files['AGENTS.md'].text, 'private test instructions')
    const write = { method: 'PUT', body: JSON.stringify({ cwd: '/fixture', revision: 'missing', text: 'role' }) }
    assert.equal((await fetch(files + '/SOUL.md', { ...write, headers: { ...headers, 'sec-fetch-site': 'same-site' } })).status, 403)
    assert.equal((await fetch(files + '/OTHER.md', { ...write, headers })).status, 404)
    assert.equal((await fetch(files + '/SOUL.md', { ...write, headers })).status, 200)
    assert.equal(writes, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('idle rotation retains the previous native session in channel history', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-idle-'))
  const store = new Store(root, 'fixture')
  try {
    const first = store.session('fixture-user', 15, 1000)
    store.sessionCreated('fixture-user')
    assert.equal(store.session('fixture-user', 15, 61_000).session_id, first.session_id)
    const second = store.session('fixture-user', 15, 961_000)
    assert.notEqual(second.session_id, first.session_id)
    store.sessionCreated('fixture-user')
    store.add('1', { messageId: '1', sender: 'fixture-user', text: 'first' })
    store.running(1, first.session_id)
    store.sent(1, '10')
    store.add('2', { messageId: '2', sender: 'fixture-user', text: 'second' })
    store.running(2, second.session_id)
    assert.deepEqual(store.overview().conversations.map(row => [row.id, row.state]),
      [[second.session_id, 'running'], [first.session_id, 'sent']])
    assert.deepEqual(store.overview().conversations.map(row => [row.id, row.historical]),
      [[second.session_id, 0], [first.session_id, 1]])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an in-flight legacy account accepts a partial hot edit without reconnecting; removal survives restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-hot-'))
  const fixture = {
    botUid: 'fixture-bot', spaceId: 'fixture-space', stateDir: root, cwd: root, enabled: true,
    apiBase: 'https://octo.invalid/api', transport: 'events', senderPolicy: 'octo',
  }
  let identified = 0
  const make = () => new Accounts({
    get: () => undefined,
    logger: () => ({ info() {}, error() {} }),
  }, fixture, { env: { DSH_OCTO_BOT_TOKEN: 'bf_fixture_legacy' }, fetchImpl: async (input, init) => {
    if (new URL(input).pathname.endsWith('/verify-bot')) {
      identified++
      return Response.json({ bot_uid: fixture.botUid, space_id: fixture.spaceId, owner_uid: 'owner' })
    }
    return new Promise((_, reject) => {
      const stop = () => reject(init.signal.reason)
      init.signal.addEventListener('abort', stop, { once: true })
      if (init.signal.aborted) stop()
    })
  } })
  let accounts = make()
  try {
    await accounts.initialize()
    const runtime = accounts.runtimes.get('legacy')
    const worker = runtime.worker
    const originalProfile = worker.config.sessionProfile
    assert.equal(worker.config.toolScope, 'private')
    const liveConfig = worker.config
    let revoked = false
    worker.revokeApproval = () => { revoked = true }
    await accounts.save('legacy', { revision: accounts.revision, account: { progressExpansion: 'all' } })
    assert.equal(worker.config, liveConfig, 'presentation changes do not replace the active config')
    assert.equal(worker.config.progressExpansion, 'all')
    assert.equal(revoked, false, 'presentation changes do not cancel approvals')
    delete worker.revokeApproval
    const active = worker.inFlight = Promise.withResolvers().promise
    worker.store.add('1', { messageId: '1', sender: 'owner', text: 'in flight' })
    worker.store.running(1)
    const updated = await accounts.save('legacy', { revision: accounts.overview().accountRevision,
      account: { label: 'Renamed immediately', sendMode: 'steer', toolScope: 'owner' } })
    assert.equal(updated.accounts[0].label, 'Renamed immediately')
    assert.equal(updated.accounts[0].toolScope, 'owner')
    assert.equal(runtime.worker, worker)
    assert.equal(worker.config.sendMode, 'steer')
    assert.equal(worker.config.toolScope, 'owner')
    assert.notEqual(worker.config.sessionProfile, originalProfile)
    const ownerProfile = worker.config.sessionProfile
    await accounts.save('legacy', { revision: accounts.overview().accountRevision, account: { toolScope: 'admitted' } })
    assert.equal(runtime.worker, worker)
    assert.equal(worker.config.toolScope, 'admitted')
    assert.notEqual(worker.config.sessionProfile, ownerProfile)
    await accounts.saveRules('legacy', { revision: runtime.settings.revision(), settings: { progress: 'off' } })
    assert.equal(runtime.settings.config.toolScope, 'admitted')
    assert.equal(worker.inFlight, active)
    assert.equal(identified, 1)
    worker.inFlight = undefined
    worker.store.sent(1, '11')
    await accounts.remove('legacy', { revision: accounts.overview().accountRevision })
    await accounts.dispose()
    accounts = make()
    await accounts.initialize()
    assert.equal(accounts.overview().accounts.length, 0)
    assert.equal(identified, 1)
  } finally {
    await accounts.dispose().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('old account records and fresh legacy imports keep private tool scope until explicitly edited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-octo-scope-migration-'))
  const managedId = '12345678-1234-1234-1234-123456789abc'
  const records = [
    { id: 'legacy', botUid: 'legacy-bot', spaceId: 'fixture-space' },
    { id: managedId, botUid: 'managed-bot', spaceId: 'fixture-space', secretRef: 'DSH_OCTO_ACCOUNT_' + 'A'.repeat(32) },
  ].map(record => ({ ...record, label: 'Old account', cwd: root, transport: 'events', enabled: false }))
  const file = join(root, 'accounts.json')
  const endpoint = 'https://octo.invalid/api'
  const original = JSON.stringify({ version: 1, endpoint, accounts: records })
  writeFileSync(file, original, { mode: 0o600 })
  const deployment = { apiBase: endpoint, stateDir: root, cwd: root, senderPolicy: 'octo', toolScope: 'admitted' }
  const make = () => new Accounts({
    logger: () => ({ info() {}, error() {} }),
    get: name => name === 'credentials' ? { resolve: async () => ({ value: 'bf_fixture' }) } : undefined,
  }, deployment, { env: { DSH_OCTO_BOT_TOKEN: 'bf_fixture' }, fetchImpl: async () => { throw new Error('unexpected_request') } })
  let accounts = make()
  try {
    await accounts.initialize()
    assert.equal(accounts.ready, true)
    for (const account of accounts.overview().accounts) {
      assert.equal(account.toolScope, 'private')
      assert.equal(accounts.runtimes.get(account.id).settings.config.toolScope, 'private')
      assert.equal(accountFields(account).toolScope, 'private')
      assert.equal(accountFields(account).progressExpansion, 'collapsed')
    }
    assert.equal(readFileSync(file, 'utf8'), original)
    await accounts.save(managedId, { revision: accounts.overview().accountRevision, account: { label: 'Renamed old account' } })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(saved.accounts.every(record => record.toolScope === 'private'))
    await accounts.dispose()
    accounts = make()
    await accounts.initialize()
    assert.ok(accounts.overview().accounts.every(record => record.toolScope === 'private'))
    await accounts.dispose()

    for (const toolScope of [null, 'all', true]) {
      writeFileSync(file, JSON.stringify({ version: 1, endpoint, accounts: [{ ...records[0], toolScope }] }))
      accounts = make()
      await accounts.initialize()
      assert.equal(accounts.ready, false)
      assert.equal(accounts.status, 'configuration_or_state_error')
      assert.equal(accounts.runtimes.size, 0)
      await accounts.dispose()
    }

    writeFileSync(file, JSON.stringify({ version: 1, endpoint, accounts: [] }))
    Object.assign(deployment, { enabled: true, botUid: 'legacy-bot', spaceId: 'fixture-space', senderPolicy: 'octo' })
    accounts = make()
    accounts.start = () => {}
    await accounts.initialize()
    assert.equal(accounts.record('legacy').toolScope, 'private')
    assert.equal(accounts.runtimes.get('legacy').settings.config.toolScope, 'private')
  } finally {
    await accounts.dispose().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('tool scope config validates enums and scopes produce distinct stable session fingerprints', () => {
  const cwd = process.cwd()
  const config = { apiBase: 'https://octo.invalid/api', cwd, botUid: 'fixture-bot', spaceId: 'fixture-space',
    senderPolicy: 'octo' }
  const env = { DSH_OCTO_BOT_TOKEN: 'bf_fixture' }
  const original = resolveConfig(config, env)
  assert.equal(original.toolScope, 'private')
  for (const toolScope of ['private', 'owner', 'admitted']) {
    assert.deepEqual(resolveConfig({ ...config, toolScope }, env), { ...original, toolScope })
  }
  for (const toolScope of [null, '', 'all', 'Owner', true, 1, [], {}]) {
    assert.throws(() => resolveConfig({ ...config, toolScope }, env), /invalid_tool_scope/)
  }

  const accounts = new Accounts({ logger: () => ({}) }, { cwd })
  const profile = record => accounts.runtimeConfig(record, {}).sessionProfile
  for (const id of ['legacy', '12345678-1234-1234-1234-123456789abc']) {
    const record = { id, cwd, permission: 'workspace-write', agentPreset: 'standard' }
    const scopes = ['private', 'owner', 'admitted'].map(toolScope => profile({ ...record, toolScope }))
    assert.equal(new Set(scopes).size, 3)
    assert.ok(scopes.every(value => /^[a-f0-9]{24}$/.test(value)))
    assert.equal(profile(record), scopes[0])
    assert.equal(scopes[0], createHash('sha256').update(JSON.stringify([
      cwd, undefined, undefined, undefined, record.permission, record.agentPreset,
    ])).digest('hex').slice(0, 24), 'default private scope preserves the pre-0.7 session fingerprint')
    assert.equal(profile({ ...record, toolScope: 'owner', label: 'Renamed' }), scopes[1])
    assert.equal(profile({ ...record, toolScope: 'admitted', dmCommands: 'safe' }), scopes[2])
    assert.equal(profile({ ...record, toolScope: 'private' }), scopes[0])
  }
  const legacy = { id: 'legacy', cwd, permission: 'text-only', agentPreset: 'octo-text' }
  const legacyConfig = accounts.runtimeConfig(legacy, {})
  assert.equal(legacyConfig.sessionProfile, undefined)
  accounts.runtimeConfig({ ...legacy, toolScope: 'owner' }, legacyConfig)
  const ownerProfile = legacyConfig.sessionProfile
  assert.match(ownerProfile, /^[a-f0-9]{24}$/)
  accounts.runtimeConfig({ ...legacy, toolScope: 'admitted' }, legacyConfig)
  assert.notEqual(legacyConfig.sessionProfile, ownerProfile)
  accounts.runtimeConfig({ ...legacy, toolScope: 'private' }, legacyConfig)
  assert.equal(legacyConfig.sessionProfile, undefined)
})

test('account editor explains independent tool access, localizes efforts and immediately saves scope edits', async () => {
  // Inspect the rendered controls and their callbacks without adding a browser or React dependency.
  const React = {
    Fragment: 'fragment', useEffect() {}, useId: () => 'fixture',
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: current => ({ current }),
    createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children }) : { type, props: props ?? {}, children: children.flat(Infinity) },
  }
  const Editor = createAccountEditor(React, { Button: 'button', Input: 'input' })
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [node]
  const account = { id: 'fixture', cwd: process.cwd(), provider: 'fixture', model: 'model', allowFiles: true }
  const options = {
    workspaces: [{ path: account.cwd }], policies: [{ id: 'text-only' }],
    models: [{ provider: 'fixture', model: 'model', reasoningEfforts: ['max', 'high', 'medium', 'low', 'default', 'custom'] }],
  }
  assert.equal(accountFields().toolScope, 'private')
  assert.equal(accountFields().progressExpansion, 'collapsed')
  const choices = [['private', '获准的私聊用户'], ['owner', 'Bot 所有者的全部会话'], ['admitted', '所有已准入用户']]
  for (const [index, [toolScope]] of choices.entries()) {
    const saved = []
    const elements = nodes(Editor({ account: { ...account, toolScope }, options, lang: 'zh',
      onSave: async fields => { saved.push(fields) } }))
    const text = elements.filter(value => typeof value === 'string').join('\n')
    const select = elements.find(node => node?.type === 'select' && node.props.id === 'fixture-tool-scope')
    assert.equal(select.props.value, toolScope)
    assert.deepEqual(select.children.filter(node => node?.type === 'option').map(node => [node.props.value, node.children[0]]), choices)
    assert.match(text, /工具使用范围/)
    assert.match(text, /所选 Agent 预设中可用的全部 DSH 工具、插件和技能/)
    assert.match(text, /账号权限策略/)
    assert.match(text, /仍须通过现有聊天准入规则/)
    assert.match(text, /私聊快捷命令/)
    assert.match(text, /群聊快捷命令/)
    assert.match(text, /不转发其他插件命令/)
    assert.match(text, /只读权限下也可开启/)
    assert.doesNotMatch(text, /仅允许插件命令|只有获准使用工具的私聊用户可以接收/)
    if (toolScope !== 'private') assert.doesNotMatch(text, /群聊和子区不开放工具/)
    const effort = elements.find(node => node?.type === 'select' && node.props.id === 'fixture-effort')
    assert.deepEqual(effort.children.filter(node => node?.props?.value).map(node => node.children[0]),
      ['最高', '高', '中等', '低', '模型默认', 'custom'])
    const expansion = elements.find(node => node?.type === 'select' && node.props.id === 'fixture-progress-expansion')
    assert.deepEqual(expansion.children.filter(node => node?.type === 'option').map(node => node.children[0]), ['默认折叠', '展开列表', '全部展开'])
    const expansionSaved = []
    const fresh = nodes(Editor({ account, options, lang: 'zh', onSave: async value => { expansionSaved.push(value) } }))
    fresh.find(node => node?.type === 'select' && node.props.id === 'fixture-progress-expansion').props.onChange({ target: { value: 'all' } })
    await Promise.resolve()
    assert.deepEqual(expansionSaved, [{ progressExpansion: 'all' }])
    const next = choices[(index + 1) % choices.length][0]
    select.props.onChange({ target: { value: next } })
    await Promise.resolve()
    assert.deepEqual(saved, [{ toolScope: next }])
  }
})


test('late credential readiness restores only the waiting Bot, preserving persisted conversations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = mkdtempSync(join(tmpdir(), 'octo-late-vault-'))
  const endpoint = 'https://octo.invalid/api', managedId = '12345678-1234-1234-1234-123456789abc'
  const record = { id: managedId, botUid: 'managed', spaceId: 'space', label: 'Managed',
    secretRef: 'DSH_OCTO_ACCOUNT_' + 'A'.repeat(32), cwd: root, transport: 'events', enabled: true }
  const legacy = { ...record, id: 'legacy', botUid: 'legacy', secretRef: undefined }
  const file = join(root, 'accounts.json'), original = JSON.stringify({ version: 1, endpoint, accounts: [legacy, record] })
  writeFileSync(file, original, { mode: 0o600 })
  const store = new Store(join(root, 'bots', managedId), JSON.stringify([endpoint, 'space', 'managed']))
  const session = store.session('user'); store.sessionCreated('user'); store.close()
  let provider, token, attempts = 0
  const logs = [], started = []
  const accounts = new Accounts({ get: name => name === 'credentials' ? provider : undefined,
    logger: () => ({ info: value => logs.push(value), error: value => logs.push(value) }) },
  { apiBase: endpoint, stateDir: root, cwd: root, senderPolicy: 'octo' }, { env: { DSH_OCTO_BOT_TOKEN: 'bf_env_fixture' } })
  accounts.start = runtime => { runtime.status = 'online'; started.push(runtime.record.id) }
  try {
    await accounts.initialize()
    const firstRuntime = accounts.runtimes.get('legacy')
    assert.equal(accounts.publicAccount(record).status, 'waiting_credentials')
    assert.equal(accounts.runtimes.size, 1)
    provider = { resolve: async () => { attempts++; return token ? { value: token } : undefined } }
    t.mock.timers.tick(3000); await setImmediate()
    assert.equal(attempts, 1)
    assert.equal(accounts.runtimes.size, 1)
    token = 'bf_secret_fixture_must_not_log'
    t.mock.timers.tick(6000); await setImmediate()
    assert.deepEqual(started, ['legacy', managedId])
    assert.equal(accounts.runtimes.get('legacy'), firstRuntime)
    assert.equal(accounts.runtimes.get(managedId).store.session('user').session_id, session.session_id)
    assert.equal(accounts.publicAccount(record).status, 'online')
    assert.equal(accounts.publicAccount(record).connectionIssue, undefined)
    assert.equal(readFileSync(file, 'utf8'), original)
    t.mock.timers.tick(60_000); await setImmediate()
    assert.equal(attempts, 2)
    assert.doesNotMatch(logs.join(' '), /bf_secret_fixture|bf_env_fixture/)
  } finally { await accounts.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('a missing runtime can reconnect or pause recovery; stopping the plugin cancels retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = mkdtempSync(join(tmpdir(), 'octo-recover-account-'))
  const endpoint = 'https://octo.invalid/api', accountId = '12345678-1234-1234-1234-123456789abc'
  const record = { id: accountId, botUid: 'managed', spaceId: 'space', label: 'Managed',
    secretRef: 'DSH_OCTO_ACCOUNT_' + 'A'.repeat(32), cwd: root, transport: 'events', enabled: true }
  writeFileSync(join(root, 'accounts.json'), JSON.stringify({ version: 1, endpoint, accounts: [record] }), { mode: 0o600 })
  let token, attempts = 0
  const accounts = new Accounts({ get: name => name === 'credentials' ? { resolve: async () => { attempts++; return { value: token } } } : undefined,
    logger: () => ({ info() {}, error() {} }) }, { apiBase: endpoint, stateDir: root, cwd: root }, { env: {} })
  accounts.start = runtime => { runtime.status = runtime.record.enabled ? 'online' : 'disabled' }
  try {
    await accounts.initialize()
    await accounts.setEnabled(accountId, { revision: accounts.revision, enabled: false })
    t.mock.timers.tick(60_000); await setImmediate()
    assert.equal(attempts, 1)
    assert.equal(accounts.publicAccount(accounts.record(accountId)).status, 'disabled')
    await accounts.setEnabled(accountId, { revision: accounts.revision, enabled: true })
    token = 'bf_recovery_fixture'
    await accounts.reconnect(accountId, { revision: accounts.revision })
    assert.equal(accounts.runtimes.size, 1)
    assert.equal(accounts.publicAccount(accounts.record(accountId)).status, 'online')
    await accounts.dispose()
    const count = attempts
    t.mock.timers.tick(60_000); await setImmediate()
    assert.equal(attempts, count)
  } finally { if (!accounts.lifetime.signal.aborted) await accounts.dispose(); rmSync(root, { recursive: true, force: true }) }
})
