import { isIP } from 'node:net'
import { apiEndpoint, validToken, validUid } from './config.js'
import { ruleScope } from './rules.js'

const MiB = 1024 * 1024
const redirects = new Set([301, 302, 303, 307, 308])
const kinds = new Map([[2, 'image'], [3, 'image'], [4, 'audio'], [5, 'video'], [8, 'file']])
const octetStream = 'application/octet-stream'
const mimeByExt = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/opus',
  wav: 'audio/wav', aac: 'audio/aac', silk: 'audio/silk', amr: 'audio/amr',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain',
  csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const kindMime = { image: 'image/jpeg', audio: 'audio/mpeg', video: 'video/mp4', file: octetStream }
const control = /[\u0000-\u001f\u007f-\u009f]/
const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/
const mediaPrefixes = ['/v1/bot/file/download/', '/v1/botfile/', '/v1/file/preview/', '/file/preview/', '/file/']
const downloadPrefix = mediaPrefixes[0]

class MediaError extends Error {
  constructor(code, status = 0) {
    super(code)
    this.code = code
    this.status = status
  }
}
const error = (code, status) => new MediaError(code, status)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const extension = name => /\.([a-z0-9]{1,16})$/i.exec(name)?.[1].toLowerCase()
const mimeForName = name => {
  const ext = extension(name)
  return Object.hasOwn(mimeByExt, ext) ? mimeByExt[ext] : undefined
}
const mimeType = value => {
  if (typeof value !== 'string' || value.length > 256 || control.test(value)) return
  const type = value.split(';', 1)[0].trim().toLowerCase()
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) return type
}
const matchesKind = (mime, kind) => mime && (kind === 'file' || mime.startsWith(kind + '/'))

function safeName(value) {
  if (typeof value !== 'string' || value.length > 4096) return
  let name = value.split(/[/\\]/).at(-1).toWellFormed().trim()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(name)) name = '_' + name
  if (name && Buffer.byteLength(name) <= 255) return name
}

