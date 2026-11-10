// Public progress facts only. Pages bound each card's node count without dropping
// earlier steps. Rows are assigned once; late tool results update their original page.
export class ProgressTimeline {
  constructor() { this.steps = []; this.calls = new Map(); this.pages = []; this.next = 0 }
  step(number) {
    if (number !== undefined) {
      const known = this.steps.find(s => s.native === number)
      if (known) return this.current = known
    }
    const step = { id: ++this.next, native: number, started: Date.now(), tools: [], notes: [] }
    this.steps.push(step); this.current = step
    this.place(step, { type: 'step' })
    return step
  }
  touch(step) { for (const page of this.pages) if (page.groups.some(g => g.step === step)) page.version++ }
  stamp(index, terminal) {
    const page = this.pages[index]
    const active = page.groups.some(g => !g.step.ended || g.step.tools.some(r => r.state === 'active'))
    return page.version + ':' + (!terminal && active ? Math.floor(Date.now() / 15000) : 0)
  }
  place(step, row) {
    let page = this.pages.at(-1)
    if (!page || page.size >= 12 || (!page.groups.some(g => g.step === step) && page.groups.length >= 5)) {
      page = { groups: [], size: 0, version: 0 }; this.pages.push(page)
    }
    let group = page.groups.find(g => g.step === step)
    if (!group) { group = { step, rows: [], continued: this.pages.some(p => p !== page && p.groups.some(g => g.step === step)) }; page.groups.push(group) }
    group.rows.push(row); page.size++; page.version++
  }
  observe(event, label) {
    if (event.kind === 'step') { this.step(event.step); return }
    if (event.kind === 'step-end') {
      const step = event.step === undefined ? this.current : this.steps.find(s => s.native === event.step)
      if (step && !step.ended) { step.ended = Date.now(); this.touch(step) }
      return
    }
    if (event.kind === 'tool-start') {
      if (this.calls.has(event.id)) return
      const step = this.current ?? this.step()
      const row = { step, type: 'tool', title: label, started: Date.now(), state: 'active' }
      step.tools.push(row); this.calls.set(event.id, row); this.place(step, row); this.touch(step)
    } else if (event.kind === 'tool-end') {
      const row = this.calls.get(event.id)
      if (row && row.state === 'active') { Object.assign(row, { state: event.failed ? 'failed' : 'done', ended: Date.now(), result: event.summary }); this.touch(row.step) }
    } else if (event.kind === 'note' && event.text) {
      const step = this.current ?? this.step()
      if (step.notes.at(-1) === event.text) return
      step.notes.push(event.text); this.place(step, { type: 'note', text: event.text })
    }
  }
  groups(pageIndex, terminal, interrupted, clean) {
    const elapsed = row => Math.max(0, Math.floor(((row.ended ?? Date.now()) - row.started) / 1000))
    return (this.pages[pageIndex]?.groups ?? []).map(({ step, rows, continued }) => {
      const active = step.tools.filter(r => r.state === 'active').length
      const failed = step.tools.filter(r => r.state === 'failed').length
      const done = step.tools.filter(r => r.state === 'done').length
      const state = active ? terminal ? interrupted ? '已停止，部分操作未确认结束' : '部分操作未确认结束' : '执行中'
        : failed ? '有操作未成功' : step.ended ? '步骤已结束' : terminal ? '回合已结束' : '处理中'
      const counts = step.tools.length ? ` · ${done + failed}/${step.tools.length} 次工具已返回${failed ? ` · ${failed} 次未成功` : ''}` : ''
      return {
        id: `dsh_progress_step_${step.id}_page_${pageIndex}`,
        thought: `第 ${step.id} 步 · ${step.tools[0]?.title ?? '理解与回复'}${continued ? '（续）' : ''}`,
        summary: `${state} · ${elapsed(step)} 秒${counts}`,
        actions: rows.filter(r => r.type !== 'step').map(row => {
          if (row.type === 'note') return { tool: '过程说明', detail: clean(row.text, 800), statusGlyph: '·', statusTone: 'Default' }
          const state = row.state === 'active' ? terminal ? interrupted ? '已停止，结果未确认' : '结果未确认' : '执行中'
            : row.state === 'failed' ? '未成功' : '工具已返回'
          return { tool: row.title, detail: `${state} · ${elapsed(row)} 秒${row.result ? ' · ' + clean(row.result, 240) : ''}`,
            statusGlyph: row.state === 'done' ? '✓' : row.state === 'failed' ? '!' : '●',
            statusTone: row.state === 'done' ? 'Good' : row.state === 'failed' ? 'Attention' : 'Accent' }
        }),
      }
    })
  }
}
