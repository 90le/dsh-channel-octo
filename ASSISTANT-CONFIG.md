# Octo 助理配置：文件、权限和上下文

## 当前做法

「Bot 账号 → 设置 → 专属助理」里的工作区指令区直接管理已绑定工作区根目录的 `AGENTS.md` 和 `SOUL.md`。每个文件独立创建、修改和保存；打开设置或点击重新读取可看到磁盘上的版本。若保存时磁盘版本已变更，保留草稿并拒绝覆盖。共用工作区的助理看到的是同一份文件；需要不同规则或角色时，绑定各自的工作区。

- `AGENTS.md` 写工作规范、操作流程、项目约定。由 DSH 原生指令加载器处理；Octo 不附加同名内容。标准、PTC、创造预设默认加载，极简及不带工具的 Octo 文字预设默认不加载；自定义预设遵循宿主设置。
- `SOUL.md` 写角色、语气、语言和沟通风格。Octo 在每项新任务开始时读取一次，在本次 Octo 任务的运行上下文中使用。更新后，最新上下文取代前面的快照；旧记录仍属于会话历史。普通 Web 请求不主动加载 Octo 的角色说明。
- 旧版存于助理配置的附加文字归档保留，设置页可查看和复制。升级不自动写入任何工作区文件。页面只编辑小于等于 32 KiB 的 UTF-8 普通文件。

## 代表性产品的配置分工

| 产品 | 主要做法 | 对 Octo 的启发 |
| --- | --- | --- |
| [OpenClaw](https://docs.openclaw.ai/gateway/config-agents/workspace-and-bootstrap) · [路由](https://docs.openclaw.ai/concepts/multi-agent) | 工作区引导文件分管规则、身份、用户、工具提示和记忆；渠道绑定与 Agent 工作区分开。 | 两份核心文件足够开始。需要多个角色时优先分工作区与路由。 |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what) · [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles) | 角色归 Agent Profile，项目指令归项目；用户偏好、长期记忆和技能各有生命周期。 | 偏好和记忆需要各自的访问范围与生效时机，不能默认广播到所有群。 |
| [AstrBot](https://docs.astrbot.app/en/use/webui.html) · [会话规则](https://docs.astrbot.app/en/use/custom-rules.html) | 人格、模型、能力、准入在 WebUI 分项配置，支持针对特定会话覆盖人格、知识库等。 | 权限和渠道策略用结构化设置；有实际需求时再加特定渠道的配置覆盖。 |
| [LangBot](https://langbot.app/docs/en/usage/pipelines/readme/) | Bot 绑定 Pipeline，可选执行器、模型、提示词、知识库、MCP 和技能。 | 工具与知识按用途绑定，技能按需使用，避免把所有资料塞进每轮提示。 |
| [Coze](https://www.coze.com/open/docs/guides/agent_quick_start) / [Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-instructions) | 通过可视化界面配置角色指令、工作流、工具、知识和渠道发布。 | 助理配置的关键在能力边界和数据来源，文件数量不是功能完整度。 |

两份 Markdown 足够定义日常工作的规则与角色。模型、工具权限、频道准入继续用结构化设置。后续优先考虑：在编辑区展示当前预设实际加载哪些来源；以用户或会话为范围的可选偏好；按需检索的记忆、知识库与技能。定时和主动行为交给独立调度设置；展示身份继续用账号名与头像。只有明确用途和加载方式时，才增加新的文件入口。
