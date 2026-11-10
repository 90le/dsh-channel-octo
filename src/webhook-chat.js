import { randomUUID } from 'node:crypto'
import { validBotIdentity, validToken, validUid } from './config.js'
import { permitsRoute } from './octo.js'
import { administerWebhooks } from './webhook-admin.js'
import { isChatWebhookId, isChatWebhookName } from './webhook-chat-command.js'

const ttl = 5 * 60_000
const maxPending = 128
const maxPerAccount = 8
const proposalId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const accountId = value => value === 'legacy' || typeof value === 'string' && proposalId.test(value)
const fail = code => { throw new Error(code) }
const unavailable = () => fail('webhook_proposal_unavailable')
const actions = new Set(['chat_pending', 'chat_approve', 'chat_cancel'])
export const isWebhookChatAction = action => actions.has(action)

export function validateWebhookChatInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !actions.has(input.action)
    || typeof input.revision !== 'string' || !input.revision.length || input.revision.length > 128) fail('invalid_webhook_request')
  const keys = ['action', 'revision']
  if (input.action !== 'chat_pending') {
    keys.push('proposalId')
    if (typeof input.proposalId !== 'string' || !proposalId.test(input.proposalId)) fail('invalid_webhook_request')
  }
  if (input.action === 'chat_approve') {
    keys.push('confirmed')
    if (input.confirmed !== true) fail('invalid_webhook_request')
  }
  if (Object.keys(input).some(key => !keys.includes(key))) fail('invalid_webhook_request')
}

function active(context) {
  try { return context.signal instanceof AbortSignal && !context.signal.aborted && context.isActive?.() === true } catch { return false }
}

function ownerAllowed(context, ownerUid, route) {
  const { record, identity, config, token } = context
  const endpoint = URL.parse(context.apiBase)
  return active(context) && endpoint?.protocol === 'https:' && accountId(record?.id)
    && typeof context.revision === 'string' && context.revision.length > 0
    && record.enabled === true && validBotIdentity(record) && record.botKind !== 'app'
    && validToken(token) && token.startsWith('bf_')
    && validUid(ownerUid) && ownerUid !== record.botUid && identity?.ownerUid === ownerUid
    && identity.botUid === record.botUid && identity.spaceId === record.spaceId && identity.botKind !== 'app'
    && config?.ownerUid === ownerUid && config.botUid === record.botUid && config.spaceId === record.spaceId
    && config.botKind !== 'app' && config.groupCommands === 'safe' && typeof config.toolPermission === 'string'
    && !['', 'text-only', 'read-only'].includes(config.toolPermission)
    && (route.type === 2 || route.type === 5) && permitsRoute(config, ownerUid, route.type, route.address)
}

// One instance per Accounts host. The map contains only approval facts and
// safe previews; secret-bearing responses are never cached or shared.
export function createWebhookChat({ now = Date.now } = {}) {
  const pending = new Map(), preparing = new Set()
  const prune = context => {
    for (const [id, item] of pending) {
      if (item.preview.expiresAt <= now() || item.accountId === context.record.id
        && (item.revision !== context.revision || item.ownerUid !== context.identity?.ownerUid
          || item.settingsRevision !== context.settingsRevision || item.botUid !== context.record.botUid
          || item.spaceId !== context.record.spaceId)) pending.delete(id)
    }
  }
  const isFresh = sentAt => Number.isSafeInteger(sentAt) && sentAt > 0
    && sentAt * 1000 >= now() - 120_000 && sentAt * 1000 <= now() + 30_000

  return Object.freeze({
    // The worker calls this only for a durably deduplicated live inbound plain
    // message, never history, delayed intake, a model tool or a form callback.
    async propose(context, message, { live } = {}) {
      const command = message?.webhookChat
      const ownerUid = message?.sender
      const route = { type: message?.channelType, address: message?.channelId }
      if (live !== true || message?.ambient !== false || !isFresh(message.webhookSentAt)
        || command?.kind !== 'request' || !ownerAllowed(context, ownerUid, route)) return { status: 'ignored' }
      const action = command.action, name = command.name, webhookId = command.webhookId
      if (!(action === 'create' && isChatWebhookName(name) && webhookId === undefined
        || action === 'regenerate' && isChatWebhookId(webhookId) && name === undefined)) return { status: 'ignored' }
      const { record, revision } = context
      const key = JSON.stringify([action, route.type, route.address, name ?? webhookId])
      prune(context)
      const own = [...pending.values()].filter(item => item.accountId === record.id)
      if (own.some(item => item.key === key)) return { status: 'pending' }
      if (preparing.has(record.id) || pending.size + preparing.size >= maxPending || own.length >= maxPerAccount) return { status: 'unavailable' }
      preparing.add(record.id)
      try {
        const { webhook } = await administerWebhooks(context, { action: 'list', route }, { ownerUid, selected: webhookId })
        if (!isFresh(message.webhookSentAt) || !ownerAllowed(context, ownerUid, route)) return { status: 'ignored' }
        const id = randomUUID()
        const display = name ?? (isChatWebhookName(webhook?.name) ? webhook.name : undefined)
        pending.set(id, { accountId: record.id, botUid: record.botUid, spaceId: record.spaceId, revision, settingsRevision: context.settingsRevision, ownerUid, key,
          version: webhook?.version, preview: { id, action, route, ...(display !== undefined && { name: display }),
            ...(webhookId && { webhookId }), expiresAt: now() + ttl } })
        return { status: 'pending' }
      } catch { return { status: 'unavailable' } }
      finally { preparing.delete(record.id) }
    },

    // Only from the authenticated, CSRF-checked accounts endpoint, under its
    // ordinary account lock. isActive must recheck the host session and
    // account revision immediately before the upstream write.
    async manage(context, input) {
      validateWebhookChatInput(input)
      if (!active(context) || !accountId(context.record?.id) || input.revision !== context.revision) unavailable()
      prune(context)
      const { id: account } = context.record
      if (input.action === 'chat_pending') {
        return { proposals: [...pending.values()].filter(item => item.accountId === account
          && ownerAllowed(context, item.ownerUid, item.preview.route)).map(item => structuredClone(item.preview)) }
      }
      const item = pending.get(input.proposalId)
      if (!item || item.accountId !== account) unavailable()
      if (input.action === 'chat_cancel') {
        pending.delete(input.proposalId)
        return { cancelled: true }
      }
      const { action, route, name, webhookId, expiresAt } = item.preview
      if (!ownerAllowed(context, item.ownerUid, route)) unavailable()
      // Consume before any await. A rejected, aborted, ambiguous or repeated
      // confirmation can never execute this proposal again.
      pending.delete(input.proposalId)
      const result = await administerWebhooks(context, action === 'create'
        ? { action, route, changes: { name, allow_mention_all: false, allow_mention_bots: false, mention_uids: [] } }
        : { action, route, webhookId, expected: item.version, confirmed: true },
      { ownerUid: item.ownerUid, canWrite: () => expiresAt > now() && ownerAllowed(context, item.ownerUid, route) })
      if (!active(context)) fail('webhook_outcome_unknown')
      return { webhook: { webhook_id: result.webhook.webhook_id }, secret: result.secret }
    },
  })
}
