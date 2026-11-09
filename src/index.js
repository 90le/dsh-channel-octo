import { Accounts } from './accounts.js'
import { registerWeb } from './web.js'

export const name = 'dsh-channel-octo'
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'tools', 'systemPrompt']

export function apply(ctx, settings = {}) {
  const accounts = new Accounts(ctx, settings)
  ctx.inject(['webServer'], (web) => { web.effect(() => registerWeb(web, accounts)) })
  ctx.effect(() => {
    const boot = accounts.initialize()
    return async () => {
      accounts.lifetime.abort()
      await boot.catch(() => {})
      await accounts.dispose()
    }
  }, 'dsh-channel-octo.accounts')
}
