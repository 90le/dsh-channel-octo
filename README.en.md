# DSH Channel Octo

Connect Octo to DeepSeek Harness Web. Each bot has a dedicated assistant with its own workspace, model, preset, and permissions. The plugin supports direct messages, groups, topics, attachments, interactive prompts, and progress cards.

[中文文档与截图](README.md) · [Community marketplace](https://awesome-dsh-plugin.com/p/90le/dsh-channel-octo/) · [Stable releases](https://github.com/90le/dsh-channel-octo/releases/latest)

1. Use Node.js 24 or 26 with DSH Web 0.2.1-rc.5 or 0.2.2-rc.1. Download the `.tgz` from GitHub Releases and install it with `dsh plugin --profile web add /absolute/path/dsh-channel-octo-<version>.tgz`.
2. Restart DSH Web. Official Octo is the default; existing configured endpoints are preserved. To use a self-hosted instance, save its HTTPS API address in **Settings → Octo Channel → Bot Accounts → Octo server**, then restart DSH Web. Each server keeps separate bots, credentials and conversations.
3. In **Settings → Octo Channel → Bot Accounts**, add a bot, verify its token, select a workspace and model, and enable receiving messages. Start with a direct message from a permitted account. Use a User Bot for groups and topics; App Bots are limited to authorized direct messages.

The plugin starts without receiving messages or granting tools. New bots default to text-only. Available permission presets come from DSH; an explicitly configured `hostPermissions` list continues to restrict them, including an empty list. Review direct-message access, group and topic rules, and tool permissions before enabling a bot. Keep tokens out of public issues and screenshots. See the [capability matrix](OCTO-COVERAGE.md) for platform limits.

Enable **Allow file attachments** for the bot to handle files. The official Octo endpoint uses built-in storage origins; no manual domain setup is required. For self-hosted Octo, configure exact HTTPS origins via `mediaUploadOrigins` and `mediaDownloadOrigins`. Each explicit list replaces its default, even when empty.
