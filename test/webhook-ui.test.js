import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exerciseWebhookUi, installWebhookUiFixture } from '../scripts/webhook-ui-smoke.mjs'

// Opt-in uses already installed tools; no installation, user browser profile,
// live accounts or remote services. The only page is this headless fixture.
const fixture = process.env.DSH_OCTO_WEBHOOK_UI_FIXTURE
const executablePath = process.env.DSH_OCTO_WEBHOOK_UI_BROWSER
test('headless development page: both languages, secret lifetime, confirmations and account-switch races',
  { skip: !fixture || !executablePath }, async t => {
    const rendererRoot = join(fixture, 'renderer-fixture', 'node_modules')
    const { build } = await import(pathToFileURL(join(rendererRoot, 'esbuild/lib/main.js')).href)
    const { chromium } = await import(pathToFileURL(join(fixture, 'browser-fixture/node_modules/playwright-core/index.mjs')).href)
    const script = `
      import React from ${JSON.stringify(join(rendererRoot, 'react/index.js').replaceAll('\\', '/'))};
      import ReactDOM from ${JSON.stringify(join(rendererRoot, 'react-dom/index.js').replaceAll('\\', '/'))};
      import { createWebhookView } from ${JSON.stringify(resolve('src/webhook-view.js').replaceAll('\\', '/'))};
      import { createAccountView } from ${JSON.stringify(resolve('src/account-view.js').replaceAll('\\', '/'))};
      const Button = ({variant,size,...props}) => React.createElement('button',props);
      const Widget = createWebhookView(React, { Button });
      let nextId = 0;
      const framework = {...React,useId:()=>React.useRef('fixture-'+(++nextId)).current};
      const account = {id:'legacy',label:'Octo Bot',legacy:true,enabled:false,config:{},botUid:'fixture-bot',spaceId:'fixture-space',cwd:'C:/fixture'};
      const AccountView = createAccountView(framework,{Button,Input:'input',Switch:()=>null},{
        status:()=>React.createElement('span',null,'Fixture'),label:()=>'',
        request:async(suffix,options)=>{
          if(suffix==='/account-options') return {workspaces:[{path:'C:/fixture',title:'Octo'}],models:[],policies:[{id:'text-only',label:'Text only'}],presets:[]};
          const response = await fetch('/api/dsh-channel-octo'+suffix,options);
          const body = await response.json(); if(!response.ok) throw Error(body.error); return body;
        }
      });
      function App() {
        const [accountId,setAccount] = React.useState('legacy');
        const [visible,setVisible] = React.useState(true);
        const lang = new URL(location.href).searchParams.get('lang') || 'en';
        React.useEffect(()=>{
          window.__switchWebhookAccount = ()=>setAccount(value=>value==='legacy'?'second':'legacy');
          window.__toggleWebhookPanel = ()=>setVisible(value=>!value);
        },[]);
        const perform = async (input,signal) => {
          const result = await fetch('/api/dsh-channel-octo/accounts/'+accountId+'/webhooks', {
            method:'POST',signal,headers:{'content-type':'application/json','x-dsh-octo-client':'1'},
            body:JSON.stringify({...input,revision:'fixture-revision'})
          });
          const body = await result.json(); if(!result.ok) throw Error(body.error); return body;
        };
        if(new URL(location.href).searchParams.get('account')==='1') return React.createElement('main',null,
          React.createElement('h1',null,'Octo settings development fixture'),
          React.createElement(AccountView,{data:{accounts:[account],canManage:true,accountRevision:'fixture-revision'},lang,
            publish(){},refresh(){},choose(){}}));
        return React.createElement('main',null,
          React.createElement('button',{onClick:()=>setAccount(accountId==='legacy'?'second':'legacy')},'Switch fixture account'),
          React.createElement('button',{onClick:()=>setVisible(!visible)},'Toggle fixture panel'),
          visible && React.createElement(Widget,{accountId,lang,perform}));
      }
      ReactDOM.render(React.createElement(App),document.getElementById('root'));
    `
    const built = await build({ stdin: { contents: script, resolveDir: process.cwd() }, bundle: true, write: false,
      platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
    const host = createServer((req, res) => {
      if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(built.outputFiles[0].text) }
      else if (req.url.startsWith('/api/')) { res.writeHead(500); res.end('fixture interception required') }
      else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;background:#f5f6f8;color:#20252d;--dsho-edge:#d9dce3;--dsho-soft:#fff;--dsho-row:#f3f5f8;--dsho-muted:#626977}button{font:inherit;cursor:pointer;background:#fff;color:inherit;border:1px solid #d9dce3;border-radius:8px;padding:7px 12px}button:disabled{opacity:.5}.dsho-modal{box-sizing:border-box;border:1px solid #d9dce3;border-radius:16px}.dsho-field{display:grid;gap:6px}input,select{font:inherit;padding:6px;border:1px solid #d9dce3;border-radius:7px;background:#fff;color:inherit}</style><div id="root"></div><script src="/app.js"></script>') }
    })
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ executablePath, headless: true })
    t.after(async () => { await browser.close(); await new Promise(resolve => host.close(resolve)) })
    const base = 'http://127.0.0.1:' + host.address().port
    for (const lang of ['zh', 'en']) {
      await t.test(lang + ' complete flow', async () => {
        const page = await browser.newPage()
        page.setDefaultTimeout(5000)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(base + '/?account=1&lang=' + lang)
        const mock = await installWebhookUiFixture(page, 'legacy', 'fixture-revision')
        await page.getByRole('button', { name: /^(设置|Settings) · Octo Bot$/ }).click()
        await page.locator('.dsho-account-editor').waitFor()
        const screenshotRoot = process.env.DSH_OCTO_WEBHOOK_UI_SCREENSHOTS
        const result = await exerciseWebhookUi(page, mock, { screenshotDir: screenshotRoot && join(screenshotRoot, lang) })
        assert.equal(result.explicitTests, 2)
        assert.equal(result.explicitCopies, 1)
        assert.deepEqual(errors, [])
        assert.equal(await page.locator('.dsho-account-modal[open]').count(), 1, 'closing child management preserves the account settings dialog')
        const manage = page.getByRole('button', { name: /^(管理 Webhook|Manage webhooks)$/ })
        await manage.click()
        const manager = page.locator('dialog.dsho-webhook-modal[open]')
        await manager.getByRole('button', { name: /^(读取可选频道|Load channels)$/ }).click()
        await manager.getByLabel(/^(目标频道|Target channel)$/).selectOption('2:00112233445566778899aabbccddeeff')
        await manager.locator('.dsho-webhook-list').getByRole('button', { name: /^(重新生成密钥|Regenerate secret)$/ }).first().click()
        await manager.getByRole('button', { name: /^(确认执行|Confirm action)$/ }).click()
        await manager.locator('.dsho-webhook-secret').waitFor()
        await page.keyboard.press('Escape')
        await manager.waitFor({ state: 'detached' })
        assert.equal(await page.locator('.dsho-account-modal[open]').count(), 1, 'Escape closes only the child modal')
        assert.equal(await manage.evaluate(element => element === document.activeElement), true, 'focus returns to the management opener')
        await manage.click()
        assert.equal(await manager.locator('.dsho-webhook-secret').count(), 0, 'Escape clears the one-time secret')
        await manager.getByRole('button', { name: /^(关闭并清除密钥|Close and clear secrets)$/ }).click()
        await mock.dispose(); await page.close()
      })
    }
    await t.test('account switch and unmount clear secrets and discard in-flight responses', async () => {
      const page = await browser.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(base)
      const mock = await installWebhookUiFixture(page, 'legacy', 'fixture-revision')
      const open = async () => {
        await page.getByRole('button', { name: 'Manage webhooks', exact: true }).click()
        await page.getByRole('button', { name: 'Load channels', exact: true }).click()
        await page.getByLabel('Target channel', { exact: true }).selectOption('2:00112233445566778899aabbccddeeff')
        await page.getByText('Webhook fixture', { exact: true }).waitFor()
      }
      await open()
      await page.getByRole('button', { name: 'Regenerate secret', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
      await page.locator('.dsho-webhook-secret').waitFor()
      await page.getByRole('button', { name: 'Reveal secrets and setup', exact: true }).click()
      await page.evaluate(() => window.__switchWebhookAccount())
      assert.equal(await page.locator('.dsho-webhook-secret').count(), 0)
      assert.ok(!(await page.locator('body').innerText()).includes('b'.repeat(64)))
      await page.evaluate(() => window.__switchWebhookAccount())
      await page.getByRole('button', { name: 'Load channels', exact: true }).click()
      await page.getByLabel('Target channel', { exact: true }).selectOption('2:00112233445566778899aabbccddeeff')
      await page.getByText('Webhook fixture', { exact: true }).waitFor()
      mock.state.gate = new Promise(resolve => { mock.state.release = resolve })
      await page.getByRole('button', { name: 'Regenerate secret', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
      await page.getByText('Working…', { exact: true }).waitFor()
      await page.evaluate(() => window.__switchWebhookAccount())
      mock.state.release()
      await page.waitForTimeout(100)
      assert.equal(await page.locator('.dsho-webhook-secret').count(), 0)
      assert.equal(await page.evaluate(() => window.__webhookFixtureCopies.length), 0)
      await page.evaluate(() => window.__toggleWebhookPanel())
      assert.equal(await page.locator('.dsho-webhook-panel').count(), 0)
      await mock.dispose(); await page.close()
    })
  })
