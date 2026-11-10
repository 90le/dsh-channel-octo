import { createWebhookChatView, webhookProposalUnavailable } from './webhook-chat-view.js'

const captions = {
  title: ['传入 Webhook', 'Incoming webhooks'], open: ['管理 Webhook', 'Manage webhooks'], close: ['关闭并清除密钥', 'Close and clear secrets'],
  policy: ['以当前 Bot 身份管理；Octo 实时校验成员与管理员权限。头像仅群管理员可改。', 'Manage as this bot. Octo checks current membership and management permissions. Only group administrators can change avatars.'],
  routes: ['读取可选频道', 'Load channels'], route: ['目标频道', 'Target channel'], select: ['请选择频道', 'Choose a channel'],
  threads: ['读取此群子区', 'Load group threads'], more: ['读取更多子区', 'Load more threads'], refresh: ['刷新列表', 'Refresh list'],
  loading: ['处理中…', 'Working…'], empty: ['此频道暂无 Webhook。', 'No webhooks in this channel.'],
  create: ['创建 Webhook', 'Create webhook'], edit: ['编辑', 'Edit'], save: ['保存', 'Save'], cancel: ['取消', 'Cancel'],
  name: ['名称', 'Name'], avatar: ['头像地址（管理员权限）', 'Avatar URL (administrator only)'], enabled: ['启用', 'Enabled'],
  all: ['允许 @所有人', 'Allow @everyone'], bots: ['允许 @所有 AI', 'Allow @all bots'],
  mentions: ['定向提及 UID（逗号分隔）', 'Target mention UIDs (comma-separated)'],
  mentionHint: ['仅可填写此群现有成员；Octo 在保存及发送时重新检查。', 'Use current group members only. Octo rechecks them when saving and sending.'],
  delete: ['删除', 'Delete'], regenerate: ['重新生成密钥', 'Regenerate secret'], test: ['发送测试消息', 'Send test message'],
  deliveries: ['投递诊断', 'Delivery diagnostics'], confirm: ['确认执行', 'Confirm action'],
  confirmDelete: ['确认删除此 Webhook？此操作不可恢复。', 'Delete this webhook? This cannot be undone.'],
  confirmRegenerate: ['确认更换密钥？旧地址将失效，新密钥只显示一次。', 'Regenerate the secret? Old URLs will stop working. The new secret is shown once.'],
  confirmTest: ['确认向下列频道发送真实测试消息？会触发列出的定向提及，不广播 @所有人或 @所有 AI。', 'Send a real test message to this channel? It includes the listed targeted mentions, without @everyone or @all bots broadcasts.'],
  targets: ['定向提及', 'Targeted mentions'], none: ['无', 'None'],
  revocation: ['删除、禁用或轮换可能有短暂缓存延迟；官方默认约 3 秒。', 'Deletion, disabling or rotation may have a short cache delay (official default: about 3 seconds).'],
  once: ['一次性密钥：关闭、切换账号或频道即清除。请主动保存至自己的安全位置。', 'One-time secret: cleared on close, account or channel change. Save it explicitly to your secure location.'],
  reveal: ['显示密钥与接入说明', 'Reveal secrets and setup'], hide: ['隐藏', 'Hide'], copy: ['复制密钥与接入说明', 'Copy secrets and setup'],
  copied: ['已复制', 'Copied'], copyFailed: ['无法自动复制，请显示后手动复制。', 'Copy unavailable. Reveal and copy manually.'],
  clear: ['清除密钥', 'Clear secrets'], secret: ['一次性密钥与接入说明', 'One-time secret and setup'],
  done: ['操作已完成。', 'Operation completed.'], sent: ['Octo 已接受测试；请在目标频道确认可见消息。消息 ID：', 'Octo accepted the test. Verify the visible message in the target channel. Message ID: '],
  noMessage: ['Octo 返回成功但未提供消息 ID；尚未确认可见投递。', 'Octo returned success without a message ID; visible delivery is unconfirmed.'],
  diagnostic: ['结果 / 原因 / HTTP / 适配器 / 字节 / 消息 ID / 时间', 'Result / Reason / HTTP / Adapter / Bytes / Message ID / Time'],
  noDeliveries: ['没有投递记录。', 'No delivery records.'], success: ['成功', 'Success'], failed: ['失败', 'Failed'], skipped: ['已跳过', 'Skipped'],
  failure: ['请求未完成。请刷新核对状态后再操作。', 'Request failed. Refresh and check the state before another action.'],
  invalid_webhook_request: ['输入无效；名称最多 64 字节，提及须为群内 UID。头像需要群管理员权限。', 'Invalid input. Names allow 64 bytes; mentions must be group member UIDs. Avatars require group administrator permission.'],
  webhook_forbidden: ['Bot 已无该空间、频道或 Webhook 的管理权限。', 'This bot lacks current space, channel or webhook permission.'],
  webhook_disabled: ['服务器未启用 Webhook 管理。', 'Webhook management is disabled on the server.'],
  webhook_not_found: ['目标已不存在或不属于此频道。', 'The target is missing or does not belong to this channel.'],
  webhook_conflict: ['已达配额或创建者已退群，请核对后再操作。', 'Quota reached or the creator left the group. Check before continuing.'],
  webhook_changed: ['配置已变化，请刷新后重新确认。', 'Configuration changed. Refresh and confirm again.'],
  webhook_proposal_unavailable: webhookProposalUnavailable,
  account_changed: ['账号设置已变化，请关闭并重新打开设置。', 'Account settings changed. Close and reopen settings.'],
  account_transition: ['账号正在切换连接，请稍后再操作。', 'The account is changing its connection. Try again shortly.'],
  webhook_rate_limited: ['请求过于频繁，请稍后手动刷新。', 'Rate limited. Refresh manually later.'],
  webhook_outcome_unknown: ['结果不确定：操作可能已经生效。不会自动重试；请先刷新或检查投递记录，勿直接重复创建、轮换或发送。', 'Outcome unknown: the operation may have completed. No automatic retry. Refresh or inspect deliveries before creating, rotating or sending again.'],
  webhook_unavailable: ['暂时无法验证 Octo 的响应，请手动刷新。', 'Octo response could not be verified. Refresh manually.'],
}

