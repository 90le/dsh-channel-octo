import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountChannelTools } from '../src/channel-tools.js'

// Optional real-service run, without installing dependencies in this project:
// DSH_CHANNEL_TOOLS_RUNTIME=/path/to/rc.5-host node --test test/channel-tools.test.js
// The directory must contain package.json + installed rc.5 DSH packages.
let native
if (process.env.DSH_CHANNEL_TOOLS_RUNTIME) {
  const require = createRequire(pathToFileURL(resolve(process.env.DSH_CHANNEL_TOOLS_RUNTIME, 'package.json')))
  for (const name of ['dsh-tools', 'dsh-system-prompt', 'dsh-scope']) {
    const manifest = JSON.parse(readFileSync(require.resolve(`@deepseek-ai/${name}/package.json`), 'utf8'))
    assert.equal(manifest.version, '0.2.1-rc.5', `native test requires rc.5 ${name}`)
  }
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)))
  const [{ Context }, { default: Tools }, { default: Prompt }, { createScope }] = await Promise.all([
    load('cordis'), load('dsh-tools'), load('dsh-system-prompt'), load('dsh-scope'),
  ])
  native = { Context, Tools, Prompt, createScope }
}

const spec = (name = 'octo_channel') => ({
  name, description: 'Read bounded current-channel history.',
  parameters: {
    type: 'object', properties: { operation: { type: 'string', enum: ['history'] }, args: { type: 'object' } },
    required: ['operation'], additionalProperties: false,
  },
})
const freshSignal = () => new AbortController().signal
const args = { operation: 'history', args: { limit: 3 } }
const deferred = () => Promise.withResolvers()
const errorText = result => result.content.map(block => block.text ?? '').join('')

// Mirrors rc.5's synchronous generator effects, per-layer duplicate names and
// thrown-body -> error-result normalization. Native runs replace this fixture;
// prompt routing, guard ordering and lossless-JSON enforcement are tested below
// only against the real service, never claimed from this small double.
function localHarness(t) {
  const definitions = new Map(), effects = []
  const tools = {
    register(definition) {
      if (definitions.has(definition.name)) throw new Error('duplicate tool')
      definitions.set(definition.name, definition)
      let live = true
      return () => { if (live) { live = false; definitions.delete(definition.name) } }
    },
  }
  const scoped = {
    get: name => name === 'tools' ? tools : undefined,
    effect(body) {
      const cleanup = []
      let live = true
      const off = () => { if (live) { live = false; for (const fn of cleanup.reverse()) fn() } }
      try { for (const fn of body()) cleanup.push(fn) } catch (error) { off(); throw error }
      effects.push(off)
      return off
    },
  }
  const close = () => { for (const off of [...effects].reverse()) off() }
  t.after(close)
  return { scoped, tools, close, get: name => definitions.get(name),
    async call(name, input = args, signal = freshSignal()) {
      try {
        const definition = definitions.get(name)
        if (!definition) throw new Error('unknown tool')
        const value = await definition.execute(input, { signal })
        return { isError: false, value, content: definition.output.render(input, value) }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] }
      }
    },
  }
}

async function nativeHarness(t) {
  const { Context, Tools, Prompt, createScope } = native
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(Prompt)
  await root.plugin(Tools)
  const agent = { id: 'octo-fixture' }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const tools = scope.ctx.get('tools')
  let call = 0
  return { root, agent, scoped: scope.ctx, tools, close: scope.dispose,
    get: name => root.tools.get(name, agent),
    call: (name, input = args, signal = freshSignal()) => root.tools.execute({
      name, arguments: input, signal, agent, callId: `fixture-${++call}`,
    }),
  }
}
const harness = native ? nativeHarness : localHarness
const options = overrides => ({ specs: [spec()], execute: async () => ({ ok: true }),
  signal: freshSignal(), isActive: () => true, ...overrides })

