import type { AccountLimitsPanelSnapshot, AccountLimitsReadInput, QuotaAccount } from "./contract.js";
import { aggregateCliproxyPool, groupAccountPools, normalizeCliproxyWindow, type PoolWindow } from "./pool.js";
import { buildWeeklyPace, isWeeklyBudget, type WeeklyPace } from "./weekly-pace.js";

/** Pool precedence affects presentation and reminders only; raw observations stay intact. */
function preferCodexPool(snapshot: AccountLimitsPanelSnapshot): AccountLimitsPanelSnapshot {
  const hasPoolQuota = snapshot.machines.some(machine => machine.source === "account-pool"
    && machine.status === "connected" && !machine.error && machine.providers.some(provider =>
      provider.id === "account-pool:codex" && provider.usage.status === "ok"
      && (provider.accounts.length ? provider.accounts.some(account => account.usage.status === "ok" && account.usage.windows.length > 0)
        : provider.usage.windows.length > 0)));
  if (!hasPoolQuota) return snapshot;
  return { machines: snapshot.machines.flatMap(machine => {
    if (machine.source !== "bb-providers") return [machine];
    const providers = machine.providers.filter(provider => provider.id !== "codex" && !provider.id.startsWith("codex-"));
    return providers.length ? [{ ...machine, providers }] : [];
  }) };
}

/** Filtering is presentation-only: failed records remain in the underlying snapshot. */
export function visibleQuota(snapshot: AccountLimitsPanelSnapshot | null, hideFailures: boolean): AccountLimitsPanelSnapshot | null {
  if (!snapshot) return snapshot;
  const preferred = preferCodexPool(snapshot);
  if (!hideFailures) return preferred;
  return { machines: preferred.machines.flatMap(machine => {
    if (machine.status !== "connected") return [];
    const providers = machine.providers.flatMap(provider => {
      if (!provider.accounts.length) return provider.usage.status === "ok" ? [provider] : [];
      const accounts = provider.accounts.filter(account => account.usage.status === "ok");
      return accounts.length ? [{ ...provider, accounts }] : [];
    });
    return providers.length || machine.providers.length === 0 ? [{ ...machine, providers }] : [];
  }) };
}

export type QuotaRead = (input: AccountLimitsReadInput) => Promise<AccountLimitsPanelSnapshot>;
export interface QuotaUiState {
  snapshot: AccountLimitsPanelSnapshot | null;
  error: string | null;
  loading: boolean;
}

/** One request and snapshot shared by the footer, full page and background monitor. */
export function createQuotaUiStore() {
  let state: QuotaUiState = { snapshot: null, error: null, loading: false };
  let pending: Promise<void> | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: QuotaUiState) => { state = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { generation++; pending = null; state = { snapshot: null, error: null, loading: false }; }
      };
    },
    refresh(read: QuotaRead, input: AccountLimitsReadInput = {}) {
      if (pending) return pending;
      const current = generation;
      publish({ ...state, error: null, loading: true });
      pending = Promise.resolve().then(async () => {
        try {
          const result = await read(input);
          if (current !== generation) return;
          const snapshot = input.source && state.snapshot
            ? { machines: [...state.snapshot.machines.filter(machine => (machine.source ?? "cliproxy") !== input.source), ...result.machines] }
            : result;
          publish({ snapshot, error: null, loading: true });
        } catch (reason) {
          if (current === generation) publish({ ...state, error: reason instanceof Error ? reason.message : "读取账户额度失败。请稍后重试。" });
        } finally {
          if (current === generation) { pending = null; publish({ ...state, loading: false }); }
        }
      });
      return pending;
    },
  };
}
export type QuotaUiStore = ReturnType<typeof createQuotaUiStore>;

/** Account records and legacy flattened observations share the same pool inputs. */
function providerAccounts(provider: AccountLimitsPanelSnapshot["machines"][number]["providers"][number]): readonly QuotaAccount[] {
  if (provider.accounts.length) return provider.accounts;
  const legacy = new Map<string, QuotaAccount>();
  if (provider.usage.status === "ok") {
    for (const window of provider.usage.windows) {
      const key = window.accountLabel ?? "provider";
      let account = legacy.get(key);
      if (!account) {
        account = { key, label: key, weight: 1, usage: { status: "ok", planLabel: provider.usage.planLabel, windows: [] } };
        legacy.set(key, account);
      }
      const prefix = window.accountLabel ? `${window.accountLabel} · ` : "";
      if (account.usage.status === "ok") account.usage.windows.push({ ...window,
        label: prefix && window.label.startsWith(prefix) ? window.label.slice(prefix.length) : window.label });
    }
  }
  return [...legacy.values()];
}

