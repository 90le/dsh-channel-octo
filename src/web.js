import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './config.js'
import { webhookErrors } from './webhook-admin.js'

const path = '/api/dsh-channel-octo'
const assistantView = readFileSync(new URL('./assistant-view.js', import.meta.url), 'utf8')
const editor = readFileSync(new URL('./account-editor.js', import.meta.url), 'utf8')
const view = readFileSync(new URL('./account-view.js', import.meta.url), 'utf8')
const webhookView = readFileSync(new URL('./webhook-view.js', import.meta.url), 'utf8')
const webhookChatView = readFileSync(new URL('./webhook-chat-view.js', import.meta.url), 'utf8')
const uiVersion = createHash('sha256').update(assistantView).update(editor).update(view).update(webhookView).update(webhookChatView).digest('hex').slice(0, 16)
const modules = new Map([[path + '/assistant-view.js', assistantView],
  [path + '/account-editor.js', editor.replace('./assistant-view.js', './assistant-view.js?v=' + uiVersion)],
  [path + '/webhook-chat-view.js', webhookChatView],
  [path + '/webhook-view.js', webhookView.replace('./webhook-chat-view.js', './webhook-chat-view.js?v=' + uiVersion)],
  [path + '/account-view.js', view.replace('./account-editor.js', './account-editor.js?v=' + uiVersion)
    .replace('./webhook-view.js', './webhook-view.js?v=' + uiVersion)]])
const editable = ['senderPolicy', 'channelPolicy', 'mentionPolicy', 'threadRuleMode',
  'allowedUids', 'allowedGroupIds', 'allowedThreadIds', 'progress', 'timeoutMs', 'maxConcurrentTurns']

function overrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !editable.includes(key))) throw new Error('invalid_settings')
  return Object.fromEntries(editable.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}

export function loadSettings(base, stateDir, token, validate = () => {}, admission = {}) {
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
  const resolve = changes => {
    const config = resolveConfig({ ...base, ...changes, ...admission }, token === undefined ? process.env
      : { ...process.env, DSH_OCTO_BOT_TOKEN: token })
    validate(config)
    return config
  }
  let config = resolve(saved)
  let revision = randomUUID()
  return {
    get config() { return config },
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
      config = candidate
      saved = changes
      revision = randomUUID()
    },
  }
}

export function channelView(config) {
  if (!config) return null
  const { botUid, spaceId, apiBase, cwd, transport, senderPolicy, channelPolicy,
    mentionPolicy, threadRuleMode, progress, timeoutMs, maxConcurrentTurns, allowed, groups, threads } = config
  return { botUid, spaceId, ...(config.botKind === 'app' && { botKind: 'app' }), apiBase, cwd, transport, senderPolicy, channelPolicy,
    mentionPolicy, threadRuleMode, progress, timeoutMs, maxConcurrentTurns,
    allowedUids: [...allowed], allowedGroupIds: [...groups], allowedThreadIds: [...threads] }
}

