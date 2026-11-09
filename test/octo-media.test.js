import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadAttachment, normalizeAttachment, uploadAttachment } from '../src/octo-media.js'

const api = 'https://api.example.invalid/gateway'
const cdn = 'https://cdn.example.invalid'
const storage = 'https://objects.example.invalid:9443'
const token = 'bf_test_media'
const config = {
  apiBase: api, token, mediaMaxBytes: 128,
  mediaDownloadOrigins: [cdn], mediaUploadOrigins: [storage],
}
const route = { channel_id: 'user-1', channel_type: 1 }
const file = { name: 'report.pdf', mime: 'application/pdf', bytes: Buffer.from([0, 255, 13, 10, 128, 37]) }
const filePayload = { type: 8, url: 'file/preview/chat/12/report.pdf', name: file.name }
const signed = {
  method: 'PUT', uploadUrl: storage + '/chat/key.pdf?signature=synthetic', downloadUrl: cdn + '/chat/key.pdf',
  contentType: 'application/pdf', contentDisposition: "inline; filename*=UTF-8''report.pdf", maxFileSize: 6,
}
const redirect = location => new Response(null, { status: 302, headers: { Location: location } })
const putOK = () => new Response(null, { status: 204 })
const invalid = code => ({ code, message: code })

function mocked(responses, overrides) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const index = calls.push({ url: new URL(url), ...init }) - 1
    const response = responses[index]
    if (typeof response === 'function') return response(init)
    if (!response) throw new Error('Unexpected mock request')
    return response
  }
  return { calls, config: { ...config, ...overrides, fetchImpl } }
}

test('normalizes Octo file, image, GIF, voice and video wire payloads', () => {
  for (const [payload, kind, name, mime, size] of [
    [{ ...filePayload, name: 'C:\\private\\report.pdf', size: 6 }, 'file', 'report.pdf', 'application/pdf', 6],
    [{ type: 2, url: '/file/chat/%E5%9B%BE.png' }, 'image', '图.png', 'image/png'],
    [{ type: 3, url: cdn + '/image?key=opaque' }, 'image', 'image', 'image/gif'],
    [{ type: 4, url: 'chat/audio.silk' }, 'audio', 'audio.silk', 'audio/silk'],
    [{ type: 5, url: cdn + '/movie.mp4?sig=ephemeral', cover: 'https://other.invalid/cover.png' },
      'video', 'movie.mp4', 'video/mp4'],
    [{ type: 8, url: 'chat/opaque', name: '../NUL.txt', mime: 'Text/Plain; charset=utf-8' },
      'file', '_NUL.txt', 'text/plain'],
  ]) {
    assert.deepEqual(normalizeAttachment(payload), { kind, url: payload.url, name, mime, ...(size !== undefined && { size }) })
  }
  for (const payload of [
    null, [], { type: 1, url: 'chat/plain.txt' }, { type: '8', url: 'chat/file.txt' }, { type: 8 },
    { type: 8, url: '//other.invalid/file.txt' }, { type: 8, url: 'file:///private/file.txt' },
    { type: 8, url: 'http://cdn.example.invalid/file.txt' }, { type: 8, url: 'file/preview/chat/%252e%252e/x.txt' },
  ]) assert.equal(normalizeAttachment(payload), undefined)
})

test('rewrites known Octo paths to the authenticated download route with a safe filename', async () => {
  for (const url of [
    'chat/12/report.pdf', '/file/chat/12/report.pdf', 'file/preview/chat/12/report.pdf',
    '/v1/botfile/file/chat/12/report.pdf', api + '/v1/file/preview/chat/12/report.pdf?filename=ignored',
    api + '/v1/bot/file/download/chat/12/report.pdf',
  ]) {
    const mock = mocked([new Response(file.bytes, { headers: { 'Content-Type': 'application/octet-stream' } })])
    const attachment = normalizeAttachment({ ...filePayload, url, name: '../中文.pdf' })
    assert.deepEqual(await downloadAttachment(mock.config, attachment), {
      name: '中文.pdf', mime: 'application/pdf', bytes: file.bytes,
    })
    assert.equal(mock.calls.length, 1)
    const [call] = mock.calls
    assert.equal(call.url.origin + call.url.pathname, api + '/v1/bot/file/download/chat/12/report.pdf')
    assert.deepEqual([...call.url.searchParams], [['filename', '中文.pdf']])
    assert.equal(call.headers.Authorization, 'Bearer ' + token)
    assert.equal(call.redirect, 'manual')
    assert.equal(call.credentials, 'omit')
  }
})

