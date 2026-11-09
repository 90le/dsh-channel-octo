import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OctoClient, OctoError } from '../src/octo.js'
import { apiErrorCode, readApiError, OctoError as ApiOctoError } from '../src/api-errors.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const signal = new AbortController().signal
const secret = 'bf_TEST_SECRET_NEVER_REFLECT'
const secretURL = 'https://private.invalid/webhook/' + secret
const route = { channel_id: 'alice', channel_type: 1 }
// Fixtures follow httperr/respond_test.go and i18n/renderer_test.go in the
// reviewed official server. The prose/details are deliberately hostile here.
const envelope = (code, semantic, wire = semantic) => ({
  error: { code, http_status: semantic, message: secretURL,
    details: { reason: secret, url: secretURL, token: secret, retry_after: 900, nested: { secret } } },
  msg: secretURL, status: wire,
})
const response = (code, semantic, wire = semantic, headers) => Response.json(envelope(code, semantic, wire), { status: wire, headers })
function client(fetchImpl) {
  return new OctoClient({ apiBase: 'https://api.invalid', token: secret, waitSeconds: 1, fetchImpl })
}
function sanitized(error) {
  for (const text of [String(error), error.stack, JSON.stringify(error), inspect(error, { showHidden: true, depth: 10 })]) {
    assert.ok(!text.includes(secret), text)
    assert.ok(!text.includes(secretURL), text)
  }
  for (const key of ['cause', 'body', 'details', 'response', 'url', 'msg', 'headers']) assert.equal(Object.hasOwn(error, key), false)
}
async function failure(api, method = () => api.typing(route, signal)) {
  let caught
  await assert.rejects(method, error => {
    caught = error
    assert.ok(error instanceof OctoError)
    sanitized(error)
    return true
  })
  return caught
}

test('OctoError keeps constructor identity and existing fields', () => {
  assert.equal(ApiOctoError, OctoError)
  const error = new OctoError('http_429', 429, 3000)
  assert.equal(error.message, 'http_429')
  assert.deepEqual({ ...error }, { code: 'http_429', status: 429, retryAfterMs: 3000 })
  assert.equal(apiErrorCode(error), 'api_rate_limited')
  assert.equal(apiErrorCode(undefined), 'api_request_failed')
  assert.equal(apiErrorCode({ status: 400, apiCode: secret, officialCode: 'err.shared.rate.limited', semanticStatus: 429 }), 'api_invalid_request')
})

test('official errors classify identically with real statuses and legacy wire 400', async t => {
  const fixtures = [
    ['err.server.bot_api.auth_failed', 401, 'api_authentication_failed'],
    ['err.shared.auth.token_expired', 401, 'api_authentication_failed'],
    ['err.server.bot_api.auth_check_failed', 500, 'api_server_error'],
    ['err.server.bot_api.bot_unavailable', 403, 'api_unavailable'],
    ['err.server.bot_api.app_bot_unsupported', 403, 'api_unsupported'],
    ['err.server.bot_api.obo_not_authorized', 403, 'api_permission_denied'],
    ['err.server.bot_api.card_revision_clear_forbidden', 403, 'api_permission_denied'],
    ['err.server.bot_api.card_disabled', 400, 'api_disabled'],
    ['err.server.bot_api.message_not_found', 404, 'api_not_found'],
    ['err.server.bot_api.store_failed', 500, 'api_server_error'],
    ['err.server.bot_api.upstream_failed', 502, 'api_unavailable'],
    ['err.shared.internal', 500, 'api_server_error'],
    ['err.server.messages_search.validation_failed', 400, 'api_invalid_request'],
    ['err.server.messages_search.depth_exceeded', 400, 'api_search_depth_exceeded'],
    ['err.server.messages_search.not_found', 404, 'api_search_not_found'],
    ['err.server.messages_search.disabled', 503, 'api_disabled'],
    ['err.server.messages_search.upstream_unavailable', 503, 'api_unavailable'],
    ['err.server.messages_search.internal', 500, 'api_server_error'],
    ['err.server.messages_search.rate_limited', 429, 'api_rate_limited'],
    ['err.server.incomingwebhook.mgmt_disabled', 403, 'api_disabled'],
    ['err.server.incomingwebhook.mgmt_forbidden', 403, 'api_permission_denied'],
    ['err.server.incomingwebhook.mgmt_thread_not_found', 404, 'api_not_found'],
    ['err.server.incomingwebhook.mgmt_creator_quota_exceeded', 409, 'api_conflict'],
    ['err.server.incomingwebhook.mgmt_creator_left', 409, 'api_conflict'],
    ['err.server.incomingwebhook.mgmt_operation_failed', 500, 'api_server_error'],
    ['err.server.ai_team.container_protected', 403, 'api_permission_denied'],
    ['err.server.thread.deleted', 410, 'api_not_found'],
  ]
  for (const [code, semantic, apiCode] of fixtures) {
    for (const wire of new Set([semantic, 400])) await t.test(`${code}: HTTP ${wire}`, async () => {
      let calls = 0
      const api = client(async () => { calls++; return response(code, semantic, wire) })
      const error = await failure(api)
      assert.equal(calls, 1)
      assert.equal(error.code, 'http_' + wire)
      assert.equal(error.message, 'http_' + wire)
      assert.equal(error.status, wire)
      assert.equal(error.semanticStatus, semantic)
      assert.equal(error.officialCode, code)
      assert.equal(error.apiCode, apiCode)
      assert.equal(apiErrorCode(error), apiCode)
      assert.equal(error.retryAfterMs, 0, 'body retry_after must never be used')
    })
  }
})

