import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Accounts } from '../src/accounts.js'
import { registerWeb } from '../src/web.js'
import { createServer } from 'node:http'
import { Store } from '../src/store.js'

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
    await assert.rejects(save(null, { token: 'bf_first_fixture' }), /duplicate_bot/)
    await assert.rejects(save(firstId, { token: 'bf_other_fixture' }), /bot_identity_mismatch/)
    config.hostPermissions = ['workspace-write']
    await save(firstId, { label: 'Renamed', token: 'bf_rotated_fixture', permission: 'workspace-write' })
    assert.equal(accounts.overview().accounts.find(row => row.id === firstId).senderPolicy, 'octo')
    const secondId = (await save(null, { label: 'Second', token: 'bf_other_fixture' })).accountId
    assert.notEqual(firstId, secondId)
    assert.equal(secrets.size, 2)
    const publicAndDisk = JSON.stringify(accounts.overview()) + readFileSync(join(root, 'accounts.json'), 'utf8')
    for (const secret of ['bf_first_fixture', 'bf_other_fixture', 'bf_rotated_fixture']) {
      assert.ok(!publicAndDisk.includes(secret))
    }
    assert.ok(!JSON.stringify(accounts.overview()).includes('DSH_OCTO_ACCOUNT_'))
    await accounts.dispose()
    accounts = make()
    await accounts.initialize()
    const restored = accounts.overview().accounts.find(row => row.id === firstId)
    assert.equal(restored.label, 'Renamed')
    assert.equal(restored.permission, 'workspace-write')
    assert.equal(restored.senderPolicy, 'octo')
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
  registerWeb(ctx, { async verify(token) { verified++; assert.equal(token, 'bf_synthetic'); return { botUid: 'fixture' } } })
  const server = createServer(route.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const headers = { authorization: 'fixture-session', 'content-type': 'application/json', 'x-dsh-octo-client': '1' }
    const base = 'http://127.0.0.1:' + server.address().port
    const post = fields => fetch(base + '/api/dsh-channel-octo/accounts/verify', {
      method: 'POST', headers: fields, body: JSON.stringify({ token: 'bf_synthetic' }),
    })
    assert.equal((await post({ ...headers, 'sec-fetch-site': 'same-site' })).status, 403)
    assert.equal((await post({ ...headers, authorization: 'wrong' })).status, 401)
    const result = await post({ ...headers, origin: base, 'sec-fetch-site': 'same-origin' })
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { botUid: 'fixture' })
    assert.equal(verified, 1)
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
    const active = worker.inFlight = Promise.withResolvers().promise
    worker.store.add('1', { messageId: '1', sender: 'owner', text: 'in flight' })
    worker.store.running(1)
    const updated = await accounts.save('legacy', { revision: accounts.overview().accountRevision,
      account: { label: 'Renamed immediately', sendMode: 'steer' } })
    assert.equal(updated.accounts[0].label, 'Renamed immediately')
    assert.equal(runtime.worker, worker)
    assert.equal(worker.config.sendMode, 'steer')
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
