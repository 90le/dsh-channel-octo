import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { OctoClient, admit } from '../src/octo.js'
import { resolveConfig } from '../src/config.js'
import { Worker } from '../src/worker.js'

const group = '00112233445566778899aabbccddeeff'
const topic = group + '____123456789012345678'
const signal = new AbortController().signal
const base = {
  apiBase: 'https://octo.invalid/api', botUid: 'bot', spaceId: 'space', cwd: resolve('.'),
  senderPolicy: 'octo', channelPolicy: 'joined', mentionPolicy: 'octo',
}
const opts = resolveConfig(base, { DSH_OCTO_BOT_TOKEN: 'bf_fixture' })
const job = (type, channel, sender = 'human', ambient = 0) => ({
  seq: 1, state: 'queued', input: 'hello', channel_type: type, channel_id: channel, sender, ambient,
})

test('friend/member mode needs no local UID list, and no-mention mode selects real-time transport', () => {
  assert.equal(opts.allowed.size, 0)
  assert.equal(opts.transport, 'websocket')
  assert.throws(() => resolveConfig({ ...base, transport: 'events' }, { DSH_OCTO_BOT_TOKEN: 'bf_fixture' }), /requires_websocket/)
  assert.throws(() => resolveConfig({ ...base, allowedUids: ['human'] }, { DSH_OCTO_BOT_TOKEN: 'bf_fixture' }), /invalid_user_allowlist/)
  assert.throws(() => resolveConfig(base, { DSH_OCTO_BOT_TOKEN: 'app_fixture' }), /require_user_bot/)
})

test('ordinary text may request Octo preference; another mention or broadcast never does', () => {
  const msg = (mention, text = 'hello') => ({ message: {
    message_id: '1', channel_id: topic, channel_type: 5, from_uid: 'human', payload: { type: 1, content: text, mention },
  } })
  assert.equal(admit(msg(), opts).ambient, true)
  assert.equal(admit(msg({ uids: ['bot'] }), opts).ambient, false)
  assert.equal(admit(msg({ uids: ['someone-else'] }), opts), undefined)
  assert.equal(admit(msg({ ais: 1, uids: ['bot'] }), opts), undefined)
  assert.equal(admit(msg({ all: true }), opts), undefined)
  assert.equal(admit(msg({}, '@someone-else hello'), opts), undefined)
  assert.equal(admit(msg(), { ...opts, mentionPolicy: 'required' }), undefined)
  assert.equal(admit({ message: { ...msg().message, from_uid: 'bot' } }, opts), undefined)
})

test('Octo checks DM friendship and group participation; child uses parent preference', async () => {
  const paths = []
  let enabled = true
  let groupAllows = true
  let joined = true
  let groupStatus = 1
  let activeParent = true
  let topicStatus = 1
  const root = '/api/v1/bot/groups/' + group
  const topicInfo = () => ({ group_no: group, short_id: topic.split('____')[1],
    channel_id: topic, channel_type: 5, status: topicStatus })
  const client = new OctoClient({
    apiBase: opts.apiBase, token: 'bf_fixture',
    fetchImpl: async (url, request) => {
      const path = new URL(url).pathname
      paths.push(path)
      if (path.endsWith('/messages/sync')) {
        const body = JSON.parse(request.body)
        assert.equal(body.limit, 1)
        assert.equal(body.on_behalf_of, undefined)
        return body.channel_id === 'friend' ? Response.json({ messages: [] }) : new Response(null, { status: 403 })
      }
      if (path.endsWith('/mention_pref')) return Response.json({ effective: enabled, group_allow_no_mention: groupAllows })
      if (path.endsWith('/groups')) {
        assert.equal(new URL(url).searchParams.get('space_id'), 'space')
        return Response.json(joined ? [{ group_no: group, space_id: 'space' }] : [])
      }
      if (path === root) {
        assert.equal(request.method, 'GET')
        return Response.json({ group_no: group, status: groupStatus })
      }
      if (path === root + '/threads') {
        assert.equal(request.method, 'GET')
        assert.equal(new URL(url).searchParams.get('page_index'), '1')
        assert.equal(new URL(url).searchParams.get('page_size'), '1')
        // This endpoint proves active parent membership; the member DTO below
        // deliberately has no status field and cannot stand in for this gate.
        if (!activeParent) return new Response(null, { status: 403 })
        return Response.json({ count: topicStatus === 1 ? 1 : 0, list: topicStatus === 1 ? [topicInfo()] : [] })
      }
      if (path === root + '/threads/' + topic.split('____')[1]) {
        assert.equal(request.method, 'GET')
        return Response.json(topicInfo())
      }
      if (path.endsWith('/members')) return Response.json([
        { uid: 'bot', robot: 1 }, { uid: 'human', robot: 0 }, { uid: 'otherbot', robot: true }, { uid: 'unknown' },
      ])
      throw new Error('unexpected path')
    },
  })
  assert.equal(await client.allowsMessage(opts, job(1, 'friend', 'friend'), signal), true)
  await assert.rejects(client.allowsMessage(opts, job(1, 'stranger', 'stranger'), signal), /http_403/)
  assert.equal(await client.allowsMessage(opts, job(2, group), signal), true)
  assert.equal(await client.allowsMessage(opts, job(5, topic, 'human', 1), signal), true)
  assert.ok(paths.includes('/api/v1/bot/groups/' + group + '/mention_pref'))
  assert.ok(paths.indexOf(root + '/threads') < paths.indexOf(root + '/mention_pref'))
  assert.ok(paths.indexOf(root + '/threads/' + topic.split('____')[1]) < paths.indexOf(root + '/mention_pref'))
  assert.equal(await client.allowsMessage(opts, job(5, topic, 'stranger', 1), signal), false)
  assert.equal(await client.allowsMessage(opts, job(5, topic, 'otherbot', 1), signal), false)
  assert.equal(await client.allowsMessage(opts, job(5, topic, 'unknown', 1), signal), false)
  activeParent = false
  await assert.rejects(client.allowsMessage(opts, job(5, topic, 'human', 1), signal), /http_403/)
  activeParent = true
  groupStatus = 2
  assert.equal(await client.allowsMessage(opts, job(2, group, 'human', 1), signal), false)
  groupStatus = 1
  topicStatus = 2
  assert.equal(await client.allowsMessage(opts, job(5, topic, 'human', 1), signal), false)
  topicStatus = 1
  enabled = false
  assert.equal(await client.allowsMessage(opts, job(5, topic, 'human', 1), signal), false)
  assert.equal(await client.allowsMessage(opts, job(5, topic), signal), true) // explicit @ still works
  enabled = true
  groupAllows = false
  assert.equal(await client.allowsMessage(opts, job(2, group, 'human', 1), signal), false)
  joined = false
  assert.equal(await client.allowsMessage(opts, job(2, group), signal), false)
})

test('a denied or unavailable Octo policy never calls the model', async () => {
  for (const [value, expected] of [[false, ['octo_access_denied']], [new Error('secret data'), ['access_internal_error', 'review']]]) {
    const discarded = []
    const worker = new Worker({
      config: opts, log() {}, store: { discard(_seq, ...args) { discarded.push(args) } },
      api: { async allowsMessage() { if (value instanceof Error) throw value; return value } },
      host: { run: () => assert.fail('model must not run') },
    })
    await worker.process(job(5, topic, 'human', 1), signal)
    assert.deepEqual(discarded, [expected])
  }
})
