import { randomUUID } from 'node:crypto'
import { sendCard, createCard } from './octo-cards.js'
import { cardInputValues } from './card-inputs.js'

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

function formInstructions(form) {
  const example = JSON.stringify({ action: form.actions[0].id, values: Object.fromEntries(form.inputs.map(input => [input.id,
    input.kind === 'number' ? 1 : input.kind === 'date' ? '2026-01-01' : input.kind === 'time' ? '09:00'
      : input.kind === 'toggle' ? false : input.kind === 'choice' ? input.options[0].value : '填写答案'])) })
  return [form.title, form.text, ...form.inputs.map(input => input.label + ' [' + input.id + ']：' + input.kind
    + (input.options ? ' ' + input.options.map(o => o.title + '=' + o.value).join(' / ') : '')),
  '请按此 JSON 格式填写并回复：' + example + '。多选值用逗号分隔；也可回复「跳过」。',
  '操作：' + form.actions.map(action => action.label + '=' + action.id).join(' / ')].filter(Boolean).join('\n')
}
function checkAccess(authorize) { if (authorize() !== true) throw new Error('octo_access_denied') }

export class QuestionBridge {
  constructor({ api, store, log }) { Object.assign(this, { api, store, log }) }

  async form(form, job, config, signal, onWaiting, authorize = () => true) {
    checkAccess(authorize)
    if (this.current) throw new Error('octo_question_busy')
    form = structuredClone(form)
    createCard(form) // Validate the entire form before waiting or sending anything.
    if (!form.inputs?.length || !form.actions?.length) throw new Error('invalid_card_form')
    const wait = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
    wait.throwIfAborted()
    const response = Promise.withResolvers()
    void response.promise.catch(() => {})
    const stop = () => response.reject(wait.reason)
    wait.addEventListener('abort', stop, { once: true })
    const active = { key: randomUUID(), form, index: 0, total: 1, sender: job.sender, sessionId: job.session_id,
      route: { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }, response, ready: false, signal: wait, authorize }
    this.current = active
    onWaiting(true)
    try {
      try {
        const sent = await sendCard(config, { ...active.route, operatorUid: job.sender }, form, wait, authorize)
        active.binding = { ...sent.binding, questionKey: active.key, questionTitle: form.title }
        this.store.bindCard(active.binding)
      } catch (error) {
        // An uncertain POST may already be delivered. Never create a second form.
        if (error?.code !== 'card_profile_unavailable' && !error?.cardNotSent) throw error
        for (const line of formInstructions(form).match(/[\s\S]{1,1500}/gu) ?? []) {
          checkAccess(authorize)
          await this.api.send(active.route.channel_id, line, wait, active.route.channel_type)
        }
      }
      wait.throwIfAborted()
      active.ready = true
      return await response.promise
    } finally {
      wait.removeEventListener('abort', stop)
      this.current = undefined
      await active.feedback
      if (active.binding) await this.closeCard(active.binding, active.summary ?? '表单等待已结束，未收到完整答案。请重新发起；旧表单不能继续提交。', signal)
      onWaiting(false)
    }
  }

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

