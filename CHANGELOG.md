# Changelog

## 0.4.0

- Close the compact disclosure on outside clicks/taps without intercepting scrolling, internal controls or the native footer toggle; preserve focus on outside inputs.

- Use BB's single sidebar scroll viewport for compact quotas, avoiding nested scrolling and interrupted gestures in long account lists.

- Separate subscription tiers before pool aggregation across full/compact views, weekly pacing, reset forecasts and public quota resources; keep Google AI Ultra and Pro in distinct pools.

- Read Antigravity quotas from daily with a versioned client identity to avoid production Gemini zero-usage placeholders; fill missing families through a bounded production fallback without replacing measured daily data.

- Preserve small nonzero quota percentages near 0%/100% in cards and meters instead of rounding them to empty or full.

- Place weekly pace badges below progress bars so adjacent session and weekly bars stay aligned on mobile.

- Establish a quiet reminder baseline on page entry so existing low quota does not pop up again when browser history is missing or unavailable.

- Mark generous weekly pace in green across compact service percentages, quota values, bars and badges; preserve independent Gemini/Claude-GPT states.

- Show measurable Claude weekly quota with a partial-coverage asterisk in compact cards; keep wholly missing weeks unknown and details separately pooled.

- Persist quota reminder history across page reloads and re-entry; retain higher-threshold and reset-cycle alerts.

- Fix compact service percentages to summarize weighted pools and prioritize weekly budgets, retaining independent model families and unknown total weeks.

- Read existing BB usage-capable providers alongside optional Account Pooler and CLI Proxy sources.
- Add a compact sidebar footer with shared used/remaining and account/pool preferences, default failure hiding, and 80%/95% reminders at the top right.
- Show Cursor subscription and on-demand budgets separately, and prefer usable pooled Codex quotas over duplicate native entries.
- Preserve cached observations on discovery failures and record fresh native Codex/Claude collection times for weekly pacing.
- Keep ACP configuration and execution independent of the dashboard; verified tasks finish with a commit and push.

## 0.3.4 - 2026-10-18

- Read Antigravity quotas from the production summary endpoint to restore Gemini weekly and 5-hour windows alongside Claude/GPT.
- Keep daily project/plan discovery, separate family windows and the existing request count.

## 0.3.3 - 2026-10-17

- Show the nearest weekly reset batch with individual remaining, exhausted or 5h-restricted states.
- Label pool-wide pacing explicitly and highlight existing near-reset priority opportunities.
- Keep unknown/stale/overdue quota pending confirmation; retain unused accounts in the nearest batch.

## 0.3.2 - 2026-10-16

- Replace the crowded quota mark with a simple gauge that stays clear at sidebar sizes.
- Use the same gauge in plugin branding, sidebar navigation and the dashboard header.

## 0.3.1 - 2026-10-16

- Normalize Antigravity quota-name suffixes in linear time, including unusually long upstream labels.
- Add isolated regression coverage and preserve existing label semantics.

## 0.3.0 - 2026-10-16

- Publish a standalone quota dashboard using a source-adapter registry.
- Make CLI Proxy opt-in; omit unconfigured machines and absent/disabled Account Pooler.
- Add persistent source folding and a custom theme-aware quota icon.
- Preserve account pools, per-reset recovery segments, weekly pacing advice and public usage RPCs.
- Remove machine-specific optional ACP launchers from the quota plugin.
