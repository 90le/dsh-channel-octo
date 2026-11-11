import { createHash, randomUUID } from 'node:crypto'
import { accessSync, chmodSync, chownSync, closeSync, constants as fs, fstatSync, linkSync, lstatSync,
  openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const instructionFiles = ['AGENTS.md', 'SOUL.md']
const limit = 32 * 1024
const fail = code => { throw new Error(code) }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
const snapshot = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
const validText = text => typeof text === 'string' && text.isWellFormed()
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)

function inWorkspace(cwd, use) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('workspace_unavailable')
  let root, dir, fd
  try {
    if (!lstatSync(cwd).isDirectory()) fail('workspace_unavailable')
    root = realpathSync(cwd)
    dir = lstatSync(root)
    if (!dir.isDirectory()) fail('workspace_unavailable')
    // Anchor writes to the opened directory on Debian, even if a parent
    // component is renamed while the editor request is in flight.
    if (process.platform === 'linux') {
      fd = openSync(root, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW)
      if (!sameFile(dir, fstatSync(fd))) fail('workspace_unavailable')
    }
    const recheck = () => {
      if (realpathSync(cwd) !== root || !lstatSync(cwd).isDirectory()
        || !sameFile(dir, lstatSync(root))) fail('instruction_changed')
    }
    recheck()
    return use(fd === undefined ? root : '/proc/self/fd/' + fd, recheck)
  } finally { if (fd !== undefined) closeSync(fd) }
}

function inspect(path) {
  let before
  try { before = lstatSync(path) }
  catch (error) { if (error.code === 'ENOENT') return { state: 'missing', revision: 'missing', text: '' }; throw error }
  if (!before.isFile() || before.nlink !== 1) return { state: 'unsafe' }
  if (before.size > limit) return { state: 'too-large' }
  const fd = openSync(path, fs.O_RDONLY | (fs.O_NOFOLLOW ?? 0) | (fs.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(before, stat)) return { state: 'unsafe' }
    const bytes = Buffer.alloc(limit + 1)
    let size = 0, count
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count
    if (size > limit) return { state: 'too-large' }
    if (snapshot(stat) !== snapshot(fstatSync(fd)) || snapshot(stat) !== snapshot(lstatSync(path))) return { state: 'unavailable' }
    const content = bytes.subarray(0, size)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content) }
    catch { return { state: 'invalid-text' } }
    if (!validText(text)) return { state: 'invalid-text' }
    const revision = createHash('sha256').update(snapshot(stat)).update('\0').update(content).digest('hex')
    return { state: 'present', text, revision, stat }
  } finally { closeSync(fd) }
}

export function readInstruction(cwd, name) {
  if (!instructionFiles.includes(name)) fail('invalid_instruction')
  try {
    return inWorkspace(cwd, root => {
      const { stat, ...view } = inspect(join(root, name))
      return view
    })
  } catch { return { state: 'unavailable' } }
}

export function saveInstruction(cwd, name, input) {
  if (!instructionFiles.includes(name) || !validText(input?.text) || Buffer.byteLength(input.text) > limit
    || typeof input.revision !== 'string' || !/^(?:missing|[a-f0-9]{64})$/u.test(input.revision)) fail('invalid_instruction')
  return inWorkspace(cwd, (root, recheck) => {
    const path = join(root, name)
    const current = inspect(path)
    if (!current.revision || current.revision !== input.revision) fail('instruction_changed')
    if (current.stat) accessSync(path, fs.W_OK)
    if (current.state === 'present' && current.text === input.text) {
      const { stat, ...view } = current
      return view
    }
    const pending = join(root, '.octo-instructions-' + randomUUID())
    let staged = false
    try {
      const fd = openSync(pending, 'wx', 0o600)
      staged = true
      try { writeFileSync(fd, input.text, { encoding: 'utf8', flush: true }) }
      finally { closeSync(fd) }
      if (current.stat && process.getuid) {
        const stagedStat = lstatSync(pending)
        if (stagedStat.uid !== current.stat.uid || stagedStat.gid !== current.stat.gid) {
          chownSync(pending, current.stat.uid, current.stat.gid)
        }
        chmodSync(pending, current.stat.mode & 0o777)
      }
      recheck()
      if (inspect(path).revision !== current.revision) fail('instruction_changed')
      if (current.state === 'missing') {
        try { linkSync(pending, path) }
        catch (error) { if (error.code === 'EEXIST') fail('instruction_changed'); throw error }
      } else renameSync(pending, path)
    } finally { if (staged) { try { unlinkSync(pending) } catch {} } }
    const { stat, ...saved } = inspect(path)
    return saved
  })
}
