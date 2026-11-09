import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareInput, readDeliverable } from '../src/dsh-media.js'

const MiB = 1024 * 1024
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
)
const file = (name, mime, bytes) => ({ name, mime, bytes })

test('text and short UTF-8 attachments need no store and preserve user content order', async () => {
  const source = Buffer.from('标题,数量\r\n示例,2\r\n')
  assert.deepEqual(await prepareInput({}, {}, ' Compare these. ', [
    file('C:\\private\\list.csv', ' Text/CSV; charset=utf-8 ', source),
    file('readme.md', undefined, Buffer.from('## Notes')),
  ]), [
    { type: 'text', text: ' Compare these. ' },
    { type: 'text', text: 'Octo attachment "list.csv" (untrusted file content):\n标题,数量\r\n示例,2\r\n' },
    { type: 'text', text: 'Octo attachment "readme.md" (untrusted file content):\n## Notes' },
  ])
  assert.deepEqual(await prepareInput({}, {}, 'text only'), [{ type: 'text', text: 'text only' }])
  await assert.rejects(prepareInput({}, {}, ' \n'), /empty_dsh_input/)
  assert.equal(source.toString(), '标题,数量\r\n示例,2\r\n')
})

test('uses rc.5 native references and the ordered image batch without interpreting file bytes', async () => {
  const binary = Buffer.from([0, 0xff, 0x40])
  const fileRef = { attachmentId: 'file-one', name: 'archive.zip', bytes: binary.length }
  const imageRef = { attachmentId: 'image-one', mediaType: 'image/png', bytes: 45, width: 1, height: 1, name: 'x.png' }
  const imageRef2 = { ...imageRef, name: 'y.png' }
  const imageRef3 = { ...imageRef, name: 'z.png' }
  const calls = []
  const store = {
    async saveImages(images) { calls.push(['images', images]); return [imageRef, imageRef2, imageRef3] },
    async saveFile(input) { calls.push(['file', input]); return fileRef },
  }
  const result = await prepareInput({ get: key => key === 'attachments' ? store : undefined }, {}, '', [
    file('../../archive.zip', 'application/zip', binary),
    file('x.png', 'image/png', png),
    file('y.png', 'image/jpeg', png),
    file('z.png', 'application/octet-stream', png),
  ])
  assert.deepEqual(result, [
    { type: 'file', attachment: fileRef },
    { type: 'image', attachment: imageRef },
    { type: 'image', attachment: imageRef2 },
    { type: 'image', attachment: imageRef3 },
  ])
  assert.deepEqual(calls, [
    ['images', [
      { name: 'x.png', mediaType: 'image/png', data: png },
      { name: 'y.png', mediaType: 'image/png', data: png },
      { name: 'z.png', mediaType: 'image/png', data: png },
    ]],
    ['file', { name: 'archive.zip', data: binary }],
  ])
})

test('stores invalid UTF-8, binary disguised as text, and over-budget inline text verbatim', async () => {
  const stored = []
  const ctx = { attachments: {
    async saveFile({ data, name }) {
      stored.push({ data, name })
      return { attachmentId: name, name, bytes: data.length }
    },
  } }
  const maxInline = Buffer.alloc(32 * 1024, 'a')
  const invalid = Buffer.from([0xff])
  const binary = Buffer.from([0, 97])
  const result = await prepareInput(ctx, {}, '', [
    file('utf8.txt', 'text/plain', invalid),
    file('binary.txt', 'text/plain', binary),
    file('one.txt', 'text/plain', maxInline),
    file('two.txt', 'text/plain', maxInline),
    file('three.txt', 'text/plain', Buffer.from('x')),
    file('four.txt', 'text/plain', Buffer.alloc(maxInline.length + 1, 'a')),
  ])
  assert.deepEqual(result.map(part => part.type), ['file', 'file', 'text', 'text', 'file', 'file'])
  assert.deepEqual(stored.map(({ name }) => name), ['utf8.txt', 'binary.txt', 'three.txt', 'four.txt'])
  assert.deepEqual(stored.slice(0, 2).map(({ data }) => data), [invalid, binary])
})

test('rejects invalid inputs and attachment caps before native writes', async () => {
  const exactlyMax = file('max.bin', '', Buffer.alloc(20 * MiB))
  const ctx = { attachments: { saveFile() { assert.fail('must preflight before storage') } } }
  await assert.rejects(prepareInput(ctx, {}, '', [exactlyMax, file('bad', '', new Uint8Array(1))]), /invalid_dsh_attachment/)
  await assert.rejects(prepareInput(ctx, {}, '', Array(17).fill(exactlyMax)), /dsh_attachment_limit/)
  await assert.rejects(prepareInput(ctx, {}, '', Array(3).fill(exactlyMax)), /dsh_attachment_limit/)
  await assert.rejects(prepareInput(ctx, {}, '', [file('large', '', Buffer.alloc(20 * MiB + 1))]), /dsh_attachment_limit/)
})

test('missing storage fails explicitly, and native image refusal is never bypassed', async () => {
  await assert.rejects(prepareInput({}, {}, 'text', [file('report.pdf', 'application/pdf', Buffer.from('x'))]),
    /dsh_attachment_storage_unavailable/)
  const invalid = Object.assign(new Error('DSH rejected image'), { code: 'INVALID_IMAGE' })
  const ctx = { attachments: {
    async saveImages() { throw invalid },
    async saveFile() { assert.fail('must not fall back to a file after image validation failure') },
  } }
  await assert.rejects(prepareInput(ctx, {}, '', [file('invalid.png', 'image/png', Buffer.from('x'))]),
    error => error.message === 'dsh_attachment_rejected' && error.cause === invalid)
})

