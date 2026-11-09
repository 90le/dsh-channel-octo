import { normalizeAttachment } from './octo-media.js'

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
export function normalizeOctoContent(payload, { allowFiles = false } = {}) {
  if (!object(payload) || !Number.isInteger(payload.type) || (Object.hasOwn(mediaLabels, payload.type) && !allowFiles && !clean(payload.content).trim())) return
  const body = [], quote = [], attachments = [], sources = new Map()
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
    if (!allowFiles) { append(parts, '【' + label + '：账号未启用附件】'); return }
    const item = normalizeAttachment(candidate)
    if (!item) { append(parts, '【' + label + '：附件不可用】'); return }
    let media = sources.get(item.url)
    if (media === undefined) {
      if (attachments.length >= maxFiles) { append(parts, '【其余附件已省略】'); return }
      media = attachments.length
      attachments.push(item)
      sources.set(item.url, media)
    }
    // Represent the bytes once. For duplicate blocks keep a visible marker at
    // the later occurrence without duplicating the native upload/storage.
    if (body.some(part => part.media === media) || quote.some(part => part.media === media)) {
      append(parts, '【重复' + label + '】')
      return
    }
    parts.push({ media })
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
        else if (typeof block.type === 'string' && Object.hasOwn(mediaTypes, block.type)) media(parts, { ...block, type: mediaTypes[block.type] })
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
        append(parts, (short(entry.from_name, 70) || users.get(entry.from_uid) || short(entry.from_uid, 70) || '未知来源') + '：')
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
      const name = short(value.name, 70), uid = short(value.uid, 70)
      append(parts, '【名片：' + (name || uid || '未知') + '】')
    }
  }
  visit(body, payload)
  if (!body.some(part => part.media !== undefined || part.text?.trim())) return
  const text = body.map(part => part.text ?? '').join('').trim()
  const reply = payload.reply
  if (object(reply) && (object(reply.payload) || (typeof reply.message_id === 'string' && /^\d{1,19}$/.test(reply.message_id)))) {
    // Give inline quote data at most 2,200 of the remaining text bytes.
    // A reference without inline content never triggers a history lookup.
    remaining = Math.min(2200, remaining)
    const name = short(reply.from_name ?? reply.from_uid, 70)
    append(quote, '【引用消息' + (name ? ' · ' + name : '') + '；仅供上下文参考】\n')
    if (object(reply.payload) && Number.isInteger(reply.payload.type)) visit(quote, reply.payload, 1)
    else append(quote, '引用的原文未随消息提供。')
    append(quote, '\n【引用结束】\n\n')
  }
  if (truncated) body.push({ text: '\n【部分内容已省略】' })
  const parts = [...quote, ...body]
  if (payload.type === 1 && !quote.length && !truncated) return { text }
  if (Object.hasOwn(mediaLabels, payload.type) && !quote.length && attachments.length === 1 && parts.length <= 2) {
    return { text, attachment: attachments[0] }
  }
  return { text, parts, ...(attachments.length && { attachments }) }
}
