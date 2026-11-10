const labels = {
  title: ['聊天请求', 'Chat requests'],
  load: ['读取聊天请求', 'Load chat requests'],
  empty: ['当前账号没有待确认的聊天请求。', 'There are no pending chat requests for this account.'],
  help: ['在目标群或子区仅 @此 Bot，然后输入 /webhook create 名称 或 /webhook rotate Webhook ID。请求保留 5 分钟。',
    'In the target group or topic, mention only this bot and enter /webhook create NAME or /webhook rotate WEBHOOK_ID. Requests last five minutes.'],
  create: ['创建 Webhook', 'Create webhook'],
  regenerate: ['轮换 Webhook 密钥', 'Rotate webhook secret'],
  review: ['核对请求', 'Review request'],
  back: ['返回', 'Back'],
  cancel: ['撤销请求', 'Discard request'],
  approve: ['确认并执行', 'Confirm and execute'],
  target: ['确切目标', 'Exact target'],
  group: ['群', 'Group'],
  topic: ['子区', 'Topic'],
  expires: ['有效至', 'Expires at'],
  createImpact: ['创建后，新密钥只在这里显示一次。不会发送测试消息或启用提及。',
    'After creation, the new secret is shown here once. No test message is sent and mentions are disabled.'],
  rotateImpact: ['轮换会使旧推送地址失效（可能有短暂缓存延迟）。新密钥只在这里显示一次；请准备更新使用旧地址的服务。',
    'Rotation invalidates the old push URLs after a short possible cache delay. The new secret is shown here once. Be ready to update services using the old URLs.'],
}

export const webhookProposalUnavailable = [
  '请求已失效、被处理或账号权限已变化。请刷新核对；需要时从原频道重新发起。',
  'This request expired, was handled, or lost authorization. Refresh to check, and start again from the original conversation if needed.',
]

// Mount inside the existing account Webhook dialog (one keyed instance per
// account). Reuse its request/lifetime guard and one-time secret display.
// The proposal UI has no secret state and never sends credentials itself.
export function createWebhookChatView(React, { Button }) {
  const { createElement: h, useState } = React
  return function WebhookChatView({ lang, blocked, request, onComplete }) {
    const [proposals, setProposals] = useState(null)
    const [selected, select] = useState(null)
    const tr = key => labels[key][lang === 'zh' ? 0 : 1]
    const button = (key, run) => h(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: !!blocked, onClick: run }, tr(key))
    const reload = () => {
      select(null); setProposals(null)
      return request({ action: 'chat_pending' }, result => setProposals(result.proposals))
    }
    const submit = approve => {
      if (!selected || blocked) return
      const proposalId = selected.id
      select(null)
      if (approve) {
        setProposals(null)
        return request({ action: 'chat_approve', proposalId, confirmed: true }, onComplete)
      }
      return request({ action: 'chat_cancel', proposalId }, () => setProposals(old => old?.filter(item => item.id !== proposalId) ?? null))
    }
    const describe = item => [
      h('strong', { key: 'action' }, tr(item.action) + (item.name ? ' · ' + item.name : '')),
      h('p', { key: 'target' }, tr('target') + ': ' + tr(item.route.type === 5 ? 'topic' : 'group') + ' · ' + item.route.address),
      item.webhookId && h('p', { key: 'id' }, 'Webhook ID: ' + item.webhookId),
      h('p', { key: 'expires', className: 'dsho-account-note' }, tr('expires') + ': ' + new Date(item.expiresAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US')),
    ]
    return h('section', { className: 'dsho-webhook-detail', 'aria-label': tr('title') },
      h('h3', null, tr('title')),
      h('p', { className: 'dsho-account-note' }, tr('help')),
      h('div', { className: 'dsho-account-buttons' }, button('load', reload)),
      proposals?.length === 0 && h('p', null, tr('empty')),
      selected ? h('div', { className: 'dsho-webhook-detail', role: 'group', 'aria-label': tr('review') },
        ...describe(selected), h('p', null, tr(selected.action === 'regenerate' ? 'rotateImpact' : 'createImpact')),
        h('div', { className: 'dsho-account-buttons' }, button('approve', () => submit(true)),
          button('cancel', () => submit(false)), button('back', () => select(null))))
        : !!proposals?.length && h('ul', { className: 'dsho-webhook-list' }, ...proposals.map(item =>
          h('li', { key: item.id }, ...describe(item), button('review', () => select(item))))))
  }
}
