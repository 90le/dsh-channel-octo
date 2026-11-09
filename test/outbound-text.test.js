import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalMentions, textSegments, hasMarkdown } from '../src/outbound-text.js'
import { OctoClient } from '../src/octo.js'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'

test('verified final-prose mentions use actual member names and UTF-16 offsets; examples never notify', () => {
  const input = '😀 请 @[alice:错误名字] 查看。\n\n> @[alice:引用]\n\n`@[alice:代码]`\n\n```text\n@[alice:围栏]\n```\n\n'
    + '\\@[alice:转义] [@[alice:链接]](https://example.invalid)\n\n@[unknown:未知] @[all:所有人]'
  const result = finalMentions(input, [{ uid: 'alice', name: '小明', robot: false }])
  assert.equal(result.text.slice(0, 13), '😀 请 @小明 查看。\n')
  assert.deepEqual(result.mention, { uids: ['alice'], entities: [{ uid: 'alice', offset: 5, length: 3 }] })
  assert.match(result.text, /> @\[alice:引用\]/)
  assert.match(result.text, /`@\[alice:代码\]`/)
  assert.match(result.text, /@未知 @所有人$/)
  assert.equal(finalMentions('@[alice:小明]', []).mention, undefined)
})

test('long replies preserve complete Markdown blocks, Unicode, and all description text', () => {
  const long = '开头 😀\n\n' + '```javascript\n' + 'const value = "你好";\n'.repeat(120) + '```\n\n'
    + '[完整链接](https://example.invalid/' + 'a'.repeat(1900) + ')\n\n**结尾说明**'
  const chunks = textSegments(long)
  assert.equal(chunks.join(''), long)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.equal((chunk.match(/^```/gm) ?? []).length % 2, 0)
  assert.ok(chunks.some(chunk => chunk.includes('完整链接') && chunk.includes('a'.repeat(1900) + ')')))
  assert.equal(hasMarkdown('**摘要**\n\n- 项目一'), true)
  assert.equal(hasMarkdown('普通图片说明'), false)
})

test('text preserves its description and only a complete usable quote is transmitted', async () => {
  const sent = []
  const api = new OctoClient({ apiBase: 'https://octo.example.invalid/api', token: 'bf_fixture',
    fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body).payload); return Response.json({ message_id: '99' }) } })
  const signal = new AbortController().signal
  const body = '摘要已完成 ✅ 文件：<fixture_summary.md>\n\n**摘要结构**\n\n- 内容一\n- 内容二\n\n还可继续修改。'
  await api.send('alice', body, signal, 1, '88')
  assert.deepEqual(sent[0], { type: 1, content: body })
  const quote = { message_id: '88', message_seq: 7, from_uid: 'alice', from_name: '小明', payload: { type: 1, content: '请总结' } }
  await api.send('group', body, signal, 2, quote)
  assert.deepEqual(sent[1], { type: 1, content: body, reply: quote })
  await api.send('group', body, signal, 2, { ...quote, message_seq: undefined })
  assert.equal(sent[2].reply, undefined)
})

test('worker total reply limit keeps truncation notices outside crossing fences and links', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'octo-long-reply-'))
  const store = new Store(cwd, 'fixture')
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) })
  const config = { cwd, ownerUid: 'alice', senderPolicy: 'octo', toolPermission: 'text-only', allowed: new Set() }
  const sent = []
  let reply
  const api = { async allowsMessage() { return true }, async rules() { return [] },
    async send(_recipient, text) { sent.push(text); return '900' } }
  const worker = new Worker({ config, store, api, log() {}, host: {
    async run(_session, _input, created) { await created(); return reply },
  } })
  const examples = ['前文\n\n```text\n' + 'long '.repeat(3000) + '\n```',
    '[long link](https://example.invalid/' + 'x'.repeat(15000) + ')',
    '```text\n' + '😀 `. '.repeat(5000) + '\n```']
  for (const [index, value] of examples.entries()) {
    reply = value; sent.length = 0
    store.add(String(index + 1), { messageId: String(index + 1), sender: 'alice', channelId: 'alice', channelType: 1, text: 'long' })
    await worker.process(store.next(Date.now()), new AbortController().signal)
    const output = sent.join('')
    assert.ok(output.length > 0 && Array.from(output).length <= 14400)
    const last = fromMarkdown(output).children.at(-1)
    assert.equal(last.type, 'paragraph')
    assert.equal(last.children.at(-1).value, '（其余内容请在 DSH 会话中查看）')
  }
})