test('unknown, malformed and inconsistent envelopes use only the wire fallback', async t => {
  const rate = envelope('err.shared.rate.limited', 429, 400)
  const fixtures = [
    ['unknown code', { ...rate, error: { ...rate.error, code: 'err.server.bot_api.' + secret } }],
    ['prose is not a code', { msg: 'disabled rate limited ' + secret, status: 400 }],
    ['wrong semantic status', { ...rate, error: { ...rate.error, http_status: 503 } }],
    ['string semantic status', { ...rate, error: { ...rate.error, http_status: '429' } }],
    ['missing semantic status', { ...rate, error: { code: rate.error.code } }],
    ['array code', { ...rate, error: { ...rate.error, code: [rate.error.code] } }],
    ['missing transport status', { error: rate.error }],
    ['mismatched transport status', { ...rate, status: 429 }],
    ['string transport status', { ...rate, status: '400' }],
    ['array envelope', [rate]],
    ['nested envelope', { data: rate }],
    ['error string', { error: secret, status: 400 }],
    ['null', null],
    ['suffix matching is forbidden', { ...rate, error: { ...rate.error, code: 'err.untrusted.rate_limited' } }],
  ]
  for (const [name, body] of fixtures) await t.test(name, async () => {
    const error = await failure(client(async () => Response.json(body, { status: 400 })))
    assert.equal(error.status, 400)
    assert.equal(error.code, 'http_400')
    assert.equal(error.officialCode, undefined)
    assert.equal(error.semanticStatus, undefined)
    assert.equal(apiErrorCode(error), 'api_invalid_request')
  })
  for (const raw of ['', '{"error":' + secret, '<html>' + secretURL + '</html>', JSON.stringify(rate) + secret]) {
    const error = await failure(client(async () => new Response(raw, { status: 503 })))
    assert.equal(error.code, 'http_503')
    assert.equal(apiErrorCode(error), 'api_server_error')
    assert.equal(error.officialCode, undefined)
  }
  const mismatch = await failure(client(async () => response('err.shared.rate.limited', 429, 500)))
  assert.equal(mismatch.status, 500)
  assert.equal(mismatch.officialCode, undefined)
  assert.equal(apiErrorCode(mismatch), 'api_server_error')
})

test('only actual HTTP 429 reads Retry-After; even an exact semantic 429 cannot change status', async () => {
  for (const wire of [400, 429, 500]) {
    const error = await failure(client(async () => response('err.shared.rate.limited', 429, wire, { 'retry-after': '7' })))
    assert.equal(error.status, wire)
    assert.equal(error.retryAfterMs, wire === 429 ? 7000 : 0)
  }
  for (const header of [secretURL, '-10', 'Infinity', '1e6', '1'.repeat(200)]) {
    const error = await readApiError(new Response(secret, { status: 429, headers: { 'retry-after': header } }), signal)
    assert.equal(error.retryAfterMs, 0)
    sanitized(error)
  }
  const future = new Date(Date.now() + 60_000).toUTCString()
  const error = await readApiError(new Response(null, { status: 429, headers: { 'retry-after': future } }), signal)
  assert.ok(error.retryAfterMs > 55_000 && error.retryAfterMs <= 60_000)
  assert.equal(apiErrorCode(error), 'api_rate_limited')
})

