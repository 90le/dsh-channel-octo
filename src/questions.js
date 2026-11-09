import { randomUUID } from 'node:crypto'
import { sendCard } from './octo-cards.js'

const cut = (value, max) => typeof value === 'string'
  ? Array.from(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()).slice(0, max).join('') : ''
const answerTokens = /[,，、;；\s]+/u

function answer(question, input) {
  const options = question.options ?? []
  const text = cut(input, 1500)
  const result = { id: question.id, selected: [] }
  if (/^(跳过|skip)$/iu.test(text)) return result
  const one = value => /^\d{1,2}$/u.test(value) ? options[Number(value) - 1]?.label
    : options.find(item => item.label === value)?.label
  const matched = one(text)
  if (matched) result.selected.push(matched)
  else if (question.multiSelect && /^[\d,，、;；\s]+$/u.test(text)) {
    const labels = text.split(answerTokens).filter(Boolean).map(one)
    if (labels.length && labels.every(Boolean)) result.selected = [...new Set(labels)]
    else result.custom = text
  } else result.custom = text
  return result
}

function presentation(question, index, total) {
  const options = question.options ?? []
  const prefix = total > 1 ? '（' + (index + 1) + '/' + total + '）' : ''
  const title = 'DSH 等待你的回答' + prefix
  const prompt = [cut(question.header, 45), cut(question.question, 240), cut(question.detail, 900)].filter(Boolean)
  const labels = options.map((option, i) => (i + 1) + '. ' + cut(option.label, 75)
    + (option.description ? ' — ' + cut(option.description, 90) : ''))
  const help = question.multiSelect ? '回复选项序号（多选用逗号分隔）、答案或「跳过」。' : '直接回复序号、答案或「跳过」。'
  return { title, text: [...prompt, ...labels, help].join('\n') }
}

export class QuestionBridge {
  constructor({ api, store, log }) { Object.assign(this, { api, store, log }) }

  async ask(questions, job, config, signal, onWaiting) {
    if (this.current || !Array.isArray(questions) || !questions.length || questions.length > 8
      || questions.some(q => typeof q?.id !== 'string' || typeof q.question !== 'string'
        || (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 12
          || q.options.some(item => typeof item?.label !== 'string'))))) throw new Error('octo_question_invalid')
    const answers = []
    onWaiting(true)
    try {
      for (const [index, question] of questions.entries()) {
        signal.throwIfAborted()
        const response = Promise.withResolvers()
        const wait = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        const stop = () => response.reject(wait.reason)
        wait.addEventListener('abort', stop, { once: true })
        void response.promise.catch(() => {})
        const key = randomUUID()
        this.current = { key, question, sender: job.sender, sessionId: job.session_id,
          route: { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }, response, ready: false }
        try {
          const active = this.current
          const { title, text } = presentation(question, index, questions.length)
          let sent = false
          const options = question.options ?? []
          // Plans require their full detail. If too large, use the DSH panel rather than ask for approval of a fragment.
          if (question.intent && Array.from(question.detail ?? '').length > 900) throw new Error('octo_question_review_too_long')
          if (!question.multiSelect && options.length >= 2 && options.length <= 12
            && Buffer.byteLength(text) <= 2048 && options.every(row => row.label && Buffer.byteLength(row.label) <= 100)) {
            try {
              const result = await sendCard(config, { ...active.route, operatorUid: active.sender }, {
                title, text, actions: [{ id: 'answer', label: '提交回答' }],
                choice: { id: 'selection', label: '选择一个选项', options: options.map((row, i) => ({ title: row.label, value: 'q' + (i + 1) })) },
              }, wait)
              this.store.bindCard({ ...result.binding, questionKey: key })
              sent = true
            } catch {
              if (!wait.aborted) this.log('question_card_fallback')
            }
          }
          if (!sent) {
            const lines = (title + '\n' + text).match(/[\s\S]{1,1500}/gu) ?? []
            for (const line of lines) await this.api.send(active.route.channel_id, line, wait, active.route.channel_type)
          }
          wait.throwIfAborted()
          active.ready = true
          answers.push(await response.promise)
        } finally {
          wait.removeEventListener('abort', stop)
          this.current = undefined
        }
      }
      return { answers }
    } finally {
      onWaiting(false)
    }
  }

  match({ sender, channelId, channelType }) {
    const current = this.current
    return current?.ready && sender === current.sender && channelId === current.route.channel_id
      && channelType === current.route.channel_type ? current : undefined
  }

  text(current, input) {
    if (this.current !== current || !current.ready) return false
    current.ready = false
    current.response.resolve(answer(current.question, input))
    return true
  }

  card(current, key, choice) {
    if (!current || current.key !== key || !/^q\d{1,2}$/u.test(choice ?? '')) return false
    return this.text(current, choice.slice(1))
  }
}
