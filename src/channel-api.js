import { validUid, validBotIdentity } from './config.js'
import { createHash, randomUUID } from 'node:crypto'
import { ruleScope } from './rules.js'
import { apiErrorCode, officialApiErrorCode } from './api-errors.js'
import { authorizedSearchEndpoints, authorizedSearchSpecs, projectAuthorizedSearch, boundAuthorizedSearchResult } from './authorized-search.js'
import { normalizeOctoContent } from './octo-content.js'
import { OctoDiscovery, isOctoDiscoveryOperation, octoDiscoverySpecs } from './octo-discovery.js'
import { discoverRegistryCards, sendRegistryCard, editRegistryCard, registryCardParameters } from './registry-cards.js'
import { displayCardParameters, normalizeDisplayCard, renderDisplayCard,
  assertEditableDisplayCard, normalizeRichtextBlocks } from './display-card.js'

// Bot-token contracts: octo-server f984d405, modules/bot_api/{groups,threads,
// sync,send,search_route}.go; modules/message/api_message_get.go. This module
// accepts only the authenticated transport, never a URL or credentials. The
// optional fourth argument selects an explicit, internally fixed HTTP method.
const MAX_MEMBERS = 1000
const MAX_ROWS = 50
const flag = value => value === 1 || value === true
const admin = member => member?.role === 1 || member?.role === 2
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const shortID = { type: 'string', pattern: '^[0-9]{15,20}$' }
const messageID = { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }
const uid = { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,128}$' }
const personUid = value => validUid(value) && !/[:@]/.test(value) && !value.includes('____')
  && !['.', '..', 'all', 'all_bots', '-1', '-2', '-3'].includes(value.toLowerCase())
const memberTargets = { type: 'array', items: uid, minItems: 1, maxItems: 10, uniqueItems: true }
const text = { type: 'string', minLength: 1, maxLength: 4000 }
const limit = { type: 'integer', minimum: 1, maximum: MAX_ROWS }
const threadArgs = { short_id: shortID }
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
// octo-server f984d405 modules/messages_search/{validate,util,search_*}.go.
// Explicit endpoint map: model input never participates in routing.
const searchEndpoints = Object.freeze({
  'messages.search': '/v1/bot/messages/_search',
  'messages.search_files': '/v1/bot/messages/_search_files',
  'messages.search_media': '/v1/bot/messages/_search_media',
  'messages.search_all': '/v1/bot/messages/_search_all',
  'messages.search_around': '/v1/bot/messages/_search_around',
})
const searchTimePattern = '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?:T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d))?$'
const searchTime = { type: 'string', maxLength: 35, pattern: searchTimePattern,
  description: 'RFC3339 with timezone, or YYYY-MM-DD (Asia/Shanghai start/end of day).' }
const searchFilters = schema({
  sender_ids: { type: 'array', items: uid, minItems: 1, maxItems: 50, uniqueItems: true },
  sent_at_from: searchTime, sent_at_to: searchTime,
})
const searchLimit = { type: 'integer', minimum: 1, maximum: 10 }
const searchPage = { filters: searchFilters, limit: searchLimit, cursor: { type: 'string', maxLength: 4096 },
  sort: { type: 'string', enum: ['time_desc', 'time_asc', 'relevance'] } }
