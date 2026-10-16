# Changelog

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
