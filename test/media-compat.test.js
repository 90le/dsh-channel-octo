import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { admit, OctoClient, readJson } from '../src/octo.js'
import { normalizeOctoContent } from '../src/octo-content.js'
import { prepareInput } from '../src/dsh-media.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const endpoint = 'https://octo.example.invalid/api'
const storage = 'https://storage.example.invalid'
const cdn = 'https://cdn.example.invalid'
const group = '00112233445566778899aabbccddeeff'
const topic = group + '____123456789012345678'
const config = { botUid: 'bot', spaceId: 'space', ownerUid: 'alice', senderPolicy: 'octo', channelPolicy: 'joined',
  mentionPolicy: 'required', allowed: new Set(), allowFiles: true, transport: 'websocket',
  toolPermission: 'workspace-write', apiBase: endpoint, token: 'bf_fixture_media', waitSeconds: 5,
  mediaDownloadOrigins: [cdn], mediaUploadOrigins: [storage] }
const send = (id, payload, channelType = 1, sender = 'alice') => ({ event_id: id, message: {
  message_id: id, from_uid: sender, channel_type: channelType, channel_id: channelType === 5 ? topic : group, payload,
} })
const control = () => new AbortController()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64')

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-wire-'))
  const store = new Store(cwd, 'fixture-bot')
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  return { cwd, store }
}

test('ordered rich text, inline quote, duplicated media, and nested forwards use bounded safe content', () => {
  const payload = { type: 14, plain: 'obsolete plain projection', content: [
    { type: 'text', text: 'Before ' },
    { type: 'image', url: cdn + '/images/first.png' },
    { type: { toString: null }, text: ' middle ' },
    { type: 'file', url: '/api/v1/file/preview/chat/example/note.txt', name: 'note.txt' },
    { type: 'image', url: cdn + '/images/first.png' },
    { type: 'image', url: { malformed: true } },
    { type: 'text', text: ' after' },
  ], reply: { from_name: 'A', payload: { type: 11, users: [{ uid: 'x', name: 'Quoted' }], msgs: [
    { from_uid: 'x', payload: { type: 14, content: [{ type: 'text', text: 'Quoted inline' }] } },
    { payload: { type: 17, plain: 'Card text', card: { actions: [{ title: 'Never execute' }] } } },
  ] } } }
  const decoded = admit(send('4', payload), config)
  assert.equal(decoded.attachments.length, 2)
  assert.equal(decoded.parts.filter(part => part.media !== undefined).length, 2)
  assert.match(decoded.parts[0].text, /引用消息.*A.*\n.*转发.*\nQuoted：Quoted inline/s)
  assert.match(decoded.parts[0].text, /Card text/)
  assert.doesNotMatch(JSON.stringify(decoded.parts), /Never execute|obsolete plain projection|cdn\.example/)
  assert.match(decoded.text, /^Before.*middle.*重复图片.*附件不可用.*after$/u)
  const withNoMedia = normalizeOctoContent(payload)
  assert.equal(withNoMedia.attachments, undefined)
  assert.match(withNoMedia.text, /账号未启用附件/)
  assert.equal(admit(send('4', payload, 5), config), undefined)
  assert.equal(admit(send('4', { ...payload, mention: { uids: ['bot'] } }, 5), config).channelId, topic)
  const idOnly = readJson('{"type":1,"content":"look","reply":{"message_id":9223372036854775807}}')
  assert.match(normalizeOctoContent(idOnly).parts[0].text, /原文未随消息提供/)
  assert.equal(admit(send('4', { type: 1, event: { type: 'system' }, content: 'test' }), config), undefined)
  assert.doesNotThrow(() => normalizeOctoContent({ type: 14, content: Array(250).fill({ type: null, text: '甲'.repeat(10000) }) }))
})

test('native DSH mixed input keeps order and continues past a rejected image', async () => {
  const invalid = Object.assign(new Error('corrupt'), { code: 'INVALID_IMAGE' })
  const native = { id: 'image-fixture' }
  const ctx = { attachments: {
    async saveImages(items) { if (items.some(item => item.name === 'bad.png')) throw invalid; return [native] },
  } }
  const file = (name, bytes) => ({ name, mime: 'image/png', bytes })
  const result = await prepareInput(ctx, {}, 'unused', [file('good.png', png), file('bad.png', Buffer.from('x'))],
    control().signal, [{ text: 'opening' }, { media: 0 }, { text: 'next' }, { media: 1 }, { text: 'end' }])
  assert.deepEqual(result, [{ type: 'text', text: 'opening' }, { type: 'image', attachment: native },
    { type: 'text', text: 'next' }, { type: 'text', text: '【此图片未能进入 DSH】' }, { type: 'text', text: 'end' }])
})

