// SPDX-License-Identifier: Apache-2.0
// Adapted from Mininglamp-OSS/openclaw-channel-octo at
// 3cdb7e794ba40ae617fb0215177d1493dd26460a: src/card-display-tool.ts,
// src/card-blocks.ts, src/card-caps.ts, src/card-limits.ts, src/card-render.ts.
// https://github.com/Mininglamp-OSS/openclaw-channel-octo/tree/3cdb7e794ba40ae617fb0215177d1493dd26460a
// Changes: bounded JavaScript display-only subset, strict schemas, HTTPS links,
// reject sensitive content instead of dropping it, native current-route transport,
// no OpenClaw discovery, logs, callback actions, raw reasoning or retry machinery.
// Redistribution: include Apache-2.0 (../LICENSE-OCTO-APACHE-2.0), retain applicable
// upstream notices and this modification notice. The pinned upstream has no NOTICE.

import { isIP } from 'node:net'
import { validUid } from './config.js'
import { decimalId, OctoError } from './octo.js'
import { ruleScope } from './rules.js'
import { apiErrorCode } from './api-errors.js'

const version = '1.5'
const maxPayloadBytes = 24 * 1024
const maxContentBytes = 8 * 1024
const maxObjects = 200
const maxBlockDepth = 6
const bytes = value => Buffer.byteLength(value, 'utf8')
const fail = code => { throw new OctoError(code) }
const invalid = () => fail('invalid_display_card')
const record = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const shape = (value, keys) => record(value) && Reflect.ownKeys(value).every(key =>
  typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
// Hoisted and self-contained: ChannelApi also imports this schema through the
// OctoClient module cycle. Return fresh JSON schemas, never shared mutable data.
export function displayCardParameters() {
  const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
  const string = maxLength => ({ type: 'string', minLength: 1, maxLength })
  const enumeration = values => ({ type: 'string', enum: values })
  const array = (items, maxItems) => ({ type: 'array', items, minItems: 1, maxItems })
  const blockList = array({ $ref: '#/$defs/block' }, 20)
  const colors = ['default', 'good', 'warning', 'attention', 'accent']
  const styles = ['default', 'good', 'warning', 'attention', 'emphasis']
  const richSegment = schema({ text: string(1000), bold: { type: 'boolean' }, subtle: { type: 'boolean' },
    fontType: enumeration(['Default', 'Monospace']), color: enumeration(colors) }, ['text'])
  const variants = {
    heading: schema({ type: { const: 'heading' }, text: string(2048), size: enumeration(['medium', 'large']) }, ['type', 'text']),
    text: schema({ type: { const: 'text' }, text: string(2048) }),
    rich: schema({ type: { const: 'rich' }, segments: array(richSegment, 20) }),
    facts: schema({ type: { const: 'facts' }, items: array(schema({ label: string(160), value: string(2048) }), 20) }),
    columns: schema({ type: { const: 'columns' }, columns: array(schema({ blocks: blockList }), 4) }),
    table: schema({ type: { const: 'table' },
      columns: array(schema({ width: { type: 'number', exclusiveMinimum: 0, maximum: 100 } }, []), 6),
      rows: array(schema({ cells: array({ oneOf: [schema({ text: string(2048) }), schema({ blocks: blockList })] }, 6) }), 12),
      firstRowAsHeader: { type: 'boolean' } }, ['type', 'rows']),
    link: schema({ type: { const: 'link' }, text: string(160), url: { ...string(2048), pattern: '^https://' } }),
    group: schema({ type: { const: 'group' }, style: enumeration(styles), blocks: blockList }, ['type', 'blocks']),
    collapsible: schema({ type: { const: 'collapsible' }, summary: string(160), blocks: blockList,
      actionLabel: string(80), expandLabel: string(80), collapseLabel: string(80), defaultVisible: { type: 'boolean' } },
    ['type', 'summary', 'blocks']),
    copy: schema({ type: { const: 'copy' }, label: string(80), text: string(4096) }, ['type', 'text']),
  }
  return { ...schema({ title: string(160), blocks: blockList }, ['blocks']),
    $defs: { block: { oneOf: Object.values(variants) } } }
}
const variants = Object.fromEntries(displayCardParameters().$defs.block.oneOf.map(value => [value.properties.type.const, value]))
const richSegment = variants.rich.properties.segments.items
const colors = richSegment.properties.color.enum
const styles = variants.group.properties.style.enum

export const spec = {
  name: 'octo_display_card',
  description: 'Send a structured DISPLAY card to the current admitted Octo conversation as the bot. '
    + 'The runtime binds the route; arguments cannot select a recipient, account, identity or raw payload. '
    + 'Use title and heading/text/rich/facts/columns/table/link/group/collapsible/copy blocks for concise user-facing output. '
    + 'Unsupported elements become faithful plain text inside the card. Links must be public HTTPS URLs without embedded credentials or credential query parameters. '
    + 'Copy, expand/collapse and navigation are local client actions only; there are no callback buttons. '
    + 'Never include secrets, raw logs or private reasoning. Limit nesting to 6 blocks, total objects to 200 and text to 8 KiB UTF-8; field limits also apply in bytes. '
    + 'If display cards are unavailable or content cannot fit, send an ordinary final text reply instead. '
    + 'This tool returns a delivery receipt, NOT a final answer. After success you MUST still produce a short final summary to the user.',
  parameters: displayCardParameters(),
}

// The upstream credential-shape guard is deliberately conservative for group-visible output.
const secretWords = /token|api[_-]?key|secret|password|passwd|pwd|authorization|bearer|access[_-]?key|credential|密码|密钥|口令/i
const secretPrefixes = [
  /(?:bf|app)_[A-Za-z0-9_-]+/, /AKIA[0-9A-Z]{12,}/, /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/, /xapp-[0-9]-[A-Za-z0-9-]{10,}/, /sk-[A-Za-z0-9_-]{16,}/,
  /[srp]k_(?:live|test)_[A-Za-z0-9]{10,}/, /glpat-[A-Za-z0-9_-]{16,}/, /AIza[0-9A-Za-z_-]{30,}/,
  /npm_[A-Za-z0-9]{30,}/, /shpat_[A-Fa-f0-9]{32,}/, /dop_v1_[A-Fa-f0-9]{32,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[0-9a-fA-F]{32,}\b/,
]
function sensitive(value) {
  // Ordinary instructions about passwords or token usage are not credentials.
  const assignment = /(?:api[_-]?key|secret|password|passwd|pwd|authorization|bearer|access[_-]?key|credential|密码|密钥|口令)\s*[:=：]\s*["']?\S{4,}/i
  if (assignment.test(value) || secretPrefixes.some(pattern => pattern.test(value))) return true
  const runs = value.match(/[A-Za-z0-9_+=-]{32,}/g) ?? []
  if (runs.some(run => /[0-9]/.test(run) && /[A-Za-z]/.test(run) || /[_+=-]/.test(run))) return true
  // Upstream's linear JWT run scan, including tokens split across rich segments.
  let older, previous
  for (const match of value.matchAll(/[A-Za-z0-9_-]+/g)) {
    const current = { text: match[0], start: match.index, end: match.index + match[0].length }
    if (older && previous.start === older.end + 1 && value[older.end] === '.'
      && current.start === previous.end + 1 && value[previous.end] === '.' && previous.text.length >= 8) {
      const head = older.text.indexOf('eyJ')
      if (head !== -1 && older.text.length - head >= 11) return true
    }
    older = previous
    previous = current
  }
  return false
}
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
function safeUrl(value) {
  let url, decoded
  try { url = new URL(value); decoded = decodeURIComponent(value) } catch { fail('display_card_unsafe_link') }
  const host = url.hostname.replace(/\.$/, '')
  if (!value.startsWith('https://') || /[\s\\<>]/u.test(value) || /[\s\\<>]/u.test(decoded) || control.test(decoded)
    || url.protocol !== 'https:' || url.username || url.password
    || [...url.searchParams.keys()].some(key => secretWords.test(key))
    || !host.includes('.') || isIP(host) || host.includes(':')
    || /(?:^|\.)(?:localhost|local|internal|lan|home)$/i.test(host)
    || sensitive(decoded)) fail('display_card_unsafe_link')
  return url.href
}
function safeContent(value) {
  if (sensitive(value)) fail('display_card_sensitive_content')
  if (/\b(?:javascript|vbscript|data|file|mailto):|(?<!:)\/\//i.test(value)) fail('display_card_unsafe_link')
  for (const match of value.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"\[\]]+/g)) safeUrl(match[0])
}

function normalize(args) {
  let count = 0, total = 0
  const allText = []
  const object = (value, keys) => { if (++count > maxObjects || !shape(value, keys)) invalid() }
  const list = (value, max) => {
    if (!Array.isArray(value) || !value.length || value.length > max) invalid()
    return Array.from(value)
  }
  const text = (value, max = 2048) => {
    if (typeof value !== 'string' || value.length > max || !value.trim() || control.test(value)) invalid()
    const length = bytes(value)
    if (length > max || (total += length) > maxContentBytes) invalid()
    safeContent(value)
    allText.push(value)
    return value
  }
  const option = (value, allowed) => {
    if (value !== undefined && !allowed.includes(value)) invalid()
    return value
  }
  const blocks = (values, depth = 1) => {
    if (depth > maxBlockDepth) invalid()
    return list(values, 20).map(value => {
      const type = record(value) && Object.getOwnPropertyDescriptor(value, 'type')?.value
      if (!Object.hasOwn(variants, type)) invalid()
      object(value, Object.keys(variants[type].properties))
      const children = items => blocks(items, depth + 1)
      switch (type) {
        case 'heading': return { type, text: text(value.text), size: option(value.size, ['medium', 'large']) }
        case 'text': return { type, text: text(value.text) }
        case 'rich': {
          const segments = list(value.segments, 20).map(segment => {
            object(segment, Object.keys(richSegment.properties))
            return { text: text(segment.text, 1000), bold: option(segment.bold, [true, false]),
              subtle: option(segment.subtle, [true, false]), fontType: option(segment.fontType, ['Default', 'Monospace']),
              color: option(segment.color, colors) }
          })
          safeContent(segments.map(segment => segment.text).join(''))
          return { type, segments }
        }
        case 'facts': return { type, items: list(value.items, 20).map(item => {
          object(item, ['label', 'value'])
          return { label: text(item.label, 160), value: text(item.value) }
        }) }
        case 'columns': return { type, columns: list(value.columns, 4).map(column => {
          object(column, ['blocks'])
          return { blocks: children(column.blocks) }
        }) }
        case 'table': {
          const rows = list(value.rows, 12).map(row => {
            object(row, ['cells'])
            return { cells: list(row.cells, 6).map(cell => {
              object(cell, ['text', 'blocks'])
              if (Object.hasOwn(cell, 'text') === Object.hasOwn(cell, 'blocks')) invalid()
              return Object.hasOwn(cell, 'text') ? { text: text(cell.text) } : { blocks: children(cell.blocks) }
            }) }
          })
          const width = rows[0].cells.length
          if (rows.some(row => row.cells.length !== width)) invalid()
          const columns = value.columns === undefined ? Array.from({ length: width }, () => ({ width: 1 }))
            : list(value.columns, 6).map(column => {
              object(column, ['width'])
              const weight = column.width === undefined ? 1 : column.width
              if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100) invalid()
              return { width: weight }
            })
          if (columns.length !== width) invalid()
          return { type, rows, columns, firstRowAsHeader: option(value.firstRowAsHeader, [true, false]) ?? true }
        }
        case 'link': return { type, text: text(value.text, 160), url: safeUrl(text(value.url, 2048)) }
        case 'group': return { type, style: option(value.style, styles), blocks: children(value.blocks) }
        case 'collapsible': return { type, summary: text(value.summary, 160), blocks: children(value.blocks),
          actionLabel: value.actionLabel === undefined ? undefined : text(value.actionLabel, 80),
          expandLabel: value.expandLabel === undefined ? undefined : text(value.expandLabel, 80),
          collapseLabel: value.collapseLabel === undefined ? undefined : text(value.collapseLabel, 80),
          defaultVisible: option(value.defaultVisible, [true, false]) ?? false }
        case 'copy': return { type, text: text(value.text, 4096), label: value.label === undefined ? '复制' : text(value.label, 80) }
      }
    })
  }
  object(args, ['title', 'blocks'])
  const normalized = { title: args.title === undefined ? undefined : text(args.title, 160), blocks: blocks(args.blocks) }
  if (sensitive(allText.join(''))) fail('display_card_sensitive_content')
  return normalized
}

// TextBlock/FactSet parse Markdown. All author text is literal; only link blocks can create navigation actions.
const literal = value => value.replace(/[\\[\]<>*_`~]/g, '\\$&')
const textBlock = (text, extra = {}) => ({ type: 'TextBlock', text: literal(text), wrap: true, ...extra })
const rendered = (elements, plain) => ({ elements, plain })
function build(args, profile) {
  const elements = new Set(profile.elements ?? ['TextBlock'])
  const actions = new Set(profile.actions ?? [])
  const fallbacks = new Set()
  let uid = 0
  const can = (block, ...types) => {
    const supported = types.every(type => (type.startsWith('Action.') ? actions : elements).has(type))
    if (!supported) fallbacks.add(block)
    return supported
  }
  const renderBlocks = blocks => {
    const items = blocks.map(renderBlock)
    return rendered(items.flatMap(item => item.elements), items.map(item => item.plain).join('\n'))
  }
  function renderBlock(block) {
    switch (block.type) {
      case 'heading': return rendered([textBlock(block.text, { weight: 'Bolder',
        ...(block.size && { size: block.size === 'large' ? 'Large' : 'Medium' }) })], block.text)
      case 'text': return rendered([textBlock(block.text)], block.text)
      case 'rich': {
        const plain = block.segments.map(segment => segment.text).join('')
        return rendered(can('rich', 'RichTextBlock') ? [{ type: 'RichTextBlock', inlines: block.segments.map(segment => ({
          type: 'TextRun', text: segment.text, ...(segment.bold && { weight: 'Bolder' }),
          ...(segment.subtle && { isSubtle: true }), ...(segment.fontType && { fontType: segment.fontType }),
          ...(segment.color && { color: segment.color }),
        })) }] : [textBlock(plain)], plain)
      }
      case 'facts': {
        const plain = block.items.map(item => item.label + '：' + item.value).join('\n')
        return rendered(can('facts', 'FactSet') ? [{ type: 'FactSet', facts: block.items.map(item =>
          ({ title: literal(item.label), value: literal(item.value) })) }] : [textBlock(plain)], plain)
      }
      case 'columns': {
        const columns = block.columns.map(column => renderBlocks(column.blocks))
        const plain = columns.map(column => column.plain).join('\n|\n')
        return rendered(can('columns', 'ColumnSet') ? [{ type: 'ColumnSet', columns: columns.map(column =>
          ({ type: 'Column', width: 'stretch', items: column.elements })) }] : [textBlock(plain)], plain)
      }
      case 'table': {
        const rows = block.rows.map(row => row.cells.map(cell => cell.blocks ? renderBlocks(cell.blocks)
          : rendered([textBlock(cell.text)], cell.text)))
        const plain = rows.map(row => row.map(cell => cell.plain).join(' | ')).join('\n')
        return rendered(can('table', 'Table') ? [{ type: 'Table', columns: block.columns,
          firstRowAsHeader: block.firstRowAsHeader, rows: rows.map(row => ({ type: 'TableRow', cells: row.map(cell =>
            ({ type: 'TableCell', items: cell.elements })) })) }] : [textBlock(plain)], plain)
      }
      case 'link': {
        const plain = block.text + '：' + block.url
        return rendered(can('link', 'ActionSet', 'Action.OpenUrl') ? [{ type: 'ActionSet', actions: [
          { type: 'Action.OpenUrl', title: block.text, url: block.url },
        ] }] : [textBlock(plain)], plain)
      }
      case 'group': {
        const inner = renderBlocks(block.blocks)
        return rendered(can('group', 'Container') ? [{ type: 'Container', items: inner.elements,
          ...(block.style && { style: block.style }) }] : inner.elements, inner.plain)
      }
      case 'collapsible': {
        const inner = renderBlocks(block.blocks)
        const plain = block.summary + '\n' + inner.plain
        if (!can('collapsible', 'Container', 'ColumnSet', 'ActionSet', 'Action.ToggleVisibility')) {
          return rendered([textBlock(block.summary, { weight: 'Bolder' }), ...inner.elements], plain)
        }
        const detailId = 'dsh_display_detail_' + uid++
        const expandId = 'dsh_display_expand_' + uid++
        const collapseId = 'dsh_display_collapse_' + uid++
        const toggle = (id, visible, title, expanded) => ({ type: 'ActionSet', id, isVisible: visible,
          actions: [{ type: 'Action.ToggleVisibility', title, targetElements: [
            { elementId: detailId, isVisible: expanded }, { elementId: expandId, isVisible: !expanded },
            { elementId: collapseId, isVisible: expanded },
          ] }] })
        return rendered([{ type: 'ColumnSet', columns: [
          { type: 'Column', width: 'stretch', items: [textBlock(block.summary, { weight: 'Bolder' })] },
          { type: 'Column', width: 'auto', items: [
            toggle(expandId, !block.defaultVisible, block.expandLabel ?? block.actionLabel ?? '展开', true),
            toggle(collapseId, block.defaultVisible, block.collapseLabel ?? '收起', false),
          ] },
        ] }, { type: 'Container', id: detailId, isVisible: block.defaultVisible, items: inner.elements }], plain)
      }
      case 'copy': return rendered(can('copy', 'ActionSet', 'Action.CopyToClipboard') ? [
        textBlock(block.text), { type: 'ActionSet', actions: [{ type: 'Action.CopyToClipboard', title: block.label, text: block.text }] },
      ] : [textBlock(block.text)], block.text)
    }
  }
  const content = renderBlocks(args.blocks)
  const body = [...(args.title ? [textBlock(args.title, { weight: 'Bolder' })] : []), ...content.elements]
  return { frame: { profile: 'octo/v1', card_version: version,
    card: { type: 'AdaptiveCard', version, body }, plain: [args.title, content.plain].filter(Boolean).join('\n') }, fallbacks }
}

// Upstream's conservative node/depth accounting includes rows, cells, facts, inlines and local actions.
function dimensions(value, depth = -1) {
  if (Array.isArray(value)) return value.map(item => dimensions(item, depth)).reduce((a, b) =>
    ({ nodes: a.nodes + b.nodes, depth: Math.max(a.depth, b.depth) }), { nodes: 0, depth })
  if (!value || typeof value !== 'object') return { nodes: 0, depth }
  const children = dimensions(Object.values(value), depth + 1)
  return { nodes: (depth === -1 ? 0 : 1) + children.nodes, depth: children.depth }
}
function capabilities(profile) {
  if (![true, 1].includes(profile?.enabled) || profile.available === false
    || profile.config?.card_enabled !== true || profile.config.display_enabled !== true
    || profile.card_version !== version || !Array.isArray(profile.profiles) || !profile.profiles.includes('octo/v1')
    || (profile.elements !== undefined && (!Array.isArray(profile.elements) || !profile.elements.includes('TextBlock')))
    || (profile.actions !== undefined && !Array.isArray(profile.actions))
    || (profile.limits !== undefined && !record(profile.limits))) fail('display_card_unavailable')
  const limits = { max_nodes: 200, max_depth: 16, max_payload_bytes: maxPayloadBytes }
  for (const key of Object.keys(limits)) {
    const value = profile.limits?.[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value <= 0) fail('display_card_unavailable')
    limits[key] = Math.min(value, limits[key])
  }
  return limits
}
function fits(frame, limits) {
  const size = dimensions(frame.card)
  return size.nodes <= limits.max_nodes && size.depth <= limits.max_depth
    && bytes(JSON.stringify({ type: 17, ...frame })) <= limits.max_payload_bytes
}

/** Validate and detach model arguments synchronously, before any asynchronous work. */
export function normalizeDisplayCard(args) { return normalize(args) }

/** Pure construction shared by sends and edits; no transport or raw action input. */
export function renderDisplayCard(normalized, profile) {
  const limits = capabilities(profile)
  const { frame, fallbacks } = build(normalized, profile)
  if (!fits(frame, limits)) {
    // Preserve every accepted character instead of dropping rows, children or copy data.
    frame.card.body = [textBlock(frame.plain)]
    fallbacks.add('limits')
    if (!fits(frame, limits)) fail('display_card_limits_exceeded')
  }
  return { frame, fallbacks }
}

// A source card is intentionally restricted to our display construction subset.
// Unknown metadata/fields are NOT evidence of a display card. In particular, the
// server allows raw v1/v2 edits, but this tool must never take over managed cards.
// octo-server f984d405: pkg/cardmsg/{profiles,provenance,interactive}.go;
// modules/bot_api/send.go: raw edits reject Registry markers on the original.
export function assertEditableDisplayCard(payload) {
  const reject = () => fail('display_card_message_required')
  if (!shape(payload, ['type', 'profile', 'card_version', 'card', 'plain', 'render_profile', 'space_id', 'visibles'])
    || payload.type !== 17 || payload.profile !== 'octo/v1' || payload.card_version !== version
    || payload.render_profile !== undefined && payload.render_profile !== 'octo-chat/v1'
    || !shape(payload.card, ['type', 'version', 'body']) || payload.card.type !== 'AdaptiveCard'
    || payload.card.version !== version || !Array.isArray(payload.card.body) || !payload.card.body.length
    || payload.card.body.some(item => !record(item) || typeof item.type !== 'string')
    || payload.plain !== undefined && typeof payload.plain !== 'string') reject()
  const fields = {
    TextBlock: ['text', 'wrap', 'weight', 'size'], RichTextBlock: ['inlines'],
    TextRun: ['text', 'weight', 'isSubtle', 'fontType', 'color'], FactSet: ['facts'],
    ColumnSet: ['columns'], Column: ['width', 'items'], Table: ['columns', 'firstRowAsHeader', 'rows'],
    TableRow: ['cells'], TableCell: ['items'], Container: ['items', 'style', 'id', 'isVisible'],
    ActionSet: ['actions', 'id', 'isVisible'], 'Action.OpenUrl': ['title', 'url'],
    'Action.ToggleVisibility': ['title', 'targetElements'], 'Action.CopyToClipboard': ['title', 'text'],
  }
  let nodes = 0, size = 0
  const walk = (value, depth = 0) => {
    if (depth > 24 || ++nodes > 2000) reject()
    if (typeof value === 'string') {
      size += bytes(value)
      // Legacy progress/question display frames have no template provenance.
      if (size > maxPayloadBytes || /DSH (?:回复进度|等待你的回答|等待你的批准|提问回执)/u.test(value)) reject()
    } else if (Array.isArray(value)) {
      if (value.length > 200) reject()
      for (const item of value) walk(item, depth + 1)
    } else if (value && typeof value === 'object') {
      const keys = value.type === undefined ? ['title', 'value', 'width', 'elementId', 'isVisible']
        : Object.hasOwn(fields, value.type) ? fields[value.type] : undefined
      if (!keys || !shape(value, value.type === undefined ? keys : ['type', ...keys])) reject()
      for (const item of Object.values(value)) walk(item, depth + 1)
    } else if (value !== null && !['number', 'boolean'].includes(typeof value)) reject()
  }
  walk(payload.card.body)
  if (payload.plain !== undefined) walk(payload.plain)
}

/** Safe public-image URLs and text for type-14 edits; never fetches media. */
export function normalizeRichtextBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 20) fail('invalid_richtext')
  let total = 0
  const texts = []
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max || !value.trim() || control.test(value)
      || bytes(value) > max || (total += bytes(value)) > maxContentBytes) fail('invalid_richtext')
    safeContent(value)
    texts.push(value)
    return value
  }
  const content = Array.from(blocks, block => {
    if (shape(block, ['type', 'text']) && block.type === 'text') return { type: 'text', text: text(block.text, 4000) }
    if (!shape(block, ['type', 'url', 'width', 'height', 'name', 'size']) || block.type !== 'image'
      || ![block.width, block.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384)
      || block.size !== undefined && (!Number.isSafeInteger(block.size) || block.size < 0 || block.size > 20 * 1024 * 1024)) fail('invalid_richtext')
    return { type: 'image', url: safeUrl(text(block.url, 2048)), width: block.width, height: block.height,
      ...(block.name !== undefined && { name: text(block.name, 160) }), ...(block.size !== undefined && { size: block.size }) }
  })
  if (sensitive(texts.join(''))) fail('display_card_sensitive_content')
  if (bytes(JSON.stringify({ type: 14, content })) > maxPayloadBytes) fail('invalid_richtext')
  return content
}

/**
 * Parent binds an authenticated OctoClient and an already admitted current route
 * {channel_id, channel_type: 1|2|5}, and rechecks tool authority before calling.
 * No argument chooses that route, an account, OBO identity or server-owned fields.
 * Returns only {messageId, format, fallbackBlocks, requiresFinalSummary} after a
 * confirmed send. Never retries an uncertain write or substitutes a second send.
 */
export async function sendDisplayCard({ api, route, args, signal, authorize } = {}) {
  if (!shape(route, ['channel_id', 'channel_type']) || !(route.channel_type === 1
    ? validUid(route.channel_id) && !route.channel_id.includes('@') : ruleScope(route.channel_type, route.channel_id))) {
    fail('invalid_display_card_route')
  }
  if (typeof api?.cardProfile !== 'function' || typeof api.progressCard !== 'function'
    || (signal !== undefined && !(signal instanceof AbortSignal))
    || (authorize !== undefined && typeof authorize !== 'function')) fail('invalid_display_card_context')
  // Detach both route and structured input before any await; concurrent caller edits cannot redirect a send.
  const target = { channel_id: route.channel_id, channel_type: route.channel_type }
  const normalized = normalize(args)
  const budget = AbortSignal.timeout(15_000)
  const active = signal ? AbortSignal.any([signal, budget]) : budget
  if (active.aborted) fail('display_card_aborted')
  if (authorize && await authorize(active) !== true) fail('octo_access_denied')
  if (active.aborted) fail('display_card_aborted')
  let profile
  try { profile = await api.cardProfile(active) } catch {
    fail(active.aborted ? 'display_card_aborted' : 'display_card_probe_failed')
  }
  if (active.aborted) fail('display_card_aborted')
  const { frame, fallbacks } = renderDisplayCard(normalized, profile)
  if (authorize && await authorize(active) !== true) fail('octo_access_denied')
  if (active.aborted) fail('display_card_aborted')
  let messageId
  try { messageId = await api.progressCard(target, frame, active) } catch (error) {
    // No exception message, response body, stack, cancellation reason or credential leaves this helper.
    // The official legacy facade can wrap a post-dispatch send_failed (500)
    // as HTTP 400. Its authenticated classification must override the wire
    // status; an uncertain card may already exist and must not be resent.
    if (error instanceof OctoError && ['api_invalid_request', 'api_authentication_failed', 'api_permission_denied',
      'api_not_found', 'api_method_not_allowed', 'api_conflict', 'api_rate_limited', 'api_disabled', 'api_unsupported']
      .includes(apiErrorCode(error))) fail('display_card_refused')
    fail('display_card_delivery_unconfirmed')
  }
  const confirmed = decimalId(messageId)
  if (!confirmed) fail('display_card_delivery_unconfirmed')
  return { messageId: confirmed, format: 'display_card', fallbackBlocks: [...fallbacks], requiresFinalSummary: true }
}
