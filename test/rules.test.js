import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { OctoClient } from '../src/octo.js'
import { resolveConfig } from '../src/config.js'
import { Worker } from '../src/worker.js'

const group = '00112233445566778899aabbccddeeff'
const thread = '123456789012345678'
const address = group + '____' + thread
const signal = new AbortController().signal

test('rules use the official read-only scope and represent an empty latest revision', async () => {
  const hits = []
  let groupDoc = { content: 'Use group terms.', version: 1 }
  const client = new OctoClient({
    apiBase: 'https://fixture.invalid/api', token: 'bf_fixture',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET')
      assert.equal(options.redirect, 'manual')
      assert.equal(options.headers.Authorization, 'Bearer bf_fixture')
      assert.equal(options.body, undefined)
      const path = new URL(url).pathname
      hits.push(path)
      return Response.json(path.includes('/threads/')
        ? { content: 'Use topic terms.', version: 7 }
        : groupDoc)
    },
  })
  const parentPath = '/api/v1/bot/groups/' + group + '/md'
  const childPath = '/api/v1/bot/groups/' + group + '/threads/' + thread + '/md'
  assert.deepEqual((await client.rules(2, group, 'thread-only', signal)).map(x => x.markdown), ['Use group terms.'])
  assert.deepEqual(hits.splice(0), [parentPath])
  assert.deepEqual((await client.rules(5, address, 'thread-only', signal)).map(x => x.markdown), ['Use topic terms.'])
  assert.deepEqual(hits.splice(0), [childPath])
  groupDoc = { content: '', version: 2 }
  assert.deepEqual(await client.rules(5, address, 'inherit-group', signal), [
    { kind: 'group', version: 2, status: 'empty', markdown: '' },
    { kind: 'thread', version: 7, status: 'present', markdown: 'Use topic terms.' },
  ])
  assert.deepEqual(hits, [childPath, parentPath])
})

test('missing permission, incompatible response and oversized rule stop before agent admission', async () => {
  const cases = [
    [() => new Response(null, { status: 403 }), 'rules_http_403'],
    [() => new Response(null, { status: 404 }), 'rules_http_404'],
    [() => Response.json({ message: 'incompatible' }), 'rules_invalid_rule_document'],
    [() => Response.json({ content: 'x'.repeat(10241), version: 1 }), 'rules_invalid_rule_document'],
  ]
  for (const [response, issue] of cases) {
    let calls = 0
    const api = new OctoClient({
      apiBase: 'https://fixture.invalid/api', token: 'bf_fixture',
      fetchImpl: async () => { calls++; return response() },
    })
    const statuses = []
    const worker = new Worker({
      api, log() {}, host: { run: () => assert.fail('model must not run') },
      store: { review: (seq, reason) => statuses.push([seq, reason]) },
      config: { botUid: 'bot', allowed: new Set(['human']), threads: new Set([address]), threadRuleMode: 'inherit-group' },
    })
    await worker.process({ seq: 1, state: 'queued', channel_type: 5, channel_id: address, sender: 'human' }, signal)
    assert.deepEqual(statuses, [[1, issue]])
    assert.equal(calls, 1) // no parent fallback after a rejected topic lookup
  }
})

test('config prevents invalid scoped routes and defaults to topic-only rules', () => {
  const base = { apiBase: 'https://fixture.invalid/api', botUid: 'bot', spaceId: 'space', cwd: resolve('.'), allowedUids: ['human'] }
  const user = { DSH_OCTO_BOT_TOKEN: 'bf_fixture' }
  assert.equal(resolveConfig({ ...base, allowedThreadIds: [address] }, user).threadRuleMode, 'thread-only')
  assert.throws(() => resolveConfig({ ...base, allowedGroupIds: ['..'] }, user), /invalid_channel_allowlist/)
  assert.throws(() => resolveConfig({ ...base, allowedThreadIds: [group + '____short'] }, user), /invalid_channel_allowlist/)
  assert.throws(() => resolveConfig({ ...base, allowedGroupIds: [group] }, { DSH_OCTO_BOT_TOKEN: 'app_fixture' }), /require_user_bot/)
  assert.throws(() => resolveConfig({ ...base, threadRuleMode: 'everything' }, user), /invalid_thread_rule_mode/)
})

test('inheritance mode does not reuse a thread-only session, and switching back resumes the thread-only history', async () => {
  const seen = []
  const config = { botUid: 'bot', allowed: new Set(['human']), threads: new Set([address]), threadRuleMode: 'thread-only' }
  const docs = [{ kind: 'thread', version: 1, status: 'empty', markdown: '' }]
  const worker = new Worker({
    config, log() {},
    api: { rules: async () => docs, send: async () => '1' },
    host: { async run(_session, _text, _created, _signal, rules) { assert.equal(rules, docs); return 'ok' } },
    store: {
      session(key) { seen.push(key); return {} },
      running() {}, ready() {}, sending() {}, sent() {},
    },
  })
  const job = { seq: 1, state: 'queued', channel_type: 5, channel_id: address, sender: 'human' }
  await worker.process(job, signal)
  config.threadRuleMode = 'inherit-group'
  await worker.process(job, signal)
  config.threadRuleMode = 'thread-only'
  await worker.process(job, signal)
  assert.notEqual(seen[0], seen[1])
  assert.equal(seen[0], seen[2])
})