async function body(req, limit = 16_384) {
  let size = 0
  const chunks = []
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length
    if (size > limit) { req.resume(); throw new Error('invalid_settings') }
    chunks.push(part)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const accountErrors = {
  ...webhookErrors,
  accounts_unavailable: 503, credential_provider_unavailable: 503,
  assistant_not_found: 404, assistant_bound: 409, invalid_assistant: 400,
  invalid_instruction: 400, instruction_changed: 409, instruction_unavailable: 500,
  account_not_found: 404, account_changed: 409, account_transition: 409, duplicate_bot: 409,
  invalid_account: 400, invalid_bot_token: 400, bot_identity_mismatch: 400, bot_verification_failed: 400,
  workspace_unavailable: 400, model_unavailable: 400, reasoning_unavailable: 400, permission_unavailable: 400,
  permission_requires_allowlist: 400, settings_changed: 409, channel_not_configured: 409,
  transport_managed_by_host: 400, invalid_settings: 400, invalid_concurrent_turns: 400, settings_not_saved: 500,
  invalid_bot_commands: 400, bot_commands_failed: 502,
  invalid_server: 400,
  app_bot_operation_unavailable: 400,
}

export function registerWeb(ctx, accounts) {
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
        await accounts.reconcileSessions?.()
        accounts.refreshNavigation?.()
        return send(200, { ...accounts.overview(), accountUiVersion: uiVersion })
      }
      if (req.method === 'GET' && modules.has(target)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(modules.get(target))
      }
      if (req.method === 'GET' && target === path + '/account-options') return send(200, await accounts.options())
      const assistant = /^\/api\/dsh-channel-octo\/assistants\/(legacy|[a-f0-9-]{36})$/.exec(target)
      const instructions = /^\/api\/dsh-channel-octo\/assistants\/(legacy|[a-f0-9-]{36})\/instructions(?:\/(AGENTS\.md|SOUL\.md))?$/.exec(target)
      const trustedEditor = req.headers['x-dsh-octo-client'] === '1' && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])
      if (req.method === 'GET' && instructions && !instructions[2]) {
        if (!trustedEditor) return send(403, { error: 'forbidden' })
        try { return send(200, accounts.workspaceInstructions(instructions[1])) }
        catch (error) {
          const code = Object.hasOwn(accountErrors, error?.message) ? error.message : 'instruction_unavailable'
          return send(accountErrors[code], { error: code })
        }
      }
      if (req.method === 'GET' && assistant) {
        try { return send(200, accounts.assistantDetail(assistant[1])) }
        catch { return send(404, { error: 'assistant_not_found' }) }
      }
      if (!['POST', 'PUT'].includes(req.method)) return send(404, { error: 'not_found' })
      if (!trustedEditor
        || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return send(403, { error: 'forbidden' })
      try {
        if (req.method === 'PUT' && instructions?.[2]) {
          const input = await body(req, 210_000)
          try { return send(200, await accounts.saveWorkspaceInstruction(instructions[1], instructions[2], input)) }
          catch (error) {
            const code = Object.hasOwn(accountErrors, error?.message) ? error.message : 'instruction_unavailable'
            return send(accountErrors[code], { error: code })
          }
        }
        const creatingAssistant = req.method === 'POST' && target === path + '/assistants'
        const editingAssistant = req.method === 'PUT' && assistant
        const savingAccount = req.method === 'POST' && target === path + '/accounts'
          || req.method === 'PUT' && /^\/api\/dsh-channel-octo\/accounts\/(legacy|[a-f0-9-]{36})$/.test(target)
        const input = await body(req, creatingAssistant || editingAssistant || savingAccount ? 110_000 : undefined)
        if (req.method === 'PUT' && target === path + '/server') return send(200, await accounts.saveServer(input))
        if (creatingAssistant || editingAssistant) return send(200, await accounts.saveAssistant(assistant?.[1], input))
        if (req.method === 'POST' && target === path + '/accounts/verify') {
          return send(200, await accounts.verify(input?.token, input?.accountId))
        }
        const match = /^\/api\/dsh-channel-octo\/accounts\/(legacy|[a-f0-9-]{36})(?:\/(settings|state|diagnose|reconnect|remove|commands|webhooks))?$/.exec(target)
        if (req.method === 'POST' && match?.[2] === 'webhooks') {
          const controller = new AbortController()
          const disconnected = () => { if (!res.writableEnded) controller.abort() }
          res.once?.('close', disconnected)
          if (res.destroyed) disconnected()
          const rejection = () => {
            const current = ctx.get('connection')
            return typeof current?.requestRejection === 'function' ? current.requestRejection(req) : 503
          }
          const authorized = () => !controller.signal.aborted && rejection() === undefined
          try {
            const result = await accounts.manageWebhooks(match[1], input, controller.signal, authorized)
            // Recheck the host session before disclosing a one-time credential.
            if (controller.signal.aborted) return
            const rejected = rejection()
            return rejected === undefined ? send(200, result) : send(rejected, { error: 'authentication_required' })
          } catch (error) {
            if (controller.signal.aborted) return
            const rejected = rejection()
            if (rejected !== undefined) return send(rejected, { error: 'authentication_required' })
            throw error
          } finally { res.off?.('close', disconnected) }
        }
        if (req.method === 'PUT' && (target === path + '/settings' || match?.[2] === 'settings')) {
          return send(200, await accounts.saveRules(match?.[1], input))
        }
        if (req.method === 'PUT' && match?.[2] === 'state') return send(200, await accounts.setEnabled(match[1], input))
        if (req.method === 'POST' && match?.[2] === 'diagnose') return send(200, await accounts.diagnose(match[1]))
        if (req.method === 'POST' && match?.[2] === 'reconnect') return send(200, await accounts.reconnect(match[1], input))
        if (req.method === 'POST' && match?.[2] === 'remove') return send(200, await accounts.remove(match[1], input))
        if (req.method === 'POST' && match?.[2] === 'commands') return send(200, await accounts.updateBotCommands(match[1], input))
        if (req.method === 'POST' && target === path + '/accounts' || req.method === 'PUT' && match && !match[2]) {
          return send(200, await accounts.save(match?.[1], input))
        }
        return send(404, { error: 'not_found' })
      } catch (error) {
        if (error?.code && ['EACCES', 'EROFS', 'ENOSPC', 'EPERM'].includes(error.code)) return send(500, { error: 'settings_not_saved' })
        const code = Object.hasOwn(accountErrors, error?.message) ? error.message : 'invalid_settings'
        return send(accountErrors[code], { error: code })
      }
    } catch { return send(500, { error: 'channel_status_unavailable' }) }
  } })
}