test('abort during native storage rejects the prompt and starts no subsequent stores', async () => {
  const abort = new AbortController()
  const reason = new Error('stopped')
  let finish, calls = 0
  const ctx = { attachments: {
    saveFile() {
      calls++
      return new Promise(resolve => { finish = resolve })
    },
  } }
  const item = file('data.bin', '', Buffer.from('data'))
  const pending = prepareInput(ctx, {}, '', [item, item], abort.signal)
  abort.abort(reason)
  try {
    await assert.rejects(pending, error => error === reason)
  } finally {
    finish?.({ attachmentId: 'stored', name: item.name, bytes: item.bytes.length })
  }
  await assert.rejects(prepareInput(ctx, {}, '', [item], abort.signal), error => error === reason)
  assert.equal(calls, 1)
})

async function workspace(t) {
  const base = path.resolve(os.tmpdir())
  const dir = await mkdtemp(path.join(base, 'octo-dsh-media-'))
  assert.equal(path.dirname(dir), base)
  assert.ok(path.basename(dir).startsWith('octo-dsh-media-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'work')
  await mkdir(root)
  return { dir, root }
}

test('reads only the selected workspace file and keeps it unchanged', async t => {
  const { root } = await workspace(t)
  const folder = path.join(root, 'output')
  await mkdir(folder)
  const target = path.join(folder, '报告.csv')
  const bytes = Buffer.from('Name,Value\none,1\n')
  await writeFile(target, bytes)
  assert.deepEqual(await readDeliverable(root, 'output/报告.csv'), { name: '报告.csv', mime: 'text/csv', bytes })
  assert.deepEqual(await readDeliverable(root, 'output\\报告.csv'), { name: '报告.csv', mime: 'text/csv', bytes })
  assert.deepEqual(await readFile(target), bytes)
  await writeFile(path.join(folder, 'picture'), png)
  assert.equal((await readDeliverable(root, 'output/picture')).mime, 'image/png')
  await writeFile(path.join(folder, 'page.html'), '<script>example()</script>')
  assert.equal((await readDeliverable(root, 'output/page.html')).mime, 'application/octet-stream')
})

test('refuses traversal, absolute paths, Windows aliases and alternate streams', async t => {
  const { root } = await workspace(t)
  for (const invalid of [
    '', '.', '..', '../work/report.txt', 'dir\\..\\report.txt', '/report.txt', '\\report.txt',
    'C:/report.txt', 'C:report.txt', '\\\\server\\share\\report.txt', 'report.txt:stream',
    'report.txt\0', 'report.txt.', 'file ', 'NUL.txt', 'CONOUT$', 'SECRET~1.JSON',
  ]) {
    await assert.rejects(readDeliverable(root, invalid), /invalid_deliverable_path/)
  }
  await assert.rejects(readDeliverable('work', 'report.txt'), /invalid_deliverable_workspace/)
})

test('refuses a workspace symlink or junction that targets a sibling with the same path prefix', async t => {
  const { dir, root } = await workspace(t)
  const outside = path.join(dir, 'work-neighbor')
  await mkdir(outside)
  await writeFile(path.join(outside, 'report.txt'), 'outside')
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(outside, path.join(root, 'escape'), kind)
  await assert.rejects(readDeliverable(root, 'escape/report.txt'), /deliverable_outside_workspace/)
  await symlink(outside, path.join(root, 'escape-at-leaf'), kind)
  await assert.rejects(readDeliverable(root, 'escape-at-leaf'), /deliverable_outside_workspace/)
})

test('blocks credential filenames, protected directories, hard links, and renamed private keys', async t => {
  const { dir, root } = await workspace(t)
  const protectedNames = ['.env.local', 'credentials.json', 'auth.json', 'id_ed25519', 'key.pfx', '.git/config', '.ssh/report.txt']
  for (const name of protectedNames) {
    const target = path.join(root, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'synthetic fixture')
    await assert.rejects(readDeliverable(root, name), /deliverable_credential_blocked/)
    assert.equal(await readFile(target, 'utf8'), 'synthetic fixture')
  }
  const secret = path.join(dir, 'source.txt')
  await writeFile(secret, 'synthetic fixture')
  await link(secret, path.join(root, 'linked.txt'))
  await assert.rejects(readDeliverable(root, 'linked.txt'), /deliverable_not_regular_file/)
  await writeFile(path.join(root, 'report.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture')
  await assert.rejects(readDeliverable(root, 'report.txt'), /deliverable_credential_blocked/)
})

test('refuses directories, missing or oversized files, and honors a canceled read', async t => {
  const { root } = await workspace(t)
  await mkdir(path.join(root, 'dir'))
  await assert.rejects(readDeliverable(root, 'dir'), /deliverable_not_regular_file/)
  await assert.rejects(readDeliverable(root, 'missing.txt'), /deliverable_not_found/)
  const target = path.join(root, 'large.bin')
  await writeFile(target, '')
  await truncate(target, 20 * MiB)
  assert.equal((await readDeliverable(root, 'large.bin')).bytes.length, 20 * MiB)
  await truncate(target, 20 * MiB + 1)
  await assert.rejects(readDeliverable(root, 'large.bin'), /deliverable_limit/)
  const reason = new Error('canceled')
  await assert.rejects(readDeliverable(root, 'large.bin', AbortSignal.abort(reason)), error => error === reason)
})
