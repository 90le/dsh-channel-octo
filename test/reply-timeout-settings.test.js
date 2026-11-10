import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { resolveConfig } from '../src/config.js'
import { channelView, loadSettings, registerWeb } from '../src/web.js'

const base = { apiBase: 'https://octo.invalid/api', cwd: process.cwd(), botUid: 'fixture-bot',
  spaceId: 'fixture-space', allowedUids: ['fixture-owner'] }
const token = 'bf_fixture'
const resolve = changes => resolveConfig({ ...base, ...changes }, { DSH_OCTO_BOT_TOKEN: token })
const dayMs = 86_400_000

test('defaults only when unset, preserves configured milliseconds, and rejects ambiguous values', () => {
  assert.equal(resolve().timeoutMs, 600_000)
  assert.equal(resolve({ timeoutMs: null }).timeoutMs, 600_000, '0.20 treated null as unset')
  for (const timeoutMs of [1000, 5001, 120_000, 90 * dayMs, Number.MAX_SAFE_INTEGER, 'unlimited']) {
    assert.equal(resolve({ timeoutMs }).timeoutMs, timeoutMs)
  }
  for (const timeoutMs of [0, 999, 1000.1, -1000, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '120000', true]) {
    assert.throws(() => resolve({ timeoutMs }), /^Error: invalid_timeouts$/)
  }
})

test('the legacy and account settings routes persist finite and unlimited overrides without changing their shape', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'octo-reply-settings-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const file = join(stateDir, 'web-settings.json')
  writeFileSync(file, '{"timeoutMs": 5001}', { mode: 0o600 })
  const reopen = () => loadSettings({ ...base, timeoutMs: 120_000, stateDir }, stateDir, token)
  const settings = reopen()
  assert.equal(channelView(settings.config).timeoutMs, 5001)
  const accountId = '12345678-1234-1234-1234-123456789abc'
  const routed = []
  let handler
  registerWeb({ get: () => ({ requestRejection: () => undefined }),
    webServer: { register: route => { handler = route.handler } } }, {
    saveRules(id, input) {
      routed.push(id)
      settings.save(input.settings, input.revision)
      return { config: channelView(settings.config), revision: settings.revision() }
    },
  })
  async function save(suffix, override, revision = settings.revision()) {
    const req = Readable.from([Buffer.from(JSON.stringify({ settings: override, revision }))])
    Object.assign(req, { method: 'PUT', url: '/api/dsh-channel-octo' + suffix,
      headers: { 'content-type': 'application/json', 'x-dsh-octo-client': '1' } })
    let status, body
    await handler(req, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } })
    return { status, body }
  }
  const initialRevision = settings.revision()
  const long = await save('/settings', { timeoutMs: 30 * dayMs })
  assert.equal(long.status, 200)
  assert.equal(long.body.config.timeoutMs, 30 * dayMs)
  assert.equal(reopen().config.timeoutMs, 30 * dayMs)
  const accountPath = '/accounts/' + accountId + '/settings'
  const unlimited = await save(accountPath, { timeoutMs: 'unlimited' })
  assert.equal(unlimited.status, 200)
  assert.equal(unlimited.body.config.timeoutMs, 'unlimited')
  assert.deepEqual(await save('/settings', { timeoutMs: 120_000 }, initialRevision),
    { status: 409, body: { error: 'settings_changed' } })
  assert.deepEqual(await save(accountPath, { timeoutMs: 0 }), { status: 400, body: { error: 'invalid_settings' } })
  assert.equal((await save(accountPath, { progress: 'typing' })).status, 200)
  assert.deepEqual(routed, [undefined, accountId, undefined, accountId, accountId])
  assert.equal(reopen().config.timeoutMs, 'unlimited')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { timeoutMs: 'unlimited', progress: 'typing' })
})

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
function settingsUi(timeoutMs) {
  const values = [], requests = []
  let index = 0, plugin, Settings
  const config = channelView(resolve({ timeoutMs }))
  let data = { accounts: [{ id: 'legacy', config, revision: 'first' }] }
  const React = {
    useEffect() {},
    useState(initial) {
      const key = index++
      if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial
      return [values[key], next => { values[key] = typeof next === 'function' ? next(values[key]) : next }]
    },
    useRef(current) { const key = index++; return values[key] ??= { current } },
    useSyncExternalStore(_subscribe, read) { const value = read(); return typeof value === 'string' ? value : data },
    createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children }) : { type, props: props ?? {}, children: children.flat(Infinity) },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => name === 'react' ? React
      : { Button: 'button', Input: 'input', SegmentedTabs: 'tabs' }) } } },
    document: { baseURI: 'https://dsh.invalid/' }, URL,
    async fetch(url, options) {
      assert.equal(url.pathname, '/api/dsh-channel-octo/accounts/legacy/settings')
      const input = JSON.parse(options.body)
      requests.push(input)
      const next = { config: { ...config, ...input.settings }, revision: 'next' }
      data = { accounts: [{ id: 'legacy', ...next }] }
      return Response.json({ ...next, overview: data })
    },
  })
  plugin.apply({ locale: { getSnapshot: () => ({ active: 'en' }) }, effect() {}, slots: {
    inject: (_name, callback) => callback(),
    register: (slot, component) => { if (slot.name === 'settings.section') Settings = component },
  } })
  function *nodes(node) {
    if (!node || typeof node !== 'object') return
    yield node
    for (const child of node.children) yield *nodes(child)
  }
  const find = predicate => {
    index = 0
    return [...nodes(Settings({}))].find(predicate)
  }
  const field = id => find(node => node.props.id === 'dsho-' + id)
  return {
    field, find, requests,
    change: (id, value) => field(id).props.onChange({ target: { value } }),
    submit: () => find(node => node.type === 'form' && node.props['aria-label'] === 'Channel settings')
      .props.onSubmit({ preventDefault() {} }),
  }
}

