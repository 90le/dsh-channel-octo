// Browser half: use the host's locale, controls, settings and session navigation.
window.__ModuleLoader__.load({
  id: 'dsh-channel-octo',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = React
    const { Button, Input, SegmentedTabs, Menu, IconEllipsisOutlineRegular, IconPinFillRegular } = primitives
    const path = 'api/dsh-channel-octo'
    const words = {
      settings: ['Octo 渠道', 'Octo channel'], shortcut: ['Octo 频道', 'Octo conversations'],
      subtitle: ['管理 Octo 机器人、消息规则和会话。', 'Manage your Octo bot, message rules and conversations.'],
      account: ['Bot 账号', 'Bot account'], rules: ['渠道设置', 'Channel settings'], sessions: ['频道会话', 'Conversations'],
      nav: ['Octo 设置分类', 'Octo settings sections'], close: ['关闭', 'Close'],
      selectedBot: ['选择账号', 'Choose account'], previousSession: ['历史会话', 'Past conversation'],
      loading: ['正在加载 Octo…', 'Loading Octo…'], retry: ['重新加载', 'Reload'],
      online: ['已连接', 'Connected'], connecting: ['正在连接', 'Connecting'],
      reconnecting: ['正在重连', 'Reconnecting'], disconnecting: ['正在停止接收', 'Stopping'], disabled: ['尚未启用', 'Disabled'],
      invalid_configuration: ['连接配置有误', 'Invalid connection settings'],
      configuration_or_state_error: ['无法读取渠道设置', 'Channel settings are unavailable'],
      worker_stopped: ['连接已停止', 'Connection stopped'],
      queued: ['待处理', 'Queued'], running: ['生成中', 'Working'], ready: ['待发送', 'Ready to send'],
      sending: ['发送中', 'Sending'], sent: ['已回复', 'Replied'], review: ['待检查', 'Needs review'],
      established: ['已建立', 'Available'], ignored: ['未触发', 'Not triggered'],
      notConfigured: ['尚未绑定 Octo Bot', 'No Octo bot is connected'],
      deployHint: ['请在 DSH 服务器中完成初始绑定。启用后，这里会显示连接状态和渠道设置。',
        'Complete the initial binding on the DSH server. Connection status and channel settings will appear here.'],
      serverManaged: ['服务器管理连接凭据', 'Connection credentials are managed on the server'],
      details: ['连接详情', 'Connection details'], botId: ['Bot ID', 'Bot ID'], space: ['空间 ID', 'Space ID'],
      endpoint: ['Octo 服务地址', 'Octo server'], directory: ['DSH 工作目录', 'DSH workspace'],
      transport: ['连接方式', 'Transport'], websocket: ['WebSocket 长连接', 'WebSocket'], events: ['事件轮询', 'Event polling'],
      credential: ['令牌', 'Token'], masked: ['已配置 · 不显示原文', 'Configured · hidden'],
      processed: ['消息处理', 'Message processing'],
      queueNote: ['连接状态和消息处理状态分别显示。', 'Connection and reply status are shown separately.'],
      noActivity: ['还没有消息记录。', 'No message activity yet.'],
      permission: ['接入权限', 'Access'], permissionHint: ['选择哪些人和频道可以使用机器人。', 'Choose who can use the bot and in which channels.'],
      sender: ['可用人群', 'Allowed people'], senderAuto: ['Octo 好友和群成员', 'Octo friends and group members'],
      senderList: ['仅用户白名单', 'Only allowed users'], users: ['用户白名单', 'Allowed user IDs'],
      routes: ['群聊与子区', 'Groups and topics'], routesAuto: ['Bot 已加入的群和子区', 'Joined groups and topics'],
      routesList: ['仅频道白名单', 'Only allowed channels'], groups: ['群聊白名单', 'Allowed group IDs'],
      threads: ['子区白名单', 'Allowed topic IDs'], threadFormat: ['每行一个完整地址：群 ID____子区 ID。',
        'Use one full address per line: group ID____topic ID.'],
      onePerLine: ['每行一个 ID', 'One ID per line'],
      triggers: ['触发与规则', 'Triggers and rules'], triggersHint: ['私聊直接触发；群聊与子区按下列规则处理。',
        'Direct messages trigger replies. Groups and topics follow these rules.'],
      mention: ['群聊与子区触发', 'Group and topic trigger'], requireMention: ['必须 @ Bot', 'Require an @mention'],
      followMention: ['跟随 Octo 的免 @ 设置', 'Follow Octo’s mention setting'],
      requiresWebSocket: ['免 @ 需要 WebSocket 长连接。', 'Replies without mentions require WebSocket.'],
      threadRule: ['子区规则', 'Topic rules'], threadOnly: ['只用子区规则', 'Use only topic rules'],
      threadInherit: ['继承群规则，子区优先', 'Inherit group rules; topic rules take priority'],
      response: ['回复体验', 'Replies'], responseHint: ['设置用户看到的进度和最长等待时间。', 'Choose the progress users see and how long to wait.'],
      progress: ['进度显示', 'Reply progress'], card: ['优先使用 Octo 进度卡', 'Prefer Octo progress cards'],
      typing: ['仅显示正在输入', 'Typing indicator only'], off: ['关闭进度', 'Turn off progress'],
      cardHint: ['卡片不可用时自动显示「正在输入」。', 'Falls back to a typing indicator when cards are unavailable.'],
      timeout: ['回复超时（秒）', 'Reply timeout (seconds)'],
      save: ['保存设置', 'Save settings'], saving: ['正在保存…', 'Saving…'],
      reset: ['恢复当前设置', 'Reset to current settings'], resetDone: ['已恢复当前设置。', 'Current settings restored.'],
      saved: ['已保存，从下一条消息起生效。', 'Saved. Applies to the next message.'],
      all: ['全部', 'All'], dm: ['私聊', 'Direct'], group: ['群聊', 'Group'], topic: ['子区', 'Topic'],
      sessionActions: ['会话操作', 'Conversation actions'], pinned: ['已置顶', 'Pinned'], openConversation: ['打开会话', 'Open conversation'],
      copyConversationId: ['复制会话 ID', 'Copy session ID'],
      filter: ['会话类型', 'Conversation type'], search: ['搜索会话', 'Search conversations'],
      empty: ['还没有 Octo 会话', 'No Octo conversations yet'],
      emptyNote: ['机器人收到符合规则的消息后，会话会出现在这里。', 'Conversations appear here when the bot receives an eligible message.'],
      noResults: ['没有匹配的会话', 'No matching conversations'],
      noResultsNote: ['换个关键词或会话类型试试。', 'Try another search or conversation type.'],
      openError: ['无法打开会话，请刷新后重试。', 'Could not open the conversation. Refresh and try again.'],
      inherited: ['继承群规则', 'Inherits group rules'],
      session_busy: ['会话正忙', 'Session is busy'], session_timeout: ['生成超时', 'Reply timed out'],
      session_preset_conflict: ['会话配置不一致', 'Session settings do not match'],
      agent_run_not_confirmed: ['DSH 未确认回复', 'DSH did not confirm the reply'],
      delivery_not_confirmed: ['Octo 未确认送达', 'Octo did not confirm delivery'],
      delivery_access_changed: ['设置或权限已变更，剩余交付已停止', 'Settings or access changed; remaining delivery stopped'],
      delivery_profile_unavailable: ['旧回复缺少配置记录，请在 DSH 核对后继续', 'Prepared reply lacks its original settings; review it in DSH'],
      file_not_presented: ['未交付可发送的文件', 'No file was prepared for delivery'],
      file_tools_unavailable: ['本次私聊没有工作区工具权限', 'Workspace tools are unavailable in this DM'],
      files_disabled: ['账号未开启附件', 'Attachments are disabled'],
      session_requires_owned_writer: ['会话权限与账号配置不一致', 'The session permission does not match the account'],
      file_delivery_not_confirmed: ['文件发送未确认', 'File delivery was not confirmed'],
      no_confirmed_final_text: ['没有可发送的正文', 'No reply text to send'],
      shared_turn_not_forwarded: ['本次包含其他来源的输入', 'This turn includes input from another source'],
      rulesIssue: ['群聊或子区规则读取失败', 'Could not read the group or topic rules'],
      accessIssue: ['未能核验接入权限', 'Could not verify access'],
      unknownIssue: ['需要检查本次处理结果', 'Check what happened to this reply'],
      settings_changed: ['设置已在别处更新。请恢复当前设置后再编辑。', 'Settings changed elsewhere. Reset to the current settings before editing.'],
      invalid_settings: ['请检查名单格式和超时范围。', 'Check the ID lists and timeout range.'],
      transport_managed_by_host: ['当前连接方式不支持免 @。', 'The current transport requires mentions.'],
      authentication_required: ['请重新登录 DSH Web。', 'Sign in to DSH Web again.'],
      settings_not_saved: ['保存失败，请检查服务器存储。', 'Could not save. Check server storage.'],
      unavailable: ['暂时无法读取 Octo 渠道，请重试。', 'Could not load the Octo channel. Try again.'],
      saveError: ['设置未保存，请稍后重试。', 'Settings were not saved. Try again.'],
      unsaved: ['有未保存的修改', 'Unsaved changes'],
    }
    const style = `
.dsho-root,.dsho-rail,.dsho-modal {
  --dsho-edge:var(--dsw-alias-border-l3, color-mix(in srgb,currentColor 14%,transparent));
  --dsho-soft:var(--dsw-alias-bg-layer-2, Canvas);
  --dsho-muted:var(--dsw-alias-text-l2, color-mix(in srgb,currentColor 72%,transparent));
  --dsho-row:color-mix(in srgb,currentColor 5%,transparent);
  min-width:0; color:inherit; font:inherit;
}
.dsho-root { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; max-width:720px; box-sizing:border-box; }
.dsho-list > .dsho-session-line { display:flex; align-items:center; gap:2px; min-width:0; }
.dsho-session-line > .dsho-row { flex:1; min-width:0; }
.dsho-session-menu-trigger { display:grid; place-items:center; flex:none; width:30px; height:30px; padding:0; border:0; border-radius:8px; background:transparent; color:inherit; cursor:pointer; }
.dsho-session-menu-trigger:hover,.dsho-session-menu-trigger[aria-expanded=true] { background:var(--dsho-row); }
.dsho-root [hidden] { display:none!important; }
.dsho-root [role="tabpanel"] { min-width:0; }
.dsho-root h2,.dsho-root h3,.dsho-rail h3,.dsho-modal h2 { margin:0; font-weight:650; line-height:1.32; }
.dsho-root h2,.dsho-modal h2 { font-size:21px; }
.dsho-root h3,.dsho-rail h3 { font-size:14px; }
.dsho-muted { color:var(--dsho-muted); font-size:12px; line-height:1.55; margin:0; }
.dsho-head,.dsho-account,.dsho-tools,.dsho-actions { display:flex; align-items:center; gap:10px; }
.dsho-head,.dsho-account,.dsho-actions { justify-content:space-between; flex-wrap:wrap; }
.dsho-head>div,.dsho-account>div { min-width:0; }
.dsho-head p { margin-top:4px; }
.dsho-nav { width:min(100%,440px); box-sizing:border-box; }
.dsho-filters { display:flex; flex-wrap:wrap; gap:4px; }
.dsho-filters [aria-pressed="true"] { background:var(--dsho-soft); box-shadow:0 0 0 1px var(--dsho-edge); font-weight:650; }
.dsho-panel,.dsho-form,.dsho-channels { display:grid; grid-template-columns:minmax(0,1fr); gap:12px; min-width:0; }
.dsho-card { border:1px solid var(--dsho-edge); border-radius:12px; padding:14px; min-width:0; }
.dsho-card > .dsho-muted { margin-top:3px; }
.dsho-identity { display:flex; gap:10px; align-items:center; }
.dsho-identity p { margin-top:2px; }
.dsho-emblem { display:grid; place-items:center; width:38px; height:38px; flex:none; border-radius:11px; background:var(--dsho-row); }
.dsho-badge { display:inline-flex; flex:none; align-items:center; gap:5px; padding:3px 8px; border-radius:20px; background:var(--dsho-row); color:var(--dsho-muted); font-size:11px; white-space:nowrap; }
.dsho-badge::before { content:''; background:currentColor; width:6px; height:6px; border-radius:50%; }
.dsho-good { color:var(--dsw-alias-text-success,#27764f); }
.dsho-busy { color:var(--dsw-alias-text-warning,#a05a15); }
.dsho-fault { color:var(--dsw-alias-text-error,#b13c39); }
.dsho-details { margin-top:12px; border-top:1px solid var(--dsho-edge); padding-top:10px; }
.dsho-details summary { cursor:pointer; font-size:12px; font-weight:600; }
.dsho-facts { margin:8px 0 0; display:grid; gap:0; font-size:12px; }
.dsho-facts div { display:grid; grid-template-columns:minmax(80px,1fr) minmax(0,2fr); gap:8px; padding:5px 0; }
.dsho-facts dt { color:var(--dsho-muted); }
.dsho-facts dd { margin:0; overflow-wrap:anywhere; }
.dsho-counts { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
.dsho-counts span { border-radius:7px; background:var(--dsho-row); padding:4px 7px; font-size:12px; }
.dsho-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr)); gap:12px; margin-top:12px; }
.dsho-field { display:grid; gap:5px; min-width:0; align-content:start; }
.dsho-field label { font-size:13px; font-weight:570; }
.dsho-field > input,.dsho-field textarea,.dsho-field select { width:100%; min-width:0; box-sizing:border-box; border:1px solid var(--dsho-edge); border-radius:8px; background:var(--dsho-soft); color:inherit; font:inherit; padding:7px 9px; }
.dsho-field textarea { resize:vertical; }
.dsho-field select { min-height:34px; max-width:100%; text-overflow:ellipsis; }
.dsho-tools { align-items:stretch; flex-wrap:wrap; }
.dsho-search { min-width:0; flex:1 1 150px; }
.dsho-search input { width:100%; min-width:0; }
.dsho-filters { align-items:center; }
.dsho-list { display:grid; gap:2px; list-style:none; padding:0; margin:0; }
.dsho-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:9px; align-items:center; padding:8px; width:100%; box-sizing:border-box; text-align:left; border:0; border-radius:8px; background:none; color:inherit; font:inherit; cursor:pointer; }
.dsho-row:not(:disabled):hover,.dsho-row[aria-current="true"] { background:var(--dsho-row); }
.dsho-row:disabled { opacity:.6; cursor:wait; }
.dsho-row .dsho-title,.dsho-row .dsho-muted { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsho-row .dsho-title { font-size:13px; font-weight:570; }
.dsho-row .dsho-muted { font-size:11px; }
.dsho-row .dsho-badge { padding:2px 6px; }
.dsho-row-icon { display:grid; place-items:center; width:28px; height:28px; border-radius:8px; background:var(--dsho-row); }
.dsho-account-roster { display:grid; gap:12px; }
.dsho-account-roster-header,.dsho-account-line,.dsho-account-controls {
  display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0;
}
.dsho-account-roster-header,.dsho-account-line { justify-content:space-between; }
.dsho-account-items { display:grid; gap:6px; margin:0; padding:0; list-style:none; }
.dsho-account-line { padding:10px 12px; border-radius:9px; background:var(--dsho-row); }
.dsho-account-name { min-width:0; overflow-wrap:anywhere; }
.dsho-account-name small { display:block; }
.dsho-account-controls { justify-content:flex-end; }
.dsho-account-modal { width:min(760px,calc(100vw - 32px))!important; padding:20px!important; }
.dsho-account-modal-top { display:flex; justify-content:flex-end; margin-bottom:-8px; }
.dsho-editor-actions { justify-content:flex-end; }
.dsho-danger-action { color:var(--dsw-alias-text-error,#b13c39); }
.dsho-empty { border:1px dashed var(--dsho-edge); border-radius:10px; padding:15px; text-align:center; }
.dsho-empty p { margin-top:4px; }
.dsho-alert { padding:9px 10px; border-radius:8px; background:var(--dsho-row); margin:0; font-size:12px; line-height:1.55; }
.dsho-savebar { position:sticky; z-index:1; bottom:0; padding:8px 0; background:#fff; border-top:1px solid var(--dsho-edge); }
[data-ds-dark-theme] .dsho-savebar { background:#1e1f22; }
[data-octo-rail].dsho-channels {
  display:flex!important; flex-direction:column!important; justify-content:flex-start!important;
  align-content:flex-start!important; align-items:stretch!important;
  flex:1 1 auto; min-height:0; max-height:100%;
  box-sizing:border-box; gap:8px!important; padding:10px 12px;
  overflow-y:auto; overscroll-behavior-y:contain;
}
.dsho-rail > * { flex:none!important; margin-block:0!important; }
.dsho-rail .dsho-tools { gap:6px; }
.dsho-rail .dsho-search { flex-basis:100%; }
.dsho-rail .dsho-row { padding-inline:4px; }
.dsho-modal { width:min(520px,calc(100vw - 32px)); max-height:calc(100vh - 48px); box-sizing:border-box; border:1px solid var(--dsho-edge); border-radius:16px; background:var(--dsho-soft); padding:18px; }
.dsho-modal::backdrop { background:rgba(0,0,0,.3); }
.dsho-modal > header { margin-bottom:14px; }
.dsho-root :focus-visible,.dsho-rail :focus-visible,.dsho-modal :focus-visible { outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,#3471d4); outline-offset:2px; }
`
    const listeners = new Set()
    let snapshot = {}
    let hasNativeTab = false
    let revisionEpoch = 0
    let refresh = () => {}
    const read = () => snapshot
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }
    const notify = () => { for (const fn of listeners) fn() }
    const publish = data => { snapshot = { accountUiVersion: snapshot.accountUiVersion, ...data }; notify() }
    const tFor = locale => key => words[key]?.[locale === 'zh' || locale?.startsWith?.('zh-') ? 0 : 1] ?? ''
    const channelNames = { 1: 'dm', 2: 'group', 5: 'topic' }
    const connectionTone = {
      online: 'good', connecting: 'busy', reconnecting: 'busy',
      worker_stopped: 'fault', invalid_configuration: 'fault', configuration_or_state_error: 'fault',
    }
    const jobTone = { sent: 'good', review: 'fault', running: 'busy', sending: 'busy' }
    const processingStates = ['queued', 'running', 'ready', 'sending', 'sent', 'review', 'ignored']
    const replaceSnapshot = data => { revisionEpoch++; publish(data) }

    async function api(suffix = '', options = {}) {
      const res = await fetch(new URL(path + suffix, document.baseURI),
        { ...options, credentials: 'same-origin', cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data || typeof data !== 'object') {
        throw new Error(data?.error ?? (res.status === 401 ? 'authentication_required' : 'unavailable'))
      }
      return data
    }
    function mark() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M13.5 7.4c0 2.5-2.4 4.5-5.5 4.5-.5 0-1-.1-1.4-.2l-2.7 1 .4-2.1A4.3 4.3 0 0 1 2.5 7.4C2.5 4.9 5 3 8 3s5.5 1.9 5.5 4.4Z',
          stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }),
        h('path', { d: 'M5.4 7.5h.1m2.4 0H8m2.4 0h.1', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round' }))
    }
    const badge = (label, tone) => h('span', { className: 'dsho-badge' + (tone ? ' dsho-' + tone : '') }, label)
    const hint = text => h('p', { className: 'dsho-muted' }, text)
    const shortId = value => typeof value === 'string' && value.length > 9 ? '…' + value.slice(-7) : value

    function apply(ctx) {
      const locale = () => ctx.locale.getSnapshot().active
      const subscribeLocale = fn => ctx.locale.subscribe(fn)
      const useT = () => tFor(useSyncExternalStore(subscribeLocale, locale))
      const sessionSnapshot = () => ctx.sessions.list.getSnapshot()
      const subscribeSessions = fn => ctx.sessions.list.subscribe(fn)
      const activeStatus = (data, t) => badge(t(data.status) || t('loading'), connectionTone[data.status])
      async function openSession(id) {
        if (!sessionSnapshot().byId[id]) await ctx.sessions.refresh()
        ctx.uiWorkspace.openSession(id)
      }
      const issueLabel = (issue, t) => typeof issue !== 'string' ? '' : t(issue)
        || (issue.startsWith('rules_') ? t('rulesIssue') : issue.startsWith('access_') ? t('accessIssue') : t('unknownIssue'))

      function Empty({ title, note }) {
        return h('div', { className: 'dsho-empty' }, h('strong', null, title), hint(note))
      }
      function ErrorNotice({ message, action, t }) {
        return h('div', { className: 'dsho-actions dsho-alert', role: 'alert' },
          h('span', null, message), action && h(Button, { size: 'sm', variant: 'outline', onClick: action }, t('retry')))
      }
      function ChannelRow({ row, kind, title, detail, issue, current, open, busy, t, renderSlot, pinned }) {
        const menuState = useState(false)
        const [menuOpen, setMenuOpen] = menuState
        const point = useRef(null)
        const more = useRef(null)
        const showContext = event => {
          event.preventDefault()
          event.stopPropagation()
          point.current = event.clientX || event.clientY ? new DOMRect(event.clientX, event.clientY, 0, 0) : null
          setMenuOpen(true)
        }
        let nativeMenu
        if (menuOpen && renderSlot) {
          try {
            nativeMenu = renderSlot('sidebar.workspaces.session.menu.item',
              { sessionId: row.id, displayTitle: title }, { hookContext: menuState })
          } catch { /* a different host may not expose the workspace seats here */ }
        }
        const items = nativeMenu ? [] : [
          { id: 'open', label: t('openConversation') }, { id: 'id', label: t('copyConversationId') },
        ]
        return h('li', { className: 'dsho-session-line', onContextMenu: showContext },
          h('button', { type: 'button', className: 'dsho-row', disabled: busy, title,
            'aria-current': current ? 'true' : undefined,
            'aria-label': kind + ' · ' + title + (issue ? ' · ' + issue : ''),
            onClick: open, onKeyDown: event => {
              if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showContext(event)
            } },
          h('span', { className: 'dsho-row-icon', ...(pinned && { 'data-octo-pinned': true, title: t('pinned') }) },
            pinned && IconPinFillRegular ? h(IconPinFillRegular) : mark()),
          h('span', null, h('span', { className: 'dsho-title' }, title), h('span', { className: 'dsho-muted' }, detail)),
          badge(t(row.state) || t('established'), jobTone[row.state])),
          h(Menu, { open: menuOpen, portal: true, autoFocus: true, align: 'end',
            getAnchorRect: () => point.current ?? more.current?.getBoundingClientRect() ?? null,
            items, onClose: () => setMenuOpen(false), onSelect: id => {
              setMenuOpen(false)
              if (id === 'open') void open()
              else if (id === 'id') void navigator.clipboard?.writeText(row.id).catch(() => {})
            },
            anchor: h('button', { ref: more, type: 'button', className: 'dsho-session-menu-trigger',
              'aria-label': t('sessionActions') + ' · ' + title, 'aria-haspopup': 'menu', 'aria-expanded': menuOpen,
              onClick: () => { point.current = null; setMenuOpen(!menuOpen) } },
            IconEllipsisOutlineRegular ? h(IconEllipsisOutlineRegular) : '⋯') }, nativeMenu))
      }

      function ChannelList({ close, rail = false, renderSlot }) {
        const t = useT()
        const data = useSyncExternalStore(subscribe, read)
        const sessions = useSyncExternalStore(subscribeSessions, sessionSnapshot)
        const workspaceList = ctx.get?.('workspaces')?.list ?? ctx.workspaces?.list
        const workspaces = useSyncExternalStore(fn => workspaceList?.subscribe(fn) ?? (() => {}),
          () => workspaceList?.getSnapshot() ?? null)
        const archived = new Set(workspaces?.archivedSessionIds ?? [])
        const pins = new Map((workspaces?.pinnedSessionIds ?? []).map((id, index) => [id, index]))
        const [filter, setFilter] = useState('all')
        const [query, setQuery] = useState('')
        const [opening, setOpening] = useState('')
        const [failed, setFailed] = useState(false)
        const entries = (data.conversations ?? []).filter(row => !archived.has(row.id))
          .sort((a, b) => (pins.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pins.get(b.id) ?? Number.MAX_SAFE_INTEGER))
          .map(row => {
          const rawTitle = sessions.byId[row.id]?.title
          const title = typeof rawTitle === 'string' && !rawTitle.includes('\uFFFD') ? rawTitle.trim() : ''
          const kind = t(channelNames[row.type]) || t('sessions')
          return { row, kind, title: title || shortId(row.address) }
        })
        const term = query.trim().toLocaleLowerCase()
        const visible = entries.filter(({ row, title, kind }) =>
          (filter === 'all' || String(row.type) === filter)
          && (!term || [title, kind, row.address, row.accountLabel].some(value => String(value ?? '').toLocaleLowerCase().includes(term))))
        return h('section', { className: 'dsho-channels' + (rail ? ' dsho-rail' : ''), 'aria-label': t('sessions'),
          ...(rail && { 'data-octo-rail': true }) },
          rail && h('div', { className: 'dsho-head' }, h('h3', null, 'Octo'), activeStatus(data, t)),
          data.error && h(ErrorNotice, { t, action: refresh, message: t(data.error) || t('unavailable') }),
          h('div', { className: 'dsho-tools' },
            h(Input, { className: 'dsho-search', type: 'search', value: query, 'aria-label': t('search'),
              placeholder: t('search'), onChange: e => setQuery(e.target.value) }),
            h('div', { className: 'dsho-filters', role: 'group', 'aria-label': t('filter') },
              ...[['all', 'all'], ['1', 'dm'], ['2', 'group'], ['5', 'topic']].map(([id, label]) =>
                h(Button, { key: id, size: 'sm', 'aria-pressed': filter === id, onClick: () => setFilter(id) }, t(label))))),
          failed && h(ErrorNotice, { t, message: t('openError') }),
          !data.status && !data.error && hint(t('loading')),
          visible.length ? h('ul', { className: 'dsho-list' }, ...visible.map(({ row, kind, title }) => {
            const issue = row.state === 'review' && issueLabel(row.issue, t)
            const detail = [kind, data.accounts?.length > 1 && row.accountLabel, row.scope && t('inherited'),
              row.historical && t('previousSession'), issue].filter(Boolean).join(' · ')
            return h(ChannelRow, { key: row.id, row, kind, title, detail, issue, t, renderSlot,
              current: sessions.byId[row.id]?.retainedBy?.mainView, pinned: pins.has(row.id),
              busy: !!opening,
              open: async () => {
                setFailed(false); setOpening(row.id)
                try { await openSession(row.id); close?.() } catch { setFailed(true) }
                finally { setOpening('') }
              } })
          })) : data.status && h(Empty, { title: t(entries.length ? 'noResults' : 'empty'),
            note: t(entries.length ? 'noResultsNote' : 'emptyNote') }))
      }

      let accountModule, accountUiVersion
      function Account({ data, current, choose, t }) {
        const [View, setView] = useState(null)
        const [failed, setFailed] = useState(false)
        const load = () => {
          const url = new URL(path + '/account-view.js', document.baseURI)
          if (data.accountUiVersion) url.searchParams.set('v', data.accountUiVersion)
          if (accountUiVersion !== url.href) { accountUiVersion = url.href; accountModule = undefined }
          accountModule ??= import(url.href)
            .then(module => module.createAccountView(React, primitives, {
              request: api, label: (key, lang) => tFor(lang)(key),
              status: (key, lang) => activeStatus({ status: key }, tFor(lang)),
            }))
          return accountModule
        }
        useEffect(() => {
          let cancelled = false
          setFailed(false)
          load().then(view => { if (!cancelled) setView(() => view) })
            .catch(() => { if (!cancelled) setFailed(true) })
          return () => { cancelled = true }
        }, [data.accountUiVersion])
        return failed ? h(ErrorNotice, { t, message: t('unavailable') })
          : View ? h(View, { data, current, choose, lang: locale()?.startsWith?.('zh') ? 'zh' : 'en',
            publish: replaceSnapshot, refresh }) : hint(t('loading'))
      }

      const choices = {
        channelPolicy: ['routes', [['joined', 'routesAuto'], ['allowlist', 'routesList']]],
        mentionPolicy: ['mention', [['required', 'requireMention'], ['octo', 'followMention']]],
        threadRuleMode: ['threadRule', [['thread-only', 'threadOnly'], ['inherit-group', 'threadInherit']]],
        progress: ['progress', [['auto', 'card'], ['typing', 'typing'], ['off', 'off']]],
      }
      const listKeys = ['allowedGroupIds', 'allowedThreadIds']
      function initialDraft(config) {
        return { ...Object.fromEntries(Object.keys(choices).map(key => [key, config[key]])),
          ...Object.fromEntries(listKeys.map(key => [key, config[key].join('\n')])), timeout: config.timeoutMs / 1000 }
      }
      function Config({ config, revision, accountId, t }) {
        const [draft, setDraft] = useState(() => initialDraft(config))
        const [feedback, setFeedback] = useState(null)
        const [saving, setSaving] = useState(false)
        const [dirty, setDirty] = useState(false)
        const base = useRef(revision)
        useEffect(() => {
          if (!dirty && base.current !== revision) { base.current = revision; setDraft(initialDraft(config)) }
        }, [config, revision, dirty])
        const set = (key, value) => { setDraft(prev => ({ ...prev, [key]: value })); setDirty(true); setFeedback(null) }
        const reset = () => { base.current = revision; setDraft(initialDraft(config)); setDirty(false); setFeedback(['status', 'resetDone']) }
        const field = (key, label, element, note) => h('div', { className: 'dsho-field', key },
          h('label', { htmlFor: 'dsho-' + key }, t(label)), element, note && hint(t(note)))
        const select = (key, note) => {
          const [label, options] = choices[key]
          return field(key, label, h('select', { id: 'dsho-' + key, value: draft[key], onChange: e => set(key, e.target.value) },
            ...options.map(([value, caption]) => h('option', { key: value, value,
              disabled: key === 'mentionPolicy' && value === 'octo' && config.transport !== 'websocket' }, t(caption)))), note)
        }
        const multi = (key, label, note) => field(key, label, h('textarea', { id: 'dsho-' + key, rows: 2,
          value: draft[key], placeholder: t('onePerLine'), onChange: e => set(key, e.target.value) }), note)
        const card = (title, note, ...fields) => h('section', { className: 'dsho-card' },
          h('h3', null, t(title)), hint(t(note)), h('div', { className: 'dsho-grid' }, ...fields))
        const save = async e => {
          e.preventDefault()
          setSaving(true); setFeedback(null); revisionEpoch++
          try {
            const settings = Object.fromEntries(Object.keys(choices).map(k => [k, draft[k]]))
            for (const key of listKeys) {
              const inactive = draft.channelPolicy === 'joined'
              settings[key] = inactive ? [] : [...new Set(draft[key].split('\n').map(x => x.trim()).filter(Boolean))]
            }
            settings.timeoutMs = Math.round(Number(draft.timeout) * 1000)
            const next = await api(accountId ? '/accounts/' + accountId + '/settings' : '/settings', { method: 'PUT', headers: {
              'Content-Type': 'application/json', 'x-dsh-octo-client': '1',
            }, body: JSON.stringify({ settings, revision: base.current }) })
            revisionEpoch++
            base.current = next.revision; setDraft(initialDraft(next.config)); setDirty(false)
            publish(next.overview ?? { ...snapshot, ...next }); setFeedback(['status', 'saved'])
          } catch (error) {
            setFeedback(['alert', t(error.message) ? error.message : 'saveError'])
            if (error.message === 'settings_changed') refresh()
          } finally { setSaving(false) }
        }
        const stale = dirty && base.current !== revision
        return h('form', { className: 'dsho-form', onSubmit: save, 'aria-label': t('rules') },
          card('permission', 'permissionHint', select('channelPolicy'),
            draft.channelPolicy === 'allowlist' && multi('allowedGroupIds', 'groups'),
            draft.channelPolicy === 'allowlist' && multi('allowedThreadIds', 'threads', 'threadFormat')),
          card('triggers', 'triggersHint', select('mentionPolicy', config.transport !== 'websocket' && 'requiresWebSocket'),
            select('threadRuleMode')),
          card('response', 'responseHint', select('progress', draft.progress === 'auto' && 'cardHint'),
            field('timeout', 'timeout', h('input', { id: 'dsho-timeout', type: 'number', min: 1, max: 600, step: 0.001,
              required: true, value: draft.timeout, onChange: e => set('timeout', e.target.value) }))),
          (feedback || stale) && h('p', { className: 'dsho-alert', role: stale ? 'alert' : feedback[0] },
            t(stale ? 'settings_changed' : feedback[1])),
          h('div', { className: 'dsho-actions dsho-savebar' },
            h('div', { className: 'dsho-tools' },
              h(Button, { type: 'submit', variant: 'primary', disabled: saving || stale || !dirty }, t(saving ? 'saving' : 'save')),
              h(Button, { type: 'button', variant: 'outline', disabled: saving || !dirty, onClick: reset }, t('reset'))),
            dirty && !feedback && hint(t('unsaved'))))
      }
      function Settings({ close }) {
        const t = useT()
        const data = useSyncExternalStore(subscribe, read)
        const [page, setPage] = useState('account')
        const [selected, setSelected] = useState('')
        const accounts = data.accounts ?? []
        const current = accounts.find(account => account.id === selected) ?? accounts[0]
        const sections = ['account', 'rules', 'sessions']
        const panel = (key, content) => h('div', { id: 'dsho-panel-' + key, role: 'tabpanel',
          'aria-labelledby': 'dsho-tab-' + key, hidden: page !== key, key }, content)
        return h('div', { className: 'dsho-root', 'data-octo-settings': true },
          h('header', { className: 'dsho-head' }, h('div', null, h('h2', null, t('settings')), hint(t('subtitle'))),
            activeStatus(current ?? data, t)),
          h(SegmentedTabs, { className: 'dsho-nav', label: t('nav'), value: page, onChange: setPage,
            items: sections.map(key => ({ value: key, label: t(key), id: 'dsho-tab-' + key, panelId: 'dsho-panel-' + key })) }),
          data.error && page !== 'sessions' && h(ErrorNotice, { t, action: refresh, message: t(data.error) || t('unavailable') }),
          panel('account', h(Account, { data, t, current, choose: setSelected })),
          panel('rules',
            h('div', { className: 'dsho-panel' },
              accounts.length > 1 && h('div', { className: 'dsho-field' },
                h('label', { htmlFor: 'dsho-select-account' }, t('selectedBot')),
                h('select', { id: 'dsho-select-account', value: current?.id ?? '', onChange: e => setSelected(e.target.value) },
                  ...accounts.map(account => h('option', { key: account.id, value: account.id }, account.label)))),
              current?.config ? h(Config, { key: current.id, config: current.config, revision: current.revision, accountId: current.id, t })
                : h(Empty, { title: t('notConfigured'), note: t('deployHint') }))),
          panel('sessions', page === 'sessions' && h(ChannelList, { close })))
      }
      function ChannelShortcut({ wide }) {
        const t = useT()
        const native = useSyncExternalStore(subscribe, () => hasNativeTab)
        const dialog = useRef(null)
        const [active, setActive] = useState(false)
        useEffect(() => {
          if (active && dialog.current && !dialog.current.open) dialog.current.showModal()
        }, [active])
        if (native && !active) return null
        return h('div', null,
          !native && h(Button, { size: 'sm', icon: mark(), onClick: () => setActive(true), title: t('shortcut'),
            'aria-label': t('shortcut'), 'data-octo-shortcut': true }, wide === false ? null : t('shortcut')),
          active && h('dialog', { className: 'dsho-modal', ref: dialog, onClose: () => setActive(false), 'aria-label': t('shortcut') },
            h('header', { className: 'dsho-head' }, h('h2', null, t('shortcut')),
              h(Button, { size: 'sm', onClick: () => dialog.current.close() }, t('close'))),
            h(ChannelList, { close: () => dialog.current.close() })))
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-channel-octo', order: 41, label: () => tFor(locale())('settings'),
      }, Settings))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: 'dsh-channel-octo',
      }, mark))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'dsh-channel-octo-shortcut', order: 45,
      }, ChannelShortcut))
      ctx.effect(() => {
        const stylesheet = document.createElement('style')
        stylesheet.textContent = style
        document.head.appendChild(stylesheet)
        const controller = new AbortController()
        let timer, flight, registry, remove
        const sync = () => {
          const readSlots = ctx.slots.entriesOfSlot ?? ctx.slots.entries
          const next = readSlots?.call(ctx.slots, 'sidebar.workspaces')
            ?.find(entry => entry?.component?.__dshNativeTabs?.version === 1)?.component?.__dshNativeTabs
          if (next === registry) return
          remove?.()
          registry = next
          remove = registry?.insert?.({ id: 'octo', label: 'Octo', order: 25,
            matchSession: id => snapshot.conversations?.some(row => row.id === id) ?? false,
            render: props => h(ChannelList, { rail: true, renderSlot: props?.renderSlot }) })
          hasNativeTab = typeof remove === 'function'
          notify()
        }
        const poll = () => {
          if (flight || controller.signal.aborted) return flight
          clearTimeout(timer)
          const epoch = revisionEpoch
          flight = (async () => {
            if (document.visibilityState === 'hidden') return
            try {
              const next = await api('', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) })
              if (!controller.signal.aborted && epoch === revisionEpoch) publish(next)
            } catch (error) {
              if (!controller.signal.aborted && epoch === revisionEpoch) {
                const denied = error.message === 'authentication_required'
                publish({ ...(denied ? {} : snapshot), error: denied ? error.message : 'unavailable' })
              }
            }
          })().finally(() => {
            flight = null
            if (!controller.signal.aborted) timer = setTimeout(poll, 4000)
          })
          return flight
        }
        refresh = poll
        sync()
        let probes = 0
        const interval = setInterval(() => { sync(); if (++probes >= 20) clearInterval(interval) }, 250)
        window.addEventListener('dsh-native-sidebar-change', sync)
        document.addEventListener('visibilitychange', poll)
        void poll()
        return () => {
          controller.abort(); clearTimeout(timer); clearInterval(interval); remove?.(); stylesheet.remove()
          window.removeEventListener('dsh-native-sidebar-change', sync)
          document.removeEventListener('visibilitychange', poll)
          refresh = () => {}; hasNativeTab = false; publish({})
        }
      }, 'Octo channel workspace')
    }
    return { apply, inject: ['slots', 'sessions', 'uiWorkspace', 'locale'] }
  },
})
