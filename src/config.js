import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { statSync } from 'node:fs'
import { ruleScope } from './rules.js'
import { DEFAULT_REPLY_TIMEOUT_MS, UNLIMITED_REPLY_TIMEOUT } from './reply-timeout.js'

export const validUid = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(s)
export const validBotIdentity = (config) => validUid(config?.botUid) && (config.botKind === 'app'
  ? /^app_[A-Za-z0-9_-]+_bot$/.test(config.botUid) && config.spaceId === null
  : (config.botKind === undefined || config.botKind === 'user') && validUid(config.spaceId))
export const validToken = (s) => typeof s === 'string' && /^(app|bf)_[A-Za-z0-9_-]{1,512}$/.test(s)
export const validProgressExpansion = value => ['collapsed', 'list', 'all'].includes(value)
export const validToolScope = (scope) => ['private', 'owner', 'admitted'].includes(scope)

export const OFFICIAL_OCTO_API = 'https://im.deepminer.com.cn/api'
const officialStorage = 'https://im-data-1255521909.cos.ap-beijing.myqcloud.com'
const officialUploadOrigins = Object.freeze([officialStorage])
const officialDownloadOrigins = Object.freeze(['https://cdn.deepminer.com.cn', officialStorage])

function scopeList(value, type) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > 50 || value.some(id => !ruleScope(type, id))) {
    throw new Error('invalid_channel_allowlist')
  }
  return new Set(value)
}

export function apiEndpoint(input) {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('api_base_must_be_https')
  }
  return url.href.replace(/\/+$/, '')
}

export function mediaOrigins(config) {
  let official = false
  try { official = apiEndpoint(config.apiBase) === OFFICIAL_OCTO_API } catch {}
  // Each explicit list (even an empty one) replaces its own default.
  return {
    download: config.mediaDownloadOrigins === undefined && official ? officialDownloadOrigins : config.mediaDownloadOrigins,
    upload: config.mediaUploadOrigins === undefined && official ? officialUploadOrigins : config.mediaUploadOrigins,
  }
}

export function privateStateDir(config, env = process.env) {
  return config.stateDir ?? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-channel-octo')
}

export function resolveConfig(config, env = process.env) {
  const apiBase = apiEndpoint(config.apiBase)
  const token = env.DSH_OCTO_BOT_TOKEN
  if (!validToken(token)) throw new Error('missing_bot_token')
  const app = token.startsWith('app_')
  if (config.botKind !== undefined && config.botKind !== (app ? 'app' : 'user')) throw new Error('bot_identity_mismatch')
  const identity = { botUid: config.botUid, spaceId: config.spaceId, ...(app ? { botKind: 'app' } : {}) }
  const groups = scopeList(config.allowedGroupIds, 2)
  const threads = scopeList(config.allowedThreadIds, 5)
  const senderPolicy = config.senderPolicy ?? 'allowlist'
  const channelPolicy = config.channelPolicy ?? 'allowlist'
  const mentionPolicy = config.mentionPolicy ?? 'required'
  const transport = config.transport ?? (app || mentionPolicy === 'octo' ? 'websocket' : 'events')
  const toolScope = config.toolScope === undefined ? 'private' : config.toolScope
  if (!validToolScope(toolScope)) throw new Error('invalid_tool_scope')
  if (!['allowlist', 'octo'].includes(senderPolicy) || !['allowlist', 'joined'].includes(channelPolicy)
    || !['required', 'octo'].includes(mentionPolicy) || !['events', 'websocket'].includes(transport)) {
    throw new Error('invalid_access_policy')
  }
  if (mentionPolicy === 'octo' && transport !== 'websocket') throw new Error('mention_free_requires_websocket')
  if (app && transport !== 'websocket') throw new Error('app_bot_requires_websocket')
  if ((groups.size || threads.size || channelPolicy === 'joined' || mentionPolicy === 'octo') && !token.startsWith('bf_')) {
    throw new Error('group_and_thread_require_user_bot')
  }
  if (channelPolicy === 'joined' && (groups.size || threads.size)) throw new Error('ambiguous_channel_policy')
  const threadRuleMode = config.threadRuleMode ?? 'thread-only'
  if (!['thread-only', 'inherit-group'].includes(threadRuleMode)) throw new Error('invalid_thread_rule_mode')
  if (!validBotIdentity(identity)) throw new Error('missing_bot_identity')
  const allowedUids = config.allowedUids ?? []
  if (!Array.isArray(allowedUids) || allowedUids.length > 20
    || (senderPolicy === 'allowlist' ? !allowedUids.length : allowedUids.length > 0)
    || allowedUids.some(uid => !validUid(uid) || uid === config.botUid)) throw new Error('invalid_user_allowlist')
  const stateDir = privateStateDir(config, env)
  if (!isAbsolute(stateDir) || typeof config.cwd !== 'string' || !isAbsolute(config.cwd) || !statSync(config.cwd).isDirectory()) {
    throw new Error('invalid_working_or_state_directory')
  }
  const waitSeconds = config.waitSeconds ?? 15
  const timeoutMs = config.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS
  const progress = config.progress ?? 'auto'
  const progressExpansion = config.progressExpansion ?? 'collapsed'
  if (!validProgressExpansion(progressExpansion)) throw new Error('invalid_progress_expansion')
  const maxConcurrentTurns = config.maxConcurrentTurns ?? 4
  if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1 || maxConcurrentTurns > 8) {
    throw new Error('invalid_concurrent_turns')
  }
  const oboSendContract = config.oboSendContract
  if (oboSendContract !== undefined && (typeof oboSendContract !== 'string' || !/^octo-server:[a-f0-9]{40}$/.test(oboSendContract))) {
    throw new Error('invalid_obo_send_contract')
  }
  if (!['auto', 'typing', 'off'].includes(progress)) throw new Error('invalid_progress_mode')
  if (!Number.isInteger(waitSeconds) || waitSeconds < 5 || waitSeconds > 30
    || (timeoutMs !== UNLIMITED_REPLY_TIMEOUT && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000))) {
    throw new Error('invalid_timeouts')
  }
  return {
    apiBase, token, stateDir, waitSeconds, timeoutMs, cwd: config.cwd,
    ...identity, allowed: new Set(allowedUids), groups, threads, threadRuleMode,
    senderPolicy, channelPolicy, mentionPolicy, transport, progress, progressExpansion, toolScope, maxConcurrentTurns,
    oboSendContract,
    mediaDownloadOrigins: config.mediaDownloadOrigins, mediaUploadOrigins: config.mediaUploadOrigins,
    mediaMaxBytes: config.mediaMaxBytes, mediaTimeoutMs: config.mediaTimeoutMs,
  }
}
