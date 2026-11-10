// One bounded card: retain active/failed operations ahead of older successes.
export class ProgressTimeline {
  constructor() { this.rows = []; this.calls = new Map(); this.next = 0; this.total = 0; this.evictedFailures = 0 }
  add(row) {
    row.id = ++this.next; this.total++; this.rows.push(row)
    if (this.rows.length > 128) {
      let index = this.rows.findIndex(r => r.state !== 'active' && r.state !== 'failed')
      if (index < 0) index = this.rows.findIndex(r => r.state !== 'active')
      if (index >= 0) { const [old] = this.rows.splice(index, 1); if (old.state === 'failed') this.evictedFailures++ }
    }
  }
  observe(event, title) {
    if (event.kind === 'note') { this.pendingNote = event.text; return }
    if (event.kind === 'tool-start') {
      if (this.calls.has(event.id)) return
      // Only a public preamble followed by real work is a progress note.
      // The final assistant message is never copied into the progress card.
      if (this.pendingNote) {
        this.add({ type: 'note', text: this.pendingNote, state: 'done' }); this.pendingNote = undefined
      }
      const row = { type: 'tool', title, state: 'active', started: Date.now() }
      this.add(row); this.calls.set(event.id, row)
    } else if (event.kind === 'tool-end') {
      const row = this.calls.get(event.id)
      if (row) { row.state = event.failed ? 'failed' : 'done'; row.result = event.summary; row.ended = Date.now(); this.calls.delete(event.id) }
    }
  }
  view(terminal, interrupted, clean) {
    const priority = row => row.state === 'active' ? 2 : row.state === 'failed' ? 1 : 0
    const selected = [...this.rows].sort((a,b) => priority(b)-priority(a) || b.id-a.id).slice(0,8).sort((a,b)=>a.id-b.id)
    const shown = new Set(selected)
    const failedHidden = this.evictedFailures + this.rows.filter(r => r.state === 'failed' && !shown.has(r)).length
    const activeHidden = this.rows.filter(r => r.state === 'active' && !shown.has(r)).length
    const hidden = this.total - selected.length
    const notice = hidden ? `已收拢 ${hidden} 条较早记录` + (failedHidden ? ` · 含 ${failedHidden} 条未成功操作` : '') + (activeHidden ? ` · ${activeHidden} 项${terminal ? '结果未确认' : '仍在执行'}` : '') : ''
    return { notice, groups: selected.map(row => {
      const status = row.state === 'active' ? terminal ? interrupted ? '已停止' : '未确认结束' : '执行中' : row.state === 'failed' ? '未成功' : '已完成'
      const result = clean(row.result,160).replace(/^状态：(已完成|成功|正常|失败|错误|进行中|等待中|已取消|未确认|已跳过)(；|$)/, '').trim()
      const elapsed = Math.max(0, Math.floor(((row.ended ?? Date.now())-row.started)/1000))
      return { id: 'dsh_progress_item_' + row.id,
        kind: row.type,
        thought: row.type === 'note' ? '分析摘要' : row.title,
        status: row.type === 'note' ? '' : status,
        tone: row.state === 'failed' ? 'Attention' : row.state === 'active' ? 'Accent' : 'Default',
        actions: [{ tool: row.type === 'note' ? '分析摘要' : row.title,
          detail: row.type === 'note' ? clean(row.text,120) : [result, `耗时 ${elapsed} 秒`].filter(Boolean).join(' · '),
          statusGlyph: row.state === 'failed' ? '!' : row.state === 'active' ? '●' : '✓',
          statusTone: row.state === 'failed' ? 'Attention' : 'Default' }],
      }
    }) }
  }
}
