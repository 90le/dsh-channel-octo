# DSH Channel Octo

在 DeepSeek Harness Web 中并列加载的 Octo 私聊插件。使用宿主模型和原生会话，只接收白名单用户的纯文本，默认仅私聊；User Bot 可以单独开放指定群和话题。见[基础方案](PLAN.md)与[完整 Octo 能力及验收计划](OCTO-COVERAGE.md)。

## 本地检查

要求 Node.js 24 或 26。项目没有运行时 npm 依赖。

```sh
npm test
npm pack --dry-run
```

## 隔离试用

以 DSH `0.2.1-rc.5` 为初始兼容目标。在临时 `DSH_HOME` 的 `web` profile 中，从已验证的工作树 `npm pack`，再执行：

```sh
dsh plugin --profile web add /absolute/path/dsh-channel-octo-0.3.0.tgz
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
    allowedGroupIds: []
    allowedThreadIds: []
    threadRuleMode: thread-only
    cwd: /absolute/test-workspace
    stateDir: /absolute/private-octo-state
    waitSeconds: 15
    timeoutMs: 120000
```

群聊与子区只接受 User Bot（`bf_`），两个白名单分别配置。子区填完整通道 ID：32 位十六进制父群 ID、四个下划线、15–20 位数字短 ID；群 ID 不会自动放行旗下子区。两个场景都只响应白名单用户明确 @ Bot 的普通文本。升级前停止消费者并备份状态目录；私聊、群聊和默认子区模式沿用旧会话。

主区每轮读群规则。默认子区仅加载本区规则；设置 `threadRuleMode: inherit-group` 后，该插件允许的子区先读本区规则，再读父群规则，有冲突时以子区为准。父群继承会使用独立的子区会话，切回默认模式不会携带继承模式的历史。详见[群规则边界](OCTO-COVERAGE.md#群主区与子区规则)。

需要为测试 profile 设置可用的 DSH 模型。使用独立 Bot，不与其他连接程序同时消费其事件；启用后会确认该 Bot 收到的事件，超出当前支持范围的事件不进入模型。暂停时将 `enabled` 改回 `false` 并按环境流程重载 Web；本地状态和会话保留。

成功确认发送后，本地队列表只保留去重及投递记录，原生 DSH 会话仍保存对话。异常时查看服务中的 `dsh-channel-octo` 日志和状态库 `jobs` 的 `state`、`issue` 字段。对于 `review`，先在 Octo 查实际送达情况；插件不会自动重放不确定的任务或回复。

## 当前状态

0.3.0 为开发候选，支持私聊、群聊、子区文本路由，以及每轮读取当前群规则和子区规则。正式环境曾另行验证 Bot 鉴权、HTTP 长轮询和悟空 WebSocket 握手；这些探测未部署本插件。实际 Octo 插件收发和规则验收、附件与卡片闭环、其他已绑定 IM 渠道收发与 Debian 部署仍待验证。

11 项自动测试通过。隔离 DSH Web 与 IM Connect 共同加载后，用模拟 Octo 和模型验证了主区规则、子区继承、清空后的新快照、私聊续接及会话隔离。

复跑宿主检查（需安装指定版本的 DSH CLI；脚本使用临时 DSH home 和测试凭据）：

```sh
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js
```
