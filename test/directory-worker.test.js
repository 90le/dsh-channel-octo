import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { InboxRecovery } from '../src/inbox.js'
import { admit, OctoClient } from '../src/octo.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const group = 'a'.repeat(32)
const shortId = '123456789012345'
const topic = group + '____' + shortId
const parent = '/v1/bot/groups/' + group
const reply = 'Synthetic directory recovery answer.'
const options = { timeout: 5000 }

// Regression coverage for directory-review-020 findings 1/2. Keep real history
// admission, SQLite persistence, context construction and delivery. Only HTTP
// and the host are synthetic; callback observations are asserted outside the
// production catch blocks so an assertion cannot masquerade as access denial.
function fixture(t, type = 2) {
  const root = mkdtempSync(join(tmpdir(), 'octo-directory-worker-'))
  const f = {
    root, type, id: type === 5 ? topic : group,
    T: Math.floor(Date.now() / 1000) * 1000 - 30_000,
    rows: [], calls: [], posts: [], acks: [], runs: [], readyRows: [], logs: [], unexpected: [], hooks: {},
    active: true, normal: true, childActive: true, fixedSpace: true, effective: true,
    members: [{ uid: 'human', name: 'Human', robot: 0 }, { uid: 'bot', robot: 1 }],
    controller: new AbortController(),
  }
  f.config = {
    apiBase: 'https://directory-worker.invalid', token: 'bf_synthetic_directory_worker',
    botUid: 'bot', spaceId: 'fixed-space', ownerUid: 'human', botKind: 'user',
    transport: 'websocket', mentionPolicy: 'octo', senderPolicy: 'allowlist', channelPolicy: 'allowlist',
    allowed: new Set(['human']), groups: new Set([group]), threads: new Set([topic]),
    toolPermission: 'text-only', toolScope: 'owner', groupCommands: 'off',
    sendMode: 'queue', progress: 'off', threadRuleMode: 'thread-only', cwd: root,
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), path = url.pathname
    const call = { path, query: url.search, body: init.body ? JSON.parse(init.body) : undefined }
    f.calls.push(call)
    if (url.origin !== f.config.apiBase) {
      f.unexpected.push(url.origin + path)
      return new Response(null, { status: 500 })
    }
    if (path === '/v1/bot/groups') return Response.json(f.fixedSpace
      ? [{ group_no: group, space_id: f.config.spaceId }] : [])
    if (path === parent) return Response.json({ group_no: group, status: f.normal ? 1 : 2 })
    if (path === parent + '/mention_pref') return Response.json({
      effective: f.effective, no_mention: Number(f.effective), group_allow_no_mention: 1,
    })
    if (path === parent + '/threads') return f.active
      ? Response.json({ count: 0, list: [] }) : new Response(null, { status: 403 })
    if (path === parent + '/threads/' + shortId) return Response.json({
      group_no: group, short_id: shortId, channel_id: topic, channel_type: 5, status: f.childActive ? 1 : 2,
    })
    if (path === parent + '/members') {
      await f.hooks.members?.(call)
      return Response.json(f.members)
    }
    if (path === parent + '/md' || path === parent + '/threads/' + shortId + '/md') {
      await f.hooks.rules?.(call)
      return Response.json({ content: '', version: 1 })
    }
    if (path === '/v1/bot/messages/sync') {
      await f.hooks.history?.(call)
      const q = call.body
      const rows = f.rows.filter(row => row.channel_id === q.channel_id)
        .sort((a, b) => a.message_seq - b.message_seq)
      const messages = q.pull_mode === 0
        ? rows.filter(row => !q.start_message_seq || row.message_seq <= q.start_message_seq).slice(-q.limit)
        : rows.filter(row => row.message_seq >= q.start_message_seq
          && (!q.end_message_seq || row.message_seq < q.end_message_seq)).slice(0, q.limit)
      call.responseMessages = structuredClone(messages)
      return Response.json({ messages })
    }
    if (/^\/v1\/bot\/events\/\d+\/ack$/.test(path)) {
      f.acks.push(path.split('/').at(-2))
      return Response.json({ status: 200 })
    }
    if (path === '/v1/bot/readReceipt') return Response.json({ status: 200 })
    if (path === '/v1/bot/sendMessage') {
      f.posts.push(call)
      return Response.json({ message_id: String(8000 + f.posts.length) })
    }
    f.unexpected.push(path)
    return new Response(null, { status: 500 })
  }
  const host = {
    async run(session, input, created, signal, rules, stage, timeout, allowed, extras) {
      f.runs.push({ input, extras, strictChecks: f.strictChecks().length })
      await created()
      await f.hooks.host?.()
      return reply
    },
  }
  const bind = () => {
    f.api = new OctoClient({ ...f.config, fetchImpl })
    f.worker = new Worker({ api: f.api, store: f.store, config: f.config, host, log: issue => f.logs.push(issue) })
    f.worker.inbox.connection(true)
    f.inbox = new InboxRecovery({ api: f.api, store: f.store, config: () => f.config,
      accept: (id, message) => f.store.add(id, message), log: issue => f.logs.push(issue) })
    f.inbox.connection(true)
    const ready = f.store.ready.bind(f.store)
    f.store.ready = (seq, text, meta) => {
      ready(seq, text, meta)
      f.readyRows.push(f.jobBySeq(seq))
      f.hooks.ready?.()
    }
  }
  f.store = new Store(root, 'directory-worker-synthetic')
  f.jobBySeq = seq => f.store.db.prepare('SELECT * FROM jobs WHERE seq=?').get(seq)
  f.job = seq => f.store.db.prepare('SELECT * FROM jobs WHERE message_id=?').get(String(9000 + seq))
  f.strictChecks = () => f.calls.filter(call => call.path === parent + '/threads')
  f.wire = (seq, { at = f.T + 2000, text = 'Synthetic request ' + seq, quote, mentioned = true } = {}) => ({
    message_id: String(9000 + seq), message_seq: seq, channel_type: type, channel_id: f.id,
    from_uid: 'human', timestamp: Math.floor(at / 1000),
    payload: { type: 1, content: text, ...(mentioned && { mention: { uids: ['bot'] } }),
      ...(quote && { reply: { message_id: String(9000 + quote) } }) },
  })
  f.seed = (kind = 'directory') => {
    const live = { messageId: '9010', messageSeq: 10, sender: 'human', text: 'Existing live message',
      channelType: type, channelId: f.id }
    if (kind === 'known') f.store.enrolInbox(live, true)
    f.store.activateDirectoryRecovery(f.T)
    if (kind === 'prefix') f.store.enrolInbox(live, true)
    f.store.seedDirectoryRoute(type, f.id)
    return f.store.inboxRoute(type, f.id)
  }
  f.bounds = () => {
    const route = f.store.inboxRoute(type, f.id)
    return { since_ms: route.since_ms, prefix_since_ms: route.prefix_since_ms, prefix_until_seq: route.prefix_until_seq }
  }
  f.recover = async rows => {
    f.rows = rows
    await f.inbox.sweep(f.controller.signal)
    assert.equal(f.store.inboxRoute(type, f.id).blocked, 0, 'synthetic recovery must actually release the route')
  }
  f.process = seq => {
    const job = f.job(seq)
    assert.ok(job, 'history must produce the real queued job')
    return f.worker.process(job, f.controller.signal)
  }
  f.receive = wire => {
    const message = admit({ message: wire }, f.config)
    assert.ok(message, 'the synthetic live receipt must pass ordinary admission')
    return f.worker.inbox.receive('ws:' + wire.message_id, message)
  }
  f.restart = () => {
    f.store.close()
    f.store = new Store(root, 'directory-worker-synthetic')
    f.controller = new AbortController()
    bind()
  }
  bind()
  t.after(() => {
    try {
      f.controller.abort()
      f.store.close()
    } finally {
      assert.equal(resolve(dirname(root)), resolve(tmpdir()), 'cleanup is limited to the owned temporary fixture')
      assert.ok(root.startsWith(join(tmpdir(), 'octo-directory-worker-')))
      rmSync(root, { recursive: true, force: true })
    }
    assert.deepEqual(f.unexpected, [], 'unexpected synthetic endpoints must not silently deny execution')
  })
  return f
}