test('bounded reader accepts the exact byte boundary and split UTF-8, rejects oversized streams', async () => {
  const text = JSON.stringify(envelope('err.server.messages_search.disabled', 503, 400))
  const bounded = text + ' '.repeat(16 * 1024 - Buffer.byteLength(text))
  const exact = await readApiError(new Response(bounded, { status: 400 }), signal)
  assert.equal(exact.officialCode, 'err.server.messages_search.disabled')
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '99999999' }]) {
    let cancelled = 0
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(bounded + ' ' + secret)); },
      cancel() { cancelled++; return new Promise(() => {}) },
    })
    const error = await failure(client(async () => new Response(stream, { status: 400, headers })))
    assert.equal(error.officialCode, undefined)
    assert.equal(cancelled, 1)
  }
  const unicode = new TextEncoder().encode(JSON.stringify({ ...envelope('err.server.messages_search.disabled', 503, 400), msg: '中文' }))
  let offset = 0
  const split = new ReadableStream({ pull(controller) {
    if (offset < unicode.length) controller.enqueue(unicode.slice(offset, ++offset))
    else controller.close()
  } })
  assert.equal((await readApiError(new Response(split, { status: 400 }), signal)).apiCode, 'api_disabled')
  const invalidUTF8 = new Uint8Array([...new TextEncoder().encode(text), 0xff])
  assert.equal((await readApiError(new Response(invalidUTF8, { status: 400 }), signal)).officialCode, undefined)
  let reads = 0, cancelled = 0
  const emptyChunks = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array()) },
    cancel() { cancelled++ },
  })
  const empty = await readApiError(new Response(emptyChunks, { status: 503 }), signal)
  assert.equal(empty.code, 'http_503')
  assert.ok(reads <= 16 * 1024 + 2)
  assert.equal(cancelled, 1)
})

test('stalled error streams and hanging cancel cannot exceed the error-read budget', { timeout: 4000 }, async () => {
  let cancelled = 0
  const stream = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}) } })
  const start = Date.now()
  const error = await failure(client(async () => new Response(stream, { status: 503 })))
  assert.ok(Date.now() - start < 2500)
  assert.equal(cancelled, 1)
  assert.equal(error.status, 503)
  assert.equal(apiErrorCode(error), 'api_server_error')
})

test('body read failures and deadlines preserve the wire without leaking exception text', async () => {
  const broken = new ReadableStream({ start(controller) { controller.error(new Error(secretURL)) } })
  const error = await failure(client(async () => new Response(broken, { status: 500 })))
  assert.equal(error.code, 'http_500')
  const controller = new AbortController()
  let cancelled = 0
  const stream = new ReadableStream({ cancel() { cancelled++ } })
  const pending = readApiError(new Response(stream, { status: 403 }), controller.signal)
  controller.abort(new Error(secretURL))
  const aborted = await pending
  assert.equal(aborted.status, 403)
  assert.equal(aborted.code, 'http_403')
  assert.equal(aborted.retryAfterMs, 0)
  assert.equal(cancelled, 1)
  sanitized(aborted)
})

test('abort after headers preserves wire errors even when the body or its cancel hangs', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', () => originalTimeout(20))
  for (const status of [400, 503]) for (const mode of ['deadline', 'transport_abort']) {
    await t.test(`HTTP ${status}: ${mode}`, async () => {
      let calls = 0, cancelled = 0, requestSignal, abortTimer
      const api = client(async (_url, options) => {
        calls++
        requestSignal = options.signal
        const stream = new ReadableStream({
          start(controller) {
            // Even a complete-looking JSON prefix is untrusted until EOF.
            controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope('err.shared.rate.limited', 429, status))))
            if (mode === 'transport_abort') abortTimer = setTimeout(() => controller.error(new DOMException(secretURL, 'AbortError')), 5)
          },
          cancel() { cancelled++; return new Promise(() => {}) },
        })
        return new Response(stream, { status, headers: { 'retry-after': '7' } })
      })
      try {
        const error = await failure(api)
        assert.equal(calls, 1)
        assert.equal(error.code, 'http_' + status)
        assert.equal(error.status, status, 'body failure must not become status zero')
        assert.equal(error.retryAfterMs, 0)
        assert.equal(error.officialCode, undefined)
        assert.equal(error.semanticStatus, undefined)
        assert.equal(apiErrorCode(error), status === 400 ? 'api_invalid_request' : 'api_server_error')
        assert.equal(requestSignal.aborted, mode === 'deadline')
        assert.equal(cancelled, mode === 'deadline' ? 1 : 0)
      } finally { clearTimeout(abortTimer) }
    })
  }
})