test('registers raw JSON Schema and canonical JSON output without forwarding extra spec fields', async t => {
  const h = await harness(t)
  const raw = spec()
  raw.parameters.properties.args = { type: 'object', properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '^.{1,4000}$' },
  }, additionalProperties: false }
  raw.execute = () => assert.fail('untrusted spec callback')
  raw.output = { render: () => assert.fail('untrusted spec renderer') }
  const calls = []
  const off = mountChannelTools(h.scoped, options({ specs: [raw], execute: async (...call) => {
    calls.push(call)
    return { messages: [{ text: '你好' }], complete: false }
  } }))
  assert.deepEqual(off.names, ['octo_channel'])
  assert.ok(Object.isFrozen(off.names))
  assert.throws(() => off.names.push('bash'), TypeError)
  assert.deepEqual(h.get('octo_channel').parameters, raw.parameters)
  assert.deepEqual(h.get('octo_channel').output.schema, {})
  raw.parameters.properties.operation.enum.push('shell')
  raw.name = 'bash'
  assert.deepEqual(h.get('octo_channel').parameters.properties.operation.enum, ['history'])
  const result = await h.call('octo_channel')
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(errorText(result)), { messages: [{ text: '你好' }], complete: false })
  assert.equal(calls[0][0], 'octo_channel')
  assert.deepEqual(calls[0][1], args)
  assert.ok(calls[0][2] instanceof AbortSignal)
  assert.equal(result.concludesTurn, undefined)
  await off()
  await off()
  assert.equal(h.get('octo_channel'), undefined)
})

test('checks authority at execution, permits later activation and fails closed on lookup failure', async t => {
  const h = await harness(t)
  let active = false, calls = 0
  mountChannelTools(h.scoped, options({ isActive: () => active,
    execute: async () => { calls++; return { ok: true } } }))
  assert.match(errorText(await h.call('octo_channel')), /channel_tool_not_active/)
  assert.equal(calls, 0)
  active = true
  assert.equal((await h.call('octo_channel')).isError, false)
  active = Promise.resolve(true)
  assert.match(errorText(await h.call('octo_channel')), /channel_tool_not_active/)
  assert.equal(calls, 1)
  mountChannelTools(h.scoped, options({ specs: [spec('octo_lookup')],
    isActive() { throw new Error('private authorization details') } }))
  const denied = errorText(await h.call('octo_lookup'))
  assert.match(denied, /channel_tool_authority_unavailable/)
  assert.ok(!denied.includes('private authorization details'))
})

test('revoked authority while work settles cannot return a successful result', async t => {
  const h = await harness(t), entered = deferred(), settled = deferred()
  let active = true
  mountChannelTools(h.scoped, options({ isActive: () => active, execute: async () => {
    entered.resolve(); await settled.promise; return { private: 'result' }
  } }))
  const result = h.call('octo_channel')
  await entered.promise
  active = false
  settled.resolve()
  assert.match(errorText(await result), /channel_tool_not_active/)
  assert.ok(!errorText(await result).includes('private'))
})

for (const source of ['task', 'tool']) {
  test(`pre-aborted ${source} signal prevents dispatch`, async t => {
    const h = await harness(t), controller = new AbortController()
    controller.abort(new Error('cancelled'))
    mountChannelTools(h.scoped, options({ signal: source === 'task' ? controller.signal : freshSignal(),
      execute: () => assert.fail('must not dispatch') }))
    assert.equal((await h.call('octo_channel', args, source === 'tool' ? controller.signal : freshSignal())).isError, true)
  })

  test(`${source} cancellation reaches the operation and waits for its cleanup`, async t => {
    const h = await harness(t), controller = new AbortController(), entered = deferred(), cleanup = deferred()
    let operationSignal, returned = false
    mountChannelTools(h.scoped, options({ signal: source === 'task' ? controller.signal : freshSignal(),
      execute: async (_name, _args, signal) => {
        operationSignal = signal
        entered.resolve()
        await cleanup.promise
        return { ok: true }
      } }))
    const result = h.call('octo_channel', args, source === 'tool' ? controller.signal : freshSignal())
      .then(value => { returned = true; return value })
    await entered.promise
    const reason = new Error('cancel operation')
    controller.abort(reason)
    assert.equal(operationSignal.aborted, true)
    assert.equal(operationSignal.reason, reason)
    await Promise.resolve()
    assert.equal(returned, false)
    cleanup.resolve()
    assert.equal((await result).isError, true)
  })
}

