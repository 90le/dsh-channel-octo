import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeImControls, parseSafeCommand } from '../src/im-controls.js'

const defaults = { sendMode: 'queue', dmCommands: 'off', groupCommands: 'off', allowFiles: false }
const enabled = { sendMode: 'steer', dmCommands: 'safe', groupCommands: 'safe', allowFiles: true }
const dm = { channelType: 1, routeAllowed: true, actorApproved: true }
const group = { ...dm, channelType: 2, botUid: 'octo_bot', isBotOwner: true, mention: { uids: ['octo_bot'] } }
const blocked = { kind: 'blocked' }
const command = name => ({ kind: 'command', command: name })

test('old and malformed account controls cannot enable a capability', () => {
  for (const raw of [undefined, null, false, [], 'steer', Object.create(enabled), {
    sendMode: 'Steer', dmCommands: true, groupCommands: 'all', allowFiles: 'true',
  }]) assert.deepEqual(normalizeImControls(raw), defaults)

  const one = normalizeImControls({ dmCommands: 'safe', allowFiles: true, unknown: 'steer' })
  assert.deepEqual(one, { ...defaults, dmCommands: 'safe', allowFiles: true })
  assert.deepEqual(normalizeImControls(Object.freeze({ ...enabled })), enabled)
  one.sendMode = 'steer'
  assert.deepEqual(normalizeImControls(), defaults)
})

test('DM commands need an independently approved actor and route on a safe account', () => {
  assert.deepEqual(parseSafeCommand(' \t/HELP \t', enabled, dm), command('help'))
  assert.deepEqual(parseSafeCommand('/status', enabled, dm), command('status'))
  assert.deepEqual(parseSafeCommand('/new', enabled, dm), command('new'))
  assert.deepEqual(parseSafeCommand('/STOP', enabled, dm), command('stop'))
  for (const route of [undefined, { ...dm, routeAllowed: false }, { ...dm, actorApproved: false },
    { ...dm, actorApproved: 'true' }, { ...dm, channelType: 9 }, { ...dm, hasAttachments: true }]) {
    assert.deepEqual(parseSafeCommand('/status', enabled, route), blocked)
  }
  assert.deepEqual(parseSafeCommand('/new', { groupCommands: 'safe' }, dm), blocked)
  assert.deepEqual(parseSafeCommand('/new', undefined, dm), blocked)
  assert.deepEqual(parseSafeCommand('@Octo /new', enabled, dm), blocked)
})

test('group and topic commands require the bot owner and a direct, unambiguous bot mention', () => {
  assert.deepEqual(parseSafeCommand('@Octo /help', enabled, group), command('help'))
  assert.deepEqual(parseSafeCommand('@[octo_bot:Octo Bot] /status', enabled, group), command('status'))
  assert.deepEqual(parseSafeCommand('/new', enabled, { ...group, channelType: 5 }), command('new'))

  for (const route of [dm, { ...group, isBotOwner: false }, { ...group, actorApproved: false },
    { ...group, routeAllowed: false }, { ...group, mention: undefined },
    { ...group, mention: { uids: ['other'] } },
    { ...group, mention: { uids: ['octo_bot', 'other'] } },
    ...['all', 'ais', 'humans'].map(flag => ({ ...group, mention: { ...group.mention, [flag]: 1 } })),
  ]) assert.deepEqual(parseSafeCommand('@Octo /new', enabled, route), blocked)

  assert.deepEqual(parseSafeCommand('@[other:Octo] /new', enabled, group), blocked)
  assert.deepEqual(parseSafeCommand('@other @Octo /new', enabled, group), blocked)
  assert.deepEqual(parseSafeCommand('@Octo /new', { dmCommands: 'safe' }, group), blocked)
})

test('malformed and unrecognized slash commands cannot become prompts', () => {
  for (const input of ['/shell whoami', '/shell/foo', '/exec/bin', '/webhook/create', '/reset', '/card', '/choose', '/stop another', '/new session', '/new;whoami', '/NEW/foo', '/help.md',
    '/new\nrun this', '/new\r\n', '/help\u200b', '\u200b/help', '/status@octo_bot', '//new', '/']) {
    assert.deepEqual(parseSafeCommand(input, enabled, dm), blocked, input)
  }
  assert.deepEqual(parseSafeCommand('@Octo /exec whoami', enabled, group), blocked)
  assert.deepEqual(parseSafeCommand('@Octo\n/new', enabled, group), blocked)
  for (const input of ['How do I use /new?', '@Octo help with /new', '讨论 /status']) {
    assert.deepEqual(parseSafeCommand(input, enabled, group), { kind: 'text' }, input)
  }
})

test('messages starting with an absolute workspace path are ordinary text', () => {
  for (const input of ['/srv/agents/样例 的本地配置', '/tmp/sample.md\n请查看文件', '/home/user/workspace\r\n参考这一份']) {
    assert.deepEqual(parseSafeCommand(input, defaults, dm), { kind: 'text' }, input)
    assert.deepEqual(parseSafeCommand('@Octo ' + input, enabled, group), { kind: 'text' }, input)
  }
})
