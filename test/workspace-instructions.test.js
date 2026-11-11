import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, linkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readInstruction, saveInstruction } from '../src/workspace-instructions.js'

test('edits the same workspace file, and cannot replace a newer disk revision', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-instructions-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const name = 'SOUL.md', path = join(cwd, name)
  const missing = readInstruction(cwd, name)
  const saved = saveInstruction(cwd, name, { text: '工作区角色\n', revision: missing.revision })
  assert.equal(readFileSync(path, 'utf8'), saved.text)
  writeFileSync(path, 'edited outside Web')
  for (const revision of [missing.revision, saved.revision]) {
    assert.throws(() => saveInstruction(cwd, name, { text: 'stale', revision }), /instruction_changed/)
  }
  const current = readInstruction(cwd, name)
  assert.equal(current.text, 'edited outside Web')
  saveInstruction(cwd, name, { text: 'updated by Web', revision: current.revision })
  assert.equal(readFileSync(path, 'utf8'), 'updated by Web')
  assert.throws(() => saveInstruction(cwd, '../SOUL.md', { text: '', revision: saved.revision }), /invalid_instruction/)
})

test('linked and oversized files cannot be opened as instruction documents', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-instructions-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const other = join(cwd, 'external.txt')
  writeFileSync(other, 'original')
  linkSync(other, join(cwd, 'AGENTS.md'))
  assert.deepEqual(readInstruction(cwd, 'AGENTS.md'), { state: 'unsafe' })
  assert.throws(() => saveInstruction(cwd, 'AGENTS.md', { text: '', revision: 'missing' }), /instruction_changed/)
  assert.equal(readFileSync(other, 'utf8'), 'original')
  writeFileSync(join(cwd, 'SOUL.md'), 'x'.repeat(32 * 1024 + 1))
  assert.deepEqual(readInstruction(cwd, 'SOUL.md'), { state: 'too-large' })
})
