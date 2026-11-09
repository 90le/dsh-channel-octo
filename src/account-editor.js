const builtinPolicy = {
  'text-only': ['仅文字（无工具）', 'Text only (no tools)'],
  'read-only': ['只读', 'Read only'],
  'workspace-write': ['工作区写入', 'Workspace write'],
  'danger-full-access': ['完全访问', 'Full access'],
  auto: ['自动（逐次审批）', 'Auto (per-call review)'],
}
const builtinPreset = {
  'octo-text': ['Octo 文字模式', 'Octo text mode'],
  standard: ['标准模式', 'Standard'],
  minimal: ['极简模式', 'Minimal'],
  ptc: ['PTC 模式', 'PTC mode'],
  cordis: ['创造模式', 'Creator mode'],
}
const builtinEffort = {
  max: ['最高', 'Maximum'],
  high: ['高', 'High'],
  medium: ['中等', 'Medium'],
  low: ['低', 'Low'],
  default: ['模型默认', 'Model default'],
}
const copy = {
  unnamed: ['Octo 账号', 'Octo account'],
  legacy: ['此账号来自服务器原有配置。', 'This account comes from the server configuration.'],
  label: ['账号名称', 'Account name'],
  labelHint: ['用于区分账号，可在账号列表中修改。', 'Use a name to distinguish this account. You can also rename it in the account list.'],
  token: ['Bot 令牌', 'Bot token'],
  replacement: ['新 Bot 令牌', 'New bot token'],
  replaceToken: ['更换 Bot 令牌', 'Replace bot token'],
  cancelReplacement: ['取消更换令牌', 'Cancel token replacement'],
  keepToken: ['验证并保存后才会更换原有令牌。', 'The existing token stays in use until you verify and save the new one.'],
  noVault: ['DSH 凭据库暂不可用。', 'The DSH credential store is unavailable.'],
  verify: ['验证令牌', 'Verify token'],
  verifying: ['正在验证令牌…', 'Verifying token…'],
  verified: ['令牌已验证', 'Token verified'],
  verifyFailed: ['无法验证令牌。请检查后重试。', 'Could not verify the token. Check it and try again.'],
  clearToken: ['重新输入令牌', 'Enter a different token'],
  saveToken: ['保存新令牌', 'Save new token'],
  botUid: ['Bot ID', 'Bot ID'],
  spaceId: ['空间 ID', 'Space ID'],
  workspace: ['工作区', 'Workspace'],
  currentWorkspace: ['当前工作区', 'Current workspace'],
  agentPreset: ['Agent 预设', 'Agent preset'],
  defaultPreset: ['Octo 文字模式', 'Octo text mode'],
  defaultModel: ['使用 DSH 默认模型', 'Use the DSH default model'],
  pickWorkspace: ['请选择工作区', 'Select a workspace'],
  noWorkspaces: ['暂无可选工作区', 'No workspaces available'],
  model: ['模型', 'Model'],
  pickModel: ['请选择可用模型', 'Select an available model'],
  reasoning: ['推理强度', 'Reasoning effort'],
  defaultEffort: ['使用模型默认值', 'Use the model default'],
  effortUnavailable: ['请选择支持推理强度的模型', 'Choose a model that supports reasoning effort'],
  permission: ['权限策略', 'Permission'],
  pickPolicy: ['请选择权限策略', 'Select a permission'],
  noPolicies: ['暂无可选权限策略', 'No permissions available'],
  policyDisabled: ['灰色选项需要管理员在服务器上开放。', 'A server administrator must enable the unavailable options.'],
  toolScope: ['工具使用范围', 'Tool access scope'],
  toolPrivate: ['获准的私聊用户', 'Authorized DM users'],
  toolOwner: ['Bot 所有者的全部会话', 'All bot owner conversations'],
  toolAdmitted: ['所有已准入用户', 'All admitted users'],
  toolScopeHint: ['控制谁能使用所选 Agent 预设中可用的全部 DSH 工具、插件和技能（Skills），实际操作仍受账号权限策略约束；“仅文字”不开放工具。所有用户和私聊、群聊、子区（话题）仍须通过现有聊天准入规则。', 'Controls who can use all DSH tools, plugins and skills available in the selected Agent preset, subject to this account’s permission policy. Text-only permission grants no tools. Every user and DM, group or topic must still pass existing chat admission rules.'],
  toolPrivateHint: ['DSH 工具仅对获准的私聊用户开放：名单准入时为名单内用户，跟随 Octo 准入时为 Bot 所有者。群聊和子区仍可使用已开放的 Octo 频道工具，不能访问工作区。', 'DSH tools are limited to allowlisted DM users or the verified bot owner in DMs. Groups and topics can still use enabled Octo channel tools, without workspace access.'],
  toolOwnerHint: ['仅已验证的 Bot 所有者可用，适用于其已准入的私聊、群聊和子区（话题）。', 'Only the verified bot owner can use tools, in admitted DMs, groups and topics.'],
  toolAdmittedHint: ['所有已通过聊天准入的用户均可用，包括私聊、群聊和子区（话题）。', 'All users who passed chat admission can use tools, including in DMs, groups and topics.'],
  senderPolicy: ['私聊准入', 'Private chat access'],
  senderAllowlist: ['仅允许名单中的用户', 'Allowlisted users only'],
  senderOcto: ['跟随 Octo 好友和群成员权限', 'Follow Octo friend and group access'],
  allowedUids: ['允许的用户 ID', 'Allowed user IDs'],
  allowedUidsHint: ['每行填写一个用户 ID。', 'Enter one user ID per line.'],
  allowedUidsRequired: ['请至少填写一个允许的用户 ID。', 'Enter at least one allowed user ID.'],
  idleMinutes: ['空闲新开会话', 'Idle session rotation'],
  idleOff: ['关闭（保持原会话）', 'Disabled (keep session)'],
  idle15: ['15 分钟', '15 min'],
  idle30: ['30 分钟', '30 min'],
  idle60: ['1 小时', '1 hr'],
  idle120: ['2 小时', '2 hrs'],
  sendMode: ['发送方式', 'Send mode'],
  sendQueue: ['排队发送', 'Queue'],
  sendSteer: ['插话发送', 'Steer'],
  sendSteerNote: ['实时连接下，同一频道内、同一获准使用 DSH 工具的用户可补充文字指令。附件准备中的补充会与附件一起处理；执行中由 DSH 在下一可插话步骤接收。其他消息仍按队列发送。', 'Over WebSocket, the same user authorized for DSH tools can add instructions in the same channel. Attachment preparation merges the supplement; running work receives it at the next DSH steering step. Other messages are queued.'],
  dmCommands: ['私聊快捷命令', 'DM shortcuts'],
  groupCommands: ['群聊快捷命令', 'Group shortcuts'],
  commandsOff: ['仅正常对话', 'Conversation only'],
  commandsSafe: ['允许频道快捷命令', 'Allow channel shortcuts'],
  commandsHint: ['仅控制 /help、/status、/new、/card、/choose 等频道快捷命令，仍遵循原有命令授权规则；不控制 DSH 工具、插件或技能访问，也不转发其他插件命令。工具访问请设置“工具使用范围”和“权限策略”。', 'Only controls channel shortcuts such as /help, /status, /new, /card and /choose, under existing command authorization rules. It does not control DSH tools, plugins or skills, or forward other plugin commands. Configure tool scope and permission for tool access.'],
  allowFiles: ['允许处理文件附件', 'Allow file attachments'],
  filesNote: ['允许处理符合聊天准入规则的附件。工作区文件交付还须符合“工具使用范围”和账号权限策略；选择包含群聊、子区的工具范围时，可在相应已准入会话交付文件。', 'Process attachments from admitted chats. Workspace file delivery also requires tool access under the selected scope and account permission. Scopes that include groups and topics allow delivery in those admitted conversations.'],
  current: ['当前设置', 'Current setting'],
  enabled: ['启用此账号', 'Enable this account'],
  save: ['保存账号', 'Save account'],
  saving: ['正在保存…', 'Saving…'],
  saved: ['已保存', 'Saved'],
  saveEdits: ['保存设置', 'Save settings'],
  saveFailed: ['未能保存账号。请稍后重试。', 'Could not save the account. Try again.'],
  retry: ['重试保存', 'Retry save'],
  diagnose: ['诊断连接', 'Diagnose connection'],
  reconnect: ['重新连接', 'Reconnect'],
  remove: ['移除账号', 'Remove account'],
  working: ['正在处理账号请求…', 'Working…'],
  diagnosed: ['Octo 已确认 Bot 身份，现有连接未被重启。', 'Octo verified the bot identity. The existing connection was not restarted.'],
  reconnected: ['重连请求已完成。', 'Reconnect completed.'],
  actionFailed: ['未能完成账号操作。请稍后重试。', 'Could not complete the account action. Try again.'],
  cancel: ['取消', 'Cancel'],
}

