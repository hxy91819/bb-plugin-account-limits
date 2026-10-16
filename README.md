# BB Account Limits

A quota dashboard for [BB](https://getbb.app). See subscription windows, account pools, reset forecasts and suggested usage pace across independent sources.

[简体中文](docs/README.zh-CN.md) · [Architecture](docs/architecture.md) · [Weekly pace algorithm](weekly-pace.md)

![Account Limits dashboard with independent, collapsible quota sources](docs/screenshots/dashboard.png)

## What it does

- Reads Claude and Codex accounts from **BB Account Pooler** through its public usage API.
- Optionally reads **CLI Proxy** OAuth accounts: Claude, Codex, Grok, Antigravity and Kimi. Other providers can expose verified cached quota signals.
- Gives each source a collapsible section; folding, account/pool view and remaining/used mode persist in the browser.
- Shows each account's reset time. Pool bars use shades for upcoming reset batches, with hover details.
- Shows weekly pacing suggestions without inventing missing quota or treating model caps as extra capacity.
- Keeps separate sources, machines and model groups separate. Account records are not a count of independent subscriptions.

**No CLI Proxy configuration means no CLI Proxy section and no proxy requests.** Account Pooler is optional too: an absent or disabled plugin is skipped. If a configured source fails, its error or cached snapshot remains visible.

This plugin displays subscription quotas. Token counts and estimated API cost belong to the separate BB Usage plugin. It does not register executable agents or modify model routing.

## Install

Requires a BB build supporting Plugin SDK **0.6.37** or newer (including public `provider-usage.v1` discovery and plugin-owned icons). Requires Node.js 22+ when installing/building source.

Install the stable Git release:

```sh
bb plugin install 'git:https://github.com/hxy91819/bb-plugin-account-limits.git@v0.3.0' --yes
```

Or download the prebuilt `.tgz` and checksums from [Releases](https://github.com/hxy91819/bb-plugin-account-limits/releases), verify the SHA-256, then:

```sh
tar -xzf bb-plugin-account-limits-0.3.0.tgz
npm install --prefix ./package --omit=dev --omit=optional --ignore-scripts
bb plugin install ./package --yes
```

The archive contains portable JavaScript bundles, source, manifest and icons; no OS-specific executable or credentials. The dependency step above is required because BB rebuilds the frontend for local-path installs. Node.js 22+ is needed for this archive workflow too. Use the same plugin on Linux, macOS or Windows in a compatible BB runtime. Individual upstream quota endpoints still depend on the service and your account permissions.

Open **账户额度** in BB's sidebar. With Account Pooler enabled and accounts added, no extra configuration is needed.

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

Claude's all-model weekly allowance and Fable/Opus model caps have different denominators. Model caps appear under the total week and are never added to it. Accounts that do not report all-model weekly quota form a separate pool.

Pool averages use `poolWeight` (default 1); reset segments use each account's own timestamp. Weekly advice compares remaining quota with a uniform seven-day budget, with individual near-reset opportunities in its hover explanation. It is an estimate of spending pace, not a prediction of future consumption. Stale, incomplete or overdue measurements are not promoted to available quota.

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

The project is extracted from the owner's earlier account-limits tool. The same `account-limits` ID preserves the existing local cache and display preferences. Optional ACP agent launchers from that tool are intentionally outside this standalone quota dashboard; configure agents separately before upgrading if you used those launchers.

MIT licensed; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
