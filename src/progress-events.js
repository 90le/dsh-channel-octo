// Public presentation metadata only. This is a bounded best-effort scrubber,
// not a secret detector: never feed it commands, arbitrary args or tool output.
const INPUT_LIMIT = 16_384
const TEXT_LIMIT = 400
const MAX_CALLS = 256
const shells = new Set(['bash', 'pwsh', 'exec'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const idOK = value => typeof value === 'string' && /^[\w:./-]{1,256}$/.test(value)

export function safeProgressText(text, max = TEXT_LIMIT) {
  if (typeof text !== 'string') return ''
  const limit = Number.isSafeInteger(max) ? Math.max(0, Math.min(max, 2000)) : TEXT_LIMIT
  if (!limit) return ''
  let value = text.slice(0, INPUT_LIMIT)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[已隐藏密钥]')
    .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/[`~]{3,}[^\n]*/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏凭据]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:bf_|app_)[A-Za-z0-9_-]+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[已隐藏凭据]')
    .replace(/\b((?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization)[\w-]*))\s*["']?\s*[:=]\s*(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s,;]+)/gi, '$1=[已隐藏凭据]')
    .replace(/\b(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|mailto:|javascript:|data:|www\.)[^\s<>）)\]]+/gi, '[已隐藏链接]')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|\/(?:home|root|Users|etc|var|tmp|private|run|mnt|opt|srv|workspace)\/)[^\s<>"'|]*|~[\\/][^\s<>"'|]*/g, '[已隐藏私有路径]')
    .replace(/(^|\n)\s*(?:[-+=]+|\d+[.)])\s+/g, '$1')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    // Full-width punctuation keeps labels readable without creating Markdown,
    // HTML, links or escapes that a downstream card validator could interpret.
    .replace(/[\\`*_{}\[\]()<>#!|~&]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
    .replace(/\s+/g, ' ').trim()
  if (text.length > INPUT_LIMIT || value.length > limit) {
    const suffix = '…（已截断）'
    value = limit < suffix.length ? '…'.repeat(limit) : value.slice(0, limit - suffix.length).trimEnd() + suffix
  }
  return value
}

function parsed(value) {
  if (typeof value !== 'string' || value.length > INPUT_LIMIT) return undefined
  try { const result = JSON.parse(value); return record(result) ? result : undefined } catch { return undefined }
}

const operations = new Map([
  ['read', '读取文件'], ['read_file', '读取文件'], ['read_image', '读取图片'],
  ['write', '写入文件'], ['write_file', '写入文件'], ['edit', '编辑文件'],
  ['edit_file', '编辑文件'], ['apply_patch', '修改文件'], ['delete', '删除文件'],
  ['list', '列出文件'], ['ls', '列出文件'], ['glob', '查找文件'], ['grep', '搜索文件'],
])
function titleFor(name, args) {
  if (!args) return ''
  const description = safeProgressText(args.description, 160)
  if (description || shells.has(name)) return description
  const title = safeProgressText(args.title, 160)
  if (title) return title
  for (const key of ['file_path', 'filePath', 'path', 'filename']) {
    const path = args[key]
    if (typeof path !== 'string' || path.length > 4096 || /[\r\n\0]/.test(path)) continue
    const base = path.split(/[\\/]/).at(-1)
    if (!base || base === '.' || base === '..' || /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|credentials(?:\..*)?)$/i.test(base)) continue
    return safeProgressText(`${operations.get(name) ?? name} · ${base}`, 160)
  }
  return ''
}

const statuses = new Map([
  ['completed', '已完成'], ['failed', '失败'], ['unknown', '未确认'], ['skipped', '已跳过'],
  ['pending', '等待中'], ['running', '进行中'], ['cancelled', '已取消'], ['success', '成功'], ['ok', '正常'], ['error', '错误'],
])
const countLabels = new Map([
  ['count', '返回数量'], ['total', '总数'], ['matched', '匹配数量'], ['updated', '更新数量'],
  ['created', '创建数量'], ['deleted', '删除数量'], ['succeeded', '成功数量'], ['failed', '失败数量'],
])
function structuredSummary(value) {
  if (!record(value)) return ''
  const fields = []
  if (typeof value.status === 'string' && statuses.has(value.status)) fields.push(`状态：${statuses.get(value.status)}`)
  for (const [key, label] of countLabels) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) fields.push(`${label}：${value[key]}`)
  }
  return fields.join('；')
}

