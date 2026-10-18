# Source architecture

```text
Host-local optional CLI Proxy -> normalized provider snapshot -> SQLite cache --+
BB Account Pooler public RPC -> normalized provider snapshot -> owner cache ----+-> source registry -> dashboard
                                                                              +-> source-specific refresh
```

The domain types are `QuotaAccount`, `ProviderSnapshot`, `QuotaSourceId` and `AccountLimitsPanelSnapshot` in `contract.ts`. The older `cliproxy*` wire names are retained only for upgrade compatibility. Sources own availability, discovery, authentication, errors and caching; the shared UI owns cards, folds, account/pool aggregation, recovery segments and weekly pacing.

- `sources.ts`: small `QuotaSource` interface and registry. Selects one source for targeted refresh, skips explicitly unavailable adapters and isolates failures.
- `config.ts`: host-local optional configuration. The default proxy is `null`; no executable paths or account identities are embedded.
- `host.ts`, `usage.ts`: CLI Proxy adapter. `cliproxyStatus` reads configuration only. Unconfigured hosts do no quota I/O. Tokens are substituted by CLI Proxy for authoritative usage endpoints; verified cached signals are a fallback. Antigravity discovers its project/plan on `daily-cloudcode-pa` but reads `retrieveUserQuotaSummary` on production `cloudcode-pa`: the daily summary can return HTTP 200 with only Claude/GPT and omit Gemini. Model catalog discovery is independent of quota summary selection.
- `server.ts`: host discovery, proxy cache and public RPC/CLI wiring. `createPanelSnapshotReader` checks host configuration before considering cached quota; removing configuration clears old proxy rows. Empty config does not become an error source. Hosts with no previous data and no reachable adapter stay absent.
- `account-pool-panel.ts`: consumes only Account Pooler's public `provider-usage.v1.listResources/getResource`. An unavailable installed source retains its last observation with a warning. Account Pooler is listed only once because it is shared across machines.
- `usage-source.ts`: exposes only proxy resources to BB's native Provider Usage consumer; it does not export Account Pooler back into itself. Discovery is cache-only. Existing resource IDs are retained.
- `pool-reset.ts`: selects the earliest reported weekly reset batch, retaining unused accounts and each individual remainder/state. It reuses per-account weekly pace quality checks, keeps overdue observations pending, and marks unreported reset times explicitly.
- `pool.ts`, `pool-recovery.ts`, `weekly-pace.ts`: pure shared calculations. Sources and independent window identities are never combined. Missing all-model weekly quota is isolated, not interpreted as unlimited.
- `app.tsx`, `panel-styles.ts`: source-level native disclosure controls, scoped host-token CSS, source/provider refresh, theme-aware custom SVG glyph. Fold state is local to this browser and independent of account/pool and display mode.

To add a source, extend the source ID schema, implement a `QuotaSource` adapter returning normalized accounts with stable window IDs and real observation times, register it in the server and add its presentation name. Include tests for absence, source failure, targeted refresh, incomplete measurements and model-window identity. Do not embed another service's authentication or storage rules into shared pool logic.

No live tokens, prompts, machine addresses, named personal accounts or agent launch wrappers are packaged. The host must be able to reach its configured service; a UI client does not need that access. Credentials remain host-local. Source Git installs are built by BB; release archives also include the generated portable bundles and their SDK metadata.