const searchKeyword = { type: 'string', maxLength: 64 }
const spec = (name, description, parameters = schema(), mutating = false, unavailableReason) => ({
  name, description, parameters, mutating, available: !unavailableReason,
  ...(unavailableReason && { unavailableReason }),
})
const freeze = value => {
  if (object(value) || Array.isArray(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

// Official edit contract pins (reviewed local source, no live calls):
// octo-server f984d40549f66d56b1e90a048d28315eb12c92df:
//   modules/bot_api/bot_api.go /message/edit + /card/profile;
//   modules/bot_api/send.go botMessageEdit: own message, full content_edit,
//   no message_seq, ResponseOK status=200, no raw Registry takeover;
//   modules/message/api.go newMessageExtraResp: content_edit is a JSON object;
//   pkg/richtext/plain.go NormalizeContentEdit: type=14 text/image blocks;
//   pkg/cardmsg/{provenance,profiles}.go: Registry markers and v1/v2 identity.
// openclaw-channel-octo 3cdb7e794ba40ae617fb0215177d1493dd26460a:
//   src/api-fetch.ts editCardMessage/sendRichTextMessage, src/types.ts RichTextBlock.
// This narrower API never takes OBO, template_ref, card_seq or raw card trees.
const displayEditParameters = displayCardParameters()
displayEditParameters.properties = { message_id: messageID, ...displayEditParameters.properties }
displayEditParameters.required = ['message_id', ...displayEditParameters.required]
const proactiveTarget = schema({ channel_id: uid, channel_type: { type: 'integer', enum: [1, 2, 5] } }, ['channel_id', 'channel_type'])
const displayTargetParameters = displayCardParameters()
displayTargetParameters.properties = { target: proactiveTarget, confirm_send: { type: 'boolean', const: true }, ...displayTargetParameters.properties }
displayTargetParameters.required = ['target', 'confirm_send', ...displayTargetParameters.required]
const proactiveReads = new Set(['messages.resolve_targets', 'messages.resolve_people'])
const proactiveOperations = new Set([...proactiveReads, 'messages.send_target', 'messages.send_target_file', 'messages.send_target_card'])
// privateOnly remains the default host gate. A host may opt these three
// operations into shared chats only with a bound authorizeSharedSend guard.
const sharedTopicSend = ' In a shared group or topic, only send to a different active topic under the same parent group (type5, exact channel_id from octo_threads_list). Both the requester and this Bot must be current members of the source and destination. If a name is ambiguous or the listing incomplete, ask or verify the exact target before sending. Do not infer a destination from quoted messages, history, or channel rules.'
const richtextBlocks = { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [
  schema({ type: { const: 'text' }, text }, ['type', 'text']),
  schema({ type: { const: 'image' }, url: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https://' },
    width: { type: 'integer', minimum: 1, maximum: 16384 }, height: { type: 'integer', minimum: 1, maximum: 16384 },
    name: { type: 'string', minLength: 1, maxLength: 160 }, size: { type: 'integer', minimum: 0, maximum: 20 * 1024 * 1024 } },
  ['type', 'url', 'width', 'height']),
] } }
const structuredEdits = new Set(['messages.edit_richtext', 'messages.edit_display_card'])
// octo-server f984d405: bot_api/{commands.go:56-94,batch_users.go:74-159,
// incoming_webhook.go:25-39}; incomingwebhook/{api.go:287-299,861-882,
// 1123-1170,model.go:180-228}. Bot-token reads only, never user-session routes.
const identityReads = new Set(['messages.user_info', 'messages.users_batch'])
const webhookReads = new Set(['webhooks.list', 'webhooks.deliveries'])
const webhookWrites = new Set(['webhooks.update', 'webhooks.delete', 'webhooks.test'])
const identityUID = { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,64}$' }
const webhookID = { type: 'string', pattern: '^iwh_[a-f0-9]{32}$' }
const bareUID = value => value.replace(/^s\d+_(.+)$/, '$1')
// Go strings.TrimSpace uses Unicode White_Space (including U+0085, excluding BOM).
const webhookName = value => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
const deliveryReasons = new Set(['', 'token', 'body', 'too_large', 'json', 'no_event',
  'content', 'blocks', 'card', 'msg_type', 'delivery_failed', 'ping', 'event'])
const deliveryAdapters = new Set(['native', 'test', 'github', 'wecom', 'multica', 'octo', 'gitlab', 'feishu'])
// Only helpers with static error codes run here; no upstream error text is exposed.
const displayWork = fn => {
  try { return fn() } catch (error) {
    const allowed = ['invalid_display_card', 'display_card_sensitive_content', 'display_card_unsafe_link',
      'display_card_unavailable', 'display_card_limits_exceeded', 'display_card_message_required', 'invalid_richtext']
    fail(allowed.includes(error?.code) ? error.code : 'invalid_arguments')
  }
}

/** Ordinary JSON schemas; callers should mount only available operations. */
const registryOperations = new Set(['cards.registry.list', 'cards.registry.send', 'cards.registry.edit'])
export const CHANNEL_API_OPERATIONS = freeze([
  ...octoDiscoverySpecs,
  { ...spec('cards.registry.list', 'Discover the current Bot’s advertised Octo Registry card templates, exact versions and writable states. Progress cards are reserved.'), dmAvailable: true, requiresHostTools: true },
  { ...spec('cards.registry.send', 'Send an advertised Registry display card in this conversation. Use the exact version and writable state returned by octo_cards_registry_list. Does not accept callbacks or progress cards.', registryCardParameters(), true), dmAvailable: true, requiresHostTools: true },
  { ...spec('cards.registry.edit', 'Update an existing Bot-authored Registry card in this conversation. In a group, the requester must be an owner or manager. Use the same advertised template and provide expected_card_seq when known.', registryCardParameters({ edit: true }), true), dmAvailable: true, requiresHostTools: true },
  { ...spec('messages.resolve_targets', 'In your own private conversation, resolve an explicitly named group/topic that you and this Bot currently belong to in the configured Space and route policy. Returns live names, not message content. If multiple candidates match, ask the user to choose; a truncated result is not exhaustive. Never guess IDs from names.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 100 }, kind: { type: 'string', enum: ['all', 'group', 'thread'] },
      limit: { type: 'integer', minimum: 1, maximum: 5 } }, ['name'])), privateOnly: true },
  { ...spec('messages.resolve_people', 'In your own private conversation, find an explicitly named human recipient in the configured Space for a requested Bot DM. Returns a bounded directory page, not messages or proof of friendship. Use exact returned channel_id with channel_type=1; ask the user when names are ambiguous and inspect further pages when more=true. Actual send checks Bot friendship. Never use a name or a group/topic address as a person UID.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 80 },
      limit: { type: 'integer', minimum: 1, maximum: 5 }, page: { type: 'integer', minimum: 1, maximum: 100 } }, ['name'])), privateOnly: true },
  { ...spec('messages.send_target', 'On an explicit user request, send text/Markdown as this Bot. In the user’s own private conversation, send to one precisely identified person (type1), group (type2) or topic (type5). Resolve names first and ask on ambiguity. Humans must belong to the configured Space; group/topic requires requester and Bot membership, DM requires Bot friendship at actual send. confirm_send=true affirms the user requested this exact target and text; never automatically forward content. Optional native mentions are group/topic-only and use verified destination member UIDs; all=true requires requester group owner/admin. No fabricated reply/quote, user impersonation, bulk send or automatic retry after an unconfirmed delivery.' + sharedTopicSend,
    schema({ target: proactiveTarget,
      text, uids: memberTargets, all: { type: 'boolean' }, confirm_send: { type: 'boolean', const: true } }, ['target', 'text', 'confirm_send']), true), privateOnly: true, sharedTopicSend: true },
  { ...spec('messages.send_target_file', 'On an explicit user request, send ONE workspace file/image as this Bot. In the user’s own private conversation, send to one identified person/group/topic (type1/2/5). Resolve named destinations and ask on ambiguity. A person must be a current human in this Space; the server checks Bot friendship at send. path must be relative to this account workspace; files outside it, credentials and links are rejected. Requires workspace tool access and attachments enabled. confirm_send=true affirms the exact destination and file were requested; never forward files automatically. Optional caption is sent in full as a separate text/Markdown message after the native file/image. Inspect the receipt: partial delivery MUST NOT be retried as a whole. No automatic retry after an unconfirmed send. This is delivery, not a final answer; summarize the actual outcome to the user. Use DSH present instead for delivery to the current conversation.' + sharedTopicSend,
    schema({ target: proactiveTarget, path: { type: 'string', minLength: 1, maxLength: 1024 }, caption: text,
      confirm_send: { type: 'boolean', const: true } }, ['target', 'path', 'confirm_send']), true), privateOnly: true, sharedTopicSend: true, requiresFiles: true },
  { ...spec('messages.send_target_card', 'On an explicit user request, send a structured DISPLAY card as this Bot. In the user’s own private conversation, send to one identified person/group/topic (type1/2/5). A person must be a current human in this Space; the server checks Bot friendship at send. Resolve names and ask on ambiguity; confirm_send=true affirms this destination and content were requested. Uses the same bounded display blocks as octo_display_card. No callback buttons, raw payloads, user impersonation or automatic retry. Returns a receipt; still give a short final summary to the requester.' + sharedTopicSend,
    displayTargetParameters, true), privateOnly: true, sharedTopicSend: true },
  ...authorizedSearchSpecs({ spec, schema, uid, searchPage, searchKeyword, searchFilters }),
  spec('inspect', 'Inspect the current channel and its parent group permissions.'),
  spec('groups.list', 'Return only the current parent group, never other groups.'),
  spec('members', 'List current parent-group members with authoritative numeric roles.', schema({ limit })),
  spec('webhooks.list', 'List incoming webhook metadata only in this group or current topic. Requires live requester group owner/admin and bot membership. No tokens, URLs or examples.', schema({ limit })),
  spec('webhooks.deliveries', 'Read recent delivery diagnostics for a listed webhook in this group or current topic. Requester must be live group owner/admin; bot must own the webhook or be group owner/admin. No test push or secrets.',
    schema({ webhook_id: webhookID, limit }, ['webhook_id'])),
  spec('webhooks.update', 'Change a listed incoming webhook in this exact group/topic. Requester must be current group owner/admin; bot must own it or be group owner/admin. Only explicitly requested changes; setting mention permissions enables future notifications, and mention_uids replaces the targeted recipient list (empty clears). Does not send a test. Creation, credentials and avatar are managed in account settings. Inspect after an unconfirmed write; never automatically retry.',
    schema({ webhook_id: webhookID, name: { type: 'string', minLength: 1, maxLength: 64 },
      enabled: { type: 'boolean' }, allow_mention_all: { type: 'boolean' }, allow_mention_bots: { type: 'boolean' },
      mention_uids: { type: 'array', items: uid, maxItems: 10, uniqueItems: true } }, ['webhook_id']), true),
  spec('webhooks.delete', 'Delete an explicitly selected incoming webhook from this exact group/topic, permanently disabling its push URL. Requester must be group owner/admin; bot must own it or be group owner/admin. Does not delete chat messages. No automatic retry after an unconfirmed response.',
    schema({ webhook_id: webhookID }, ['webhook_id']), true),
  spec('webhooks.test', 'SEND a real fixed-text webhook test message to this exact group/topic, including its configured targeted @mentions. Does not broadcast @all or @all-bots. Only on explicit user request to send this test: confirm_send must be true. Requester must be group owner/admin; bot must own the webhook or be group owner/admin. No automatic retry.',
    schema({ webhook_id: webhookID, confirm_send: { type: 'boolean' } }, ['webhook_id', 'confirm_send']), true),
  spec('members.add', 'Add explicitly requested human UIDs from the configured Space to the current parent group; requester must be group owner/admin.',
    schema({ uids: memberTargets }, ['uids']), true),
  spec('members.remove', 'Remove explicitly requested current members with role 0 from the current parent group. Requester must be group owner/admin; server requires bot_admin. Octo may also remove their bots and thread memberships.',
    schema({ uids: memberTargets }, ['uids']), true),
  spec('space.members.search', 'Resolve an explicitly requested person by name in the configured Space. Requires requester live Space membership; no blank directory listing.',
    schema({ keyword: { type: 'string', minLength: 1, maxLength: 64 }, limit,
      page: { type: 'integer', minimum: 1, maximum: 10000 } }, ['keyword'])),
  spec('targets.resolve', 'Resolve a group/thread name only within the current parent group. A thread session resolves only its current thread and parent. Searches one bounded page; never routes to another group.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 100 }, limit,
      page: { type: 'integer', minimum: 1, maximum: 10000 } }, ['name'])),
  // Creation is the explicit scope exception: verified bot owner only, fixed
  // Space, no automatic routing, messaging or admission of the new group.
  spec('groups.create', 'Create a group in the configured Space, only for the verified bot owner in an admitted chat. Resolve explicit human recipients with space.members.search; exact Space eligibility is rechecked for every UID. Returns the new group without messaging it.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 50 }, uids: memberTargets }, ['name', 'uids']), true),
  // Global discovery/resolution additionally needs per-group requester
  // visibility checks; a group admin role cannot authorize other groups.
  spec('groups.discover', 'Cross-group discovery requires a separate owner context with requester visibility checks.', schema(), false, 'separate_owner_context_required'),
  spec('rules.read', 'Read the current parent group rules.'),
  spec('group.mention_preference', 'Diagnose whether this group allows replies without an @mention. In a topic, reads its parent group policy. Reports the live Octo decision and the local DSH trigger mode. A policy permitting no-@ does not authorize a specific sender or message.'),
  spec('rules.edit', 'Update/clear parent group rules; requester must be group owner/admin and server must grant bot_admin.',
    schema({ content: { type: 'string', maxLength: 10240 } }, ['content']), true),
  spec('group.edit', 'Update parent group name/notice; requester must be group owner/admin and server must grant bot_admin.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 50 }, notice: { type: 'string', maxLength: 4000 } }), true),
  spec('threads.list', 'List one bounded page of threads in the current parent group.',
    schema({ page: { type: 'integer', minimum: 1, maximum: 10000 }, limit })),
  spec('threads.create', 'Create a bot-owned thread in the current parent group; requester must be owner/admin.',
    schema({ name: { type: 'string', minLength: 1, maxLength: 100 } }, ['name']), true),
  spec('thread.read', 'Read a thread in this group. In a thread session only the current thread is allowed.', schema(threadArgs)),
  spec('thread.members', 'List current thread participants; thread role 1 means creator, not group admin.', schema({ ...threadArgs, limit })),
  spec('thread.rules.read', 'Read the selected/current thread rules.', schema(threadArgs)),
  spec('thread.rules.edit', 'Replace topic rules with nonblank Markdown; requester must be group owner/admin and server must grant bot_admin. A bot token cannot clear topic rules. For clearing, direct the requester to the Octo topic rule editor.',
    schema({ ...threadArgs, content: { type: 'string', minLength: 1, maxLength: 10240 } }, ['content']), true),
  spec('thread.rename', 'Rename a thread; no bot-token rename endpoint in the reviewed server.',
    schema({ ...threadArgs, name: { type: 'string', minLength: 1, maxLength: 100 } }, ['name']), true, 'unsupported_bot_endpoint'),
  spec('thread.join', 'Join the selected/current thread as the bot, not as the requester.', schema(threadArgs), true),
  spec('thread.leave', 'Leave the selected/current thread as the bot.', schema(threadArgs), true),
  spec('thread.archive', 'Archive a thread; requester must be group admin and bot must be creator or group admin.', schema(threadArgs), true),
  spec('thread.delete', 'Delete a thread; requester must be group admin and bot must be creator or group admin.', schema(threadArgs), true),
  spec('messages.recent', 'Read one bounded page of current-channel history; before_seq is exclusive.',
    schema({ limit, before_seq: { type: 'integer', minimum: 1, maximum: 0xffffffff } })),
  spec('messages.read', 'Read one message from the current channel.', schema({ message_id: messageID }, ['message_id'])),
  // Keep conversation identity tools in messages.* for the host's native DM filter.
  spec('messages.user_info', 'Read a visible participant name by exact UID in this conversation. DM: current actor or this bot only; group: live members; topic: live participants plus current actor/this bot. No global directory or avatar URL.',
    schema({ uid: identityUID }, ['uid'])),
  spec('messages.users_batch', 'Look up 1-20 exact visible participant UIDs in this conversation, returning names/status/robot flags and missing UIDs. Same visibility rules as user_info; Space aliases do not grant access. Missing is not proof of nonmembership.',
    schema({ uids: { type: 'array', items: identityUID, minItems: 1, maxItems: 20, uniqueItems: true } }, ['uids'])),
  spec('messages.search', 'Search current-channel messages as a User Bot with server search enabled. Supply a keyword or sender/time filter. One page, at most 10 verified hits; no global or OBO search.',
    schema({ keyword: searchKeyword, ...searchPage })),
  spec('messages.search_files', 'Search/list files in the current channel as a User Bot with server search enabled. Keyword optional; one page of at most 10 verified messages and attachment metadata, without downloads or indexed snippets.',
    schema({ keyword: searchKeyword, ...searchPage })),
  spec('messages.search_media', 'List images/videos in the current channel as a User Bot with server search enabled. Sender/time filters only, no keyword or relevance sort. One page of at most 10 verified messages; no media downloads.',
    schema({ ...searchPage, sort: { type: 'string', enum: ['time_desc', 'time_asc'] } })),
  spec('messages.search_all', 'Search messages and files together in the current channel as a User Bot with server search enabled. Supply a keyword or sender/time filter. One page of at most 10 individually verified hits; no cross-channel search.',
    schema({ keyword: searchKeyword, ...searchPage })),
  spec('messages.search_around', 'Read context around a visible current-channel message as a User Bot with server search enabled. Use its exact decimal message_id string, not message_seq. limit is per side (default 5, max 10): at most 21 verified messages including the anchor. Neighbors excluded by visibility checks are omitted without backfill, so the window may be partial. Sender/time filters affect neighbors, not the anchor. No cursor or automatic paging.',
    schema({ anchor_message_id: messageID, filters: searchFilters, limit: searchLimit }, ['anchor_message_id'])),
  spec('messages.notify', 'Send text with visible native @name mentions for current member UIDs. Explicit all=true requires a current requester group owner/admin and notifies humans, never all bots.',
    schema({ text, uids: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,128}$' }, maxItems: 10, uniqueItems: true },
      all: { type: 'boolean' } }, ['text']), true),
  spec('messages.edit', 'Edit a bot-authored plain text message in this channel; group requester must be owner/admin.',
    schema({ message_id: messageID, text }, ['message_id', 'text']), true),
  { ...spec('messages.send_richtext', 'Send one native rich-text message with ordered text and images to the current conversation on explicit user request. Images must be explicitly supplied public HTTPS URLs with their actual dimensions, and file handling must be enabled. Use DSH present for workspace files. No raw payloads, quotes, mentions, callbacks or automatic retries. Summarize the outcome without repeating the message.', schema({
    blocks: richtextBlocks, confirm_send: { type: 'boolean', const: true },
  }, ['blocks', 'confirm_send']), true), requiresHostTools: true },
  spec('messages.edit_richtext', 'Replace an already-sent bot-authored type-14 richtext message in the current conversation. Group requester must be owner/admin. Supply ordered text/image blocks; images require public HTTPS URLs and dimensions. Max 20 blocks, 8 KiB total UTF-8 content, 24 KiB payload. No uploads, mentions or raw payload. Returns only a confirmed edit receipt; never retry an unconfirmed write automatically.',
    schema({ message_id: messageID, blocks: richtextBlocks }, ['message_id', 'blocks']), true),
  spec('messages.edit_display_card', 'Replace an already-sent bot-authored octo/v1 display card in the current conversation. Group requester must be owner/admin. Uses the same bounded title/blocks and live capability negotiation as octo_display_card. No progress, question, callback, v2 or Registry cards; no raw actions. Max 6 block levels, 200 objects, 8 KiB UTF-8 content and 24 KiB payload. Returns only a confirmed receipt; still provide a short final summary. Never retry an unconfirmed edit automatically.',
    displayEditParameters, true),
  spec('messages.mark_read', 'Mark specified current-channel messages as read by the bot and clear the bot unread count; does not act as the requester.',
    schema({ message_ids: { type: 'array', items: messageID, minItems: 1, maxItems: 10, uniqueItems: true } }, ['message_ids']), true),
  spec('messages.clear_card_revisions', 'Erase prior revisions of this bot\'s existing display card in the current conversation, retaining the current card and a server audit tombstone. Irreversible history cleanup, only on explicit user request with confirm_clear=true. Verified bot owner only; in groups also requires current group owner/admin. No question, approval, progress or Registry cards. Does not cancel an interaction or delete a message. Never retry an uncertain write.',
    schema({ message_id: messageID, confirm_clear: { type: 'boolean' } }, ['message_id', 'confirm_clear']), true),
  spec('voice.context.read', 'Owner DM only: read personal voice-correction context in the bot server-selected primary Space, not group/thread settings.'),
  spec('voice.context.update', 'Owner DM only: replace personal voice-correction context in the bot server-selected primary Space.',
    schema({ context: { type: 'string', minLength: 1, maxLength: 10000 } }, ['context']), true),
  spec('voice.context.delete', 'Owner DM only: delete personal voice-correction context in the bot server-selected primary Space.', schema(), true),
  ...['react', 'pin', 'delete'].map(action => spec('messages.' + action,
    'Unavailable: no reviewed bot-token endpoint for this message mutation.',
    schema({ message_id: messageID }, ['message_id']), true, 'unsupported_bot_endpoint')),
])
const specs = new Map(CHANNEL_API_OPERATIONS.map(value => [value.name, value]))
// App Bots have a distinct DM-only API surface. Do not expose User Bot group,
// directory, delegated search or voice operations and let the model discover
// their incompatibility by issuing failing mutations.
const appOperations = new Set(['inspect', 'messages.recent', 'messages.read', 'messages.user_info', 'messages.users_batch',
  'messages.notify', 'messages.mark_read', 'messages.edit', 'messages.send_richtext', 'messages.edit_richtext', 'messages.edit_display_card',
  'messages.clear_card_revisions', ...registryOperations])
const errorHints = Object.freeze({
  account_configuration_changed: '账号配置已变更，此次旧配置下的操作已停止。请基于当前配置重新确认；已经发出的写请求不会自动重试。',
  private_operation_required: '请在你与 Bot 的私聊中使用此操作。',
  shared_topic_target_required: '请明确选择本群的另一个子区，使用其准确的子区频道 ID。',
  shared_topic_operator_required: '发起人没有此账号的共享会话发送权限，或权限已变更。',
  requester_not_topic_member: '发起人必须是来源和目标子区的当前成员。',
  bot_not_topic_member: 'Bot 必须是来源和目标子区的当前成员。',
  invalid_target_response: '目标频道信息未能通过校验，未猜测或发送到其他地址。',
  thread_not_active: '此子区已归档或不可用，未发送消息。',
  private_search_required: '跨频道检索仅在发起人自己的私聊中提供，结果不会回发到共享群聊。',
  delegated_search_unavailable: '未能确认服务器支持按用户授权检索；没有退回 Bot 身份读取。请检查 Octo 版本及授权检索配置。',
  delegated_search_denied: 'Octo 未允许本用户的委托检索。请检查自己对该 Bot 已有的读取授权、频道范围及当前访问权限；插件不会自动创建授权。',
  delegated_target_not_allowed: '请选择当前账号配置空间内、Bot 已加入且渠道规则允许的群或子区。',
  search_continuation_invalid: '此续页标识已过期，或不属于当前账号、用户及完全相同的查询。请重新搜索；不会借用其他用户的游标。',
  api_permission_denied: 'Octo denied this bot credential. Check current membership/status and the group-specific bot_admin grant for rule/group-info edits or member removal.',
  api_authentication_failed: 'Reconnect with a valid bot credential.',
  api_invalid_request: 'Octo rejected the request. Check arguments and the server API version.',
  api_not_found: 'The endpoint or resource is unavailable. Check the server version and current-channel resource.',
  api_method_not_allowed: 'This server does not support the required HTTP method for this endpoint.',
  api_conflict: 'Refresh the resource before making another change.',
  api_rate_limited: 'Octo rate-limited this request. Wait before retrying; no automatic retry was attempted.',
  api_server_error: 'Octo reported a server failure. Check the resource state before retrying a mutation.',
  api_request_failed: 'The request failed. Check connectivity/API support and inspect the resource before retrying a mutation.',
  api_disabled: 'This Octo server has disabled the requested feature. Check its capability/feature configuration; retrying unchanged arguments will not enable it.',
  api_unavailable: 'The Octo feature or its upstream service is unavailable. Check service health; inspect mutation state before retrying.',
  api_unsupported: 'This operation or format is unsupported for the current bot type or server capability. Use the documented supported operation.',
  api_search_not_found: 'The requested search anchor/resource is not available in this visible conversation. Refresh the target; this is not proof of empty history.',
  api_search_depth_exceeded: 'The search cursor exceeded the server depth limit. Start a new, narrower time or sender search.',
  requester_admin_required: 'The requesting member must be this group owner or administrator; bot ownership grants no extra authority.',
  identity_outside_channel: 'Use an exact UID currently visible in this conversation; directory aliases and bot ownership grant no extra visibility.',
  webhook_outside_channel: 'Select a webhook listed in this exact group or topic.',
  webhook_bot_permission_required: 'The bot must own this webhook or currently be a group owner/administrator.',
  separate_owner_context_required: 'This operation is outside the admitted current-parent scope. It needs a separate owner context with explicit Space and requester visibility checks.',
  owner_dm_required: 'Personal voice context is available only in a verified bot-owner DM; group administrator status is not owner authority.',
  owner_identity_required: 'The host must first verify the bot owner identity before using this owner-only operation.',
  requester_owner_required: 'Only the verified bot owner can create a group; current group administrator status does not grant bot-owner authority.',
  human_member_required: 'Only live human members of the configured Space can be added through this operation.',
  protected_member: 'This operation cannot remove the calling bot or a group owner/administrator.',
  bot_permission_required: 'The bot must be the thread creator or a current group owner/administrator.',
  mutation_permission_changed: 'Live membership or role changed during this operation. No mutation was sent.',
  mutation_unconfirmed: 'The server did not return the required success acknowledgement. Inspect the resource before retrying.',
  unsupported_bot_endpoint: 'The reviewed official server has no bot-token endpoint for this operation.',
  thread_rules_clear_unsupported: 'Octo rejects blank topic rules from a bot. Use the delete action in the Octo topic rule editor if you have permission.',
  unsafe_mention_label: 'A selected member name resembles a broadcast or embeds another @. Use a safe member display name before sending a native mention.',
  invalid_mention_target: 'Broadcast sentinel UIDs cannot be used as individual mention targets. Use the explicit all option with group administrator authority.',
})
const statusErrors = new Map([[400, 'api_invalid_request'], [401, 'api_authentication_failed'], [403, 'api_permission_denied'],
  [404, 'api_not_found'], [405, 'api_method_not_allowed'], [409, 'api_conflict'], [413, 'api_invalid_request'], [429, 'api_rate_limited']])