function assertBlocked(f, seq) {
  assert.equal(f.runs.length, 0, 'revoked directory work must never enter host.run')
  assert.equal(f.posts.length, 0, 'revoked directory work must not send replies or failure notices')
  assert.ok(['ignored', 'review'].includes(f.job(seq).state))
}

for (const type of [2, 5]) {
  test(`directory type ${type}: revoke after inbox and reopen blocks targeted model admission`, options, async t => {
    const f = fixture(t, type)
    assert.equal(f.seed().directory_all, 1)
    await f.recover([f.wire(2)])
    assert.equal(f.job(2).ambient, 0)
    assert.deepEqual(JSON.parse(f.job(2).metadata).directoryRecovery, f.bounds())
    f.restart()
    assert.equal(f.job(2).directoryRecovery, undefined, 'Worker must reconstruct provenance from persisted metadata')
    f.active = false
    f.calls.length = 0
    await f.process(2)
    assertBlocked(f, 2)
    assert.ok(f.strictChecks().length > 0, 'targeted allowlisted work must still prove active membership')
    assert.equal(f.calls.filter(call => call.path.endsWith('/md')).length, 0)
  })
}

for (const [name, change] of [
  ['sender disappears', f => { f.members = f.members.filter(member => member.uid !== 'human') }],
  ['sender becomes a robot', f => { f.members.find(member => member.uid === 'human').robot = true }],
]) {
  test(`targeted directory local allowlist: ${name} after inbox blocks the model`, options, async t => {
    const f = fixture(t)
    f.seed()
    await f.recover([f.wire(2)])
    assert.equal(f.job(2).state, 'queued')
    assert.equal(f.job(2).ambient, 0, 'the explicit Bot mention must exercise targeted admission')
    assert.deepEqual(JSON.parse(f.job(2).metadata).directoryRecovery, f.bounds())
    assert.equal(f.config.senderPolicy, 'allowlist')
    assert.equal(f.config.channelPolicy, 'allowlist')
    assert.ok(f.config.allowed.has('human'), 'local sender authorization remains unchanged')
    change(f)
    f.calls.length = 0
    await f.process(2)
    assertBlocked(f, 2)
    assert.equal(f.job(2).issue, 'octo_access_denied')
    assert.ok(f.strictChecks().length > 0, 'the Bot still has active parent membership')
    assert.ok(f.calls.some(call => call.path === parent + '/members'), 'current human membership must be fetched')
    assert.equal(f.calls.filter(call => call.path.endsWith('/md')).length, 0,
      'invalid senders must be denied before model preparation')
  })
}

