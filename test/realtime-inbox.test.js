import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { wirePeer } from '../scripts/wukong-fixture.mjs'
import { OctoClient } from '../src/octo.js'
import { Worker } from '../src/worker.js'
import { Store } from '../src/store.js'

async function until(fn) {
  for (let i = 0; i < 240; i++) { if (fn()) return; await delay(25) }
  assert.fail('synthetic realtime recovery did not settle')
}
test('real encrypted socket reconnect recovers missing messages before newly ACKed input', { timeout: 15000 }, async () => {
  const botUid = 'fixture-bot', peer = await wirePeer({ bot: botUid })
  const dir = mkdtempSync(join(tmpdir(), 'octo-recovery-wire-')), store = new Store(dir, 'fixture')
  const stop = new AbortController(), runs = [], requests = []
  const config = { botUid, spaceId: 'space', allowed: new Set(['human']), transport: 'websocket' }
  const input = seq => seq === 10 || seq === 11 ? '/srv/agents/样例 消息 ' + seq : 'message ' + seq
  const row = seq => ({ message_id: String(seq), message_seq: seq, from_uid: 'human', channel_type: 1,
    channel_id: 'internal-dm', payload: { type: 1, content: input(seq) } })
  let rows = [row(10)]
  const client = new OctoClient({ ...config, apiBase: 'https://fixture.invalid', token: 'bf_fixture', fetchImpl: async (_url, options) => {
    const req = JSON.parse(options.body); requests.push(req)
    return Response.json({ messages: req.pull_mode === 0 ? rows.slice(-1)
      : rows.filter(item => item.message_seq >= req.start_message_seq && item.message_seq < req.end_message_seq).slice(0, req.limit) })
  } })
  const api = { verify: async () => ({}), register: async () => ({ robot_id: botUid, im_token: 'fixture-im-secret', ws_url: peer.wsUrl }),
    send: async () => String(1000 + runs.length), inboxPage: client.inboxPage.bind(client) }
  const worker = new Worker({ api, store, config, log() {}, host: { async run(_session, text) { runs.push(text); return 'reply' } } })
  const running = worker.run(stop.signal).catch(error => { if (!stop.signal.aborted) throw error })
  void running.catch(() => {})
  const send = seq => peer.send({ messageId: String(seq), seq, channelId: 'internal-dm', channelType: 1, sender: 'human', payload: row(seq).payload })
  try {
    await until(() => peer.send)
    send(10); await until(() => store.db.prepare("SELECT 1 FROM jobs WHERE message_id='10' AND state='sent'").get())
    rows = [10, 11, 12, 13].map(row)
    peer.disconnect()
    await until(() => peer.connections === 2 && peer.send)
    send(13)
    await until(() => peer.acked.length === 2)
    assert.equal(store.stagedInbox({ channel_type: 1, channel_id: 'human' }).at(-1)?.message_id, '13')
    assert.deepEqual(runs, [input(10)])
    await until(() => store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='sent'").get().n === 4)
    assert.deepEqual(runs, [10, 11, 12, 13].map(input))
    send(13); await until(() => peer.acked.length === 3)
    assert.equal(runs.length, 4)
    assert.ok(requests.some(req => req.pull_mode === 1 && req.end_message_seq === 14))
    assert.equal(store.inboxRoute(1, 'human').blocked, 0)
  } finally {
    stop.abort(); await running; await peer.close(); store.close()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    assert.ok(basename(dir).startsWith('octo-recovery-wire-'))
    rmSync(dir, { recursive: true, force: true })
  }
})
