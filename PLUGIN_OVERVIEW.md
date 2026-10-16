## One place for subscription limits

See Claude and Codex accounts from BB Account Pooler alongside an optional CLI Proxy source. Each source has its own collapsible group, with account and pool views, remaining or used percentages, and reset countdowns.

Pool bars show upcoming recovery batches with different shades. Weekly pacing labels explain when a reported allowance is relatively generous or tight. Model-specific caps stay subordinate to all-model weekly limits, and missing data stays unknown.

## Optional sources

BB Account Pooler uses its public usage interface and needs enabled accounts. CLI Proxy requires an explicit management URL and a host-local key environment variable or key file. Without that configuration, no proxy section or proxy quota requests appear. A failing configured source does not hide other sources.

## Requirements

A BB build with Plugin SDK 0.6.37 or newer is required. Source installation needs Node.js 22 or newer. This plugin displays account quotas; it does not register agents, change routing, or provide token-cost accounting.

Install instructions and configuration examples are in the [project README](https://github.com/hxy91819/bb-plugin-account-limits).