for (const phase of ['rules', 'history']) {
  test(`revocation while asynchronous ${phase} preparation is pending blocks host.run`, options, async t => {
    const f = fixture(t)
    f.seed()
    await f.recover([f.wire(2)])
    const entered = Promise.withResolvers(), released = Promise.withResolvers()
    f.hooks[phase] = async () => { entered.resolve(); await released.promise }
    f.calls.length = 0
    const processing = f.process(2)
    // If preparation is never reached, fail promptly instead of relying on a
    // timeout or leaving an unresolved callback behind.
    try {
      await Promise.race([entered.promise, processing.then(() => assert.fail('preparation was never reached'))])
      assert.ok(f.strictChecks().length > 0, 'initial strict admission must have succeeded')
      f.active = false
    } finally { released.resolve() }
    await processing
    assertBlocked(f, 2)
    assert.ok(f.strictChecks().length >= 2, 'authorization must be refreshed after awaited preparation')
  })
}

for (const [name, type, revoke] of [
  ['fixed Space', 2, f => { f.fixedSpace = false }],
  ['normal parent', 2, f => { f.normal = false }],
  ['active child', 5, f => { f.childActive = false }],
  ['local route scope', 5, f => { f.config.threads.clear() }],
]) {
  test(`targeted directory work rechecks ${name} after recovery`, options, async t => {
    const f = fixture(t, type)
    f.seed()
    await f.recover([f.wire(2)])
    revoke(f)
    await f.process(2)
    assertBlocked(f, 2)
  })
}

