# Octo × DeepSeek Harness 接入方案

## 目标与范围

在 DSH Web `0.2.1-rc.5` 中并列挂载 `dsh-channel-octo` 和 IM Connect `1.0.30`。授权用户在 Octo 私聊专用 Bot，收到同一私聊中的最终文本，下一条消息可续接原生 DSH 会话。使用现有 Web 宿主的模型配置，Octo 连接仅使用出站 HTTPS。独立管理 Bot 和数据；不改 IM Connect，也不读取它的历史和凭据。

0.1.0 范围是白名单纯文本私聊；0.2.0 增加群聊和话题文本；0.3.0 增加读取群和子区规则；0.4.0 增加好友/成员准入与 WebSocket 免 @。会话注册空工具 preset，并在每次创建及恢复时挂载 scoped 工具限制和拒绝 guard。附件、卡片、后台任务、命令路由、通用审批和管理网页仍未实现。[完整能力及后续验收](OCTO-COVERAGE.md)。没有生产 Bot 或正式部署前提。共享 Web 进程不能作为公司数据隔离边界。

## 设计

- **协议**：启动用 `/v1/auth/verify-bot` 检查身份及 Space。HTTP 模式通过 `/v1/bot/events` 接收并按事件 ID 确认；WebSocket 模式采用悟空握手、保活和接收确认。两种模式只选其一，均先入 SQLite 再确认，通过 `/v1/bot/sendMessage` 回复。免 @ 使用 WebSocket。仅供专用 Bot 单实例使用。
- **状态**：一个数据库绑定一个 Octo API、Bot 和 Space。按消息 ID 去重，按私聊对端、群或话题地址绑定独立的原生会话。首版单 worker 串行消费，每轮取得 DSH 自有 handle，监听 claim 和匹配的完成事件；只取已提交的最终文本。持久会话存在但不能恢复时，停止这一条，不悄悄换会话。
- **恢复**：收到消息 → 持久入队 → ACK → 模型执行 → 持久存回复 → 发送。中断前未开始的任务可恢复；执行中断、发出请求但无法确认送达时标记待核查，不能自动重跑或重发。429 确定未接收时有限次延后重试。Octo 的文本发送契约没有可依赖的幂等键；不声称端到端恰好一次。
- **密钥与边界**：Bot token 只由服务环境注入；禁止重定向转发、输出 token 或记录原始 API 响应。数据库含消息内容，放在受限状态目录。Octo Bot 身份和 DSH 模型认证分别管理。

## 验收顺序

1. 本地测试：真实 SQLite 和模拟 Octo HTTP，覆盖准入、64 位 ID、去重、ACK 时序、恢复、发送结果不明。用模拟 DSH 宿主验证会话恢复、轮次关联和工具拒绝。
2. 隔离宿主：同版本 DSH Web 加载两份插件，验证 Octo 生命周期、作用域工具限制、原生会话、停用后 IM Connect 未受影响。使用本地假 Bot/模型或专用测试环境。
3. 目标 Octo：独立 Bot、一名用户，验收两轮私聊、重复事件、重启恢复。验证后再评估群和话题。部署、公司消息和真实模型调用需要对应环境的授权。

## 当前状态

验证记录与待办见 [README](README.md)。参考 [DSH 0.2.1-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5)、[IM Connect 1.0.30 源码](https://github.com/MichengAI/dsh-im-connect/tree/128cd0ce9cacebc6fe57a6f8a47464fff51743a7) 和 [Octo Bot API](https://github.com/Mininglamp-OSS/octo-server/tree/f984d40549f66d56b1e90a048d28315eb12c92df/modules/bot_api)。