// Stable diagnoses only: never expose arbitrary error.code, name or reason.
const errorCauses = new Map([
  ['permission_denied', '权限不足'], ['api_permission_denied', 'Octo 拒绝访问'],
  ['tasktimeout', '任务超时'], ['task_timeout', '任务超时'], ['etimedout', '操作超时'],
  ['eacces', '访问被拒绝'], ['eperm', '操作不被允许'], ['enoent', '文件或路径不存在'],
  ['unknown_tool', '工具不可用'], ['invalid_args', '工具参数不符合要求'],
  ['invalid_tool_output', '工具返回格式不符合要求'], ['tool_activation_failed', '工具启用失败'],
  ['tool_executor_unavailable', '工具执行器不可用'], ['aborted', '工具执行已中止'],
  ['aborted_before_dispatch', '工具在执行前已中止'],
])
function errorSummary(error) {
  const code = typeof error?.code === 'string' && error.code.length <= 64 ? error.code.toLowerCase() : ''
  return errorCauses.has(code) ? `工具报告错误（${code}）：${errorCauses.get(code)}` : '工具报告错误'
}

function resultFor(data, name) {
  const message = record(data.message) ? data.message : {}
  // Preserve the host's failure semantics even for malformed error metadata.
  let failed = message.isError === true || !!data.error
  let summary = failed ? errorSummary(data.error) : ''
  const content = Array.isArray(message.content) ? message.content : []
  if (shells.has(name)) {
    // Official dsh-shell/render.ts contract: a newline and an exact terminal
    // marker. Read only the suffix, never publish stdout or the signal text.
    const last = content.at(-1)
    const tail = last?.type === 'text' && typeof last.text === 'string' ? last.text.slice(-256) : ''
    const exit = /\n\[exit code: (\d+)\]$/.exec(tail)
    const killed = /\n\[killed by signal: ([^\]\n]+)\]$/.test(tail)
    if (exit) {
      const code = Number(exit[1])
      failed ||= code !== 0
      if (Number.isSafeInteger(code)) summary = failed && code === 0 ? summary : `退出码：${code}`
      else summary = '退出码非零'
    } else if (killed) { failed = true; summary = '被信号终止' }
    // No marker is the upstream exit-0 convention, but do not announce success:
    // background/promoted results and malformed payloads are also marker-free.
  } else if (!failed) {
    summary = structuredSummary(data.meta)
    if (!summary && content.length === 1 && content[0]?.type === 'text') summary = structuredSummary(parsed(content[0].text))
  }
  // Generated only from fixed labels, allowlisted codes and bounded integers.
  return { failed, ...(summary ? { summary } : {}) }
}

/** One instance per host turn, called only after session/turn ownership checks.
 * Stored metadata is bounded and contains no arguments, output or private text.
 * failed=false means no verified failure, not confirmation of task success.
 */
export function createProgressEvents() {
  const calls = new Map()
  return {
    clear() { calls.clear() },
    extract(event) {
      const data = event?.data
      if (!record(data)) return undefined
      if (event.type === 'step/start' || event.type === 'step/end') {
        if (!Number.isSafeInteger(data.step) || data.step < 0 || Object.is(data.step, -0)) return undefined
        return { kind: event.type === 'step/start' ? 'step' : 'step-end', step: data.step }
      }
      if (event.type === 'tool/call') {
        if (!idOK(data.callId) || typeof data.name !== 'string' || !/^[\w.-]{1,96}$/.test(data.name)
          || calls.has(data.callId) || calls.size >= MAX_CALLS) return undefined
        calls.set(data.callId, data.name)
        const title = titleFor(data.name, parsed(data.arguments))
        return { kind: 'tool-start', id: data.callId, name: data.name, ...(title ? { title } : {}) }
      }
      if (event.type === 'tool/result') {
        const id = data.message?.toolCallId
        if (!calls.has(id)) return undefined
        const name = calls.get(id)
        calls.delete(id)
        return { kind: 'tool-end', id, ...resultFor(data, name) }
      }
      if (event.type === 'assistant/message' && !data.interrupted && Array.isArray(data.message?.content)) {
        let text = ''
        for (const part of data.message.content.slice(0, 64)) {
          if (part?.type !== 'text' || typeof part.text !== 'string') continue
          text += part.text.slice(0, INPUT_LIMIT + 1) + '\n'
          if (text.length > INPUT_LIMIT) break
        }
        const publicText = safeProgressText(text)
        // The renderer labels this as 过程说明; only public text blocks enter it.
        if (publicText) return { kind: 'note', text: publicText }
      }
      return undefined
    },
  }
}
