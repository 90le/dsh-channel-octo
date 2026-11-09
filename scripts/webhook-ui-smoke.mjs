// Use only with a disposable DSH development profile, never a live account.
// CLI: node scripts/webhook-ui-smoke.mjs <fixture-launch-url> <playwright-module> <chrome-executable>
// Or import runWebhookUiSmoke(page) into an already authenticated native fixture.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const group = '00112233445566778899aabbccddeeff'
const route = { type: 2, address: group, name: 'Webhook fixture group' }
const child = { type: 5, address: group + '____123456789012345678', name: 'Webhook fixture thread' }
const secret = 'b'.repeat(64)
const id = 'iwh_' + 'a'.repeat(32)
const row = (extra = {}) => ({ webhook_id: id, group_no: group, name: 'Webhook fixture', avatar: '', creator_uid: 'fixture-bot',
  status: 1, allow_mention_all: 0, allow_mention_bots: 0, mention_uids: ['fixture-person'],
  last_used_at: 0, call_count: 0, created_at: 123, version: 'a'.repeat(64), ...extra })

export async function installWebhookUiFixture(page, accountId, accountRevision) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(page.url()).hostname), 'loopback development page required')
  const calls = [], rows = new Map([[route.address, [row()]], [child.address, [row({ thread_short_id: '123456789012345678' })]]])
  const state = { failNext: false, gate: null, release: null }
  const urlPattern = '**/api/dsh-channel-octo/accounts/*/webhooks'
  const intercept = async intercepted => {
    const req = intercepted.request(), input = req.postDataJSON()
    assert.equal(req.method(), 'POST'); assert.equal(req.headers()['x-dsh-octo-client'], '1')
    assert.equal(new URL(req.url()).pathname.split('/').at(-2), accountId)
    assert.equal(input.revision, accountRevision)
    calls.push(input)
    if (state.gate) { const waiting = state.gate; state.gate = null; await waiting }
    if (state.failNext) { state.failNext = false; await intercepted.fulfill({ status: 502, json: { error: 'webhook_outcome_unknown' } }); return }
    const current = rows.get(input.route?.address) || []
    let result
    if (input.action === 'routes') result = { routes: [route, child] }
    else if (input.action === 'threads') result = { routes: [child], page: 1, more: false }
    else if (input.action === 'list') result = { list: current }
    else if (input.action === 'deliveries') result = { deliveries: [{ status: 1, reason: '', http_status: 200, adapter: 'test', byte_size: 9, message_id: '9223372036854775807', created_at: 123 }] }
    else if (input.action === 'test') {
      assert.equal(input.confirmed, true); result = { test: { message_id: '0' } }
    } else if (input.action === 'delete') {
      assert.equal(input.confirmed, true); rows.set(input.route.address, current.filter(item => item.webhook_id !== input.webhookId)); result = { deleted: input.webhookId }
    } else if (input.action === 'create' || input.action === 'update' || input.action === 'regenerate') {
      if (input.action === 'regenerate') assert.equal(input.confirmed, true)
      const item = row({ ...(current.find(item => item.webhook_id === input.webhookId) || {}), ...input.changes,
        ...(input.action === 'create' && { webhook_id: 'iwh_' + 'c'.repeat(32) }) })
      for (const key of ['allow_mention_all', 'allow_mention_bots']) item[key] = Number(item[key])
      rows.set(input.route.address, [...current.filter(row => row.webhook_id !== item.webhook_id), item])
      result = { webhook: item }
      if (input.action !== 'update') result.secret = { token: secret, url: 'https://octo.invalid/v1/incoming-webhooks/' + item.webhook_id + '/' + secret,
        urls: { native: 'https://octo.invalid/v1/incoming-webhooks/' + item.webhook_id + '/' + secret }, adapter_examples: [] }
    } else throw Error('Unexpected fixture action')
    await intercepted.fulfill({ status: 200, headers: { 'Cache-Control': 'no-store' }, json: { accountId, accountRevision, ...result } })
  }
  await page.route(urlPattern, intercept)
  await page.evaluate(() => {
    window.__webhookFixtureCopies = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__webhookFixtureCopies.push(text) },
    } })
  })
  return { calls, rows, state, dispose: () => page.unroute(urlPattern, intercept) }
}

