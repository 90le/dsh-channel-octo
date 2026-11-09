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
const ownerSmoke = process.env.DSH_OCTO_SMOKE_OWNER === '1'
if (ownerSmoke && (!wire || browserModule)) throw new Error('Owner tool smoke uses headless WebSocket')
const screenshots = process.env.DSH_OCTO_SMOKE_SCREENSHOTS
const codexUi = process.env.DSH_OCTO_SMOKE_CODEX_UI
const automation = process.env.DSH_OCTO_SMOKE_AUTOMATION
if (codexUi && !/^\d+\.\d+\.\d+$/.test(codexUi)) throw new Error('Set an exact Codex UI version')
if (automation && !/^\d+\.\d+\.\d+$/.test(automation)) throw new Error('Set an exact automation version')
if (browserModule && (!browserExecutable || !wire)) throw new Error('Browser smoke needs WebSocket and an executable path')
const browserReady = join(home, 'browser-ready')
const observer = join(home, 'fixture-observer.mjs')
// Keep filesystem/runtime discovery variables, but never pass existing API keys to the fixture process.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG|npm_config_cache)$/i.test(key)))
Object.assign(env, {
  DSH_HOME: home, DSH_OCTO_BOT_TOKEN: 'bf_fixture', DEEPSEEK_API_KEY: 'sk-fixture-for-local-smoke',
  DSH_TELEMETRY_DISABLED: '1',
  DSH_OCTO_FIXTURE_OWNER: ownerSmoke ? '1' : '0',
  DSH_OCTO_FIXTURE_WIRE: wire ? '1' : '0',
  ...(browserModule && { DSH_OCTO_BROWSER_READY: browserReady }),
})
const common = { cwd: project, env, windowsHide: true, encoding: 'utf8', timeout: 50_000 }
function node(args) {
  const result = spawnSync(process.execPath, args, common)
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
let child, browser
try {
  if (node([cli, '--version']).trim() !== '0.2.1-rc.5') throw new Error('Expected DSH 0.2.1-rc.5')
  const packed = JSON.parse(node([npm, 'pack', '--json', '--pack-destination', home]))
  const { filename } = Array.isArray(packed) ? packed[0] : packed['dsh-channel-octo']
  if (typeof filename !== 'string' || !/^dsh-channel-octo-\d+\.\d+\.\d+\.tgz$/.test(filename)) throw new Error('Unexpected fixture package')
  for (const spec of [join(home, filename), ...(ownerSmoke ? [] : ['@michengai/dsh-im-connect@1.0.30']),
    ...(codexUi ? ['@michengai/dsh-codex-ui@' + codexUi] : []),
    ...(automation ? ['@michengai/dsh-automation@' + automation] : [])]) {
    node([cli, 'plugin', '--profile', 'web', 'add', spec, '--registry=https://registry.npmjs.org/'])
  }
  const q = JSON.stringify
  writeFileSync(observer, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
export const name = 'octo-fixture-observer'
export const inject = ['agents', 'agentPresets', 'agentDefaultModel']
export function apply(ctx) {
  ctx.logger.exporter({ levels: { default: 2 }, export: ({ name, args }) => {
    if (name === 'dsh-channel-octo' && ['dsh_session_reused', 'session_busy', 'session_preset_conflict', 'bot_verified', 'octo_ws_connected', 'file_not_presented', 'file_tools_unavailable', 'worker_stopped: internal_error',
      'delivery_not_confirmed', 'file_delivery_not_confirmed', 'agent_run_not_confirmed', 'no_confirmed_final_text', 'shared_turn_not_forwarded', 'workspace_attach_failed',
      'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context'].includes(args?.[0])) {
      console.log('FIXTURE_DSH=' + args[0])
    }
  } })
  if (process.env.DSH_OCTO_FIXTURE_OWNER === '1') {
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result') console.log('FIXTURE_TOOL=' + (event.data.message?.isError ? 'failed' : 'ok'))
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
  if (ownerSmoke) {
    mkdirSync(state, { mode: 0o700 })
    writeFileSync(join(state, 'accounts.json'), JSON.stringify({
      version: 1, endpoint: 'https://octo-fixture.invalid/api', accounts: [{
        id: 'legacy', botUid: 'fixture-bot', spaceId: 'fixture-space', cwd: home,
        label: 'Octo Bot', enabled: true, permission: 'workspace-write', agentPreset: 'standard',
        senderPolicy: 'octo', transport: 'websocket', allowFiles: true, sendMode: 'steer',
      }],
    }), { mode: 0o600 })
  }
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- insert:', '  - id: octo-fixture-observer', '    name: ' + q(pathToFileURL(observer).href),
    '- id: dsh-channel-octo', '  config:', '    enabled: true',
    '    apiBase: https://octo-fixture.invalid/api', '    botUid: fixture-bot',
    '    spaceId: fixture-space',
    ...(wire
      ? ['    senderPolicy: octo', '    channelPolicy: joined', '    mentionPolicy: octo']
      : ['    allowedUids: [fixture-user]',
        '    allowedGroupIds: ["00112233445566778899aabbccddeeff"]',
        '    allowedThreadIds: ["00112233445566778899aabbccddeeff____123456789012345678"]']),
    '    threadRuleMode: inherit-group', '    allowFiles: true',
    '    hostPermissions: [read-only, workspace-write, danger-full-access, auto]',
    ...(ownerSmoke ? ['    mediaDownloadOrigins: ["https://files-fixture.invalid"]',
      '    mediaUploadOrigins: ["https://storage-fixture.invalid"]'] : []),
    '    cwd: ' + q(home), '    stateDir: ' + q(state), '    timeoutMs: 22000',
    '- id: llm-deepseek', '  config:', '    baseURL: https://model-fixture.invalid',
  ].join('\n') + '\n')
  child = spawn(process.execPath, [
    '--import', new URL('./web-fixture.mjs', import.meta.url).href,
    cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], { ...common, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12_000) })
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
    await policy.selectOption({ label: '工作区写入' })
    await edit.getByText('已保存', { exact: true }).waitFor({ timeout: 9000 })
    const sendMode = edit.getByLabel('发送方式', { exact: true })
    await sendMode.selectOption('steer')
    await edit.getByText('已保存', { exact: true }).waitFor({ timeout: 9000 })
    await edit.getByLabel('账号名称', { exact: true }).fill('Fixture spare renamed')
    await edit.getByLabel('账号名称', { exact: true }).press('Enter')
    await edit.getByRole('heading', { name: 'Fixture spare renamed', exact: true }).waitFor({ timeout: 9000 })
    await edit.getByRole('button', { name: '关闭', exact: true }).click()
    await roster.getByRole('button', { name: '设置 · Fixture spare renamed', exact: true }).waitFor({ timeout: 9000 })
    const overview = await (await page.request.get(new URL('/api/dsh-channel-octo', launch).href)).json()
    if (!overview.accounts.some(row => row.label === 'Fixture spare renamed' && row.enabled === false && row.permission === 'workspace-write' && row.senderPolicy === 'octo' && row.sendMode === 'steer')) {
      throw new Error('The second Bot did not stay separately configured')
    }
    const stored = readFileSync(join(state, 'accounts.json'), 'utf8')
    if ((JSON.stringify(overview) + stored).includes('bf_fixture_second')) throw new Error('Bot credential escaped its vault')
    await roster.getByRole('button', { name: '设置 · Fixture spare renamed', exact: true }).click()
    const rotated = page.locator('.dsho-account-modal[open]')
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
    console.log('PASS: HTTP account add, partial edits, credential rotation and confirmed removal; credentials not exposed.')
  }
  // Browser loading, onboarding and screenshots must not consume the post-setup reply budget.
  const replyDeadline = browserModule ? Date.now() + 30_000 : deadline
  const expectedReceipts = ownerSmoke ? 6 : 5
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
  const cardDeadline = Date.now() + 5000
  while (Date.now() < cardDeadline && !/FIXTURE_CARD=completed:\d+/.test(output)) await delay(100)
  const edits = [...output.matchAll(/FIXTURE_CARD=(\w+):(\d+)/g)]
  if (!/FIXTURE_CARD_OPEN/.test(output) || !edits.some(row => row[1] === 'answering')
    || edits.at(-1)?.[1] !== 'completed' || edits.some((row, i) => i && Number(row[2]) <= Number(edits[i - 1][2]))
    || /FIXTURE_CARD_.*MISMATCH/.test(output)) {
    throw new Error('expected one progress card and ordered interim + terminal edits: '
      + output.replace(/https?:\/\/\S+/g, '[url]').slice(-1500))
  }
  if (browserModule && !/dsh_session_reused/.test(output)) throw new Error('Web did not hold the fixture session open during the second turn')
  if (ownerSmoke && (readFileSync(join(home, 'octo-tool-fixture.txt'), 'utf8') !== 'written by native DSH'
    || !output.includes('FIXTURE_FILE_OK') || !output.includes('FIXTURE_QUESTION_ANSWERED'))) throw new Error('Native write/present/delivery failed: '
      + output.replace(/https?:\/\/\S+/g, '[url]').slice(-1500))
  if (!output.includes('FIXTURE_RICH_IMAGE_DOWNLOADED') || output.includes('FIXTURE_SYNC_SCOPE_WRONG')) throw new Error('Missing scoped rich media/history')
  if (ownerSmoke) {
    const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare("SELECT message_id,result_id,session_id FROM jobs WHERE state='sent' AND message_id IN ('1','902')").all()
      if (rows.length !== 2 || !rows[0].result_id || rows[0].result_id !== rows[1].result_id
        || !rows[0].session_id || rows[0].session_id !== rows[1].session_id) throw new Error('File and follow-up did not share one confirmed reply')
    } finally { db.close() }
    console.log('PASS: file and follow-up shared one round; native question resumed from Octo, then DSH wrote and delivered identical file bytes.')
  }
  if (!ownerSmoke) {
    const imLog = readFileSync(join(home, 'dsh-im-connect', 'gateway.log'), 'utf8')
    if (!imLog.includes('API 已注册') || !imLog.includes('attachMappedSessions')) throw new Error('IM Connect did not initialize')
  }
  console.log('PASS: DSH Web' + (ownerSmoke ? '' : ' + IM Connect') + '; '
    + (wire ? 'Octo friends/members with @ and no-@ over WebSocket' : 'explicit @ over HTTP events')
    + '; channel rules and isolated histories.')
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
