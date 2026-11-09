import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { statSync } from 'node:fs'

const validUid = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(s)

export function resolveConfig(config, env = process.env) {
  const url = new URL(config.apiBase)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('api_base_must_be_https')
  }
  const apiBase = url.href.replace(/\/+$/, '')
  const token = env.DSH_OCTO_BOT_TOKEN
  if (!/^(app|bf)_[A-Za-z0-9_-]+$/.test(token ?? '')) throw new Error('missing_bot_token')
  if (!validUid(config.botUid) || !validUid(config.spaceId)) throw new Error('missing_bot_identity')
  if (!Array.isArray(config.allowedUids) || !config.allowedUids.length || config.allowedUids.length > 20
    || config.allowedUids.some(uid => !validUid(uid) || uid === config.botUid)) throw new Error('invalid_user_allowlist')
  const stateDir = config.stateDir ?? join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-channel-octo')
  if (!isAbsolute(stateDir) || typeof config.cwd !== 'string' || !isAbsolute(config.cwd) || !statSync(config.cwd).isDirectory()) {
    throw new Error('invalid_working_or_state_directory')
  }
  const waitSeconds = config.waitSeconds ?? 15
  const timeoutMs = config.timeoutMs ?? 120_000
  if (!Number.isInteger(waitSeconds) || waitSeconds < 5 || waitSeconds > 30
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('invalid_timeouts')
  return {
    apiBase, token, stateDir, waitSeconds, timeoutMs, cwd: config.cwd,
    botUid: config.botUid, spaceId: config.spaceId, allowed: new Set(config.allowedUids),
  }
}