export async function exerciseWebhookUi(page, fixture, { screenshotDir } = {}) {
  const screenshots = []
  const manager = page.locator('dialog.dsho-webhook-modal[open]')
  const checkVisible = async subject => {
    await subject.scrollIntoViewIfNeeded()
    const geometry = await subject.evaluate(element => {
      const dialog = element.closest('dialog'), panel = dialog.querySelector('.dsho-webhook-panel')
      const box = element.getBoundingClientRect(), frame = dialog.getBoundingClientRect(), body = panel.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(20, box.height / 2))
      return { modal: dialog.matches(':modal'), frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom },
        width: innerWidth, height: innerHeight, panelHeight: body.height, overflow: panel.scrollWidth - panel.clientWidth,
        visible: box.top >= body.top - 1 && box.bottom <= body.bottom + 1 && box.left >= body.left - 1 && box.right <= body.right + 1,
        foreground: hit === element || element.contains(hit) }
    })
    assert.equal(geometry.modal, true, 'management must occupy its own modal top layer')
    assert.ok(geometry.frame.left >= 0 && geometry.frame.top >= 0 && geometry.frame.right <= geometry.width + 1 && geometry.frame.bottom <= geometry.height + 1)
    assert.ok(geometry.panelHeight >= Math.min(480, geometry.height * 0.65), 'usable viewport, not an account footer slot')
    assert.ok(geometry.overflow <= 2, 'no horizontal panel overflow')
    assert.equal(geometry.visible, true, 'whole confirmation/secret region must be visible within its scroll viewport')
    assert.equal(geometry.foreground, true, 'region must not be clipped or covered by the account form')
  }
  const snapshot = async (name, subject) => {
    await checkVisible(subject)
    if (!screenshotDir) return
    mkdirSync(screenshotDir, { recursive: true })
    const path = join(screenshotDir, name + '.png')
    await page.screenshot({ path, animations: 'disabled' }); screenshots.push(path)
  }
  const manage = page.getByRole('button', { name: /^(管理 Webhook|Manage webhooks)$/ })
  await manage.click()
  await manager.waitFor()
  const panel = manager.locator('.dsho-webhook-panel')
  const click = label => manager.getByRole('button', { name: label, exact: true }).click()
  const select = panel.getByLabel(/^(目标频道|Target channel)$/)
  await click(/^(读取可选频道|Load channels)$/)
  await select.selectOption('2:' + group)
  await panel.getByText('Webhook fixture', { exact: true }).waitFor()
  assert.ok(fixture.calls.every(call => ['routes', 'list'].includes(call.action)))
  await click(/^(编辑|Edit)$/)
  await panel.getByLabel(/^(名称|Name)$/).fill('Edited fixture')
  await panel.getByLabel(/^(头像地址（管理员权限）|Avatar URL \(administrator only\))$/).fill('https://images.invalid/test.png')
  await panel.getByLabel(/^(允许 @所有人|Allow @everyone)$/).check()
  await panel.getByLabel(/^(允许 @所有 AI|Allow @all bots)$/).check()
  await panel.getByLabel(/^(定向提及 UID（逗号分隔）|Target mention UIDs \(comma-separated\))$/).fill('fixture-person, fixture-second')
  await panel.getByLabel(/^(启用|Enabled)$/).uncheck()
  await click(/^(保存|Save)$/)
  await panel.getByText('Edited fixture', { exact: true }).waitFor()
  assert.deepEqual(fixture.calls.at(-1).changes, { name: 'Edited fixture', avatar: 'https://images.invalid/test.png', status: 0,
    allow_mention_all: true, allow_mention_bots: true, mention_uids: ['fixture-person', 'fixture-second'] })
  const beforeCancel = fixture.calls.length
  await click(/^(删除|Delete)$/)
  await panel.getByRole('group').getByText(/fixture-person, fixture-second/).waitFor()
  await click(/^(取消|Cancel)$/)
  assert.equal(fixture.calls.length, beforeCancel)
  await click(/^(发送测试消息|Send test message)$/)
  assert.equal(fixture.calls.length, beforeCancel)
  await panel.getByRole('group').scrollIntoViewIfNeeded()
  await snapshot('webhook-test-confirmation', panel.getByRole('group'))
  await click(/^(确认执行|Confirm action)$/)
  await panel.getByText(/未提供消息 ID|without a message ID/).waitFor()
  assert.equal(fixture.calls.filter(call => call.action === 'test').length, 1)
  await click(/^(投递诊断|Delivery diagnostics)$/)
  await panel.getByText(/9223372036854775807/).waitFor()
  await panel.getByText(/9223372036854775807/).scrollIntoViewIfNeeded()
  await snapshot('webhook-delivery-diagnostics', panel.locator('.dsho-webhook-detail'))
  await click(/^(创建 Webhook|Create webhook)$/)
  await panel.getByLabel(/^(名称|Name)$/).fill('Created fixture')
  await click(/^(保存|Save)$/)
  await panel.locator('.dsho-webhook-secret').waitFor()
  assert.equal(await panel.locator('.dsho-webhook-secret').innerText(), '••••••••••••••••')
  assert.equal(await page.evaluate(() => window.__webhookFixtureCopies.length), 0)
  assert.ok(!(await panel.innerText()).includes(secret))
  await panel.locator('.dsho-webhook-secret').scrollIntoViewIfNeeded()
  await snapshot('webhook-secret-masked', panel.locator('.dsho-webhook-detail'))
  {
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    await panel.locator('.dsho-webhook-secret').scrollIntoViewIfNeeded()
    await snapshot('webhook-secret-masked-narrow', panel.locator('.dsho-webhook-detail'))
    if (viewport) await page.setViewportSize(viewport)
  }
  await click(/^(显示密钥与接入说明|Reveal secrets and setup)$/)
  assert.ok((await panel.locator('.dsho-webhook-secret').innerText()).includes(secret))
  await click(/^(隐藏|Hide)$/)
  assert.ok(!(await panel.innerText()).includes(secret))
  await click(/^(复制密钥与接入说明|Copy secrets and setup)$/)
  assert.equal(await page.evaluate(() => window.__webhookFixtureCopies.length), 1)
  await select.selectOption('5:' + child.address)
  await panel.getByText('Webhook fixture', { exact: true }).waitFor()
  assert.equal(await panel.locator('.dsho-webhook-secret').count(), 0)
  await click(/^(重新生成密钥|Regenerate secret)$/)
  await click(/^(确认执行|Confirm action)$/)
  await panel.locator('.dsho-webhook-secret').waitFor()
  await click(/^(关闭并清除密钥|Close and clear secrets)$/)
  await manage.click()
  assert.equal(await panel.locator('.dsho-webhook-secret').count(), 0)
  await click(/^(读取可选频道|Load channels)$/)
  await select.selectOption('5:' + child.address)
  await panel.getByText('Webhook fixture', { exact: true }).waitFor()
  fixture.state.failNext = true
  await click(/^(发送测试消息|Send test message)$/)
  await click(/^(确认执行|Confirm action)$/)
  await panel.getByRole('alert').getByText(/不会自动重试|No automatic retry/).waitFor()
  const attempts = fixture.calls.filter(call => call.action === 'test').length
  await page.waitForTimeout(250)
  assert.equal(fixture.calls.filter(call => call.action === 'test').length, attempts)
  assert.equal(attempts, 2)
  await click(/^(刷新列表|Refresh list)$/)
  await panel.getByText('Webhook fixture', { exact: true }).waitFor()
  await click(/^(删除|Delete)$/)
  await click(/^(确认执行|Confirm action)$/)
  await panel.getByText(/暂无 Webhook|No webhooks in/).waitFor()
  assert.equal(fixture.calls.filter(call => call.action === 'delete').length, 1)
  await click(/^(关闭并清除密钥|Close and clear secrets)$/)
  return { operations: fixture.calls.length, explicitTests: attempts, explicitCopies: 1, screenshots }
}