for (const [type, quote] of [[2, 2], [5, 2], [2, 1]]) {
  test(`directory type ${type}: old context and quote ${quote} stay outside model input`, options, async t => {
    const f = fixture(t, type)
    f.seed()
    // Timestamps intentionally do not follow sequence order.
    const eligible = f.wire(1, { text: 'Eligible recent context' })
    const old = f.wire(2, { at: f.T - 60_000, text: '/new PRE_ACTIVATION_SYNTHETIC' })
    const boundary = f.wire(3, { at: f.T, text: 'AT_ACTIVATION_SYNTHETIC' })
    await f.recover([eligible, old, boundary, f.wire(4, { quote })])
    assert.ok(f.store.inboxSeen(old.message_id))
    assert.equal(f.job(2), undefined, 'old scanned body must not become a job')
    f.calls.length = 0
    await f.process(4)
    assert.equal(f.runs.length, 1, 'an authorized new request must still execute')
    assert.equal(f.job(4).state, 'sent')
    assert.equal(f.posts.length, 1)
    const context = f.runs[0].extras.channelContext
    assert.doesNotMatch(JSON.stringify(f.runs[0]), /PRE_ACTIVATION_SYNTHETIC|AT_ACTIVATION_SYNTHETIC/)
    if (quote === 1) {
      assert.equal(context.quote.text, eligible.payload.content, 'in-range quotes must remain available')
      assert.deepEqual(context.history, [])
    } else {
      assert.equal(context.quote, undefined)
      assert.deepEqual(context.history.map(row => row.text), [eligible.payload.content])
    }
    assert.ok(f.runs[0].strictChecks >= 2, 'strict access is checked immediately before model execution')
    const contextReads = f.calls.filter(call => call.body?.limit === 20)
    assert.equal(contextReads.length, 1)
    assert.equal(contextReads[0].body.channel_id, f.id, 'topic context must never fall back to the parent')
    assert.equal(Object.hasOwn(contextReads[0].body, 'since_ms'), false, 'local recovery bounds are not wire fields')
  })
}

test('directory prefix persists bounds, excludes its old quote and retains eligible context', options, async t => {
  const f = fixture(t)
  const route = f.seed('prefix')
  assert.equal(route.directory_all, 0)
  assert.equal(route.prefix_until_seq, 9)
  await f.recover([
    f.wire(6, { at: f.T - 60_000, text: 'OLD_PREFIX_CONTEXT' }),
    f.wire(7, { text: 'Eligible prefix context' }),
    f.wire(8, { quote: 6 }),
    f.wire(10, { at: f.T - 60_000, text: 'Already accepted upper range' }),
  ])
  assert.deepEqual(JSON.parse(f.job(8).metadata).directoryRecovery,
    { since_ms: 0, prefix_since_ms: f.T, prefix_until_seq: 9 })
  await f.process(8)
  assert.equal(f.runs.length, 1)
  assert.equal(f.runs[0].extras.channelContext.quote, undefined)
  assert.deepEqual(f.runs[0].extras.channelContext.history.map(row => row.text), ['Eligible prefix context'])
  assert.doesNotMatch(JSON.stringify(f.runs[0]), /OLD_PREFIX_CONTEXT/)
  assert.equal(f.job(8).state, 'sent')
})

async function leaveReady(f) {
  f.hooks.ready = () => f.controller.abort()
  await assert.rejects(f.process(2), error => error.name === 'AbortError')
  assert.equal(f.job(2).state, 'ready')
  assert.equal(f.runs.length, 1)
  assert.equal(f.posts.length, 0)
  assert.deepEqual(JSON.parse(f.readyRows[0].metadata).directoryRecovery, f.bounds())
  assert.match(JSON.parse(f.job(2).metadata).deliveryProfile, /^[a-f0-9]{64}$/)
  delete f.hooks.ready
  f.restart()
  assert.equal(f.job(2).state, 'ready')
  assert.deepEqual(JSON.parse(f.job(2).metadata).directoryRecovery, f.bounds())
}