test('never sends bot credentials to a direct CDN URL or any redirect', async () => {
  const mock = mocked([
    redirect(cdn + '/objects/start?signature=synthetic'),
    redirect('end'),
    redirect(api + '/objects/same-origin'),
    new Response('picture', { headers: { 'Content-Type': 'image/webp; test=metadata' } }),
  ], { mediaDownloadOrigins: [cdn, new URL(api).origin] })
  const attachment = normalizeAttachment({ type: 2, url: 'chat/photo.jpg' })
  assert.deepEqual(await downloadAttachment(mock.config, attachment), {
    name: 'photo.jpg', mime: 'image/webp', bytes: Buffer.from('picture'),
  })
  assert.deepEqual(mock.calls.map(call => call.url.origin), [new URL(api).origin, cdn, cdn, new URL(api).origin])
  assert.deepEqual(mock.calls.map(call => call.headers.Authorization), ['Bearer ' + token, undefined, undefined, undefined])
  assert.ok(mock.calls.every(call => call.redirect === 'manual'))
  assert.equal(mock.calls[1].url.searchParams.get('signature'), 'synthetic')
  assert.equal(mock.calls[2].url.pathname, '/objects/end')

  const direct = mocked([new Response('voice', { headers: { 'Content-Type': 'text/html' } })])
  assert.equal((await downloadAttachment(direct.config, normalizeAttachment({ type: 4, url: cdn + '/audio.m4a' }))).mime, 'audio/mp4')
  assert.equal(direct.calls[0].headers.Authorization, undefined)
})

test('blocks untrusted origins and unsafe storage paths before requesting bytes', async () => {
  for (const [url, code] of [
    ['https://cdn.example.invalid.evil.invalid/payload', 'media_download_origin_blocked'],
    ['https://cdn.example.invalid:8443/payload', 'media_download_origin_blocked'],
    [api + '/v1/bot/groups', 'media_download_origin_blocked'],
    ['https://127.0.0.1/chat/a.pdf', 'media_download_origin_blocked'],
    ['https://cdn.example.invalid@evil.invalid/a.pdf', 'media_invalid_attachment'],
    ['//cdn.example.invalid/a.pdf', 'media_invalid_attachment'],
    ['chat/../other/a.pdf', 'media_invalid_attachment'],
    ['chat/encoded%2fslash/a.pdf', 'media_invalid_attachment'],
    ['chat/plus%2Bspace.pdf', 'media_invalid_attachment'],
    [api + '/v1/bot/file/download/chat/%252e%252e/a.pdf', 'media_invalid_attachment'],
    [api + '/v1/bot/file/download/chat/%2e%2e/a.pdf', 'media_invalid_attachment'],
  ]) {
    const mock = mocked([])
    await assert.rejects(downloadAttachment(mock.config, { url }), invalid(code))
    assert.equal(mock.calls.length, 0)
  }
})

test('rejects unsafe redirects at each hop and stops redirect loops', async () => {
  const attachment = normalizeAttachment(filePayload)
  for (const location of [
    'http://cdn.example.invalid/file.pdf', 'https://cdn.example.invalid:8443/file.pdf',
    'https://cdn.example.invalid.evil.invalid/file.pdf', '//169.254.169.254/latest',
    'https://user@cdn.example.invalid/file.pdf', 'https://cdn.example.invalid/file.pdf#fragment',
    api + '/v1/bot/file/download/chat/a.pdf', '/unlisted-api-path',
  ]) {
    const mock = mocked([redirect(location)])
    await assert.rejects(downloadAttachment(mock.config, attachment), invalid('media_redirect_blocked'))
    assert.equal(mock.calls.length, 1)
  }
  const loop = mocked(Array.from({ length: 4 }, () => redirect(cdn + '/loop')))
  await assert.rejects(downloadAttachment(loop.config, attachment), invalid('media_redirect_blocked'))
  assert.equal(loop.calls.length, 4)
})

test('enforces declared and streamed byte ceilings, cancels bodies, and rejects partial content', async () => {
  const attachment = normalizeAttachment(filePayload)
  const declared = mocked([], { mediaMaxBytes: 3 })
  await assert.rejects(downloadAttachment(declared.config, { ...attachment, size: 4 }), invalid('media_too_large'))
  assert.equal(declared.calls.length, 0)
  const limits = [
    { headers: { 'Content-Length': '4' }, expectedPulls: 0 },
    { headers: {}, expectedPulls: 2 },
    { headers: { 'Content-Length': '1', 'Content-Encoding': 'gzip' }, expectedPulls: 2 },
  ]
  for (const { headers, expectedPulls } of limits) {
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(Buffer.from('ab')) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const mock = mocked([new Response(body, { headers })], { mediaMaxBytes: 3 })
    await assert.rejects(downloadAttachment(mock.config, attachment), invalid('media_too_large'))
    assert.equal(pulls, expectedPulls)
    assert.equal(cancelled, true)
  }
  const exact = mocked([new Response('abc')], { mediaMaxBytes: 3 })
  assert.deepEqual((await downloadAttachment(exact.config, attachment)).bytes, Buffer.from('abc'))
  const partial = mocked([new Response('abc', { status: 206 })])
  await assert.rejects(downloadAttachment(partial.config, attachment), { ...invalid('media_download_http_206'), status: 206 })
})

