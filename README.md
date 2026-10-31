# BB Account Limits

A quota dashboard for [BB](https://getbb.app). See subscription windows, account pools, reset forecasts and suggested usage pace across independent sources.

[简体中文](docs/README.zh-CN.md) · [Architecture](docs/architecture.md) · [Weekly pace algorithm](weekly-pace.md)

![Account Limits dashboard with independent, collapsible quota sources](docs/screenshots/dashboard.png)

## What it does

- Reads existing BB providers (including named Codex homes and supported ACP providers) through BB's public provider maintenance API, on each connected machine.
- Reads Claude and Codex accounts from **BB Account Pooler** through its public usage API.
- Optionally reads **CLI Proxy** OAuth accounts: Claude, Codex, Grok, Antigravity and Kimi. Other providers can expose verified cached quota signals.
- Gives each source a collapsible section; folding, account/pool view and remaining/used mode persist in the browser.
- Shows each account's reset time. Pool bars use shades for upcoming reset batches, with hover details.
- Shows weekly pacing suggestions without inventing missing quota or treating model caps as extra capacity.
- Separates the pool-wide pace from its nearest reset batch: current weekly remainder, exhausted or 5h-restricted accounts, and which allowance to use first.
- Keeps separate sources, machines and model groups separate. Account records are not a count of independent subscriptions.

**No CLI Proxy configuration means no CLI Proxy section and no proxy requests.** Account Pooler is optional too: an absent or disabled plugin is skipped. If a configured source fails, its error or cached snapshot remains visible.

This plugin displays subscription quotas. Token counts and estimated API cost belong to the separate BB Usage plugin. It does not register executable agents or modify model routing.

## Install

Requires a BB build supporting Plugin SDK **0.6.37** or newer (including public `provider-usage.v1` discovery and plugin-owned icons). Requires Node.js 22+ when installing/building source.

Install the stable Git release:

```sh
bb plugin install 'git:https://github.com/hxy91819/bb-plugin-account-limits.git@v0.3.4' --yes
```

For the current 0.4.0 source with native BB accounts and the compact footer, install `main`:

```sh
bb plugin install 'git:https://github.com/hxy91819/bb-plugin-account-limits.git@main' --yes
```

Or download the prebuilt `.tgz` and checksums from [Releases](https://github.com/hxy91819/bb-plugin-account-limits/releases), verify the SHA-256, then:

```sh
tar -xzf bb-plugin-account-limits-0.3.4.tgz
npm install --prefix ./package --omit=dev --omit=optional --ignore-scripts
bb plugin install ./package --yes
```

The archive contains portable JavaScript bundles, source, manifest and icons; no OS-specific executable or credentials. The dependency step above is required because BB rebuilds the frontend for local-path installs. Node.js 22+ is needed for this archive workflow too. Use the same plugin on Linux, macOS or Windows in a compatible BB runtime. Individual upstream quota endpoints still depend on the service and your account permissions.

Open **账户额度** in BB's sidebar. Existing usage-capable BB providers appear under **BB 已有账户** without extra configuration. Verified native Codex/Claude collectors record successful collection times for weekly pacing; third-party sources without reliable observation times keep pacing unknown. Account Pooler and CLI Proxy remain optional independent sources.

Click the bottom-left **账户额度** icon to open the disclosure; startup and plugin reload do not force it open or replace another plugin’s disclosure. It offers a compact service selector, remaining quota bars, reset countdowns, weekly pace and a link to the full dashboard. The compact header keeps an at-a-glance percentage card for each service. These cards always summarize account pools using the full dashboard’s capacity weights, prioritizing all-model weekly windows. Short session limits and model caps do not replace a reported total week. Independent model-family weeks stay separate. When Claude has both reported and missing all-model weeks, the card shows the capacity-weighted percentage of reporting accounts with `*`; hover explains coverage and that the value does not represent the whole pool. Partial coverage of any displayed window uses the same marker. If no account reports a total week, the card keeps `—`. Expanded details retain the separate missing-week pool. Expanded details still follow the account/pool selection. Cursor’s subscription and on-demand percentages sit side by side in one card, with independent colors and equal card heights. Cursor subscription allowance and on-demand budget are shown as separate percentages with independent warning colors and reminder names; a missing budget window is omitted rather than inferred. The compact view follows the full page’s remaining/used and account/pool selections; labels, bars and service percentages update together without extra quota requests. Failed records are hidden by default; the toggle is shared across both views and remembered per browser. The underlying source snapshot and its failures are retained.

Quota reminders default to enabled. Opening the app, or first enabling reminders, establishes a quiet baseline from the first usable snapshot; existing low quota stays visible in the panel without a startup toast. Later observations crossing 80% or 95% used produce one toast per resource-pool window, using the same capacity weights and subscription-tier boundaries as the pool view. A depleted individual account does not notify while its pool stays below the threshold. Model families, Claude missing-total-week pools and Cursor budgets stay separate; incomplete or overdue pool windows do not fall back to individual-account alerts. If a failed account loses its tier, reminders pause for that provider rather than treating its remaining accounts as a complete pool. The browser stores reminder history locally, so refreshing or reopening the same BB site does not repeat an unchanged warning. Recovering below a threshold re-arms it. A new known reset shared by every member also re-arms the pool; moving the earliest reset in a staggered pool does not repeat the same warning. Alert identities belong to source/machine/provider/type/window pools, so account labels, account order and the selected view do not create separate reminders. If browser storage is unavailable, deduplication lasts for the current page only. Cached source failures and overdue windows do not create alerts. While the app is visible, a shared monitor checks every five minutes, including with the disclosure closed. You can disable reminders in either view. To replace BB's official usage display on this installation, disable `bb--provider-usage`; providers themselves remain enabled.

Click or tap outside the compact disclosure to close it. Scrolling and internal settings keep it open; outside controls still receive their activation and retain input focus. The footer icon and Escape also close it through BB's existing controls.

Weekly quota is the main meter in every view. Each matching 5h window appears below its own weekly/model-family quota as a small status with its percentage, reset time and any short-term exhaustion warning. Missing weekly data stays unknown, including compact summary cards. Pool capacity is always 100%: three equally weighted accounts used at 1%, 18% and 0% give 6.3% used for the pool. Pooled percentages retain one decimal and state how many reporting accounts were aggregated; incomplete coverage stays explicit.

## Optional CLI Proxy setup

On each enrolled machine that should query a proxy, create `~/.config/bb/account-limits/local.json` (or `$XDG_CONFIG_HOME/bb/account-limits/local.json`). `ACCOUNT_LIMITS_LOCAL_CONFIG` can point to a different file.

```json
{
  "cliproxy": {
    "managementBaseUrl": "http://127.0.0.1:8317/v0/management",
    "managementKeyEnv": "CLIPROXY_MANAGEMENT_KEY"
  }
}
```

Provide the key to the **BB host process environment**. Alternatively use `managementKeyFile` with an absolute path to a UTF-8 file containing the key. The environment variable takes priority. Keys stay on the enrolled host; they are never sent to the frontend. See [config.example.json](config.example.json).

Reload after changing configuration:

```sh
bb plugin reload account-limits
```

All discovered OAuth providers are included by default. An optional top-level `enabledProviders` array filters them (for example `["cliproxy-claude", "cliproxy-codex"]`). Account overrides support labels, `poolWeight`, `enabled: false`, and cached signal mappings. The source is disabled by omitting `cliproxy`, setting it to `null`, or setting `cliproxy.enabled` to `false`. No localhost scanning or automatic login occurs.

CLI Proxy's API-key-only routes are not discovered as OAuth accounts. Muse can expose models without exposing subscription usage; missing data is not displayed as zero or unlimited.

## Quota semantics

CLI Proxy Claude reads the official OAuth profile alongside usage, so Pro, Max 5x, Max 20x, Team and Enterprise use separate subscription pools. Team/Enterprise seat tiers remain distinct when reported, even if their rate-limit multiplier matches a personal Max plan. Profile failures preserve usable quota in the unidentified cohort; verified tiers also label cached quota. Account records and Team seats are not counts of independent subscriptions. Antigravity's Claude/GPT allowance stays in its own source and model-family pool.

Claude's all-model weekly allowance and Fable/Opus model caps have different denominators. Model caps appear under the total week and are never added to it. Accounts that do not report all-model weekly quota form a separate pool.

Pool averages use `poolWeight` (default 1); reset segments use each account's own timestamp. Weekly advice compares remaining quota with a uniform seven-day budget, with individual near-reset opportunities in its hover explanation. A visible nearest-reset summary identifies only the earliest reported batch; its percentages always mean each account's remaining week, even in used mode. Hover shows the individual accounts. Fully unused accounts stay included, overdue/stale observations await confirmation, and unknown reset times are explicit. It is an estimate of spending pace, not a prediction of future consumption. Stale, incomplete or overdue measurements are not promoted to available quota.

Refresh-all reads available sources; a card refresh targets only its source and provider. Proxy quotas are cached for 30 minutes. Folding a section does not send extra requests. Account Pooler owns its own quota cache.

For command-line inspection:

```sh
bb account-limits
bb account-limits --host <host-id>
```

`--host` filters host-local proxy data; Account Pooler is shared. The public read RPC is `readAccountLimits`. The legacy `readCliproxyUsage` RPC and proxy cache table names remain compatible with the earlier local plugin.

## Development

```sh
npm ci
npm run check
npm run build
npm run package
```

Tests use fictional accounts and offline HTTP fixtures. See [architecture](docs/architecture.md) before adding another source. Runtime code uses only the public BB SDK, and does not read Account Pooler credential files or private BB modules.

The compact scrolling regression uses Chromium for real overflow measurements. Opt in with an explicitly provisioned browser: `CHROME_BIN=/path/to/chrome npm run check`. Without `CHROME_BIN`, the Node-only suite skips this browser integration test and has no system-browser dependency.

The project is extracted from the owner's earlier account-limits tool. The same `account-limits` ID preserves the existing local cache and display preferences. Optional ACP agent launchers from that tool are intentionally outside this standalone quota dashboard; configure agents separately before upgrading if you used those launchers.

MIT licensed; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

When the pool has usable Codex quota, both panels and reminders prefer it over native Codex entries. Native Codex remains a fallback if the pool fails. Other services, including Cursor SDK, remain visible. Provider enablement, routing and raw observations are unchanged.
