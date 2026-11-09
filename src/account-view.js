import { accountFields, createAccountEditor } from './account-editor.js'

const styles = `
.dsho-account-roster {
  container-type:inline-size; min-width:0; border:1px solid var(--dsho-edge); border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,transparent); overflow:hidden;
}
.dsho-account-roster .dsho-account-roster-header { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; min-height:56px; padding:0 16px; }
.dsho-account-roster .dsho-account-roster-header:has([aria-expanded]) { padding-inline-end:44px; }
.dsho-account-platform { display:flex; align-items:center; gap:10px; min-width:0; min-height:56px; text-align:start; color:inherit; font:inherit; background:none; border:0; padding:0; }
button.dsho-account-platform { cursor:pointer; }
.dsho-account-platform .dsho-account-platform-name { flex:1; font-size:14px; font-weight:600; }
.dsho-account-logo { display:grid; place-items:center; flex:none; width:24px; height:24px; border-radius:6px; background:var(--dsho-row); font-weight:650; }
.dsho-account-count,.dsho-account-caret { flex:none; color:var(--dsho-muted); font-size:12px; }
.dsho-account-caret { position:absolute; inset-inline-end:16px; top:50%; translate:0 -50%; transition:transform .15s ease; }
.dsho-account-platform[aria-expanded="true"] .dsho-account-caret { transform:rotate(90deg); }
.dsho-account-roster .dsho-account-items { gap:8px; padding:0 14px 14px; }
.dsho-account-roster .dsho-account-items[hidden] { display:none; }
.dsho-account-roster .dsho-account-line {
  display:grid; grid-template-columns:minmax(0,1fr) auto auto auto; align-items:center; gap:12px;
  min-height:48px; padding:10px 12px; border-radius:8px; background:color-mix(in srgb,currentColor 7%,transparent);
}
.dsho-account-roster .dsho-account-line:hover { background:var(--dsw-alias-interactive-bg-hover,var(--dsho-row)); }
.dsho-account-rename { display:block; width:100%; min-width:0; padding:0; border:0; background:none; color:inherit; font:inherit; font-size:13px; font-weight:500; text-align:start; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:text; }
.dsho-account-rename:hover { color:var(--dsw-alias-brand-primary,#4b7cff); }
.dsho-account-name input { box-sizing:border-box; width:100%; min-width:0; height:30px; padding:4px 7px; border:1px solid var(--dsho-edge); border-radius:6px; background:var(--dsho-soft); color:inherit; font:inherit; }
.dsho-account-receive { display:flex; align-items:center; gap:8px; white-space:nowrap; }
.dsho-account-roster .dsho-account-list-note,.dsho-account-roster .dsho-counts { margin:0 14px 14px; }
@container (max-width:480px) {
  .dsho-account-roster .dsho-account-line { gap:8px; padding:8px 10px; }
  .dsho-account-roster .dsho-account-receive-caption { display:none; }
}
@container (max-width:320px) {
  .dsho-account-roster .dsho-account-roster-header { gap:6px; padding-inline-start:10px; }
  .dsho-account-roster .dsho-account-roster-header:has([aria-expanded]) { padding-inline-end:30px; }
  .dsho-account-caret { inset-inline-end:8px; }
  .dsho-account-platform { gap:6px; }
}
dialog.dsho-account-modal[open] {
  display:flex; flex-direction:column; width:min(720px,calc(100vw - 32px))!important; min-height:0;
  max-height:calc(100dvh - 40px); padding:0!important; color:inherit; overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,var(--dsho-soft,Canvas));
}
.dsho-account-dialog-head { display:flex; justify-content:space-between; align-items:center; flex:none; gap:12px; padding:14px 24px; border-bottom:1px solid var(--dsho-edge); }
.dsho-account-dialog-head h2 { font-size:17px; line-height:24px; }
.dsho-account-editor { display:flex; flex-direction:column; min-width:0; min-height:0; margin:0; }
.dsho-account-body {
  display:grid; align-content:start; gap:16px; min-width:0; min-height:0; overflow:auto;
  padding:18px 24px 20px; scrollbar-gutter:stable; overscroll-behavior:contain;
}
.dsho-account-footer { display:grid; gap:8px; flex:none; padding:12px 24px; border-top:1px solid var(--dsho-edge); }
.dsho-account-footer>.dsho-account-buttons,.dsho-account-edit-actions { justify-content:flex-end; }
.dsho-account-buttons { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.dsho-account-setup { padding:16px; border:1px solid var(--dsho-edge); border-radius:12px; background:var(--dsho-soft); }
.dsho-account-settings { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 16px; min-width:0; }
.dsho-account-wide { grid-column:1/-1; }
.dsho-account-editor .dsho-field label { color:var(--dsw-alias-label-secondary,var(--dsho-muted)); font-size:12px; font-weight:550; line-height:16px; }
.dsho-account-editor .dsho-field input,.dsho-account-editor .dsho-field select {
  box-sizing:border-box; width:100%; min-width:0; min-height:36px; font-size:13px;
}
.dsho-account-note { color:var(--dsho-muted); font-size:11px; line-height:1.6; margin:0; }
.dsho-account-checkbox { display:flex; align-items:center; gap:8px; font-size:13px; }
.dsho-account-inspector { display:flex; gap:12px; padding-bottom:16px; border-bottom:1px solid var(--dsho-edge); }
.dsho-account-inspector-copy { display:grid; gap:4px; min-width:0; }
.dsho-account-inspector-title { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; }
.dsho-account-inspector-title h3 { margin:0; min-width:0; font-size:17px; overflow-wrap:anywhere; }
.dsho-account-ids { display:flex; flex-wrap:wrap; gap:2px 12px; color:var(--dsho-muted); font-size:11px; overflow-wrap:anywhere; }
.dsho-account-credentials { display:flex; align-items:flex-start; flex-wrap:wrap; gap:8px 12px; }
.dsho-account-credentials>.dsho-field,.dsho-account-verified { flex:1 1 230px; min-width:0; }
.dsho-account-credentials .dsho-account-buttons { align-self:flex-start; margin-top:21px; }
.dsho-account-verified .dsho-account-note { margin-bottom:4px; }
.dsho-account-feedback { display:grid; justify-items:start; gap:6px; min-width:0; }
.dsho-account-feedback:empty { display:none; }
.dsho-account-confirm { color:inherit; }
.dsho-account-confirm .dsho-account-buttons { justify-content:flex-end; }
@media (max-width:520px) {
  .dsho-account-dialog-head,.dsho-account-body,.dsho-account-footer { padding-inline:14px; }
  .dsho-account-settings { grid-template-columns:minmax(0,1fr); gap:12px; }
  .dsho-account-setup { padding:12px; }
  .dsho-account-credentials .dsho-account-buttons { margin-top:0; }
}
`

