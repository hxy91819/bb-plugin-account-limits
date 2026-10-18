# BB Account Limits

在 BB 中查看订阅额度、账号池、重置分段和周使用节奏。不同来源独立统计，可折叠并记住状态。

![独立、可折叠的额度来源](screenshots/dashboard.png)

- **BB Account Pooler**：自动读取已启用的 Claude、Codex 账号，无须复制登录凭证。
- **CLI Proxy**：可选来源，配置后才出现。没有配置时不显示，也不发送代理请求。
- 保留账号/池视图、剩余/已用切换、重置倒计时、Claude 总周与模型上限关系。
- 池视图标明“整池节奏”，直接显示最近重置的一批账号还有多少周额度、是否耗尽或 5h 暂受限；多账号悬停查看各自余量。摘要始终显示剩余，不随“已用”模式倒转。
- 周建议为“可多用 / 正常用 / 节约用”，数据缺失或过时则暂不判断。多账号分别计算重置时间，临期宽裕账号放在悬停解释中。

安装：

```sh
bb plugin install 'git:https://github.com/hxy91819/bb-plugin-account-limits.git@v0.3.4' --yes
```

包含 BB 已有账户、左下角精简面板和提醒的当前 0.4.0 源码位于 `main`：

```sh
bb plugin install 'git:https://github.com/hxy91819/bb-plugin-account-limits.git@main' --yes
```

也可从 GitHub Releases 下载 `.tgz` 和校验文件，验证后解压，先执行 `npm install --prefix ./package --omit=dev --omit=optional --ignore-scripts` 安装声明的依赖，再执行 `bb plugin install ./package --yes`。本地路径安装会重建前端，因此解压安装也需要 Node.js 22+。需要支持 Plugin SDK 0.6.37 的 BB；源码安装需要 Node.js 22+。安装包是跨平台 JavaScript，不携带本机凭证。

在侧栏打开“账户额度”。插件会自动读取 BB 中已配置且支持额度查询的 provider；Account Pooler 和 CLI Proxy 是可选的额外来源。

点击左下角的“账户额度”按钮打开精简面板；启动或重载插件不会强制展开，也不会覆盖其他插件已打开的面板。精简面板显示服务切换、最紧窗口余量、重置倒计时和周使用节奏，并可跳转完整页面。顶部保留各服务的百分比概览卡片；Cursor 的套餐和按量百分比在同一卡片中并排显示，独立变色，所有卡片保持等高。Cursor 的套餐额度与按量预算分别显示、独立变色和提醒，不合并成一个百分比；未返回的窗口不会补成零。精简面板跟随详情页的“已用/剩余”和“账号/池”设置，标签、百分比和额度条同步切换，无需额外查询。“隐藏获取失败”默认开启，可关闭查看失败记录；偏好在当前浏览器保存，并同步到精简版和完整页面。

额度提醒默认开启：已用达到 80% / 95% 时弹出提示，同一窗口在同一档位不重复提醒，恢复余量后再次越线可重新提醒。可在精简版或完整页面关闭。页面可见时每五分钟检查一次；收起面板后仍检查。已核实的原生 Codex/Claude 每次向上游采集额度，成功后记录采集时间，支持周节奏判断；其他无法确认测量时间的来源保持“暂不判断”。

本机部署可停用官方 `bb--provider-usage`，由这个左下角入口替代；停用官方额度显示不影响 provider 本身。

使用 CLI Proxy 时，在**需要查询代理的机器**创建 `~/.config/bb/account-limits/local.json`：

```json
{
  "cliproxy": {
    "managementBaseUrl": "http://127.0.0.1:8317/v0/management",
    "managementKeyEnv": "CLIPROXY_MANAGEMENT_KEY"
  }
}
```

密钥放进 BB host 进程环境，也可用 `managementKeyFile` 指向密钥文件，环境变量优先。配置后 `bb plugin reload account-limits`。没有配置的机器会自动跳过，已配置但查询失败的来源仍显示错误或缓存。

默认发现代理中全部 OAuth 账号；可用顶层 `enabledProviders` 筛选供应商，用 `accounts` 覆盖显示名、权重或隐藏账号。省略 `cliproxy`、设为 `null` 或 `enabled: false` 都会停用来源。API Key 路由不在 OAuth 账号发现范围；没有 Muse 用量信号时也不会伪造百分比。

该插件不统计对话 token 或预估 API 费用，也不注册可执行 Agent；这些由 BB Usage 和相应 Provider 负责。旧本机工具中的可选 ACP 启动器不属于本开源版，如使用过，需要单独配置。

快捷菜单顶部的服务百分比始终汇总账号池，沿用完整面板的容量权重，优先显示总周额度。单个账号耗尽、5h 限制或模型上限不会替代已报告的总周；不同模型组分别显示，缺总周账号显示“周未报”，悬停可见覆盖率。展开明细仍跟随账号/池选择。

详见英文 README、[架构](architecture.md)和[算法](../weekly-pace.md)。

账号池有可用 Codex 额度时，精简面板、详情页和额度提醒优先使用账号池，隐藏原生 Codex 重复项；池不可用时回退到原生账户。Cursor SDK 等其他服务仍同时展示。此规则不改变 provider 开关、路由或原始观测。
