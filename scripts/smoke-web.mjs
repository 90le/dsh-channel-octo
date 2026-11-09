// Opt-in: uses an installed, exact-version DSH CLI and a temporary Web profile.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
// Keep filesystem/runtime discovery variables, but never pass existing API keys to the fixture process.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG)$/i.test(key)))
Object.assign(env, {
  DSH_HOME: home, DSH_OCTO_BOT_TOKEN: 'bf_fixture', DEEPSEEK_API_KEY: 'sk-fixture-for-local-smoke',
  DSH_TELEMETRY_DISABLED: '1',
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
let child
try {
  if (node([cli, '--version']).trim() !== '0.2.1-rc.5') throw new Error('Expected DSH 0.2.1-rc.5')
  const [{ filename }] = JSON.parse(node([npm, 'pack', '--json', '--pack-destination', home]))
  for (const spec of [join(home, filename), '@michengai/dsh-im-connect@1.0.30']) {
    node([cli, 'plugin', '--profile', 'web', 'add', spec, '--registry=https://registry.npmjs.org/'])
  }
  const q = JSON.stringify
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: dsh-channel-octo', '  config:', '    enabled: true',
    '    apiBase: https://octo-fixture.invalid/api', '    botUid: fixture-bot',
    '    spaceId: fixture-space', '    allowedUids: [fixture-user]',
    '    allowedGroupIds: ["00112233445566778899aabbccddeeff"]',
    '    allowedThreadIds: ["00112233445566778899aabbccddeeff____123456789012345678"]',
    '    threadRuleMode: inherit-group',
    '    cwd: ' + q(home), '    stateDir: ' + q(state), '    timeoutMs: 8000',
    '- id: llm-deepseek', '  config:', '    baseURL: https://model-fixture.invalid',
  ].join('\n') + '\n')
  child = spawn(process.execPath, [
    '--import', new URL('./web-fixture.mjs', import.meta.url).href,
    cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], { ...common, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12_000) })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && child.exitCode === null && sentCount() !== 5) await delay(200)
  if (sentCount() !== 5) {
    throw new Error('expected five delivered replies; fixture diagnostics: ' + output.replace(/https?:\/\/\S+/g, '[url]'))
  }
  const imLog = readFileSync(join(home, 'dsh-im-connect', 'gateway.log'), 'utf8')
  if (!imLog.includes('API 已注册') || !imLog.includes('attachMappedSessions')) throw new Error('IM Connect did not initialize')
  console.log('PASS: DSH Web + IM Connect; scoped group/topic rules, cleared latest snapshot, isolated history, no model tools.')
} finally {
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