export async function runWebhookUiSmoke(page, options = {}) {
  options = { screenshotDir: process.env.DSH_OCTO_WEBHOOK_UI_SCREENSHOTS || process.env.DSH_OCTO_SMOKE_SCREENSHOTS, ...options }
  const endpoint = new URL('/api/dsh-channel-octo', page.url())
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'development fixture only')
  const response = await page.request.get(endpoint.href)
  assert.equal(response.status(), 200)
  const overview = await response.json()
  const account = overview.accounts.find(account => /fixture/i.test(account.botUid))
  assert.ok(account, 'requires a synthetic fixture bot; refuses real accounts')
  const fixture = await installWebhookUiFixture(page, account.id, overview.accountRevision)
  try {
    const config = page.locator('[data-octo-settings]')
    if (!await config.isVisible()) {
      await page.keyboard.press('Control+Alt+,')
      await page.getByRole('button', { name: /^(Octo 渠道|Octo channel)$/ }).click({ timeout: 10000 })
    }
    const accountRow = config.locator('.dsho-account-line').filter({ has: page.getByRole('button', { name: new RegExp(account.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }) }).first()
    await accountRow.getByRole('button', { name: /^(设置|Settings) · / }).click()
    const result = await exerciseWebhookUi(page, fixture, options)
    await page.locator('.dsho-account-modal[open]').getByRole('button', { name: /^(关闭|Close)$/ }).click()
    return { ...result, nativeDshSettings: true }
  } finally { await fixture.dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [launch, module, executablePath] = process.argv.slice(2)
  if (!launch || !module || !executablePath || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(launch).hostname)) {
    throw Error('Supply an isolated loopback DSH fixture URL, Playwright module and browser executable')
  }
  const { chromium } = await import(pathToFileURL(resolve(module)).href)
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    await page.goto(launch)
    const proceed = page.getByRole('dialog').getByRole('button', { name: /^(继续|Continue|跳过|Skip|开始使用|Get started)$/i }).first()
    for (let i = 0; i < 5; i++) {
      if (!await proceed.isVisible().catch(() => false)) break
      await proceed.click(); await page.waitForTimeout(100)
    }
    console.log(JSON.stringify(await runWebhookUiSmoke(page, { screenshotDir: process.env.DSH_OCTO_WEBHOOK_UI_SCREENSHOTS })))
  } finally { await browser.close() }
}
