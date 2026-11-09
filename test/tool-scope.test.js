import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Worker, authorizedTools } from '../src/worker.js'
import { OctoClient } from '../src/octo.js'

test('DSH tool scope distinguishes trusted DM, owner in groups, and explicitly admitted members', () => {
  const base = { ownerUid: 'owner', senderPolicy: 'octo', allowed: new Set() }
  for (const channel_type of [1, 2, 5]) {
    assert.equal(authorizedTools(base, { sender: 'owner', channel_type }), channel_type === 1)
    assert.equal(authorizedTools({ ...base, toolScope: 'owner' }, { sender: 'owner', channel_type }), true)
    assert.equal(authorizedTools({ ...base, toolScope: 'owner' }, { sender: 'friend', channel_type }), false)
    assert.equal(authorizedTools({ ...base, toolScope: 'admitted' }, { sender: 'friend', channel_type }), true)
  }
})

test('hot configuration refreshes channel API admission without reconnecting or losing verified owner', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-hot-tools-'))
  const store = new Store(cwd, 'fixture')
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  const config = { cwd, botUid: 'bot', spaceId: 'space', ownerUid: 'alice', senderPolicy: 'allowlist',
    allowed: new Set(['alice']), apiBase: 'https://octo.invalid/api', token: 'bf_fixture',
    fetchImpl: async () => Response.json({ messages: [] }) }
  const api = new OctoClient(config)
  const previousChannel = api.channel
  const worker = new Worker({ config, api, store, host: {}, log() {} })
  const route = { channel_type: 1, channel_id: 'alice' }
  await api.channel.dispatch(route, 'alice', 'inspect')
  const next = { ...config, ownerUid: undefined, allowed: new Set(['bob']) }
  worker.reconfigure(next, {})
  await assert.rejects(previousChannel.dispatch(route, 'alice', 'inspect'), { code: 'account_configuration_changed' })
  assert.equal(next.ownerUid, 'alice')
  await assert.rejects(api.channel.dispatch(route, 'alice', 'inspect'), { code: 'requester_not_allowed' })
  await api.channel.dispatch({ channel_type: 1, channel_id: 'bob' }, 'bob', 'inspect')
})

test('group scope enables native tools only after admission and separates restricted writers', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-scope-'))
  const store = new Store(cwd, 'fixture')
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  const config = { cwd, ownerUid: 'alice', botUid: 'bot', spaceId: 'space', toolScope: 'owner',
    senderPolicy: 'octo', channelPolicy: 'joined', allowed: new Set(), sessionProfile: 'fixture', toolPermission: 'workspace-write' }
  const runs = [], sent = []
  let allow = true
  const api = { async allowsMessage() { return allow }, async rules() { return [] },
    async send(...args) { sent.push(args); return '900' },
    channel: { async members() { return [{ uid: 'alice', name: '小明', role: 1, robot: 0 }] }, async dispatch() { return {} } } }
  const worker = new Worker({ config, store, api, log() {}, host: {
    async run(session, text, created, signal, rules, stage, timeout, toolsAllowed, extras) {
      runs.push({ session: session.session_id, toolsAllowed, extras }); await created()
      return '请 @[alice:小明] 查看。'
    },
  } })
  for (const [index, sender] of ['alice', 'bob', 'bob'].entries()) {
    if (index === 2) allow = false
    store.add(String(index + 1), { messageId: String(index + 1), sender, channelId: 'a'.repeat(32), channelType: 2,
      messageSeq: index + 1, text: '测试' })
    await worker.process(store.next(Date.now()), new AbortController().signal)
  }
  assert.deepEqual(runs.map(r => r.toolsAllowed), [true, false])
  assert.notEqual(runs[0].session, runs[1].session)
  assert.ok(runs.every(r => r.extras.channelTools.specs.some(s => s.name === 'octo_members')))
  assert.ok(runs.every(r => !r.extras.channelTools.specs.some(s => s.name.startsWith('octo_messages_search_authorized'))))
  assert.ok(runs.every(r => !r.extras.channelTools.specs.some(s => ['octo_messages_send_target', 'octo_messages_resolve_targets'].includes(s.name))))
  assert.equal(sent.length, 2)
  assert.equal(sent[0][1], '请 @小明 查看。')
  assert.equal(sent[0][4].from_name, '小明')
  assert.equal(sent[0][4].payload.content, '测试')
  assert.deepEqual(sent[0][5], { uids: ['alice'], entities: [{ uid: 'alice', offset: 2, length: 3 }] })
})