test('settings show the 600-second default and save durations in any unit with no 600-second cap', async () => {
  for (const [unit, value, ms] of [
    ['seconds', '601.125', 601_125], ['minutes', '25.5', 1_530_000], ['hours', '1.5', 5_400_000], ['days', '30', 30 * dayMs],
  ]) {
    const ui = settingsUi()
    assert.equal(ui.field('timeout').props.value, 600)
    assert.equal(ui.field('timeout').props.max, undefined)
    assert.deepEqual(Array.from(ui.field('timeout-unit').children, option => option.props.value),
      ['seconds', 'minutes', 'hours', 'days', 'unlimited'])
    ui.change('timeout-unit', unit)
    ui.change('timeout', value)
    await ui.submit()
    assert.equal(ui.requests[0].settings.timeoutMs, ms)
    assert.equal(ui.field('timeout-unit').props.value, unit)
    assert.equal(ui.field('timeout').props.value, Number(value))
  }
})

test('settings send unlimited explicitly, then require a valid duration to enable the timer again', async () => {
  const ui = settingsUi(5001)
  assert.equal(ui.field('timeout').props.value, 5.001)
  ui.change('timeout-unit', 'unlimited')
  assert.equal(ui.field('timeout'), undefined)
  await ui.submit()
  assert.equal(ui.requests[0].settings.timeoutMs, 'unlimited')
  ui.change('timeout-unit', 'days')
  await ui.submit()
  assert.equal(ui.requests.length, 1)
  assert.match(ui.find(node => node.props.role === 'alert').children[0], /Enter a valid duration/)
  ui.change('timeout', '1e100')
  await ui.submit()
  assert.equal(ui.requests.length, 1)
  ui.change('timeout', '2')
  await ui.submit()
  assert.equal(ui.requests[1].settings.timeoutMs, 2 * dayMs)
})
