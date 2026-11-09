// A transcription tool can only select an attachment already admitted and
// downloaded for this turn. It never accepts a URL, local path or target user.
export function voiceTool(api, attachments) {
  const audio = attachments.map((file, index) => ({ file, index }))
    .filter(({ file }) => /^audio\//i.test(file?.mime ?? '') && file.bytes instanceof Uint8Array)
  if (!audio.length || typeof api?.transcribe !== 'function') return undefined
  const selected = new Map(audio.map(({ file, index }) => [index, file]))
  const cache = new Map()
  const spec = {
    name: 'octo_voice_transcribe',
    description: '使用 Octo 语音服务转写本轮已接收的音频附件。仅支持本轮附件编号：'
      + audio.map(({ index }) => index).join('、') + '。append 保留原话，edit 可整理表达；不会读取其他文件或会话。',
    parameters: { type: 'object', properties: {
      attachment: { type: 'integer', enum: audio.map(({ index }) => index) },
      mode: { type: 'string', enum: ['append', 'edit'], description: '默认 append。' },
    }, required: ['attachment'], additionalProperties: false },
  }
  return { spec, async execute(args, signal) {
    signal.throwIfAborted()
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['attachment', 'mode'].includes(key))
      || !Number.isInteger(args.attachment) || !selected.has(args.attachment)
      || args.mode !== undefined && !['append', 'edit'].includes(args.mode)) throw new Error('invalid_voice_arguments')
    const mode = args.mode ?? 'append', key = args.attachment + ':' + mode
    if (!cache.has(key)) cache.set(key, api.transcribe(selected.get(args.attachment), mode, signal))
    const result = await cache.get(key)
    signal.throwIfAborted()
    return { ...result, attachment: args.attachment, source: 'current_message_audio' }
  } }
}
