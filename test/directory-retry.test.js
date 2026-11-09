import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../src/store.js'
import { DirectoryDiscovery } from '../src/directory-discovery.js'
import { OctoClient } from '../src/octo.js'

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32)
const epoch = 1_800_000_000_000
const topic = (group, index) => {
  const short_id = String(100000000000000n + BigInt(index))
  return { group_no: group, short_id, channel_id: group + '____' + short_id, channel_type: 5, status: 1 }
}

function fixture(t, ids = [a]) {
  const root = mkdtempSync(join(tmpdir(), 'octo-directory-retry-'))
  const f = { now: epoch, ids, pages: [], listCalls: 0, paused: false, online: true }
  t.mock.method(Date, 'now', () => f.now)
  f.config = { apiBase: 'https://directory.invalid', token: 'bf_synthetic', botUid: 'bot', spaceId: 'space',
    transport: 'websocket', mentionPolicy: 'octo', channelPolicy: 'joined' }
  f.api = new OctoClient({ ...f.config, fetchImpl: async url => {
    const parsed = new URL(url), path = parsed.pathname, group = path.split('/')[4]
    if (path === '/v1/bot/groups') return Response.json(f.ids.map(group_no => ({ group_no, space_id: 'space' })))
    if (path.endsWith('/mention_pref')) return Response.json({ effective: true, group_allow_no_mention: 1 })
    if (path.endsWith('/threads')) {
      const page = Number(parsed.searchParams.get('page_index'))
      f.pages.push([group, page])
      const response = await f.response?.(group, page)
      if (response) return response
      const count = f.count?.(group) ?? 0
      return Response.json({ count, list: Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) },
        (_, i) => topic(group, (page - 1) * 100 + i)) })
    }
    assert.ok(f.ids.includes(group), 'only synthetic group endpoints are allowed')
    return Response.json({ group_no: group, status: 1 })
  } })
  const listing = f.api.inboxDirectoryGroups.bind(f.api)
  f.api.inboxDirectoryGroups = (...args) => { f.listCalls++; return listing(...args) }
  const open = () => {
    f.store = new Store(root, 'synthetic-retry')
    f.discovery = new DirectoryDiscovery({ api: f.api, store: f.store, config: () => f.config,
      online: () => f.online, paused: () => f.paused, log() {} })
  }
  open()
  f.sweep = () => f.discovery.sweep(t.signal)
  f.restart = () => { f.store.close(); open() }
  f.group = group => ({ ...f.store.db.prepare('SELECT * FROM directory_groups WHERE group_no=?').get(group) })
  t.after(() => {
    f.store.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('octo-directory-retry-'))
    rmSync(root, { recursive: true, force: true })
  })
  return f
}

test('HTTP 429 preserves page through restart, rotates other groups and resumes at Retry-After', async t => {
  const f = fixture(t, [a, b])
  f.count = group => group === a ? 201 : 101
  let limited = true
  f.response = (group, page) => {
    if (group === a && page === 2 && limited) {
      limited = false
      return new Response('', { status: 429, headers: { 'Retry-After': '120' } })
    }
  }
  await f.sweep(); f.now++; await f.sweep(); f.now++; await f.sweep()
  const retryAt = f.now + 120_000
  assert.deepEqual(f.group(a), { group_no: a, page: 2, done: 0, failed: 1, checked_ms: f.now, retry_ms: retryAt })
  assert.equal(f.store.directoryRecovery().failed, true)
  f.now++; await f.sweep()
  assert.equal(f.group(b).done, 1, 'other group advances during A backoff')
  assert.equal(f.store.directoryRecovery().pendingGroups, 1)
  const interrupted = f.group(a)
  f.restart()
  assert.deepEqual(f.group(a), interrupted)
  f.now = retryAt - 1
  await f.sweep(); await f.sweep()
  assert.equal(f.listCalls, 2, 'catalog refresh proceeds without replacing the waiting page')
  assert.deepEqual(f.group(a), interrupted)
  assert.deepEqual(f.pages, [[a, 1], [b, 1], [a, 2], [b, 2], [b, 1], [b, 2]])
  f.now = retryAt
  await f.sweep()
  assert.equal(f.group(a).page, 3)
  assert.equal(f.group(a).retry_ms, 0)
  assert.equal(f.group(a).failed, 0)
  assert.equal(f.store.directoryRecovery().failed, false, 'successful retry clears status before final page')
  assert.equal(f.store.directoryRecovery().ready, false)
  await f.sweep()
  assert.deepEqual(f.pages, [[a, 1], [b, 1], [a, 2], [b, 2], [b, 1], [b, 2], [a, 2], [a, 3]])
  assert.equal(f.store.directoryRecovery().ready, true)
  assert.equal(f.store.directoryRecovery().pendingGroups, 0)
  assert.ok(f.store.inboxRoute(5, topic(a, 200).channel_id), 'previously starved last-page topic is discovered')
  f.restart(); await f.sweep()
  assert.equal(f.listCalls, 2, 'restart preserves the independent listing interval')
})