function safeHttps(value, base) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value !== value.trim()
    || control.test(value) || /[\\#]/.test(value)) return
  if ((!base || hasScheme.test(value)) && !/^https:\/\/[^/?#@]+(?=[/?#]|$)/i.test(value)) return
  const url = URL.parse(value, base)
  if (url?.protocol === 'https:' && !url.username && !url.password) return url
}

// Decode exactly one URL-encoding layer, then reject forms the Go endpoint's
// repeated QueryUnescape could reinterpret (including a literal plus or percent).
function objectKey(value) {
  if (/[?#\\]/.test(value) || value.startsWith('//') || hasScheme.test(value)) return
  const parts = value.replace(/^\//, '').split('/')
  try {
    const decoded = parts.map(part => decodeURIComponent(part))
    if (decoded.some(part => !part || part === '.' || part.includes('..') || control.test(part)
      || /[/\\+%?:#]/.test(part) || part !== part.trim())) return
    return decoded.map(part => encodeURIComponent(part)).join('/')
  } catch {
    return undefined
  }
}

function mediaPath(path) {
  const prefix = mediaPrefixes.find(prefix => path.startsWith(prefix))
  if (!prefix) return
  let key = path.slice(prefix.length)
  // The legacy /v1/botfile route also accepted the file/ spelling.
  if (prefix === '/v1/botfile/') key = key.replace(/^file\/(?:preview\/)?/, '')
  return key
}

function relativeKey(value) {
  if (value.startsWith('//') || /[?#]/.test(value)) return
  const path = (value.startsWith('/') ? value : '/' + value).replace(/^\/api(?=\/(?:v1\/)?file\/preview\/)/u, '')
  return objectKey(mediaPath(path) ?? path)
}

/** Returns {kind, url, name, mime, size?}, or undefined for non-attachment/invalid wire data. */
export function normalizeAttachment(payload) {
  if (!isObject(payload)) return
  const kind = kinds.get(payload.type)
  const url = payload.url
  if (!kind || typeof url !== 'string' || !url || url.length > 8192 || url !== url.trim() || control.test(url)) return
  const absolute = hasScheme.test(url)
  const path = absolute ? safeHttps(url)?.pathname : relativeKey(url)
  if (!path) return
  let basename
  try {
    const segment = decodeURIComponent(path.split('/').at(-1))
    if (!/[/\\]/.test(segment)) basename = safeName(segment)
  } catch {}
  const name = safeName(payload.name) ?? basename ?? ({ image: 'image', audio: 'audio', video: 'video', file: 'attachment' })[kind]
  const candidates = [payload.type === 3 && 'image/gif', mimeType(payload.mime), mimeForName(name), mimeForName(basename)]
  const mime = candidates.find(candidate => matchesKind(candidate, kind)) ?? kindMime[kind]
  const size = payload.size
  return { kind, url, name, mime, ...(Number.isSafeInteger(size) && size >= 0 && { size }) }
}

function storageOrigins(values) {
  if (values === undefined) return new Set()
  if (!Array.isArray(values)) throw error('media_invalid_config')
  return new Set(values.map(value => {
    const url = safeHttps(value)
    if (!url || !/^https:\/\/[^/?#]+\/?$/i.test(value)
      || isIP(url.hostname.replace(/^\[|\]$/g, ''))
      || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local)\.?$/i.test(url.hostname)) {
      throw error('media_invalid_config')
    }
    return url.origin
  }))
}

function context(config, callerSignal) {
  callerSignal?.throwIfAborted()
  if (!safeHttps(config?.apiBase) || config.apiBase.includes('?')) throw error('media_invalid_config')
  let base
  try { base = apiEndpoint(config?.apiBase) } catch { throw error('media_invalid_config') }
  const { token, fetchImpl = globalThis.fetch, mediaMaxBytes = 16 * MiB, mediaTimeoutMs = 60_000 } = config
  if (!validToken(token) || typeof fetchImpl !== 'function' || !Number.isSafeInteger(mediaMaxBytes)
    || mediaMaxBytes < 1 || mediaMaxBytes > 100 * MiB || !Number.isSafeInteger(mediaTimeoutMs)
    || mediaTimeoutMs < 1 || mediaTimeoutMs > 300_000) throw error('media_invalid_config')
  const deadline = AbortSignal.timeout(mediaTimeoutMs)
  return {
    base, api: new URL(base), auth: { Authorization: 'Bearer ' + token }, fetchImpl,
    downloadOrigins: storageOrigins(config.mediaDownloadOrigins), uploadOrigins: storageOrigins(config.mediaUploadOrigins),
    limit: mediaMaxBytes, callerSignal, deadline,
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  }
}

function discard(body) {
  if (body && !body.locked) void body.cancel().catch(() => {})
}

async function atStage(ctx, stage, operation) {
  try {
    ctx.signal.throwIfAborted()
    const result = await operation()
    ctx.signal.throwIfAborted()
    return result
  } catch (err) {
    ctx.callerSignal?.throwIfAborted()
    if (ctx.deadline.aborted) throw error('media_' + stage + '_timeout')
    if (err instanceof MediaError) throw err
    // Never propagate Fetch error causes, signed URLs, headers or response bodies.
    throw error('media_' + stage + '_transport')
  }
}

async function request(ctx, url, init) {
  ctx.signal.throwIfAborted()
  const response = await ctx.fetchImpl(url, { ...init, redirect: 'manual', credentials: 'omit', signal: ctx.signal })
  if (ctx.signal.aborted) {
    discard(response.body)
    ctx.signal.throwIfAborted()
  }
  if (response.redirected) {
    discard(response.body)
    throw error('media_redirect_blocked')
  }
  return response
}

function httpError(response, stage) {
  discard(response.body)
  return error('media_' + stage + '_http_' + response.status, response.status)
}

async function readBytes(response, limit, signal, tooLarge) {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    discard(response.body)
    throw error(tooLarge)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  let bytes = Buffer.alloc(0)
  let size = 0
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      const end = size + value.byteLength
      if (end > limit) throw error(tooLarge)
      if (end > bytes.length) {
        const grown = Buffer.alloc(Math.min(limit, Math.max(end, 16 * 1024, bytes.length * 2)))
        bytes.copy(grown, 0, 0, size)
        bytes = grown
      }
      bytes.set(value, size)
      size = end
    }
    signal.throwIfAborted()
    return bytes.subarray(0, size)
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

function apiKey(ctx, url, raw) {
  if (url.origin !== ctx.api.origin) return
  // Use the raw path, before URL parsing removes encoded dot segments.
  const path = raw.replace(/^https:\/\/[^/?#]+/i, '').split('?', 1)[0]
  const basePath = ctx.api.pathname.replace(/\/$/, '')
  const withoutBase = basePath && path.startsWith(basePath + '/') ? path.slice(basePath.length) : path
  const key = mediaPath(withoutBase)
  if (key === undefined) return
  const validated = objectKey(key)
  if (!validated) throw error('media_invalid_attachment')
  return validated
}

/** Download after the caller has admitted the source message and authorized its attachment. */
export async function downloadAttachment(config, attachment, signal) {
  const ctx = context(config, signal)
  return atStage(ctx, 'download', async () => {
    const { url, name, mime, kind, size } = attachment ?? {}
    // Revalidate URL and metadata even if a caller did not use normalizeAttachment.
    if (typeof url !== 'string' || !url || url.length > 8192 || url !== url.trim() || control.test(url)) {
      throw error('media_invalid_attachment')
    }
    if (Number.isSafeInteger(size) && size > ctx.limit) throw error('media_too_large')
    const filename = safeName(name) ?? 'attachment'
    let target, key
    if (hasScheme.test(url)) {
      target = safeHttps(url)
      if (!target) throw error('media_invalid_attachment')
      key = apiKey(ctx, target, url)
      if (!key && !ctx.downloadOrigins.has(target.origin)) throw error('media_download_origin_blocked')
    } else {
      key = relativeKey(url)
      if (!key) throw error('media_invalid_attachment')
    }
    if (key) target = new URL(ctx.base + downloadPrefix + key + '?' + new URLSearchParams({ filename }))

    for (let hop = 0; ; hop++) {
      const response = await request(ctx, target.href, { method: 'GET', headers: hop === 0 && key ? ctx.auth : {} })
      if (redirects.has(response.status)) {
        const next = safeHttps(response.headers.get('location'), target)
        discard(response.body)
        if (hop >= 3 || !next || !ctx.downloadOrigins.has(next.origin)) throw error('media_redirect_blocked')
        target = next
        continue
      }
      if (response.status !== 200) throw httpError(response, 'download')
      const bytes = await readBytes(response, ctx.limit, ctx.signal, 'media_too_large')
      const hinted = mimeType(mime)
      const received = mimeType(response.headers.get('content-type'))
      const effectiveKind = ['image', 'audio', 'video'].includes(kind) ? kind : 'file'
      return {
        name: filename,
        mime: [received !== octetStream && received, hinted, mimeForName(filename)]
          .find(candidate => matchesKind(candidate, effectiveKind)) ?? kindMime[effectiveKind],
        bytes,
      }
    }
  })
}

async function json(ctx, response, stage, invalidCode) {
  if (!response.ok) throw httpError(response, stage)
  const bytes = await readBytes(response, 64 * 1024, ctx.signal, invalidCode)
  try {
    // Keep the literal Go int64 digits; a JS number can silently round the ID.
    return JSON.parse(bytes.toString('utf8'), (key, value, source) =>
      key === 'message_id' && typeof value === 'number' ? source.source : value)
  } catch {
    throw error(invalidCode)
  }
}

// The native image payload can include dimensions. Only read known headers;
// when dimensions are unavailable the upstream client also omits them.
function imageDimensions(bytes, mime) {
  let width, height
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  } else if (mime === 'image/gif' && bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    width = bytes.readUInt16LE(6)
    height = bytes.readUInt16LE(8)
  } else if (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const end = Math.min(bytes.length, 64 * 1024)
    for (let offset = 2; offset + 4 <= end && bytes[offset++] === 0xff;) {
      while (offset < end && bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (offset + 2 > end || marker === 0xda || marker === 0xd9) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > end) break
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3)
        width = bytes.readUInt16BE(offset + 5)
        break
      }
      offset += length
    }
  } else if (mime === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16)
    if (format === 'VP8X') {
      width = 1 + bytes.readUIntLE(24, 3)
      height = 1 + bytes.readUIntLE(27, 3)
    } else if (format === 'VP8L' && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21)
      width = 1 + (packed & 0x3fff)
      height = 1 + ((packed >>> 14) & 0x3fff)
    } else if (format === 'VP8 ' && bytes.subarray(23, 26).toString('hex') === '9d012a') {
      width = bytes.readUInt16LE(26) & 0x3fff
      height = bytes.readUInt16LE(28) & 0x3fff
    }
  }
  return width > 0 && height > 0 ? { width, height } : {}
}

async function uploadMedia(ctx, file, authorize) {
  const { bytes } = file ?? {}
  const name = safeName(file?.name)
  const mime = mimeType(file?.mime)
  if (!name || !extension(name) || !mime || !Buffer.isBuffer(bytes) || !bytes.length) throw error('media_invalid_file')
  const size = bytes.length
  if (size > ctx.limit) throw error('media_too_large')

  await authorize?.()
  const { upload, download, contentType, contentDisposition } = await atStage(ctx, 'presign', async () => {
    const query = new URLSearchParams({ filename: name, fileSize: String(size), contentType: mime })
    const response = await request(ctx, ctx.base + '/v1/bot/upload/presigned?' + query, { method: 'GET', headers: ctx.auth })
    const signed = await json(ctx, response, 'presign', 'media_invalid_presign')
    const upload = safeHttps(signed?.uploadUrl)
    const download = safeHttps(signed?.downloadUrl)
    const contentType = signed?.contentType
    const contentDisposition = signed?.contentDisposition
    if (!upload?.search || !download || signed.downloadUrl.includes('?')
      || !mimeType(contentType) || (signed.method !== undefined && signed.method !== 'PUT')
      || (signed.maxFileSize !== undefined && signed.maxFileSize !== size)
      || (contentDisposition !== undefined && (typeof contentDisposition !== 'string' || !contentDisposition
        || contentDisposition.length > 4096 || /[^\x20-\x7e]/.test(contentDisposition)))) {
      throw error('media_invalid_presign')
    }
    if (!ctx.uploadOrigins.has(upload.origin)) throw error('media_upload_origin_blocked')
    if (!ctx.downloadOrigins.has(download.origin)) throw error('media_download_origin_blocked')
    return { upload, download, contentType, contentDisposition }
  })

  await authorize?.()
  await atStage(ctx, 'put', async () => {
    const response = await request(ctx, upload.href, {
      method: 'PUT', body: bytes,
      headers: {
        'Content-Length': String(size), 'Content-Type': contentType,
        ...(contentDisposition && { 'Content-Disposition': contentDisposition }),
      },
    })
    if (!response.ok) throw httpError(response, 'put')
    discard(response.body)
  })

  // A standalone image may have unknown dimensions; an Octo RichText block may not.
  const storedMime = mimeType(contentType)
  const isImage = mime.startsWith('image/') && storedMime.startsWith('image/')
  return { type: isImage ? 2 : 8, url: download.href, name, size,
    ...(isImage && imageDimensions(bytes, storedMime)) }
}

export function prepareAttachment(config, file, signal, { authorize } = {}) {
  if (authorize !== undefined && typeof authorize !== 'function') throw error('media_invalid_config')
  return uploadMedia(context(config, signal), file, authorize)
}

/** Upload caller-authorized bytes and send as a native image/file message. */
export async function uploadAttachment(config, route, file, signal, { authorize } = {}) {
  if (authorize !== undefined && typeof authorize !== 'function') throw error('media_invalid_config')
  const ctx = context(config, signal)
  const { channel_id, channel_type } = route ?? {}
  if (channel_type === 1 ? !validUid(channel_id) : !ruleScope(channel_type, channel_id)) throw error('media_invalid_route')
  const payload = await uploadMedia(ctx, file, authorize)
  await authorize?.()
  return atStage(ctx, 'send', async () => {
    const response = await request(ctx, ctx.base + '/v1/bot/sendMessage', {
      method: 'POST', headers: { ...ctx.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id, channel_type, payload }),
    })
    const result = await json(ctx, response, 'send', 'send_result_unconfirmed')
    const id = result?.message_id
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      throw error('send_result_unconfirmed')
    }
    return id
  })
}