const statusError = status => statusErrors.get(status)
  ?? (Number.isInteger(status) && status >= 500 && status <= 599 ? 'api_server_error' : 'api_request_failed')

export class ChannelApiError extends Error {
  constructor(code, hint = '') {
    super(code + (errorHints[code] ? ': ' + errorHints[code] : '') + (hint ? ' ' + hint : ''))
    this.name = 'ChannelApiError'
    this.code = code
  }
}
const fail = code => { throw new ChannelApiError(code) }
const id = value => {
  const s = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  return /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n ? s : undefined
}
const seq = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff
function searchTimeSeconds(value, endOfDay = false) {
  // Date.parse alone accepts impossible dates such as February 30. Check the
  // calendar independently, then mirror Go's seconds precision and +08 day bounds.
  if (!new RegExp(searchTimePattern).test(value)) fail('invalid_arguments')
  const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) fail('invalid_arguments')
  const time = value.length === 10 ? day / 1000 - 8 * 3600 + (endOfDay ? 86399 : 0) : Math.floor(Date.parse(value) / 1000)
  if (!Number.isFinite(time)) fail('invalid_arguments')
  return time
}
function validateSearch(operation, args) {
  const filters = args.filters ?? {}
  const from = filters.sent_at_from === undefined ? undefined : searchTimeSeconds(filters.sent_at_from)
  const to = filters.sent_at_to === undefined ? undefined : searchTimeSeconds(filters.sent_at_to, true)
  if (from !== undefined && to !== undefined && from > to) fail('invalid_arguments')
  if (['messages.search', 'messages.search_all'].includes(operation)
    && !args.keyword?.trim() && !filters.sender_ids?.length && from === undefined && to === undefined) fail('invalid_arguments')
  if (args.sort === 'relevance' && !args.keyword?.trim()) fail('invalid_arguments')
  if (operation === 'messages.search_around' && !id(args.anchor_message_id)) fail('invalid_arguments')
}
const boundedText = (value, max) => typeof value === 'string'
  ? Array.from(value.slice(0, max * 2)).slice(0, max).join('').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') : ''
const messageText = value => {
  // Budget JSON-encoded bytes, including escapes: even 50 worst-case message
  // snippets and their identifiers fit the host's 64 KiB tool-result boundary.
  let result = '', bytes = 0
  for (const rune of boundedText(value, 2000)) {
    bytes += Buffer.byteLength(JSON.stringify(rune), 'utf8') - 2
    if (bytes > 800) break
    result += rune
  }
  return result
}
function notificationPayload(text, uids, rows = [], all = false) {
  // sendMessage passes flags through without a bot_admin requirement. Explicit
  // all maps to humans for current clients; retain all for legacy clients.
  if (all) return { type: 1, content: text + '\n@所有人 ', mention: { all: 1, humans: 1 } }
  if (!uids.length) return { type: 1, content: text }
  const members = new Map(rows.map(row => [row.uid, row]))
  let content = text + '\n'
  const entities = []
  for (const uid of uids) {
    if (['all', '-1', '-2', '-3'].includes(uid.toLowerCase())) fail('invalid_mention_target')
    const member = members.get(uid)
    if (!member) fail('mention_not_member')
    const name = member.name.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim()
    const canonical = name.normalize('NFKC').toLowerCase()
    // Like the official render guard, reject broadcast-like names even when
    // their UID is a member: older clients tokenize display labels themselves.
    if (!name || canonical.includes('@') || /^(?:所有人|所有ai|all)(?:$|[^\p{L}\p{N}])/u.test(canonical)) fail('unsafe_mention_label')
    const label = '@' + name
    // JS lengths are UTF-16 code units, exactly the official entity contract.
    entities.push({ uid, offset: content.length, length: label.length })
    content += label + ' '
  }
  return { type: 1, content, mention: { uids, entities } }
}
const list = (value, max) => {
  if (value === null) return [] // Go nil slices are encoded as null.
  if (!Array.isArray(value)) fail('invalid_api_response')
  if (value.length > max) fail('response_limit_exceeded')
  return value
}

// Validate again in-process: a host's schema validation is not an access gate.
function validate(value, def) {
  if (def.type === 'object') {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_arguments')
    if (Object.keys(value).some(key => !Object.hasOwn(def.properties, key))
      || def.required.some(key => !Object.hasOwn(value, key))) fail('invalid_arguments')
    for (const [key, item] of Object.entries(value)) validate(item, def.properties[key])
  } else if (def.type === 'string') {
    if (typeof value !== 'string' || value.length > (def.maxLength ?? 4096) * 2
      || Array.from(value).length > (def.maxLength ?? 4096)
      || (def.minLength && !value.trim()) || (def.pattern && !new RegExp(def.pattern).test(value))
      || (def.enum && !def.enum.includes(value))) fail('invalid_arguments')
  } else if (def.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < def.minimum || value > def.maximum
      || def.enum && !def.enum.includes(value)) fail('invalid_arguments')
  } else if (def.type === 'boolean') {
    if (typeof value !== 'boolean') fail('invalid_arguments')
  } else if (def.type === 'array') {
    if (!Array.isArray(value) || value.length < (def.minItems ?? 0)
      || value.length > def.maxItems || new Set(value).size !== value.length) fail('invalid_arguments')
    for (const item of value) validate(item, def.items)
  }
}

// Snapshot new read inputs without invoking accessors, iterators or toJSON.
// Flat objects and UID arrays only; schema limits are enforced before walking.
function readArguments(value, def) {
  if (def.type === 'object' || def.type === 'array') {
    const array = def.type === 'array'
    if (array ? !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > def.maxItems
      : !object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_arguments')
    const copy = array ? [] : {}
    const keys = Reflect.ownKeys(value)
    if (array && keys.length !== value.length + 1) fail('invalid_arguments')
    for (const key of keys) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
        || (array ? !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length : !Object.hasOwn(def.properties, key))) fail('invalid_arguments')
      copy[key] = readArguments(descriptor.value, array ? def.items : def.properties[key])
    }
    validate(copy, def)
    return copy
  }
  validate(value, def)
  return value
}

function responseRows(raw, key, max, code) {
  if (!object(raw) || !Array.isArray(raw[key]) || raw[key].length > max) fail(code)
  return raw[key]
}
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
function identityName(value) {
  if (typeof value !== 'string' || value.length > 1000) fail('invalid_identity_response')
  return boundedText(value, 100)
}

function webhookRows(raw, scope) {
  const seen = new Set()
  return responseRows(raw, 'list', MAX_MEMBERS, 'invalid_webhook_response').map(row => {
    if (!object(row) || typeof row.webhook_id !== 'string' || !/^iwh_[a-f0-9]{32}$/.test(row.webhook_id)
      || seen.has(row.webhook_id) || row.group_no !== scope.group
      || (scope.thread ? row.thread_short_id !== scope.thread : row.thread_short_id !== undefined && row.thread_short_id !== '')
      || !validUid(row.creator_uid) || typeof row.name !== 'string' || row.name.length > 1000
      || ![0, 1].includes(row.status) || ![0, 1].includes(row.allow_mention_all) || ![0, 1].includes(row.allow_mention_bots)
      || ![row.last_used_at, row.call_count, row.created_at].every(nonnegative)) fail('invalid_webhook_response')
    seen.add(row.webhook_id)
    // Never spread upstream DTOs (including create DTOs carrying one-time secrets).
    return { webhook_id: row.webhook_id, group_no: scope.group, ...(scope.thread && { thread_short_id: scope.thread }),
      name: boundedText(row.name, 100), creator_uid: row.creator_uid, status: row.status,
      allow_mention_all: row.allow_mention_all, allow_mention_bots: row.allow_mention_bots,
      last_used_at: row.last_used_at, call_count: row.call_count, created_at: row.created_at }
  })
}

function deliveryRows(raw, size) {
  return responseRows(raw, 'list', size, 'invalid_delivery_response').map(row => {
    const messageID = row?.message_id === 0 || row?.message_id === '0' ? '0' : id(row?.message_id)
    if (!object(row) || !messageID || ![1, 2, 3].includes(row.status)
      // sql/20260606000001_incomingwebhook_audit_outcome.sql:14: legacy
      // successful rows use 0 = unknown HTTP status, deliberately not 200.
      || !Number.isInteger(row.http_status) || row.http_status !== 0 && (row.http_status < 100 || row.http_status > 599)
      || typeof row.reason !== 'string' || typeof row.adapter !== 'string'
      || !nonnegative(row.byte_size) || !nonnegative(row.created_at)) fail('invalid_delivery_response')
    return { status: row.status, reason: deliveryReasons.has(row.reason) ? row.reason : 'unknown',
      adapter: deliveryAdapters.has(row.adapter) ? row.adapter : 'unknown', http_status: row.http_status,
      byte_size: row.byte_size, message_id: messageID, created_at: row.created_at }
  })
}

function memberRows(raw) {
  const seen = new Set()
  return list(raw, MAX_MEMBERS).flatMap(row => {
    if (!object(row) || !validUid(row.uid) || seen.has(row.uid)
      || ![0, 1, 2].includes(row.role) || ![0, 1].includes(row.robot)) fail('invalid_member_response')
    seen.add(row.uid)
    // The reviewed bot endpoint omits status/bot_admin. Do not invent them.
    // If a future server supplies status, removed/blacklisted rows fail closed.
    if (row.is_deleted !== undefined && row.is_deleted !== 0 && row.is_deleted !== false
      || row.status !== undefined && row.status !== 1) return []
    return [{ uid: row.uid, name: boundedText(row.name, 100) || row.uid, robot: row.robot, role: row.role }]
  })
}

/** route and sender MUST come from the admitted event, never model arguments.
 * members() is trusted metadata plumbing; it cannot authorize a requester.
 * No cached membership, retries, pagination loops or user-token fallback.
 * Delegated search is a separate private-only operation with a closure-bound
 * human principal. Current-route reads never fall back to that authority.
 */