const caption = {
  count: ['个账号', 'accounts'], one: ['个账号', 'account'], add: ['添加账号', 'Add account'],
  receive: ['接收消息', 'Receive messages'], receiveHint: ['关闭后保留账号配置，但不接收新消息。', 'Turning this off keeps the account settings and stops new messages.'],
  edit: ['设置', 'Settings'], rename: ['修改账号名称', 'Rename account'], name: ['账号名称', 'Account name'],
  loading: ['正在读取工作区、模型与权限…', 'Loading workspaces, models and permissions…'],
  noServer: ['请先在 DSH 服务器配置受信任的 Octo 地址。', 'Configure a trusted Octo endpoint on the DSH server first.'],
  secure: ['添加账号和更换令牌请从 HTTPS 管理入口打开。', 'Use the HTTPS management page to add an account or replace a token.'],
  noVault: ['DSH 凭据库暂不可用，不能添加账号或更换令牌。', 'The DSH credential store is unavailable.'],
  cancel: ['取消', 'Cancel'], close: ['关闭', 'Close'], unnamed: ['Octo 账号', 'Octo account'],
  processing: ['处理中…', 'Processing…'],
  failure: ['操作未完成，请稍后重试。', 'Could not complete the request. Try again.'],
  account_busy: ['该账号正在处理消息，请等回复完成后再操作。', 'Wait for this account to finish its current messages.'],
  account_changed: ['账号设置已在别处更新，请重新打开设置后再试。', 'The account changed elsewhere. Reopen its settings and try again.'],
  duplicate_bot: ['这个 Bot 已经添加，请编辑原账号。', 'This bot already has an account. Edit the existing account.'],
  invalid_bot_token: ['Bot 令牌无效或尚未配置。', 'The bot token is invalid or missing.'],
  bot_identity_mismatch: ['新令牌不属于原来的 Bot 和空间。', 'The replacement token belongs to a different bot or space.'],
  bot_verification_failed: ['Octo 未确认令牌，请检查令牌和服务地址。', 'Octo could not verify this token. Check the token and server.'],
  secure_connection_required: ['当前连接不能提交令牌。请从 HTTPS 管理入口打开。', 'This connection cannot submit a token. Open the HTTPS management page.'],
  credential_provider_unavailable: ['DSH 凭据库暂不可用。', 'The DSH credential store is unavailable.'],
  permission_unavailable: ['该权限预设未在 Octo 的服务器配置中开放。', 'This permission preset is not enabled for Octo.'],
  permission_requires_allowlist: ['启用工具前，请选择仅允许名单中的用户并填写名单。', 'Set a private-chat allowlist before enabling tools.'],
  workspace_unavailable: ['所选工作区不可用，请重新选择。', 'Select an available workspace.'],
  model_unavailable: ['所选模型当前不可用。', 'The selected model is currently unavailable.'],
  reasoning_unavailable: ['这个模型不支持所选推理强度。', 'This model does not support the selected reasoning effort.'],
  remove: ['移除账号', 'Remove account'],
  confirmRemove: ['确定移除这个账号？已有 DSH 会话和历史记录会保留。', 'Remove this account? Existing DSH sessions and history will remain.'],
  failedOptions: ['无法读取账号设置选项。', 'Could not load account settings.'],
}