test('successful retry cannot clear another waiting group failure', async t => {
  const f = fixture(t, [a, b])
  const failed = new Set()
  f.response = group => {
    if (!failed.has(group)) {
      failed.add(group)
      return new Response('', { status: 429, headers: { 'Retry-After': group === a ? '30' : '120' } })
    }
  }
  await f.sweep(); await f.sweep()
  f.now += 30_000
  await f.sweep()
  assert.equal(f.group(a).done, 1)
  assert.equal(f.store.directoryRecovery().failed, true)
  assert.equal(f.store.directoryRecovery().pendingGroups, 1)
  f.restart(); f.now += 90_000; await f.sweep()
  assert.equal(f.group(b).done, 1)
  assert.equal(f.store.directoryRecovery().failed, false)
  await f.sweep() // The independently refreshed catalog rechecks completed A.
  assert.equal(f.store.directoryRecovery().ready, true)
})

for (const failure of ['403', 'malformed', '429']) {
  test(`persistent ${failure} cannot hide a new group or a completed group's new topic`, async t => {
    const f = fixture(t, [a, b])
    let fresh = false
    f.count = group => group === a ? 201 : fresh ? 1 : 0
    f.response = (group, page) => {
      if (group !== a || page !== 2) return
      if (failure === 'malformed') return Response.json({ count: 201, list: [] })
      return new Response('', { status: Number(failure), headers: { 'Retry-After': '300' } })
    }
    await f.sweep(); f.now++; await f.sweep(); f.now++; await f.sweep()
    const waiting = f.group(a)
    assert.equal(waiting.page, 2)
    assert.equal(waiting.done, 0)
    f.restart()
    fresh = true; f.ids = [a, b, c]; f.now = epoch + 60_000
    await f.sweep()
    assert.equal(f.store.directoryListedAt(), f.now)
    assert.equal(f.listCalls, 2)
    assert.deepEqual(f.group(a), waiting, 'refresh preserves pending page, failure and Retry-After exactly')
    assert.ok(f.store.inboxRoute(5, topic(c, 0).channel_id), 'new group gets its first scan')
    f.now++; await f.sweep()
    assert.ok(f.store.inboxRoute(5, topic(b, 0).channel_id), 'completed group is relisted for new topics')
    assert.equal(f.store.directoryRecovery().failed, true)
    if (failure === '429') {
      f.now++; await f.sweep()
      assert.deepEqual(f.group(a), waiting, 'refresh must not waive a future Retry-After')
    }
    // A successful directory refresh can retire a group that is no longer listed.
    f.ids = [b, c]; f.now = epoch + 120_000; await f.sweep()
    assert.deepEqual(f.group(a), {})
    assert.equal(f.store.directoryRecovery().failed, false)
    assert.ok(f.store.inboxRoute(2, a), 'removing the catalog candidate does not delete recovery data')
  })
}

