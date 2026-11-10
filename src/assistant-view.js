
const zh = {
  title: '助理配置', intro: '每个 Bot 可绑定一位助理。工作区、模型、预设和权限在此统一管理。',
  add: '新建助理', edit: '编辑', unbound: '暂不绑定', bind: '绑定 Bot', name: '助理名称', cwd: '工作区',
  model: '模型', preset: 'Agent 预设', permission: '权限策略', scope: '工具使用范围', reasoning: '推理强度',
  default: '跟随宿主默认值', select: '请选择', save: '保存助理', cancel: '取消', loading: '正在读取助理设置…',
  failed: '读取助理设置失败。', success: '助理设置已保存，从后续消息起生效。',
  invalid_assistant: '请检查助理名称和文件内容。每个文件最多 8 KB。',
  assistant_bound: '这位助理已经绑定其他 Bot。', account_changed: '设置已在别处更新，请关闭编辑后重新打开。',
  workspace_unavailable: '该工作区不可用。', model_unavailable: '该模型不可用。', reasoning_unavailable: '该推理强度不可用。',
  permission_unavailable: '该权限未在 DSH 开放。', invalid_account: '请检查工作区、模型、预设和权限。',
  saveFailed: '助理设置未保存。', docs: '文件内容只应用于这位助理的 Octo 回合。不会覆盖实际工作区同名文件。',
  private: '获准的私聊用户', owner: 'Bot 所有者的全部会话', admitted: '所有已准入用户',
}
const en = {
  title: 'Assistant profiles', intro: 'Bind one assistant to each bot and manage its workspace, model, preset and permissions here.',
  add: 'New assistant', edit: 'Edit', unbound: 'Unbound', bind: 'Bot binding', name: 'Assistant name', cwd: 'Workspace',
  model: 'Model', preset: 'Agent preset', permission: 'Permission', scope: 'Tool access scope', reasoning: 'Reasoning effort',
  default: 'Use host default', select: 'Select an option', save: 'Save assistant', cancel: 'Cancel', loading: 'Loading assistant settings…',
  failed: 'Could not load assistant settings.', success: 'Saved. Changes apply to subsequent messages.',
  invalid_assistant: 'Check the name and documents. Each document can contain up to 8 KB.',
  assistant_bound: 'This assistant is bound to a different bot.', account_changed: 'Settings changed elsewhere. Close and reopen the editor.',
  workspace_unavailable: 'The workspace is unavailable.', model_unavailable: 'The model is unavailable.',
  reasoning_unavailable: 'The reasoning effort is unavailable.', permission_unavailable: 'DSH has not enabled this permission.',
  invalid_account: 'Check workspace, model, preset and permission.', saveFailed: 'Could not save the assistant.',
  docs: 'These files apply only to this assistant’s Octo turns. They do not overwrite files in the workspace.',
  private: 'Authorized DM users', owner: 'All conversations from the bot owner', admitted: 'All admitted users',
}
const zhPresets = { standard: '标准模式', minimal: '极简模式', ptc: 'PTC 模式', cordis: '创造模式', 'octo-text': 'Octo 文字模式' }
const zhPolicies = { 'text-only': '仅文字（无工具）', 'read-only': '只读', 'workspace-write': '工作区写入', 'danger-full-access': '完全访问', auto: '自动（逐次审批）' }

