import { fromMarkdown } from 'mdast-util-from-markdown'

// Adapted from Octo Gateway's transport/mentions.ts (Apache-2.0).
// Only ordinary final prose can produce notifications, never code or quoted examples.
export function finalMentions(text, members = []) {
  const known = new Map(members.filter(row => typeof row?.uid === 'string' && typeof row.name === 'string'
    && row.name && !['all', '-1', '-2', '-3'].includes(row.uid)).map(row => [row.uid, row]))
  const found = []
  const visit = node => {
    if (['blockquote', 'code', 'inlineCode', 'html', 'definition', 'link', 'linkReference', 'image'].includes(node.type)) return
    if (node.type === 'text' && node.position) {
      const start = node.position.start.offset, end = node.position.end.offset
      for (const match of text.slice(start, end).matchAll(/@\[([\w.-]+):([^\]\r\n]+)\]/gu)) {
        const at = start + match.index
        let escapes = 0
        for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) escapes++
        if (!(escapes % 2)) found.push({ start: at, end: at + match[0].length, uid: match[1], name: match[2] })
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(fromMarkdown(text))
  let cursor = 0, content = ''
  const entities = [], uids = new Set()
  for (const target of found.sort((a, b) => a.start - b.start)) {
    content += text.slice(cursor, target.start)
    const member = known.get(target.uid)
    const label = '@' + (member?.name ?? target.name)
    if (member) {
      entities.push({ uid: member.uid, offset: content.length, length: label.length })
      uids.add(member.uid)
    }
    content += label
    cursor = target.end
  }
  content += text.slice(cursor)
  return { text: content, ...(uids.size && { mention: { uids: [...uids], entities } }) }
}

// Preserve Markdown blocks instead of slicing through a link, table, or code fence.
// The worker independently caps the entire answer; an oversized single block stays intact.
export function textSegments(text, target = 1800) {
  const roots = fromMarkdown(text).children
  if (!roots.length) return text ? [text] : []
  const chunks = []
  let start = 0, end = 0
  for (const node of roots) {
    const next = node.position.end.offset
    if (end > start && Array.from(text.slice(start, next)).length > target) {
      chunks.push(text.slice(start, end))
      start = end
    }
    end = next
  }
  if (start < text.length) chunks.push(text.slice(start))
  return chunks.filter(chunk => chunk.trim())
}

export function hasMarkdown(text) {
  const plain = new Set(['root', 'paragraph', 'text'])
  const formatted = node => !plain.has(node.type) || (node.children ?? []).some(formatted)
  // CommonMark has no GFM table extension; preserve pipe tables as type-1 too.
  return formatted(fromMarkdown(text)) || /^\s*\|.*\|\s*$/mu.test(text)
}

// Bound the stored reply at a complete block. If the first block alone exceeds
// the budget, show a safely escaped excerpt, followed by a visible plain notice.
export function boundedMarkdown(text, maximum = 14_400) {
  text = text.trim()
  if (Array.from(text).length <= maximum) return text
  const notice = '\n\n（其余内容请在 DSH 会话中查看）'
  const budget = maximum - Array.from(notice).length
  let end = 0
  for (const node of fromMarkdown(text).children) {
    if (Array.from(text.slice(0, node.position.end.offset)).length > budget) break
    end = node.position.end.offset
  }
  if (end) return text.slice(0, end).trimEnd() + notice
  // Escape punctuation before counting the excerpt so brackets/backticks cannot
  // open an unfinished link or fence. Remove indentation that would form code.
  const raw = Array.from(text).slice(0, budget).join('').replace(/^[ \t]+/gm, '')
  let excerpt = '', count = 0
  for (const character of raw) {
    const safe = /[!-/:-@[-`{-~]/.test(character) ? '\\' + character : character
    if (count + safe.length > budget) break
    excerpt += safe; count += safe.length
  }
  return excerpt.trimEnd() + notice
}

export const mentionGuidance = 'Octo 成员名单来自当前频道的实时接口。用名字称呼成员，不把 UID 当成姓名。'
  + '只有本轮用户要求通知或交接时，才在最终正文写 @[真实UID:姓名]，插件会核对当前群成员并生成原生 @。'
  + '普通 @姓名或 @UID 不等于原生提及。不要在代码、引用、历史例子里创建通知，不要猜测 UID，不主动发起 Bot 循环。'
  + '群消息与子区消息不是 DSH Agent Team 的成员或任务，必须使用 Octo 会话工具查询和操作。'