test('caller abort and local deadline cancel an active download without leaking transport details', async () => {
  const attachment = normalizeAttachment(filePayload)
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  let cancelled = false
  const body = new ReadableStream({
    pull() { queueMicrotask(() => controller.abort(reason)); return new Promise(() => {}) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const mock = mocked([new Response(body)])
  await assert.rejects(downloadAttachment(mock.config, attachment, controller.signal), err => err === reason)
  assert.equal(cancelled, true)
  await assert.rejects(downloadAttachment(mock.config, attachment, controller.signal), err => err === reason)
  assert.equal(mock.calls.length, 1)

  const timed = mocked([new Response(new ReadableStream({ pull() {} }))], { mediaTimeoutMs: 10 })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(downloadAttachment(timed.config, attachment), invalid('media_download_timeout'))
  } finally { clearTimeout(keepAlive) }
  const failed = mocked([() => { throw new Error('private URL or authorization') }])
  await assert.rejects(downloadAttachment(failed.config, attachment), invalid('media_download_transport'))
})

test('presigns the exact byte count, PUTs with server-signed headers, then sends the stable file URL', async () => {
  const messageId = '9223372036854775807'
  const mock = mocked([Response.json(signed), putOK(), new Response('{"message_id":' + messageId + '}')])
  const topic = { channel_id: '0123456789abcdef0123456789abcdef____123456789012345', channel_type: 5 }
  assert.equal(await uploadAttachment(mock.config, topic, file), messageId)
  const [presign, put, send] = mock.calls
  assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'PUT', 'POST'])
  assert.ok(mock.calls.every(call => call.redirect === 'manual' && call.signal instanceof AbortSignal))
  assert.equal(presign.url.origin + presign.url.pathname, api + '/v1/bot/upload/presigned')
  assert.deepEqual(Object.fromEntries(presign.url.searchParams), {
    filename: 'report.pdf', fileSize: '6', contentType: 'application/pdf',
  })
  assert.equal(presign.headers.Authorization, 'Bearer ' + token)
  assert.equal(put.url.href, signed.uploadUrl)
  assert.deepEqual(put.headers, {
    'Content-Length': '6', 'Content-Type': signed.contentType, 'Content-Disposition': signed.contentDisposition,
  })
  assert.deepEqual(put.body, file.bytes)
  assert.equal(send.url.href, api + '/v1/bot/sendMessage')
  assert.equal(send.headers.Authorization, 'Bearer ' + token)
  assert.deepEqual(JSON.parse(send.body), { ...topic, payload: { ...filePayload, url: signed.downloadUrl, size: 6 } })
})

test('sends native images with known dimensions and uses file messages for audio/video', async () => {
  const pngHeader = Buffer.from('89504e470d0a1a0a0000000d494844520000001000000020', 'hex')
  for (const [name, mime, bytes, expected] of [
    ['image.png', 'image/png', pngHeader, { type: 2, width: 16, height: 32 }],
    ['voice.mp3', 'audio/mpeg', Buffer.from('voice'), { type: 8 }],
    ['video.mp4', 'video/mp4', Buffer.from('video'), { type: 8 }],
    ['notes.txt', 'text/plain', Buffer.from('notes'), { type: 8 }],
  ]) {
    const contentType = mime === 'text/plain' ? 'text/plain; charset=utf-8' : mime
    const downloadUrl = cdn + '/chat/' + name
    const mock = mocked([Response.json({
      ...signed, contentType, contentDisposition: undefined, maxFileSize: bytes.length, downloadUrl,
    }), putOK(), Response.json({ message_id: '42' })])
    assert.equal(await uploadAttachment(mock.config, route, { name: 'C:\\exports\\' + name, mime, bytes }), '42')
    assert.equal(mock.calls[1].headers['Content-Type'], contentType)
    assert.deepEqual(JSON.parse(mock.calls[2].body), { ...route, payload: { ...expected, name, url: downloadUrl, size: bytes.length } })
  }
})

