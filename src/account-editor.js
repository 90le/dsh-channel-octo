import { createAssistantInstructionHelp } from './assistant-view.js'

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
  accountTab: ['账号连接', 'Connection'], assistantTab: ['专属助理', 'Assistant'],
  messagesTab: ['消息行为', 'Messages'], advancedTab: ['高级管理', 'Advanced'],
  assistantIntro: ['每个 Bot 自动拥有一位专属助理，以下设置仅用于此 Bot。', 'Each bot has its own assistant. These settings apply only to this bot.'],
  documents: ['Octo 附加指令', 'Extra Octo instructions'],
  agentsMd: ['AGENTS.md', 'AGENTS.md'], soulMd: ['SOUL.md', 'SOUL.md'],
  agentsPlaceholder: ['可选：仅此助理的操作约定，不自动读取工作区 AGENTS.md。', 'Optional: conventions for this assistant only. Workspace AGENTS.md is not imported.'],
  soulPlaceholder: ['可选：仅此助理的角色与语气，不自动读取工作区 SOUL.md。', 'Optional: role and tone for this assistant only. Workspace SOUL.md is not imported.'],
  documentsTooLarge: ['每份助理指令最多 8 KB，请缩短后保存。', 'Each instruction document can contain up to 8 KB.'],
  setupHint: ['验证 Bot 令牌，并在「专属助理」选择工作区，即可创建账号。', 'Verify the bot token and choose a workspace under Assistant to create the account.'],
  savedHint: ['设置自动保存，后续消息生效。', 'Changes save automatically and apply to subsequent messages.'],
  assistant: ['专属助理', 'Assistant'],
  assistantHint: ['工作区、模型、预设和权限请在「助理」页编辑。', 'Use the Assistants tab to edit the workspace, model, preset and permissions.'],
  connection: ['连接与诊断', 'Connection and diagnostics'], messageBehavior: ['私聊准入与附件', 'DM admission and attachments'],
  advancedBehavior: ['高级消息行为', 'Advanced message behavior'],
  legacy: ['此账号来自服务器原有配置。', 'This account comes from the server configuration.'],
  label: ['账号名称', 'Account name'],
  labelHint: ['用于区分账号，可在账号列表中修改。', 'Use a name to distinguish this account. You can also rename it in the account list.'],
  token: ['Bot 令牌', 'Bot token'],
  replacement: ['新 Bot 令牌', 'New bot token'],
  replaceToken: ['更换 Bot 令牌', 'Replace bot token'],
  cancelReplacement: ['取消更换令牌', 'Cancel token replacement'],
  keepToken: ['这里只能更换同一个 Bot 的令牌。验证并保存后才会替换旧令牌。', 'Use a new token for this same Bot. Verify and save it to replace the old token.'],
  noVault: ['DSH 凭据库暂不可用。', 'The DSH credential store is unavailable.'],
  verify: ['验证令牌', 'Verify token'],
  verifying: ['正在验证令牌…', 'Verifying token…'],
  verified: ['令牌已验证', 'Token verified'],
  verifyFailed: ['Octo 未能确认此令牌，请检查令牌或连接后重试。', 'Octo could not confirm the token. Check the token or connection and try again.'],
  differentBot: ['令牌有效，但与当前账号绑定的 Bot 不一致。请使用此 Bot 的新令牌；若要连接另一个 Bot，请点「添加账号」。', 'This token is valid but does not match the Bot linked to this account. Use a new token for this Bot, or choose Add account to connect another Bot.'],
  clearToken: ['重新输入令牌', 'Enter a different token'],
  saveToken: ['保存新令牌', 'Save new token'],
  botUid: ['Bot ID', 'Bot ID'],
  spaceId: ['空间 ID', 'Space ID'],
  botKind: ['Bot 类型', 'Bot type'],
  appBot: ['应用 Bot', 'App Bot'],
  userBot: ['用户 Bot', 'User Bot'],
  scope: ['聊天范围', 'Chat scope'],
  appScope: ['Octo 管理的私聊范围', 'Octo-managed DM scope'],
  appRegistration: ['验证 App Bot 令牌时，也会向 Octo 注册该 Bot 的连接。', 'Verifying an App Bot token also registers its connection with Octo.'],
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
  appToolScopeHint: ['控制谁能在获准的私聊中使用所选 Agent 预设的 DSH 工具、插件和技能，实际操作仍受账号权限策略约束；“仅文字”不开放工具。', 'Controls who can use the selected Agent preset’s DSH tools, plugins and skills in admitted DMs, subject to this account’s permission policy. Text-only permission grants no tools.'],
  appToolPrivateHint: ['工具对名单内的私聊用户开放；跟随 Octo 准入时为已验证的 Bot 所有者。', 'Tools are available to allowlisted DM users or, with Octo admission, the verified bot owner.'],
  appToolOwnerHint: ['工具仅对已验证的 Bot 所有者的获准私聊开放。', 'Tools are available to the verified bot owner in admitted DMs.'],
  appToolAdmittedHint: ['工具对所有已通过聊天准入的私聊用户开放。', 'Tools are available to all admitted DM users.'],
  toolPrivateHint: ['DSH 工具仅对获准的私聊用户开放：名单准入时为名单内用户，跟随 Octo 准入时为 Bot 所有者。群聊和子区仍可使用已开放的 Octo 频道工具，不能访问工作区。', 'DSH tools are limited to allowlisted DM users or the verified bot owner in DMs. Groups and topics can still use enabled Octo channel tools, without workspace access.'],
  toolOwnerHint: ['仅已验证的 Bot 所有者可用，适用于其已准入的私聊、群聊和子区（话题）。', 'Only the verified bot owner can use tools, in admitted DMs, groups and topics.'],
  toolAdmittedHint: ['所有已通过聊天准入的用户均可用，包括私聊、群聊和子区（话题）。', 'All users who passed chat admission can use tools, including in DMs, groups and topics.'],
  senderPolicy: ['私聊准入', 'Private chat access'],
  senderAllowlist: ['仅允许名单中的用户', 'Allowlisted users only'],
  senderOcto: ['跟随 Octo 好友和群成员权限', 'Follow Octo friend and group access'],
  appSenderOcto: ['跟随 Octo 私聊权限', 'Follow Octo DM access'],
  allowedUids: ['允许的用户 ID', 'Allowed user IDs'],
  allowedUidsHint: ['每行填写一个用户 ID。', 'Enter one user ID per line.'],
  allowedUidsRequired: ['请至少填写一个允许的用户 ID。', 'Enter at least one allowed user ID.'],
  idleMinutes: ['空闲新开会话', 'Idle session rotation'],
  idleOff: ['关闭（保持原会话）', 'Disabled (keep session)'],
  idle15: ['15 分钟', '15 min'],
  idle30: ['30 分钟', '30 min'],
  idle60: ['1 小时', '1 hr'],
  idle120: ['2 小时', '2 hrs'],
  progressSection: ['进度卡', 'Progress card'],
  progressExpansion: ['执行时进度卡展开方式', 'Progress card while running'],
  progressCollapsed: ['默认折叠', 'Collapsed'],
  progressList: ['展开列表', 'Expand list'],
  progressAll: ['全部展开', 'Expand all'],
  progressExpansionHint: ['启用进度卡时，仅对当前 Bot 的新任务生效。等待回答或审批时保持此方式；成功、失败、停止或超时结束后全部折叠。每次更新按此设置显示，手动展开状态可能重置。', 'Applies to new tasks for this Bot. Waiting for answers or approval retains this view; completion, failure, stop or timeout collapses everything. Updates apply this default and may reset manual toggles.'],
  sendMode: ['发送方式', 'Send mode'],
  sendQueue: ['排队发送', 'Queue'],
  sendSteer: ['插话发送', 'Steer'],
  sendSteerNote: ['实时连接下，同一频道内、同一获准使用 DSH 工具的用户可补充文字指令。附件准备中的补充会与附件一起处理；执行中由 DSH 在下一可插话步骤接收。其他消息仍按队列发送。', 'Over WebSocket, the same user authorized for DSH tools can add instructions in the same channel. Attachment preparation merges the supplement; running work receives it at the next DSH steering step. Other messages are queued.'],
  dmCommands: ['私聊快捷命令', 'DM shortcuts'],
  groupCommands: ['群聊快捷命令', 'Group shortcuts'],
  commandsOff: ['仅正常对话', 'Conversation only'],
  commandsSafe: ['允许频道快捷命令', 'Allow channel shortcuts'],
  commandsHint: ['开启后可用 /help、/status、/new、/stop。私聊限已准入的 Bot 所有者或名单用户；群聊和子区仅 Bot 所有者可用。/stop 只停止当前频道正在处理的任务。此设置不转发其他插件命令；工具访问由“工具使用范围”和“权限策略”控制。', 'Enables /help, /status, /new and /stop. In DMs, only the admitted bot owner or allowlisted users can use them. In groups and topics, only the bot owner can use them. /stop stops only the current task in that conversation. This setting does not forward other plugins’ commands. Tool access is controlled by tool scope and permission.'],
  allowFiles: ['允许处理文件附件', 'Allow file attachments'],
  filesNote: ['开启后可接收、读取和分析附件。只读权限下也可开启，不会因此允许创建、修改或删除工作区文件。发送已有文件仍需满足工具使用范围和文件交付规则。', 'Receive, read and analyze attachments. This also works with read-only permission and does not permit creating, modifying or deleting workspace files. Delivering existing files still requires tool access and file-delivery authorization.'],
  filesDisabledNote: ['关闭后，含附件的整条消息（包括配文）将不处理；纯文字消息不受影响。', 'When disabled, messages containing attachments, including their accompanying text, are skipped. Text-only messages are unaffected.'],
  appFilesNote: ['开启后可接收、读取和分析获准私聊中的附件。只读权限下也可开启，不会放开工作区写入权限；发送已有文件仍需满足工具使用范围和文件交付规则。', 'Receive, read and analyze attachments from admitted DMs, including with read-only permission. Workspace write access is unchanged; delivering existing files still requires tool access and file-delivery authorization.'],
  current: ['当前设置', 'Current setting'],
  enabled: ['启用此账号', 'Enable this account'],
  save: ['保存账号', 'Save account'],
  saving: ['正在保存…', 'Saving…'],
  saved: ['保存成功', 'Saved successfully'],
  saveEdits: ['保存设置', 'Save settings'],
  saveFailed: ['未能保存账号。请稍后重试。', 'Could not save the account. Try again.'],
  retry: ['重试保存', 'Retry save'],
  diagnose: ['诊断连接', 'Diagnose connection'],
  reconnect: ['重新连接', 'Reconnect'],
  remove: ['移除账号', 'Remove account'],
  working: ['正在处理账号请求…', 'Working…'],
  diagnosed: ['Octo 已确认 Bot 身份，现有连接未被重启。', 'Octo verified the bot identity. The existing connection was not restarted.'],
  reconnected: ['已发起重连，请查看账号连接状态。', 'Reconnection requested. Check the account connection status.'],
  actionFailed: ['未能完成账号操作。请稍后重试。', 'Could not complete the account action. Try again.'],
  cancel: ['取消', 'Cancel'], close: ['关闭', 'Close'],
}

