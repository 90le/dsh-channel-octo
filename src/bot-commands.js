import { apiEndpoint, validToken } from './config.js'

export const BOT_COMMANDS = Object.freeze([
  { command: 'help', description: '查看频道命令帮助' },
  { command: 'status', description: '查看当前会话状态' },
  { command: 'new', description: '开始新会话' },
  { command: 'card', description: '查看展示卡片' },
  { command: 'choose', description: '试用交互卡片' },
].map(Object.freeze))

export function botCommandMenu(action) {
  if (action === 'publish') return BOT_COMMANDS.map(command => ({ ...command }))
  if (action === 'clear') return []
  throw new Error('invalid_bot_commands')
}

// OctoClient's request method is private. Keep this narrowly scoped writer on
// the account's same pinned endpoint, credential and injected fetch transport.
// No retries: an interrupted replacement may already have reached Octo.
export async function setBotCommands({ apiBase, token, fetchImpl = fetch }, action, signal) {
  const commands = botCommandMenu(action)
  if (!validToken(token)) throw new Error('invalid_bot_token')
  // The official handler only updates robot.bot_commands; App tokens can get
  // HTTP 200 without updating any App Bot. Do not report a phantom menu save.
  if (token.startsWith('app_')) throw new Error('app_bot_operation_unavailable')
  let reader
  try {
    const endpoint = apiEndpoint(apiBase)
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)])
    requestSignal.throwIfAborted()
    const response = await fetchImpl(endpoint + '/v1/bot/setCommands', {
      method: 'POST', redirect: 'manual', signal: requestSignal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ commands }),
    })
    reader = response.body?.getReader()
    if (!response.ok || !reader) throw new Error()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) throw new Error()
      chunks.push(value)
    }
    requestSignal.throwIfAborted()
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!result || Array.isArray(result) || result.status !== 200 || result.error != null || result.ok === false) throw new Error()
    return { action, count: commands.length }
  } catch {
    throw new Error('bot_commands_failed')
  } finally { await reader?.cancel().catch(() => {}) }
}