test('catalog refresh failure and backoff do not stop pending forward pages', async t => {
  const f = fixture(t)
  f.count = () => 201
  await f.sweep()
  const listing = f.api.inboxDirectoryGroups
  let attempts = 0
  f.api.inboxDirectoryGroups = async () => {
    attempts++
    throw Object.assign(new Error('synthetic catalog outage'), { retryAfterMs: 120_000 })
  }
  f.now += 60_000
  await f.sweep(); await f.sweep()
  assert.deepEqual(f.pages, [[a, 1], [a, 2], [a, 3]])
  assert.equal(attempts, 1)
  assert.equal(f.store.directoryRecovery().failed, true, 'successful pages cannot hide the catalog failure')
  assert.equal(f.store.directoryRecovery().pendingGroups, 0)
  assert.equal(f.store.directoryListedAt(), epoch, 'only a successful listing changes the durable clock')
  f.api.inboxDirectoryGroups = listing
  f.now += 119_999; await f.sweep()
  assert.equal(f.listCalls, 1)
  f.now++; await f.sweep()
  assert.equal(f.listCalls, 2)
  assert.equal(f.store.directoryRecovery().failed, false)
})

test('frequent catalog refreshes cannot starve pending groups behind reset completed groups', async t => {
  const f = fixture(t, [a, b, c])
  // One page per refresh: resetting completed checked_ms to zero would always
  // select A and prevent B/C from ever being visited.
  await f.sweep()
  f.now += 60_000; await f.sweep()
  f.now += 60_000; await f.sweep()
  assert.deepEqual(f.pages, [[a, 1], [b, 1], [c, 1]])
})

for (const change of ['config', 'pause', 'abort']) {
  test(`stale catalog refresh cannot replace candidates after ${change}`, async t => {
    const f = fixture(t)
    f.count = () => 201
    await f.sweep()
    const before = f.group(a), listedAt = f.store.directoryListedAt()
    f.now += 60_000
    let release
    f.api.inboxDirectoryGroups = () => new Promise(resolve => { release = resolve })
    const controller = new AbortController()
    const running = f.discovery.sweep(controller.signal)
    while (!release) await Promise.resolve()
    if (change === 'config') f.config = { ...f.config }
    if (change === 'pause') f.paused = true
    if (change === 'abort') controller.abort()
    release([b]); await running
    assert.deepEqual(f.group(a), before)
    assert.deepEqual(f.group(b), {})
    assert.equal(f.store.directoryListedAt(), listedAt)
  })
}

for (const [header, status, wait] of [
  [undefined, 503, 30_000], ['1', 429, 30_000], ['invalid', 429, 30_000],
  [new Date(epoch + 90_000).toUTCString(), 429, 90_000],
]) test(`bounded retry for HTTP ${status}, Retry-After=${header}`, async t => {
  const f = fixture(t)
  f.response = () => new Response('', { status, headers: header === undefined ? {} : { 'Retry-After': header } })
  await f.sweep()
  assert.equal(f.group(a).retry_ms, epoch + wait)
  f.restart(); f.now += wait - 1; await f.sweep()
  assert.equal(f.pages.length, 1)
  f.response = undefined; f.now++; await f.sweep()
  assert.equal(f.pages.length, 2)
  assert.equal(f.store.directoryRecovery().failed, false)
})

test('invalid retry hints cannot poison deadlines or cause immediate retries', async t => {
  const f = fixture(t)
  for (const hint of [NaN, Infinity, -Infinity, '60000', -1, Number.MAX_VALUE]) {
    f.api.inboxDirectoryPage = async () => { throw Object.assign(new Error('synthetic'), { retryAfterMs: hint }) }
    await f.sweep()
    assert.equal(f.group(a).retry_ms, f.now + 30_000)
    assert.equal(f.store.nextDirectoryGroup(f.now + 29_999), undefined)
    f.now += 30_000
  }
})

test('a stale failure cannot schedule retries after config replacement, pause or abort', async t => {
  const f = fixture(t)
  f.store.activateDirectoryRecovery(); f.store.beginDirectoryScan([a])
  const before = f.group(a)
  for (const change of ['config', 'pause', 'abort']) {
    const controller = new AbortController()
    let release
    f.api.inboxDirectoryPage = () => new Promise((_resolve, reject) => { release = reject })
    const running = f.discovery.sweep(controller.signal)
    while (!release) await Promise.resolve()
    if (change === 'config') f.config = { ...f.config }
    if (change === 'pause') f.paused = true
    if (change === 'abort') controller.abort()
    release(new Error('stale failure'))
    if (change === 'abort') await assert.rejects(running)
    else await running
    assert.deepEqual(f.group(a), before)
    assert.equal(f.store.directoryRecovery().failed, false)
    f.paused = false
  }
})
