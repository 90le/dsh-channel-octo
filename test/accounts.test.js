import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Accounts } from '../src/accounts.js'
import { credentialRequest } from '../src/web.js'
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

test('credential inputs reject plain LAN HTTP and untrusted forwarded HTTPS', () => {
  const req = (origin, host, address, forwarded, encrypted = false) => ({
    headers: { origin, host, 'x-forwarded-proto': forwarded },
    socket: { remoteAddress: address, localAddress: '192.0.2.10', encrypted },
  })
  assert.equal(credentialRequest(req('http://example.invalid', 'example.invalid', '192.0.2.20', 'https')), false)
  assert.equal(credentialRequest(req('https://example.invalid', 'example.invalid', '192.0.2.20', 'https')), false)
  assert.equal(credentialRequest(req('https://example.invalid', 'example.invalid', '192.0.2.20', 'https'), ['192.0.2.20']), true)
  assert.equal(credentialRequest(req('https://example.invalid', 'example.invalid', '192.0.2.20', '', true)), true)
  assert.equal(credentialRequest(req('https://other.invalid', 'example.invalid', '192.0.2.20', '', true)), false)
  assert.equal(credentialRequest(req('http://localhost:1234', 'localhost:1234', '127.0.0.1')), true)
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
