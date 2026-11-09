# DSH Channel Octo

在 DeepSeek Harness Web 中并列加载的 Octo IM 插件。使用宿主模型和原生会话，支持私聊、群聊和子区纯文本，以及回复进度卡。可选本地白名单或 Octo 好友与成员准入。见[基础方案](PLAN.md)与[完整能力及验收计划](OCTO-COVERAGE.md)。

## 本地检查

要求 Node.js 24 或 26。运行时依赖为 WebSocket 客户端 `ws`。

```sh
npm ci
npm test
npm pack --dry-run
```

## 隔离试用

以 DSH `0.2.1-rc.5` 为初始兼容目标。在临时 `DSH_HOME` 的 `web` profile 中，从已验证的工作树 `npm pack`，再执行：

```sh
dsh plugin --profile web add /absolute/path/dsh-channel-octo-0.5.1.tgz
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

默认仍采用本地用户和频道白名单，群与子区要求明确 @。群聊与子区只接受 User Bot（`bf_`）。显式配置子区时填完整通道 ID：32 位十六进制父群 ID、四个下划线、15–20 位数字短 ID；群 ID 不会自动放行旗下子区。升级前停止消费者并备份状态目录；私聊、群聊和默认子区模式沿用旧会话。

要让 Octo 好友及群友无需逐个配置 UID，在同一配置中设置：

```yaml
    senderPolicy: octo
    channelPolicy: joined
    mentionPolicy: octo
```

- `senderPolicy: octo`：删除或清空 `allowedUids`。私聊由 Octo 检查好友关系（User Bot 的所有者也可直接私聊）；群与子区检查父群成员身份。只需要取消逐人白名单时，可以继续用 `channelPolicy: allowlist` 控制开放哪些群或子区。
- `channelPolicy: joined`：删除或清空 `allowedGroupIds` 和 `allowedThreadIds`。接收 Bot 在绑定 Space 已加入的普通群及 Octo 实际投递到 Bot 的子区。
- `mentionPolicy: octo`：自动用 WebSocket 接收消息。明确 @ 仍有效；免 @ 仅在 Octo 返回父群有效开关为开、发送者是已确认的普通成员、且消息未 @ 其他人时触发。只想开放给好友和群友但保留必需 @，可省略此项。

WebSocket 注册占用该 Bot 的连接，同一 Bot 只运行一个消费者。旧模式仍可使用 `transport: events`；如需在必需 @ 模式使用实时接收，可设置 `transport: websocket`。短时断线会重连，当前版本不主动补拉断线期间漏收的普通群消息。

主区每轮读群规则。默认子区仅加载本区规则；设置 `threadRuleMode: inherit-group` 后，该插件允许的子区先读本区规则，再读父群规则，有冲突时以子区为准。父群继承会使用独立的子区会话，切回默认模式不会携带继承模式的历史。详见[群规则边界](OCTO-COVERAGE.md#群主区与子区规则)。

需要为测试 profile 设置可用的 DSH 模型。使用独立 Bot，不与其他连接程序同时消费其事件；启用后会确认该 Bot 收到的事件，超出当前支持范围的事件不进入模型。暂停时将 `enabled` 改回 `false` 并按环境流程重载 Web；本地状态和会话保留。

成功确认发送后，本地队列表只保留去重及投递记录，原生 DSH 会话仍保存对话。异常时查看服务中的 `dsh-channel-octo` 日志和状态库 `jobs` 的 `state`、`issue` 字段。对于 `review`，先在 Octo 查实际送达情况；插件不会自动重放不确定的任务或回复。

## 当前状态

0.5.0 复用已经在 DSH Web 打开的 Octo 会话，继续限制宿主工具，等待已有工作结束后再提交 Octo 消息。终态与该消息对应的回合绑定；同回合混入其他输入时停止转发。没有确认回复的旧任务仍留在待检查列表。

- **设置 → Octo 渠道**：0.5.1 使用 DSH 的控件和语言设置，把 Bot 账号、渠道设置、频道会话分开。连接详情默认折叠；渠道设置包含准入、名单、@ 触发、子区规则、进度和超时。保存后，新消息使用新设置。Bot 绑定和令牌仍由服务器管理，面板不会读取或显示令牌原文。
- **侧栏 → Octo**：有宿主扩展页签时，显示一个 Octo 页签；没有时，在侧栏底部提供「Octo 频道」入口。私聊、群聊和子区自动归档；可按类型筛选、搜索并打开原生 DSH 会话。
- **进度**：长回复优先使用 Octo 推理过程模板，或使用展示卡；卡片不可用时回退到“正在输入”。卡片只显示 DSH 的工作阶段和耗时。进度失败不阻止正文；明确失败有提示，旧任务不会自动重放。

文件、媒体、任意内容卡和卡片按钮回调未接入。具体接口与验证边界见[能力矩阵](OCTO-COVERAGE.md)。

自动测试覆盖权限校验、断线重连、收件确认和重复消息去重。隔离 DSH Web 与 IM Connect 共同加载，用模拟 Octo 和模型检查规则、会话隔离和进度卡更新。可另传 Playwright 模块与 Chromium 路径，验证浏览器设置页。

复跑宿主检查（需安装指定版本的 DSH CLI；脚本使用临时 DSH home 和测试凭据）：

```sh
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js events
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js websocket /absolute/path/to/playwright-core/index.mjs /absolute/path/to/chrome
```

浏览器验收默认与 IM Connect 1.0.30 共存。设置 `DSH_OCTO_SMOKE_CODEX_UI=2.0.19` 可同时安装该版本的 Codex UI；可选的 `DSH_OCTO_SMOKE_SCREENSHOTS` 指向已存在的截图目录，截图只含测试会话。
