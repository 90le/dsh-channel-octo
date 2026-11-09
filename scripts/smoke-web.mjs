// Opt-in: uses an installed, exact-version DSH CLI and a temporary Web profile.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

if (!process.argv[2] || !process.env.npm_execpath) {
  throw new Error('Usage: npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js')
}
const cli = resolve(process.argv[2])
const project = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = realpathSync(tmpdir())
const home = mkdtempSync(join(temporary, 'dsh-octo-smoke-'))
const state = join(home, 'octo-state')
const npm = process.env.npm_execpath
const wire = process.argv[3] !== 'events'
const browserModule = process.argv[4]
const browserExecutable = process.argv[5]
const appBotSmoke = process.env.DSH_OCTO_SMOKE_APP_BOT === '1'
const ownerSmoke = process.env.DSH_OCTO_SMOKE_OWNER === '1'
const groupToolsSmoke = process.env.DSH_OCTO_SMOKE_GROUP_TOOLS === '1'
const delegatedSmoke = process.env.DSH_OCTO_SMOKE_DELEGATED_SEARCH === '1'
const deferredSmoke = process.env.DSH_OCTO_SMOKE_DEFERRED === '1'
if (delegatedSmoke && !ownerSmoke) throw new Error('Delegated search smoke requires owner fixture mode')
if (groupToolsSmoke && !ownerSmoke) throw new Error('Group tools smoke requires owner mode')
const deleteSmoke = process.env.DSH_OCTO_SMOKE_DELETE === '1'
const includeImConnect = !deferredSmoke && !appBotSmoke && !ownerSmoke && process.env.DSH_OCTO_SMOKE_CORE_ONLY !== '1'
if (appBotSmoke && (ownerSmoke || groupToolsSmoke || delegatedSmoke || deleteSmoke || !wire || browserModule)) {
  throw new Error('AppBot smoke requires its own headless WebSocket scenario; do not combine USER fixture modes')
}
if (deleteSmoke && (ownerSmoke || browserModule)) throw new Error('Deletion smoke uses an isolated headless profile')
if (ownerSmoke && (!wire || browserModule)) throw new Error('Owner tool smoke uses headless WebSocket')
const screenshots = process.env.DSH_OCTO_SMOKE_SCREENSHOTS
const codexUi = process.env.DSH_OCTO_SMOKE_CODEX_UI
const automation = process.env.DSH_OCTO_SMOKE_AUTOMATION
if (deferredSmoke && (appBotSmoke || ownerSmoke || groupToolsSmoke || delegatedSmoke || deleteSmoke
  || !wire || browserModule || codexUi || automation || process.env.DSH_OCTO_SMOKE_WEBHOOK_UI === '1')) {
  throw new Error('Deferred smoke requires its own headless WebSocket scenario')
}
if (appBotSmoke && (codexUi || automation)) throw new Error('AppBot smoke uses only the isolated Octo plugin')
if (codexUi && !/^\d+\.\d+\.\d+$/.test(codexUi)) throw new Error('Set an exact Codex UI version')
if (automation && !/^\d+\.\d+\.\d+$/.test(automation)) throw new Error('Set an exact automation version')
if (browserModule && (!browserExecutable || !wire)) throw new Error('Browser smoke needs WebSocket and an executable path')
const browserReady = join(home, 'browser-ready')
const observer = join(home, 'fixture-observer.mjs')
// Keep filesystem/runtime discovery variables, but never pass existing API keys to the fixture process.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG|npm_config_cache)$/i.test(key)))
Object.assign(env, {
  DSH_HOME: home, DSH_OCTO_BOT_TOKEN: appBotSmoke ? 'app_SECRETfixture' : 'bf_fixture', DEEPSEEK_API_KEY: 'sk-fixture-for-local-smoke',
  DSH_TELEMETRY_DISABLED: '1',
  DSH_OCTO_FIXTURE_APP_BOT: appBotSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_OWNER: ownerSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_GROUP_TOOLS: groupToolsSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_DELEGATED_SEARCH: delegatedSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_DELETE: deleteSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_DEFERRED: deferredSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_STATE: state,
  DSH_OCTO_FIXTURE_WIRE: wire ? '1' : '0',
  ...(browserModule && { DSH_OCTO_BROWSER_READY: browserReady }),
})
const common = { cwd: project, env, windowsHide: true, encoding: 'utf8', timeout: 50_000 }
function node(args, timeout = 50_000) {
  const result = spawnSync(process.execPath, args, { ...common, timeout })
  if (result.status !== 0) throw new Error('command failed: ' + (result.error?.message ?? result.stderr.slice(-2500)))
  return result.stdout
}
function sentCount() {
  let db
  try {
    db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
    return db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='sent'").get().n
  } catch { return 0 }
  finally { db?.close() }
}
async function assertAppBotSmoke(child, output, deadline) {
  const markers = ['REGISTER_OK', 'WIRE_ACK_OK', 'HUMAN_OK=fixture-user', 'HUMAN_OK=fixture-owner',
    'FRIEND_OK=fixture-user', 'FRIEND_OK=fixture-owner', 'NONOWNER_TEXT_ONLY_OK', 'ORDINARY_OK',
    'MESSAGE_GET_OK=fixture-user:1', 'MESSAGE_GET_OK=fixture-owner:2', 'MESSAGE_GET_OK=fixture-owner:720',
    'CHANNEL_TOOLS_OK=11',
    'QUESTION_CARD_OK', 'INVALID_CALLBACKS_IGNORED', 'CALLBACK_ACK_OK', 'QUESTION_FEEDBACK_OK',
    'UPLOAD_OK', 'FILE_OK', 'FULL_CAPTION_OK', 'DISPLAY_OK', 'FINAL_OK',
    ...[0, 1, 2, 3, 4].map(step => 'TOOL_SCOPE_OK=' + step),
    ...[1, 2, 3, 4].map(step => 'NATIVE_TOOL_OK=' + step)].map(marker => 'FIXTURE_APP_' + marker)
  const complete = () => sentCount() === 2 && markers.every(marker => output().includes(marker))
  while (Date.now() < deadline && child.exitCode === null && !complete() && !output().includes('FIXTURE_APP_FAIL=')) await delay(100)
  if (!complete() || output().includes('FIXTURE_APP_FAIL=')) {
    let jobs = []
    try {
      const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
      try { jobs = db.prepare('SELECT message_id,state,issue FROM jobs ORDER BY seq').all() } finally { db.close() }
    } catch {}
    throw new Error('AppBot native fixture failed; missing: ' + markers.filter(marker => !output().includes(marker)).join(', ')
      + '; jobs: ' + JSON.stringify(jobs) + '\n' + output().replace(/https?:\/\/\S+/g, '[url]'))
  }
  if ((output().match(/FIXTURE_APP_REGISTER_OK/g) ?? []).length !== 1
    || readFileSync(join(home, 'appbot-tool-fixture.txt'), 'utf8') !== 'written by native DSH for AppBot') {
    throw new Error('AppBot registration cache or native workspace write was not confirmed')
  }
  const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
  try {
    const jobs = db.prepare('SELECT message_id,sender,channel_type,channel_id,session_id,state,result_id,input FROM jobs ORDER BY seq').all()
    const ordinary = jobs.find(job => job.message_id === '1'), owner = jobs.find(job => job.message_id === '2')
    const answer = jobs.find(job => job.message_id === 'card_action:9205')
    if (jobs.length !== 3 || !ordinary?.session_id || !owner?.session_id || ordinary.session_id === owner.session_id
      || ordinary.state !== 'sent' || ordinary.result_id !== '710' || ordinary.sender !== 'fixture-user'
      || owner.state !== 'sent' || owner.result_id !== '741' || owner.sender !== 'fixture-owner'
      || jobs.some(job => job.channel_type !== 1 || job.channel_id !== job.sender)
      || answer?.session_id !== owner.session_id || answer.state !== 'ignored' || answer.input !== '' || answer.sender !== owner.sender) {
      throw new Error('AppBot DM isolation, group/topic rejection or native callback session binding failed')
    }
    const card = db.prepare("SELECT claimed,binding FROM card_bindings WHERE message_id='720'").get()
    const binding = card && JSON.parse(card.binding)
    if (card?.claimed !== 1 || binding?.questionFeedback !== 1 || binding?.spaceId !== null
      || binding.account !== JSON.stringify(['https://octo-fixture.invalid/api', null, 'app_fixture_bot'])
      || binding.messageId !== '720' || binding.operatorUid !== 'fixture-owner'
      || binding.route.channel_type !== 1 || binding.route.channel_id !== 'fixture-owner') {
      throw new Error('AppBot callback did not retain its account, null Space, operator, DM and exact card binding')
    }
  } finally { db.close() }
  const stored = readFileSync(join(state, 'accounts.json'), 'utf8')
  const account = JSON.parse(stored).accounts.find(row => row.id === 'legacy')
  if (account?.botKind !== 'app' || account.botUid !== 'app_fixture_bot' || account.spaceId !== null
    || account.transport !== 'websocket' || account.senderPolicy !== 'octo' || account.permission !== 'workspace-write'
    || stored.includes('app_SECRETfixture') || Object.hasOwn(account, 'ownerUid')) {
    throw new Error('AppBot account identity, server-managed admission or credential isolation changed')
  }
  console.log('PASS: native AppBot register identity and cached encrypted WebSocket; no verify-bot or invented Space.')
  console.log('PASS: active-human batch lookup and friendship sync; ordinary DM text-only, registered owner native workspace tools; isolated DM sessions.')
  console.log('PASS: official person-message GET verified both DM triggers and the stored question card against their exact peers and IDs.')
  console.log('PASS: owner menu contains exactly 11 App DM channel operations plus display-card, waiting-form and deferred publish/manage tools.')
  console.log('PASS: native question-card callback with server Space, wrong operator/route/message/nonce rejection, write/present, file plus full Markdown caption, display receipt and final.')
  console.log('PASS: group/topic inputs rejected; unavailable group/search/proactive/voice tools absent; fake local APIs only.')
}
let child, browser
try {
  if (node([cli, '--version']).trim() !== '0.2.1-rc.5') throw new Error('Expected DSH 0.2.1-rc.5')
  const packed = JSON.parse(node([npm, 'pack', '--json', '--pack-destination', home]))
  const { filename } = Array.isArray(packed) ? packed[0] : packed['dsh-channel-octo']
  if (typeof filename !== 'string' || !/^dsh-channel-octo-\d+\.\d+\.\d+\.tgz$/.test(filename)) throw new Error('Unexpected fixture package')
  for (const spec of [join(home, filename), ...(includeImConnect ? ['@michengai/dsh-im-connect@1.0.30'] : []),
    ...(codexUi ? ['@michengai/dsh-codex-ui@' + codexUi] : []),
    ...(automation ? ['@michengai/dsh-automation@' + automation] : [])]) {
    node([cli, 'plugin', '--profile', 'web', 'add', spec, '--registry=https://registry.npmjs.org/'], 180_000)
  }
  const q = JSON.stringify
  writeFileSync(observer, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
export const name = 'octo-fixture-observer'
export const inject = ['agents', 'agentPresets', 'agentDefaultModel']
export function apply(ctx) {
  if (process.env.DSH_OCTO_FIXTURE_DEFERRED === '1') ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      console.log('FIXTURE_DEFERRED_NATIVE=' + JSON.stringify({ type: event.type, sessionId: session.id,
        reason: event.data.reason?.kind }))
    }
    if (event.type === 'tool/result' && event.data.message?.isError) console.error('FIXTURE_DEFERRED_FAIL=NATIVE_TOOL_RESULT')
  }, { global: true })
  if (process.env.DSH_OCTO_FIXTURE_DELETE === '1') ctx.on('session/event', (_session, event) => {
    const content = event.type === 'user/message' && event.data.content
    if (Array.isArray(content) && content.some(part => part.type === 'text' && part.text?.includes('fixture prompt 2'))) {
      console.log('FIXTURE_NATIVE_IMAGE=' + content.some(part => part.type === 'image' && part.attachment))
    }
  }, { global: true })
  ctx.logger.exporter({ levels: { default: 2 }, export: ({ name, args }) => {
    if (name === 'dsh-channel-octo' && ['dsh_session_reused', 'session_busy', 'session_preset_conflict', 'bot_verified', 'octo_ws_connected', 'file_not_presented', 'file_tools_unavailable', 'worker_stopped: internal_error',
      'delivery_not_confirmed', 'file_delivery_not_confirmed', 'agent_run_not_confirmed', 'no_confirmed_final_text', 'shared_turn_not_forwarded', 'workspace_attach_failed',
      'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context'].includes(args?.[0])) {
      console.log('FIXTURE_DSH=' + args[0])
    }
  } })
  if (process.env.DSH_OCTO_FIXTURE_OWNER === '1') {
    if (process.env.DSH_OCTO_FIXTURE_GROUP_TOOLS === '1') ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'write' && exec.arguments?.file_path === 'group-tool-fixture.txt') {
        console.log('FIXTURE_NATIVE_APPROVAL_REQUEST')
        return { kind: 'ask', reason: 'Synthetic one-time group file approval' }
      }
      return next()
    }, { prepend: true })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result') console.log('FIXTURE_TOOL=' + (event.data.message?.isError ? 'failed' : 'ok'))
      if (event.type === 'tool/result' && event.data.message?.isError) {
        const known = JSON.stringify(event.data.message).match(/(?:channel_tool_failed: )([a-z_]+)/)?.[1]
        console.log('FIXTURE_TOOL_ERROR=' + (known || 'unclassified'))
      }
      if (event.type === 'turn/end') console.log('FIXTURE_END=' + event.data.reason?.kind)
    }, { global: true })
  }
  const marker = process.env.DSH_OCTO_BROWSER_READY
  if (marker) ctx.effect(() => {
    let handle
    const timer = setInterval(async () => {
      if (!existsSync(marker)) return
      clearInterval(timer)
      const id = readFileSync(marker, 'utf8')
      try {
        if (!ctx.agents.get(id)) handle = await ctx.agents.resume({
          resumeSessionId: id, agentOptions: ctx.agentDefaultModel.currentSelection(),
          setup: async scoped => { await ctx.agentPresets.mount(scoped, 'octo-text') },
        })
        writeFileSync(marker + '.owned', '')
      } catch (error) { console.error('FIXTURE_OWNER_FAILED=' + error.name) }
    }, 100)
    return async () => { clearInterval(timer); await handle?.dispose() }
  })
}
`)
  if (ownerSmoke || deferredSmoke) {
    mkdirSync(state, { mode: 0o700 })
    writeFileSync(join(state, 'accounts.json'), JSON.stringify({
      version: 1, endpoint: 'https://octo-fixture.invalid/api', accounts: [{
        id: 'legacy', botUid: 'fixture-bot', spaceId: 'fixture-space', cwd: home,
        label: 'Octo Bot', enabled: true, permission: 'workspace-write', agentPreset: 'standard',
        senderPolicy: 'octo', transport: 'websocket', allowFiles: true, sendMode: 'steer',
        toolScope: groupToolsSmoke ? 'owner' : 'private',
      }],
    }), { mode: 0o600 })
  }
  if (appBotSmoke) {
    mkdirSync(state, { mode: 0o700 })
    writeFileSync(join(state, 'accounts.json'), JSON.stringify({
      version: 1, endpoint: 'https://octo-fixture.invalid/api', accounts: [{
        id: 'legacy', botUid: 'app_fixture_bot', botKind: 'app', spaceId: null, cwd: home,
        label: 'Fixture AppBot', enabled: true, permission: 'workspace-write', agentPreset: 'standard',
        senderPolicy: 'octo', transport: 'websocket', allowFiles: true, sendMode: 'steer', toolScope: 'private',
      }],
    }), { mode: 0o600 })
  }
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- insert:', '  - id: octo-fixture-observer', '    name: ' + q(pathToFileURL(observer).href),
    '- id: dsh-channel-octo', '  config:', '    enabled: true',
    '    apiBase: https://octo-fixture.invalid/api',
    ...(appBotSmoke ? ['    botUid: app_fixture_bot', '    botKind: app', '    spaceId: null']
      : ['    botUid: fixture-bot', '    spaceId: fixture-space']),
    ...(appBotSmoke || deferredSmoke ? ['    senderPolicy: octo', '    transport: websocket', '    progress: off'] : wire
      ? ['    senderPolicy: octo', '    channelPolicy: joined', '    mentionPolicy: octo']
      : ['    allowedUids: [fixture-user]',
        '    allowedGroupIds: ["00112233445566778899aabbccddeeff"]',
        '    allowedThreadIds: ["00112233445566778899aabbccddeeff____123456789012345678"]']),
    '    threadRuleMode: inherit-group', '    allowFiles: true',
    '    hostPermissions: [read-only, workspace-write, danger-full-access, auto]',
    ...(ownerSmoke || appBotSmoke || deferredSmoke ? ['    mediaDownloadOrigins: ["https://files-fixture.invalid"]',
      '    mediaUploadOrigins: ["https://storage-fixture.invalid"]'] : []),
    '    cwd: ' + q(home), '    stateDir: ' + q(state), '    timeoutMs: 22000',
    '- id: llm-deepseek', '  config:', '    baseURL: https://model-fixture.invalid',
  ].join('\n') + '\n')
  const launch = () => spawn(process.execPath, [
    '--import', new URL('./web-fixture.mjs', import.meta.url).href,
    cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], { ...common, stdio: ['ignore', 'pipe', 'pipe'] })
  child = launch()
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(deferredSmoke ? -100_000 : -12_000) })
  const deadline = Date.now() + 85_000
  if (browserModule) {
    const { chromium } = await import(pathToFileURL(resolve(browserModule)).href)
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true })
    let launch
    while (Date.now() < deadline && child.exitCode === null) {
      launch = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*\btoken=[^\s\x1b]+/)?.[0]
      if (launch) break
      await delay(150)
    }
    if (!launch) throw new Error('fixture launch URL not found')
    const unauth = await fetch(new URL('/api/dsh-channel-octo', launch))
    if (unauth.status !== 401) throw new Error('Octo Web API must require DSH login; status ' + unauth.status)
    const page = await browser.newPage()
    const browserErrors = []
    page.on('pageerror', error => browserErrors.push(error.message.replace(/https?:\/\/\S+/g, '[url]')))
    page.on('console', msg => {
      if (msg.type() === 'error' && /octo|plugin|module/i.test(msg.text())) {
        browserErrors.push(msg.text().replace(/https?:\/\/\S+/g, '[url]'))
      }
    })
    await page.addInitScript(() => { Object.defineProperty(window, 'isSecureContext', { value: false }) })
    await page.goto(launch)
    const native = page.getByRole('tab', { name: 'Octo', exact: true })
    const fallback = page.locator('[data-octo-shortcut]')
    const shortcut = native.or(fallback).first()
    try { await shortcut.waitFor({ timeout: 15000 }) } catch (error) {
      throw new Error('Octo entry did not mount: ' + browserErrors.join(' | '), { cause: error })
    }
    // A fresh profile presents an explicit preview acknowledgement.
    const proceed = page.getByRole('dialog').getByRole('button', { name: /^(继续|Continue|跳过|Skip|开始使用|Get started)$/i })
      .and(page.locator('button:not(:disabled)')).first()
    for (let step = 0; step < 4; step++) {
      if (!await proceed.waitFor({ timeout: 1000 }).then(() => true, () => false)) break
      await proceed.click({ timeout: 2000 })
    }
    const entry = await native.isVisible() ? native : fallback
    try { await entry.click({ timeout: 15000 }) } catch (error) {
      const overlays = (await page.locator('[role=dialog],dialog[open]').allTextContents()).join(' ').slice(0, 450)
      throw new Error('Octo sidebar unavailable: ' + browserErrors.join(' | ') + ' ' + overlays, { cause: error })
    }
    if (await native.isVisible() && await fallback.count()) throw new Error('Duplicate Octo sidebar entries')
    const channel = page.locator('.dsho-row').first()
    while (Date.now() < deadline && sentCount() < 1) await delay(150)
    if (!sentCount()) throw new Error('First fixture reply was not delivered: ' + output.replace(/https?:\/\/\S+/g, '[url]'))
    await channel.waitFor({ timeout: 8000 })
    if (await native.isVisible()) {
      const viewport = page.viewportSize()
      await page.setViewportSize({ width: 1280, height: 1000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      if (screenshots) await page.screenshot({ path: join(screenshots, 'octo-channel-tall.png'), animations: 'disabled' })
      const layout = await page.locator('.dsho-rail').evaluate(rail => {
        const controls = rail.querySelector('.dsho-tools')
        const tools = controls.getBoundingClientRect()
        const head = rail.querySelector('.dsho-head').getBoundingClientRect()
        const first = rail.querySelector('.dsho-row').getBoundingClientRect()
        const style = getComputedStyle(rail)
        const list = rail.querySelector('.dsho-list')
        const extras = Array.from({ length: 70 }, () => list.firstElementChild.cloneNode(true))
        list.append(...extras)
        rail.scrollTop = 200
        const scrolls = rail.scrollTop > 0 && rail.scrollHeight > rail.clientHeight
        for (const extra of extras) extra.remove()
        rail.scrollTop = 0
        return { beforeHeader: head.top - rail.getBoundingClientRect().top,
          beforeSearch: tools.top - controls.previousElementSibling.getBoundingClientRect().bottom,
          beforeRow: first.top - tools.bottom, display: style.display, align: style.justifyContent, gap: style.gap, scrolls }
      })
      if (layout.beforeHeader > 20 || layout.beforeSearch > 20 || layout.beforeRow > 20 || !layout.scrolls) {
        throw new Error('Octo sidebar spacing or scrolling is incorrect: ' + JSON.stringify(layout))
      }
      if (viewport) await page.setViewportSize(viewport)
    }
    if (screenshots) {
      await page.screenshot({ path: join(screenshots, 'octo-channel.png'), animations: 'disabled' })
    }
    const search = page.getByRole('searchbox', { name: '搜索会话', exact: true })
    await search.fill('this-does-not-match')
    await page.getByText('没有匹配的会话', { exact: true }).waitFor()
    await search.fill('fixture-user')
    if (await native.isVisible()) {
      const more = page.locator('.dsho-rail .dsho-session-menu-trigger').first()
      await more.click()
      await page.getByRole('menuitem', { name: /重命名|Rename/ }).first().waitFor({ timeout: 7000 })
      await page.keyboard.press('Escape')
      await channel.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /^(置顶会话|Pin session)$/ }).first().click({ timeout: 7000 })
      await page.locator('.dsho-rail [data-octo-pinned]').first().waitFor({ timeout: 7000 })
      await more.click()
      await page.getByRole('menuitem', { name: /^(取消置顶|Unpin session)$/ }).first().click({ timeout: 7000 })
      await page.locator('.dsho-rail [data-octo-pinned]').first().waitFor({ state: 'detached', timeout: 7000 })
      console.log('PASS: Octo overflow and context menu use native DSH actions and reflect pin changes.')
    }
    await channel.click({ timeout: 15000 })
    try { await page.getByText('fixture response 1', { exact: true }).waitFor({ timeout: 12000 }) } catch (error) {
      throw new Error('native session unavailable: ' + (await page.locator('body').innerText()).slice(-550)
        + ' fixture: ' + output.replace(/https?:\/\/\S+/g, '[url]').slice(-1200), { cause: error })
    }
    await page.keyboard.press('Control+Alt+,')
    await page.getByRole('button', { name: 'Octo 渠道', exact: true }).click({ timeout: 8000 })
    const config = page.locator('[data-octo-settings]')
    const platform = config.locator('.dsho-account-platform[aria-expanded=false]')
    if (await platform.count()) await platform.click()
    await config.getByText('Octo Bot', { exact: true }).waitFor({ timeout: 7000 })
    if (await config.getByText('fixture-bot', { exact: true }).isVisible()) throw new Error('Technical details should start collapsed')
    if (screenshots) await page.screenshot({ path: join(screenshots, 'octo-account.png'), animations: 'disabled' })
    await config.getByRole('tablist', { name: 'Octo 设置分类' }).getByRole('tab', { name: '渠道设置', exact: true }).click()
    if (screenshots) {
      await config.getByRole('combobox', { name: '进度显示', exact: true }).waitFor({ timeout: 7000 })
      await page.screenshot({ path: join(screenshots, 'octo-settings.png'), animations: 'disabled' })
    }
    if ((await config.innerText()).includes('\uFFFD')) throw new Error('Found a replacement character in the Octo settings')
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 800, height: 760 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (screenshots) await page.screenshot({ path: join(screenshots, 'octo-settings-narrow.png'), animations: 'disabled' })
    const overflow = await config.evaluate(el => {
      if (el.scrollWidth <= el.clientWidth + 2) return null
      const right = el.getBoundingClientRect().right
      return { width: el.clientWidth, scroll: el.scrollWidth,
        children: [...el.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > right + 2)
          .slice(0, 8).map(child => [child.tagName, String(child.className).slice(0, 65),
            Math.round(child.getBoundingClientRect().right - right)]) }
    })
    if (overflow) throw new Error('Octo settings overflow the panel: ' + JSON.stringify(overflow))
    if (viewport) await page.setViewportSize(viewport)
    try { await config.getByRole('combobox', { name: '进度显示', exact: true }).selectOption('typing', { timeout: 7000 }) }
    catch (error) { throw new Error('Octo settings missing: ' + (await page.locator('[data-shortcut-modal="settings"]').innerText()).slice(-900), { cause: error }) }
    await config.getByRole('button', { name: '保存设置', exact: true }).click()
    await config.getByText('已保存，从下一条消息起生效。', { exact: true }).waitFor({ timeout: 8000 })
    const settings = JSON.parse(readFileSync(join(state, 'web-settings.json'), 'utf8'))
    if (settings.progress !== 'typing') throw new Error('Web settings did not persist')
    const summary = await page.request.get(new URL('/api/dsh-channel-octo', launch).href)
    const { conversations } = await summary.json()
    const id = conversations.find(row => row.type === 1 && row.address === 'fixture-user')?.id
    if (!id) throw new Error('native Octo conversation is missing')
    writeFileSync(browserReady, id)
    console.log('PASS: browser channel, existing native session, authenticated settings save.')
    await config.getByRole('tab', { name: 'Bot 账号', exact: true }).click()
    await config.getByRole('button', { name: '添加账号', exact: true }).click({ timeout: 15000 })
    const editor = page.getByRole('dialog', { name: '添加账号', exact: true })
    await editor.getByLabel('Bot 令牌', { exact: true }).fill('bf_fixture_second', { timeout: 15000 })
    await editor.getByRole('button', { name: '验证令牌', exact: true }).click()
    await editor.getByText('令牌已验证', { exact: true }).waitFor({ timeout: 8000 })
    await editor.getByLabel('账号名称', { exact: true }).fill('Fixture spare')
    const workspace = editor.getByLabel('工作区', { exact: true })
    const ws = (await workspace.locator('option').evaluateAll(options => options.find(option => option.value)?.value))
    await workspace.selectOption(ws)
    await editor.getByRole('checkbox', { name: '启用此账号', exact: true }).uncheck()
    if (screenshots) await page.screenshot({ path: join(screenshots, 'octo-account-editor.png'), animations: 'disabled' })
    await editor.getByRole('button', { name: '保存账号', exact: true }).click()
    const roster = config.locator('.dsho-account-roster')
    await roster.getByText('Fixture spare', { exact: true }).waitFor({ timeout: 9000 })
    await config.getByRole('button', { name: '设置 · Fixture spare', exact: true }).click()
    const edit = page.locator('.dsho-account-modal[open]')
    const policy = edit.getByLabel('权限策略', { exact: true })
    const toolScope = edit.getByLabel('工具使用范围', { exact: true })
    await toolScope.waitFor({ state: 'visible', timeout: 9000 })
    const scopeChoices = await toolScope.locator('option').evaluateAll(options => options.map(option =>
      ({ value: option.value, label: option.textContent, disabled: option.disabled })))
    const expectedScopes = [
      { value: 'private', label: '获准的私聊用户', disabled: false },
      { value: 'owner', label: 'Bot 所有者的全部会话', disabled: false },
      { value: 'admitted', label: '所有已准入用户', disabled: false },
    ]
    if (JSON.stringify(scopeChoices) !== JSON.stringify(expectedScopes) || await toolScope.inputValue() !== 'private') {
      throw new Error('Tool scope choices or legacy default are incorrect: ' + JSON.stringify(scopeChoices))
    }
    console.log('FIXTURE_TOOL_SCOPE_CHOICES_ZH_OK')
    const sendMode = edit.getByLabel('发送方式', { exact: true })
    const accountName = edit.getByLabel('账号名称', { exact: true })
    const overviewUrl = new URL('/api/dsh-channel-octo', launch).href
    const beforeEdits = await (await page.request.get(overviewUrl)).json()
    const spareId = beforeEdits.accounts.find(row => row.label === 'Fixture spare')?.id
    if (!spareId) throw new Error('The spare account is missing before rapid edits')
    const accountUrl = new URL('/api/dsh-channel-octo/accounts/' + spareId, launch).href
    const firstSave = Promise.withResolvers(), editsQueued = Promise.withResolvers()
    let delayedPuts = 0, overview, spare
    const pendingRoutes = new Set()
    const delayAccountPut = async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      const first = ++delayedPuts === 1
      const forwarding = (async () => {
        if (first) firstSave.resolve()
        await delay(250)
        // Guarantee overlap even when browser actions take longer on a busy host.
        if (first) await editsQueued.promise
        await route.continue()
      })()
      pendingRoutes.add(forwarding)
      try { await forwarding } finally { pendingRoutes.delete(forwarding) }
    }
    await page.route(accountUrl, delayAccountPut)
    try {
      await Promise.all([
        policy.selectOption({ label: '工作区写入' }, { timeout: 9000 }),
        Promise.race([firstSave.promise, delay(9000, undefined, { ref: false }).then(() => {
          throw new Error('The first account PUT was not intercepted')
        })]),
      ])
      await sendMode.selectOption('steer', { timeout: 9000 })
      await toolScope.selectOption('admitted', { timeout: 9000 })
      await accountName.fill('Fixture spare renamed', { timeout: 9000 })
      await accountName.press('Enter', { timeout: 9000 })
      editsQueued.resolve()
      await edit.getByText('已保存', { exact: true }).waitFor({ timeout: 9000 })
      const matchesFinal = row => row?.label === 'Fixture spare renamed' && row.enabled === false
        && row.permission === 'workspace-write' && row.senderPolicy === 'octo'
        && row.sendMode === 'steer' && row.toolScope === 'admitted'
      const savedDeadline = Date.now() + 9000
      do {
        const response = await page.request.get(overviewUrl)
        if (!response.ok()) throw new Error('Rapid edit readback failed: ' + response.status())
        overview = await response.json()
        spare = overview.accounts.find(row => row.id === spareId)
        if (matchesFinal(spare)) break
        await delay(100)
      } while (Date.now() < savedDeadline)
      if (delayedPuts < 2 || !matchesFinal(spare)) throw new Error('Queued account edits lost their final values')
      await edit.getByRole('heading', { name: 'Fixture spare renamed', exact: true }).waitFor({ timeout: 9000 })
      if (await policy.inputValue() !== 'workspace-write' || await sendMode.inputValue() !== 'steer'
        || await toolScope.inputValue() !== 'admitted' || await accountName.inputValue() !== 'Fixture spare renamed') {
        throw new Error('Account editor reverted after queued saves')
      }
      console.log('FIXTURE_RAPID_ACCOUNT_EDITS_OK')
    } finally {
      editsQueued.resolve()
      await page.unroute(accountUrl, delayAccountPut)
      await Promise.allSettled([...pendingRoutes])
    }
    await edit.getByRole('button', { name: '关闭', exact: true }).click()
    await roster.getByRole('button', { name: '设置 · Fixture spare renamed', exact: true }).waitFor({ timeout: 9000 })
    const stored = readFileSync(join(state, 'accounts.json'), 'utf8')
    if (JSON.parse(stored).accounts.find(row => row.id === spare.id)?.toolScope !== 'admitted') {
      throw new Error('Tool scope did not persist in the account store')
    }
    console.log('FIXTURE_TOOL_SCOPE_PERSISTED=admitted')
    if ((JSON.stringify(overview) + stored).includes('bf_fixture_second')) throw new Error('Bot credential escaped its vault')
    await roster.getByRole('button', { name: '设置 · Fixture spare renamed', exact: true }).click()
    const rotated = page.locator('.dsho-account-modal[open]')
    if (await rotated.getByLabel('工具使用范围', { exact: true }).inputValue() !== 'admitted'
      || await rotated.getByLabel('权限策略', { exact: true }).inputValue() !== 'workspace-write'
      || await rotated.getByLabel('发送方式', { exact: true }).inputValue() !== 'steer'
      || await rotated.getByLabel('账号名称', { exact: true }).inputValue() !== 'Fixture spare renamed') {
      throw new Error('Reopening the account changed saved settings')
    }
    console.log('FIXTURE_TOOL_SCOPE_REOPENED=admitted')
    const preset = rotated.getByLabel('Agent 预设', { exact: true })
    await preset.locator('option', { hasText: '标准模式' }).waitFor({ state: 'attached' })
    const full = rotated.getByLabel('权限策略', { exact: true }).locator('option[value="danger-full-access"]')
    if (await full.getAttribute('disabled') !== null || await full.textContent() !== '完全访问') throw new Error('full access not selectable in Chinese')
    await rotated.getByRole('button', { name: '更换 Bot 令牌', exact: true }).click()
    await rotated.getByLabel('新 Bot 令牌', { exact: true }).fill('bf_fixture_second_rotated')
    await rotated.getByRole('button', { name: '验证令牌', exact: true }).click()
    await rotated.getByRole('button', { name: '保存新令牌', exact: true }).click({ timeout: 9000 })
    await rotated.getByText('已保存', { exact: true }).waitFor({ timeout: 9000 })
    await rotated.getByRole('button', { name: '移除账号', exact: true }).click()
    await page.getByRole('dialog', { name: '移除账号', exact: true }).getByRole('button', { name: '移除账号', exact: true }).click()
    await roster.getByRole('button', { name: '设置 · Fixture spare renamed', exact: true }).waitFor({ state: 'detached', timeout: 9000 })
    if (readFileSync(join(state, 'accounts.json'), 'utf8').includes('bf_fixture_second_rotated')) throw new Error('Rotated credential escaped its vault')
    console.log('PASS: delayed account PUT preserves rapid permission/send-mode/tool-scope/name edits; Chinese scopes, persisted and reopened settings, credential rotation and confirmed removal; credentials not exposed.')
    if (process.env.DSH_OCTO_SMOKE_WEBHOOK_UI === '1') {
      const { runWebhookUiSmoke } = await import('./webhook-ui-smoke.mjs')
      console.log('PASS: protected Webhook native settings UI ' + JSON.stringify(await runWebhookUiSmoke(page)))
    }
  }
  if (deferredSmoke) {
    const { assertDeferredSmoke } = await import('./deferred-fixture.mjs')
    await assertDeferredSmoke({ home, state, child, output: () => output,
      restart: () => { child = launch(); return child } })
  } else if (appBotSmoke) await assertAppBotSmoke(child, () => output, deadline)
  else {
  // Browser loading, onboarding and screenshots must not consume the post-setup reply budget.
  const replyDeadline = browserModule ? Date.now() + 30_000 : deadline
  const expectedReceipts = ownerSmoke || deleteSmoke ? 6 : 5
  while (Date.now() < replyDeadline && child.exitCode === null && sentCount() !== expectedReceipts) await delay(200)
  if (sentCount() !== expectedReceipts) {
    let jobs = []
    try {
      const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
      try { jobs = db.prepare('SELECT seq,state,issue FROM jobs ORDER BY seq').all() } finally { db.close() }
    } catch {}
    throw new Error('expected five delivered replies; fixture jobs: ' + JSON.stringify(jobs) + '\n'
      + output.replace(/https?:\/\/\S+/g, '[url]'))
  }
  const expectedCards = [
    { id: '200', type: '1', address: 'fixture-user', answering: true },
    ...(delegatedSmoke ? [{ id: '202', type: '1', address: 'fixture-user', answering: false }] : []),
    // Group completion may beat the edit throttle after its question is answered.
    // Its initial reasoning state and final completed edit are still mandatory.
    ...(groupToolsSmoke ? [{ id: '201', type: '2', address: '00112233445566778899aabbccddeeff', answering: false }] : []),
  ]
  const cardDeadline = Date.now() + 5000
  while (Date.now() < cardDeadline && expectedCards.some(card => !output.includes('FIXTURE_CARD=' + card.id + ':completed:'))) await delay(100)
  const opened = [...output.matchAll(/FIXTURE_CARD_OPEN=(\d+):(\d+):([^:\r\n]+):(\w+):(\d+)/g)]
  const edits = [...output.matchAll(/FIXTURE_CARD=(\d+):(\w+):(\d+)/g)]
  if (opened.length !== expectedCards.length || edits.some(row => !expectedCards.some(card => card.id === row[1]))
    || expectedCards.some(card => {
      const starts = opened.filter(row => row[1] === card.id)
      const updates = edits.filter(row => row[1] === card.id)
      return starts.length !== 1 || starts[0][2] !== card.type || starts[0][3] !== card.address
        || !['reasoning', 'answering'].includes(starts[0][4]) || Number(starts[0][5]) !== 1
        || card.id === '201' && starts[0][4] !== 'reasoning'
        || card.answering && !updates.some(row => row[2] === 'answering')
        || updates.at(-1)?.[2] !== 'completed'
        || updates.some((row, i) => Number(row[3]) <= (i ? Number(updates[i - 1][3]) : 1)
          || (i === updates.length - 1 ? row[2] !== 'completed' : !['reasoning', 'answering'].includes(row[2])))
    }) || /FIXTURE_CARD_.*MISMATCH/.test(output)) {
    throw new Error('expected route-bound progress cards with ordered states and final completed edits: '
      + (output.match(/FIXTURE_CARD[^\r\n]*/g) ?? []).join('\n'))
  }
  if (groupToolsSmoke) console.log('FIXTURE_GROUP_PROGRESS_OK=201')
  if (browserModule && !/dsh_session_reused/.test(output)) throw new Error('Web did not hold the fixture session open during the second turn')
  if (ownerSmoke && (readFileSync(join(home, 'octo-tool-fixture.txt'), 'utf8') !== 'written by native DSH'
    || !output.includes('FIXTURE_FILE_OK') || !output.includes('FIXTURE_FILE_CAPTION_OK') || !output.includes('FIXTURE_QUESTION_ANSWERED')
    || !output.includes('FIXTURE_GROUP_MEMBERS_OK')
    || [501, 502, 503].some(id => !output.includes('FIXTURE_ANSWER_FEEDBACK=' + id)))) throw new Error('Native write/present/delivery failed: '
      + output.replace(/https?:\/\/\S+/g, '[url]').slice(-1500))
  if (!output.includes('FIXTURE_RICH_IMAGE_DOWNLOADED') || output.includes('FIXTURE_SYNC_SCOPE_WRONG')) throw new Error('Missing scoped rich media/history')
  if (delegatedSmoke) {
    const markers = new Set(output.match(/FIXTURE_[A-Z_]+(?:=\d+)?/g) ?? [])
    if (Array.from({ length: 13 }, (_, i) => i + 1).some(step => !markers.has('FIXTURE_DELEGATED_TOOL_OK=' + step))
      || [2, 5].some(type => !output.includes('FIXTURE_PROACTIVE_SENT=' + type))
      || ['FILE', 'CAPTION', 'CARD'].some(kind => !output.includes('FIXTURE_TARGET_' + kind + '_SENT'))
      || output.includes('FIXTURE_DELEGATED_SCOPE_MISMATCH')) throw new Error('Delegated search native roundtrip failed')
    const personMarkers = ['FIXTURE_PERSON_TOOL_SCHEMA_OK', 'FIXTURE_PERSON_DIRECTORY_OK', 'FIXTURE_PERSON_FILE_UPLOADED',
      'FIXTURE_PERSON_TEXT_SENT=783', 'FIXTURE_PERSON_FILE_SENT=784', 'FIXTURE_PERSON_CAPTION_SENT=785',
      'FIXTURE_PERSON_CARD_SENT=786', 'FIXTURE_PERSON_FINAL_OK',
      ...[10, 11, 12, 13].flatMap(step => ['HOST_TOOL', 'PRINCIPALS', 'TOOL_RESULT'].map(kind => 'FIXTURE_PERSON_' + kind + '_OK=' + step)),
      ...[3, 4, 5].map(round => 'FIXTURE_PERSON_PRIVATE_SCOPE_OK=' + round)]
    if (personMarkers.some(marker => !markers.has(marker))
      || /FIXTURE_PERSON_[^\r\n]*(?:MISMATCH|FORBIDDEN|BEFORE_TOOLS)/.test(output)) {
      throw new Error('Third-party DM host tool/payload/result/final roundtrip failed: '
        + (output.match(/FIXTURE_PERSON_[^\r\n]*/g) ?? []).join('\n'))
    }
    console.log('PASS: native private delegated message/file/group searches and bound continuation, without raw cursors or attachments.')
    console.log('PASS: native target discovery and explicit group/topic sends with member mentions, without impersonation or empty quotes.')
    console.log('PASS: native target file upload, full Markdown caption and topic display card with confirmed receipts and final summary.')
    console.log('PASS: 13 delegated host tool steps; bounded human directory resolution and Bot DM text, file plus full caption, display card, receipts and final summary; fixed-Space principals, private-only tools, no target history/sync or OBO.')
  }
  if (ownerSmoke) {
    if (groupToolsSmoke && (readFileSync(join(home, 'group-tool-fixture.txt'), 'utf8') !== 'group native tools executed'
      || ['FIXTURE_GROUP_QUESTION_SENT', 'FIXTURE_GROUP_INVALID_CALLBACKS_IGNORED', 'FIXTURE_GROUP_QUESTION_ANSWERED',
        'FIXTURE_ANSWER_FEEDBACK=504', 'FIXTURE_GROUP_WRITE_OK', 'FIXTURE_GROUP_DISPLAY_CARD_OK=700',
        'FIXTURE_GROUP_DISPLAY_RECEIPT_OK', 'FIXTURE_GROUP_FINAL_OK', 'FIXTURE_TYPED_FORM_SENT', 'FIXTURE_TYPED_FORM_FEEDBACK', 'FIXTURE_TYPED_FORM_ANSWERED',
        'FIXTURE_NATIVE_APPROVAL_REQUEST', 'FIXTURE_APPROVAL_CARD', 'FIXTURE_APPROVAL_FEEDBACK'].some(marker => !output.includes(marker))
      || ['octo_webhooks_update', 'octo_webhooks_test', 'octo_webhooks_delete', 'octo_messages_clear_card_revisions']
        .some(name => !output.includes('FIXTURE_ADMIN_TOOL_OK=' + name))
      || /FIXTURE_GROUP_INVALID_CALLBACK_ACCEPTED|FIXTURE_QUESTION_FEEDBACK_MISMATCH|FIXTURE_GROUP_DISPLAY_(?:CARD_MISMATCH|RECEIPT_WRONG)/.test(output))) {
      throw new Error('Group native question/write/display-card/final roundtrip failed: '
        + output.replace(/https?:\/\/\S+/g, '[url]').slice(-2000))
    }
    const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare("SELECT message_id,result_id,session_id FROM jobs WHERE state='sent' AND message_id IN ('1','902')").all()
      if (rows.length !== 2 || !rows[0].result_id || rows[0].result_id !== rows[1].result_id
        || !rows[0].session_id || rows[0].session_id !== rows[1].session_id) throw new Error('File and follow-up did not share one confirmed reply')
      if (groupToolsSmoke) {
        const final = db.prepare("SELECT session_id FROM jobs WHERE message_id='3' AND state='sent'").get()
        const formAnswer = db.prepare("SELECT session_id,state,input FROM jobs WHERE message_id='card_action:908'").get()
        if (formAnswer?.session_id !== final?.session_id || formAnswer?.state !== 'ignored' || formAnswer?.input !== '') throw new Error('Typed form lost its waiting native turn')
        const approval = db.prepare("SELECT session_id,state,input FROM jobs WHERE message_id='card_action:907'").get()
        if (approval?.session_id !== final?.session_id || approval?.state !== 'ignored' || approval?.input !== '') throw new Error('Approval lost its waiting native turn')
        const answers = db.prepare("SELECT message_id,sender,channel_type,channel_id,session_id,state FROM jobs WHERE message_id IN ('card_action:904','card_action:905','card_action:906')").all()
        const card = db.prepare("SELECT claimed,binding FROM card_bindings WHERE message_id='504'").get()
        if (!final?.session_id || answers.length !== 1 || answers[0].message_id !== 'card_action:906'
          || answers[0].sender !== 'fixture-user' || answers[0].channel_type !== 2
          || answers[0].channel_id !== '00112233445566778899aabbccddeeff'
          || answers[0].state !== 'ignored' || answers[0].session_id !== final.session_id
          || card?.claimed !== 1 || JSON.parse(card.binding).questionFeedback !== 1) {
          throw new Error('Group card callback accepted a wrong sender/channel or lost its original session/feedback')
        }
      }
    } finally { db.close() }
    console.log('PASS: three DM card answers, file plus full description, group member tool, and '
      + (groupToolsSmoke ? 'native group question, approval card, wrong callback rejection, workspace write, structured display, typed form, webhook tools, card revision cleanup and final.' : 'Octo-only group tool isolation.'))
  }
  if (deleteSmoke) {
    const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare("SELECT session_id FROM jobs WHERE message_id IN ('1','2','6') ORDER BY seq").all()
      if (rows.length !== 3 || rows[0].session_id === rows[1].session_id || rows[1].session_id !== rows[2].session_id
        || db.prepare('SELECT 1 FROM conversations WHERE session_id=?').get(rows[0].session_id)
        || db.prepare('SELECT 1 FROM conversation_history WHERE session_id=?').get(rows[0].session_id)) {
        throw new Error('Deleted session was retained or resumed')
      }
    } finally { db.close() }
    if (!output.includes('FIXTURE_SESSION_REMOVED') || !output.includes('FIXTURE_POST_DELETE_IMAGE')
      || !output.includes('FIXTURE_NATIVE_IMAGE=true')) throw new Error('Deletion or native image fixture did not run: '
        + (output.match(/FIXTURE_[^\r\n]+/g) ?? []).join('; '))
    console.log('PASS: deleted native session is forgotten; rich image+text and subsequent text use a fresh session.')
  }
  if (includeImConnect) {
    const imLog = readFileSync(join(home, 'dsh-im-connect', 'gateway.log'), 'utf8')
    if (!imLog.includes('API 已注册') || !imLog.includes('attachMappedSessions')) throw new Error('IM Connect did not initialize')
  }
  console.log('PASS: DSH Web' + (includeImConnect ? ' + IM Connect' : '') + '; '
    + (wire ? 'Octo friends/members with @ and no-@ over WebSocket' : 'explicit @ over HTTP events')
    + '; channel rules and isolated histories.')
  }
} finally {
  await browser?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await Promise.race([exited, delay(2000, undefined, { ref: false })])
  }
  const path = realpathSync(home)
  if (relative(temporary, path).startsWith('dsh-octo-smoke-') && dirname(path) === temporary) {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
}