const modelChoice = (provider, model) => provider || model ? JSON.stringify([provider, model]) : ''
const idleChoices = [0, 15, 30, 60, 120]
const userIds = text => [...new Set(text.split(/\r?\n/).map(uid => uid.trim()).filter(Boolean))]

export function accountFields(account) {
  return {
    label: account?.label ?? '',
    agentsMd: account?.agentsMd ?? '', soulMd: account?.soulMd ?? '',
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
    progressExpansion: ['list', 'all'].includes(account?.progressExpansion) ? account.progressExpansion : 'collapsed',
  }
}

export function createAccountEditor(React, { Button, Input }) {
  const { createElement: h, useEffect, useId, useRef, useState } = React
  const InstructionHelp = createAssistantInstructionHelp(React)

  function AccountForm({ account, options, allowCredentials, onVerify, onSave, onCancel,
    onDiagnose, onReconnect, onRemove, t, lang = 'zh', connectionStatus, errorMessage, management }) {
    const tr = key => {
      const id = 'octo.accountEditor.' + key
      const translated = t?.(id)
      return typeof translated === 'string' && translated && translated !== id ? translated : copy[key]?.[lang === 'zh' ? 0 : 1]
    }
    const editing = account != null
    const id = useId()
    const [page, setPage] = useState('account')
    const scroll = useRef(null)
    useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0 }, [page])
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
    const failure = (error, fallback, retry = false, area) =>
      setFeedback({ text: error?.message === 'bot_identity_mismatch' && area === 'credentials'
        ? tr('differentBot') : errorMessage?.(error) || tr(fallback), error: true, retry, area })
    const verify = async () => {
      if (!allowCredentials || pending.current) return
      const token = tokenField.current?.value.trim()
      if (!token) return
      clearToken()
      const request = start('verify')
      try {
        const { botUid, spaceId, botKind } = await onVerify({ token })
        if (pending.current !== request) return
        const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value) && !value.includes(token)
        const verifiedApp = botKind === 'app' && token.startsWith('app_') && validId(botUid)
          && /^app_[A-Za-z0-9_-]+_bot$/.test(botUid) && spaceId === null
        const verifiedUser = (botKind === undefined || botKind === 'user') && token.startsWith('bf_')
          && validId(botUid) && validId(spaceId)
        if (!verifiedApp && !verifiedUser) {
          failure(null, 'verifyFailed', false, 'credentials')
          return
        }
        if (editing && (botUid !== account.botUid || spaceId !== account.spaceId
          || (botKind ?? 'user') !== (account.botKind ?? 'user'))) {
          failure(null, 'differentBot', false, 'credentials')
          return
        }
        verifiedToken.current = token
        setIdentity({ botUid, spaceId, ...(verifiedApp && { botKind: 'app' }) })
      } catch (error) {
        if (pending.current === request) failure(error, 'verifyFailed', false, 'credentials')
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
      const problem = [fields.agentsMd, fields.soulMd].some(text => new TextEncoder().encode(text).length > 8192)
        ? 'documentsTooLarge' : validate(fields)
      if (problem) {
        queued.current = null
        if (['pickWorkspace', 'noWorkspaces', 'pickModel', 'pickPolicy', 'noPolicies', 'documentsTooLarge'].includes(problem)) setPage('assistant')
        setFeedback({ text: tr(problem), error: true })
        return
      }
      if (pending.current) {
        queued.current = fields
        return
      }
      if (!withCredential && JSON.stringify(fields) === saved.current) {
        setFeedback({ text: tr('saved') })
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
        setFeedback({ text: tr('saved') })
      } catch (error) {
        queued.current = null
        if (pending.current === request) failure(error, 'saveFailed',
          editing && !withCredential && error?.message !== 'account_changed', withCredential ? 'credentials' : undefined)
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
    const app = (editing ? account : identity)?.botKind === 'app'
    const senderItems = enums([['allowlist', 'senderAllowlist'], ['octo', app ? 'appSenderOcto' : 'senderOcto']])
    const toolItems = enums([['private', 'toolPrivate'], ['owner', 'toolOwner'], ['admitted', 'toolAdmitted']])
    const toolHint = draft.toolScope === 'owner' ? (app ? 'appToolOwnerHint' : 'toolOwnerHint')
      : draft.toolScope === 'admitted' ? (app ? 'appToolAdmittedHint' : 'toolAdmittedHint') : (app ? 'appToolPrivateHint' : 'toolPrivateHint')
    const idleItems = choices(idleChoices.map(minutes => ({
      value: String(minutes), label: tr(minutes === 0 ? 'idleOff' : 'idle' + minutes),
    })), String(initial.idleMinutes))
    const commandItems = enums([['off', 'commandsOff'], ['safe', 'commandsSafe']])
    const checkbox = (key, title, description) => h('label', { className: 'dsho-account-checkbox dsho-account-wide' },
      h('input', { type: 'checkbox', checked: draft[key], disabled: locked, 'aria-describedby': description,
        onChange: event => update({ [key]: event.target.checked }) }), tr(title))
    const identityDetails = value => (value?.botUid || value?.spaceId) && h('div', { className: 'dsho-account-ids' },
      h('span', null, tr('botKind') + ': ', tr(value.botKind === 'app' ? 'appBot' : 'userBot')),
      h('span', null, tr('botUid') + ': ', value.botUid),
      value.botKind === 'app' ? h('span', null, tr('scope') + ': ', tr('appScope'))
        : h('span', null, tr('spaceId') + ': ', value.spaceId))

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
    const assistantSettings = h(React.Fragment, null,
      hint('assistantIntro'),
      h('div', { className: 'dsho-account-settings' },
        select('cwd', editing ? 'currentWorkspace' : 'workspace', workspaceItems, draft.cwd, cwd => update({ cwd }),
          workspaceItems.length ? 'pickWorkspace' : 'noWorkspaces'),
        select('preset', 'agentPreset', presetItems, draft.agentPreset, agentPreset => update({ agentPreset })),
        select('model', 'model', modelItems, modelValue, value => {
          const [provider, model] = value ? JSON.parse(value) : ['', '']
          update({ provider, model, reasoningEffort: '' })
        }, 'defaultModel', true),
        effortItems.length > 0 ? select('effort', 'reasoning', effortItems, draft.reasoningEffort,
          reasoningEffort => update({ reasoningEffort }), 'defaultEffort', true)
          : field('effort', 'reasoning', h('select', { id: id + '-effort', disabled: true },
            h('option', null, tr('effortUnavailable')))),
        select('policy', 'permission', policyItems, draft.permission, permission => update({ permission }),
          policyItems.length ? 'pickPolicy' : 'noPolicies'),
        select('tool-scope', 'toolScope', toolItems, draft.toolScope, toolScope => update({ toolScope }))),
      hint(toolHint),
      h('details', { className: 'dsho-account-help' }, h('summary', null, tr('toolScope')),
        hint(app ? 'appToolScopeHint' : 'toolScopeHint'),
        policies.some(item => item.disabled) && hint('policyDisabled')),
      h('section', { className: 'dsho-account-section' },
        h('h3', null, tr('documents')), h(InstructionHelp, { lang, id: id + '-instruction-source' }),
        ...['agentsMd', 'soulMd'].map(key => field(key, key, h('textarea', {
          id: id + '-' + key, rows: 4, maxLength: 8192, value: draft[key], disabled: locked,
          'aria-describedby': id + '-instruction-source',
          placeholder: tr(key === 'agentsMd' ? 'agentsPlaceholder' : 'soulPlaceholder'),
          onChange: event => update({ [key]: event.target.value }, false),
          onBlur: () => { if (editing) void save(draft, uidText) },
        })))))
    const messageSettings = h(React.Fragment, null,
      h('div', { className: 'dsho-account-settings' },
        select('sender', 'senderPolicy', senderItems, draft.senderPolicy, senderPolicy => update({ senderPolicy })),
        select('send-mode', 'sendMode', enums([['queue', 'sendQueue'], ['steer', 'sendSteer']]),
          draft.sendMode, sendMode => update({ sendMode })),
        draft.senderPolicy === 'allowlist' && field('uids', 'allowedUids', h(React.Fragment, null,
          h('textarea', { id: id + '-uids', rows: 3, value: uidText, disabled: locked,
            onChange: event => setUidText(event.target.value),
            onBlur: () => { if (editing) void save(draft, uidText) } }), hint('allowedUidsHint')), true),
        select('idle', 'idleMinutes', idleItems, String(draft.idleMinutes),
          idleMinutes => update({ idleMinutes: Number(idleMinutes) }))),
      draft.sendMode === 'steer' && hint('sendSteerNote'),
      h('section', { className: 'dsho-account-section' },
        h('h3', null, tr('progressSection')),
        select('progress-expansion', 'progressExpansion', enums([['collapsed', 'progressCollapsed'], ['list', 'progressList'], ['all', 'progressAll']]),
          draft.progressExpansion, progressExpansion => update({ progressExpansion })),
        hint('progressExpansionHint')),
      h('section', { className: 'dsho-account-section' },
        checkbox('allowFiles', 'allowFiles', id + '-files-help'),
        hint(draft.allowFiles ? app ? 'appFilesNote' : 'filesNote' : 'filesDisabledNote', { id: id + '-files-help' })),
      h('section', { className: 'dsho-account-section' },
        h('div', { className: 'dsho-account-settings' },
          select('dm-commands', 'dmCommands', commandItems, draft.dmCommands, dmCommands => update({ dmCommands })),
          !app && select('group-commands', 'groupCommands', commandItems, draft.groupCommands, groupCommands => update({ groupCommands }))),
        hint('commandsHint')))

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
                'aria-describedby': id + '-registration' + (editing ? ' ' + id + '-keep' : ''),
                onChange: event => { setHasInput(Boolean(event.target.value.trim())); setFeedback(null) },
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); void verify() } } }),
              editing && hint('keepToken', { id: id + '-keep' }),
              hint('appRegistration', { id: id + '-registration' }))),
          h('div', { className: 'dsho-account-buttons' },
            !identity && h(Button, { type: 'button', variant: 'outline', disabled: !!busy || !hasInput, onClick: verify }, tr('verify')),
            editing && identity && h(Button, { type: 'button', variant: 'primary', disabled: !!busy,
              onClick: () => save(draft, uidText, true) }, tr('saveToken')),
            (editing || identity) && h(Button, { type: 'button', variant: 'outline', disabled: !!busy, onClick: cancelToken },
              tr(editing ? 'cancelReplacement' : 'clearToken'))),
          feedback?.area === 'credentials' && h('p', { className: 'dsho-alert dsho-credential-feedback', role: 'alert' }, feedback.text))

    const actions = [['diagnose', onDiagnose], ['reconnect', onReconnect], ['remove', onRemove]]
      .filter(([, handler]) => editing && typeof handler === 'function')
    const feedbackLine = h('div', { className: 'dsho-account-feedback' },
      busy && hint(busy === 'verify' ? 'verifying' : busy === 'save' ? 'saving' : 'working', { role: 'status' }),
      feedback && feedback.area !== 'credentials' && h('p', { className: feedback.error ? 'dsho-alert' : 'dsho-account-success',
        role: feedback.error ? 'alert' : 'status', 'aria-live': 'polite' },
        !feedback.error && h('span', { 'aria-hidden': true }, '✓ '), feedback.text),
      feedback?.retry && h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!busy,
        onClick: () => save(draft, uidText) }, tr('retry')))
    const pages = [['account', 'accountTab'], ['assistant', 'assistantTab'], ['messages', 'messagesTab'],
      ...(editing ? [['advanced', 'advancedTab']] : [])]
    const panel = (key, ...children) => h('div', { className: 'dsho-account-tabpanel', role: 'tabpanel',
      id: id + '-panel-' + key, 'aria-labelledby': id + '-tab-' + key, hidden: page !== key }, ...children)
    return h('form', { className: 'dsho-account-editor', autoComplete: 'off',
      onSubmit: event => { event.preventDefault(); void save(draft, uidText, !editing) } },
      h('div', { className: 'dsho-account-tabs', role: 'tablist', 'aria-label': tr('unnamed') },
        ...pages.map(([key, title], index) => h('button', { key, type: 'button', role: 'tab',
          id: id + '-tab-' + key, 'aria-controls': id + '-panel-' + key, 'aria-selected': page === key,
          tabIndex: page === key ? 0 : -1, onClick: () => setPage(key),
          onKeyDown: event => {
            let next
            if (event.key === 'ArrowRight') next = (index + 1) % pages.length
            if (event.key === 'ArrowLeft') next = (index + pages.length - 1) % pages.length
            if (event.key === 'Home') next = 0
            if (event.key === 'End') next = pages.length - 1
            if (next !== undefined) { event.preventDefault(); setPage(pages[next][0]); document.getElementById(id + '-tab-' + pages[next][0])?.focus() }
          } }, tr(title)))),
      h('div', { className: 'dsho-account-body', ref: scroll },
        panel('account',
          editing && h('header', { className: 'dsho-account-inspector' },
            h('span', { className: 'dsho-account-logo', 'aria-hidden': true }, 'O'),
            h('div', { className: 'dsho-account-inspector-copy' },
              h('div', { className: 'dsho-account-inspector-title' },
                h('h3', null, account.label || tr('unnamed')), connectionStatus), identityDetails(account))),
          !editing && hint('setupHint'), labelField, credentials, !editing && checkbox('enabled', 'enabled')),
        panel('assistant', assistantSettings),
        panel('messages', messageSettings),
        editing && panel('advanced', management,
          h('section', { className: 'dsho-account-section' }, h('h3', null, tr('connection')),
            account.legacy && hint('legacy'),
            h('div', { className: 'dsho-account-buttons' }, ...actions.map(([kind, action]) =>
              h(Button, { key: kind, type: 'button', variant: 'outline', disabled: !!busy,
                className: kind === 'remove' ? 'dsho-danger-action' : undefined,
                onClick: () => runAction(kind, action) }, tr(kind))))))),
      h('footer', { className: 'dsho-account-footer' },
        h('div', null, feedbackLine, !feedback && !busy && hint(editing ? 'savedHint' : 'assistantIntro')),
        h('div', { className: 'dsho-account-buttons' },
          h(Button, { type: 'button', variant: 'outline', disabled: !!busy, onClick: () => { clearToken(); onCancel() } }, tr(editing ? 'close' : 'cancel')),
          h(Button, { type: 'submit', variant: 'primary',
            disabled: !!busy || (!editing && (!allowCredentials || !identity)) }, tr(editing ? 'saveEdits' : 'save')))))

  }

  return function AccountEditor(props) {
    const { account } = props
    return h(AccountForm, { ...props, key: account ? 'edit:' + (account.id ?? account.botUid) : 'add' })
  }
}