for (const closing of ['disposer', 'scope']) test(`${closing} unregisters, aborts in-flight work and revokes captured bodies`, async t => {
  const h = await harness(t), entered = deferred(), cleanup = deferred()
  let operationSignal, calls = 0
  const off = mountChannelTools(h.scoped, options({ execute: async (_name, _args, signal) => {
    calls++; operationSignal = signal; entered.resolve(); await cleanup.promise; return null
  } }))
  const captured = h.get('octo_channel')
  const result = h.call('octo_channel')
  await entered.promise
  if (closing === 'scope') await h.close()
  else await off()
  assert.equal(operationSignal.aborted, true)
  assert.equal(h.get('octo_channel'), undefined)
  await assert.rejects(captured.execute(args, { signal: freshSignal() }), /channel_tool_aborted/)
  assert.equal(calls, 1)
  cleanup.resolve()
  assert.equal((await result).isError, true)
})

test('rolls back partial registration while preserving an existing tool', async t => {
  const h = await harness(t)
  const previous = mountChannelTools(h.scoped, options({ specs: [spec('octo_existing')] }))
  const existing = h.get('octo_existing')
  assert.throws(() => mountChannelTools(h.scoped, options({ specs: [spec(), spec('octo_existing')] })))
  assert.equal(h.get('octo_channel'), undefined)
  assert.equal(h.get('octo_existing'), existing)
  assert.equal((await h.call('octo_existing')).isError, false)
  await previous()
})

test('rejects malformed setup before registering any tool', async t => {
  const h = await harness(t)
  for (const specs of [null, [spec(), spec()], [spec(), spec('run_code')], [{ ...spec(), parameters: {} }],
    [spec(), { ...spec('octo_other'), description: undefined }]]) {
    assert.throws(() => mountChannelTools(h.scoped, options({ specs })), /invalid_channel_tool/)
    assert.equal(h.get('octo_channel'), undefined)
  }
  for (const invalid of [{ execute: null }, { isActive: undefined }, { signal: undefined }]) {
    assert.throws(() => mountChannelTools(h.scoped, options(invalid)), /invalid_channel_tools_options/)
  }
  assert.throws(() => mountChannelTools({ get: () => ({}) }, options()), /missing_scoped_tool_controls/)
  const empty = mountChannelTools(h.scoped, options({ specs: [] }))
  assert.deepEqual(empty.names, [])
  await empty()
})

test('operation errors stay explicit and bounded; later model tool calls still work', async t => {
  const h = await harness(t)
  let calls = 0
  mountChannelTools(h.scoped, options({ execute: async () => {
    if (++calls === 1) throw new Error('upstream denied ' + 'x'.repeat(4000), { cause: new Error('hidden cause') })
    return { ok: true }
  } }))
  const failed = await h.call('octo_channel')
  assert.equal(failed.isError, true)
  assert.match(errorText(failed), /channel_tool_failed: upstream denied/)
  assert.ok(errorText(failed).length < 1100)
  assert.ok(!errorText(failed).includes('hidden cause'))
  assert.equal(failed.concludesTurn, undefined)
  assert.equal((await h.call('octo_channel')).isError, false)
})

test('rejects oversized UTF-8 results and unserializable results explicitly', async t => {
  const h = await harness(t)
  let value
  mountChannelTools(h.scoped, options({ execute: async () => value }))
  for (const item of [undefined, 1n, { self: null }]) {
    value = item
    if (value && typeof value === 'object') value.self = value
    assert.match(errorText(await h.call('octo_channel')), /channel_tool_invalid_result/)
  }
  value = '中'.repeat(24 * 1024)
  assert.match(errorText(await h.call('octo_channel')), /channel_tool_result_too_large/)
  value = null
  assert.equal((await h.call('octo_channel')).isError, false)
})

