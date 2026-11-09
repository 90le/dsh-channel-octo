// DSH Web loads this module through its shared React and slot runtime.
window.__ModuleLoader__.load({
  id: 'dsh-channel-octo',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = require('react')
    const path = '/api/dsh-channel-octo'
    const listeners = new Set()
    const notify = () => { for (const cb of listeners) cb() }
    const subscribe = cb => { listeners.add(cb); return () => listeners.delete(cb) }
    let snapshot = {}
    const read = () => snapshot
    const statusNames = {
      online: '已连接', connecting: '正在连接', reconnecting: '正在重连', disabled: '尚未启用',
      invalid_configuration: '连接配置有误', configuration_or_state_error: '无法读取渠道设置', worker_stopped: '连接已停止',
    }
    const jobNames = { queued: '待处理', running: '生成中', ready: '待发送', sending: '发送中', sent: '已回复', review: '待检查' }
    const issues = { session_busy: '会话正忙', session_timeout: '生成超时', session_preset_conflict: '会话配置不一致',
      agent_run_not_confirmed: 'DSH 未确认生成', delivery_not_confirmed: 'Octo 未确认送达',
      no_confirmed_final_text: '没有可发送的正文', shared_turn_not_forwarded: '本回合包含其他来源的消息' }
    const errors = {
      settings_changed: '设置已在别处更新。请重新加载后再保存。',
      invalid_settings: '设置不符合要求，请检查名单和超时。',
      transport_managed_by_host: '当前连接使用轮询。免 @ 需要管理员将传输改为 WebSocket。',
      authentication_required: '请重新登录 DSH Web。', settings_not_saved: '写入失败，请检查服务器存储。',
    }
    const button = { cursor: 'pointer', font: 'inherit', color: 'inherit', padding: '5px 9px', borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1, #8887)', background: 'var(--dsw-alias-bg-layer-2, transparent)' }
    const field = { ...button, cursor: 'auto', width: '100%', boxSizing: 'border-box' }
    const stack = { display: 'grid', gap: 12 }
    async function api(suffix = '', options = {}) {
      const res = await fetch(new URL(path.slice(1) + suffix, document.baseURI),
        { ...options, credentials: 'same-origin', cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? (res.status === 401 ? 'authentication_required' : 'unavailable'))
      return data
    }
    const setSnapshot = value => { snapshot = value; notify() }
    function apply(ctx) {
      async function open(id) {
        // The channel row can arrive before DSH's session catalog refresh.
        if (!ctx.sessions.list.getSnapshot().byId[id]) await ctx.sessions.refresh()
        ctx.uiWorkspace.openSession(id)
      }

      function ChannelList({ close, compact = false }) {
        const data = useSyncExternalStore(subscribe, read)
        const [filter, setFilter] = useState('all')
        const [openError, setOpenError] = useState(false)
        const [opening, setOpening] = useState(false)
        const channels = (data.conversations ?? []).filter(row => filter === 'all' || String(row.type) === filter)
        const kinds = { 1: '私聊', 2: '群聊', 5: '子区' }
        return h('section', { style: { ...stack, padding: compact ? 10 : 0 }, 'aria-label': 'Octo 会话' },
          h('div', null, 'Octo · ', statusNames[data.status] ?? '读取中',
            data.error && h('p', { role: 'alert' }, errors[data.error] ?? '无法读取 Octo 渠道。')),
          h('label', null, '会话类型 ', h('select', { value: filter, onChange: e => setFilter(e.target.value), style: button },
            ...[['all', '全部'], ['1', '私聊'], ['2', '群聊'], ['5', '子区']].map(([k, v]) => h('option', { key: k, value: k }, v)))),
          openError && h('div', { role: 'alert' }, '当前页面无法打开会话，请刷新 DSH Web。'),
          channels.length === 0 && h('p', null, 'Bot 收到符合规则的消息后，会话会自动出现在这里。'),
          h('div', { style: { ...stack, gap: 6 } }, ...channels.map(row => h('button', {
            key: row.id, type: 'button', style: { ...button, textAlign: 'left', overflowWrap: 'anywhere' },
            disabled: opening,
            onClick: async () => {
              setOpenError(false); setOpening(true)
              try { await open(row.id); close?.() }
              catch { setOpenError(true) }
              finally { setOpening(false) }
            },
            title: row.address,
          }, h('strong', null, kinds[row.type] ?? '会话'), ' · ', row.address,
          row.scope && ' · 继承群规则', h('div', null, jobNames[row.state] ?? '已建立',
            row.state === 'review' && row.issue && ' · ' + (issues[row.issue] ?? row.issue))))))
      }

      const choices = {
        senderPolicy: ['发送者', { octo: 'Octo 好友和群成员', allowlist: '仅允许名单' }],
        channelPolicy: ['群与子区', { joined: 'Bot 已加入的群和子区', allowlist: '仅允许名单' }],
        mentionPolicy: ['群与子区触发', { required: '仅明确 @ Bot', octo: '按 Octo 的免 @ 设置' }],
        threadRuleMode: ['子区规则', { 'thread-only': '只用子区规则', 'inherit-group': '群规则 + 子区规则' }],
        progress: ['进度显示', { auto: '优先用 Octo 进度卡', typing: '只显示正在输入', off: '关闭' }],
      }
      function Config({ config, revision }) {
        const [draft, setDraft] = useState(config)
        const [feedback, setFeedback] = useState('')
        const [saving, setSaving] = useState(false)
        const revisionRef = useRef(revision)
        const update = (key, value) => setDraft(prev => ({ ...prev, [key]: value }))
        const multi = (key, label) => h('label', { style: stack }, label,
          h('textarea', { rows: 2, style: field, value: draft[key].join('\n'),
            onChange: e => update(key, e.target.value.split('\n')), placeholder: '每行一个 ID' }))
        const save = async e => {
          e.preventDefault()
          setSaving(true); setFeedback('')
          try {
            const settings = Object.fromEntries(Object.keys(choices).map(k => [k, draft[k]]))
            for (const key of ['allowedUids', 'allowedGroupIds', 'allowedThreadIds']) {
              const inactive = key === 'allowedUids' ? draft.senderPolicy === 'octo' : draft.channelPolicy === 'joined'
              settings[key] = inactive ? [] : [...new Set(draft[key].map(x => x.trim()).filter(Boolean))]
            }
            settings.timeoutMs = Number(draft.timeoutMs)
            const next = await api('/settings', { method: 'PUT', headers: {
              'Content-Type': 'application/json', 'x-dsh-octo-client': '1',
            }, body: JSON.stringify({ settings, revision: revisionRef.current }) })
            revisionRef.current = next.revision
            setDraft(next.config)
            setSnapshot({ ...snapshot, ...next })
            setFeedback('已保存，从下一条消息起生效。')
          } catch (error) { setFeedback(errors[error.message] ?? '未保存，请稍后重试。') }
          finally { setSaving(false) }
        }
        return h('form', { style: stack, onSubmit: save },
          h('div', { style: { overflowWrap: 'anywhere', lineHeight: 1.65 } },
            h('strong', null, 'Bot 连接 · 由部署管理'),
            ...[['Bot', config.botUid], ['工作空间 ID', config.spaceId], ['Octo 地址', config.apiBase],
              ['工作目录', config.cwd], ['连接方式', config.transport], ['凭据', '服务器环境变量']].map(([key, value]) =>
              h('div', { key }, key, '：', value))),
          ...Object.entries(choices).map(([key, [label, options]]) => h('label', { key, style: stack }, label,
            h('select', { style: field, 'aria-label': label, value: draft[key], onChange: e => update(key, e.target.value) },
              ...Object.entries(options).map(([value, text]) => h('option', { key: value, value,
                disabled: key === 'mentionPolicy' && value === 'octo' && config.transport !== 'websocket' }, text))))),
          draft.progress === 'auto' && h('small', null, '使用 Octo 中此 Bot 的卡片开关。卡片不可用时，显示正在输入。'),
          draft.senderPolicy === 'allowlist' && multi('allowedUids', '用户 UID 名单'),
          draft.channelPolicy === 'allowlist' && multi('allowedGroupIds', '群 ID 名单'),
          draft.channelPolicy === 'allowlist' && multi('allowedThreadIds', '子区地址名单（群 ID____子区 ID）'),
          h('label', { style: stack }, '回复超时（毫秒）',
            h('input', { type: 'number', style: field, min: 1000, max: 600000, required: true,
              value: draft.timeoutMs, onChange: e => update('timeoutMs', e.target.value) })),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: button, type: 'submit', disabled: saving }, saving ? '正在保存…' : '保存设置'),
            h('button', { style: button, type: 'button', disabled: saving, onClick: () => {
              setDraft(config); revisionRef.current = revision; setFeedback('已加载当前设置。')
            } }, '恢复当前设置')),
          feedback && h('p', { role: 'status' }, feedback))
      }

      function Settings({ close }) {
        const data = useSyncExternalStore(subscribe, read)
        const [tab, setTab] = useState('settings')
        return h('div', { style: { ...stack, maxWidth: 680 }, 'data-octo-settings': true },
          h('h2', null, 'Octo 渠道'), h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: button, 'aria-pressed': tab === 'settings', onClick: () => setTab('settings') }, '连接与规则'),
            h('button', { type: 'button', style: button, 'aria-pressed': tab === 'channels', onClick: () => setTab('channels') }, '频道会话')),
          tab === 'channels' ? h(ChannelList, { close })
            : h('div', { style: stack }, h('div', null, '连接状态：', statusNames[data.status] ?? '读取中',
              data.counts?.length ? ' · ' + data.counts.map(row => (jobNames[row.state] ?? row.state) + ' ' + row.total).join(' / ') : ''),
            data.error ? h('p', { role: 'alert' }, errors[data.error] ?? '无法读取 Octo 渠道。')
              : data.config ? h(Config, { config: data.config, revision: data.revision })
                : h('p', null, '需要管理员先在 DSH 部署配置中启用并绑定 Octo Bot。')))
      }

      function ChannelShortcut({ wide }) {
        const dialog = useRef(null)
        const [active, setActive] = useState(false)
        useEffect(() => {
          if (active && !dialog.current.open) dialog.current.showModal()
        }, [active])
        return h('div', null,
          h('button', { style: button, type: 'button', onClick: () => setActive(true), title: 'Octo 频道', 'aria-label': 'Octo 频道' },
            wide === false ? 'Octo' : 'Octo 频道'),
          active && h('dialog', { ref: dialog, onClose: () => setActive(false), 'aria-label': 'Octo 频道',
            style: { width: 'min(520px, 90vw)', maxHeight: '75vh', borderRadius: 12, color: 'inherit',
              background: 'var(--dsw-alias-bg-layer-2, Canvas)' } },
            h('button', { type: 'button', style: button, onClick: () => dialog.current.close() }, '关闭'),
            h(ChannelList, { close: () => dialog.current.close(), compact: true })))
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-channel-octo', order: 41, label: () => 'Octo 渠道',
      }, Settings))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'dsh-channel-octo-shortcut', order: 45,
      }, ChannelShortcut))
      ctx.effect(() => {
        const controller = new AbortController()
        let timer, interval, registry, remove
        const sync = () => {
          const readSlots = ctx.slots.entriesOfSlot ?? ctx.slots.entries
          const next = readSlots?.call(ctx.slots, 'sidebar.workspaces')
            ?.find(entry => entry?.component?.__dshNativeTabs?.version === 1)?.component?.__dshNativeTabs
          if (next === registry) return
          remove?.()
          registry = next
          remove = registry?.insert?.({ id: 'octo', label: 'Octo', order: 25,
            matchSession: id => snapshot.conversations?.some(row => row.id === id) ?? false,
            render: () => h(ChannelList, { compact: true }) })
        }
        const poll = async () => {
          try {
            if (document.visibilityState !== 'hidden') {
              const next = await api('', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) })
              if (!controller.signal.aborted) setSnapshot(next)
            }
          } catch (error) { if (!controller.signal.aborted) setSnapshot({ error: error.message }) }
          finally { if (!controller.signal.aborted) timer = setTimeout(poll, 4000) }
        }
        sync()
        let probes = 0
        interval = setInterval(() => { sync(); if (++probes >= 20) clearInterval(interval) }, 250)
        window.addEventListener('dsh-native-sidebar-change', sync)
        void poll()
        return () => {
          controller.abort(); clearTimeout(timer); clearInterval(interval); remove?.()
          window.removeEventListener('dsh-native-sidebar-change', sync)
        }
      }, 'Octo channel list')
    }
    return { apply, inject: ['slots', 'sessions', 'uiWorkspace'] }
  },
})