for (const [policy, from, to] of [
  ['mentionPolicy', 'octo', 'required'],
  ['senderPolicy', 'allowlist', 'octo'],
]) for (const ready of [false, true]) {
  test(`ambient directory ${policy} change during final ${ready ? 'ready delivery' : 'model'} authorization blocks work`, options, async t => {
    const f = fixture(t)
    f.seed()
    await f.recover([f.wire(2, { mentioned: false })])
    assert.equal(f.job(2).ambient, 1, 'the recovered message has no Bot mention')
    assert.deepEqual(JSON.parse(f.job(2).metadata).directoryRecovery, f.bounds())
    if (ready) await leaveReady(f)
    assert.equal(f.job(2).ambient, 1, 'ambient provenance must survive ready/restart')

    const entered = Promise.withResolvers(), released = Promise.withResolvers()
    // Admission and context/delivery member lookup precede authorization. Ready
    // work also passes the batch gate before its final per-send authorization.
    const finalLookup = ready ? 4 : 3
    let lookups = 0
    f.hooks.members = async () => {
      if (++lookups === finalLookup) { entered.resolve(); await released.promise }
    }
    const processing = f.process(2)
    try {
      await Promise.race([entered.promise, processing.then(() => assert.fail('final authorization was never reached'))])
      assert.equal(f.runs.length, ready ? 1 : 0)
      assert.equal(f.posts.length, 0)
      assert.equal(f.worker.config[policy], from)
      f.worker.reconfigure({ ...f.worker.config, [policy]: to }, f.worker.host)
    } finally { released.resolve() }
    await processing
    assert.equal(lookups, finalLookup, 'the policy change occurred inside the awaited final roster check')
    assert.equal(f.worker.config[policy], to)
    assert.equal(f.runs.length, ready ? 1 : 0, 'changed admission policy must prevent a new model run')
    assert.equal(f.posts.length, 0, 'changed admission policy must prevent ambient delivery')
    assert.equal(f.job(2).state, 'review')
    assert.equal(f.job(2).issue, 'delivery_access_changed')
    assert.deepEqual(JSON.parse(f.job(2).metadata).directoryRecovery, f.bounds())
  })
}

for (const revoke of [false, true]) {
  test(`ready directory metadata survives restart; delivery ${revoke ? 'denies revoked access' : 'resumes without a model rerun'}`, options, async t => {
    const f = fixture(t)
    f.seed()
    await f.recover([f.wire(2)])
    await leaveReady(f)
    f.calls.length = 0
    f.active = !revoke
    await f.process(2)
    assert.equal(f.runs.length, 1, 'ready replay must never call the model again')
    assert.equal(f.posts.length, revoke ? 0 : 1)
    assert.ok(f.strictChecks().length > 0, 'reopened ready work must reconstruct provenance for strict admission')
    if (revoke) assert.ok(['ignored', 'review'].includes(f.job(2).state))
    else {
      assert.equal(f.job(2).state, 'sent')
      assert.equal(f.posts[0].body.payload.content, reply)
    }
  })
}

test('ready delivery rechecks strict membership after its awaited member lookup', options, async t => {
  const f = fixture(t)
  f.seed()
  await f.recover([f.wire(2)])
  await leaveReady(f)
  f.calls.length = 0
  // Ready jobs skip rules/context preparation. This lookup happens between
  // their fresh admission and actual delivery; it must not extend authority.
  f.hooks.members = async () => { f.active = false }
  await f.process(2)
  assert.equal(f.runs.length, 1)
  assert.equal(f.posts.length, 0)
  assert.equal(f.job(2).state, 'review')
  assert.equal(f.job(2).issue, 'delivery_access_changed')
  assert.ok(f.strictChecks().length >= 2)
})

test('revocation after the model returns blocks immediate delivery and retains recovery metadata', options, async t => {
  const f = fixture(t)
  f.seed()
  await f.recover([f.wire(2)])
  f.hooks.ready = () => { f.active = false }
  await f.process(2)
  assert.equal(f.runs.length, 1)
  assert.equal(f.posts.length, 0)
  assert.equal(f.job(2).issue, 'delivery_access_changed')
  assert.deepEqual(JSON.parse(f.readyRows[0].metadata).directoryRecovery, f.bounds())
  assert.deepEqual(JSON.parse(f.job(2).metadata).directoryRecovery, f.bounds())
})