for (const mode of ['native', 'unsupported', 'unknown']) test('rich-image sending and quote receipts: ' + mode, async t => {
  const { cwd, store } = fixture(t)
  writeFileSync(join(cwd, 'pixel.png'), png)
  writeFileSync(join(cwd, 'report.txt'), 'document')
  let puts = 0
  const payloads = []
  const current = { ...config, cwd, fetchImpl: async (input, init) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/messages/sync')) return Response.json({ messages: [] })
    if (url.origin === cdn) {
      if (url.pathname.endsWith('missing.png')) return new Response(null, { status: 404 })
      if (url.pathname.endsWith('in.png')) return new Response(png, { headers: { 'Content-Type': 'image/png' } })
    }
    if (url.origin === storage) {
      puts++
      assert.equal(init.headers.Authorization, undefined)
      return new Response(null, { status: 200 })
    }
    if (url.pathname.endsWith('/upload/presigned')) {
      const name = url.searchParams.get('filename')
      return Response.json({ method: 'PUT', uploadUrl: storage + '/' + name + '?signature=fixture',
        downloadUrl: cdn + '/' + name, contentType: name.endsWith('.png') ? 'image/png' : 'text/plain' })
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const { channel_id, channel_type, payload } = JSON.parse(init.body)
      assert.equal(channel_id, 'alice')
      assert.equal(channel_type, 1)
      assert.deepEqual(payload.reply, { message_id: '9223372036854775807' })
      payloads.push(payload)
      if (payload.type === 14 && mode === 'unsupported') return new Response(null, { status: 422 })
      if (payload.type === 14 && mode === 'unknown') throw new Error('lost acknowledgement')
      return Response.json({ message_id: String(100 + payloads.length) })
    }
    assert.fail('unexpected request')
  } }
  const worker = new Worker({ api: new OctoClient(current), store, config: current, log() {}, host: {
    async run(_session, _text, created, _signal, _rules, _progress, _timeout, allowed, extras) {
      assert.equal(allowed, true)
      await created()
      assert.deepEqual(extras.attachments.map(item => item.bytes), [png])
      assert.match(extras.order[0].text, /inline quote/)
      assert.deepEqual(extras.order.find(part => part.media === 0), { media: 0 })
      assert.ok(extras.order.some(part => part.text === '【附件未能读取】'))
      extras.onDeliverables([join(cwd, 'pixel.png'), join(cwd, 'report.txt')])
      return 'Final answer with image and file'
    },
  } })
  const id = '9223372036854775807'
  store.add(id, admit(send(id, { type: 14, content: [
    { type: 'text', text: 'Inspect ' }, { type: 'image', url: cdn + '/in.png' },
    { type: 'image', url: cdn + '/missing.png' }, { type: 'text', text: ' and reply' },
  ], reply: { payload: { type: 1, content: 'inline quote' } } }), current))
  await worker.process(store.next(Date.now()), control().signal)
  assert.equal(puts, 2)
  assert.deepEqual(payloads.map(p => p.type), mode === 'unsupported' ? [8, 14, 2, 1] : [8, 14])
  assert.deepEqual(payloads[1].content, [
    { type: 'text', text: 'Final answer with image and file' }, { type: 'image', url: cdn + '/pixel.png', width: 1, height: 1 },
  ])
  const job = store.db.prepare('select state, issue from jobs').get()
  assert.equal(job.state, mode === 'unknown' ? 'review' : 'sent')
  assert.equal(store.next(Date.now()), undefined)
})