export function createAssistantView(React, { Button, Input }) {
  const { createElement: h, useEffect, useId, useState } = React
  function Editor({ selection, data, request, publish, refresh, close, lang }) {
    const t = lang === 'zh' ? zh : en
    const prefix = useId(), [loaded, setLoaded] = useState(null), [draft, setDraft] = useState(null)
    const [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => {
      const controller = new AbortController()
      const signal = controller.signal
      Promise.all([request('/account-options', { signal }),
        selection.id ? request('/assistants/' + selection.id, { signal }) : {}]).then(([options, profile]) => {
        if (signal.aborted) return
        setLoaded({ options, profile })
        setDraft({ name: '', cwd: '', provider: '', model: '', reasoningEffort: '', agentPreset: 'octo-text',
          permission: 'text-only', toolScope: 'private', agentsMd: '', soulMd: '', ...profile,
          accountId: profile.boundAccountId ?? '' })
      }).catch(() => { if (!signal.aborted) setError(t.failed) })
      return () => controller.abort()
    }, [selection])
    if (!loaded || !draft) return h('div', { className: 'dsho-panel' }, h('p', { role: error ? 'alert' : 'status' }, error || t.loading),
      h(Button, { type: 'button', onClick: close }, t.cancel))
    const { options, profile } = loaded
    const set = patch => setDraft(current => ({ ...current, ...patch }))
    const field = (key, label, content) => h('div', { className: 'dsho-field' },
      h('label', { htmlFor: prefix + key }, label), content)
    const select = (key, label, value, rows, change, extra = {}) => {
      const choices = value && !rows.some(row => row.value === value) ? [...rows, { value, label: value }] : rows
      return field(key, label, h('select', { id: prefix + key, value, onChange: e => change(e.target.value), ...extra },
        ...choices.map(row => h('option', { key: row.value, value: row.value, disabled: row.disabled }, row.label))))
    }
    const modelKey = draft.provider ? JSON.stringify([draft.provider, draft.model]) : ''
    const chosen = options.models.find(model => model.provider === draft.provider && model.model === draft.model)
    const text = key => h('textarea', { id: prefix + key, rows: 5, maxLength: 8192,
      value: draft[key], onChange: event => set({ [key]: event.target.value }) })
    const submit = async event => {
      event.preventDefault()
      if (busy) return
      setError('')
      if ([draft.agentsMd, draft.soulMd].some(value => new TextEncoder().encode(value).length > 8192)) {
        setError(t.invalid_assistant); return
      }
      setBusy(true)
      try {
        const { accountId, id, boundAccountId, ...assistant } = draft
        const result = await request('/assistants' + (selection.id ? '/' + selection.id : ''), {
          method: selection.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dsh-octo-client': '1' },
          body: JSON.stringify({ revision: selection.revision, accountId, assistant }),
        })
        publish(result)
        close(t.success)
      } catch (error) {
        if (error?.message === 'account_changed') refresh()
        setError(t[error?.message] || t.saveFailed)
      } finally { setBusy(false) }
    }
    return h('form', { className: 'dsho-panel dsho-form', onSubmit: submit, 'aria-label': t.title },
      h('div', { className: 'dsho-grid' },
        field('name', t.name, h(Input, { id: prefix + 'name', required: true, maxLength: 80,
          value: draft.name, onChange: event => set({ name: event.target.value }) })),
        select('bind', t.bind, draft.accountId, [{ value: '', label: t.unbound }, ...(data.accounts ?? []).map(account =>
          ({ value: account.id, label: account.label }))], accountId => set({ accountId }), { disabled: Boolean(profile.boundAccountId) }),
        select('cwd', t.cwd, draft.cwd, [{ value: '', label: t.select }, ...options.workspaces.map(item => ({
          value: item.path, label: item.title + ' · ' + item.path,
        }))], cwd => set({ cwd }), { required: true }),
        select('preset', t.preset, draft.agentPreset, options.agentPresets.map(item => ({ value: item.id,
          label: (lang === 'zh' && zhPresets[item.id]) || item.label })), agentPreset => set({ agentPreset })),
        select('model', t.model, modelKey, [{ value: '', label: t.default }, ...options.models.map(item => ({
          value: JSON.stringify([item.provider, item.model]), label: item.label + ' · ' + item.provider,
        }))], value => { const [provider, model] = value ? JSON.parse(value) : ['', '']; set({ provider, model, reasoningEffort: '' }) }),
        select('reasoning', t.reasoning, draft.reasoningEffort, [{ value: '', label: t.default },
          ...(chosen?.reasoningEfforts ?? []).map(value => ({ value, label: value }))], reasoningEffort => set({ reasoningEffort })),
        select('permission', t.permission, draft.permission, options.policies.map(item => ({ value: item.id, disabled: item.disabled,
          label: (lang === 'zh' && zhPolicies[item.id]) || item.label })), permission => set({ permission })),
        select('scope', t.scope, draft.toolScope, ['private','owner','admitted'].map(value => ({ value, label: t[value] })),
          toolScope => set({ toolScope }))),
      h('p', { className: 'dsho-muted' }, t.docs),
      field('agentsMd', 'AGENTS.md', text('agentsMd')), field('soulMd', 'SOUL.md', text('soulMd')),
      error && h('p', { role: 'alert', className: 'dsho-alert' }, error),
      h('div', { className: 'dsho-tools' },
        h(Button, { type: 'submit', variant: 'primary', disabled: busy || !data.canManage }, t.save),
        h(Button, { type: 'button', disabled: busy, onClick: () => close() }, t.cancel)))
  }

  return function Assistants({ data, request, publish, refresh, lang }) {
    const t = lang === 'zh' ? zh : en
    const [selection, setSelection] = useState(null), [notice, setNotice] = useState('')
    const open = id => { setNotice(''); setSelection({ id, revision: data.accountRevision }) }
    if (selection) return h(Editor, { selection, data, request, publish, refresh, lang,
      close: message => { setSelection(null); setNotice(message || '') } })
    return h('section', { className: 'dsho-panel', 'aria-label': t.title },
      h('header', { className: 'dsho-head' }, h('div', null, h('h3', null, t.title), h('p', { className: 'dsho-muted' }, t.intro)),
        h(Button, { type: 'button', disabled: !data.canManage, onClick: () => open() }, t.add)),
      notice && h('p', { role: 'status' }, notice),
      h('ul', { className: 'dsho-account-items' }, ...(data.assistants ?? []).map(profile =>
        h('li', { className: 'dsho-account-line', key: profile.id },
          h('div', null, h('strong', null, profile.name), h('p', { className: 'dsho-muted' },
            data.accounts?.find(account => account.id === profile.boundAccountId)?.label || t.unbound)),
          h(Button, { type: 'button', disabled: !data.canManage, onClick: () => open(profile.id),
            'aria-label': t.edit + ' · ' + profile.name }, t.edit)))))
  }
}