export interface QuotaAlert { key: string; level: number; title: string; resetsAt: number | null; }
export function quotaAlerts(snapshot: AccountLimitsPanelSnapshot): QuotaAlert[] {
  const now = Date.now();
  return preferCodexPool(snapshot).machines.flatMap(machine => machine.status !== "connected" || machine.error ? [] : machine.providers.flatMap(provider => {
    const accounts = providerAccounts(provider);
    // Failed reads lose their tier in the normalized DTO. They may belong to any
    // current cohort, so do not let regrouping manufacture a smaller full pool.
    if (accounts.some(account => account.usage.status !== "ok")) return [];
    const groups = groupAccountPools(provider.id, accounts);
    const emptyTypes = new Set(groups.filter(group => group.accounts.some(account =>
      account.usage.status === "ok" && account.usage.windows.length === 0)).map(group => group.typeId));
    if (emptyTypes.has("default")) return [];
    return groups.flatMap(group => {
      // An empty observation could have belonged to either Claude availability
      // subgroup; retain the type boundary when suppressing incomplete data.
      if (emptyTypes.has(group.typeId)) return [];
      const pool = aggregateCliproxyPool(group.accounts);
      if (pool.status !== "ok") return [];
      return pool.windows.flatMap(window => {
        // A partial/overdue observation cannot stand in for the complete pool.
        if (window.accounts !== pool.totalAccounts) return [];
        const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
        if (Number.isFinite(reset) && reset <= now) return [];
        const resets = group.accounts.map(account => {
          const raw = account.usage.status === "ok" ? account.usage.windows.find(candidate =>
            (candidate.id ?? normalizeCliproxyWindow(candidate.label).id) === window.id) : undefined;
          return raw?.resetsAt ? Date.parse(raw.resetsAt) : NaN;
        });
        // Only a synchronized whole-pool reset forms a single known cycle.
        // Moving the earliest reset in a staggered pool must not re-notify it.
        const sharedReset = resets.every(Number.isFinite) && new Set(resets).size === 1 ? resets[0]! : null;
        const key = JSON.stringify([machine.source ?? "cliproxy", machine.id, provider.id, "pool", group.id, window.id]);
        const level = window.usedPercent >= 95 ? 2 : window.usedPercent >= 80 ? 1 : 0;
        const label = quotaWindowDisplayLabel(provider.id, window.label)
          ?? (window.label === "scoped" ? "Fable 周上限" : window.label === "Opus 7d" ? "Opus 周上限" : window.label.replace(/\b7d$/u, "周额度"));
        return [{ key, level, resetsAt: sharedReset,
          title: `${provider.displayName} · ${machine.displayName}${group.label ? ` · ${group.label}` : ""} 资源池 · ${label} 已用 ${formatQuotaPercent(window.usedPercent, 1)}%${level === 2 ? "，额度紧张" : "，请留意余量"}（${window.accounts} 个账号汇总）` }];
      });
    });
  }));
}

export interface QuotaAlertStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
interface AlertHistoryEntry { level: number; resetsAt: number | null; }
const alertHistoryKey = "account-limits.alert-history.v1";

/** Seed the first usable snapshot quietly; notify only subsequent crossings. */
export function createQuotaAlertTracker(storage?: QuotaAlertStorage) {
  let levels = new Map<string, AlertHistoryEntry>();
  let initialized = false;
  return (snapshot: AccountLimitsPanelSnapshot): QuotaAlert[] => {
    // Read again before deciding so another open page's recorded alerts are seen.
    try {
      const raw = storage?.getItem(alertHistoryKey);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved) && saved.every(entry => Array.isArray(entry) && entry.length === 2
        && typeof entry[0] === "string" && entry[1] !== null && typeof entry[1] === "object"
        && [0, 1, 2].includes(entry[1].level)
        && (entry[1].resetsAt === null || typeof entry[1].resetsAt === "number" && Number.isFinite(entry[1].resetsAt)))) {
        levels = new Map(saved.map(([key, value]) => [key, { level: value.level, resetsAt: value.resetsAt }]));
      }
    } catch { /* Unavailable or invalid storage keeps this page's in-memory state. */ }
    const observations = quotaAlerts(snapshot);
    const baseline = !initialized;
    if (observations.length) initialized = true;
    const alerts = observations.filter(alert => {
      const previous = levels.get(alert.key);
      const sameCycle = previous && (previous.resetsAt === null || alert.resetsAt === null || previous.resetsAt === alert.resetsAt);
      levels.set(alert.key, { level: alert.level, resetsAt: alert.resetsAt ?? previous?.resetsAt ?? null });
      return previous !== undefined && alert.level > (sameCycle ? previous.level : 0);
    });
    try { storage?.setItem(alertHistoryKey, JSON.stringify([...levels])); }
    catch { /* The tracker still deduplicates while this page stays open. */ }
    return baseline ? [] : alerts;
  };
}

/** Cursor subscription allowance and on-demand budget are separate denominators. */
export function quotaWindowDisplayLabel(providerId: string, label: string): string | undefined {
  if (!providerId.includes("cursor")) return undefined;
  if (/^plan usage$/iu.test(label)) return "套餐额度";
  if (/^on-demand spend$/iu.test(label)) return "按量预算";
  return undefined;
}

