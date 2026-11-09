# DSH Channel Octo

在 DeepSeek Harness Web 中并列加载的 Octo 私聊插件。使用宿主模型和原生会话，只接收白名单用户的纯文本私聊。设计、运行边界和分阶段验收见 [方案](PLAN.md)。

## 本地检查

要求 Node.js 24 或 26。项目没有运行时 npm 依赖。

```sh
npm test
npm pack --dry-run
```

## 隔离试用

以 DSH `0.2.1-rc.5` 为初始兼容目标。在临时 `DSH_HOME` 的 `web` profile 中，从已验证的工作树 `npm pack`，再执行：

```sh
dsh plugin --profile web add /absolute/path/dsh-channel-octo-0.1.0.tgz
```

包安装后默认关闭 Octo 收发。若使用专用测试 Bot，给 DSH 进程注入 `DSH_OCTO_BOT_TOKEN`，在测试 profile 的 `cordis.patch.yml` 中追加以下覆盖。确保工作目录已存在，状态目录仅服务账号可读写（Linux 上模式 0700）。使用实际 Octo API 前缀，例如以 `/api` 结尾的 HTTPS 地址；Bot 和 Space 必须与校验接口返回值一致。

```yaml
- id: dsh-channel-octo
  config:
    enabled: true
    apiBase: https://octo.example.invalid/api
    botUid: TEST_BOT_UID
    spaceId: TEST_SPACE_ID
    allowedUids: [TEST_USER_UID]
    cwd: /absolute/test-workspace
    stateDir: /absolute/private-octo-state
    waitSeconds: 15
    timeoutMs: 120000
```

需要为测试 profile 设置可用的 DSH 模型。使用独立 Bot，不与其他连接程序同时消费其事件；启用后会确认该 Bot 收到的事件，超出当前支持范围的事件不进入模型。暂停时将 `enabled` 改回 `false` 并按环境流程重载 Web；本地状态和会话保留。

成功确认发送后，本地队列表只保留去重及投递记录，原生 DSH 会话仍保存对话。异常时查看服务中的 `dsh-channel-octo` 日志和状态库 `jobs` 的 `state`、`issue` 字段。对于 `review`，先在 Octo 查实际送达情况；插件不会自动重放不确定的任务或回复。

## 当前状态

0.1.0 为开发候选，包含长轮询、白名单、原生会话续接、工具拒绝、持久队列及回复投递。已通过 5 项自动测试，以及隔离 DSH Web 0.2.1-rc.5 与 IM Connect 1.0.30 的共存检查。隔离检查用模拟 Octo 和模型完成两轮私聊并确认回复入库、续接同一原生会话、模型请求不带工具。尚未连接实际 Octo、验证已绑定的其他 IM 渠道收发或部署 Debian。

复跑宿主检查（需安装指定版本的 DSH CLI；脚本使用临时 DSH home 和测试凭据）：

```sh
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js
```