test('read-only channels expose no Octo mutations and DM tools remain in the originating chat', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-tool-boundary-'))
  const store = new Store(cwd, 'fixture')
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  const config = { cwd, ownerUid: 'alice', botUid: 'bot', spaceId: 'space', toolScope: 'owner',
    senderPolicy: 'octo', channelPolicy: 'joined', allowed: new Set(), toolPermission: 'read-only' }
  const calls = [], runs = []
  const api = { async allowsMessage() { return true }, async rules() { return [] }, async send() { return '900' },
    channel: { async members() { return [] }, async dispatch(...args) { calls.push(args); return {} } } }
  const worker = new Worker({ config, store, api, log() {}, host: {
    async run(session, text, created, signal, rules, stage, timeout, allowed, extras) {
      await created(); runs.push(extras.channelTools)
      const names = extras.channelTools.specs.map(spec => spec.name)
      assert.ok(names.includes('octo_messages_recent'))
      if (config.toolPermission === 'read-only') {
        assert.ok(!names.includes('octo_messages_notify'))
        assert.throws(() => extras.channelTools.execute('octo_messages_notify', { text: 'test' }, signal), /unavailable/)
      } else {
        assert.ok(!names.includes('octo_members'))
        assert.ok(names.includes('octo_messages_search_authorized'))
        assert.ok(names.includes('octo_messages_send_target'))
        assert.ok(names.includes('octo_messages_resolve_targets'))
        assert.ok(names.includes('octo_voice_context_read'))
        assert.ok(names.includes('octo_groups_create'))
        await extras.channelTools.execute('octo_messages_recent', {}, signal)
      }
      return 'done'
    },
  } })
  store.add('1', { messageId: '1', sender: 'alice', channelId: 'a'.repeat(32), channelType: 2, text: 'inspect' })
  await worker.process(store.next(Date.now()), new AbortController().signal)
  config.toolPermission = 'workspace-write'
  store.add('2', { messageId: '2', sender: 'alice', channelId: 'alice', channelType: 1, text: 'inspect' })
  await worker.process(store.next(Date.now()), new AbortController().signal)
  assert.equal(runs.length, 2)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][0], { channel_type: 1, channel_id: 'alice' })
  assert.equal(calls[0][1], 'alice')
})

test('in-flight channel results are withheld after configuration, API, or admission changes', async t => {
  for (const change of ['configuration', 'channel instance', 'live admission']) await t.test(change, async t => {
    const cwd = mkdtempSync(join(tmpdir(), 'octo-search-reconfigure-'))
    const store = new Store(cwd, 'fixture')
    t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
    const config = { cwd, ownerUid: 'alice', botUid: 'bot', spaceId: 'space', toolScope: 'owner',
      senderPolicy: 'octo', channelPolicy: 'joined', allowed: new Set(), toolPermission: 'read-only' }
    let release, entered, allow = true, reached = false
    const response = new Promise(resolve => { release = resolve })
    const searching = new Promise(resolve => { entered = resolve })
    const api = { async allowsMessage() { return allow }, async send() { return '900' },
      channel: { async dispatch() { entered(); return response } } }
    const worker = new Worker({ config, api, store, log() {}, host: {
      async run(session, input, created, signal, rules, stage, timeout, toolsAllowed, extras) {
        await created()
        const result = extras.channelTools.execute('octo_messages_search_authorized', { targets: [] }, signal)
        const denied = assert.rejects(result, /octo_access_denied/)
        await searching
        if (change === 'configuration') worker.reconfigure({ ...config, toolPermission: 'text-only', allowed: new Set() }, {})
        else if (change === 'channel instance') api.channel = { async dispatch() { throw Error('must not call replacement') } }
        else allow = false
        release({ entries: [{ excerpt: 'MUST_NOT_RETURN' }], continuation: 'ocs_' + 'a'.repeat(32) })
        await denied
        await assert.rejects(extras.channelTools.execute('octo_messages_search_authorized', {}, signal), /octo_access_denied/)
        reached = true
        return 'done'
      },
    } })
    store.add('1', { messageId: '1', sender: 'alice', channelId: 'alice', channelType: 1, text: 'search' })
    await worker.process(store.next(Date.now()), new AbortController().signal)
    assert.equal(reached, true)
  })
})
