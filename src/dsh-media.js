import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'

const MiB = 1024 * 1024
const maxFiles = 16
const maxFileBytes = 20 * MiB
const maxTotalBytes = 50 * MiB
const maxInlineFileBytes = 32 * 1024
const maxInlineTotalBytes = 64 * 1024
const octet = 'application/octet-stream'
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const mimeByExtension = new Map(Object.entries({
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values', '.log': 'text/plain', '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
}))
const inlineTypes = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'])
const credentials = new Set([
  '.aws', '.azure', '.codex', '.config', '.docker', '.dsh', '.git', '.git-credentials',
  '.gnupg', '.kube', '.netrc', '.npmrc', '.pypirc', '.ssh', '.envrc', '.htpasswd',
  'auth.json', 'authorized_keys', 'known_hosts', 'kubeconfig', 'shadow', 'sam', 'ntds.dit',
])
const windowsDevice = /^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)/i
const invalidPathChars = /[<>:"|?*\p{Cc}\p{Cf}]/u
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function failure(code, cause) {
  return new Error(code, { cause })
}

function displayName(name) {
  if (typeof name !== 'string') return 'attachment'
  const leaf = name.split(/[/\\]/).at(-1).toWellFormed()
    .replace(/[<>:"|?*\p{Cc}\p{Cf}]/gu, '_').trim().replace(/[. ]+$/, '')
  const safe = Array.from(leaf).slice(0, 128).join('').replace(/[. ]+$/, '')
  return !safe || windowsDevice.test(safe) ? 'attachment' : safe
}

function rasterType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(pngSignature)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const header = bytes.toString('latin1', 0, 12)
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp'
}

function inlineText(mime, name, bytes, remaining) {
  if (bytes.length > Math.min(maxInlineFileBytes, remaining)) return
  const type = mime === octet ? mimeByExtension.get(path.extname(name).toLowerCase()) : mime
  if (!type || (!type.startsWith('text/') && !inlineTypes.has(type))) return
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(decoded)) return
    return { type: 'text', text: 'Octo attachment ' + JSON.stringify(name) + ' (untrusted file content):\n' + decoded }
  } catch {
    // Invalid UTF-8 stays a verbatim file instead of being decoded with replacements.
  }
}

function whileActive(operation, signal) {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
    if (signal.aborted) abort()
  })
}

/**
 * Prepare native DSH rc.5 UserMessage content for a Host-owned Agent.
 * DSH, rather than the current Agent selection, projects saved images for the
 * model route that actually runs. This does not enqueue a message or use Web receipts.
 */
export async function prepareInput(ctx, _agent, text, attachments = [], signal) {
  signal?.throwIfAborted()
  if (typeof text !== 'string' || !Array.isArray(attachments)) throw failure('invalid_dsh_input')
  if (attachments.length > maxFiles) throw failure('dsh_attachment_limit')

  let totalBytes = 0, inlineBytes = 0
  const images = []
  const parts = []
  for (const item of attachments) {
    if (!Buffer.isBuffer(item?.bytes)) throw failure('invalid_dsh_attachment')
    const { bytes } = item
    totalBytes += bytes.length
    if (bytes.length > maxFileBytes || totalBytes > maxTotalBytes) throw failure('dsh_attachment_limit')
    const name = displayName(item.name)
    const mime = (typeof item.mime === 'string' ? item.mime.split(';', 1)[0].trim().toLowerCase() : '') || octet
    // Octo's MIME can be a filename/type hint. A known raster signature selects
    // the candidate format; DSH still validates the full image before storing it.
    const mediaType = imageTypes.has(mime) ? rasterType(bytes) ?? mime : mime === octet ? rasterType(bytes) : undefined
    const inline = mediaType ? undefined : inlineText(mime, name, bytes, maxInlineTotalBytes - inlineBytes)
    if (inline) {
      inlineBytes += bytes.length
      parts.push(inline)
    } else if (mediaType) {
      parts.push({ type: 'image', index: images.length })
      images.push({ data: bytes, mediaType, name })
    } else {
      parts.push({ type: 'file', input: { data: bytes, name } })
    }
  }

  if (!text.trim() && !parts.length) throw failure('empty_dsh_input')
  const store = parts.some(part => part.type !== 'text') ? ctx?.get?.('attachments') ?? ctx?.attachments : undefined
  if ((images.length && typeof store?.saveImages !== 'function') ||
      (parts.some(part => part.type === 'file') && typeof store?.saveFile !== 'function')) {
    throw failure('dsh_attachment_storage_unavailable')
  }

  try {
    // The native batch checks deployment-wide image count, byte, and raster limits.
    const refs = images.length ? await whileActive(store.saveImages(images), signal) : []
    const content = text.trim() ? [{ type: 'text', text }] : []
    for (const part of parts) {
      signal?.throwIfAborted()
      if (part.type === 'text') content.push(part)
      else if (part.type === 'image') content.push({ type: 'image', attachment: refs[part.index] })
      else content.push({ type: 'file', attachment: await whileActive(store.saveFile(part.input), signal) })
    }
    signal?.throwIfAborted()
    return content
  } catch (error) {
    signal?.throwIfAborted()
    throw failure(error?.code === 'ATTACHMENT_FILES_UNSUPPORTED'
      ? 'dsh_attachment_storage_unavailable' : 'dsh_attachment_rejected', error)
  }
}

