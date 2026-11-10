import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { OctoClient } from '../src/octo.js'

test('only an exact authorized channel can supply the group and subarea name', async () => {
  const group = 'a'.repeat(32), topic = '123456789012345', address = group + '____' + topic
  const calls = []
  let returnedTopic = topic, returnedGroup = group
  const octo = new OctoClient({ apiBase: 'https://octo.invalid/api', token: 'bf_navigation_fixture',
    fetchImpl: async url => {
      const path = new URL(url).pathname
      calls.push(path)
      if (path.endsWith('/groups')) return Response.json([{ group_no: returnedGroup, space_id: 'space', name: 'Agent test group' }])
      return Response.json({ group_no: group, short_id: returnedTopic, channel_id: address, channel_type: 5, status: 1, name: 'Documents' })
    } })
  const signal = new AbortController().signal
  const config = { spaceId: 'space', channelPolicy: 'allowlist', threads: new Set([address]) }
  assert.deepEqual(await octo.refreshNavigation(config, 5, group + '____123456789012346', signal), [])
  assert.deepEqual(calls, [])
  returnedTopic = '123456789012346'
  assert.deepEqual(await octo.refreshNavigation(config, 5, address, signal), [[2, group, 'Agent test group']])
  returnedTopic = topic
  assert.deepEqual(await octo.refreshNavigation(config, 5, address, signal), [[2, group, 'Agent test group'], [5, address, 'Documents']])
  returnedGroup = 'b'.repeat(32)
  assert.deepEqual(await octo.refreshNavigation(config, 5, address, signal), [])
  assert.equal(calls.length, 5)
})

test('main is above newer topics; task projection hides empty owned directories but retains local tasks', () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const implementation = source.slice(source.indexOf('    const folderPrefix'), source.indexOf('    function nativeTabRegistry'))
  const { octoFolders, taskWorkspaceProjection } = new Function('shortId', implementation
    + '; return { octoFolders, taskWorkspaceProjection }')(x => x)
  const routes = [{ id: 'topic', type: 5, group: 'g', address: 'g-topic', groupName: 'Group', name: 'Documents', updatedAt: 20 },
    { id: 'main', type: 2, group: 'g', address: 'g', groupName: 'Group', updatedAt: 10 }]
  const folders = octoFolders(routes, { byId: { topic: {}, main: {} } }, false, x => x, false, [])
  assert.deepEqual(folders.map(row => row.title), ['group', 'Group', 'mainArea', 'Documents'])
  const botRoutes = routes.map(row => ({ ...row, accountId: 'one', accountLabel: 'First bot' }))
  botRoutes.push({ ...botRoutes[1], id: 'other', accountId: 'two', accountLabel: 'Second bot' })
  const grouped = octoFolders(botRoutes, { byId: { topic: {}, main: {}, other: {} } }, true, x => x, false, [])
  assert.deepEqual(grouped.filter(row => row.path.split('/').length === 2).map(row => row.title), ['First bot', 'Second bot'])
  assert.equal(grouped.find(row => row.sessionIds.includes('other')).path.includes('bot%3Atwo'), true)
  const rows = { items: [{ path: '/srv/agents/dsh/octo', sessionIds: [] }, { path: '/other', sessionIds: [] }] }
  const phase = 'ready', paths = new Set(['/srv/agents/dsh/octo']), known = new Set(['topic','main'])
  assert.deepEqual(taskWorkspaceProjection(rows, known, paths, { phase, ids: [], byId: {} }).items, [rows.items[1]])
  assert.equal(taskWorkspaceProjection(rows, known, paths, { phase, ids: ['local'], byId: { local: { cwd: rows.items[0].path } } }), rows)
})


test('unchanged polls retain snapshots and route references; updates and removed fields still notify', () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const implementation = source.slice(source.indexOf('    const listeners = new Set()'), source.indexOf('    const tFor'))
  const store = new Function(implementation + '; return { read, publish, subscribe }')()
  let notifications = 0
  store.subscribe(() => notifications++)
  store.publish({ sessionRoutes: [{ id: 'one', type: 1 }], accounts: [{ id: 'bot' }], status: 'online', error: 'old' })
  const original = store.read()
  store.publish(JSON.parse(JSON.stringify(original)))
  assert.equal(store.read(), original)
  assert.equal(notifications, 1)
  store.publish({ ...original, status: 'reconnecting' })
  assert.equal(store.read().sessionRoutes, original.sessionRoutes)
  assert.equal(notifications, 2)
  store.publish({ sessionRoutes: [{ id: 'one', type: 2 }], accounts: [{ id: 'bot' }], status: 'online' })
  assert.notEqual(store.read().sessionRoutes, original.sessionRoutes)
  assert.equal(store.read().accounts, original.accounts)
  assert.equal(Object.hasOwn(store.read(), 'error'), false)
  assert.equal(notifications, 3)
  store.publish({})
  assert.equal(Object.hasOwn(store.read(), 'sessionRoutes'), false)
})
