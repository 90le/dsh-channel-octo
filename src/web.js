import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './config.js'

const path = '/api/dsh-channel-octo'
const editable = ['senderPolicy', 'channelPolicy', 'mentionPolicy', 'threadRuleMode',
  'allowedUids', 'allowedGroupIds', 'allowedThreadIds', 'progress', 'timeoutMs']

function overrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !editable.includes(key))) throw new Error('invalid_settings')
  return Object.fromEntries(editable.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}

export function loadSettings(base, stateDir) {
  const file = join(stateDir, 'web-settings.json')
  let saved = {}
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 16_384 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('invalid_settings_file')
    }
    saved = overrides(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // Keep connection and credential destination controlled by the deployment.
  const resolve = changes => resolveConfig({ ...base, ...changes })
  const config = resolve(saved)
  let revision = randomUUID()
  return {
    config,
    revision: () => revision,
    save(input, expected) {
      if (expected !== revision) throw new Error('settings_changed')
      const changes = { ...saved, ...overrides(input) }
      const candidate = resolve(changes)
      if (candidate.transport !== config.transport) throw new Error('transport_managed_by_host')
      const pending = file + '.' + randomUUID()
      try {
        writeFileSync(pending, JSON.stringify(changes, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true })
        renameSync(pending, file)
      } finally { try { unlinkSync(pending) } catch {} }
      Object.assign(config, candidate)
      saved = changes
      revision = randomUUID()
    },
  }
}

function view(config) {
  if (!config) return null
  const { botUid, spaceId, apiBase, cwd, transport, senderPolicy, channelPolicy,
    mentionPolicy, threadRuleMode, progress, timeoutMs, allowed, groups, threads } = config
  return { botUid, spaceId, apiBase, cwd, transport, senderPolicy, channelPolicy,
    mentionPolicy, threadRuleMode, progress, timeoutMs,
    allowedUids: [...allowed], allowedGroupIds: [...groups], allowedThreadIds: [...threads] }
}

async function body(req) {
  let size = 0
  const chunks = []
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length
    if (size > 16_384) { req.resume(); throw new Error('invalid_settings') }
    chunks.push(part)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function registerWeb(ctx, state) {
  return ctx.webServer.register({ kind: 'prefix', path, handler: async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection !== 'function') return send(503, { error: 'auth_unavailable' })
      const rejected = connection.requestRejection(req)
      if (rejected !== undefined) return send(rejected, { error: 'authentication_required' })
      const target = new URL(req.url ?? '/', 'http://localhost').pathname
      if (req.method === 'GET' && target === path) {
        return send(200, { status: state.status, config: view(state.settings?.config),
          revision: state.settings?.revision(), ...(state.store?.overview() ?? { conversations: [], counts: [] }) })
      }
      if (req.method !== 'PUT' || target !== path + '/settings') return send(404, { error: 'not_found' })
      if (req.headers['x-dsh-octo-client'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site'
        || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return send(403, { error: 'forbidden' })
      if (!state.settings || !state.store) return send(409, { error: 'channel_not_configured' })
      try {
        const input = await body(req)
        state.settings.save(input?.settings, input?.revision)
      } catch (error) {
        if (error?.message === 'settings_changed') return send(409, { error: 'settings_changed' })
        if (error?.message === 'transport_managed_by_host') return send(400, { error: 'transport_managed_by_host' })
        if (error?.code && ['EACCES', 'EROFS', 'ENOSPC', 'EPERM'].includes(error.code)) return send(500, { error: 'settings_not_saved' })
        return send(400, { error: 'invalid_settings' })
      }
      return send(200, { config: view(state.settings.config), revision: state.settings.revision() })
    } catch { return send(500, { error: 'channel_status_unavailable' }) }
  } })
}