export class ChannelApi {
  #request
  #config
  #ownerUid
  #discovery
  #searchContinuations = new Map()
  #revoked = false
  constructor({ request, config, verifyAccount }) {
    if (typeof request !== 'function' || !validBotIdentity(config)) fail('invalid_channel_api_config')
    this.#request = request
    // The host fills ownerUid from verified identity after constructing its
    // client. Read that trusted field at call time; never accept it in args.
    this.#ownerUid = () => config.ownerUid
    if (typeof verifyAccount === 'function') this.#discovery = new OctoDiscovery({ request, config, verifyAccount })
    this.#config = {
      botUid: config.botUid, spaceId: config.spaceId, botKind: config.botKind,
      senderPolicy: config.senderPolicy ?? 'octo', channelPolicy: config.channelPolicy ?? 'joined',
      mentionPolicy: config.mentionPolicy ?? 'required', transport: config.transport, allowFiles: config.allowFiles === true,
      allowed: new Set(config.allowed ?? []), groups: new Set(config.groups ?? []), threads: new Set(config.threads ?? []),
    }
    if (!['octo', 'allowlist'].includes(this.#config.senderPolicy)
      || !['joined', 'allowlist'].includes(this.#config.channelPolicy)) fail('invalid_channel_api_config')
  }

  revoke() { this.#revoked = true; this.#searchContinuations.clear(); this.#discovery?.revoke() }

  supports(operation) {
    return specs.get(operation)?.available === true && (!isOctoDiscoveryOperation(operation) || !!this.#discovery)
      && (this.#config.botKind !== 'app' || appOperations.has(operation))
  }

  // Unlike sync, this official route applies the App's server-managed Space
  // guard as well as ordinary DM visibility. Never cache this authorization.
  async appMessage(route, sender, messageId, signal) {
    if (this.#config.botKind !== 'app' || route.channel_type !== 1 || route.channel_id !== sender) fail('invalid_route')
    return this.#readMessage(this.#scope(route), sender, messageId, signal)
  }

  async #call(path, body, signal, method = body === undefined ? 'GET' : 'POST', retainSendReceipt = false) {
    if (this.#revoked) fail('account_configuration_changed')
    if (signal?.aborted) fail('aborted')
    let result
    try { result = await this.#request(path, body === undefined ? undefined : JSON.stringify(body), signal, { method }) }
    catch (error) {
      if (signal?.aborted) fail('aborted')
      // The transport brands exact official code/status pairs. All text remains
      // a static local hint; never expose translated upstream messages/details.
      fail(apiErrorCode(error))
    }
    if (signal?.aborted || this.#revoked) {
      // Acknowledged sends cannot be undone by a concurrent settings change.
      // Preserve only the receipt, never stale target names or response fields.
      if (retainSendReceipt && object(result) && id(result.message_id) && result.error == null && result.ok !== false
        && (result.status === undefined || [0, 1, 2, 3, 200].includes(result.status))) {
        return { message_id: id(result.message_id), authority_changed: true }
      }
      if (signal?.aborted) fail('aborted')
      fail('account_configuration_changed')
    }
    // Never expose a transport exception, HTTP body, nested error, or credentials.
    if (Number.isInteger(result?.status) && result.status >= 400) fail(statusError(result.status))
    if (object(result) && (result.error != null || result.ok === false
      || result.status !== undefined && ![0, 1, 2, 3, 200].includes(result.status))) fail('api_request_failed')
    return result
  }

  #scope(route) {
    if (!object(route)) fail('invalid_route')
    const { channel_id, channel_type } = route
    const fixed = { channel_id, channel_type }
    if (channel_type === 1 && validUid(channel_id) && !channel_id.includes('@') && channel_id !== this.#config.botUid) {
      return { route: fixed }
    }
    if (this.#config.botKind === 'app') fail('api_unsupported')
    const scope = ruleScope(channel_type, channel_id)
    if (!scope) fail('invalid_route')
    if (this.#config.channelPolicy === 'allowlist'
      && !(channel_type === 2 ? this.#config.groups : this.#config.threads).has(channel_id)) fail('route_not_allowed')
    return { ...scope, route: fixed, root: '/v1/bot/groups/' + encodeURIComponent(scope.group) }
  }

  async #membership(scope, signal) {
    // Pin the parent to the configured Space, including allowlisted routes.
    const groups = list(await this.#call('/v1/bot/groups?' + new URLSearchParams({ space_id: this.#config.spaceId }), undefined, signal), 1000)
    const matches = groups.filter(row => row?.group_no === scope.group)
    if (matches.length !== 1 || matches[0].space_id !== this.#config.spaceId) fail('group_access_denied')
    const rows = memberRows(await this.#call(scope.root + '/members', undefined, signal))
    if (!rows.some(row => row.uid === this.#config.botUid && row.robot === 1)) fail('bot_not_member')
    return rows
  }

  async members(route, signal = new AbortController().signal) {
    const scope = this.#scope(route)
    if (!scope.group) fail('group_required')
    return this.#membership(scope, signal)
  }

  #requireOwnerDM(scope, sender) {
    const owner = this.#ownerUid()
    if (!validUid(owner) || owner === this.#config.botUid) fail('owner_identity_required')
    if (scope.route.channel_type !== 1 || scope.route.channel_id !== owner || sender !== owner) fail('owner_dm_required')
  }

  #requireOwner(sender) {
    const owner = this.#ownerUid()
    if (!validUid(owner) || owner === this.#config.botUid) fail('owner_identity_required')
    if (sender !== owner) fail('requester_owner_required')
  }

  async #principal(target, signal) {
    const raw = await this.#call('/v1/bot/space/principals/' + encodeURIComponent(target)
      + '?' + new URLSearchParams({ space_id: this.#config.spaceId }), undefined, signal)
    if (raw?.uid !== target || !['human', 'user_bot'].includes(raw.principal_type)) fail('invalid_principal_response')
    return raw.principal_type
  }

  async #threads(scope, page, size, signal) {
    const raw = await this.#call(scope.root + '/threads?' + new URLSearchParams({ page_index: page, page_size: size }), undefined, signal)
    if (!Number.isSafeInteger(raw?.count) || raw.count < 0) fail('invalid_thread_response')
    return { threads: list(raw.list, size).map(row => this.#thread(row, scope)), total: raw.count, more: page * size < raw.count }
  }

  async #access(scope, sender, mutating, signal, strictRead = false) {
    if (!validUid(sender) || sender === this.#config.botUid
      || this.#config.senderPolicy === 'allowlist' && !this.#config.allowed.has(sender)) fail('requester_not_allowed')
    if (!scope.group) {
      if (scope.route.channel_id !== sender) fail('requester_not_allowed')
      if (this.#config.botKind === 'app') {
        const users = await this.#call('/v1/bot/users/batch', { uids: [sender] }, signal)
        if (!Array.isArray(users?.users) || users.users.length !== 1 || !Array.isArray(users.missing_uids)
          || users.missing_uids.length || users.users[0]?.uid !== sender
          || users.users[0].status !== 1 || users.users[0].robot !== 0) fail('requester_not_allowed')
      }
      // Also used before DM mutations: ordinary sync checks owner/friend access.
      const data = await this.#call('/v1/bot/messages/sync', { ...scope.route, start_message_seq: 0, end_message_seq: 0, limit: 1, pull_mode: 0 }, signal)
      // Official sync can serialize an empty Go slice as null. Missing/other
      // shapes are not a successful access probe for the scoped identity reads.
      if (!object(data) || strictRead && (!Object.hasOwn(data, 'messages')
        || data.messages !== null && !Array.isArray(data.messages))) fail('invalid_api_response')
      list(data.messages, 1)
      if (this.#config.botKind === 'app') {
        const anchor = id(data.messages?.[0]?.message_id)
        if (!anchor) fail('message_unavailable')
        await this.#readMessage(scope, sender, anchor, signal)
      }
      return {}
    }
    const rows = await this.#membership(scope, signal)
    const actor = rows.find(row => row.uid === sender)
    if (!actor || actor.robot !== 0) fail('requester_not_member')
    const bot = rows.find(row => row.uid === this.#config.botUid)
    const raw = await this.#call(scope.root, undefined, signal)
    if (raw?.group_no !== scope.group || ![0, 1, 2].includes(raw.status)) fail('invalid_group_response')
    if (mutating && raw.status !== 1) fail('group_not_active')
    const group = { group_no: scope.group, name: boundedText(raw.name, 100), notice: boundedText(raw.notice, 4000), status: raw.status }
    return { rows, actor, bot, group }
  }

  #threadPath(scope, args) {
    if (!scope.group || !/^[a-fA-F0-9]{32}$/.test(scope.group)) fail('invalid_thread_scope')
    const selected = args.short_id ?? scope.thread
    if (typeof selected !== 'string' || !/^[0-9]{15,20}$/.test(selected)) fail('thread_required')
    if (scope.thread && scope.thread !== selected) fail('current_thread_only')
    return { path: scope.root + '/threads/' + selected, selected }
  }

  #thread(raw, scope, selected) {
    if (!object(raw) || raw.group_no !== scope.group || typeof raw.short_id !== 'string' || !/^[0-9]{15,20}$/.test(raw.short_id)
      || selected && raw.short_id !== selected || raw.channel_id !== scope.group + '____' + raw.short_id
      || raw.channel_type !== 5 || !validUid(raw.creator_uid) || ![1, 2].includes(raw.status)) fail('invalid_thread_response')
    return { group_no: scope.group, short_id: raw.short_id, channel_id: raw.channel_id, channel_type: 5,
      name: boundedText(raw.name, 100), creator_uid: raw.creator_uid, status: raw.status }
  }

  async #currentReadScope(scope, access, signal) {
    if (scope.group && access.group.status !== 1) fail('group_not_active')
    if (scope.thread) {
      const thread = this.#threadPath(scope, {})
      this.#thread(await this.#call(thread.path, undefined, signal), scope, thread.selected)
      return thread.path
    }
    return scope.root
  }

  async #visibleIdentities(scope, sender, access, signal) {
    const path = await this.#currentReadScope(scope, access, signal)
    if (!scope.group) return new Set([sender, this.#config.botUid])
    const visible = new Set(access.rows.map(row => row.uid))
    if (!scope.thread) return visible
    // A topic does not grant the parent's whole roster. Parent membership is
    // still necessary; topic subscriptions alone cannot resurrect removed users.
    const raw = await this.#call(path + '/members', undefined, signal)
    if (!Array.isArray(raw) || raw.length > MAX_MEMBERS) fail('invalid_thread_response')
    const participants = new Set([sender, this.#config.botUid]), seen = new Set()
    for (const row of raw) {
      if (!object(row) || !validUid(row.uid) || ![0, 1].includes(row.role) || seen.has(row.uid)) fail('invalid_thread_response')
      seen.add(row.uid)
      if (row.is_deleted !== undefined && ![0, false].includes(row.is_deleted)
        || row.status !== undefined && row.status !== 1) continue
      if (visible.has(row.uid)) participants.add(row.uid)
    }
    return participants
  }

  async #identities(scope, sender, operation, args, access, signal) {
    const targets = operation === 'messages.user_info' ? [args.uid] : args.uids
    // Check literal current-route UIDs BEFORE normalizing the server's aliases.
    const check = async current => {
      const visible = await this.#visibleIdentities(scope, sender, current, signal)
      if (targets.some(target => !visible.has(target))) fail('identity_outside_channel')
    }
    await check(access)
    let result
    if (operation === 'messages.user_info') {
      const raw = await this.#call('/v1/bot/user/info?' + new URLSearchParams({ uid: args.uid }), undefined, signal)
      if (!object(raw) || raw.uid !== bareUID(args.uid)) fail('invalid_identity_response')
      // Keep the admitted caller key, not an alias that could imply new access.
      result = { uid: args.uid, name: identityName(raw.name) }
    } else {
      const raw = await this.#call('/v1/bot/users/batch', { uids: targets }, signal)
      const seen = new Set()
      const accept = target => {
        if (!targets.includes(target) || seen.has(target)) fail('invalid_identity_response')
        seen.add(target)
      }
      const users = responseRows(raw, 'users', targets.length, 'invalid_identity_response').map(row => {
        if (!object(row) || row.status !== 1 || ![0, 1].includes(row.robot)) fail('invalid_identity_response')
        accept(row.uid)
        return { uid: row.uid, name: identityName(row.name), status: 1, robot: row.robot }
      })
      const missing = responseRows(raw, 'missing_uids', targets.length, 'invalid_identity_response')
      missing.forEach(accept)
      if (seen.size !== targets.length) fail('invalid_identity_response')
      result = { users: targets.flatMap(target => users.filter(row => row.uid === target)),
        missing_uids: targets.filter(target => missing.includes(target)) }
    }
    // No identity cache or authorization carried into the next conversation.
    await check(await this.#access(scope, sender, false, signal, true))
    return result
  }

  async #webhooks(scope, sender, operation, args, access, signal) {
    const gate = async current => {
      if (!admin(current.actor)) fail('requester_admin_required')
      return (await this.#currentReadScope(scope, current, signal)) + '/incoming-webhooks'
    }
    const path = await gate(access)
    const rows = webhookRows(await this.#call(path, undefined, signal), scope)
    const size = args.limit ?? 20
    const selected = operation === 'webhooks.deliveries' ? rows.find(row => row.webhook_id === args.webhook_id) : undefined
    const botCanRead = current => {
      if (!selected) fail('webhook_outside_channel')
      if (selected.creator_uid !== this.#config.botUid && !admin(current.bot)) fail('webhook_bot_permission_required')
    }
    let result
    if (operation === 'webhooks.deliveries') {
      botCanRead(access)
      // Listing is a separate request; recheck roles before fetching diagnostics.
      const current = await this.#access(scope, sender, false, signal, true)
      await gate(current)
      botCanRead(current)
      const raw = await this.#call(path + '/' + args.webhook_id + '/deliveries?' + new URLSearchParams({ limit: size }), undefined, signal)
      result = { webhook_id: args.webhook_id, deliveries: deliveryRows(raw, size) }
    } else result = { webhooks: rows.slice(0, size), total: rows.length, truncated: rows.length > size }
    const current = await this.#access(scope, sender, false, signal, true)
    await gate(current)
    if (selected) botCanRead(current)
    return result
  }

  async #writeWebhook(scope, sender, operation, args, access, signal) {
    const gate = async current => {
      if (!admin(current.actor)) fail('requester_admin_required')
      return (await this.#currentReadScope(scope, current, signal)) + '/incoming-webhooks'
    }
    const path = await gate(access)
    const select = async current => {
      const rows = webhookRows(await this.#call(path, undefined, signal), scope)
      const selected = rows.find(row => row.webhook_id === args.webhook_id)
      if (!selected) fail('webhook_outside_channel')
      if (selected.creator_uid !== this.#config.botUid && !admin(current.bot)) fail('webhook_bot_permission_required')
      if (args.mention_uids?.some(target => ['all', 'all_bots'].includes(target)
        || !current.rows.some(member => member.uid === target))) fail('invalid_mention_target')
      return selected
    }
    const selected = await select(access)
    // Listing can take time. Re-read current route/roles and the selected row;
    // then recheck roles once more immediately before the sole mutation.
    const current = await this.#access(scope, sender, true, signal, true)
    await gate(current)
    const latest = await select(current)
    if (selected.creator_uid !== latest.creator_uid) fail('mutation_permission_changed')
    const fresh = await this.#access(scope, sender, true, signal, true)
    await gate(fresh)
    if (latest.creator_uid !== this.#config.botUid && !admin(fresh.bot)) fail('mutation_permission_changed')
    if (args.mention_uids?.some(target => !fresh.rows.some(member => member.uid === target))) fail('mutation_permission_changed')
    const endpoint = path + '/' + args.webhook_id
    if (operation === 'webhooks.delete') {
      const raw = await this.#mutation(endpoint, undefined, signal, 'DELETE')
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, webhook_id: args.webhook_id, deleted: true }
    }
    if (operation === 'webhooks.test') {
      const raw = await this.#mutation(endpoint + '/test', undefined, signal, 'POST')
      if (raw?.status !== 0 || !id(raw.message_id)) fail('mutation_unconfirmed')
      return { ok: true, webhook_id: args.webhook_id, message_id: id(raw.message_id), ...scope.route,
        sent: true, targeted_mentions: 'configured_webhook_recipients', broadcast: false }
    }
    const { webhook_id, enabled, ...fields } = args
    if (enabled !== undefined) fields.status = enabled ? 1 : 0
    const raw = await this.#mutation(endpoint, fields, signal, 'PUT')
    let result
    try { result = webhookRows({ list: [raw] }, scope)[0] } catch { fail('mutation_unconfirmed') }
    if (result.webhook_id !== webhook_id || result.creator_uid !== latest.creator_uid) fail('mutation_unconfirmed')
    for (const [key, value] of Object.entries(fields)) {
      const received = raw[key]
      if (key === 'mention_uids' ? !Array.isArray(received) || received.length !== value.length
        || new Set(received).size !== value.length
        || received.some(target => !value.includes(target))
        : received !== (typeof value === 'boolean' ? Number(value) : value)) fail('mutation_unconfirmed')
    }
    return { ok: true, webhook: result }
  }

  async #mutation(path, body, signal, method = 'POST') {
    try { return await this.#call(path, body, signal, method, path === '/v1/bot/sendMessage') } catch (error) {
      if (['api_invalid_request', 'api_authentication_failed', 'api_permission_denied', 'api_not_found',
        'api_method_not_allowed', 'api_conflict', 'api_rate_limited', 'api_disabled', 'api_unsupported'].includes(error?.code)) throw error
      fail('mutation_unconfirmed')
    }
  }

  async #rules(path, signal) {
    const raw = await this.#call(path + '/md', undefined, signal)
    if (typeof raw?.content !== 'string' || Buffer.byteLength(raw.content, 'utf8') > 10240
      || !Number.isSafeInteger(raw.version) || raw.version < 0) fail('invalid_rule_response')
    return { content: raw.content, version: raw.version }
  }

  async #editRules(path, content, signal) {
    // The server checks IsBotAdmin (bot_admin=1), NOT member.role. That bit is
    // not published by GET /members. Never substitute owner/admin role, a
    // config flag, or the bot owner's role for this atomic server-side check.
    const raw = await this.#call(path + '/md', { content }, signal, 'PUT')
    if (!Number.isSafeInteger(raw?.version) || raw.version < 1) fail('mutation_unconfirmed')
    return { ok: true, version: raw.version }
  }

  #message(raw, scope, sender, details = false, editType, expectedNeighbor) {
    if (!object(raw) || !id(raw.message_id) || !seq(raw.message_seq) || !validUid(raw.from_uid)
      || raw.channel_type !== scope.route.channel_type) fail('invalid_message_response')
    const channel = scope.route.channel_id
    // WuKong sorts DM peers by CRC32, not lexically. Either order is the
    // exact same two-party conversation; no third participant is accepted.
    const dmIDs = [channel, channel + '@' + this.#config.botUid, this.#config.botUid + '@' + channel]
    if (scope.group ? raw.channel_id !== channel : !dmIDs.includes(raw.channel_id)
      || ![channel, this.#config.botUid].includes(raw.from_uid)) fail('message_outside_channel')
    // An unavailable neighbor can be omitted only after its identity matches
    // the current-route index hit. Do not mask a protocol or routing mismatch.
    if (expectedNeighbor) {
      if (id(raw.message_id) !== expectedNeighbor.message_id) fail('message_outside_channel')
      if (raw.message_seq !== expectedNeighbor.message_seq || raw.from_uid !== expectedNeighbor.sender_id) fail('invalid_search_response')
    }
    if ([raw, raw.extra, raw.message_extra].some(extra => extra && [extra.revoke, extra.revoked, extra.is_deleted].some(flag))) fail('message_unavailable')
    let payload = raw.payload
    if (typeof payload === 'string' && payload.length <= 120000) {
      try { payload = JSON.parse(payload.trimStart().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8')) }
      catch { fail('invalid_message_response') }
    }
    const matchesSpace = value => value.space_id == null || (this.#config.botKind === 'app'
      ? validUid(value.space_id) : value.space_id === this.#config.spaceId)
    if (!object(payload)) fail(expectedNeighbor ? 'invalid_message_response' : 'message_unavailable')
    if (payload.event != null || !matchesSpace(payload)) fail('message_unavailable')
    if (payload.visibles != null) {
      if (!Array.isArray(payload.visibles)) fail(expectedNeighbor ? 'invalid_message_response' : 'message_unavailable')
      if (payload.visibles.length > 0 && !payload.visibles.includes(sender)) fail('message_unavailable')
    }
    const checkEditSource = value => {
      if (value.type !== editType) fail(editType === 17 ? 'display_card_message_required'
        : editType === 14 ? 'richtext_message_required' : 'plain_text_message_required')
      if (editType === 17) displayWork(() => assertEditableDisplayCard(value))
    }
    if (editType) {
      checkEditSource(payload) // Original identity cannot be laundered by content_edit.
      for (const extra of [raw, raw.extra, raw.message_extra]) {
        if (!extra) continue
        if (['revoke', 'revoked', 'is_deleted', 'is_mutual_deleted'].some(key => extra[key] != null && ![0, false].includes(extra[key]))) fail('message_unavailable')
      }
      if (raw.extra?.content_edit && raw.message_extra?.content_edit
        && JSON.stringify(raw.extra.content_edit) !== JSON.stringify(raw.message_extra.content_edit)) fail('invalid_message_response')
    }
    const edited = raw.message_extra?.content_edit ?? raw.extra?.content_edit
    if (edited != null && edited !== '') {
      // Official GET (newMessageExtraResp) decodes content_edit into an object.
      // Older transports expose the stored JSON string. Accept both, bounded;
      // never mistake an effective v2/Registry frame for the original v1 card.
      if (object(edited)) {
        let encoded
        try { encoded = JSON.stringify(edited) } catch { fail('invalid_message_response') }
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 120000) fail('invalid_message_response')
        payload = JSON.parse(encoded)
      } else {
        if (typeof edited !== 'string' || edited.length > 120000) fail('invalid_message_response')
        try { payload = JSON.parse(edited) } catch { payload = { type: 1, content: edited } }
      }
      if (!object(payload) || payload.visibles != null || payload.event != null) fail('invalid_message_response')
    }
    if (editType) {
      if (!matchesSpace(payload)) fail('message_unavailable')
      checkEditSource(payload)
    }
    const normalized = normalizeOctoContent(payload, { allowFiles: details })
    const attachments = normalized?.attachment ? [normalized.attachment] : normalized?.attachments ?? []
    return { message_id: id(raw.message_id), message_seq: raw.message_seq, from_uid: raw.from_uid,
      type: payload.type, text: messageText(normalized?.text),
      // Metadata comes from the live, visibility-checked message, not the index.
      // No URLs, indexed file-body excerpts, downloads, or unbounded attachments.
      ...(details && attachments.length && { attachments: attachments.slice(0, 2).map(item => ({
        kind: item.kind, name: boundedText(item.name, 80), mime: boundedText(item.mime, 100),
        ...(item.size !== undefined && { size: item.size }),
      })), attachments_truncated: attachments.length > 2 }) }
  }

  async #readMessage(scope, sender, messageId, signal, details = false, editType, expectedNeighbor, rawSource = false) {
    if (!id(messageId)) fail('invalid_arguments')
    const base = scope.group ? scope.root + (scope.thread ? '/threads/' + scope.thread : '')
      : '/v1/bot/messages/person/' + encodeURIComponent(scope.route.channel_id)
    const path = scope.group ? base + '/messages/' + messageId : base + '/' + messageId
    const raw = await this.#call(path, undefined, signal)
    const result = this.#message(raw, scope, sender, details, editType, expectedNeighbor)
    if (result.message_id !== messageId) fail('message_outside_channel')
    return rawSource ? raw : result
  }

  async #search(scope, sender, operation, args, signal) {
    const around = operation === 'messages.search_around'
    const size = args.limit ?? (around ? 5 : 10)
    // A bot-visible anchor need not be visible to the requester. Verify it BEFORE
    // asking for its neighbors, and again after the search to catch changed visibility.
    if (around) await this.#readMessage(scope, sender, args.anchor_message_id, signal)
    const body = { ...scope.route, page_size: size, ...(args.filters && { filters: args.filters }),
      ...(around ? { anchor_message_id: args.anchor_message_id }
        : { sort: args.sort ?? 'time_desc', ...(args.keyword !== undefined && { keyword: args.keyword.trim() }),
          ...(args.cursor && { cursor: args.cursor }) }) }
    let raw
    try { raw = await this.#call(searchEndpoints[operation], body, signal) }
    catch (error) {
      if (around && error?.code === 'api_search_not_found') throw error
      if (error instanceof ChannelApiError && error.code.startsWith('api_')) {
        throw new ChannelApiError(error.code, 'Search requires a User Bot, an enabled server search backend, and current channel access. No retry or identity fallback was attempted.')
      }
      throw error
    }
    const rows = value => {
      if (!Array.isArray(value)) fail('invalid_search_response')
      if (value.length > size) fail('response_limit_exceeded')
      return value
    }
    const seen = new Set()
    const hit = (row, kind, channelRequired = true) => {
      if (!object(row) || typeof row.message_id !== 'string' || !id(row.message_id) || !seq(row.message_seq)
        || !validUid(row.sender_id) || seen.has(row.message_id)
        || (channelRequired || Object.hasOwn(row, 'channel_id')) && row.channel_id !== scope.route.channel_id
        || Object.hasOwn(row, 'channel_type') && row.channel_type !== scope.route.channel_type) fail('invalid_search_response')
      seen.add(row.message_id)
      return { row, kind }
    }
    let entries, before, anchor, after
    if (around) {
      if (!object(raw) || typeof raw.has_more_before !== 'boolean' || typeof raw.has_more_after !== 'boolean'
        || raw.anchor?.message_id !== args.anchor_message_id) fail('invalid_search_response')
      anchor = hit(raw.anchor)
      before = rows(raw.before).map(row => hit(row))
      after = rows(raw.after).map(row => hit(row))
      entries = [anchor, ...before, ...after]
    } else {
      if (!object(raw?.pagination) || typeof raw.pagination.has_more !== 'boolean'
        || typeof raw.pagination.next_cursor !== 'string' || raw.pagination.next_cursor.length > 4096
        || raw.pagination.has_more && !raw.pagination.next_cursor) fail('invalid_search_response')
      entries = rows(raw.data).map(row => {
        if (operation === 'messages.search_all') {
          if (!object(row) || !['message', 'file'].includes(row.result_type)
            || Object.hasOwn(row, row.result_type === 'file' ? 'message' : 'file')) fail('invalid_search_response')
          return hit(row[row.result_type], row.result_type)
        }
        if (operation === 'messages.search_media') {
          if (!['image', 'video'].includes(row?.media_kind)) fail('invalid_search_response')
          return hit(row, row.media_kind, false)
        }
        return hit(row, operation === 'messages.search_files' ? 'file' : undefined, operation !== 'messages.search_files')
      })
    }
    for (const entry of entries) {
      const { row, kind } = entry
      const neighbor = around && entry !== anchor
      let message
      try {
        message = await this.#readMessage(scope, sender, row.message_id, signal, true, undefined, neighbor ? row : undefined)
      } catch (error) {
        // Octo windows are visibility-filtered for the bot. Apply the
        // requester's additional visibility filter per neighbor. Never skip
        // the anchor or treat an upstream error as a visibility decision.
        if (neighbor && error instanceof ChannelApiError && error.code === 'message_unavailable') continue
        throw error
      }
      if (!Number.isInteger(message.type) || message.type < 1 || message.type >= 99
        || message.message_seq !== row.message_seq || message.from_uid !== row.sender_id
        || kind === 'file' && message.type !== 8 || kind === 'message' && message.type === 8
        || kind === 'image' && message.type !== 2 || kind === 'video' && message.type !== 5) fail('invalid_search_response')
      entry.value = { ...message, name: boundedText(row.sender_name, 100), ...(kind && { result_type: kind }) }
    }
    // Search and verification may take time; membership loss during either must
    // prevent returning even an otherwise valid page. No cursor traversal/retries.
    await this.#access(scope, sender, false, signal)
    const visible = side => side.filter(entry => entry.value).map(entry => entry.value)
    return around ? { before: visible(before), anchor: anchor.value, after: visible(after),
      has_more_before: raw.has_more_before, has_more_after: raw.has_more_after }
      : { messages: entries.map(entry => entry.value), more: raw.pagination.has_more, next_cursor: raw.pagination.next_cursor }
  }

  async #authorizedSearch(scope, sender, operation, args, signal) {
    if (scope.group || scope.route.channel_id !== sender) fail('private_search_required')
    if (await this.#principal(sender, signal) !== 'human' || await this.#principal(this.#config.botUid, signal) !== 'user_bot') fail('delegated_search_denied')
    const scopes = args.targets.map(target => {
      const selected = this.#scope(target)
      if (!selected.group || !/^[a-fA-F0-9]{32}$/.test(selected.group)) fail('delegated_target_not_allowed')
      return selected
    })
    const groups = list(await this.#call('/v1/bot/groups?' + new URLSearchParams({ space_id: this.#config.spaceId }), undefined, signal), 1000)
    if (scopes.some(selected => {
      const matches = groups.filter(row => row?.group_no === selected.group)
      return matches.length !== 1 || matches[0].space_id !== this.#config.spaceId
    })) fail('delegated_target_not_allowed')
    const body = { ...(args.keyword !== undefined && { keyword: webhookName(args.keyword) }),
      filters: { ...args.filters, channel_ids: args.targets, channel_types: [...new Set(args.targets.map(row => row.channel_type))] },
      ...(operation !== 'messages.search_authorized_groups' && { page_size: args.limit ?? 10,
        sort: args.sort ?? 'time_desc' }) }
    // Cursor signatures on this API do not bind the identity, query or targets.
    // Keep raw wire cursors private and expose only account-instance-scoped,
    // short-lived handles. Reconfiguration constructs a fresh ChannelApi.
    const canonical = value => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
    const query = createHash('sha256').update(JSON.stringify(canonical({ sender, route: scope.route, operation, body }))).digest('hex')
    for (const [handle, record] of this.#searchContinuations) if (record.expires <= Date.now()) this.#searchContinuations.delete(handle)
    if (args.continuation) {
      const record = this.#searchContinuations.get(args.continuation)
      if (!record || record.query !== query) fail('search_continuation_invalid')
      body.cursor = record.cursor
    }
    const path = authorizedSearchEndpoints[operation]
    // A legacy server may silently ignore an unknown on_behalf_of field. First
    // require its exact, branded self-delegation rejection. The deliberately
    // invalid keyword prevents a field-ignoring old handler from searching any
    // content. This is a compatibility guard, not a proof of all server nodes'
    // version or index visibility; no successful probe content is ever returned.
    let recognized = false
    try {
      await this.#request(path, JSON.stringify({ keyword: 'x'.repeat(65), on_behalf_of: this.#config.botUid }), signal, { method: 'POST' })
    } catch (error) {
      recognized = error?.status === 403 && officialApiErrorCode(error) === 'err.server.bot_api.obo_not_authorized'
    }
    if (signal.aborted) fail('aborted')
    if (!recognized) fail('delegated_search_unavailable')
    let raw
    try { raw = await this.#call(path, { ...body, on_behalf_of: sender }, signal) }
    catch (error) {
      if (error.code === 'api_permission_denied') fail('delegated_search_denied')
      throw error
    }
    // Return only the OBO projection. An as-bot message lookup here could reveal
    // text/files hidden by the human's self-delete or cleared-history state.
    let result
    try { result = projectAuthorizedSearch(operation, raw, args) }
    catch { fail('invalid_authorized_search_response') }
    const cursor = result.next_cursor
    delete result.next_cursor
    if (result.more && cursor) {
      while (this.#searchContinuations.size >= 64) this.#searchContinuations.delete(this.#searchContinuations.keys().next().value)
      const handle = 'ocs_' + randomUUID().replaceAll('-', '')
      this.#searchContinuations.set(handle, { query, cursor, expires: Date.now() + 5 * 60_000 })
      result.continuation = handle
    }
    return boundAuthorizedSearchResult(result)
  }

  async #targetAccess(target, sender, signal) {
    const scope = this.#scope(target)
    if (scope.route.channel_type === 1) {
      const person = scope.route.channel_id
      if (!personUid(person)) fail('invalid_route')
      if (await this.#principal(sender, signal) !== 'human'
        || await this.#principal(this.#config.botUid, signal) !== 'user_bot'
        || await this.#principal(person, signal) !== 'human') fail('human_member_required')
      const raw = await this.#call('/v1/bot/user/info?' + new URLSearchParams({ uid: person }), undefined, signal)
      if (!object(raw) || raw.uid !== person) fail('invalid_identity_response')
      const name = identityName(raw.name)
      // Do not read a third party's DM history as a send preflight. The actual
      // send handler atomically checks the bot-to-peer friendship. Exact Space
      // principals are refreshed after metadata; directory names grant no access.
      for (const principal of new Set([sender, person])) {
        if (await this.#principal(principal, signal) !== 'human') fail('human_member_required')
      }
      return { scope, access: { actor: { uid: sender }, rows: [] }, target: { ...scope.route, name } }
    }
    if (!scope.group || !/^[a-fA-F0-9]{32}$/.test(scope.group)) fail('invalid_route')
    const access = await this.#access(scope, sender, true, signal)
    let topic
    if (scope.thread) {
      topic = this.#thread(await this.#call(scope.root + '/threads/' + scope.thread, undefined, signal), scope, scope.thread)
      if (topic.status !== 1) fail('thread_not_active')
    }
    // Metadata requests can outlive membership/admin changes. Make the actual
    // member read the final network await before returning/sending; the server
    // still owns atomic membership/group lifecycle enforcement at dispatch.
    const rows = await this.#membership(scope, signal)
    const actor = rows.find(row => row.uid === sender)
    if (!actor || actor.robot !== 0) fail('requester_not_member')
    return { scope, access: { ...access, rows, actor, bot: rows.find(row => row.uid === this.#config.botUid) },
      target: { ...scope.route, name: topic?.name ?? access.group.name,
      ...(topic && { parent_name: access.group.name }) } }
  }

  async #activeSendTopic(scope, sender, signal) {
    const { path, selected } = this.#threadPath(scope, {})
    const topic = this.#thread(await this.#call(path, undefined, signal), scope, selected)
    if (topic.status !== 1) fail('thread_not_active')
    // Octo's bot thread endpoint itself only requires the Bot's active parent
    // membership. The actual topic roster is needed; do not seed it with the
    // event sender, the Bot, the topic creator, or other parent members.
    const raw = await this.#call(path + '/members', undefined, signal)
    if (!Array.isArray(raw)) fail('invalid_thread_response')
    const seen = new Set(), members = new Set()
    for (const row of list(raw, MAX_MEMBERS)) {
      if (!object(row) || !validUid(row.uid) || ![0, 1].includes(row.role) || seen.has(row.uid)) fail('invalid_thread_response')
      seen.add(row.uid)
      if (row.is_deleted !== undefined && ![0, false].includes(row.is_deleted)
        || row.status !== undefined && row.status !== 1) continue
      members.add(row.uid)
    }
    if (!members.has(sender)) fail('requester_not_topic_member')
    if (!members.has(this.#config.botUid)) fail('bot_not_topic_member')
    return { topic, members }
  }

  async #sendFromShared(scope, sender, operation, args, signal, prepared, runtime, authorizeOperator) {
    const { channel_type, channel_id } = args.target
    const selected = ruleScope(channel_type, channel_id)
    if (!selected?.thread || selected.group !== scope.group || channel_id === scope.route.channel_id) fail('shared_topic_target_required')
    const target = this.#scope(args.target)
    // Host-only synchronous guard, bound to the admitted job and current
    // account/tool grant. Model arguments cannot supply or override it.
    const operatorAllowed = () => {
      try { return authorizeOperator() === true } catch { return false }
    }
    const assertOperator = () => {
      if (this.#revoked) fail('account_configuration_changed')
      if (signal.aborted) fail('aborted')
      if (!operatorAllowed()) fail('shared_topic_operator_required')
    }
    const authorize = async () => {
      assertOperator()
      const { group } = await this.#access(scope, sender, true, signal, true)
      if (await this.#principal(sender, signal) !== 'human'
        || await this.#principal(this.#config.botUid, signal) !== 'user_bot') fail('requester_not_allowed')
      if (scope.thread) await this.#activeSendTopic(scope, sender, signal)
      const { topic, members } = await this.#activeSendTopic(target, sender, signal)
      // Recheck parent membership and the human's role after topic metadata.
      // Topic roles are creator flags and do not authorize broadcasts.
      const rows = await this.#membership(target, signal)
      const actor = rows.find(row => row.uid === sender && row.robot === 0)
      if (!actor) fail('requester_not_member')
      assertOperator()
      return { scope: target, access: { actor, rows: rows.filter(row => members.has(row.uid)) },
        target: { ...target.route, name: topic.name, parent_name: group.name } }
    }
    // Before a profile read or file preparation, prove both routes. Text has
    // no preparation and only needs the authorization immediately before send.
    if (operation !== 'messages.send_target') await authorize()
    return this.#sendTarget(operation, args, signal, prepared, runtime, authorize, operatorAllowed)
  }

  async #proactive(scope, sender, operation, args, signal, prepared, runtime) {
    if (scope.route.channel_type !== 1 || scope.route.channel_id !== sender) fail('private_operation_required')
    if (await this.#principal(sender, signal) !== 'human' || await this.#principal(this.#config.botUid, signal) !== 'user_bot') fail('requester_not_allowed')
    if (operation === 'messages.resolve_people') {
      const size = args.limit ?? 5, page = args.page ?? 1
      const raw = await this.#call('/v1/bot/space/members?' + new URLSearchParams({ space_id: this.#config.spaceId,
        keyword: webhookName(args.name), limit: size, page }), undefined, signal)
      const rows = list(raw, size), seen = new Set(), candidates = []
      for (const row of rows) {
        if (!personUid(row?.uid)
          || ![0, 1].includes(row.robot) || seen.has(row.uid)) fail('invalid_member_response')
        seen.add(row.uid)
        if (row.robot !== 0 || row.uid === this.#config.botUid) continue
        const name = identityName(row.name)
        try {
          if (await this.#principal(row.uid, signal) === 'human') candidates.push({ channel_id: row.uid, channel_type: 1, name })
        } catch (error) {
          if (!['api_not_found', 'api_permission_denied'].includes(error?.code)) throw error
        }
      }
      await this.#access(scope, sender, false, signal, true)
      if (await this.#principal(sender, signal) !== 'human' || await this.#principal(this.#config.botUid, signal) !== 'user_bot') fail('requester_not_allowed')
      const verified = []
      for (const candidate of candidates) {
        try {
          if (await this.#principal(candidate.channel_id, signal) === 'human') verified.push(candidate)
        } catch (error) {
          if (!['api_not_found', 'api_permission_denied'].includes(error?.code)) throw error
        }
      }
      // The principal endpoint deliberately conflates a missing recipient with
      // inactive Space/caller membership. A skipped 404 must not publish earlier
      // candidates after the whole directory's authorization was withdrawn.
      if (await this.#principal(sender, signal) !== 'human' || await this.#principal(this.#config.botUid, signal) !== 'user_bot') fail('requester_not_allowed')
      const more = rows.length === size
      return { candidates: verified, page, more, scope: 'configured_space_humans', friendship_checked: false,
        needs_choice: verified.length !== 1 || more || page !== 1 }
    }
    if (operation === 'messages.resolve_targets') {
      const kind = args.kind ?? 'all', limit = args.limit ?? 5
      const raw = await this.#call('/v1/bot/resolve/targets?' + new URLSearchParams({ name: webhookName(args.name), kind, limit: 20 }), undefined, signal)
      if (!object(raw) || !Array.isArray(raw.candidates) || raw.candidates.length > (kind === 'all' ? 40 : 20)
        || raw.total !== raw.candidates.length || typeof raw.truncated !== 'boolean') fail('invalid_target_response')
      const candidates = [], seen = new Set()
      // Global resolver results are bot-visible and not Space-scoped upstream.
      // Never return their names/counts until current human membership and the
      // configured account route policy have independently authorized the route.
      for (const candidate of raw.candidates) {
        const selected = ruleScope(candidate?.channel_type, candidate?.channel_id)
        if (!selected || candidate.group_no !== selected.group
          || candidate.kind !== (selected.thread ? 'thread' : 'group')
          || kind !== 'all' && candidate.kind !== kind
          || selected.thread && candidate.short_id !== selected.thread) fail('invalid_target_response')
        const key = candidate.channel_type + ':' + candidate.channel_id
        if (seen.has(key)) fail('invalid_target_response')
        seen.add(key)
        try {
          const value = await this.#targetAccess(candidate, sender, signal)
          candidates.push(value.target)
        } catch (error) {
          if (!['route_not_allowed', 'group_access_denied', 'requester_not_member', 'bot_not_member',
            'group_not_active', 'thread_not_active', 'api_not_found', 'api_permission_denied'].includes(error?.code)) throw error
        }
      }
      const verified = []
      await this.#access(scope, sender, false, signal, true)
      for (const candidate of candidates.slice(0, limit)) verified.push((await this.#targetAccess(candidate, sender, signal)).target)
      return { candidates: verified, truncated: raw.truncated || candidates.length > limit,
        scope: 'requester_and_bot_member_routes', needs_choice: verified.length !== 1 || raw.truncated || candidates.length > limit }
    }
    // Re-read before committing: name discovery is never an authorization cache.
    await this.#targetAccess(args.target, sender, signal)
    const authorize = async () => {
      signal.throwIfAborted()
      await this.#access(scope, sender, true, signal, true)
      return this.#targetAccess(args.target, sender, signal)
    }
    return this.#sendTarget(operation, args, signal, prepared, runtime, authorize)
  }

  async #sendTarget(operation, args, signal, prepared, runtime, authorize, sharedOperatorAllowed) {
    let payload, fallbackBlocks
    if (operation === 'messages.send_target_card') {
      const profile = await this.#call('/v1/bot/card/profile', undefined, signal)
      const rendered = displayWork(() => renderDisplayCard(prepared, profile))
      payload = { type: 17, ...rendered.frame }
      fallbackBlocks = [...rendered.fallbacks]
    } else if (operation === 'messages.send_target_file') {
      // Only the host-owned runtime can read/upload bytes. Model arguments
      // cannot supply an upload URL, credentials, raw payload or another cwd.
      if (typeof runtime?.prepareFile !== 'function') fail('file_delivery_unavailable')
      const file = await runtime.prepareFile(args.path, authorize, signal)
      const url = typeof file?.url === 'string' && URL.parse(file.url)
      if (![2, 8].includes(file?.type) || !url || url.protocol !== 'https:' || url.username || url.password || url.hash
        || file.url.length > 8192 || typeof file.name !== 'string' || !file.name || file.name.length > 255
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 20 * 1024 * 1024) fail('invalid_prepared_file')
      payload = { type: file.type, url: file.url, name: file.name, size: file.size }
      if (file.type === 2 && Number.isInteger(file.width) && file.width > 0 && file.width <= 16384
        && Number.isInteger(file.height) && file.height > 0 && file.height <= 16384) {
        payload.width = file.width; payload.height = file.height
      }
    }
    const fresh = await authorize()
    const uids = args.uids ?? []
    if (args.all && !admin(fresh.access.actor)) fail('requester_admin_required')
    if (sharedOperatorAllowed && uids.some(uid => ['all', 'all_bots', '-1', '-2', '-3'].includes(uid.toLowerCase()))) fail('invalid_mention_target')
    if (uids.some(uid => !fresh.access.rows.some(row => row.uid === uid))) fail('mention_not_member')
    payload ??= notificationPayload(args.text, uids, fresh.access.rows, args.all)
    if (sharedOperatorAllowed && !sharedOperatorAllowed()) fail('shared_topic_operator_required')
    const raw = await this.#mutation('/v1/bot/sendMessage', { ...fresh.scope.route, payload }, signal)
    if (!id(raw?.message_id)) fail('mutation_unconfirmed')
    if (raw.authority_changed || sharedOperatorAllowed && !sharedOperatorAllowed()) return { ok: operation !== 'messages.send_target_file' || args.caption === undefined,
      message_id: id(raw.message_id), sent_as: 'bot', authority_changed: true, requiresFinalSummary: true,
      ...(operation === 'messages.send_target_file' && args.caption !== undefined
        && { partial: true, caption_status: 'not_sent', retry_whole_delivery: false }) }
    if (operation === 'messages.send_target_card') return { ok: true, message_id: id(raw.message_id), ...fresh.target,
      sent_as: 'bot', format: 'display_card', fallbackBlocks, requiresFinalSummary: true }
    if (operation === 'messages.send_target_file') {
      const receipt = { message_id: id(raw.message_id), ...fresh.target, sent_as: 'bot',
        format: payload.type === 2 ? 'image' : 'file', file_name: payload.name, size: payload.size, requiresFinalSummary: true }
      if (args.caption === undefined) return { ok: true, ...receipt }
      // Native file/image captions are not consistently rendered by clients.
      // Use an independent full text/Markdown message; retain the confirmed
      // file receipt if permission changes or that second send is uncertain.
      try {
        await authorize()
        if (sharedOperatorAllowed && !sharedOperatorAllowed()) fail('shared_topic_operator_required')
        const caption = await this.#mutation('/v1/bot/sendMessage', { ...fresh.scope.route,
          payload: notificationPayload(args.caption, [], [], false) }, signal)
        const captionId = id(caption?.message_id)
        if (!captionId || sharedOperatorAllowed && captionId === receipt.message_id) fail('mutation_unconfirmed')
        if (caption.authority_changed || sharedOperatorAllowed && !sharedOperatorAllowed()) return { ok: true, message_id: receipt.message_id,
          caption_message_id: captionId, sent_as: 'bot', authority_changed: true, requiresFinalSummary: true }
        return { ok: true, ...receipt, caption_message_id: captionId, caption: args.caption }
      } catch (error) {
        return { ok: false, ...receipt, partial: true,
          caption_status: error?.code === 'mutation_unconfirmed' ? 'unconfirmed' : 'not_sent',
          retry_whole_delivery: false }
      }
    }
    return { ok: true, message_id: id(raw.message_id), ...fresh.target, sent_as: 'bot',
      text: payload.content, ...(payload.mention && { mention: payload.mention }),
      ...(sharedOperatorAllowed && { requiresFinalSummary: true }) }
  }

  async dispatch(route, sender, operation, args = {}, signal = new AbortController().signal, runtime) {
    if (this.#revoked) fail('account_configuration_changed')
    const definition = specs.get(operation)
    if (!definition) fail('unknown_operation')
    if (this.#config.botKind === 'app' && !this.supports(operation)) fail('api_unsupported')
    if (operation === 'messages.send_richtext') {
      if (!object(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
        || Reflect.ownKeys(args).length !== 2) fail('invalid_arguments')
      const fields = Object.getOwnPropertyDescriptors(args)
      if (!Object.hasOwn(fields, 'blocks') || !Object.hasOwn(fields.blocks, 'value')
        || !Object.hasOwn(fields, 'confirm_send') || !Object.hasOwn(fields.confirm_send, 'value')) fail('invalid_arguments')
      if (fields.confirm_send.value !== true) fail('explicit_confirmation_required')
      const content = displayWork(() => normalizeRichtextBlocks(fields.blocks.value))
      if (content.some(block => block.type === 'image') && !this.#config.allowFiles) fail('files_disabled')
      if (!(signal instanceof AbortSignal)) fail('invalid_arguments')
      signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      const scope = this.#scope(route)
      if (typeof runtime?.richtextActive !== 'function' || typeof runtime?.authorizeRichtext !== 'function'
        || runtime.richtextActive() !== true) fail('requester_not_allowed')
      await this.#access(scope, sender, true, signal, true)
      if (scope.thread) await this.#activeSendTopic(scope, sender, signal)
      if (await runtime.authorizeRichtext(signal) !== true || runtime.richtextActive() !== true || signal.aborted || this.#revoked) {
        fail('requester_not_allowed')
      }
      const raw = await this.#mutation('/v1/bot/sendMessage', { ...scope.route, payload: { type: 14, content } }, signal)
      const message_id = id(raw?.message_id)
      if (!message_id) fail('mutation_unconfirmed')
      return { ok: true, message_id, format: 'richtext', requiresFinalSummary: true,
        ...(raw.authority_changed === true && { authority_changed: true }) }
    }
    if (isOctoDiscoveryOperation(operation)) {
      if (!this.#discovery) fail('api_unsupported')
      return this.#discovery.dispatch(route, sender, operation, args, signal)
    }
    if (registryOperations.has(operation)) {
      const scope = this.#scope(route)
      const authorize = async active => {
        if (this.#revoked || active.aborted || !await runtime?.authorizeRegistry?.(active)) return false
        const access = await this.#access(scope, sender, definition.mutating, active, true)
        if (scope.thread) await this.#activeSendTopic(scope, sender, active)
        if (scope.group && operation === 'cards.registry.edit' && !admin(access.actor)) return false
        return !this.#revoked && !active.aborted && runtime.registryActive?.() === true
      }
      const call = (path, body, active) => this.#call(path, body, active, undefined, path === '/v1/bot/sendMessage')
      if (operation === 'cards.registry.list') {
        validate(args, definition.parameters)
        return discoverRegistryCards({ call, authorize, signal })
      }
      if (operation === 'cards.registry.send') return sendRegistryCard({ call, authorize, route: scope.route, args, signal })
      return editRegistryCard({ call, authorize, route: scope.route, botUid: this.#config.botUid, args, signal,
        readSource: (messageId, active) => this.#readMessage(scope, sender, messageId, active, false, undefined, undefined, true) })
    }
    const structuredEdit = structuredEdits.has(operation)
    const identityRead = identityReads.has(operation)
    const scopedRead = identityRead || webhookReads.has(operation)
    const clearRevisions = operation === 'messages.clear_card_revisions'
    const delegatedSearch = Object.hasOwn(authorizedSearchEndpoints, operation)
    const proactive = proactiveOperations.has(operation)
    const targetCard = operation === 'messages.send_target_card'
    if (scopedRead || webhookWrites.has(operation) || clearRevisions || delegatedSearch || proactive && !targetCard) args = readArguments(args, definition.parameters)
    if (operation === 'webhooks.test' && args.confirm_send !== true
      || clearRevisions && args.confirm_clear !== true
      || proactive && !targetCard && !proactiveReads.has(operation) && args.confirm_send !== true) fail('explicit_confirmation_required')
    if (proactive && (proactiveReads.has(operation) ? !webhookName(args.name)
      : operation === 'messages.send_target' ? !args.text.trim() || args.all && args.uids?.length
        : operation === 'messages.send_target_file' && (!args.path.trim() || args.caption !== undefined && !args.caption.trim()))) fail('invalid_arguments')
    if (proactive && !targetCard && !proactiveReads.has(operation) && args.target?.channel_type === 1 && (args.all || args.uids?.length)) fail('invalid_arguments')
    if (operation === 'webhooks.update') {
      if (args.name !== undefined) args.name = webhookName(args.name)
      if (Object.keys(args).length < 2 || args.name !== undefined && (!args.name || Buffer.byteLength(args.name, 'utf8') > 64)) fail('invalid_arguments')
    }
    if (identityRead) {
      const targets = operation === 'messages.user_info' ? [args.uid] : args.uids
      if (targets.some(target => ['.', '..'].includes(bareUID(target)))
        || new Set(targets.map(target => bareUID(target).toLowerCase())).size !== targets.length) fail('invalid_arguments')
    }
    if (operation === 'thread.rules.edit' && object(args)) {
      // The bot PUT rejects Go strings.TrimSpace(content) == ""; the DELETE
      // route is mounted only for authenticated users.
      const content = Object.getOwnPropertyDescriptor(args, 'content')?.value
      if (typeof content === 'string' && !/\P{White_Space}/u.test(content)) fail('thread_rules_clear_unsupported')
    }
    let prepared
    if (structuredEdit || targetCard) {
      // The recursive display DSL and richtext union use their bounded runtime
      // normalizers, not this module's flat-schema validator. Reject top-level
      // accessors/symbols/extra fields before reading or awaiting anything.
      if (!object(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
        || Reflect.ownKeys(args).some(key => typeof key !== 'string' || !Object.hasOwn(definition.parameters.properties, key)
          || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value'))
        || !targetCard && (!id(args.message_id) || typeof args.message_id !== 'string')) fail('invalid_arguments')
      const selected = targetCard ? readArguments({ target: args.target, confirm_send: args.confirm_send },
        schema({ target: proactiveTarget, confirm_send: { type: 'boolean' } }, ['target', 'confirm_send'])) : undefined
      if (targetCard && selected.confirm_send !== true) fail('explicit_confirmation_required')
      prepared = displayWork(() => targetCard || operation === 'messages.edit_display_card'
        ? normalizeDisplayCard({ ...(args.title !== undefined && { title: args.title }), blocks: args.blocks })
        : normalizeRichtextBlocks(args.blocks))
      // The prepared value is already detached. Do not serialize raw input
      // again (toJSON/accessors or cycles are not a second input channel).
      args = targetCard ? selected : { message_id: args.message_id }
      if (!(signal instanceof AbortSignal)) fail('invalid_arguments')
      signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    } else validate(args, definition.parameters)
    // Copy admitted inputs before the first await; do not retain mutable model args.
    args = JSON.parse(JSON.stringify(args))
    const search = Object.hasOwn(searchEndpoints, operation)
    if (search || delegatedSearch) validateSearch(operation, args)
    if (delegatedSearch) {
      if (new Set(args.targets.map(row => row.channel_type + ':' + row.channel_id)).size !== args.targets.length
        || args.targets.some(row => !ruleScope(row.channel_type, row.channel_id))
        || args.filters?.file_size_max > 0 && (args.filters.file_size_min ?? 0) > args.filters.file_size_max) fail('invalid_arguments')
    }
    if (['rules.edit', 'thread.rules.edit'].includes(operation) && Buffer.byteLength(args.content, 'utf8') > 10240) fail('invalid_arguments')
    if (operation === 'group.edit' && !Object.keys(args).length) fail('invalid_arguments')
    const scope = this.#scope(route)
    if (scope.group && definition.sharedTopicSend) {
      const authorizeOperator = runtime?.authorizeSharedSend
      if (typeof authorizeOperator === 'function') {
        return this.#sendFromShared(scope, sender, operation, args, signal, prepared, runtime, authorizeOperator)
      }
    }
    if (definition.privateOnly && scope.route.channel_type !== 1) fail(proactive ? 'private_operation_required' : 'private_search_required')
    if (!definition.available) fail(definition.unavailableReason)
    const voice = operation.startsWith('voice.context.')
    if (voice) this.#requireOwnerDM(scope, sender)
    if (operation === 'groups.create') this.#requireOwner(sender)
    if (clearRevisions) this.#requireOwner(sender)
    if (!scope.group && !voice && !search && !delegatedSearch && !proactive && !structuredEdit && !identityRead && !['inspect', 'messages.recent', 'messages.read', 'messages.edit', 'messages.notify',
      'messages.mark_read', 'messages.clear_card_revisions', 'space.members.search', 'groups.create'].includes(operation)) fail('group_required')
    const thread = operation.startsWith('thread.') ? this.#threadPath(scope, args) : undefined
    const access = await this.#access(scope, sender, definition.mutating, signal, scopedRead || delegatedSearch || proactive)
    const requireAdmin = () => { if (scope.group && !admin(access.actor)) fail('requester_admin_required') }

    if (operation === 'group.mention_preference') {
      await this.#currentReadScope(scope, access, signal)
      const raw = await this.#call(scope.root + '/mention_pref', undefined, signal)
      const bit = value => [true, false, 0, 1].includes(value)
      const effective = raw?.effective ?? raw?.no_mention
      const groupAllows = raw?.group_allow_no_mention
      if (!object(raw) || !bit(effective) || groupAllows !== undefined && !bit(groupAllows)) fail('invalid_api_response')
      const serverNoMention = flag(effective) && (groupAllows === undefined || flag(groupAllows))
      const pluginFollowsOcto = this.#config.mentionPolicy === 'octo' && this.#config.transport === 'websocket'
      return { group_no: scope.group, source: scope.thread ? 'parent_group' : 'group', server_no_mention: serverNoMention,
        group_allows_no_mention: groupAllows === undefined ? null : flag(groupAllows),
        plugin_follows_octo: pluginFollowsOcto, requires_mention: !serverNoMention || !pluginFollowsOcto }
    }

    if (delegatedSearch) return this.#authorizedSearch(scope, sender, operation, args, signal)
    if (proactive) return this.#proactive(scope, sender, operation, args, signal, prepared, runtime)

    if (identityRead) return this.#identities(scope, sender, operation, args, access, signal)
    if (webhookReads.has(operation)) return this.#webhooks(scope, sender, operation, args, access, signal)
    if (webhookWrites.has(operation)) return this.#writeWebhook(scope, sender, operation, args, access, signal)
    if (clearRevisions) {
      requireAdmin()
      const read = async () => {
        const message = await this.#readMessage(scope, sender, args.message_id, signal, false, 17)
        if (message.from_uid !== this.#config.botUid) fail('bot_message_required')
      }
      await read()
      // Recheck the actual card after authorization lookup, then current
      // authority before destructive history cleanup. No cached card identity.
      const fresh = await this.#access(scope, sender, true, signal)
      if (scope.group && !admin(fresh.actor)) fail('mutation_permission_changed')
      await read()
      this.#requireOwner(sender)
      const final = await this.#access(scope, sender, true, signal)
      if (scope.group && !admin(final.actor)) fail('mutation_permission_changed')
      this.#requireOwner(sender)
      const raw = await this.#mutation('/v1/bot/message/card/revisions/clear', { ...scope.route, message_id: args.message_id }, signal)
      if (!Number.isSafeInteger(raw?.cleared) || raw.cleared < 0) fail('mutation_unconfirmed')
      return { ok: true, message_id: args.message_id, cleared: raw.cleared, current_card_retained: true, audit_tombstone: true }
    }

    if (operation === 'inspect') return { ...scope.route, ...(access.group && { group: access.group }),
      requester_group_admin: admin(access.actor), bot_group_admin: admin(access.bot),
      bot_rules_admin: 'unknown', bot_rules_admin_reason: 'bot_members_endpoint_omits_bot_admin',
      broadcast_available: !!scope.group && admin(access.actor) && access.group.status === 1 }
    if (operation === 'groups.list') return [access.group]
    if (operation === 'members') return { members: access.rows.slice(0, args.limit ?? MAX_ROWS), total: access.rows.length,
      truncated: access.rows.length > (args.limit ?? MAX_ROWS) }
    if (operation === 'space.members.search') {
      if (await this.#principal(sender, signal) !== 'human') fail('requester_not_allowed')
      const size = args.limit ?? 20, page = args.page ?? 1
      const raw = await this.#call('/v1/bot/space/members?' + new URLSearchParams({ space_id: this.#config.spaceId,
        keyword: args.keyword.trim(), limit: size, page }), undefined, signal)
      const seen = new Set()
      const members = list(raw, size).map(row => {
        if (!validUid(row?.uid) || ![0, 1].includes(row.robot) || seen.has(row.uid)) fail('invalid_member_response')
        seen.add(row.uid)
        return { uid: row.uid, name: boundedText(row.name, 100) || row.uid, robot: row.robot }
      })
      return { members, page, more: members.length === size }
    }
    if (operation === 'groups.create') {
      // Name search is only discovery: its one-page LIKE results are not an
      // authorization cache. This exact lookup is mandatory for the owner and
      // every recipient, even when a previous search resolved their names.
      for (const target of new Set([sender, ...args.uids])) {
        if (await this.#principal(target, signal) !== 'human') fail('human_member_required')
      }
      await this.#access(scope, sender, true, signal)
      this.#requireOwner(sender)
      const raw = await this.#call('/v1/bot/createGroup', {
        name: args.name.trim(), members: args.uids, creator: sender, space_id: this.#config.spaceId,
      }, signal)
      if (typeof raw?.group_no !== 'string' || !/^[a-fA-F0-9]{32}$/.test(raw.group_no)
        || raw.group_no === scope.group || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200) fail('mutation_unconfirmed')
      const skipped = raw.skipped_members === undefined ? [] : list(raw.skipped_members, args.uids.length)
      if (skipped.some(target => !args.uids.includes(target)) || new Set(skipped).size !== skipped.length) fail('invalid_member_response')
      return { group_no: raw.group_no, name: boundedText(raw.name, 100), space_id: this.#config.spaceId,
        ...(skipped.length && { skipped_members: skipped }) }
    }
    if (operation === 'members.add' || operation === 'members.remove') {
      requireAdmin()
      const adding = operation === 'members.add'
      if (adding) {
        // Exact-Space eligibility prevents bot membership in some other Space
        // from turning a guessed UID into an invitation to this group.
        for (const target of args.uids) {
          if (await this.#principal(target, signal) !== 'human') fail('human_member_required')
        }
      }
      const fresh = await this.#access(scope, sender, true, signal)
      if (!admin(fresh.actor)) fail('mutation_permission_changed')
      if (!adding) {
        for (const target of args.uids) {
          const member = fresh.rows.find(row => row.uid === target)
          if (!member) fail('target_not_member')
          if (target === this.#config.botUid || member.role !== 0) fail('protected_member')
        }
      }
      // Add requires bot membership; remove additionally has an atomic
      // IsBotAdmin + privileged-target guard in groups.go. No role substitution.
      const action = adding ? 'add' : 'remove', countKey = adding ? 'added' : 'removed'
      const raw = await this.#call(scope.root + '/members/' + action, { members: args.uids }, signal)
      if (raw?.ok !== true || !Number.isSafeInteger(raw[countKey]) || raw[countKey] < 0
        || raw[countKey] > (adding ? args.uids.length : MAX_MEMBERS)) fail('mutation_unconfirmed')
      const skipped = adding && raw.skipped_bots !== undefined ? list(raw.skipped_bots, args.uids.length) : []
      if (skipped.some(target => !args.uids.includes(target)) || new Set(skipped).size !== skipped.length) fail('invalid_member_response')
      return { ok: true, group_no: scope.group, [countKey]: raw[countKey], ...(skipped.length && { skipped_bots: skipped }) }
    }
    if (voice) {
      if (await this.#principal(sender, signal) !== 'human') fail('requester_not_allowed')
      this.#requireOwnerDM(scope, sender)
      // This official endpoint deliberately selects the bot's primary active
      // Space. It has no channel/Space override; report its true scope explicitly.
      const voiceScope = 'bot_owner_primary_space'
      if (operation === 'voice.context.read') {
        const raw = await this.#call('/v1/bot/voice/context', undefined, signal)
        if (raw?.status !== 200 || typeof raw.has_context !== 'boolean' || typeof raw.context !== 'string'
          || raw.context.length > 20000 || Array.from(raw.context).length > 10000) fail('invalid_voice_response')
        this.#requireOwnerDM(scope, sender)
        return { scope: voiceScope, has_context: raw.has_context, context: raw.context, updated_at: boundedText(raw.updated_at, 100) }
      }
      const update = operation === 'voice.context.update'
      await this.#access(scope, sender, true, signal)
      this.#requireOwnerDM(scope, sender)
      const raw = await this.#call('/v1/bot/voice/context', update ? { context: args.context.trim() } : undefined, signal, update ? 'PUT' : 'DELETE')
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, scope: voiceScope }
    }
    if (operation === 'targets.resolve') {
      const query = args.name.trim().toLowerCase(), size = args.limit ?? 20
      const candidates = []
      if (access.group.name.toLowerCase().includes(query)) candidates.push({ kind: 'group', ...access.group, channel_id: scope.group, channel_type: 2 })
      let threads, more = false
      if (scope.thread) {
        if ((args.page ?? 1) !== 1) fail('invalid_arguments')
        threads = [this.#thread(await this.#call(scope.root + '/threads/' + scope.thread, undefined, signal), scope, scope.thread)]
      } else {
        const page = await this.#threads(scope, args.page ?? 1, size, signal)
        threads = page.threads; more = page.more
      }
      for (const row of threads) if (row.name.toLowerCase().includes(query)) candidates.push({ kind: 'thread', ...row })
      return { candidates: candidates.slice(0, size), searched_threads: threads.length, more: more || candidates.length > size }
    }
    if (operation === 'rules.read') return this.#rules(scope.root, signal)
    if (operation === 'rules.edit') {
      requireAdmin()
      return this.#editRules(scope.root, args.content, signal)
    }
    if (operation === 'group.edit') {
      requireAdmin()
      const raw = await this.#call(scope.root + '/info', args, signal, 'PUT')
      if (raw?.ok !== true) fail('mutation_unconfirmed')
      return { ok: true, group_no: scope.group }
    }
    if (operation === 'threads.list') {
      return this.#threads(scope, args.page ?? 1, args.limit ?? 20, signal)
    }
    if (operation === 'threads.create') {
      requireAdmin()
      if (!/^[a-fA-F0-9]{32}$/.test(scope.group)) fail('invalid_thread_scope')
      // No source_message_id or on_behalf_of: no cross-channel copying/grant escalation.
      const result = this.#thread(await this.#call(scope.root + '/threads', { name: args.name }, signal), scope)
      if (result.creator_uid !== this.#config.botUid) fail('mutation_unconfirmed')
      return result
    }
    if (thread) {
      const detail = this.#thread(await this.#call(thread.path, undefined, signal), scope, thread.selected)
      if (operation === 'thread.read') return detail
      if (operation === 'thread.rules.read') return this.#rules(thread.path, signal)
      if (operation === 'thread.members') {
        const rows = list(await this.#call(thread.path + '/members', undefined, signal), MAX_MEMBERS)
          .map(row => {
            if (!validUid(row?.uid) || ![0, 1].includes(row.role)) fail('invalid_member_response')
            return { uid: row.uid, name: boundedText(row.name, 100) || row.uid, role: row.role }
          })
        return { members: rows.slice(0, args.limit ?? MAX_ROWS), total: rows.length, truncated: rows.length > (args.limit ?? MAX_ROWS) }
      }
      const managed = ['thread.archive', 'thread.delete'].includes(operation)
      if (managed || operation === 'thread.rules.edit') requireAdmin()
      if (managed) {
        if (detail.creator_uid !== this.#config.botUid && !admin(access.bot)) fail('bot_permission_required')
      }
      if (operation === 'thread.leave' && detail.creator_uid === this.#config.botUid) fail('thread_creator_cannot_leave')
      if (operation === 'thread.join' && detail.status !== 1) fail('thread_not_active')
      // Membership is re-read after the target lookup, immediately before writing.
      const fresh = await this.#access(scope, sender, true, signal)
      if ((managed || operation === 'thread.rules.edit') && !admin(fresh.actor)) fail('mutation_permission_changed')
      if (managed && detail.creator_uid !== this.#config.botUid && !admin(fresh.bot)) fail('mutation_permission_changed')
      if (operation === 'thread.rules.edit') return this.#editRules(thread.path, args.content, signal)
      const result = operation === 'thread.delete'
        ? await this.#call(thread.path, undefined, signal, 'DELETE')
        : await this.#call(thread.path + '/' + operation.split('.')[1], {}, signal)
      if (result?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, short_id: thread.selected, actor_uid: this.#config.botUid }
    }
    if (operation === 'messages.read') return this.#readMessage(scope, sender, args.message_id, signal)
    if (operation === 'messages.recent') {
      if (args.before_seq === 1) return { messages: [], more: false }
      const size = args.limit ?? 20
      const raw = await this.#call('/v1/bot/messages/sync', { ...scope.route, limit: size, pull_mode: 0,
        start_message_seq: args.before_seq ? args.before_seq - 1 : 0, end_message_seq: 0 }, signal)
      if (!object(raw)) fail('invalid_api_response')
      const rows = list(raw.messages, size), messages = [], seen = new Set()
      for (const row of rows) {
        try {
          const message = this.#config.botKind === 'app'
            ? await this.#readMessage(scope, sender, id(row?.message_id), signal)
            : this.#message(row, scope, sender)
          if ((!args.before_seq || message.message_seq < args.before_seq) && !seen.has(message.message_id)) {
            seen.add(message.message_id); messages.push(message)
          }
        } catch (error) {
          if (!(error instanceof ChannelApiError)) throw error
          // Hidden, revoked, malformed and foreign records never become model context.
        }
      }
      return { messages: messages.sort((a, b) => a.message_seq - b.message_seq), more: flag(raw.more) || rows.length === size }
    }
    if (search) return this.#search(scope, sender, operation, args, signal)
    if (operation === 'messages.notify') {
      const uids = args.uids ?? []
      if (args.all && uids.length) fail('invalid_arguments')
      if (!scope.group && (args.all || uids.length)) fail('group_required')
      if (args.all) {
        requireAdmin()
        // The reviewed send API requires bot membership, not bot_admin, for
        // mention flags. The requester admin requirement is our explicit
        // broadcast policy; do not add a nonexistent platform bot-role gate.
      }
      if (uids.some(uid => !access.rows?.some(row => row.uid === uid))) fail('mention_not_member')
      const payload = notificationPayload(args.text, uids, access.rows, args.all)
      const raw = await this.#call('/v1/bot/sendMessage', { ...scope.route, payload }, signal)
      if (!id(raw?.message_id)) fail('mutation_unconfirmed')
      return { ok: true, message_id: id(raw.message_id), ...scope.route, text: payload.content,
        ...(payload.mention && { mention: payload.mention }) }
    }
    if (structuredEdit) {
      requireAdmin()
      const card = operation === 'messages.edit_display_card', type = card ? 17 : 14
      const readSource = async () => {
        const source = await this.#readMessage(scope, sender, args.message_id, signal, false, type)
        if (source.from_uid !== this.#config.botUid) fail('bot_message_required')
      }
      await readSource()
      let payload, fallbackBlocks
      if (card) {
        const profile = await this.#call('/v1/bot/card/profile', undefined, signal)
        const rendered = displayWork(() => renderDisplayCard(prepared, profile))
        payload = { type: 17, ...rendered.frame }
        fallbackBlocks = [...rendered.fallbacks]
      } else payload = { type: 14, content: prepared } // plain is server-owned.
      const content_edit = JSON.stringify(payload)
      // Re-read live visibility, ownership and BOTH original/effective types
      // after probing. Then recheck authorization immediately before mutation.
      await readSource()
      const fresh = await this.#access(scope, sender, true, signal)
      if (scope.group && !admin(fresh.actor)) fail('mutation_permission_changed')
      if (signal.aborted) fail('aborted')
      let raw
      try {
        raw = await this.#call('/v1/bot/message/edit', { ...scope.route, message_id: args.message_id, content_edit }, signal)
      } catch (error) {
        // Abort/timeout/5xx after dispatch can mean the write landed. Never
        // claim failure/success or retry; preserve only definitive 4xx refusals.
        if (['api_invalid_request', 'api_authentication_failed', 'api_permission_denied', 'api_not_found',
          'api_method_not_allowed', 'api_conflict', 'api_rate_limited'].includes(error?.code)) throw error
        fail('mutation_unconfirmed')
      }
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, message_id: args.message_id, format: card ? 'display_card' : 'richtext',
        ...(card && { fallbackBlocks, requiresFinalSummary: true }) }
    }
    if (operation === 'messages.edit') {
      requireAdmin()
      const message = await this.#readMessage(scope, sender, args.message_id, signal, false, 1)
      if (message.from_uid !== this.#config.botUid) fail('bot_message_required')
      if (message.type !== 1) fail('plain_text_message_required')
      const fresh = await this.#access(scope, sender, true, signal)
      if (scope.group && !admin(fresh.actor)) fail('mutation_permission_changed')
      const raw = await this.#call('/v1/bot/message/edit', { ...scope.route, message_id: args.message_id,
        content_edit: JSON.stringify({ type: 1, content: args.text }) }, signal)
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, message_id: args.message_id }
    }
    if (operation === 'messages.mark_read') {
      for (const messageId of args.message_ids) await this.#readMessage(scope, sender, messageId, signal)
      await this.#access(scope, sender, true, signal)
      const raw = await this.#call('/v1/bot/readReceipt', { ...scope.route, message_ids: args.message_ids }, signal)
      if (raw?.status !== 200) fail('mutation_unconfirmed')
      return { ok: true, actor_uid: this.#config.botUid, message_ids: args.message_ids }
    }
    fail('unknown_operation')
  }
}