/** Avoid displaying a positive near-boundary fraction as exactly empty or full. */
export function formatQuotaPercent(value: number, precision: 0 | 1 = 0): string {
  if (value > 0 && value < 0.1) return "<0.1";
  if (value > 99.9 && value < 100) return ">99.9";
  if (precision === 1 || value > 0 && value < 1 || value > 99 && value < 100) return String(Number(value.toFixed(1)));
  return String(Math.round(value));
}

/** Presentation pairing only: preserve the model suffix added by source adapters. */
export function quotaWindowPeriod(label: string): { family: string; period: "5h" | "7d" } | null {
  const separator = label.indexOf(" · ");
  const base = separator < 0 ? label : label.slice(0, separator);
  const model = separator < 0 ? "" : label.slice(separator + 3);
  const match = /^(?:(.+) )?(5h|7d)$/u.exec(base)
    ?? /^(?:(.+) )?(5h|7d)$/u.exec(normalizeCliproxyWindow(base).id);
  return match ? { family: [match[1], model].filter(Boolean).join(" · "), period: match[2] as "5h" | "7d" } : null;
}

export interface CompactPoolSummary {
  key: string;
  label: string;
  fullLabel: string;
  usedPercent: number | null;
  detail: string;
  pace: WeeklyPace | null;
  /** Only reporting accounts enter the denominator; missing observations are excluded. */
  partial: boolean;
}

/** Service cards always describe a pool, independent of the expanded account view. */
export function compactPoolSummaries(provider: AccountLimitsPanelSnapshot["machines"][number]["providers"][number], now: number): CompactPoolSummary[] {
  const accounts = providerAccounts(provider);
  const groups = groupAccountPools(provider.id, accounts);
  return groups.flatMap<CompactPoolSummary>(group => {
    const compatibleGroups = groups.filter(other => other.typeId === group.typeId);
    const typeAccounts = compatibleGroups.flatMap(other => [...other.accounts]);
    const missingWeekly = compatibleGroups.find(other => other.kind === "without-weekly")?.accounts.length ?? 0;
    const hasReportedWeek = compatibleGroups.some(other => other.kind !== "without-weekly" && other.accounts.some(account =>
      account.usage.status === "ok" && account.usage.windows.some(window => isWeeklyBudget(window.label))));
    if (group.kind === "without-weekly") return hasReportedWeek ? [] : [{ key: group.id, label: "周未报", fullLabel: "总周额度未返回", usedPercent: null,
      detail: `${group.accounts.length} 个账号未返回总周额度，独立统计${group.typeLabel ? ` · ${group.typeLabel}` : ""}`, pace: null, partial: false }];
    const pool = aggregateCliproxyPool(group.accounts);
    if (pool.status !== "ok" || !pool.windows.length) return [];
    const weekly = pool.windows.filter(window => isWeeklyBudget(window.label));
    const cursor = pool.windows.filter(window => quotaWindowDisplayLabel(provider.id, window.label) !== undefined);
    const primary = pool.windows.filter(window => quotaWindowPeriod(window.label)?.period !== "5h");
    if (!primary.length) return [{ key: `${group.id}:weekly-unknown`, label: "周未报", fullLabel: "周额度未返回", usedPercent: null,
      detail: `${group.accounts.length} 个账号仅返回 5h 窗口，周额度未知`, pace: null, partial: false }];
    const tightest = primary.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b);
    const selected = cursor.length ? cursor : weekly.length ? weekly : [tightest];
    return selected.map((window: PoolWindow) => {
      const cursorLabel = quotaWindowDisplayLabel(provider.id, window.label);
      const label = cursorLabel === "套餐额度" ? "套餐" : cursorLabel === "按量预算" ? "按量"
        : window.label === "7d" ? "周" : window.label.replace(/ 7d$/u, "周");
      const fullLabel = cursorLabel ? `池${cursorLabel}` : isWeeklyBudget(window.label) ? `${label === "周" ? "" : label.replace(/周$/u, " ")}池周额度` : `池 ${window.label}`;
      const pace = isWeeklyBudget(window.label) ? buildWeeklyPace(group.accounts, window.id, now, provider.updatedAt) : null;
      const partial = window.accounts < typeAccounts.length;
      return { key: `${group.id}:${window.id}`, label, fullLabel, usedPercent: window.usedPercent, partial,
        detail: `${window.accounts} 个账号汇总 · 覆盖 ${window.accounts}/${typeAccounts.length}${group.label ? ` · ${group.label}` : ""}${missingWeekly && isWeeklyBudget(window.label) ? ` · ${missingWeekly} 个账号未返回总周额度` : ""}${partial ? " · * 仅统计已返回该窗口的账号，不代表全池额度" : ""}`,
        pace };
    });
  });
}