const styles = `
dialog.dsho-webhook-modal[open] {
  display:flex!important; flex-direction:column; position:fixed; inset:0; margin:auto!important;
  box-sizing:border-box; width:min(880px,calc(100vw - 32px))!important;
  height:min(820px,calc(100dvh - 48px)); max-height:calc(100dvh - 48px);
  min-width:0; min-height:0; padding:0!important; overflow:hidden;
  border:1px solid var(--dsho-edge,#d9dce3); border-radius:16px;
  background:var(--dsw-alias-bg-layer-1,var(--dsho-soft,Canvas)); color:inherit;
  box-shadow:0 20px 72px #0003; font:inherit;
}
.dsho-webhook-modal::backdrop { background:#0006; }
.dsho-webhook-header { display:flex; align-items:center; justify-content:space-between; gap:16px;
  flex:none; padding:18px 24px; border-bottom:1px solid var(--dsho-edge,#d9dce3); }
.dsho-webhook-header h2 { margin:0; font-size:18px; line-height:26px; }
.dsho-webhook-header p { margin:4px 0 0; font-size:12px; color:var(--dsho-muted,#626977); overflow-wrap:anywhere; }
.dsho-webhook-header>div { min-width:0; }
.dsho-webhook-header>button { flex:none; min-width:32px; min-height:32px; }
.dsho-webhook-modal .dsho-webhook-panel { flex:1; display:grid; align-content:start; gap:16px;
  min-height:0; min-width:0; overflow:auto; padding:20px 24px 28px; overscroll-behavior:contain; scrollbar-gutter:stable; }
.dsho-webhook-panel p { margin:0; overflow-wrap:anywhere; line-height:1.65; }
.dsho-webhook-panel .dsho-account-note { font-size:12px; color:var(--dsho-muted,#626977); }
.dsho-webhook-panel .dsho-account-buttons { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.dsho-webhook-panel button { max-width:100%; white-space:normal; }
.dsho-webhook-panel .dsho-field { display:grid; align-content:start; gap:6px; min-width:0; font-size:13px; }
.dsho-webhook-panel select,.dsho-webhook-panel input:not([type=checkbox]) {
  box-sizing:border-box; width:100%; min-width:0; min-height:38px; padding:8px 10px;
  border:1px solid var(--dsho-edge,#d9dce3); border-radius:8px; color:inherit;
  background:var(--dsw-alias-bg-layer-1,var(--dsho-soft,Canvas)); font:inherit;
}
.dsho-webhook-editor { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.dsho-webhook-editor .dsho-account-wide { grid-column:1/-1; }
.dsho-webhook-editor .dsho-account-checkbox { display:flex; align-items:center; gap:8px; font-size:13px; }
.dsho-webhook-detail { min-width:0; display:grid; gap:12px; padding:18px;
  border:1px solid var(--dsho-edge,#d9dce3); border-radius:12px; scroll-margin-block:20px; }
.dsho-webhook-detail:focus { outline:none; }
.dsho-webhook-detail h3 { margin:0; font-size:15px; }
.dsho-webhook-list { list-style:none; padding:0; margin:0; display:grid; gap:12px; }
.dsho-webhook-list li { min-width:0; display:grid; gap:8px; padding:16px; border:1px solid var(--dsho-edge,#d9dce3); border-radius:12px; }
.dsho-webhook-secret { margin:0; padding:14px; border-radius:8px; background:var(--dsho-row,#f3f5f8);
  white-space:pre-wrap; overflow-wrap:anywhere; max-height:240px; overflow:auto; font-size:13px; }
@media (max-width:520px) {
  dialog.dsho-webhook-modal[open] { width:calc(100vw - 16px)!important; height:calc(100dvh - 16px); max-height:calc(100dvh - 16px); border-radius:12px; }
  .dsho-webhook-header { padding:14px 16px; }
  .dsho-webhook-modal .dsho-webhook-panel { padding:16px; scrollbar-gutter:auto; }
  .dsho-webhook-editor { grid-template-columns:minmax(0,1fr); }
  .dsho-webhook-detail,.dsho-webhook-list li { padding:14px; }
}
`