export function createAccountView(React, primitives, { request, status, label }) {
  const { createElement: h, useEffect, useId, useRef, useState } = React
  const { Button, Switch } = primitives
  const Editor = createAccountEditor(React, primitives)
  const talk = lang => key => Object.hasOwn(caption, key) ? caption[key][lang === 'zh' ? 0 : 1] : ''
  const send = (suffix, method, body) => request(suffix, {
    method, headers: { 'Content-Type': 'application/json', 'x-dsh-octo-client': '1' },
    body: JSON.stringify(body),
  })
  const endpoint = id => '/accounts/' + id

  function ConfirmRemove({ tr, onClose, remove }) {
    const dialog = useRef(null)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    useEffect(() => { if (!dialog.current.open) dialog.current.showModal() }, [])
    const confirm = async () => {
      setBusy(true)
      setNotice('')
      try { await remove() } catch (error) { setNotice(tr(error?.message) || tr('failure')); setBusy(false) }
    }
    return h('dialog', { ref: dialog, className: 'dsho-modal dsho-account-confirm', 'aria-label': tr('remove'),
      onClose, onCancel: event => { event.stopPropagation(); if (busy) event.preventDefault() } },
      h('header', null, h('h2', null, tr('remove'))),
      h('p', null, tr('confirmRemove')),
      notice && h('p', { className: 'dsho-alert', role: 'alert' }, notice),
      h('div', { className: 'dsho-account-buttons' },
        h(Button, { type: 'button', variant: 'outline', autoFocus: true, disabled: busy,
          onClick: () => dialog.current.close() }, tr('cancel')),
        h(Button, { type: 'button', variant: 'outline', className: 'dsho-danger-action',
          disabled: busy, onClick: confirm }, tr('remove'))))
  }

  function Modal({ account, data, lang, tr, publish, refresh, close, added }) {
    const dialog = useRef(null)
    const revision = useRef(data.accountRevision)
    const pending = useRef(false)
    const [options, setOptions] = useState(null)
    const [failed, setFailed] = useState(false)
    const [busy, setBusy] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const allowCredentials = window.isSecureContext && data.credentialAvailable === true
    useEffect(() => {
      if (!dialog.current.open) dialog.current.showModal()
      const controller = new AbortController()
      request('/account-options', { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) setOptions(result)
      }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
      return () => controller.abort()
    }, [])
    const perform = async (method, suffix, body, finish = false) => {
      pending.current = true
      setBusy(true)
      try {
        const next = await send(suffix, method, body)
        if (next.accounts) {
          revision.current = next.accountRevision
          publish(next)
        }
        if (finish) {
          if (!account) added()
          dialog.current?.close()
        }
        return next
      } catch (error) {
        if (error?.message === 'account_changed') refresh()
        throw error
      } finally {
        pending.current = false
        setBusy(false)
      }
    }
    const closeDialog = () => { if (!pending.current) dialog.current?.close() }
    const title = tr(account ? 'edit' : 'add')
    return h('dialog', { ref: dialog, className: 'dsho-modal dsho-account-modal', 'aria-label': title,
      onClose: event => { if (event.target === dialog.current) close() },
      onCancel: event => {
        event.stopPropagation()
        if (event.target === dialog.current && pending.current) event.preventDefault()
      } },
      h('header', { className: 'dsho-account-dialog-head' },
        h('h2', null, title),
        h(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: closeDialog,
          disabled: busy, 'aria-label': tr('close') }, '×')),
      failed ? h('div', { className: 'dsho-account-body' }, h('p', { className: 'dsho-alert', role: 'alert' }, tr('failedOptions'))) : !options
        ? h('div', { className: 'dsho-account-body' }, h('p', { role: 'status' }, tr('loading')))
        : h(Editor, {
          account, options, allowCredentials, secureSettings: window.isSecureContext, lang, onCancel: closeDialog, errorMessage: error => tr(error?.message),
          connectionStatus: account && status(account.enabled === false ? 'disabled' : account.status, lang),
          onVerify: ({ token }) => perform('POST', '/accounts/verify', { token }),
          onSave: fields => perform(account ? 'PUT' : 'POST', account ? endpoint(account.id) : '/accounts',
            { account: fields, revision: revision.current }, !account),
          onDiagnose: account && (() => perform('POST', endpoint(account.id) + '/diagnose', {})),
          onReconnect: account?.enabled && (() => perform('POST', endpoint(account.id) + '/reconnect',
            { revision: revision.current })),
          onRemove: account && !account.legacy && (() => { setConfirming(true); return false }),
        }),
      confirming && h(ConfirmRemove, { tr, onClose: () => setConfirming(false),
        remove: () => perform('POST', endpoint(account.id) + '/remove', { revision: revision.current }, true) }))
  }

  function AccountName({ account, tr, disabled, rename }) {
    const name = account.label || tr('unnamed')
    const [draft, setDraft] = useState(null)
    const button = useRef(null)
    const restore = useRef(false)
    useEffect(() => {
      if (draft === null && restore.current && !disabled) {
        restore.current = false
        button.current?.focus()
      }
    }, [draft, disabled])
    const finish = (commit, restoreFocus) => {
      const next = draft.trim()
      restore.current = restoreFocus
      setDraft(null)
      if (commit && next !== account.label) void rename(account, next)
    }
    return h('div', { className: 'dsho-account-name' }, draft === null
      ? h('button', { ref: button, type: 'button', className: 'dsho-account-rename', disabled, title: tr('rename'),
        'aria-label': name + ' · ' + tr('rename'), onClick: () => setDraft(account.label || '') }, name)
      : h('input', { autoFocus: true, type: 'text', value: draft, maxLength: 80, 'aria-label': tr('name'),
        onChange: event => setDraft(event.target.value), onBlur: () => finish(true, false),
        onKeyDown: event => {
          if (event.nativeEvent.isComposing || !['Enter', 'Escape'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          finish(event.key === 'Enter', true)
        } }))
  }

  return function AccountView({ data, lang, publish, refresh, choose, current }) {
    const tr = talk(lang)
    const rosterId = useId()
    const [expanded, setExpanded] = useState(true)
    const [modal, setModal] = useState(null)
    const [busy, setBusy] = useState('')
    const [notice, setNotice] = useState('')
    const writing = useRef(false)
    const accounts = data.accounts ?? []
    const selected = accounts.find(account => account.id === modal?.id)
    const canAdd = window.isSecureContext && data.canManage && data.credentialAvailable
    const noAdd = !data.canManage ? tr('noServer') : !window.isSecureContext ? tr('secure') : !data.credentialAvailable ? tr('noVault') : ''
    const mutate = async (account, suffix, body) => {
      if (writing.current) return
      writing.current = true
      setBusy(account.id)
      setNotice('')
      try {
        publish(await send(endpoint(account.id) + suffix, 'PUT', { ...body, revision: data.accountRevision }))
      } catch (error) {
        setNotice(tr(error?.message) || tr('failure'))
        if (error?.message === 'account_changed') refresh()
      } finally {
        writing.current = false
        setBusy('')
      }
    }
    const rename = (account, name) => mutate(account, '', { account: { ...accountFields(account), label: name } })
    const open = accounts.length > 0 && expanded
    const platformName = [
      h('span', { key: 'logo', className: 'dsho-account-logo', 'aria-hidden': true }, 'O'),
      h('span', { key: 'name', className: 'dsho-account-platform-name' }, 'Octo'),
      h('span', { key: 'count', className: 'dsho-account-count' }, accounts.length + ' ' + tr(accounts.length === 1 ? 'one' : 'count')),
    ]
    return h('section', { className: 'dsho-account-roster', 'aria-label': 'Octo' },
      h('style', null, styles),
      h('header', { className: 'dsho-account-roster-header' },
        accounts.length > 0
          ? h('button', { className: 'dsho-account-platform', type: 'button', 'aria-expanded': open, 'aria-controls': rosterId,
            onClick: () => setExpanded(value => !value) },
            ...platformName, h('span', { className: 'dsho-account-caret', 'aria-hidden': true },
              h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none' },
                h('path', { d: 'm5 3 4 4-4 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))))
          : h('div', { className: 'dsho-account-platform' }, ...platformName),
        h(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: () => { if (!writing.current) setModal({}) },
          disabled: !canAdd || Boolean(busy), title: noAdd || undefined }, tr('add'))),
      noAdd && h('p', { className: 'dsho-muted dsho-account-list-note' }, noAdd),
      h('ul', { id: rosterId, className: 'dsho-account-items', hidden: !open }, ...accounts.map(account =>
        h('li', { className: 'dsho-account-line', key: account.id },
          h(AccountName, { account, tr, disabled: !!busy || !data.canManage, rename }),
          busy === account.id ? h('span', { className: 'dsho-badge dsho-busy', role: 'status' }, tr('processing'))
            : status(account.enabled === false ? 'disabled' : account.status, lang),
          h('div', { className: 'dsho-account-receive', title: tr('receiveHint') },
            h('span', { className: 'dsho-muted dsho-account-receive-caption' }, tr('receive')),
            h(Switch, { checked: account.enabled === true, disabled: !!busy || !account.config,
              label: tr('receive') + ' · ' + (account.label || tr('unnamed')),
              onChange: enabled => mutate(account, '/state', { enabled }) })),
          h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!busy,
            onClick: () => { if (!writing.current) { choose(account.id); setModal({ id: account.id }) } },
            'aria-label': tr('edit') + ' · ' + (account.label || tr('unnamed')) }, tr('edit'))))),
      notice && h('p', { className: 'dsho-alert dsho-account-list-note', role: 'alert' }, notice),
      open && current?.counts?.length > 0 && h('div', { className: 'dsho-counts' }, ...current.counts.map(row =>
        h('span', { key: row.state }, (label(row.state, lang) || label('review', lang)) + ' ' + row.total))),
      modal && (!modal.id || selected) && h(Modal, { key: modal.id ?? 'new', account: selected, data, lang, tr, publish, refresh,
        close: () => setModal(null), added: () => setExpanded(true) }))
  }
}
