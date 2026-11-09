// Opt-in: uses an installed, exact-version DSH CLI and a temporary Web profile.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
if (browserModule && (!browserExecutable || !wire)) throw new Error('Browser smoke needs WebSocket and an executable path')
const browserReady = join(home, 'browser-ready')
const observer = join(home, 'fixture-observer.mjs')
// Keep filesystem/runtime discovery variables, but never pass existing API keys to the fixture process.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG)$/i.test(key)))
Object.assign(env, {
  DSH_HOME: home, DSH_OCTO_BOT_TOKEN: 'bf_fixture', DEEPSEEK_API_KEY: 'sk-fixture-for-local-smoke',
  DSH_TELEMETRY_DISABLED: '1',
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
  const [{ filename }] = JSON.parse(node([npm, 'pack', '--json', '--pack-destination', home]))
  for (const spec of [join(home, filename), '@michengai/dsh-im-connect@1.0.30']) {
    node([cli, 'plugin', '--profile', 'web', 'add', spec, '--registry=https://registry.npmjs.org/'])
  }
  const q = JSON.stringify
  writeFileSync(observer, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
export const name = 'octo-fixture-observer'
export const inject = ['agents', 'agentPresets', 'agentDefaultModel']
export function apply(ctx) {
  ctx.logger.exporter({ levels: { default: 2 }, export: ({ name, args }) => {
    if (name === 'dsh-channel-octo' && ['dsh_session_reused', 'session_busy', 'session_preset_conflict',
      'agent_run_not_confirmed', 'no_confirmed_final_text', 'shared_turn_not_forwarded', 'workspace_attach_failed',
      'session_open_failed', 'session_flush_failed', 'session_turn_failed', 'missing_scoped_rule_context'].includes(args?.[0])) {
      console.log('FIXTURE_DSH=' + args[0])
    }
  } })
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
    '    threadRuleMode: inherit-group',
    '    cwd: ' + q(home), '    stateDir: ' + q(state), '    timeoutMs: 12000',
    '- id: llm-deepseek', '  config:', '    baseURL: https://model-fixture.invalid',
  ].join('\n') + '\n')
  child = spawn(process.execPath, [
    '--import', new URL('./web-fixture.mjs', import.meta.url).href,
    cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], { ...common, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12_000) })
  const deadline = Date.now() + 48_000
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
    await page.goto(launch)
    const shortcut = page.getByRole('button', { name: 'Octo 频道', exact: true })
    await shortcut.waitFor({ timeout: 15000 })
    // A fresh profile presents an explicit preview acknowledgement.
    const proceed = page.getByRole('dialog').getByRole('button', { name: /^(继续|Continue|跳过|Skip|开始使用|Get started)$/i })
      .and(page.locator('button:not(:disabled)')).first()
    for (let step = 0; step < 4; step++) {
      if (!await proceed.waitFor({ timeout: 1000 }).then(() => true, () => false)) break
      await proceed.click({ timeout: 2000 })
    }
    try { await shortcut.click({ timeout: 15000 }) } catch (error) {
      const overlays = (await page.locator('[role=dialog],dialog[open]').allTextContents()).join(' ').slice(0, 450)
      throw new Error('Octo sidebar unavailable: ' + browserErrors.join(' | ') + ' ' + overlays, { cause: error })
    }
    const channel = page.getByRole('button', { name: /私聊.*fixture-user/ })
    while (Date.now() < deadline && sentCount() < 1) await delay(150)
    await channel.click({ timeout: 15000 })
    try { await page.getByText('fixture response 1', { exact: true }).waitFor({ timeout: 12000 }) } catch (error) {
      throw new Error('native session unavailable: ' + (await page.locator('body').innerText()).slice(-550)
        + ' fixture: ' + output.replace(/https?:\/\/\S+/g, '[url]').slice(-1200), { cause: error })
    }
    await page.keyboard.press('Control+Alt+,')
    await page.getByRole('button', { name: 'Octo 渠道', exact: true }).click({ timeout: 8000 })
    const config = page.locator('[data-octo-settings]')
    try { await config.getByRole('combobox', { name: '进度显示', exact: true }).selectOption('typing', { timeout: 7000 }) }
    catch (error) { throw new Error('Octo settings missing: ' + (await page.locator('[data-shortcut-modal="settings"]').innerText()).slice(-900), { cause: error }) }
    await config.getByRole('button', { name: '保存设置', exact: true }).click()
    await config.getByText('已保存，从下一条消息起生效。', { exact: true }).waitFor({ timeout: 8000 })
    const settings = JSON.parse(readFileSync(join(state, 'web-settings.json'), 'utf8'))
    if (settings.progress !== 'typing' || settings.senderPolicy !== 'octo') throw new Error('Web settings did not persist')
    const summary = await page.request.get(new URL('/api/dsh-channel-octo', launch).href)
    const { conversations } = await summary.json()
    const id = conversations.find(row => row.type === 1 && row.address === 'fixture-user')?.id
    if (!id) throw new Error('native Octo conversation is missing')
    writeFileSync(browserReady, id)
    console.log('PASS: browser channel, existing native session, authenticated settings save.')
  }
  while (Date.now() < deadline && child.exitCode === null && sentCount() !== 5) await delay(200)
  if (sentCount() !== 5) {
    throw new Error('expected five delivered replies; fixture diagnostics: ' + output.replace(/https?:\/\/\S+/g, '[url]'))
  }
  if (!/FIXTURE_CARD_OPEN/.test(output) || !/FIXTURE_CARD=answering:2/.test(output)
    || !/FIXTURE_CARD=completed:3/.test(output) || /FIXTURE_CARD_.*MISMATCH/.test(output)) {
    throw new Error('expected one progress card and ordered interim + terminal edits')
  }
  if (browserModule && !/dsh_session_reused/.test(output)) throw new Error('Web did not hold the fixture session open during the second turn')
  const imLog = readFileSync(join(home, 'dsh-im-connect', 'gateway.log'), 'utf8')
  if (!imLog.includes('API 已注册') || !imLog.includes('attachMappedSessions')) throw new Error('IM Connect did not initialize')
  console.log('PASS: DSH Web + IM Connect; ' + (wire ? 'Octo friends/members with @ and no-@ over WebSocket' : 'explicit @ over HTTP events')
    + '; rules, isolated history and no model tools.')
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