const nativeOnly = { skip: !native && 'Set DSH_CHANNEL_TOOLS_RUNTIME to an installed rc.5 host.' }
const harmlessTool = name => ({ name, description: name, parameters: { type: 'object' },
  output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute: async () => ({ fixture: name }),
})

test('native rc.5: scope-local names bypass restrict([]), exact guards/filter deny other tools', nativeOnly, async t => {
  const h = await nativeHarness(t)
  for (const name of ['bash', 'read_file', 'agent_team']) h.root.tools.register(harmlessTool(name))
  h.tools.register(harmlessTool('scope_plugin_tool'))
  const off = mountChannelTools(h.scoped, options())
  const names = new Set(off.names)
  // rc.5 intentionally rejects LOCAL names in restrict({ allow: names }).
  assert.throws(() => h.tools.restrict({ allow: off.names }), /unknown global tool/)
  const controls = [h.tools.presentAs('native'), h.tools.restrict({ allow: [] }),
    h.scoped.on('tools/pre-execute', async (_exec, next) => { await next(); return { kind: 'allow' } }),
    h.tools.guard(exec => names.has(exec.name) ? undefined : 'channel tools only'),
    h.scoped.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return { ...assembled, tools: assembled.tools.filter(tool => names.has(tool.name)) }
    }, { prepend: true }),
  ]
  assert.deepEqual((await h.root.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name), off.names)
  assert.equal((await h.call('octo_channel')).isError, false)
  for (const name of ['bash', 'read_file', 'agent_team', 'scope_plugin_tool', 'ask_user_question', 'run_code']) {
    assert.equal((await h.call(name)).isError, true, name)
  }
  assert.equal(h.root.tools.get('octo_channel'), undefined)
  assert.deepEqual((await h.root.systemPrompt.assemble()).tools.map(tool => tool.name), ['agent_team', 'bash', 'read_file'])
  for (const release of controls.reverse()) await release()
  await off()
  assert.equal((await h.call('scope_plugin_tool')).isError, false)
  assert.equal((await h.call('bash')).isError, false)
})

test('native rc.5: mounted alongside full tools, same tool name routes independently per agent', nativeOnly, async t => {
  const h = await nativeHarness(t)
  h.root.tools.register(harmlessTool('bash'))
  h.root.tools.register(harmlessTool('octo_channel'))
  const peer = { id: 'other-octo' }
  const scope = native.createScope(h.root, peer)
  peer.ctx = scope.ctx
  mountChannelTools(h.scoped, options({ execute: async () => ({ route: 'group-A' }) }))
  mountChannelTools(scope.ctx, options({ execute: async () => ({ route: 'group-B' }) }))
  assert.equal((await h.call('bash')).isError, false)
  assert.equal((await h.call('octo_channel')).value.route, 'group-A')
  const other = await h.root.tools.execute({ name: 'octo_channel', arguments: args, agent: peer,
    signal: freshSignal(), callId: 'peer-call' })
  assert.equal(other.value.route, 'group-B')
  await h.close()
  assert.equal(h.root.tools.get('octo_channel', h.agent), h.root.tools.get('octo_channel'))
  assert.ok(h.root.tools.get('octo_channel', peer))
  await scope.dispose()
})

test('native rc.5: raw argument validation belongs to dispatch; output must be lossless JSON', nativeOnly, async t => {
  const h = await nativeHarness(t)
  let calls = 0, value = { ok: true }
  mountChannelTools(h.scoped, options({ execute: async (_name, input) => {
    calls++
    if (input.operation !== 'history') throw new Error('invalid_operation')
    return value
  } }))
  const invalid = await h.call('octo_channel', { operation: 'shell', route: 'another-group' })
  assert.match(errorText(invalid), /invalid_operation/)
  assert.equal(calls, 1)
  value = { omitted: undefined }
  assert.equal((await h.call('octo_channel')).isError, true)
  value = { ok: true }
  assert.equal((await h.call('octo_channel')).isError, false)
})