test('file-follow-up in steer mode joins the in-flight upload and only the combined answer is sent', async t => {
  const { cwd, store } = fixture(t)
  const stop = control()
  const fetching = Promise.withResolvers(), bytes = Promise.withResolvers()
  const delivered = Promise.withResolvers()
  const current = { ...config, cwd, sendMode: 'steer', fetchImpl: async (input, init) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/messages/sync')) return Response.json({ messages: [] })
    if (url.origin === cdn) { fetching.resolve(); return bytes.promise }
    if (url.pathname.endsWith('/sendMessage')) {
      const request = JSON.parse(init.body)
      assert.equal(request.payload.content, 'answer to the combined request')
      delivered.resolve()
      return Response.json({ message_id: '501' })
    }
    assert.fail('unexpected fixture request')
  } }
  let runs = 0
  const worker = new Worker({ api: new OctoClient(current), store, config: current, log() {}, host: {
    async run(_session, text, created, _signal, _rules, _progress, _timeout, _allowed, extra) {
      runs++
      await created()
      assert.match(text, /Read the file and summarize its first line/)
      assert.deepEqual(extra.order[0], { media: 0 })
      assert.match(extra.order.at(-1).text, /summarize/)
      return 'answer to the combined request'
    },
  } })
  worker.acceptInbound('1', admit(send('1', { type: 8, url: cdn + '/note.txt' }), current))
  const running = worker.drain(stop.signal).catch(error => { if (!stop.signal.aborted) throw error })
  try {
    await fetching.promise
    worker.acceptInbound('2', admit(send('2', { type: 1, content: 'Read the file and summarize its first line' }), current))
    bytes.resolve(new Response('first line', { headers: { 'Content-Type': 'text/plain' } }))
    await delivered.promise
    await delay(25)
    assert.deepEqual(store.db.prepare("SELECT state,result_id FROM jobs ORDER BY seq").all().map(j => [j.state, j.result_id]),
      [['sent', '501'], ['sent', '501']])
    assert.equal(runs, 1)
  } finally { stop.abort(); await running }
})

test('group context uses only the current group/topic and earlier positions; DMs only resolve an explicit quote', async t => {
  const { cwd, store } = fixture(t)
  const fetched = [], passed = []
  const current = { ...config, cwd }
  const row = (seq, id, sender, payload, extra = {}) => ({ message_seq: seq, message_id: id, from_uid: sender,
    payload: Buffer.from(JSON.stringify(payload)).toString('base64'), ...extra })
  const payload = content => ({ type: 1, content })
  current.fetchImpl = async (input, init) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/messages/sync')) {
      const req = JSON.parse(init.body)
      if (req.limit === 1) return Response.json({ messages: [] })
      fetched.push([req.channel_id, req.channel_type, req.start_message_seq])
      const forDm = req.channel_type === 1
      return Response.json({ messages: [
        row(10, '10', 'alice', payload('trigger or later')),
        row(9, '9', 'other', payload('revoked'), { revoke: 1 }),
        row(8, '8', forDm ? 'alice' : 'other', payload('quoted earlier note')),
        row(7, '7', 'other', payload('another channel'), { channel_type: 5, channel_id: 'different' }),
        row(6, '6', 'other', { type: 14, content: [{ type: 'text', text: 'recent group context' }] }),
        row(5, '5', 'bot', payload('own previous output')),
      ] })
    }
    if (url.pathname.endsWith('/sendMessage')) return Response.json({ message_id: '900' })
    assert.fail('unexpected synthetic request')
  }
  const api = new OctoClient(current)
  api.allowsMessage = async () => true
  api.rules = async () => []
  const worker = new Worker({ api, store, config: current, log() {}, host: {
    async run(_session, _text, created, _signal, _rules, _progress, _timeout, _allowed, extras) {
      await created()
      passed.push(extras.channelContext)
      return 'reply'
    },
  } })
  for (const [i, type] of [2,5,1].entries()) {
    const id = String(100 + i)
    const ev = send(id, { ...payload('context please'),
      mention: { entities: [{ uid: 'bot', offset: 0, length: 3 }] },
      ...(type === 1 && { reply: { message_id: '8' } }) }, type)
    ev.message.message_seq = 10
    store.add(id, admit(ev, current))
    await worker.process(store.next(Date.now()), control().signal)
  }
  assert.deepEqual(fetched, [[group,2,9], [topic,5,9], ['alice',1,9]])
  assert.deepEqual(passed[0].history.map(row => row.text), ['recent group context','quoted earlier note'])
  assert.deepEqual(passed[1].history.map(row => row.text), passed[0].history.map(row => row.text))
  assert.equal(passed[2].history, undefined)
  assert.deepEqual(passed[2].quote, { sender: 'alice', text: 'quoted earlier note' })
})
