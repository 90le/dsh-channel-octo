import { randomUUID } from 'node:crypto'
import { sendCard, createCard } from './octo-cards.js'

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

  async closeCard(binding, summary, signal) {
    if (!binding?.questionKey) return
    this.store.finishQuestionCard(binding.messageId, summary)
    if (signal?.aborted) return
    try {
      const title = binding.questionTitle?.replace('DSH 等待你的回答', 'DSH 提问回执') ?? 'DSH 提问回执'
      const { type: _type, ...frame } = createCard({ title, text: summary })
      if (typeof this.api.editProgress !== 'function') throw new Error('edit_unavailable')
      await this.api.editProgress(binding.route, binding.messageId, frame, undefined, false, signal)
      this.store.questionFeedbackSent(binding.messageId)
    } catch {
      if (!signal?.aborted) {
        try {
          await this.api.send(binding.route.channel_id, summary, signal, binding.route.channel_type, binding.messageId)
          this.store.questionFeedbackSent(binding.messageId)
        } catch { this.log('question_feedback_unconfirmed') }
      }
    }
  }

  async closeInterrupted(signal) {
    for (const binding of this.store.unfinishedQuestionCards()) {
      if (signal.aborted) return
      await this.closeCard(binding, binding.questionSummary
        ?? 'DSH 服务已重新连接，上次提问的等待已结束。这张旧卡片不能继续提交，请重新发起提问。', signal)
    }
  }

  async ask(questions, job, config, signal, onWaiting) {
    if (this.current || !Array.isArray(questions) || !questions.length || questions.length > 8
      || questions.some(q => typeof q?.id !== 'string' || typeof q.question !== 'string'
        || (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 12
          || q.options.some(item => typeof item?.label !== 'string'))))) throw new Error('octo_question_invalid')
    const answers = []
    const batchSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
    onWaiting(true)
    try {
      for (const [index, question] of questions.entries()) {
        signal.throwIfAborted()
        const response = Promise.withResolvers()
        const wait = batchSignal
        const stop = () => response.reject(wait.reason)
        wait.addEventListener('abort', stop, { once: true })
        void response.promise.catch(() => {})
        const key = randomUUID()
        this.current = { key, question, index, total: questions.length, sender: job.sender, sessionId: job.session_id,
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
              active.binding = { ...result.binding, questionKey: key, questionTitle: title }
              this.store.bindCard(active.binding)
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
          const active = this.current
          this.current = undefined
          if (active?.binding) await this.closeCard(active.binding, active.summary
            ?? '本次提问已结束，未收到完整答案。请重新发起提问；旧卡片不能继续提交。', signal)
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
    const result = answer(current.question, input)
    current.summary = '已收到第 ' + (current.index + 1) + '/' + current.total + ' 题的答案。'
      + (current.index + 1 < current.total ? '请继续回答下一张提问卡。' : '答案已交给 DSH，正在继续处理。')
      + '\n' + (result.selected.length ? '已选择：' + result.selected.join('、') : result.custom ? '自定义答案已记录。' : '已跳过。')
    if (current.binding) this.store.finishQuestionCard(current.binding.messageId, current.summary)
    current.response.resolve(result)
    return true
  }

  card(current, key, choice) {
    if (!current || current.key !== key || !/^q\d{1,2}$/u.test(choice ?? '')) return false
    return this.text(current, choice.slice(1))
  }
}