for (const kind of ['known', 'prefix']) {
  test(`${kind} route retains legacy targeted upper-range admission without directory provenance`, options, async t => {
    const f = fixture(t)
    const route = f.seed(kind)
    assert.equal(route.directory_all, 0)
    // Even after discovery touches the route, the original seq >= 10 range
    // keeps the existing allowlist behavior, including pre-activation input.
    await f.recover([f.wire(10, { at: f.T - 60_000 })])
    assert.equal(JSON.parse(f.job(10).metadata ?? '{}').directoryRecovery, undefined)
    f.restart()
    f.calls.length = 0
    f.active = false
    f.effective = false
    await f.process(10)
    assert.equal(f.runs.length, 1)
    assert.equal(f.posts.length, 1)
    assert.equal(f.job(10).state, 'sent')
    assert.equal(f.strictChecks().length, 0, 'directory checks must not be imposed on legacy targeted input')
    assert.equal(JSON.parse(f.readyRows[0].metadata).directoryRecovery, undefined)
  })
}

function assertPromoted(f, since = 0, prefix = 9) {
  const route = f.store.inboxRoute(f.type, f.id)
  assert.equal(route.directory_all, 0)
  assert.equal(route.prefix_until_seq, prefix)
  assert.equal(route.prefix_since_ms, f.T)
  assert.equal(route.since_ms, since)
  return route
}

function assertRecoveredUpper(f, { emptyPrefix = false } = {}) {
  const route = f.store.inboxRoute(f.type, f.id)
  assert.equal(route.blocked, 0)
  assert.equal(route.checkpoint, 10, 'the upper range must actually be scanned')
  assert.deepEqual(f.store.db.prepare('SELECT message_id FROM jobs ORDER BY seq').all()
    .map(row => row.message_id), ['9010'])
  assert.equal(f.job(10).state, 'queued')
  assert.equal(f.job(10).ambient, 0)
  assert.equal(JSON.parse(f.job(10).metadata ?? '{}').directoryRecovery, undefined,
    'the actual explicit receipt establishes ordinary upper-range authority')
  assert.ok(f.store.db.prepare('SELECT 1 FROM inbox_seen WHERE message_id=?').get('9010'),
    'staged live input alone must not conceal a skipped upper-history read')
  assert.deepEqual(f.store.stagedInbox(route), [])
  const reads = f.calls.filter(call => call.path === '/v1/bot/messages/sync')
  const forward = reads.filter(call => call.body.pull_mode === 1)
  assert.deepEqual(forward.map(call => [call.body.start_message_seq, call.body.end_message_seq]),
    emptyPrefix ? [[1, 10], [10, 11]] : [[10, 11]],
    'a disabled prefix must make no forward body request; an empty prefix must not skip the upper range')
  assert.ok(reads.every(call => call.body.channel_id === f.id && call.body.channel_type === f.type))
  assert.ok(reads.flatMap(call => call.responseMessages).every(row => row.message_seq === 10),
    'old prefix bodies must not be returned during recovery')
  assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT input,metadata FROM jobs').all()), /OLD_PROMOTION_BODY/)
}