  async ask(questions, job, config, signal, onWaiting, authorize = () => true) {
    checkAccess(authorize)
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
          route: { channel_id: job.channel_id ?? job.sender, channel_type: job.channel_type }, response, ready: false, signal: wait, authorize }
        try {
          const active = this.current
          const { title, text } = presentation(question, index, questions.length)
          let sent = false
          const options = question.options ?? []
          // Plans require their full detail. If too large, use the DSH panel rather than ask for approval of a fragment.
          if (question.intent && Array.from(question.detail ?? '').length > 900) throw new Error('octo_question_review_too_long')
          if ((options.length >= 2 || options.length === 0) && options.length <= 12
            && Buffer.byteLength(text) <= 2048 && options.every(row => row.label && Buffer.byteLength(row.label) <= 100)) {
            try {
              const choices = options.map((row, i) => ({ title: row.label, value: 'q' + (i + 1) }))
              const fields = options.length === 0
                ? { inputs: [{ kind: 'text', id: 'response', label: '输入答案', required: true }] }
                : question.multiSelect
                  ? { inputs: [{ kind: 'choice', id: 'selection', label: '选择一个或多个选项', multi: true, required: true, options: choices }] }
                  : { choice: { id: 'selection', label: '选择一个选项', options: choices } }
              const result = await sendCard(config, { ...active.route, operatorUid: active.sender }, {
                title, text, actions: [{ id: 'answer', label: '提交回答' }],
                ...fields,
              }, wait, authorize)
              active.binding = { ...result.binding, questionKey: key, questionTitle: title }
              this.store.bindCard(active.binding)
              sent = true
            } catch (error) {
              if (error?.code !== 'card_profile_unavailable' && !error?.cardNotSent) throw error
              if (!wait.aborted) this.log('question_card_fallback')
            }
          }
          if (!sent) {
            const lines = (title + '\n' + text).match(/[\s\S]{1,1500}/gu) ?? []
            for (const line of lines) {
              checkAccess(authorize)
              await this.api.send(active.route.channel_id, line, wait, active.route.channel_type)
            }
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
    if (current.form) {
      if (/^(跳过|skip)$/iu.test(input.trim())) return this.completeForm(current, { skipped: true })
      let response
      try { response = JSON.parse(input) } catch { return this.invalidFormReply(current) }
      if (!response || typeof response !== 'object' || Array.isArray(response)
        || Object.keys(response).some(key => !['action', 'values'].includes(key))
        || !current.form.actions.some(action => action.id === response.action)) return this.invalidFormReply(current)
      const values = cardInputValues(current.form.inputs, response.values, current.binding?.inputLimits)
      return values ? this.completeForm(current, { action: response.action, values }) : this.invalidFormReply(current)
    }
    current.ready = false
    const result = answer(current.question, input)
    current.summary = '已收到第 ' + (current.index + 1) + '/' + current.total + ' 题的答案。'
      + (current.index + 1 < current.total ? '请继续回答下一张提问卡。' : '答案已交给 DSH，正在继续处理。')
      + '\n' + (result.selected.length ? '已选择：' + result.selected.join('、') : result.custom ? '自定义答案已记录。' : '已跳过。')
    if (current.binding) this.store.finishQuestionCard(current.binding.messageId, current.summary)
    current.response.resolve(result)
    return true
  }

  completeForm(current, result) {
    if (this.current !== current || !current.ready) return false
    current.ready = false
    current.summary = result.skipped ? '已跳过表单。DSH 将继续处理。' : '表单答案已交给 DSH，正在继续处理。'
    if (current.binding) this.store.finishQuestionCard(current.binding.messageId, current.summary)
    current.response.resolve(result)
    return true
  }

  async rejectCard(current) {
    if (this.current !== current || !current.ready || current.signal.aborted) return
    checkAccess(current.authorize ?? (() => true))
    // Octo deduplicates submits by message/action/operator. Retire this action
    // and explicitly retain the waiting turn for a fresh text answer.
    await this.closeCard(current.binding, '本次卡片答案格式无效，尚未提交。请按随后提示直接回复文字；DSH 仍在等待你的答案。', current.signal)
    const text = current.form ? formInstructions(current.form) : presentation(current.question, current.index, current.total).text
    for (const line of text.match(/[\s\S]{1,1500}/gu) ?? []) {
      checkAccess(current.authorize ?? (() => true))
      await this.api.send(current.route.channel_id, line, current.signal, current.route.channel_type)
    }
  }

  invalidFormReply(current) {
    if (!current.feedbackPending && Date.now() - (current.lastFeedback ?? 0) >= 3000) {
      current.lastFeedback = Date.now()
      current.feedbackPending = true
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(5000)])
      current.feedback = Promise.resolve().then(() => this.api.send(current.route.channel_id,
        '表单答案尚未提交：请检查必填项、选项和日期/数字格式。可在卡片中填写，或按上面的 JSON 格式回复；回复「跳过」可继续。',
        signal, current.route.channel_type)).catch(() => this.log('form_validation_feedback_unconfirmed'))
        .finally(() => { current.feedbackPending = false })
    }
    return false
  }

  card(current, key, choice, action) {
    if (current?.form) return current.key === key && action?.values && this.completeForm(current, { action: action.actionId, values: action.values })
    if (current?.key === key && action?.values) {
      if (typeof action.values.response === 'string') return this.text(current, action.values.response)
      if (Array.isArray(action.values.selection) && action.values.selection.every(value => /^q\d{1,2}$/u.test(value))) {
        return this.text(current, action.values.selection.map(value => value.slice(1)).join(','))
      }
    }
    if (!current || current.key !== key || !/^q\d{1,2}$/u.test(choice ?? '')) return false
    return this.text(current, choice.slice(1))
  }
}
