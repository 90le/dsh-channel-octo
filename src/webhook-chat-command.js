import { ruleScope } from './rules.js'

const control = /[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/u
const webhookId = /^iwh_[a-f0-9]{32}$/
export const isChatWebhookId = value => typeof value === 'string' && webhookId.test(value)
export const isChatWebhookName = value => typeof value === 'string' && value === value.trim()
  && Buffer.byteLength(value) <= 64 && /^[\p{L}\p{M}\p{N}_(). -]+$/u.test(value)
  && !/[a-f0-9]{64}|\b(?:bf|app)_[a-z0-9_-]+/i.test(value)

// Call on the original plain-text payload, after normal Octo route and mention
// admission. A reserved but invalid command must never reach the agent or store.
export function parseWebhookChatCommand(text, { config, sender, channelType, channelId, mention, plain } = {}) {
  if (typeof text !== 'string') return
  let body = text.trim(), prefix
  const entity = mention?.entities?.length === 1 && mention.entities[0]
  if (/^[@＠]/u.test(text) && entity?.uid === config?.botUid && entity?.offset === 0
    && Number.isSafeInteger(entity.length) && entity.length > 1 && entity.length <= 256
    && text.slice(entity.length, entity.length + 1) === ' ') {
    prefix = text.slice(0, entity.length)
    body = text.slice(entity.length).trim()
  } else {
    const match = /^(@\[[^\]\r\n]+\]|[@＠][^\s/]+) +/u.exec(body)
    if (match) { prefix = match[1]; body = body.slice(match[0].length) }
  }
  if (!/^\/webhook(?:\s|$)/iu.test(body)) return
  const blocked = { kind: 'blocked' }
  if (plain !== true || text.length > 512 || control.test(text) || config?.botKind === 'app'
    || config?.groupCommands !== 'safe' || !sender || sender !== config.ownerUid || sender === config.botUid
    || !ruleScope(channelType, channelId) || !Array.isArray(mention?.uids) || mention.uids.length !== 1 || mention.uids[0] !== config.botUid
    || [mention.all, mention.ais, mention.humans].some(flag => flag != null && flag !== false && flag !== 0)
    || prefix?.startsWith('@[') && (!prefix.startsWith('@[' + config.botUid + ':') || !prefix.endsWith(']'))) return blocked
  const match = /^\/webhook +(create|rotate) +(.+)$/iu.exec(body)
  if (!match) return blocked
  const [, verb, value] = match
  if (verb.toLowerCase() === 'create' && isChatWebhookName(value)) return { kind: 'request', action: 'create', name: value }
  if (verb.toLowerCase() === 'rotate' && isChatWebhookId(value)) return { kind: 'request', action: 'regenerate', webhookId: value }
  return blocked
}

export const webhookChatReceipt = '已登记 Webhook 请求，尚未执行。请在 5 分钟内打开 DSH → Octo 账号设置 → 管理 Webhook → 聊天请求，核对目标后确认。'
