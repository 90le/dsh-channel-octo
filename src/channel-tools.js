// DSH 0.2.1-rc.5 raw ToolDefinition adapter. No preset or permission changes.
const maxResultBytes = 64 * 1024
const maxErrorLength = 1024

/**
 * Mount current-route Octo tools through the caller's actual agent.ctx.
 *
 * The caller owns restrict/guard/prompt filtering and must bind route + sender
 * in execute's closure. Raw parameters are model-facing JSON Schema, not the
 * defineTool property DSL. DSH does not validate raw input schemas: execute
 * must validate arguments, operation permissions and current-route access.
 *
 * @param {object} scoped DSH scoped Cordis context, never the host/root context.
 * @param {object} options
 * @param {Array<{name: string, description: string, parameters: object}>} options.specs
 * @param {function(string, unknown, AbortSignal): Promise<unknown>} options.execute
 *   Returns lossless JSON (at most 64 KiB when encoded as UTF-8 JSON).
 *   Forward the signal and await all owned work;
 *   this adapter never abandons an operation or retries an uncertain write.
 * @param {AbortSignal} options.signal Task lifetime/deadline signal.
 * @param {function(): boolean} options.isActive Synchronous live authority check;
 *   true only for the claimed, unmixed, authorized Octo turn.
 * @returns {function(): unknown} Idempotent disposer with a frozen .names array.
 *   Scope teardown also revokes execution and aborts in-flight operations.
 */
export function mountChannelTools(scoped, { specs, execute, signal, isActive }) {
  const tools = scoped?.get?.('tools')
  if (typeof tools?.register !== 'function' || typeof scoped?.effect !== 'function') {
    throw new Error('missing_scoped_tool_controls')
  }
  if (!Array.isArray(specs) || typeof execute !== 'function' || typeof isActive !== 'function'
    || !(signal instanceof AbortSignal)) throw new TypeError('invalid_channel_tools_options')

  const names = new Set()
  const definitions = specs.map(spec => {
    if (!spec || typeof spec.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name)
      || spec.name === 'run_code' || names.has(spec.name) || typeof spec.description !== 'string'
      || !spec.parameters || spec.parameters.type !== 'object' || Array.isArray(spec.parameters)) {
      throw new TypeError('invalid_channel_tool_spec')
    }
    names.add(spec.name)
    return { name: spec.name, description: spec.description, parameters: structuredClone(spec.parameters) }
  })

  const lifetime = new AbortController()
  const assertAuthority = toolSignal => {
    if (toolSignal.aborted) throw new Error('channel_tool_aborted')
    let active = false
    try { active = isActive() === true } catch (error) {
      // A failed authority lookup must not grant access or expose its internals.
      throw new Error('channel_tool_authority_unavailable')
    }
    if (!active) throw new Error('channel_tool_not_active')
  }

  const dispose = scoped.effect(function* () {
    // Yield first so partial registration failures also revoke captured bodies.
    yield () => lifetime.abort(new Error('channel_tools_disposed'))
    for (const definition of definitions) {
      yield tools.register({
        ...definition,
        output: {
          // rc.5 accepts {} for any lossless JSON and validates it natively.
          schema: {},
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const toolSignal = AbortSignal.any([signal, exec.signal, lifetime.signal])
          assertAuthority(toolSignal)
          let value
          try {
            value = await execute(definition.name, args, toolSignal)
          } catch (error) {
            assertAuthority(toolSignal)
            // DSH converts this to an error tool result, not a turn conclusion.
            // Include only the bounded message; never serialize stack or cause.
            const message = typeof error?.message === 'string' ? error.message
              : typeof error === 'string' ? error : 'channel_operation_failed'
            throw new Error(`channel_tool_failed: ${message.slice(0, maxErrorLength)}`)
          }
          assertAuthority(toolSignal)
          let text
          try { text = JSON.stringify(value) } catch (error) {
            throw new Error('channel_tool_invalid_result')
          }
          if (text === undefined) throw new Error('channel_tool_invalid_result')
          if (Buffer.byteLength(text, 'utf8') > maxResultBytes) throw new Error('channel_tool_result_too_large')
          return value
        },
      })
    }
  }, 'dsh-channel-octo.channel-tools')
  Object.defineProperty(dispose, 'names', { value: Object.freeze([...names]), enumerable: true })
  return dispose
}
