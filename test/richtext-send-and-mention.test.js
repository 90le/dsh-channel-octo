import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChannelApi } from '../src/channel-api.js'

const sender = 'fixture-human', bot = 'fixture-bot', space = 'fixture-space'
const group = 'a'.repeat(32), short = '123456789012345678'
const root = '/v1/bot/groups/' + group
const dm = { channel_type: 1, channel_id: sender }
const topic = { channel_type: 5, channel_id: group + '____' + short }
const image = { type: 'image', url: 'https://images.example.com/test.png', width: 20, height: 40 }
const args = { confirm_send: true, blocks: [{ type: 'text', text: 'Before' }, image, { type: 'text', text: 'After' }] }
const runtime = { richtextActive: () => true, authorizeRichtext: async () => true }
const receipt = '9007199254740999'

function fixture({ config = {}, members, preference, send } = {}) {
  const calls = []
  const api = new ChannelApi({ config: { botUid: bot, spaceId: space, allowFiles: true, mentionPolicy: 'octo',
    transport: 'websocket', ...config }, request: async (path, body, _signal, options) => {
    calls.push({ path, body: body && JSON.parse(body), method: options.method })
    if (path.startsWith('/v1/bot/groups?')) return [{ group_no: group, space_id: space }]
    if (path === root) return { group_no: group, name: 'Fixture', status: 1 }
    if (path === root + '/members') return members ?? [{ uid: sender, name: 'Human', robot: 0, role: 0 },
      { uid: bot, name: 'Bot', robot: 1, role: 0 }]
    if (path === root + '/threads/' + short) return { group_no: group, short_id: short, ...topic,
      name: 'Fixture topic', creator_uid: bot, status: 1 }
    if (path === root + '/mention_pref') return preference ?? { no_mention: 1, effective: true, group_allow_no_mention: 1 }
    if (path === '/v1/bot/messages/sync') return { messages: [] }
    if (path === '/v1/bot/sendMessage') return send ? send() : { message_id: receipt }
    assert.fail('Unexpected request: ' + path)
  } })
  return { api, calls }
}

test('native richtext sends ordered blocks to the current DM and does not add a raw payload or quote', async t => {
  const { api, calls } = fixture()
  assert.deepEqual(await api.dispatch(dm, sender, 'messages.send_richtext', args, t.signal, runtime),
    { ok: true, message_id: receipt, format: 'richtext', requiresFinalSummary: true })
  assert.deepEqual(calls.at(-1), { path: '/v1/bot/sendMessage', method: 'POST',
    body: { ...dm, payload: { type: 14, content: args.blocks } } })
  assert.equal(calls.filter(x => x.path === '/v1/bot/sendMessage').length, 1)
})

test('richtext checks confirmation, file gate, host permission and authorization at dispatch', async t => {
  const f = fixture()
  const send = (input, host, who = sender) => f.api.dispatch(dm, who, 'messages.send_richtext', input, t.signal, host)
  await assert.rejects(send({ ...args, confirm_send: false }, runtime), { code: 'explicit_confirmation_required' })
  await assert.rejects(send({ ...args, channel_id: 'another-dm' }, runtime), { code: 'invalid_arguments' })
  await assert.rejects(send(args), { code: 'requester_not_allowed' })
  await assert.rejects(send(args, runtime, 'another-human'), { code: 'requester_not_allowed' })
  await assert.rejects(send(args, { ...runtime, authorizeRichtext: async () => false }), { code: 'requester_not_allowed' })
  assert.ok(!f.calls.some(x => x.path === '/v1/bot/sendMessage'))
  const off = fixture({ config: { allowFiles: false } })
  await assert.rejects(off.api.dispatch(dm, sender, 'messages.send_richtext', args, t.signal, runtime), { code: 'files_disabled' })
  assert.deepEqual(off.calls, [])
})

test('a confirmed richtext receipt survives revocation; uncertain sends are not retried', async t => {
  const writing = Promise.withResolvers(), response = Promise.withResolvers()
  const f = fixture({ send: () => { writing.resolve(); return response.promise } })
  const dispatch = f.api.dispatch(dm, sender, 'messages.send_richtext', args, t.signal, runtime)
  await writing.promise
  f.api.revoke()
  response.resolve({ message_id: receipt })
  assert.equal((await dispatch).authority_changed, true)
  const failed = fixture({ send() { throw new Error('transport lost after sending') } })
  await assert.rejects(failed.api.dispatch(dm, sender, 'messages.send_richtext', args, t.signal, runtime),
    { code: 'mutation_unconfirmed' })
  assert.equal(failed.calls.filter(x => x.path === '/v1/bot/sendMessage').length, 1)
})

test('topic mention diagnosis uses only its parent group and distinguishes Octo and plugin policy', async t => {
  const enabled = fixture()
  assert.deepEqual(await enabled.api.dispatch(topic, sender, 'group.mention_preference', {}, t.signal),
    { group_no: group, source: 'parent_group', server_no_mention: true, group_allows_no_mention: true,
      plugin_follows_octo: true, requires_mention: false })
  assert.equal(enabled.calls.at(-1).path, root + '/mention_pref')
  const local = fixture({ config: { mentionPolicy: 'required' } })
  assert.equal((await local.api.dispatch(topic, sender, 'group.mention_preference', {}, t.signal)).requires_mention, true)
  const denied = fixture({ preference: { no_mention: 1, group_allow_no_mention: 0 } })
  assert.equal((await denied.api.dispatch(topic, sender, 'group.mention_preference', {}, t.signal)).requires_mention, true)
  await assert.rejects(enabled.api.dispatch(dm, sender, 'group.mention_preference', {}, t.signal), { code: 'group_required' })
})