export function createWebhookView(React, { Button }) {
  const { createElement: h, useEffect, useRef, useState } = React
  const ChatRequests = createWebhookChatView(React, { Button })
  const talk = lang => key => (captions[key] || captions.failure)[lang === 'zh' ? 0 : 1]
  const routeKey = route => route ? route.type + ':' + route.address : ''

  function Panel({ accountId, accountLabel, lang, disabled, busy, perform, close, chatEnabled }) {
    const tr = talk(lang)
    const [routes, setRoutes] = useState([]), [route, setRoute] = useState(null)
    const [list, setList] = useState(null), [working, setWorking] = useState(false)
    const [notice, setNotice] = useState(null), [draft, setDraft] = useState(null)
    const [confirm, setConfirm] = useState(null), [deliveries, setDeliveries] = useState(null)
    const [secretPresent, setSecretPresent] = useState(false), [revealed, setRevealed] = useState(false)
    const [threadPage, setThreadPage] = useState(null)
    const secret = useRef(null), pending = useRef(null), generation = useRef(0), alive = useRef(true)
    const dialog = useRef(null), detail = useRef(null)
    const clearSecret = () => { secret.current = null; setSecretPresent(false); setRevealed(false) }
    const invalidate = () => {
      generation.current++; pending.current?.abort(); pending.current = null
      clearSecret(); setWorking(false); setConfirm(null); setDraft(null); setDeliveries(null); setNotice(null)
    }
    useEffect(() => {
      alive.current = true
      const element = dialog.current
      if (!element.open) element.showModal()
      return () => {
        alive.current = false; generation.current++; pending.current?.abort(); secret.current = null
        if (element.open) element.close()
      }
    }, [accountId])
    useEffect(() => {
      if (detail.current) {
        detail.current.scrollIntoView({ block: 'nearest' })
        detail.current.focus({ preventScroll: true })
      }
    }, [!!draft, confirm, secretPresent, deliveries])
    const dismiss = () => { invalidate(); dialog.current?.close() }
    const blocked = disabled || busy || working
    const request = async (input, apply) => {
      if (disabled || busy || pending.current) return
      clearSecret(); setNotice(null); setDeliveries(null)
      const controller = new AbortController(), stamp = generation.current
      pending.current = controller; setWorking(true)
      try {
        const result = await perform(input, controller.signal)
        if (!alive.current || controller.signal.aborted || stamp !== generation.current || result.accountId !== accountId) return
        apply(result)
      } catch (error) {
        if (alive.current && !controller.signal.aborted && stamp === generation.current) {
          setNotice({ error: true, text: tr(error?.message) }); setConfirm(null)
          // Clear stale permission/configuration views; require a fresh list.
          setList(null)
        }
      } finally {
        if (pending.current === controller) { pending.current = null; if (alive.current) setWorking(false) }
      }
    }
    const select = selected => {
      invalidate(); setRoute(selected); setList(null); setThreadPage(null)
      if (selected) void request({ action: 'list', route: { type: selected.type, address: selected.address } }, result => setList(result.list))
    }
    const target = route && { type: route.type, address: route.address }
    const loadRoutes = () => { invalidate(); setRoute(null); setList(null); setThreadPage(null)
      return request({ action: 'routes' }, result => setRoutes(result.routes)) }
    const edit = item => {
      clearSecret(); setConfirm(null); setNotice(null); setDeliveries(null)
      setDraft({ original: item, name: item?.name || '', avatar: item?.avatar || '', status: item?.status ?? 1,
        allow_mention_all: !!item?.allow_mention_all, allow_mention_bots: !!item?.allow_mention_bots, mention_uids: (item?.mention_uids || []).join(', ') })
    }
    const completed = result => {
      setDraft(null); setConfirm(null)
      if (result.webhook) setList(old => [...(old || []).filter(item => item.webhook_id !== result.webhook.webhook_id), result.webhook])
      if (result.deleted) setList(old => (old || []).filter(item => item.webhook_id !== result.deleted))
      if (result.secret) { secret.current = result.secret; setSecretPresent(true); setRevealed(false) }
      setNotice({ text: result.test ? result.test.message_id === '0' ? tr('noMessage') : tr('sent') + result.test.message_id : tr('done') })
    }
    const save = () => {
      if (!draft) return
      const changes = {}, original = draft.original
      for (const key of ['name', 'avatar', 'status', 'allow_mention_all', 'allow_mention_bots', 'mention_uids']) {
        const value = key === 'mention_uids' ? draft[key].split(/[,，\s]+/).filter(Boolean) : draft[key]
        if (!original && (key === 'status' || (['name', 'avatar'].includes(key) && !value))) continue
        const prior = key.startsWith('allow_') ? !!original?.[key] : original?.[key]
        if (!original || JSON.stringify(value) !== JSON.stringify(prior)) changes[key] = value
      }
      return request({ action: original ? 'update' : 'create', route: target, changes,
        ...(original && { webhookId: original.webhook_id, expected: original.version }) }, completed)
    }
    const action = (kind, item) => {
      clearSecret(); setDraft(null); setNotice(null); setDeliveries(null)
      setConfirm({ action: kind, item })
    }
    const button = (key, onClick, props = {}) => h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!blocked, onClick, ...props }, tr(key))
    const field = (key, type = 'text') => h('label', { className: 'dsho-field' }, tr(key === 'mention_uids' ? 'mentions' : key), h('input', {
      type, value: draft[key], disabled: !!blocked, autoComplete: 'off', onChange: e => setDraft({ ...draft, [key]: e.target.value }),
    }))
    const content = h('section', { className: 'dsho-webhook-panel', 'aria-label': tr('title') },
      h('p', { className: 'dsho-account-note' }, tr('policy')),
      h('div', { className: 'dsho-account-buttons' }, button('routes', loadRoutes)),
      h('label', { className: 'dsho-field' }, tr('route'), h('select', {
        'aria-label': tr('route'),
        value: routeKey(route), disabled: !!(disabled || busy), onChange: event => select(routes.find(row => routeKey(row) === event.target.value) || null),
      }, h('option', { value: '' }, tr('select')), ...routes.map(row => h('option', { key: routeKey(row), value: routeKey(row) }, row.name + ' · ' + row.address)))),
      route && h('div', { className: 'dsho-account-buttons' },
        button('refresh', () => request({ action: 'list', route: target }, result => { setList(result.list); setConfirm(null); setDraft(null) })),
        route.type === 2 && (!threadPage || threadPage.more) && button(threadPage ? 'more' : 'threads', () => request({ action: 'threads', route: target, page: (threadPage?.page || 0) + 1 }, result => {
          setRoutes(old => [...new Map([...old, ...result.routes].map(row => [routeKey(row), row])).values()]); setThreadPage(result)
        })),
        list && button('create', () => edit(null))),
      working && h('p', { role: 'status' }, tr('loading')),
      notice && h('p', { role: notice.error ? 'alert' : 'status', className: notice.error ? 'dsho-alert' : 'dsho-account-note' }, notice.text),
      chatEnabled && !route && h(ChatRequests, { lang, blocked, request,
        // A chat receipt is not a row for the manual manager's selected route.
        onComplete: ({ secret: issued }) => completed({ secret: issued }) }),
      list?.length === 0 && h('p', null, tr('empty')),
      draft && h('div', { ref: detail, tabIndex: -1, className: 'dsho-webhook-detail' },
        h('h3', null, tr(draft.original ? 'edit' : 'create')),
        h('div', { className: 'dsho-webhook-editor' }, field('name'), field('avatar'),
        ...['status', 'allow_mention_all', 'allow_mention_bots'].filter(key => draft.original || key !== 'status').map(key => h('label', { className: 'dsho-account-checkbox', key },
          h('input', { type: 'checkbox', checked: !!draft[key], disabled: !!blocked,
            onChange: event => setDraft({ ...draft, [key]: key === 'status' ? Number(event.target.checked) : event.target.checked }) }),
          tr(key === 'status' ? 'enabled' : key === 'allow_mention_all' ? 'all' : 'bots'))),
        field('mention_uids'), h('p', { className: 'dsho-account-note dsho-account-wide' }, tr('mentionHint')),
        h('div', { className: 'dsho-account-buttons dsho-account-wide' }, button('save', save), button('cancel', () => setDraft(null))))),
      confirm && h('div', { ref: detail, tabIndex: -1, className: 'dsho-webhook-detail', role: 'group', 'aria-label': tr('confirm') },
        h('h3', null, tr(confirm.action)),
        h('p', null, tr(confirm.action === 'test' ? 'confirmTest' : confirm.action === 'delete' ? 'confirmDelete' : 'confirmRegenerate')),
        h('p', null, (route.name || route.address) + ' · ' + route.address + ' · ' + confirm.item.name + ' · ' + confirm.item.webhook_id),
        h('p', null, tr('targets') + ': ' + (confirm.item.mention_uids.join(', ') || tr('none'))),
        h('div', { className: 'dsho-account-buttons' }, button('confirm', () => request({ action: confirm.action, route: target,
          webhookId: confirm.item.webhook_id, expected: confirm.item.version, confirmed: true }, completed)), button('cancel', () => setConfirm(null)))),
      secretPresent && h('section', { ref: detail, tabIndex: -1, className: 'dsho-webhook-detail', 'aria-label': tr('secret') },
        h('h3', null, tr('secret')),
        h('p', { className: 'dsho-account-note' }, tr('once')),
        h('pre', { className: 'dsho-webhook-secret', 'aria-label': tr('secret') }, revealed ? JSON.stringify(secret.current, null, 2) : '••••••••••••••••'),
        h('div', { className: 'dsho-account-buttons' }, button(revealed ? 'hide' : 'reveal', () => setRevealed(!revealed)),
          button('copy', async () => {
            const stamp = generation.current
            try {
              await navigator.clipboard.writeText(JSON.stringify(secret.current, null, 2))
              if (alive.current && stamp === generation.current) setNotice({ text: tr('copied') })
            } catch { if (alive.current && stamp === generation.current) setNotice({ error: true, text: tr('copyFailed') }) }
          }), button('clear', clearSecret))),
      deliveries && h('section', { ref: detail, tabIndex: -1, className: 'dsho-webhook-detail', 'aria-label': tr('deliveries') }, h('h3', null, tr('deliveries')), h('strong', null, deliveries.name),
        h('p', { className: 'dsho-account-note' }, tr('diagnostic')),
        !deliveries.rows.length && h('p', null, tr('noDeliveries')),
        ...deliveries.rows.map((row, index) => h('p', { key: index, className: 'dsho-account-note' },
          [tr(row.status === 1 ? 'success' : row.status === 2 ? 'failed' : 'skipped'), row.reason || '−', row.http_status, row.adapter,
            row.byte_size, row.message_id, new Date(row.created_at * 1000).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')].join(' / ')))),
      list && h('ul', { className: 'dsho-webhook-list' }, ...list.map(item => h('li', { key: item.webhook_id },
        h('strong', null, item.name), h('p', { className: 'dsho-account-note' }, item.webhook_id + ' · ' + item.creator_uid + ' · ' + tr('enabled') + ': ' + (item.status === 1 ? '✓' : '−')),
        h('p', { className: 'dsho-account-note' }, tr('targets') + ': ' + (item.mention_uids.join(', ') || tr('none'))),
        h('div', { className: 'dsho-account-buttons' }, button('edit', () => edit(item)),
          ...['delete', 'regenerate', 'test'].map(kind => button(kind, () => action(kind, item), { key: kind })),
          button('deliveries', () => request({ action: 'deliveries', route: target, webhookId: item.webhook_id, limit: 50 }, result => setDeliveries({ name: item.name, rows: result.deliveries }))))))),
      h('p', { className: 'dsho-account-note' }, tr('revocation')))
    return h('dialog', { ref: dialog, className: 'dsho-webhook-modal', 'aria-label': tr('title'),
      onCancel: event => { event.stopPropagation(); event.preventDefault(); dismiss() },
      onClose: event => { event.stopPropagation(); invalidate(); close() } },
      h('header', { className: 'dsho-webhook-header' },
        h('div', null, h('h2', null, tr('title')), h('p', null, accountLabel || accountId)),
        h(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: dismiss, 'aria-label': tr('close'), title: tr('close') }, '×')),
      content)
  }

  return function WebhookView(props) {
    const [open, setOpen] = useState(false)
    const tr = talk(props.lang)
    return h('section', { className: 'dsho-account-footer', 'aria-label': tr('title') },
      h('style', null, styles),
      h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!(props.disabled || props.busy),
        'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(true) }, tr('open')),
      open && h(Panel, { ...props, key: props.accountId, close: () => setOpen(false) }))
  }
}
