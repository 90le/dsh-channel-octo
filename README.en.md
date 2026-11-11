# DSH Channel Octo

Connect Octo to DeepSeek Harness Web. Each bot has a dedicated assistant with its own workspace, model, preset, and permissions. The plugin supports direct messages, groups, topics, attachments, interactive prompts, and progress cards.

[中文文档与截图](README.md) · [Community marketplace](https://awesome-dsh-plugin.com/p/90le/dsh-channel-octo/) · [Stable releases](https://github.com/90le/dsh-channel-octo/releases/latest)

1. Use Node.js 24 or 26 with DSH Web 0.2.1-rc.5 or 0.2.2-rc.1. Download the `.tgz` from GitHub Releases and install it with `dsh plugin --profile web add /absolute/path/dsh-channel-octo-0.26.14.tgz`.
2. Set the trusted Octo HTTPS API base (`apiBase`) in the Web profile as shown in the [installation guide](README.md#安装与首次连接), then restart DSH Web.
3. In **Settings → Octo Channel → Bot Accounts**, add a bot, verify its token, select a workspace and model, and enable receiving messages. Start with a direct message from a permitted account. Use a User Bot for groups and topics; App Bots are limited to authorized direct messages.

The plugin starts without receiving messages or granting tools. Review direct-message access, group and topic rules, and tool permissions before enabling a bot. Keep tokens out of public issues and screenshots. See the [capability matrix](OCTO-COVERAGE.md) for platform limits.
