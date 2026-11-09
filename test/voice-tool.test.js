import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OctoClient } from '../src/octo.js'
import { voiceTool } from '../src/voice-tool.js'

const signal = new AbortController().signal
const audio = { name: '测试.wav', mime: 'audio/wav', bytes: Buffer.from('RIFF-fixture') }
const client = fetchImpl => new OctoClient({ token: 'bf_fixture', apiBase: 'https://octo.invalid/api', fetchImpl })

test('voice transcription sends only admitted bytes as multipart to the fixed Octo endpoint', async () => {
  let count = 0
  const api = client(async (url, options) => {
    count++
    assert.equal(url, 'https://octo.invalid/api/v1/bot/voice/transcribe')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer bf_fixture')
    assert.equal(options.headers['Content-Type'], undefined)
    assert.deepEqual([...options.body.keys()], ['audio', 'mode'])
    const file = options.body.get('audio')
    assert.equal(file.name, audio.name)
    assert.equal(file.type, 'audio/wav')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio.bytes)
    assert.equal(options.body.get('mode'), 'append')
    return Response.json({ status: 200, text: '请生成一份测试摘要。', unknown: 'not returned' })
  })
  const tool = voiceTool(api, [{ name: 'text.txt', mime: 'text/plain', bytes: Buffer.from('text') }, audio])
  assert.deepEqual(tool.spec.parameters.properties.attachment.enum, [1])
  assert.deepEqual(await tool.execute({ attachment: 1 }, signal), {
    text: '请生成一份测试摘要。', mode: 'append', attachment: 1, source: 'current_message_audio',
  })
  await tool.execute({ attachment: 1, mode: 'append' }, signal)
  assert.equal(count, 1)
})

test('voice tool rejects foreign attachment selectors, files and arbitrary transport arguments', async () => {
  let count = 0
  const api = { async transcribe() { count++; return { text: 'recognized' } } }
  assert.equal(voiceTool(api, []), undefined)
  assert.equal(voiceTool(api, [{ ...audio, mime: 'text/plain' }]), undefined)
  const tool = voiceTool(api, [audio])
  for (const args of [null, [], { attachment: -1 }, { attachment: 1 }, { attachment: '0' },
    { attachment: 0, mode: 'append_only' }, { attachment: 0, url: 'https://elsewhere.invalid/file' },
    { attachment: 0, path: '/etc/hosts' }]) await assert.rejects(tool.execute(args, signal), /invalid_voice_arguments/)
  await assert.rejects(tool.execute({ attachment: 0 }, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(count, 0)
})

test('voice API validates audio and bot identity before any request and preserves error classifications', async () => {
  let count = 0
  const fetchImpl = async () => { count++; return Response.json({ text: 'yes' }) }
  const api = client(fetchImpl)
  for (const attachment of [undefined, { ...audio, bytes: Buffer.alloc(0) }, { ...audio, mime: 'video/mp4' },
    { ...audio, mime: 'audio/wav\r\nheader' }, { ...audio, bytes: Buffer.alloc(16 * 1024 * 1024 + 1) }]) {
    await assert.rejects(api.transcribe(attachment, 'append', signal), /invalid_voice_attachment/)
  }
  const app = new OctoClient({ token: 'app_fixture', apiBase: 'https://octo.invalid', fetchImpl })
  await assert.rejects(app.transcribe(audio, 'append', signal), /voice_requires_user_bot/)
  assert.equal(count, 0)
  for (const status of [403, 413, 429, 502]) {
    await assert.rejects(client(async () => new Response('private upstream detail', { status }))
      .transcribe(audio, 'edit', signal), { code: 'http_' + status, status })
  }
  for (const result of [{}, { text: '' }, { text: 'x', status: 500 }, { text: 'x'.repeat(24_001) }]) {
    await assert.rejects(client(async () => Response.json(result)).transcribe(audio, 'append', signal), /invalid_voice_transcript/)
  }
})

test('voice requests never follow redirects or automatically repeat uncertain uploads', async () => {
  let count = 0
  const tool = voiceTool(client(async () => { count++; return new Response(null, {
    status: 307, headers: { location: 'https://another.invalid/upload' },
  }) }), [audio])
  await assert.rejects(tool.execute({ attachment: 0 }, signal), { code: 'http_307' })
  await assert.rejects(tool.execute({ attachment: 0 }, signal), { code: 'http_307' })
  assert.equal(count, 1)
})
