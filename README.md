# DSH Channel Octo

在 DeepSeek Harness Web 中并列加载的 Octo IM 插件。使用宿主模型和原生会话，支持私聊、群聊和子区的文字、文件与媒体附件，以及展示卡、确认卡和动态回复进度。可选本地白名单或 Octo 好友与成员准入。见[基础方案](PLAN.md)与[完整能力及验收计划](OCTO-COVERAGE.md)。

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
dsh plugin --profile web add /absolute/path/dsh-channel-octo-0.6.5.tgz
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

## 0.6.5

账号管理参照 IM Connect 1.0.30。两个插件可共存，各自保留账号、会话与凭据。默认的文字模式可复用已经在 DSH Web 打开的空闲 Octo 会话。同回合混入其他来源的输入时不会向 Octo 转发。

- **设置 → Octo 渠道 → Bot 账号**：渠道卡片显示账号数量、连接状态和「接收消息」开关；添加与设置使用同一个双栏表单。每个账号独立选择 DSH 已登记的工作区、Agent 预设、模型、推理强度、权限、私聊准入和空闲新会话时间。已有服务器账号自动出现在列表中，沿用原有历史。
- **添加、验证和更换令牌**：在已登录的 DSH Web 页面可用，HTTP 和 HTTPS 均可。服务端固定 Octo API 地址；新令牌仅保存到 DSH 凭据库，不回显。移除接入保留 DSH 会话与历史。
- **权限**：默认为「仅文字（无工具）」。DSH 权限预设由宿主提供；如要开放某个预设，管理员须在部署配置 `hostPermissions` 中明确列出；跟随 Octo 准入时只允许 Octo 确认的 Bot 所有者私聊使用工具，名单模式只允许名单中的用户。群聊和子区始终不执行工具；宿主权限审批仍由 DSH 处理。Agent 提问可在发起任务的授权私聊点选卡片或回复序号和文字。
- **发送方式**：默认排队。启用「插话发送」后，同一获准使用工具的私聊用户可在 WebSocket 下补充文字。附件准备期间，补充要求与附件一起交给模型；模型已开始时，DSH 在可插话的下一步接收补充。其他来源的会话继续按原方式处理。
- **渠道设置**：选择账号后独立配置群聊/子区名单、@ 触发、子区规则、进度和超时。普通配置保存后对新消息立即生效，不中断当前任务；修改工作区、模型或权限会在需要时开新 DSH 会话，旧会话仍可查看。
- **侧栏 → Octo**：有宿主扩展页签时，显示一个 Octo 页签；没有时，在侧栏底部提供「Octo 频道」入口。私聊、群聊和子区自动归档；可按类型筛选、搜索并打开原生 DSH 会话。原生 Octo 页签的「…」和右键打开同一组宿主会话操作。
- **删除会话后继续聊天**：频道列表以 DSH 原生会话是否存在为准，正常刷新会移除已删除项。下一条 Octo 消息自动创建新会话，不再尝试恢复已删除的会话；原消息的去重和投递回执保留。宿主读取失败、格式损坏或会话忙不会当成删除。
- **进度**：长回复优先使用 Octo 推理过程模板，或使用展示卡；卡片不可用时回退到“正在输入”。卡片显示 DSH 的真实步骤、工具执行结果、文件交付数量和耗时，不包含模型原始推理或工具参数。进度失败不阻止正文；明确失败有提示，旧任务不会自动重放。
- **提问与回答**：多题按顺序展示；提交后原卡显示收到的答案并关闭按钮，随后显示下一题。答题期间暂停模型执行计时，整组问题最多等待 15 分钟。服务重启会结束原等待，旧卡改为结束提示，需重新发起提问；不会把旧卡答案误当作新指令执行。
- **文件**：启用账号的文件选项后，已通过准入的私聊、群聊和子区可以接收文件、图片、GIF、语音和视频附件。图片是否可识别取决于所选模型；其他非文本媒体保留为 DSH 附件，不自动转录。发送仅限已启用工具的授权私聊，且仅发送本轮通过 DSH 正式交付的工作区文件。默认每个文件上限 16 MiB；部署需配置确切的 `mediaDownloadOrigins`、`mediaUploadOrigins` HTTPS 来源。文件上传与消息投递任一步无法确认时不会自动重放。
- **群聊前文与引用**：触发后补充当前群主区或当前子区的近期可读消息；不把群历史放进私聊。支持原消息引用、内联引用和有界的合并转发解析。富文本按原顺序接收文字、图片和可识别的附件；发送时用 Octo 原生文字加图片格式，普通文件独立发送。详见[消息兼容矩阵](OCTO-COVERAGE.md)。
- **卡片与安全命令**：在账号的私聊或群聊命令选项开启后，授权操作者可使用 `/help`、`/status`、`/new`、`/card` 和 `/choose`。群聊和子区还要求 Bot 所有者直接 @ Bot。卡片按钮只接受原账号、原会话与指定用户的有效回调。授权用户可直接要求展示卡片；不支持的卡片退回文字。长正文会分段发送。
- **范围**：User Bot（`bf_`）是当前验收目标。没有通用 App Bot 绑定、任意 Adaptive Card 结构、原生逐字流、任意目标主动发送、Octo Drive/Docs 或宿主审批接管。详见[双方源码对照与验收边界](IM-CONNECT-PARITY.md)。

自动测试覆盖权限校验、断线重连、收件确认和重复消息去重。隔离 DSH Web 与 IM Connect 共同加载，用模拟 Octo 和模型检查规则、会话隔离和进度卡更新。可另传 Playwright 模块与 Chromium 路径，验证浏览器设置页。

复跑宿主检查（需安装指定版本的 DSH CLI；脚本使用临时 DSH home 和测试凭据）：

```sh
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js events
DSH_OCTO_SMOKE_DELETE=1 npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js websocket
DSH_OCTO_SMOKE_OWNER=1 npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js websocket
npm run smoke:web -- /absolute/path/to/dsh/lib/bin.js websocket /absolute/path/to/playwright-core/index.mjs /absolute/path/to/chrome
```

浏览器验收默认与 IM Connect 1.0.30 共存。设置 `DSH_OCTO_SMOKE_CODEX_UI=2.0.19` 或 `DSH_OCTO_SMOKE_AUTOMATION` 可加测指定版本；可选的 `DSH_OCTO_SMOKE_SCREENSHOTS` 指向已存在的截图目录，截图只含测试账号和会话。

0.6.5 验证：90 项自动测试通过；Debian 上 DSH `0.2.1-rc.5` 的隔离宿主验证了连续三题的卡片回调、全部答案进入原生工具结果、逐题回执以及答完后继续写入和交付文件。该检查使用模拟 Octo 和模型；真实客户端的点击体验仍需实际使用确认。
