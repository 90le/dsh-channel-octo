# IM Connect 渠道接入

源版本为 [IM Connect v1.0.34](https://github.com/MichengAI/dsh-im-connect/tree/v1.0.34)（commit `05f163c`，Apache-2.0）。补丁只调整浏览器端的渠道数据接入与测试，不改变 IM Connect 服务端收发、凭据或账号配置。

兼容包继续由 IM Connect 渲染「频道」页。新增 `registry.channelSources` v1：注册者提供固定渠道 ID、名称、稳定的订阅快照和设置入口；每行只有宿主会话 ID 和分组路径。频道数据源注销后由宿主移除；已知 IM Connect 自有行优先，不重复认领。宿主列表暂时没有摘要时不创建假会话行。

从干净的 IM Connect v1.0.34 工作树执行：

1. `git apply /absolute/path/im-connect-v1.0.34-channel-sources.patch`
2. `npm ci --ignore-scripts`，然后 `node scripts/copy-client.mjs`（复用标签中的已构建服务端文件）。
3. `node --test tests/sidebar-channel-source.test.mjs tests/sidebar-host.test.mjs tests/sidebar-lifecycle.test.mjs tests/sidebar-shell-state.test.mjs tests/sidebar-tab-follow.test.mjs`。
4. `npm pack --ignore-scripts` 后先在隔离 DSH profile 安装检查，再由 `dsh plugin --profile web add` 正常安装兼容包。不直接覆盖正在运行的插件文件。
5. 恢复官方 `@michengai/dsh-im-connect@1.0.34` 即取消频道合并；Octo 自动退回独立入口。

兼容接口未提交至 IM Connect 上游；无需访问正式 Octo 服务端，也无需迁移任一插件的数据库。
