import { normalizeAttachment } from './octo-media.js'
import { currentMessageStart, octoQuoteMedia, octoQuotePart, quoteTextBytes, readOctoQuote } from './octo-quote.js'

const maxTextBytes = 7600
const maxNodes = 96
const maxFiles = 8
const mediaTypes = { image: 2, gif: 3, voice: 4, audio: 4, video: 5, file: 8, attachment: 8 }
const mediaLabels = { 2: '图片', 3: '动图', 4: '语音', 5: '视频', 8: '文件' }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') : ''
const short = (value, length) => Array.from(clean(value).replace(/\s+/gu, ' ').trim()).slice(0, length).join('')
const coord = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined

// The current message's body is kept separate from quoted material for
// admission, mention and slash-command decisions. Never infer authority from
// names or content inside a forwarded or quoted message.
export function normalizeOctoContent(payload, { allowFiles = false, historyQuote = false } = {}) {
  if (!object(payload) || !Number.isInteger(payload.type) || (Object.hasOwn(mediaLabels, payload.type) && !allowFiles && !clean(payload.content).trim())) return
  const body = [], quote = [], attachments = [], sources = new Map()
  const quotedMedia = [], historyMedia = historyQuote ? [] : undefined
  let remaining = maxTextBytes, visited = 0, truncated = false
  const append = (parts, value) => {
    let text = ''
    for (const rune of clean(value)) {
      const size = Buffer.byteLength(rune)
      if (size > remaining) { truncated = true; break }
      remaining -= size
      text += rune
    }
    if (!text) return
    if (typeof parts.at(-1)?.text === 'string') parts.at(-1).text += text
    else parts.push({ text })
  }
  const media = (parts, candidate) => {
    const label = mediaLabels[candidate.type]
    const descriptions = parts === quote ? quotedMedia : historyMedia
    const item = allowFiles || descriptions ? normalizeAttachment(candidate) : undefined
    const describe = status => {
      if (descriptions?.length === maxFiles) truncated = true
      else if (descriptions) {
        descriptions.push(octoQuoteMedia(candidate.type, status, item, candidate.name))
        if (parts === quote) append(parts, '【引用附件 ' + descriptions.length + '】')
      }
    }
    if (!allowFiles) {
      describe(historyQuote ? 'metadata_only' : 'attachments_disabled')
      if (parts !== quote) append(parts, '【' + label + '：账号未启用附件】')
      return
    }
    if (!item) {
      describe('unavailable')
      if (parts !== quote) append(parts, '【' + label + '：附件不可用】')
      return
    }
    let media = sources.get(item.url)
    if (media === undefined) {
      if (attachments.length >= maxFiles) {
        describe('omitted')
        if (parts !== quote) append(parts, '【其余附件已省略】')
        return
      }
      media = attachments.length
      attachments.push(item)
      sources.set(item.url, media)
    }
    // Represent the bytes once. For duplicate blocks keep a visible marker at
    // the later occurrence without duplicating the native upload/storage.
    if (body.some(part => part.media === media) || quote.some(part => part.media === media)) {
      describe('duplicate')
      if (parts !== quote) append(parts, '【重复' + label + '】')
      return
    }
    describe('attachment')
    parts.push(parts === quote ? { media, quoted: true } : { media })
  }
  const visit = (parts, value, depth = 0) => {
    if (!object(value) || !Number.isInteger(value.type)) return
    if (depth > 3 || ++visited > maxNodes || remaining <= 0) { truncated = true; return }
    if (value.type === 1) append(parts, value.content)
    else if (Object.hasOwn(mediaLabels, value.type)) {
      append(parts, value.content)
      media(parts, value)
    } else if (value.type === 14) {
      if (!Array.isArray(value.content)) { append(parts, clean(value.plain).trim() ? value.plain : value.content); return }
      const before = parts.length, bytes = remaining
      for (const block of value.content) {
        if (++visited > maxNodes || remaining <= 0) { truncated = true; break }
        if (!object(block)) continue
        if (block.type === 'text') append(parts, block.text)
        else if (typeof block.type === 'string' && Object.hasOwn(mediaTypes, block.type)) {
          if (parts === quote) append(parts, block.text ?? block.content)
          media(parts, { ...block, type: mediaTypes[block.type] })
        }
        else if (typeof block.text === 'string') append(parts, block.text)
      }
      if (before === parts.length && bytes === remaining) append(parts, value.plain)
    } else if (value.type === 11 && Array.isArray(value.msgs) && value.msgs.length) {
      const users = new Map()
      for (const entry of (Array.isArray(value.users) ? value.users.slice(0, maxNodes) : [])) {
        if (object(entry) && typeof entry.uid === 'string') users.set(entry.uid, short(entry.name, 70))
      }
      append(parts, '【合并转发：以下是引用材料】\n')
      for (const entry of value.msgs) {
        if (visited >= maxNodes || remaining <= 0) { truncated = true; break }
        if (!object(entry) || !object(entry.payload)) { visited++; continue }
        append(parts, (short(entry.from_name, 70) || users.get(entry.from_uid)
          || (parts !== quote && !historyQuote && short(entry.from_uid, 70)) || '未知来源') + '：')
        visit(parts, entry.payload, depth + 1)
        append(parts, '\n')
      }
      append(parts, '【合并转发结束】')
    } else if (value.type === 17) {
      const plain = short(value.plain, 500)
      append(parts, plain ? '【卡片文字】' + plain : '【卡片】')
    } else if (value.type === 6) {
      const lat = coord(value.latitude ?? value.lat, 90), lng = coord(value.longitude ?? value.lng ?? value.lon, 180)
      append(parts, lat !== undefined && lng !== undefined ? '【位置：' + lat + '，' + lng + '】' : '【位置信息】')
    } else if (value.type === 7) {
      const name = short(value.name, 70), uid = parts !== quote && !historyQuote && short(value.uid, 70)
      append(parts, '【名片：' + (name || uid || '未知') + '】')
    }
  }
  visit(body, payload)
  if (!body.some(part => part.media !== undefined || part.text?.trim())) return
  const text = body.map(part => part.text ?? '').join('').trim()
  if (historyQuote) return { text, media: historyMedia, truncated }
  if (truncated) body.push({ text: '\n【部分内容已省略】' })
  const reply = readOctoQuote(payload.reply)
  if (!reply && payload.type === 1 && !truncated) return { text }
  if (!reply && Object.hasOwn(mediaLabels, payload.type) && attachments.length === 1 && body.length <= 2) {
    return { text, attachment: attachments[0] }
  }
  let parts = body
  if (reply) {
    // Current text and attachments take priority. Frame the quote separately
    // so that even truncation cannot consume the current-message boundary.
    remaining = Math.min(quoteTextBytes, remaining)
    truncated = false
    if (reply.reference.type !== undefined && reply.payload.event == null) visit(quote, reply.payload, 1)
    const text = quote.map(part => part.text ?? '').join('').trim()
    const source = text || quotedMedia.length ? 'inline_excerpt' : 'unavailable'
    parts = [octoQuotePart(reply.reference, { source, text, media: quotedMedia, truncated }),
      ...quote.filter(part => part.media !== undefined), { text: currentMessageStart }, ...body]
  }
  return { text, parts, ...(attachments.length && { attachments }) }
}