test('rejects invalid config, routes, files, and oversized outbound buffers without requests', async () => {
  for (const [overrides, target, attachment, code] of [
    [{ apiBase: 'http://api.example.invalid' }, route, file, 'media_invalid_config'],
    [{ mediaUploadOrigins: ['https://127.0.0.1'] }, route, file, 'media_invalid_config'],
    [{ mediaUploadOrigins: [storage + '/prefix'] }, route, file, 'media_invalid_config'],
    [{ mediaMaxBytes: 0 }, route, file, 'media_invalid_config'],
    [{}, { channel_id: 'group', channel_type: 5 }, file, 'media_invalid_route'],
    [{}, { channel_id: 'user-1', channel_type: 4 }, file, 'media_invalid_route'],
    [{}, route, { ...file, name: 'no-extension' }, 'media_invalid_file'],
    [{}, route, { ...file, bytes: Buffer.alloc(0) }, 'media_invalid_file'],
    [{}, route, { ...file, bytes: new Uint8Array(2) }, 'media_invalid_file'],
    [{ mediaMaxBytes: 5 }, route, file, 'media_too_large'],
  ]) {
    const mock = mocked([], overrides)
    await assert.rejects(uploadAttachment(mock.config, target, attachment), invalid(code))
    assert.equal(mock.calls.length, 0)
  }
})

test('rejects unsafe or malformed presign responses before PUT and rejects a redirect from PUT', async () => {
  for (const [changes, code] of [
    [{ uploadUrl: 'https://other.invalid/a.pdf?signature=synthetic' }, 'media_upload_origin_blocked'],
    [{ downloadUrl: 'https://other.invalid/a.pdf' }, 'media_download_origin_blocked'],
    [{ downloadUrl: cdn + '/a.pdf?signature=synthetic' }, 'media_invalid_presign'],
    [{ uploadUrl: storage + '/a.pdf' }, 'media_invalid_presign'],
    [{ maxFileSize: 5 }, 'media_invalid_presign'],
    [{ method: 'POST' }, 'media_invalid_presign'],
    [{ contentDisposition: 'inline\r\nx-leak: bad' }, 'media_invalid_presign'],
    [{ contentType: undefined }, 'media_invalid_presign'],
  ]) {
    const mock = mocked([Response.json({ ...signed, ...changes })])
    await assert.rejects(uploadAttachment(mock.config, route, file), invalid(code))
    assert.equal(mock.calls.length, 1)
  }
  const tooBig = mocked([new Response(' '.repeat(64 * 1024 + 1))])
  await assert.rejects(uploadAttachment(tooBig.config, route, file), invalid('media_invalid_presign'))
  const put = mocked([Response.json(signed), redirect(storage + '/unexpected')])
  await assert.rejects(uploadAttachment(put.config, route, file), { ...invalid('media_put_http_302'), status: 302 })
  assert.equal(put.calls.length, 2)
})

test('failed stages stop immediately; missing or malformed send IDs never count as success', async () => {
  const statusCases = [
    [[new Response('private details', { status: 403 })], 'media_presign_http_403', 403],
    [[Response.json(signed), new Response('private details', { status: 413 })], 'media_put_http_413', 413],
    [[Response.json(signed), putOK(), new Response('private details', { status: 429 })], 'media_send_http_429', 429],
  ]
  for (const [responses, code, status] of statusCases) {
    const mock = mocked(responses)
    await assert.rejects(uploadAttachment(mock.config, route, file), { ...invalid(code), status })
    assert.equal(mock.calls.length, responses.length)
  }
  for (const body of ['{}', 'not json', '{"message_id":0}', '{"message_id":9223372036854775808}', '{"message_id":1e3}']) {
    const mock = mocked([Response.json(signed), putOK(), new Response(body)])
    await assert.rejects(uploadAttachment(mock.config, route, file), invalid('send_result_unconfirmed'))
    assert.equal(mock.calls.length, 3)
  }
  const sendTransport = mocked([Response.json(signed), putOK(), () => { throw new Error('untrusted error body') }])
  await assert.rejects(uploadAttachment(sendTransport.config, route, file), invalid('media_send_transport'))
  assert.equal(sendTransport.calls.length, 3)
})

test('aborting after PUT prevents the outbound send', async () => {
  const controller = new AbortController()
  const reason = new Error('stop before send')
  const mock = mocked([Response.json(signed), () => { controller.abort(reason); return putOK() }])
  await assert.rejects(uploadAttachment(mock.config, route, file, controller.signal), err => err === reason)
  assert.equal(mock.calls.length, 2)
})