test('fetch timeout/transport errors are sanitized, and caller cancellation is preserved', async t => {
  for (const reason of [new Error(secretURL), new DOMException(secretURL, 'TimeoutError')]) {
    const error = await failure(client(async () => { throw reason }))
    assert.equal(error.code, 'transport_or_invalid_response')
    assert.equal(error.status, 0)
  }
  // Exercise the actual request signal deadline with a short local timer.
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', () => originalTimeout(20))
  const keepAlive = setTimeout(() => {}, 1000)
  t.after(() => clearTimeout(keepAlive))
  const api = client(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const timeout = await failure(api)
  assert.equal(timeout.code, 'transport_or_invalid_response')
  assert.equal(timeout.status, 0)
  const controller = new AbortController()
  const reason = new Error('local_caller_stopped')
  controller.abort(reason)
  await assert.rejects(client(async () => { throw new Error(secret) }).typing(route, controller.signal), e => e === reason)
})

test('redirects are rejected without following or interpreting their body or Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0, cancelled = 0
    const stream = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}) } })
    const api = client(async (_url, options) => {
      calls++
      assert.equal(options.redirect, 'manual')
      return new Response(stream, { status, headers: { location: secretURL } })
    })
    const error = await failure(api)
    assert.equal(calls, 1)
    assert.equal(cancelled, 1)
    assert.equal(error.status, status)
    assert.equal(error.officialCode, undefined)
    assert.equal(apiErrorCode(error), 'api_request_failed')
  }
})

test('HTTP 200 error-shaped responses fail generically and normal direct success payloads survive', async () => {
  for (const body of [envelope('err.shared.rate.limited', 429, 200), { status: 429, msg: secret },
    { ok: false, message: secret }, { error: secret }]) {
    const api = client(async () => Response.json(body))
    const error = await failure(api)
    assert.equal(error.code, 'invalid_api_response')
    assert.equal(error.status, 200)
    assert.equal(error.officialCode, undefined)
    assert.equal(error.semanticStatus, undefined)
    assert.equal(error.retryAfterMs, 0)
    assert.equal(apiErrorCode(error), 'api_request_failed')
  }
  for (const body of [{ status: 200 }, { status: 0 }, { status: 1 }, { cleared: 0 }, []]) {
    await client(async () => Response.json(body)).typing(route, signal)
  }
  const sent = await client(async () => new Response('{"message_id":9223372036854775807}', {
    headers: { 'content-type': 'application/json' },
  })).send('alice', 'hello', signal)
  assert.equal(sent, '9223372036854775807')
})

test('delivery worker holds semantic 429 and ambiguous writes; only wire 429 schedules retry', async t => {
  for (const status of [400, 429, 500, 200]) await t.test('HTTP ' + status, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'octo-api-errors-'))
    const store = new Store(dir, 'test-bot')
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
    let sends = 0
    const api = client(async () => {
      sends++
      return response('err.shared.rate.limited', 429, status, { 'retry-after': '1' })
    })
    const worker = new Worker({ api: { send: api.send.bind(api) }, store,
      host: { async run() { return 'answer' } },
      config: { botUid: 'bot', spaceId: 'space', allowed: new Set(['alice']) }, log() {} })
    store.add('1', { messageId: '1', sender: 'alice', text: 'text' })
    await worker.process(store.next(Date.now()), signal)
    assert.equal(sends, 1)
    const row = store.db.prepare('SELECT state,issue FROM jobs').get()
    if (status === 429) {
      assert.notEqual(row.state, 'review')
      assert.ok(store.next(Date.now() + 10_000))
    } else {
      assert.equal(row.state, 'review')
      assert.equal(row.issue, 'delivery_not_confirmed')
      assert.equal(store.next(Date.now() + 10_000), undefined)
    }
  })
})
