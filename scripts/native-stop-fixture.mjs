import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const user = 'fixture-user'
const prompt = 'NATIVE-STOP-START: Run the synthetic foreground shell command.'
const followup = 'NATIVE-STOP-FOLLOWUP: Reply normally after the canceled command.'
const forbiddenFinal = 'NATIVE-STOP-UNEXPECTED-FINAL'
const followupFinal = 'NATIVE-STOP-FOLLOWUP-OK'
const callId = 'toolu_native_stop_fixture'
const tool = process.platform === 'win32' ? 'pwsh' : 'bash'
const durationMs = 9000
const paths = home => ({ started: join(home, 'native-stop-started'), survived: join(home, 'native-stop-survived') })
const mark = value => console.log('FIXTURE_STOP_' + value)

function probe(home) {
  const { started } = paths(home)
  if (!existsSync(started)) return null
  const [pid, time] = readFileSync(started, 'utf8').split(' ').map(Number)
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(time) && time > 0 ? { pid, time } : null
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

function command(home) {
  const { started, survived } = paths(home)
  if (tool === 'pwsh') {
    const quote = s => "'" + s.replaceAll("'", "''") + "'"
    return `[IO.File]::WriteAllText(${quote(started)}, "$PID $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"); `
      + `Start-Sleep -Milliseconds ${durationMs}; [IO.File]::WriteAllText(${quote(survived)}, 'continued')`
  }
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, process.pid + ' ' + Date.now()); `
    + `setTimeout(() => fs.writeFileSync(${JSON.stringify(survived)}, 'continued'), ${durationMs});`
  return `exec ${quote(process.execPath)} -e ${quote(script)}`
}

export function nativeStopFixture({ peer, home, modelStream }) {
  assert.ok(peer && /^dsh-octo-smoke-/.test(basename(home)), 'Requires a fresh synthetic WebSocket smoke home')
  let step = 0, stopped = false, confirmed = false, status = false, final = false
  let toolRequested = false, followupRequested = false
  const cards = new Map()
  const messages = [prompt, '/stop', '/status', followup]
  const fail = issue => { mark('FAIL=' + issue); return new Response(null, { status: 400 }) }
  const timer = setInterval(() => {
    if (!peer.send || step === messages.length) return
    if (step === 1) {
      const child = probe(home)
      if (!cards.size || !child) return
      if (!alive(child.pid) || Date.now() - child.time > 3000) {
        clearInterval(timer); fail('SHELL_NOT_LIVE_BEFORE_STOP'); return
      }
      mark('LIVE_CHILD=' + child.pid)
    }
    if ((step === 2 && !confirmed) || (step === 3 && (!status || !stopped))) return
    const content = messages[step++]
    peer.send({ messageId: String(step), sender: user, channelType: 1, channelId: user, seq: step * 10,
      payload: { type: 1, content } })
    mark('INPUT=' + step)
  }, 50).unref()
  const ackTimer = setInterval(() => {
    if (!messages.every((_, i) => peer.acked.includes(String(i + 1)))) return
    clearInterval(ackTimer)
    mark('ACKS_OK')
  }, 50).unref()
  // The Octo client and DSH session driver are real; only the remote endpoints are fixtures.
  return (url, init) => {
    if (url.hostname === 'model-fixture.invalid' && url.pathname.endsWith('/messages')) {
      const body = JSON.parse(init.body), tail = JSON.stringify(body.messages.at(-1))
      const stream = (content, call) => modelStream(body.model, 'native-stop-fixture', content, call)
      if (tail.includes('Generate the session title from this JSON array of human messages:')) return stream('Native stop fixture')
      if (tail.includes(prompt) && !toolRequested && step === 1) {
        if (!body.tools?.some(spec => spec.name === tool)) return fail('NATIVE_SHELL_TOOL_MISSING')
        toolRequested = true
        return stream({ command: command(home), description: 'Run bounded synthetic cancellation probe', timeoutMs: 30_000 }, { name: tool, id: callId })
      }
      if (tail.includes(followup) && !followupRequested && step === 4) {
        followupRequested = true
        mark('FOLLOWUP_MODEL')
        return stream(followupFinal)
      }
      mark('FAIL=UNEXPECTED_MODEL_STEP')
      return stream(forbiddenFinal)
    }
    if (url.hostname !== 'octo-fixture.invalid') return
    const isSend = url.pathname.endsWith('/sendMessage'), isEdit = url.pathname.endsWith('/message/edit')
    if (!isSend && !isEdit) return
    const body = JSON.parse(init.body), json = value => Response.json(value)
    if (body.channel_id !== user || body.channel_type !== 1) return fail('OUTBOUND_ROUTE')
    if (isSend && body.payload.type === 17) {
      const cardId = cards.size ? '202' : '201', payload = body.payload
      if (cards.size >= 2 || (cardId === '201' ? step !== 1 : step !== 4 || !stopped)
        || payload.template_ref?.id !== 'ai.reasoning-process' || !['reasoning', 'answering'].includes(payload.state)) return fail('PROGRESS_CREATE')
      cards.set(cardId, { seq: 1, reasoningId: payload.data?.reasoningId })
      return json({ message_id: cardId })
    }
    if (isEdit) {
      const card = cards.get(body.message_id)
      if (!card || card.terminal || !(body.card_seq > card.seq) || body.data?.reasoningId !== card.reasoningId
        || body.template_ref?.id !== 'ai.reasoning-process' || body.data?.state !== body.state) return fail('PROGRESS_EDIT')
      card.seq = body.card_seq
      if (body.state === 'stopped' && body.message_id === '201' && step >= 2 && !body.transient
        && body.data.statusLabel === '任务已停止' && body.data.progressText.includes('/stop')) {
        card.terminal = stopped = true
        mark('STOPPED_PROGRESS')
      } else if (body.state === 'completed' && body.message_id === '202' && !body.transient && final) card.terminal = true
      else if (!['reasoning', 'answering'].includes(body.state) || body.transient !== true) return fail('PROGRESS_STATE:' + body.state)
      return json({})
    }
    if (body.payload.type !== 1) return fail('UNEXPECTED_DELIVERY_TYPE:' + body.payload.type)
    const { content } = body.payload
    if (step === 2 && !confirmed && content.startsWith('已请求停止当前任务')) {
      confirmed = true; mark('STOP_CONFIRMED'); return json({ message_id: '301' })
    }
    if (step === 3 && !status && content.startsWith('DSH 已收到这条消息，当前会话可以正常处理消息')) {
      status = true; mark('STATUS_CONFIRMED'); return json({ message_id: '302' })
    }
    if (step === 4 && !final && followupRequested && content === followupFinal) {
      final = true; mark('FOLLOWUP_DELIVERED'); return json({ message_id: '303' })
    }
    return fail('UNEXPECTED_TEXT_DELIVERY')
  }
}

export async function assertNativeStopSmoke({ home, state, child, output, deadline }) {
  const wait = async (description, check) => {
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !output().includes('FIXTURE_STOP_FAIL=')) {
      if (check()) return
      await delay(50)
    }
    assert.fail('Native /stop smoke: ' + description + '\n' + output().replace(/https?:\/\/\S+/g, '[url]'))
  }
  const seen = name => output().includes('FIXTURE_STOP_' + name)
  const native = () => [...output().matchAll(/FIXTURE_STOP_NATIVE=(\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]))
  await wait('shell never started before the stop', () => seen('LIVE_CHILD='))
  const { pid, time } = probe(home)
  assert.ok(seen('LIVE_CHILD=' + pid), 'Expected the PID from the running fixture shell')
  const cutoff = time + 6000
  await wait('could not observe the shell after /stop', () => !alive(pid) || Date.now() >= cutoff)
  const killedPromptly = !alive(pid) && Date.now() < cutoff
  // Observe past the uncanceled completion time with DSH still running. This
  // also lets the bounded probe exit on its own if cancellation regresses.
  await delay(Math.max(0, time + durationMs + 300 - Date.now()))
  assert.ok(!existsSync(paths(home).survived), 'Canceled shell continued and wrote its completion sentinel')
  assert.ok(killedPromptly, 'Shell survived until near its normal completion; /stop did not kill it promptly')
  const markers = ['STOP_CONFIRMED', 'STOPPED_PROGRESS', 'STATUS_CONFIRMED', 'FOLLOWUP_MODEL', 'FOLLOWUP_DELIVERED', 'ACKS_OK']
  await wait('missing Octo confirmation, terminal progress, status, follow-up or WebSocket ACKs', () => markers.every(seen))

  const db = new DatabaseSync(join(state, 'channel.sqlite'), { readOnly: true })
  let jobs
  try { jobs = db.prepare('SELECT message_id, session_id, state, issue, result_id, reply, metadata FROM jobs ORDER BY seq').all() }
  finally { db.close() }
  assert.deepEqual(jobs.map(job => [job.message_id, job.state, job.result_id]), [
    ['1', 'stopped', null], ['2', 'ignored', null], ['3', 'sent', '302'], ['4', 'sent', '303'],
  ])
  const [work, control, , next] = jobs
  assert.equal(work.issue, 'stopped_by_user')
  assert.equal(work.reply, null)
  assert.equal(work.metadata, null)
  assert.equal(control.session_id, null)
  assert.ok(work.session_id && work.session_id === next.session_id, 'Follow-up must reuse the canceled native session')
  const events = native().filter(event => event.sessionId === work.session_id)
  const turns = events.filter(event => event.type === 'turn/end')
  assert.equal(turns.length, 2, JSON.stringify(events))
  assert.equal(turns[0].reason, 'aborted')
  assert.equal(turns[0].cause, 'user')
  assert.equal(turns[1].reason, 'completed')
  assert.notEqual(turns[0].turn, turns[1].turn)
  assert.ok(events.some(event => event.type === 'tool/call' && event.turn === turns[0].turn
    && event.name === tool && event.callId === callId), 'Native canceled turn did not call the shell')
  console.log(`PASS: native ${tool} child ${pid} exited before its sentinel deadline; DSH recorded a user abort.`)
  console.log('PASS: Octo /stop confirmation and stopped progress, no canceled reply, /status, and a successful follow-up in the same session.')
}