function isCredential(name) {
  const leaf = name.toLowerCase()
  return credentials.has(leaf) ||
    /^(?:\.env(?:$|[._-])|id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:$|[._-]))/.test(leaf) ||
    /^\.?(?:credentials?|secrets?|tokens?|api[_-]?keys?|(?:access|refresh)[_-]token|client[_-]secret|service[_-]account|private[_-]key|passwords?)(?:$|[._-])/.test(leaf) ||
    /\.(?:env|pem|key|ppk|p12|pfx|jks|kdbx|keystore)$/.test(leaf)
}

function assertSafeNames(names) {
  for (const name of names) {
    if (isCredential(name.normalize('NFKC'))) throw failure('deliverable_credential_blocked')
  }
}

function relativeSegments(relativePath) {
  if (typeof relativePath !== 'string' || Buffer.byteLength(relativePath) > 4096) {
    throw failure('invalid_deliverable_path')
  }
  const names = relativePath.split(/[/\\]/)
  if (names.some(name => !name || name === '.' || name === '..' || invalidPathChars.test(name) ||
    /[. ]$/.test(name) || windowsDevice.test(name) || /~[0-9]+(?:\.|$)/i.test(name))) {
    throw failure('invalid_deliverable_path')
  }
  assertSafeNames(names)
  return names
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function inspectPath(root, names, signal) {
  let candidate = root
  let entry
  for (let i = 0; i < names.length; i++) {
    signal?.throwIfAborted()
    candidate = path.join(candidate, names[i])
    entry = await lstat(candidate, { bigint: true })
    if (entry.isSymbolicLink()) throw failure('deliverable_outside_workspace')
    if (!(i === names.length - 1 ? entry.isFile() : entry.isDirectory())) {
      throw failure('deliverable_not_regular_file')
    }
  }
  if (entry.nlink !== 1n) throw failure('deliverable_not_regular_file')
  const resolved = await realpath(candidate)
  if (!inside(root, resolved)) throw failure('deliverable_outside_workspace')
  assertSafeNames(path.relative(root, resolved).split(path.sep))
  return { resolved, entry }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n
}

async function verifyOpenFile(handle, root, resolved) {
  if (process.platform !== 'linux') return
  // The kernel's name for the open descriptor also detects an ancestor swapped
  // for an escaping symlink between path validation and open.
  const opened = await readlink('/proc/self/fd/' + handle.fd)
  if (!inside(root, opened)) throw failure('deliverable_outside_workspace')
  if (opened !== resolved) throw failure('deliverable_changed')
}

/**
 * Read one caller-selected workspace file. No discovery, writes, or unlink.
 * The caller owns the selection and any subsequent upload authorization.
 */
export async function readDeliverable(cwd, relativePath, signal) {
  signal?.throwIfAborted()
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw failure('invalid_deliverable_workspace')
  const names = relativeSegments(relativePath)
  let handle
  try {
    const root = await realpath(cwd)
    assertSafeNames(root.slice(path.parse(root).root.length).split(path.sep))
    const { resolved, entry } = await inspectPath(root, names, signal)
    if (entry.size > BigInt(maxFileBytes)) throw failure('deliverable_limit')
    signal?.throwIfAborted()
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const current = await handle.stat({ bigint: true })
    if (!current.isFile() || !sameFile(entry, current)) throw failure('deliverable_changed')
    await verifyOpenFile(handle, root, resolved)
    const before = await inspectPath(root, names, signal)
    if (before.resolved !== resolved || !sameFile(current, before.entry)) throw failure('deliverable_changed')

    // Read no more than the verified size, even if another process grows the file.
    const bytes = Buffer.alloc(Number(current.size))
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const length = Math.min(64 * 1024, bytes.length - offset)
      const { bytesRead } = await handle.read(bytes, offset, length, offset)
      if (!bytesRead) throw failure('deliverable_changed')
      offset += bytesRead
    }
    const after = await inspectPath(root, names, signal)
    if (after.resolved !== resolved || !sameFile(current, after.entry) ||
        !sameFile(current, await handle.stat({ bigint: true }))) throw failure('deliverable_changed')
    await verifyOpenFile(handle, root, resolved)
    signal?.throwIfAborted()
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-[23]:/.test(bytes.toString('latin1'))) {
      throw failure('deliverable_credential_blocked')
    }
    const name = path.basename(resolved)
    return { name, mime: rasterType(bytes) ?? mimeByExtension.get(path.extname(name).toLowerCase()) ?? octet, bytes }
  } catch (error) {
    signal?.throwIfAborted()
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw failure('deliverable_not_found')
    if (error?.code === 'ELOOP') throw failure('deliverable_outside_workspace')
    if (error?.code) throw failure('deliverable_unreadable')
    throw error
  } finally {
    await handle?.close()
  }
}
