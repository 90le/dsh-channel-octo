import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Accounts } from '../src/accounts.js'
import { registerWeb } from '../src/web.js'
import { createServer } from 'node:http'

const ctx = { get: () => undefined, logger: () => ({ info() {}, error() {} }) }
const production = 'https://im.deepminer.com.cn/api'
const custom = 'https://octo.example.invalid/api'

test('server defaults, saved overrides and previous accounts remain isolated across restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'octo-server-'))
  const make = options => new Accounts(ctx, { stateDir: root, ...options }, { env: {} })
  let accounts
  try {
    accounts = make({})
    await accounts.initialize()
    assert.equal(accounts.overview().server.current, production)
    assert.equal(accounts.ready, true)
    await assert.rejects(accounts.saveServer({ endpoint: 'http://example.invalid/api', revision: accounts.revision }), /invalid_server/)
    await assert.rejects(accounts.saveServer({ endpoint: 'https://user:pass@example.invalid/api', revision: accounts.revision }), /invalid_server/)
    await assert.rejects(accounts.saveServer({ endpoint: custom, revision: 'stale' }), /account_changed/)
    await accounts.saveServer({ endpoint: custom, revision: accounts.revision })
    assert.equal(accounts.overview().server.current, production)
    assert.equal(accounts.overview().server.pending, custom)
    await accounts.dispose()
    accounts = make({})
    await accounts.initialize()
    assert.equal(accounts.endpoint, custom)
    assert.notEqual(accounts.root, root)
    await accounts.saveServer({ endpoint: production, revision: accounts.revision })
    await accounts.dispose()
    accounts = make({})
    await accounts.initialize()
    assert.equal(accounts.endpoint, production)
    assert.equal(accounts.root, root)
    assert.equal(JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')).endpoint, production)
  } finally { await accounts?.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('existing explicit custom endpoint and registry stay intact through server switching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'octo-server-existing-'))
  const record = { id: '12345678-1234-1234-1234-123456789abc', botUid: 'fixture-bot', spaceId: 'fixture-space',
    label: 'Existing', cwd: root, secretRef: 'DSH_OCTO_ACCOUNT_12345678123412341234123456789ABC', enabled: false, transport: 'events' }
  const original = JSON.stringify({ version: 1, endpoint: custom, accounts: [record] })
  writeFileSync(join(root, 'accounts.json'), original, { mode: 0o600 })
  const make = () => new Accounts(ctx, { stateDir: root, apiBase: custom }, { env: {} })
  let accounts
  try {
    accounts = make()
    await accounts.initialize()
    assert.equal(accounts.endpoint, custom)
    assert.equal(accounts.root, root)
    assert.equal(accounts.records.get(record.id).botUid, record.botUid)
    await accounts.saveServer({ endpoint: production, revision: accounts.revision })
    assert.equal(readFileSync(join(root, 'accounts.json'), 'utf8'), original)
    await accounts.dispose()
    accounts = make()
    await accounts.initialize()
    assert.equal(accounts.endpoint, production)
    assert.notEqual(accounts.root, root)
    assert.equal(accounts.records.size, 0)
    await accounts.saveServer({ endpoint: custom, revision: accounts.revision })
    await accounts.dispose()
    accounts = make()
    await accounts.initialize()
    assert.equal(accounts.root, root)
    assert.equal(accounts.records.get(record.id).botUid, record.botUid)
    assert.equal(readFileSync(join(root, 'accounts.json'), 'utf8'), original)
  } finally { await accounts?.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('server changes require an authenticated same-origin editor', async () => {
  let route, calls = 0
  const host = { webServer: { register: value => { route = value } },
    get: () => ({ requestRejection: req => req.headers.authorization === 'ok' ? undefined : 401 }) }
  registerWeb(host, { saveServer: async input => { calls++; return input } })
  const server = createServer(route.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/api/dsh-channel-octo/server'
    const headers = { authorization: 'ok', 'content-type': 'application/json', 'x-dsh-octo-client': '1' }
    const send = fields => fetch(url, { method: 'PUT', headers: fields, body: JSON.stringify({ endpoint: custom, revision: 'r' }) })
    assert.equal((await send({ ...headers, authorization: 'bad' })).status, 401)
    assert.equal((await send({ ...headers, 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await send({ ...headers, 'x-dsh-octo-client': '' })).status, 403)
    assert.equal(calls, 0)
    assert.equal((await send({ ...headers, 'sec-fetch-site': 'same-origin' })).status, 200)
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