const modelChoice = (provider, model) => provider || model ? JSON.stringify([provider, model]) : ''
const idleChoices = [0, 15, 30, 60, 120]
const userIds = text => [...new Set(text.split(/\r?\n/).map(uid => uid.trim()).filter(Boolean))]

export function accountFields(account) {
  return {
    label: account?.label ?? '',
    cwd: account?.cwd ?? '',
    provider: account?.provider ?? '',
    model: account?.model ?? '',
    reasoningEffort: account?.reasoningEffort ?? '',
    permission: account?.permission ?? 'text-only',
    agentPreset: account?.agentPreset ?? 'octo-text',
    toolScope: account?.toolScope ?? 'private',
    senderPolicy: account?.senderPolicy ?? 'octo',
    allowedUids: account?.allowedUids ?? [],
    idleMinutes: account?.idleMinutes ?? 0,
    enabled: account?.enabled ?? true,
    sendMode: account?.sendMode === 'steer' ? 'steer' : 'queue',
    dmCommands: account?.dmCommands === 'safe' ? 'safe' : 'off',
    groupCommands: account?.groupCommands === 'safe' ? 'safe' : 'off',
    allowFiles: account?.allowFiles === true,
  }
}

export function createAccountEditor(React, { Button, Input }) {
  const { createElement: h, useEffect, useId, useRef, useState } = React

  function AccountForm({ account, options, allowCredentials, onVerify, onSave, onCancel,
    onDiagnose, onReconnect, onRemove, t, lang = 'zh', connectionStatus, errorMessage }) {
    const tr = key => {
      const id = 'octo.accountEditor.' + key
      const translated = t?.(id)
      return typeof translated === 'string' && translated && translated !== id ? translated : copy[key]?.[lang === 'zh' ? 0 : 1]
    }
    const editing = account != null
    const id = useId()
    const [initial] = useState(() => accountFields(account))
    const [draft, setDraft] = useState(initial)
    const [uidText, setUidText] = useState(() => initial.allowedUids.join('\n'))
    const [replacing, setReplacing] = useState(false)
    const [hasInput, setHasInput] = useState(false)
    const [identity, setIdentity] = useState(null)
    const [busy, setBusy] = useState('')
    const [feedback, setFeedback] = useState(null)
    const tokenField = useRef(null)
    const verifiedToken = useRef('')
    const pending = useRef(null)
    const queued = useRef(null)
    const saved = useRef(JSON.stringify(initial))

    useEffect(() => () => {
      pending.current = null
      queued.current = null
      verifiedToken.current = ''
    }, [])
    useEffect(() => {
      if (allowCredentials) return
      verifiedToken.current = ''
      setReplacing(false)
      setHasInput(false)
      setIdentity(null)
      if (pending.current?.kind === 'verify') {
        pending.current = null
        setBusy('')
      }
    }, [allowCredentials])

    const clearToken = () => {
      if (tokenField.current) tokenField.current.value = ''
      verifiedToken.current = ''
      setHasInput(false)
      setIdentity(null)
    }
    const start = kind => {
      const request = { kind }
      pending.current = request
      setBusy(kind)
      setFeedback(null)
      return request
    }
    const finish = request => {
      if (pending.current !== request) return
      pending.current = null
      setBusy('')
    }
    const failure = (error, fallback, retry = false) =>
      setFeedback({ text: errorMessage?.(error) || tr(fallback), error: true, retry })
    const verify = async () => {
      if (!allowCredentials || pending.current) return
      const token = tokenField.current?.value.trim()
      if (!token) return
      clearToken()
      const request = start('verify')
      try {
        const { botUid, spaceId } = await onVerify({ token })
        if (pending.current !== request) return
        if ([botUid, spaceId].some(value => typeof value !== 'string' || !value.trim() || value.includes(token))) {
          failure(null, 'verifyFailed')
          return
        }
        verifiedToken.current = token
        setIdentity({ botUid, spaceId })
      } catch (error) {
        if (pending.current === request) failure(error, 'verifyFailed')
      } finally {
        finish(request)
      }
    }

    const workspaces = options?.workspaces ?? []
    const models = options?.models ?? []
    const policies = options?.policies ?? []
    const presets = options?.agentPresets ?? []
    const modelValue = modelChoice(draft.provider, draft.model)
    const originalModel = modelChoice(initial.provider, initial.model)
    const selectedModel = models.find(item => modelChoice(item.provider, item.model) === modelValue)
    const efforts = selectedModel?.reasoningEfforts ?? []
    const originalEffort = modelValue === originalModel ? initial.reasoningEffort : ''

    const choices = (items, original, name = original) => editing && original && !items.some(item => item.value === original)
      ? [...items, { value: original, label: name + ' (' + tr('current') + ')' }]
      : items
    const workspaceItems = choices(workspaces.map(item => ({ value: item.path, label: item.title || item.path })), initial.cwd)
    const modelItems = choices(models.map(item => ({
      value: modelChoice(item.provider, item.model), label: (item.label || item.model) + ' · ' + item.provider,
    })), originalModel, [initial.model, initial.provider].filter(Boolean).join(' · '))
    const catalogChoices = (items, builtins) => items.map(item => ({
      value: item.id,
      label: (Object.hasOwn(builtins, item.id) ? builtins[item.id][lang === 'zh' ? 0 : 1] : null) || item.label || item.id,
      disabled: item.disabled === true,
    }))
    const policyItems = choices(catalogChoices(policies, builtinPolicy), initial.permission)
    const presetOptions = catalogChoices(presets, builtinPreset)
    if (!presetOptions.some(item => item.value === 'octo-text')) {
      presetOptions.unshift({ value: 'octo-text', label: tr('defaultPreset') })
    }
    const presetItems = choices(presetOptions, initial.agentPreset)
    const effortLabel = value => Object.hasOwn(builtinEffort, value) ? builtinEffort[value][lang === 'zh' ? 0 : 1] : value
    const effortItems = choices(efforts.map(value => ({ value, label: effortLabel(value) })), originalEffort, effortLabel(originalEffort))
    const validChoice = (items, value, original) => (editing && value === original)
      || items.some(item => item.value === value && !item.disabled)
    const validate = fields => {
      const model = modelChoice(fields.provider, fields.model)
      return !validChoice(workspaceItems, fields.cwd, initial.cwd) ? (workspaces.length ? 'pickWorkspace' : 'noWorkspaces')
        : model && !validChoice(modelItems, model, originalModel) ? 'pickModel'
        : !validChoice(policyItems, fields.permission, initial.permission) ? (policies.length ? 'pickPolicy' : 'noPolicies')
        : fields.senderPolicy === 'allowlist' && !fields.allowedUids.length ? 'allowedUidsRequired'
        : ''
    }

    // Send only one mutation at a time, using the revision returned by the previous save.
    // A newer valid edit replaces any waiting edit, while incomplete drafts stay local.
    const save = async (settings, uids, withCredential = false) => {
      if (pending.current && (!editing || pending.current.kind !== 'save' || withCredential)) return
      const token = withCredential && allowCredentials ? verifiedToken.current : ''
      if (withCredential && !token) return
      const fields = {
        ...settings,
        label: settings.label.trim(),
        allowedUids: settings.senderPolicy === 'allowlist' ? userIds(uids) : [],
      }
      const problem = validate(fields)
      if (problem) {
        queued.current = null
        setFeedback({ text: tr(problem), error: true })
        return
      }
      if (pending.current) {
        queued.current = fields
        return
      }
      if (!withCredential && JSON.stringify(fields) === saved.current) {
        setFeedback(current => current?.error ? null : current)
        return
      }
      const request = start('save')
      let next = fields
      try {
        while (next && pending.current === request) {
          const credential = next === fields ? token : ''
          const signature = JSON.stringify(next)
          if (credential || signature !== saved.current) {
            const previous = JSON.parse(saved.current)
            const changes = editing ? Object.fromEntries(Object.entries(next).filter(([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(previous[key]))) : next
            await onSave({ ...changes, ...(credential ? { token: credential } : {}) })
            if (pending.current !== request) return
            saved.current = signature
            if (credential) {
              clearToken()
              setReplacing(false)
            }
          }
          next = queued.current
          queued.current = null
        }
        setFeedback(current => current?.error ? current : { text: tr('saved') })
      } catch (error) {
        queued.current = null
        if (pending.current === request) failure(error, 'saveFailed',
          editing && !withCredential && error?.message !== 'account_changed')
      } finally {
        finish(request)
      }
    }

    const update = (patch, commit = true) => {
      const next = { ...draft, ...patch }
      setDraft(next)
      if (editing && commit) void save(next, uidText)
    }
    const runAction = async (kind, action) => {
      if (pending.current) return
      const request = start(kind)
      try {
        const result = await action()
        if (pending.current !== request || result === false) return
        if (kind === 'remove') clearToken()
        else setFeedback({ text: tr(kind === 'diagnose' ? 'diagnosed' : 'reconnected') })
      } catch (error) {
        if (pending.current === request) failure(error, 'actionFailed')
      } finally {
        finish(request)
      }
    }

    const locked = Boolean(busy && !(editing && busy === 'save'))
    const hint = (key, props) => h('p', { className: 'dsho-account-note', ...props }, tr(key))
    const field = (key, title, control, wide = false) => h('div', { className: 'dsho-field' + (wide ? ' dsho-account-wide' : '') },
      h('label', { htmlFor: id + '-' + key }, tr(title)), control)
    const select = (key, title, items, value, onChange, placeholder, emptyAllowed = false) => field(key, title,
      h('select', { id: id + '-' + key, value: items.some(item => item.value === value) ? value : '',
        disabled: locked, 'aria-required': !emptyAllowed, onChange: event => onChange(event.target.value) },
      placeholder && h('option', { value: '', disabled: !emptyAllowed }, tr(placeholder)),
      ...items.map(item => h('option', { key: item.value, value: item.value, disabled: item.disabled }, item.label))))
    const enums = values => values.map(([value, label]) => ({ value, label: tr(label) }))
    const senderItems = enums([['allowlist', 'senderAllowlist'], ['octo', 'senderOcto']])
    const toolItems = enums([['private', 'toolPrivate'], ['owner', 'toolOwner'], ['admitted', 'toolAdmitted']])
    const toolHint = draft.toolScope === 'owner' ? 'toolOwnerHint' : draft.toolScope === 'admitted' ? 'toolAdmittedHint' : 'toolPrivateHint'
    const idleItems = choices(idleChoices.map(minutes => ({
      value: String(minutes), label: tr(minutes === 0 ? 'idleOff' : 'idle' + minutes),
    })), String(initial.idleMinutes))
    const commandItems = enums([['off', 'commandsOff'], ['safe', 'commandsSafe']])
    const checkbox = (key, title, description) => h('label', { className: 'dsho-account-checkbox dsho-account-wide' },
      h('input', { type: 'checkbox', checked: draft[key], disabled: locked, 'aria-describedby': description,
        onChange: event => update({ [key]: event.target.checked }) }), tr(title))
    const identityDetails = value => (value?.botUid || value?.spaceId) && h('div', { className: 'dsho-account-ids' },
      ...['botUid', 'spaceId'].filter(key => value[key]).map(key =>
        h('span', { key }, tr(key) + ': ', value[key])))

    const labelField = field('label', 'label', h(React.Fragment, null, h(Input, {
      id: id + '-label', value: draft.label, maxLength: 80, disabled: locked,
      onChange: event => update({ label: event.target.value }, false),
      onBlur: () => { if (editing) void save(draft, uidText) },
      onKeyDown: event => {
        if (editing && event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.currentTarget.blur()
        }
      },
    }), editing && hint('labelHint')), true)
    const settings = h('div', { className: 'dsho-account-settings' },
      !editing && labelField,
      select('cwd', editing ? 'currentWorkspace' : 'workspace', workspaceItems, draft.cwd, cwd => update({ cwd }),
        workspaceItems.length ? 'pickWorkspace' : 'noWorkspaces'),
      select('preset', 'agentPreset', presetItems, draft.agentPreset, agentPreset => update({ agentPreset })),
      h('div', { className: 'dsho-account-settings dsho-account-wide' },
        select('model', 'model', modelItems, modelValue, value => {
          const [provider, model] = value ? JSON.parse(value) : ['', '']
          update({ provider, model, reasoningEffort: '' })
        }, 'defaultModel', true),
        effortItems.length > 0 ? select('effort', 'reasoning', effortItems, draft.reasoningEffort,
          reasoningEffort => update({ reasoningEffort }), 'defaultEffort', true)
          : field('effort', 'reasoning', h('select', { id: id + '-effort', disabled: true },
            h('option', null, tr('effortUnavailable'))))),
      select('policy', 'permission', policyItems, draft.permission, permission => update({ permission }),
        policyItems.length ? 'pickPolicy' : 'noPolicies'),
      select('tool-scope', 'toolScope', toolItems, draft.toolScope, toolScope => update({ toolScope })),
      policies.some(item => item.disabled) && hint('policyDisabled', { className: 'dsho-account-note dsho-account-wide' }),
      hint('toolScopeHint', { className: 'dsho-account-note dsho-account-wide' }),
      hint(toolHint, { className: 'dsho-account-note dsho-account-wide' }),
      select('sender', 'senderPolicy', senderItems, draft.senderPolicy, senderPolicy => update({ senderPolicy })),
      draft.senderPolicy === 'allowlist' && field('uids', 'allowedUids', h(React.Fragment, null,
        h('textarea', { id: id + '-uids', rows: 3, value: uidText, disabled: locked, 'aria-required': true,
          'aria-describedby': id + '-uids-hint', onChange: event => setUidText(event.target.value),
          onBlur: () => { if (editing) void save(draft, uidText) } }),
        hint('allowedUidsHint', { id: id + '-uids-hint' })), true),
      select('send-mode', 'sendMode', enums([['queue', 'sendQueue'], ['steer', 'sendSteer']]),
        draft.sendMode, sendMode => update({ sendMode })),
      select('idle', 'idleMinutes', idleItems, String(draft.idleMinutes),
        idleMinutes => update({ idleMinutes: Number(idleMinutes) })),
      draft.sendMode === 'steer' && hint('sendSteerNote', { className: 'dsho-account-note dsho-account-wide' }),
      select('dm-commands', 'dmCommands', commandItems, draft.dmCommands, dmCommands => update({ dmCommands })),
      select('group-commands', 'groupCommands', commandItems, draft.groupCommands, groupCommands => update({ groupCommands })),
      hint('commandsHint', { className: 'dsho-account-note dsho-account-wide' }),
      checkbox('allowFiles', 'allowFiles', draft.allowFiles ? id + '-files-note' : undefined),
      draft.allowFiles && hint('filesNote', { id: id + '-files-note', className: 'dsho-account-note dsho-account-wide' }),
      !editing && checkbox('enabled', 'enabled'))

    const cancelReplacement = () => { clearToken(); setReplacing(false); setFeedback(null) }
    const cancelToken = () => editing ? cancelReplacement() : clearToken()
    const credentials = !allowCredentials ? hint('noVault')
      : editing && !replacing
        ? h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!busy,
          onClick: () => { setReplacing(true); setFeedback(null) } }, tr('replaceToken'))
        : h('div', { className: 'dsho-account-credentials' },
          identity ? h('div', { className: 'dsho-account-verified' },
            hint('verified', { role: 'status' }), identityDetails(identity))
            : field('token', editing ? 'replacement' : 'token', h(React.Fragment, null,
              h('input', { id: id + '-token', ref: tokenField, type: 'password', autoComplete: 'off', disabled: !!busy,
                'aria-describedby': editing ? id + '-keep' : undefined,
                onChange: event => { setHasInput(Boolean(event.target.value.trim())); setFeedback(null) },
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); void verify() } } }),
              editing && hint('keepToken', { id: id + '-keep' }))),
          h('div', { className: 'dsho-account-buttons' },
            !identity && h(Button, { type: 'button', variant: 'outline', disabled: !!busy || !hasInput, onClick: verify }, tr('verify')),
            editing && identity && h(Button, { type: 'button', variant: 'primary', disabled: !!busy,
              onClick: () => save(draft, uidText, true) }, tr('saveToken')),
            (editing || identity) && h(Button, { type: 'button', variant: 'outline', disabled: !!busy, onClick: cancelToken },
              tr(editing ? 'cancelReplacement' : 'clearToken'))))

    const actions = [['diagnose', onDiagnose], ['reconnect', onReconnect], ['remove', onRemove]]
      .filter(([, handler]) => editing && typeof handler === 'function')
    const feedbackLine = h('div', { className: 'dsho-account-feedback' },
      busy && hint(busy === 'verify' ? 'verifying' : busy === 'save' ? 'saving' : 'working', { role: 'status' }),
      feedback && h('p', { className: feedback.error ? 'dsho-alert' : 'dsho-account-note',
        role: feedback.error ? 'alert' : 'status' }, feedback.text),
      feedback?.retry && h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!busy,
        onClick: () => save(draft, uidText) }, tr('retry')))
    return h('form', { className: 'dsho-account-editor', autoComplete: 'off',
      onSubmit: event => { event.preventDefault(); void save(draft, uidText, !editing) } },
      h('div', { className: 'dsho-account-body' },
        editing && h('header', { className: 'dsho-account-inspector' },
          h('span', { className: 'dsho-account-logo', 'aria-hidden': true }, 'O'),
          h('div', { className: 'dsho-account-inspector-copy' },
            h('div', { className: 'dsho-account-inspector-title' },
              h('h3', null, account.label || tr('unnamed')), connectionStatus),
            identityDetails(account), account.legacy && hint('legacy'))),
        editing && labelField,
        h('div', { className: editing ? undefined : 'dsho-account-setup' }, settings),
        credentials,
        editing && h('div', { className: 'dsho-account-buttons' },
          h(Button, { type: 'submit', variant: 'outline', disabled: !!busy }, tr('saveEdits')), feedbackLine),
        editing && actions.length > 0 && h('div', { className: 'dsho-account-buttons dsho-account-edit-actions' },
          ...actions.map(([kind, action]) =>
            h(Button, { key: kind, type: 'button', variant: 'outline', disabled: !!busy,
              className: kind === 'remove' ? 'dsho-danger-action' : undefined,
              onClick: () => runAction(kind, action) }, tr(kind))))),
      !editing && h('footer', { className: 'dsho-account-footer' },
        feedbackLine,
        h('div', { className: 'dsho-account-buttons' },
          h(Button, { type: 'button', variant: 'outline', disabled: !!busy, onClick: () => { clearToken(); onCancel() } }, tr('cancel')),
          h(Button, { type: 'submit', variant: 'primary',
            disabled: !!busy || !allowCredentials || !identity || !draft.cwd }, tr('save')))))
  }

  return function AccountEditor(props) {
    const { account } = props
    return h(AccountForm, { ...props, key: account ? 'edit:' + (account.id ?? account.botUid) : 'add' })
  }
}
