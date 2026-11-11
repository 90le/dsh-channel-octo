import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Accounts } from '../src/accounts.js'

test('host presets are selectable by default, while explicit deployment restrictions remain authoritative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'octo-permission-defaults-'))
  const vault = new Map()
  let permissions = { names: ['read-only', 'workspace-write', 'danger-full-access', 'auto', 'custom-policy'],
    optionOf: name => ({ name }) }
  const services = {
    credentials: { set: async (key, value) => vault.set(key, value), resolve: async key => ({ value: vault.get(key) }) },
    workspaceRegistry: { list: () => [{ path: root, title: 'Fixture' }] },
  }
  const ctx = { get: name => name === 'permissionPresets' ? permissions : services[name],
    logger: () => ({ info() {}, error() {} }) }
  const deployment = { stateDir: root, apiBase: 'https://octo.invalid/api' }
  const fetchImpl = async () => Response.json({ bot_uid: 'fixture-bot', space_id: 'fixture-space' })
  const make = () => new Accounts(ctx, deployment, { env: {}, fetchImpl })
  let accounts = make()
  const save = account => accounts.save(null, { revision: accounts.revision, account: {
    label: 'Fixture', cwd: root, token: 'bf_fixture', enabled: false, senderPolicy: 'octo', ...account,
  } })
  try {
    await accounts.initialize()
    assert.equal(accounts.policies().length, 6)
    assert.ok(accounts.policies().slice(1).every(item => !item.disabled))
    const defaults = await accounts.editFields({ label: 'Default', cwd: root, senderPolicy: 'octo' })
    assert.equal(defaults.permission, 'text-only')
    assert.equal(defaults.toolScope, 'private')
    await assert.rejects(save({ permission: 'unknown-policy' }), /permission_unavailable/)
    const result = await save({ permission: 'custom-policy' })
    assert.equal(result.accounts[0].permission, 'custom-policy')
    assert.equal(result.accounts[0].toolScope, 'private')
    const accountId = result.accountId
    await accounts.dispose()

    // A saved account can restore before the host permission service appears.
    permissions = undefined
    accounts = make()
    await accounts.initialize()
    assert.equal(accounts.records.get(accountId).permission, 'custom-policy')
    assert.ok(accounts.runtimes.has(accountId))
    assert.deepEqual(accounts.policies().map(row => row.id), ['text-only'])
    await assert.rejects(accounts.save(accountId, { revision: accounts.revision,
      account: { permission: 'workspace-write' } }), /permission_unavailable/)
    await accounts.dispose()

    permissions = { names: ['read-only', 'workspace-write', 'custom-policy'], optionOf: name => ({ name }) }
    deployment.hostPermissions = ['read-only']
    accounts = make()
    await accounts.initialize()
    assert.equal(accounts.openIssues.get(accountId), 'permission_unavailable')
    assert.equal(accounts.policies().find(row => row.id === 'read-only').disabled, false)
    assert.equal(accounts.policies().find(row => row.id === 'workspace-write').disabled, true)
    await assert.rejects(accounts.save(accountId, { revision: accounts.revision,
      account: { permission: 'workspace-write' } }), /permission_unavailable/)
    deployment.hostPermissions = []
    assert.ok(accounts.policies().slice(1).every(row => row.disabled))
    deployment.hostPermissions = 'invalid'
    assert.ok(accounts.policies().slice(1).every(row => row.disabled))
  } finally { await accounts.dispose(); rmSync(root, { recursive: true, force: true }) }
})
