import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'
import { OctoError, readApiError } from '../src/api-errors.js'

test('failed turn gives actionable static feedback without replay, raw errors or duplicate card/text notices', async t => {
  const cases = [
    [new Error('session_busy'), 'session_busy', /另一个回合/],
    [new Error('session_timeout'), 'session_timeout', /可能已有工具执行/],
    [new Error('no_confirmed_final_text'), 'no_confirmed_final_text', /没有提交可确认的最终回复/],
    [new Error('missing_host_model'), 'missing_host_model', /选择可用模型/],
    [new OctoError('attachment_unavailable'), 'attachment_unavailable', /附件未能读取/],
    [new Error('SECRET_RAW_EXCEPTION'), 'agent_run_not_confirmed', /避免重复操作/],
    [await readApiError(Response.json({ status: 400, error: { code: 'err.server.messages_search.disabled',
      http_status: 503, message: 'SECRET_RAW_EXCEPTION' } }, { status: 400 })), 'api_disabled', /尚未开启此功能/],
  ]
  for (const [error, code, pattern] of cases) for (const shownCard of [false, true]) {
    await t.test(code + ':card=' + shownCard, async t => {
      const base = realpathSync(tmpdir()), dir = mkdtempSync(join(base, 'octo-failure-'))
      const store = new Store(dir, 'fixture')
      t.after(() => {
        store.close()
        const path = relative(base, realpathSync(dir))
        assert.ok(path && !isAbsolute(path) && !path.startsWith('..'))
        rmSync(dir, { recursive: true, force: true })
      })
      store.add('1', { messageId: '1', sender: 'alice', text: 'hi', channelType: 1 })
      const sent = [], logged = [], progress = []
      let runs = 0
      const worker = new Worker({ store, config: { botUid: 'bot', spaceId: 'space', allowed: new Set(['alice']), progress: 'off' },
        api: { async send(...args) { sent.push(args); return '2' } }, log: value => logged.push(value),
        host: { async run() { runs++; throw error } } })
      worker.progress = { start() { return { stage() {}, trace() {}, async finish(state, details) {
        progress.push({ state, ...details }); return shownCard
      } } } }
      await worker.process(store.next(Date.now()), new AbortController().signal)
      assert.equal(runs, 1)
      assert.equal(store.next(Date.now()), undefined)
      assert.equal(store.db.prepare('SELECT issue FROM jobs').get().issue, code)
      assert.equal(progress.length, 1)
      assert.match(progress[0].detail, pattern)
      assert.equal(sent.length, shownCard ? 0 : 1)
      if (!shownCard) assert.match(sent[0][1], pattern)
      assert.doesNotMatch(JSON.stringify([sent, logged, progress]), /SECRET_RAW_EXCEPTION|请稍后重发/)
    })
  }
})
