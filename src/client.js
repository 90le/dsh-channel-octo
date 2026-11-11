// Browser half: use the host's locale, controls, settings and session navigation.
window.__ModuleLoader__.load({
  id: 'dsh-channel-octo',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    const { Button, Input, SegmentedTabs, Menu, IconEllipsisOutlineRegular, IconPinFillRegular, MenuItemButton } = primitives
    const path = 'api/dsh-channel-octo'
    const words = {
      settings: ['Octo 渠道', 'Octo channel'], shortcut: ['Octo 频道', 'Octo conversations'],
      subtitle: ['管理 Octo 机器人、消息规则和会话。', 'Manage your Octo bot, message rules and conversations.'],
      account: ['Bot 账号', 'Bot account'], rules: ['消息规则', 'Message rules'], cli: ['Octo CLI', 'Octo CLI'], sessions: ['频道会话', 'Conversations'],
      conversationType: ['会话类型', 'Conversation type'], assistants: ['助理', 'Assistants'],
      railNav: ['侧栏', 'Sidebar'], tasks: ['任务', 'Tasks'], openChannel: ['打开频道', 'Open channel'], mainArea: ['主区', 'Main area'],
      ungroupedTopics: ['未归组子区', 'Ungrouped topics'], advanced: ['高级设置', 'Advanced settings'],
      copyOctoId: ['复制 Octo 会话 ID', 'Copy Octo conversation ID'], waiting: ['等待回答', 'Waiting for an answer'],
      nav: ['Octo 设置分类', 'Octo settings sections'], close: ['关闭', 'Close'],
      selectedBot: ['选择账号', 'Choose account'], previousSession: ['历史会话', 'Past conversation'],
      loading: ['正在加载 Octo…', 'Loading Octo…'], retry: ['重新加载', 'Reload'],
      online: ['已连接', 'Connected'], connecting: ['正在连接', 'Connecting'],
      reconnecting: ['正在重连', 'Reconnecting'], disconnecting: ['正在停止接收', 'Stopping'], disabled: ['已暂停接收', 'Receiving paused'],
      waiting_credentials: ['等待凭据就绪', 'Waiting for credentials'],
      invalid_configuration: ['连接配置有误', 'Invalid connection settings'],
      configuration_or_state_error: ['无法读取渠道设置', 'Channel settings are unavailable'],
      worker_stopped: ['连接已停止', 'Connection stopped'],
      queued: ['待处理', 'Queued'], running: ['生成中', 'Working'], ready: ['待发送', 'Ready to send'],
      sending: ['发送中', 'Sending'], sent: ['已回复', 'Replied'], stopped: ['已停止', 'Stopped'], review: ['待检查', 'Needs review'],
      established: ['已建立', 'Available'], ignored: ['未触发', 'Not triggered'],
      notConfigured: ['尚未绑定 Octo Bot', 'No Octo bot is connected'],
      deployHint: ['请在 DSH 服务器中完成初始绑定。启用后，这里会显示连接状态和渠道设置。',
        'Complete the initial binding on the DSH server. Connection status and channel settings will appear here.'],
      serverManaged: ['服务器管理连接凭据', 'Connection credentials are managed on the server'],
      details: ['连接详情', 'Connection details'], botId: ['Bot ID', 'Bot ID'], space: ['空间 ID', 'Space ID'],
      endpoint: ['Octo 服务地址', 'Octo server'], directory: ['DSH 工作目录', 'DSH workspace'],
      serverTitle: ['Octo 服务端', 'Octo server'],
      serverHint: ['默认使用正式 Octo。使用自建服务时填写其 HTTPS API 地址。', 'Uses official Octo by default. Enter the HTTPS API address for a self-hosted server.'],
      serverIsolation: ['不同服务端的 Bot、令牌和会话分别保存。切换后需要在对应服务端添加 Bot，切回时可恢复原账号。', 'Bots, credentials and conversations are kept separate for each server. Add bots for the selected server; switching back restores the previous accounts.'],
      serverPending: ['地址已保存，重启 DSH Web 后生效。当前连接在重启前不变。', 'Saved. Restart DSH Web to activate the new address; current connections remain until restart.'],
      serverCurrent: ['当前使用', 'Currently using'], serverSave: ['保存服务地址', 'Save server address'],
      serverSavedCurrent: ['服务地址已保存。', 'Server address saved.'],
      invalid_server: ['请输入有效的 HTTPS 服务地址，不要包含用户名、密码、查询或片段。', 'Enter a valid HTTPS address without credentials, query or fragment.'],
      account_changed: ['设置已在别处更新，请刷新后重试。', 'Settings changed elsewhere. Refresh and try again.'],
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
      appScope: ['Octo 管理的私聊范围', 'Octo-managed DM scope'],
      threadRule: ['子区规则', 'Topic rules'], threadOnly: ['只用子区规则', 'Use only topic rules'],
      threadInherit: ['继承群规则，子区优先', 'Inherit group rules; topic rules take priority'],
      response: ['回复体验', 'Replies'], responseHint: ['设置并行会话、回复进度和执行时限。', 'Set conversation concurrency, progress and reply timeout.'],
      concurrentTurns: ['并行会话数', 'Concurrent conversations'],
      concurrentTurnsHint: ['不同私聊、群聊和子区可同时处理。同一会话一次处理一项任务。', 'Direct chats, groups and topics can run in parallel. Each conversation runs one task at a time.'],
      invalid_concurrent_turns: ['并行会话数须为 1 至 8。', 'Choose between 1 and 8 concurrent conversations.'],
      progress: ['进度显示', 'Reply progress'], card: ['优先使用 Octo 进度卡', 'Prefer Octo progress cards'],
      typing: ['仅显示正在输入', 'Typing indicator only'], off: ['关闭进度', 'Turn off progress'],
      cardHint: ['卡片不可用时自动显示「正在输入」。', 'Falls back to a typing indicator when cards are unavailable.'],
      timeout: ['回复时限', 'Reply timeout'],
      timeoutDuration: ['时长', 'Duration'], timeoutUnit: ['单位', 'Unit'],
      seconds: ['秒', 'Seconds'], minutes: ['分钟', 'Minutes'], hours: ['小时', 'Hours'], days: ['天', 'Days'],
      unlimited: ['不限时', 'Unlimited'],
      timeoutHint: ['等待用户回答或批准的时间不计入时限。', 'Time spent waiting for an answer or approval does not count.'],
      invalidTimeout: ['请输入有效时长，至少 1 秒；或选择不限时。', 'Enter a valid duration of at least one second, or choose Unlimited.'],
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
      background_reply_pending: ['子任务已回传，等待继续处理', 'Background results are waiting to be processed'],
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
.dsho-advanced > summary { cursor:pointer; font-weight:560; margin-block:8px; }
[data-dsho-hidden-task-workspace] { display:none!important; }
.dsho-native-tabs { margin:8px 12px; }
.dsho-bot-filter { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:2px 16px 0; min-height:30px; font-size:12px; }
.dsho-filter-context { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; opacity:.65; }
.dsho-filter-menu { position:relative; flex:none; }
.dsho-filter-menu > summary { display:flex; align-items:center; gap:5px; list-style:none; border-radius:7px; padding:5px 8px; cursor:pointer; user-select:none; }
.dsho-filter-menu > summary::-webkit-details-marker { display:none; }
.dsho-filter-menu > summary:hover,.dsho-filter-menu[open] > summary { background:color-mix(in srgb,currentColor 7%,transparent); }
.dsho-filter-menu > summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4b7cff); }
.dsho-filter-dot { width:5px; height:5px; border-radius:50%; background:var(--dsw-alias-brand-primary,#4b7cff); }
.dsho-filter-popover { position:absolute; inset-inline-end:0; top:calc(100% + 6px); z-index:40; width:220px; max-width:calc(100vw - 40px);
  box-sizing:border-box; display:grid; gap:12px; padding:14px; border:1px solid color-mix(in srgb,currentColor 13%,transparent);
  background:var(--dsw-alias-bg-layer-1,Canvas); color:inherit; box-shadow:0 8px 24px #0002; border-radius:12px; }
.dsho-filter-popover label { display:grid; gap:6px; font-weight:550; }
.dsho-filter-popover select { width:100%; box-sizing:border-box; min-height:34px; padding:6px 8px; border:1px solid color-mix(in srgb,currentColor 15%,transparent);
  border-radius:7px; background:transparent; color:inherit; font:inherit; font-weight:400; }
.dsho-filter-popover button { border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; padding:4px; text-align:start; }

.dsho-native-state { max-width:100px; color:var(--dsw-alias-label-secondary,currentColor); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
.dsho-timeout { min-inline-size:0; border:0; margin:0; padding:0; }
.dsho-timeout legend { font-size:13px; font-weight:570; padding:0; margin-bottom:5px; }
.dsho-timeout-controls { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:5px; }
.dsho-timeout-controls > .dsho-field { flex:1 1 88px; }
.dsho-tools { align-items:stretch; flex-wrap:wrap; }
.dsho-search { min-width:0; flex:1 1 150px; }
.dsho-search input { width:100%; min-width:0; }
.dsho-filters { align-items:center; }
.dsho-route-folder { padding-inline-start:8px; }
.dsho-route-folder > summary { cursor:pointer; padding-block:5px; }
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
    const publish = data => {
      const next = { accountUiVersion: snapshot.accountUiVersion, ...data }
      // Share unchanged fields so status polling does not rebuild every conversation tree.
      let changed = Object.keys(snapshot).length !== Object.keys(next).length
      for (const key of Object.keys(next)) {
        if (Object.hasOwn(snapshot, key) && JSON.stringify(snapshot[key]) === JSON.stringify(next[key])) next[key] = snapshot[key]
        else changed = true
      }
      if (!changed) return
      snapshot = next
      notify()
    }
    const tFor = locale => key => words[key]?.[locale === 'zh' || locale?.startsWith?.('zh-') ? 0 : 1] ?? ''
    const channelNames = { 1: 'dm', 2: 'group', 5: 'topic' }
    const connectionTone = {
      online: 'good', connecting: 'busy', reconnecting: 'busy', waiting_credentials: 'busy',
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

    const folderPrefix = 'dsh-octo:'
    function routeParts(row, multi, t) {
      const bot = multi ? [{ key: 'bot:' + row.accountId, label: row.accountLabel || 'Bot' }] : []
      if (row.type === 1) return [...bot, { key: 'dm', label: t('dm') }]
      const groups = [...bot, { key: 'groups', label: t('group') }]
      if (!row.group) return [...groups, { key: 'unknown', label: t('ungroupedTopics') }]
      return [...groups, { key: 'group:' + row.group, label: row.groupName || t('group') + ' ' + shortId(row.group) },
        row.type === 5 ? { key: 'topic:' + row.address, label: row.name || t('topic') + ' ' + shortId(row.address) }
          : { key: 'main', label: t('mainArea') }]
    }
    function octoFolders(rows, sessions, multi, t, archivedOnly, archivedIds) {
      const result = new Map(), archived = new Set(archivedIds)
      for (const row of rows) {
        if (!sessions.byId[row.id] || (archivedOnly && !archived.has(row.id))) continue
        const parts = routeParts(row, multi, t), keys = [], labels = []
        const updated = Number(row.updatedAt || sessions.byId[row.id].updatedAt)
        for (const [index, part] of parts.entries()) {
          keys.push(encodeURIComponent(part.key)); labels.push(part.label)
          const leaf = index === parts.length - 1
          if (archivedOnly && !leaf) continue
          const path = 'octo-channel:/' + keys.join('/')
          const id = folderPrefix + keys.join('/')
          if (!result.has(id)) result.set(id, { workspaceId: id, id, path,
            title: archivedOnly ? labels.join(' / ') : part.label,
            createdAt: Number.isFinite(updated) && updated > 0 ? new Date(updated).toISOString() : '', sessionIds: [] })
          if (leaf) result.get(id).sessionIds.push(row.id)
        }
      }
      const folders = [...result.values()]
      for (const main of result.values()) {
        if (!main.path.endsWith('/main')) continue
        const prefix = main.path.slice(0, -4) + 'topic%3A'
        const before = folders.findIndex(folder => folder.path.startsWith(prefix))
        const current = folders.indexOf(main)
        if (before >= 0 && before < current) {
          folders.splice(current, 1)
          folders.splice(before, 0, main)
        }
      }
      return folders
    }
    const workspacePathKey = path => typeof path === 'string' ? path.replaceAll(String.fromCharCode(92), '/').replace(/\/+$/, '') || '/' : ''
    function taskWorkspaceProjection(raw, octoIds, channelPaths, catalog) {
      const items = raw.items.filter(workspace => {
        if (workspace.sessionIds.length && workspace.sessionIds.every(id => octoIds.has(id))) return false
        const path = workspacePathKey(workspace.path)
        if (!channelPaths.has(path) || catalog.phase !== 'ready') return true
        const local = id => !octoIds.has(id) && catalog.byId[id] && !catalog.byId[id].blank
        return workspace.sessionIds.some(local)
          || catalog.ids.some(id => local(id) && workspacePathKey(catalog.byId[id].cwd) === path)
      })
      return items.length === raw.items.length ? raw : { ...raw, items }
    }
    function nativeTabRegistry(officialTree) {
      const tabs = new Map(), listeners = new Set(), sessionFilters = [], sessionOpeners = []
      let items = [], revision = 0
      const emit = () => { revision++; for (const fn of listeners) fn() }
      const add = (array, item) => {
        array.push(item); emit()
        return () => { const i = array.indexOf(item); if (i >= 0) { array.splice(i, 1); emit() } }
      }
      const rebuild = () => { items = [...tabs.values()].sort((a,b) => (a.order || 0) - (b.order || 0)); emit() }
      return { version: 1, officialTree, sessionFilters, sessionOpeners,
        getTabs: () => items, getRevision: () => revision,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        insert(tab) { tabs.set(tab.id, tab); rebuild(); return () => { if (tabs.get(tab.id) === tab) { tabs.delete(tab.id); rebuild() } } },
        addSessionFilter: fn => add(sessionFilters, fn), addSessionOpener: item => add(sessionOpeners, item) }
    }

    function apply(ctx) {
      const locale = () => ctx.locale.getSnapshot().active
      const subscribeLocale = fn => ctx.locale.subscribe(fn)
      const useT = () => {
        const lang = useSyncExternalStore(subscribeLocale, locale)
        return useMemo(() => tFor(lang), [lang])
      }
      const sessionSnapshot = () => ctx.sessions.list.getSnapshot()
      const subscribeSessions = fn => ctx.sessions.list.subscribe(fn)
      let showChannel = () => false
      let ownTabSwitch
      let openOctoSettings = () => {}
      const shortcutListeners = new Set()
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
        const statusRows = new Map((data.conversations ?? []).map(row => [row.id, row]))
        const [filter, setFilter] = useState('all')
        const [botFilter, setBotFilter] = useState('')
        const [query, setQuery] = useState('')
        const [opening, setOpening] = useState('')
        const [failed, setFailed] = useState(false)
        const entries = (data.sessionRoutes ?? data.conversations ?? []).map(row => ({ ...row, ...statusRows.get(row.id) })).filter(row => sessions.byId[row.id] && !archived.has(row.id))
          .sort((a, b) => (pins.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pins.get(b.id) ?? Number.MAX_SAFE_INTEGER))
          .map(row => {
          const rawTitle = sessions.byId[row.id]?.title
          const title = typeof rawTitle === 'string' && !rawTitle.includes('\uFFFD') ? rawTitle.trim() : ''
          const kind = t(channelNames[row.type]) || t('sessions')
          return { row, kind, title: title || shortId(row.address) }
        })
        const term = query.trim().toLocaleLowerCase()
        const visible = entries.filter(({ row, title, kind }) =>
          (!botFilter || row.accountId === botFilter) && (filter === 'all' || String(row.type) === filter)
          && (!term || [title, kind, row.address, row.accountLabel].some(value => String(value ?? '').toLocaleLowerCase().includes(term))))
        const tree = { branches: new Map(), entries: [] }
        for (const entry of visible) {
          let branch = tree
          for (const part of routeParts(entry.row, (data.accounts?.length ?? 0) > 1, t)) {
            if (!branch.branches.has(part.key)) branch.branches.set(part.key, { label: part.label, branches: new Map(), entries: [] })
            branch = branch.branches.get(part.key)
          }
          branch.entries.push(entry)
        }
        const renderTree = branch => h(React.Fragment, null,
          ...[...branch.branches].map(([key, child]) => h('details', { key, open: true, className: 'dsho-route-folder' },
            h('summary', null, child.label), renderTree(child))),
          branch.entries.length > 0 && h('ul', { className: 'dsho-list' }, ...branch.entries.map(renderEntry)))
        const renderEntry = ({ row, kind, title }) => {
          const issue = row.state === 'review' && issueLabel(row.issue, t)
          const detail = [kind, row.historical && t('previousSession'), issue].filter(Boolean).join(' · ')
          return h(ChannelRow, { key: row.id, row, kind, title, detail, issue, t, renderSlot,
            current: sessions.byId[row.id]?.retainedBy?.mainView, pinned: pins.has(row.id), busy: !!opening,
            open: async () => {
              setFailed(false); setOpening(row.id)
              try { await openSession(row.id); close?.() } catch { setFailed(true) } finally { setOpening('') }
            } })
        }
        return h('section', { className: 'dsho-channels' + (rail ? ' dsho-rail' : ''), 'aria-label': t('sessions'),
          ...(rail && { 'data-octo-rail': true }) },
          rail && h('div', { className: 'dsho-head' }, h('h3', null, 'Octo'), activeStatus(data, t)),
          data.error && h(ErrorNotice, { t, action: refresh, message: t(data.error) || t('unavailable') }),
          h('div', { className: 'dsho-tools' },
            data.accounts?.length > 1 && h('label', null, 'Bot ', h('select', { value: botFilter, onChange: e => setBotFilter(e.target.value) },
              h('option', { value: '' }, t('all')), ...data.accounts.map(bot => h('option', { key: bot.id, value: bot.id }, bot.label)))),
            h(Input, { className: 'dsho-search', type: 'search', value: query, 'aria-label': t('search'),
              placeholder: t('search'), onChange: e => setQuery(e.target.value) }),
            h('div', { className: 'dsho-filters', role: 'group', 'aria-label': t('filter') },
              ...[['all', 'all'], ['1', 'dm'], ['2', 'group'], ['5', 'topic']].map(([id, label]) =>
                h(Button, { key: id, size: 'sm', 'aria-pressed': filter === id, onClick: () => setFilter(id) }, t(label))))),
          failed && h(ErrorNotice, { t, message: t('openError') }),
          !data.status && !data.error && hint(t('loading')),
          visible.length ? renderTree(tree) : data.status && h(Empty, { title: t(entries.length ? 'noResults' : 'empty'),
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
      const timeoutUnits = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }
      function initialDraft(config, preferredUnit) {
        const ms = config.timeoutMs
        const timeoutUnit = ms === 'unlimited' ? 'unlimited'
          : Object.hasOwn(timeoutUnits, preferredUnit) ? preferredUnit
          // Keep the seconds display for values supported by 0.20.
          : (ms > 600_000 && ['days', 'hours', 'minutes'].find(unit => ms % timeoutUnits[unit] === 0)) || 'seconds'
        return { ...Object.fromEntries(Object.keys(choices).map(key => [key, config[key]])),
          ...Object.fromEntries(listKeys.map(key => [key, config[key].join('\n')])),
          maxConcurrentTurns: config.maxConcurrentTurns ?? 4,
          timeoutUnit, timeout: timeoutUnit === 'unlimited' ? '' : ms / timeoutUnits[timeoutUnit] }
      }
      function Config({ config, revision, accountId, t }) {
        const app = config.botKind === 'app'
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
        const unlimited = draft.timeoutUnit === 'unlimited'
        const multiplier = timeoutUnits[draft.timeoutUnit]
        const timeoutControl = h('fieldset', { className: 'dsho-timeout', 'aria-describedby': 'dsho-timeout-note' },
          h('legend', null, t('timeout')),
          h('div', { className: 'dsho-timeout-controls' },
            !unlimited && field('timeout', 'timeoutDuration', h('input', { id: 'dsho-timeout', type: 'number',
              min: 1000 / multiplier, step: 'any', required: true, value: draft.timeout,
              onChange: e => set('timeout', e.target.value) })),
            field('timeout-unit', 'timeoutUnit', h('select', { id: 'dsho-timeout-unit', value: draft.timeoutUnit,
              onChange: e => set('timeoutUnit', e.target.value) },
              ...[...Object.keys(timeoutUnits), 'unlimited'].map(unit => h('option', { key: unit, value: unit }, t(unit)))))),
          h('p', { className: 'dsho-muted', id: 'dsho-timeout-note' }, t('timeoutHint')))
        const save = async e => {
          e.preventDefault()
          let timeoutMs = 'unlimited'
          if (!unlimited) {
            const duration = Number(draft.timeout)
            // Keep the original integer if its displayed value was left as is.
            timeoutMs = duration === config.timeoutMs / multiplier ? config.timeoutMs : Math.round(duration * multiplier)
            if (duration < 1000 / multiplier || !Number.isSafeInteger(timeoutMs)) {
              setFeedback(['alert', 'invalidTimeout'])
              return
            }
          }
          setSaving(true); setFeedback(null); revisionEpoch++
          try {
            const settings = Object.fromEntries((app ? ['progress'] : Object.keys(choices)).map(k => [k, draft[k]]))
            for (const key of app ? [] : listKeys) {
              const inactive = draft.channelPolicy === 'joined'
              settings[key] = inactive ? [] : [...new Set(draft[key].split('\n').map(x => x.trim()).filter(Boolean))]
            }
            settings.timeoutMs = timeoutMs
            settings.maxConcurrentTurns = Number(draft.maxConcurrentTurns)
            const next = await api(accountId ? '/accounts/' + accountId + '/settings' : '/settings', { method: 'PUT', headers: {
              'Content-Type': 'application/json', 'x-dsh-octo-client': '1',
            }, body: JSON.stringify({ settings, revision: base.current }) })
            revisionEpoch++
            base.current = next.revision; setDraft(initialDraft(next.config, draft.timeoutUnit)); setDirty(false)
            publish(next.overview ?? { ...snapshot, ...next }); setFeedback(['status', 'saved'])
          } catch (error) {
            setFeedback(['alert', t(error.message) ? error.message : 'saveError'])
            if (error.message === 'settings_changed') refresh()
          } finally { setSaving(false) }
        }
        const stale = dirty && base.current !== revision
        return h('form', { className: 'dsho-form', onSubmit: save, 'aria-label': t('rules') },
          app && hint(t('appScope')),
          !app && card('permission', 'permissionHint', select('channelPolicy'),
            draft.channelPolicy === 'allowlist' && multi('allowedGroupIds', 'groups'),
            draft.channelPolicy === 'allowlist' && multi('allowedThreadIds', 'threads', 'threadFormat')),
          !app && card('triggers', 'triggersHint', select('mentionPolicy', config.transport !== 'websocket' && 'requiresWebSocket'),
            select('threadRuleMode')),
          h('details', { className: 'dsho-advanced' }, h('summary', null, t('advanced')),
          card('response', 'responseHint', select('progress', draft.progress === 'auto' && 'cardHint'), timeoutControl,
            field('maxConcurrentTurns', 'concurrentTurns', h('select', { id: 'dsho-maxConcurrentTurns',
              value: draft.maxConcurrentTurns, onChange: e => set('maxConcurrentTurns', e.target.value) },
            ...Array.from({ length: 8 }, (_, i) => h('option', { key: i + 1, value: i + 1 }, i + 1))), 'concurrentTurnsHint'))),
          (feedback || stale) && h('p', { className: 'dsho-alert', role: stale ? 'alert' : feedback[0] },
            t(stale ? 'settings_changed' : feedback[1])),
          h('div', { className: 'dsho-actions dsho-savebar' },
            h('div', { className: 'dsho-tools' },
              h(Button, { type: 'submit', variant: 'primary', disabled: saving || stale || !dirty }, t(saving ? 'saving' : 'save')),
              h(Button, { type: 'button', variant: 'outline', disabled: saving || !dirty, onClick: reset }, t('reset'))),
            dirty && !feedback && hint(t('unsaved'))))
      }
      function nativeMembers(raw, ids) {
        const visible = raw.ids.filter(id => ids.has(id) && raw.byId[id])
        return { ...raw, ids: visible, byId: Object.fromEntries(visible.map(id => [id, raw.byId[id]])) }
      }

      // Older sidebar registries can still render the native component in a separate tab.
      function NativeOcto({ official, props, getIds }) {
        const t = useT()
        const ids = useSyncExternalStore(subscribe, getIds)
        const data = useSyncExternalStore(subscribe, read)
        const sessions = useSyncExternalStore(subscribeSessions, sessionSnapshot)
        const [account, setAccount] = useState('')
        const [kind, setKind] = useState('')
        const rows = useMemo(() => (data.sessionRoutes ?? data.conversations ?? []).filter(row =>
          (!account || row.accountId === account) && (!kind || Number(kind) === row.type)),
        [data.sessionRoutes, data.conversations, account, kind])
        const visibleIds = useMemo(() => account || kind ? new Set(rows.map(row => row.id)) : ids, [rows, account, kind, ids])
        const sessionCache = useMemo(() => new WeakMap(), [visibleIds])
        const [view, setView] = useState({ groupBy: 'workspace-tree', archivedFilter: 'default', orderBy: 'updated',
          groupExpansion: {}, sessionOrderByAccount: {} })
        const state = patch => setView(current => ({ ...current, ...patch }))
        const actions = {
          setGroupBy: groupBy => state({ groupBy }), setArchivedFilter: archivedFilter => state({ archivedFilter }),
          setOrderBy: (orderBy, orders) => state({ orderBy, sessionOrderByAccount: orderBy === 'manual' ? orders ?? {} : {} }),
          setSessionOrder: (key, order, initial) => setView(current => ({ ...current, orderBy: 'manual',
            sessionOrderByAccount: { ...(current.orderBy === 'manual' ? current.sessionOrderByAccount : initial), [key]: order } })),
          setGroupExpanded: (key, expanded) => setView(current => ({ ...current,
            groupExpansion: { ...current.groupExpansion, [key]: expanded } })),
          retainAccountKeys: () => {},
        }
        if (!official || !props?.useSessions || !props?.useWorkspaces) return h(ChannelList, { rail: true, renderSlot: props?.renderSlot })
        const workspaceSource = props.octoUseWorkspaces ?? props.useWorkspaces
        const archiveOnly = view.archivedFilter === 'only'
        const flatGroups = archiveOnly || view.groupBy === 'workspace'
        const workspaceCache = useMemo(() => new WeakMap(), [rows, data.accounts?.length, account, sessions, archiveOnly, t])
        const useOctoWorkspaces = (select, equal) => workspaceSource(raw => {
          let projected = workspaceCache.get(raw)
          if (!projected) {
            projected = { ...raw, items: octoFolders(rows, sessions,
              (data.accounts?.length ?? 0) > 1 && !account, t, archiveOnly, raw.archivedSessionIds) }
            workspaceCache.set(raw, projected)
          }
          return select(projected)
        }, equal)
        const synthetic = id => typeof id === 'string' && id.startsWith(folderPrefix)
        const defaultExpansion = {}
        for (const row of rows) {
          const keys = []
          for (const part of routeParts(row, (data.accounts?.length ?? 0) > 1 && !account, t)) {
            keys.push(encodeURIComponent(part.key))
            defaultExpansion[folderPrefix + keys.join('/')] = true
          }
        }
        const viewProjection = { ...view, groupBy: flatGroups ? 'workspace' : view.groupBy,
          groupExpansion: { ...defaultExpansion, ...view.groupExpansion } }
        const native = { ...props, actions, useStore: select => select(viewProjection),
          useSessions: (select, equal) => props.useSessions(raw => {
            if (!sessionCache.has(raw)) sessionCache.set(raw, nativeMembers(raw, visibleIds))
            return select(sessionCache.get(raw))
          }, equal),
          useWorkspaces: useOctoWorkspaces,
          startSession: (id, ...args) => { if (!synthetic(id)) props.startSession?.(id, ...args) },
          useWorkspaceAccess: (id, ...args) => {
            const granted = props.useWorkspaceAccess?.(id, ...args)
            return !synthetic(id) && granted
          },
          ...(props.useContextMenu && { useContextMenu: () => {
            const menu = props.useContextMenu()
            return { ...menu, getTriggerProps(target, ...args) {
              return menu.getTriggerProps(synthetic(target?.value?.workspaceId) ? undefined : target, ...args)
            } }
          } }),
          renderFactorySlot: props.renderFactorySlot && ((slot, owner, ...args) =>
            synthetic(owner?.target?.value?.workspaceId) ? null : props.renderFactorySlot(slot, owner, ...args)),
          renameWorkspace: (id, ...args) => { if (!synthetic(id)) return props.renameWorkspace?.(id, ...args) },
          deleteWorkspace: (id, ...args) => { if (!synthetic(id)) return props.deleteWorkspace?.(id, ...args) },
          insertWorkspaceBefore: (id, ...args) => { if (!synthetic(id)) return props.insertWorkspaceBefore?.(id, ...args) },
          t: (key, params) => key === 'section.workspaces' || key === 'section.sessions' ? 'Octo' : props.t?.(key, params) ?? t(key) }
        if (props.searchSessions) native.searchSessions = async (...args) => {
          const result = await props.searchSessions(...args)
          return { ...result, items: result.items.filter(row => visibleIds.has(row.id)) }
        }
        return h(React.Fragment, null,
          h('div', { className: 'dsho-bot-filter' },
            h('span', { className: 'dsho-filter-context' }, account
              ? data.accounts?.find(bot => bot.id === account)?.label || 'Octo'
              : (locale()?.startsWith('zh') ? '全部 Bot' : 'All bots')),
            h('details', { className: 'dsho-filter-menu',
              onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false },
              onKeyDown: event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } } },
              h('summary', { 'aria-label': locale()?.startsWith('zh') ? '筛选会话' : 'Filter conversations' },
                h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                  h('path', { d: 'M2 4h12M4 8h8M6 12h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
                locale()?.startsWith('zh') ? '筛选' : 'Filter', (account || kind) && h('span', { className: 'dsho-filter-dot', 'aria-hidden': true })),
              h('div', { className: 'dsho-filter-popover' },
                data.accounts?.length > 1 && h('label', null, 'Bot',
                  h('select', { 'aria-label': 'Bot', value: account, onChange: event => setAccount(event.target.value) },
                    h('option', { value: '' }, t('all')), ...data.accounts.map(bot => h('option', { key: bot.id, value: bot.id }, bot.label)))),
                h('label', null, t('conversationType'), h('select', { 'aria-label': t('conversationType'), value: kind, onChange: event => setKind(event.target.value) },
                  h('option', { value: '' }, t('all')), ...[1,2,5].map(type => h('option', { key: type, value: type }, t(channelNames[type]))))),
                (account || kind) && h('button', { type: 'button', onClick: () => { setAccount(''); setKind('') } },
                  locale()?.startsWith('zh') ? '重置筛选' : 'Reset filters')))),
          h(official, native))

      }

      function StandaloneSidebar({ official, props, registry }) {
        const t = useT()
        const tabs = useSyncExternalStore(registry.subscribe, registry.getTabs)
        const revision = useSyncExternalStore(registry.subscribe, registry.getRevision)
        const [tab, setTab] = useState('tasks')
        const allowed = id => registry.sessionFilters.every(fn => fn(id))
        const taskUseSessions = useMemo(() => {
          const cache = new WeakMap()
          return (select, equal) => props.useSessions(raw => {
            if (!cache.has(raw)) cache.set(raw, nativeMembers(raw, new Set(raw.ids.filter(allowed))))
            return select(cache.get(raw))
          }, equal)
        }, [props.useSessions, revision])
        useEffect(() => {
          const select = id => setTab(id)
          ownTabSwitch = select
          return () => { if (ownTabSwitch === select) ownTabSwitch = undefined }
        }, [])
        const active = tabs.find(item => item.id === tab)
        const snapshot = useSyncExternalStore(subscribe, read)
        const catalog = useSyncExternalStore(subscribeSessions, sessionSnapshot)
        const taskPaths = useMemo(() => new Set((snapshot.channelWorkspacePaths ?? []).map(workspacePathKey)), [snapshot])
        const workspaceCache = useMemo(() => new WeakMap(), [taskPaths, catalog, revision])
        const taskProps = { ...props, useSessions: taskUseSessions,
          useWorkspaces: (select, equal) => props.useWorkspaces(raw => {
            if (!workspaceCache.has(raw)) {
              const ids = new Set((snapshot.sessionRoutes ?? snapshot.conversations ?? []).map(row => row.id))
              workspaceCache.set(raw, taskWorkspaceProjection(raw, ids, taskPaths, catalog))
            }
            return select(workspaceCache.get(raw))
          }, equal),
          ...(props.searchSessions && { searchSessions: async (...args) => {
            const result = await props.searchSessions(...args)
            return { ...result, items: result.items.filter(row => allowed(row.id)) }
          } }),
        }
        const items = [{ value: 'tasks', label: t('tasks'), id: 'dsho-tab-tasks' },
          ...tabs.map(item => ({ value: item.id, label: item.label, id: 'dsho-tab-' + item.id }))]
        return h(React.Fragment, null,
          props.wide !== false && h(SegmentedTabs, { className: 'dsho-native-tabs', label: t('railNav'),
            value: active?.id ?? 'tasks', items, onChange: setTab }),
          active && props.wide !== false ? active.render(props) : h(official, taskProps))
      }

      function NativeState({ sessionId }) {
        const t = useT()
        const data = useSyncExternalStore(subscribe, read)
        const row = data.conversations?.find(row => row.id === sessionId)
        if (!row || !['running', 'sending', 'waiting', 'review'].includes(row.state)) return null
        const label = t(row.state)
        return h('span', { className: 'dsho-native-state', title: issueLabel(row.issue, t) || label }, label)
      }

      function OctoMenuItem({ sessionId, useMenuOpenState }) {
        const t = useT()
        const data = useSyncExternalStore(subscribe, read)
        const [, closeMenu] = useMenuOpenState?.() ?? []
        const row = (data.sessionRoutes ?? data.conversations)?.find(row => row.id === sessionId)
        if (!row?.address) return null
        return h(MenuItemButton, { onSelect: () => {
          closeMenu?.(false)
          if (navigator.clipboard) { void navigator.clipboard.writeText(row.address).catch(() => {}); return }
          const field = document.createElement('textarea')
          field.value = row.address
          field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
          document.body.appendChild(field)
          try { field.select(); document.execCommand('copy') } finally { field.remove() }
        } }, t('copyOctoId'))
      }

      function Assistants({ data, t }) {
        const [View, setView] = useState(null)
        const [failed, setFailed] = useState(false)
        useEffect(() => {
          let stopped = false
          const url = new URL(path + '/assistant-view.js', document.baseURI)
          if (data.accountUiVersion) url.searchParams.set('v', data.accountUiVersion)
          import(url.href).then(module => {
            if (!stopped) setView(() => module.createAssistantView(React, primitives))
          }).catch(() => { if (!stopped) setFailed(true) })
          return () => { stopped = true }
        }, [data.accountUiVersion])
        if (failed) return h(ErrorNotice, { t, message: t('unavailable') })
        return View ? h(View, { data, request: api, publish: replaceSnapshot, refresh,
          lang: locale()?.startsWith('zh') ? 'zh' : 'en' }) : hint(t('loading'))
      }

      function CliGuide({ version }) {
        const [View, setView] = useState(null)
        const [failed, setFailed] = useState(false)
        const [attempt, retry] = useState(0)
        useEffect(() => {
          let stopped = false
          setFailed(false)
          const url = new URL(path + '/assistant-view.js', document.baseURI)
          if (version) url.searchParams.set('v', version)
          if (attempt) url.searchParams.set('retry', attempt)
          import(url.href).then(module => {
            if (!stopped) setView(() => module.createCliGuide(React, primitives))
          }).catch(() => { if (!stopped) setFailed(true) })
          return () => { stopped = true }
        }, [version, attempt])
        if (failed) return h('div', { className: 'dsho-panel' },
          h('p', { role: 'alert', className: 'dsho-muted' }, '安装指南加载失败，请重试。'),
          h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => retry(value => value + 1) }, '重新加载'))
        return View ? h(View) : hint('正在加载安装指南…')
      }

      function ServerSettings({ data, t }) {
        const [value, setValue] = useState(data.server?.pending ?? '')
        const [notice, setNotice] = useState('')
        const [busy, setBusy] = useState(false)
        useEffect(() => { setValue(data.server?.pending ?? '') }, [data.server?.pending])
        const saveServer = async event => {
          event.preventDefault()
          setBusy(true); setNotice('')
          try {
            const next = await api('/server', { method: 'PUT', headers: {
              'Content-Type': 'application/json', 'X-DSH-Octo-Client': '1'
            }, body: JSON.stringify({ endpoint: value.trim(), revision: data.accountRevision }) })
            replaceSnapshot(next)
            setNotice(next.server.pending === next.server.current ? t('serverSavedCurrent') : t('serverPending'))
          } catch (error) { setNotice(t(error.message) || t('saveError')) }
          finally { setBusy(false) }
        }
        return h('form', { className: 'dsho-panel', onSubmit: saveServer },
          h('h3', null, t('serverTitle')), hint(t('serverHint')),
          data.server?.current && hint(t('serverCurrent') + '：' + data.server.current),
          h('div', { className: 'dsho-field' },
            h('label', { htmlFor: 'dsho-server-address' }, t('endpoint')),
            h('input', { id: 'dsho-server-address', type: 'url', required: true, value,
              placeholder: data.server?.default, onChange: e => { setValue(e.target.value); setNotice('') } })),
          hint(t('serverIsolation')),
          data.server?.pending !== data.server?.current && hint(t('serverPending')),
          h(Button, { type: 'submit', disabled: busy || !data.canManage }, t('serverSave')),
          notice && h('p', { role: 'status' }, notice))
      }
      function Settings({ close }) {
        const t = useT()
        const data = useSyncExternalStore(subscribe, read)
        const [page, setPage] = useState('account')
        const [selected, setSelected] = useState('')
        const accounts = data.accounts ?? []
        const current = accounts.find(account => account.id === selected) ?? accounts[0]
        const sections = ['account', 'rules', 'cli']
        const panel = (key, content) => h('div', { id: 'dsho-panel-' + key, role: 'tabpanel',
          'aria-labelledby': 'dsho-tab-' + key, hidden: page !== key, key }, content)
        return h('div', { className: 'dsho-root', 'data-octo-settings': true },
          h('header', { className: 'dsho-head' }, h('div', null, h('h2', null, t('settings')), hint(t('subtitle'))),
            h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => {
              close?.()
              requestAnimationFrame(() => { if (!showChannel()) for (const fn of shortcutListeners) fn() })
            } }, t('openChannel'))),
          h(SegmentedTabs, { className: 'dsho-nav', label: t('nav'), value: page, onChange: setPage,
            items: sections.map(key => ({ value: key, label: t(key), id: 'dsho-tab-' + key, panelId: 'dsho-panel-' + key })) }),
          data.error && h(ErrorNotice, { t, action: refresh, message: t(data.error) || t('unavailable') }),
          panel('account', h(Account, { data, t, current, choose: setSelected })),
          data.server && h('div', { hidden: page !== 'account' }, h(ServerSettings, { data, t })),
          panel('rules',
            h('div', { className: 'dsho-panel' },
              accounts.length > 1 && h('div', { className: 'dsho-field' },
                h('label', { htmlFor: 'dsho-select-account' }, t('selectedBot')),
                h('select', { id: 'dsho-select-account', value: current?.id ?? '', onChange: e => setSelected(e.target.value) },
                  ...accounts.map(account => h('option', { key: account.id, value: account.id }, account.label)))),
              current?.config ? h(Config, { key: current.id, config: current.config, revision: current.revision, accountId: current.id, t })
                : h(Empty, { title: t('notConfigured'), note: t('deployHint') }))),
          panel('cli', page === 'cli' && h(CliGuide, { version: data.accountUiVersion })))
      }
      function ChannelShortcut({ wide }) {
        const t = useT()
        const native = useSyncExternalStore(subscribe, () => hasNativeTab)
        const dialog = useRef(null)
        const [active, setActive] = useState(false)
        const [settings, setSettings] = useState(false)
        useEffect(() => {
          const open = () => { setSettings(false); setActive(true) }
          shortcutListeners.add(open)
          const openSettings = () => { setSettings(true); setActive(true) }
          openOctoSettings = openSettings
          return () => { shortcutListeners.delete(open); if (openOctoSettings === openSettings) openOctoSettings = () => {} }
        }, [])
        useEffect(() => {
          if (active && dialog.current && !dialog.current.open) dialog.current.showModal()
        }, [active])
        if (native && !active) return null
        return h('div', null,
          !native && h(Button, { size: 'sm', icon: mark(), onClick: () => { setSettings(false); setActive(true) }, title: t('shortcut'),
            'aria-label': t('shortcut'), 'data-octo-shortcut': true }, wide === false ? null : t('shortcut')),
          active && h('dialog', { className: 'dsho-modal', ref: dialog, onClose: () => setActive(false), 'aria-label': t('shortcut') },
            h('header', { className: 'dsho-head' }, h('h2', null, t('shortcut')),
              h(Button, { size: 'sm', onClick: () => dialog.current.close() }, t('close'))),
            settings ? h(Settings, { close: () => dialog.current.close() })
              : h(ChannelList, { close: () => dialog.current.close() })))
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
      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action', id: 'dsh-channel-octo-status', order: 40,
      }, NativeState))
      if (MenuItemButton) ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: 'dsh-channel-octo-copy-id', order: 490,
      }, OctoMenuItem))
      ctx.effect(() => {
        const stylesheet = document.createElement('style')
        stylesheet.textContent = style
        document.head.appendChild(stylesheet)
        const controller = new AbortController()
        let timer, flight, registry, remove, removeFilter, matchIds = new Set()
        let hostEntry, standalone, original
        const getIds = () => matchIds
        let sessionRefresh
        const refreshNativeIndex = () => {
          if (sessionRefresh || controller.signal.aborted) return
          sessionRefresh = Promise.resolve().then(() => ctx.sessions.refresh?.())
            .catch(() => {}).finally(() => { sessionRefresh = undefined })
        }
        const applyFilter = () => {
          removeFilter?.()
          removeFilter = hasNativeTab && matchIds.size ? registry?.addSessionFilter?.(id => !matchIds.has(id)) : undefined
        }
        const rebuild = () => {
          const next = new Set((snapshot.sessionRoutes ?? snapshot.conversations ?? []).map(row => row.id))
          if (matchIds.size === next.size && [...next].every(id => matchIds.has(id))) return
          const hasNew = [...next].some(id => !matchIds.has(id))
          matchIds = next
          applyFilter()
          if (hasNew) refreshNativeIndex()
        }
        const restoreEntry = () => {
          if (standalone && hostEntry?.component === standalone) hostEntry.component = original
          hostEntry = standalone = original = undefined
        }
        // A foreign shell may pass the root workspace hook directly (not the
        // entry injection). Keep its workspace source untouched and limit the
        // visibility adjustment to its selected Tasks panel.
        const workspaceList = ctx.get?.('workspaces')?.list ?? ctx.workspaces?.list
        const hiddenMark = 'data-dsho-hidden-task-workspace'
        let frame
        const updateForeignTasks = () => {
          frame = undefined
          const selected = [...document.querySelectorAll('[role=tab][aria-selected=true]')]
            .find(tab => /(?:^|-)tab-tasks$/.test(tab.id) || ['任务', 'Tasks'].includes(tab.textContent.trim()))
          const raw = registry && !standalone && selected ? workspaceList?.getSnapshot?.() : null
          const paths = new Set((snapshot.channelWorkspacePaths ?? []).map(workspacePathKey))
          const hidden = new Set()
          if (raw) {
            const remaining = new Set(taskWorkspaceProjection(raw, matchIds, paths, sessionSnapshot()).items
              .map(row => row.workspaceId ?? row.id))
            for (const row of raw.items) {
              const id = row.workspaceId ?? row.id
              if (id && !remaining.has(id)) hidden.add('workspace:' + id)
            }
          }
          for (const row of document.querySelectorAll('[data-row-key^="workspace:"], [' + hiddenMark + ']')) {
            row.toggleAttribute(hiddenMark, hidden.has(row.getAttribute('data-row-key')))
          }
        }
        const scheduleForeignTasks = () => { if (frame === undefined) frame = requestAnimationFrame(updateForeignTasks) }
        const taskObserver = new MutationObserver(scheduleForeignTasks)
        taskObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] })
        const stopWorkspace = workspaceList?.subscribe?.(scheduleForeignTasks)
        const stopSession = subscribeSessions(scheduleForeignTasks)
        const stopSnapshot = subscribe(scheduleForeignTasks)
        const sync = () => {
          const readSlots = ctx.slots.entriesOfSlot ?? ctx.slots.entries
          const entry = readSlots?.call(ctx.slots, 'sidebar.workspaces')?.find(row => typeof row?.component === 'function')
          const current = entry?.component
          const offered = current?.__dshNativeTabs
          const foreign = typeof offered?.insert === 'function' && typeof offered.officialTree === 'function'
          if (entry === hostEntry && ((standalone && current === standalone) || (!standalone && offered === registry))) return
          removeFilter?.(); remove?.()
          removeFilter = remove = registry = undefined
          restoreEntry()
          if (entry) {
            hostEntry = entry
            if (foreign) registry = offered
            else if (entry.locale === 'workspace' || /workspace.browser|ui-workspace/i.test(entry.registrant ?? '')
              || entry.component.name === 'WorkspaceBrowser') {
              original = entry.component
              const own = nativeTabRegistry(original)
              const base = original
              standalone = props => h(StandaloneSidebar, { official: base, props, registry: own })
              Object.assign(standalone, { __dshNativeTabs: own, __dshNativeTabHost: true, __dshNativeTabWrapped: true })
              entry.component = standalone
              registry = own
              queueMicrotask(() => window.dispatchEvent(new Event('dsh-native-sidebar-change')))
            }
          }
          const official = registry?.officialTree
          remove = registry?.insert({ id: 'octo', label: 'Octo', order: 25,
            matchSession: id => matchIds.has(id), render: props => h(NativeOcto, { props, official, getIds }) })
          hasNativeTab = typeof remove === 'function'
          showChannel = () => {
            if (ownTabSwitch) { ownTabSwitch('octo'); return true }
            const tab = document.getElementById('ima-tab-octo') ?? document.getElementById('dcu-tab-octo')
              ?? [...document.querySelectorAll('[role=tab]')].find(el => el.textContent.trim() === 'Octo')
            if (!tab || tab.getAttribute('role') !== 'tab') return false
            tab.click(); return true
          }
          applyFilter()
          notify()
        }
        const unsubscribe = subscribe(rebuild)
        rebuild()
        const poll = () => {
          if (flight || controller.signal.aborted) return flight
          clearTimeout(timer)
          const epoch = revisionEpoch
          flight = (async () => {
            if (document.visibilityState === 'hidden') return
            try {
              const next = await api('', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) })
              if (!controller.signal.aborted && epoch === revisionEpoch) {
                publish(next)
                // A short-lived Octo Agent can be disposed after the host's previous list pull.
                // Re-query its durable summary rather than displaying a second synthetic row.
                const native = sessionSnapshot().byId
                if ((next.sessionRoutes ?? []).some(row => !native[row.id])) refreshNativeIndex()
              }
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
        const unsubscribeSlots = ctx.slots.subscribe?.('sidebar.workspaces', sync)
        window.addEventListener('dsh-native-sidebar-change', sync)
        document.addEventListener('visibilitychange', poll)
        void poll()
        return () => {
          controller.abort(); clearTimeout(timer); clearInterval(interval); unsubscribe(); unsubscribeSlots?.()
          removeFilter?.(); remove?.(); restoreEntry(); stylesheet.remove()
          taskObserver.disconnect(); stopWorkspace?.(); stopSession?.(); stopSnapshot()
          if (frame !== undefined) cancelAnimationFrame(frame)
          for (const row of document.querySelectorAll('[' + hiddenMark + ']')) row.removeAttribute(hiddenMark)
          window.removeEventListener('dsh-native-sidebar-change', sync)
          document.removeEventListener('visibilitychange', poll)
          refresh = () => {}; showChannel = () => false; hasNativeTab = false; publish({})
        }
      }, 'Octo channel workspace')
    }
    return { apply, inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale'] }
  },
})
