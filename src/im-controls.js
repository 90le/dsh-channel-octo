export const DEFAULT_IM_CONTROLS = Object.freeze({
  sendMode: 'queue',
  dmCommands: 'off',
  groupCommands: 'off',
  allowFiles: false,
})

// Accept only explicit opt-ins. Old, partial, and malformed account records
// can be read without granting a capability or mutating the saved record.
export function normalizeImControls(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_IM_CONTROLS }
  const field = key => Object.hasOwn(input, key) ? input[key] : undefined
  return {
    sendMode: field('sendMode') === 'steer' ? 'steer' : 'queue',
    dmCommands: field('dmCommands') === 'safe' ? 'safe' : 'off',
    groupCommands: field('groupCommands') === 'safe' ? 'safe' : 'off',
    allowFiles: field('allowFiles') === true,
  }
}

const safeCommands = new Set(['help', 'status', 'new', 'stop'])
const reservedPathPrefixes = new Set([...safeCommands, 'webhook', 'shell', 'exec', 'reset', 'card', 'choose'])
const absolutePathPrefix = /^\/([\p{L}\p{N}\p{M}._~+%-]+)\/(?=[\p{L}\p{N}\p{M}._~+%@-])/u
export const OCTO_STOP = new Error('octo_user_stop')
const mentionPrefix = /^(?:@\[[^\]\r\n]+\]|[@＠]\S+)\s+/u
const structuredMention = /^@\[([\w.-]+):[^\]\r\n]+\]$/u
const invisible = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/gu

function targetsOnlyBot(botUid, mention) {
  return typeof botUid === 'string' && botUid.length > 0 && Array.isArray(mention?.uids)
    && mention.uids.length === 1 && mention.uids[0] === botUid
    && [mention.all, mention.ais, mention.humans].every(value => value == null || value === false || value === 0)
}

/**
 * Classify native inbound text: { kind: 'text' }, { kind: 'blocked' }, or
 * { kind: 'command', command: 'help' | 'status' | 'new' | 'stop' }. Only 'text' may
 * enter the agent prompt path. The parser never executes a command.
 *
 * The caller supplies routeAllowed and actorApproved from the current
 * account's admission and command approval checks, never from the payload.
 * Synthetic events are not allowed routes. For groups/topics, isBotOwner
 * comes from verified account identity and mention is authenticated Octo
 * metadata (not a guess from the display text). Recheck policy at execution.
 */
export function parseSafeCommand(text, controls, route) {
  if (typeof text !== 'string') return { kind: 'blocked' }
  // Detect an obfuscated slash intent without accepting it as a command.
  const visible = text.replace(invisible, char => /\s/u.test(char) ? ' ' : '')
  let body = visible.trim()
  let prefix, count = 0
  for (let match; (match = mentionPrefix.exec(body));) {
    if (++count === 1) prefix = match[0].trimEnd()
    body = body.slice(match[0].length)
  }
  if (!body.startsWith('/')) return { kind: 'text' }

  // A nested POSIX path at the start of a message is normal conversation.
  // Keep malformed variants of reserved slash commands out of the prompt.
  const path = absolutePathPrefix.exec(body)
  if (path && count <= 1 && visible === text.replace(/\r?\n/g, newline => ' '.repeat(newline.length))
    && !reservedPathPrefixes.has(path[1].toLowerCase())) return { kind: 'text' }

  const blocked = { kind: 'blocked' }
  // A whole, single-line command only: no arguments, continuations, or
  // invisible characters. The positive grammar is deliberately ASCII.
  if (visible !== text) return blocked
  const command = body.slice(1).toLowerCase()
  if (!/^\/[A-Za-z]+$/u.test(body) || !safeCommands.has(command) || count > 1
    || route?.routeAllowed !== true || route.actorApproved !== true
    || (route.hasAttachments != null && route.hasAttachments !== false)) return blocked

  const { dmCommands, groupCommands } = normalizeImControls(controls)
  if (route.channelType === 1) {
    if (dmCommands !== 'safe' || count) return blocked
  } else if (route.channelType === 2 || route.channelType === 5) {
    if (groupCommands !== 'safe' || route.isBotOwner !== true || !targetsOnlyBot(route.botUid, route.mention)) return blocked
    // Display names are presentation only. A structured prefix that carries
    // a UID must agree with the separately authenticated mention target.
    if (prefix && /^[@＠]\[/u.test(prefix) && structuredMention.exec(prefix)?.[1] !== route.botUid) return blocked
  } else return blocked
  return { kind: 'command', command }
}