for (const type of [2, 5]) {
  test(`directory type ${type}: actual WS promotes pure route and preference-off skips only the prefix`, options, async t => {
    const f = fixture(t, type)
    assert.equal(f.seed().directory_all, 1)
    const live = f.wire(10, { text: 'Explicit live request' })
    f.rows = [f.wire(1, { at: f.T - 60_000, text: 'OLD_PROMOTION_BODY' }), live]
    f.receive(live)
    assertPromoted(f)
    assert.equal(f.job(10), undefined, 'live input stays staged until recovery releases the route')
    f.effective = false
    f.calls.length = 0
    await f.worker.inbox.sweep(f.controller.signal)
    assertRecoveredUpper(f)
    const tip = f.calls.findIndex(call => call.path === '/v1/bot/messages/sync')
    const pref = f.calls.findIndex(call => call.path === parent + '/mention_pref')
    assert.ok(tip >= 0 && pref > tip, 'latest upper-position lookup must not inherit the prefix preference gate')
    assert.equal(f.job(10).input, live.payload.content)
    await f.process(10)
    assert.equal(f.runs.length, 1)
    assert.equal(f.runs[0].input, live.payload.content)
    assert.equal(f.posts.length, 1)
    assert.equal(f.job(10).state, 'sent')
  })

  test(`directory type ${type}: an empty enabled prefix still fetches explicit WS upper seq 10`, options, async t => {
    const f = fixture(t, type)
    f.seed()
    const live = f.wire(10)
    f.rows = [live]
    f.receive(live)
    assertPromoted(f)
    await f.worker.inbox.sweep(f.controller.signal)
    assertRecoveredUpper(f, { emptyPrefix: true })
    const prefixRead = f.calls.find(call => call.body?.pull_mode === 1 && call.body.start_message_seq === 1)
    assert.deepEqual(prefixRead.responseMessages, [])
    await f.process(10)
    assert.equal(f.runs.length, 1)
    assert.equal(f.posts.length, 1)
    assert.equal(f.job(10).state, 'sent')
  })

  test(`directory type ${type}: event promotion survives restart and retains discovery plus ACK obligations`, options, async t => {
    const f = fixture(t, type)
    const eventSince = f.T - 2000
    f.store.activateEventRecovery(eventSince)
    f.seed()
    const eventMessage = admit({ message: f.wire(10, { text: 'UNTRUSTED_EVENT_BODY' }) }, f.config)
    assert.ok(eventMessage)
    assert.equal(f.store.seedInboxEvent('600', eventMessage), true)
    const promoted = assertPromoted(f, eventSince)
    assert.deepEqual(f.store.pendingInboxDiscoveries(promoted).map(row => [row.event_id, row.message_id]), [['600', '9010']])
    assert.deepEqual(f.store.pendingMessageEventAcks(), ['600'])
    assert.equal(f.job(10), undefined, 'an event discovery must not queue its payload')
    f.rows = [f.wire(1, { at: f.T - 60_000, text: 'OLD_PROMOTION_BODY' }),
      f.wire(10, { text: 'Current history body' })]
    f.effective = false
    f.restart()
    assertPromoted(f, eventSince)
    assert.deepEqual(f.store.pendingMessageEventAcks(), ['600'])
    assert.equal(f.store.pendingInboxDiscoveries(promoted).length, 1)
    f.calls.length = 0
    await f.worker.inbox.sweep(f.controller.signal)
    assertRecoveredUpper(f)
    assert.equal(f.job(10).input, 'Current history body')
    assert.deepEqual(f.store.pendingInboxDiscoveries(promoted), [])
    assert.deepEqual(f.store.pendingMessageEventAcks(), ['600'], 'history completion must not fabricate an ACK')
    await f.worker.ackMessageEvent('600', f.controller.signal)
    assert.deepEqual(f.acks, ['600'])
    assert.deepEqual(f.store.pendingMessageEventAcks(), [])
    const beforeReplay = { ...f.store.inboxRoute(type, f.id) }
    assert.equal(f.store.seedInboxEvent('600', eventMessage), false)
    assert.deepEqual({ ...f.store.inboxRoute(type, f.id) }, beforeReplay)
    assert.deepEqual(f.store.pendingMessageEventAcks(), [], 'an acknowledged event replay must not reopen the ACK')
    await f.process(10)
    assert.equal(f.runs.length, 1)
    assert.equal(f.runs[0].input, 'Current history body')
    assert.equal(f.posts.length, 1)
  })

  test(`directory type ${type}: replayed old seen WS cannot promote pure or shrink prefix authority`, options, async t => {
    const f = fixture(t, type)
    f.seed()
    const old = f.wire(1, { at: f.T - 60_000, text: 'OLD_PROMOTION_BODY' })
    f.rows = [old, f.wire(10)]
    await f.worker.inbox.sweep(f.controller.signal)
    assert.ok(f.store.db.prepare('SELECT 1 FROM inbox_seen WHERE message_id=?').get(old.message_id))
    assert.equal(f.job(1), undefined)
    const pure = { ...f.store.inboxRoute(type, f.id) }
    assert.equal(pure.directory_all, 1)
    f.receive(old)
    assert.deepEqual({ ...f.store.inboxRoute(type, f.id) }, pure)
    assert.deepEqual(f.store.stagedInbox(pure), [])
    f.receive(f.wire(8))
    const prefix = { ...assertPromoted(f, 0, 7) }
    const staged = f.store.stagedInbox(prefix)
    assert.deepEqual(staged.map(row => row.message_id), ['9008'])
    f.receive(old)
    assert.deepEqual({ ...f.store.inboxRoute(type, f.id) }, prefix)
    assert.deepEqual(f.store.stagedInbox(prefix), staged)
    assert.equal(f.job(1), undefined)
    assert.equal(f.runs.length, 0)
    assert.equal(f.posts.length, 0)
  })
}
