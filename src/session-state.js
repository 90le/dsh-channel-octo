// A live Agent or the host's durable metadata is authoritative. A read failure
// is never treated as deletion, and no event log or message body is inspected.
export async function sessionExists(ctx, sessionId, signal) {
  signal?.throwIfAborted()
  if (ctx.agents?.get?.(sessionId)) return true
  const persistence = ctx.get?.('sessionPersistence')
  if (typeof persistence?.stat !== 'function') return undefined
  const stored = await persistence.stat(sessionId, { signal })
  signal?.throwIfAborted()
  return !!stored || !!ctx.agents?.get?.(sessionId)
}
