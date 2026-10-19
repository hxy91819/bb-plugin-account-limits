import type { AccountLimitsPanelSnapshot, AccountLimitsReadInput, QuotaAccount } from "./contract.js";
import { aggregateCliproxyPool, groupAccountPools, type PoolWindow } from "./pool.js";
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

export interface QuotaAlert { key: string; level: number; title: string; resetsAt: number | null; }
export function quotaAlerts(snapshot: AccountLimitsPanelSnapshot): QuotaAlert[] {
  return preferCodexPool(snapshot).machines.flatMap(machine => machine.status !== "connected" || machine.error ? [] : machine.providers.flatMap(provider => {
    const accounts = provider.accounts.length ? provider.accounts : [{ key: "provider", label: provider.displayName, usage: provider.usage }];
    return accounts.flatMap(account => {
      if (account.usage.status !== "ok") return [];
      const seen = new Set<string>();
      return account.usage.windows.flatMap(window => {
        const key = JSON.stringify([machine.source ?? "cliproxy", machine.id, provider.id, account.key, ("id" in window ? window.id : null) ?? window.label]);
        if (seen.has(key)) return [];
        seen.add(key);
        const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
        if (Number.isFinite(reset) && reset <= Date.now()) return [];
        const level = window.usedPercent >= 95 ? 2 : window.usedPercent >= 80 ? 1 : 0;
        return [{ key, level, resetsAt: Number.isFinite(reset) ? reset : null,
          title: `${provider.displayName}${account.label === provider.displayName ? "" : ` · ${account.label}`} · ${quotaWindowDisplayLabel(provider.id, window.label) ?? window.label} 已用 ${Math.round(window.usedPercent)}%${level === 2 ? "，额度紧张" : "，请留意余量"}` }];
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
  const legacy = new Map<string, QuotaAccount>();
  if (!provider.accounts.length && provider.usage.status === "ok") {
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
  const accounts = provider.accounts.length ? provider.accounts : [...legacy.values()];
  const groups = groupAccountPools(provider.id, accounts);
  const missingWeekly = groups.find(group => group.id === "without-weekly")?.accounts.length ?? 0;
  const hasReportedWeek = groups.some(group => group.id !== "without-weekly" && group.accounts.some(account =>
    account.usage.status === "ok" && account.usage.windows.some(window => isWeeklyBudget(window.label))));
  return groups.flatMap<CompactPoolSummary>(group => {
    if (group.id === "without-weekly") return hasReportedWeek ? [] : [{ key: group.id, label: "周未报", fullLabel: "总周额度未返回", usedPercent: null,
      detail: `${group.accounts.length} 个账号未返回总周额度，独立统计`, pace: null, partial: false }];
    const pool = aggregateCliproxyPool(group.accounts);
    if (pool.status !== "ok" || !pool.windows.length) return [];
    const weekly = pool.windows.filter(window => isWeeklyBudget(window.label));
    const cursor = pool.windows.filter(window => quotaWindowDisplayLabel(provider.id, window.label) !== undefined);
    const tightest = pool.windows.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b);
    const selected = cursor.length ? cursor : weekly.length ? weekly : [tightest];
    return selected.map((window: PoolWindow) => {
      const cursorLabel = quotaWindowDisplayLabel(provider.id, window.label);
      const label = cursorLabel === "套餐额度" ? "套餐" : cursorLabel === "按量预算" ? "按量"
        : window.label === "7d" ? "周" : window.label.replace(/ 7d$/u, "周");
      const fullLabel = cursorLabel ? `池${cursorLabel}` : isWeeklyBudget(window.label) ? `${label === "周" ? "" : label.replace(/周$/u, " ")}池周额度` : `池 ${window.label}`;
      const pace = isWeeklyBudget(window.label) ? buildWeeklyPace(group.accounts, window.id, now, provider.updatedAt) : null;
      const partial = window.accounts < accounts.length;
      return { key: `${group.id}:${window.id}`, label, fullLabel, usedPercent: window.usedPercent, partial,
        detail: `覆盖 ${window.accounts}/${accounts.length}${group.label ? ` · ${group.label}` : ""}${missingWeekly && isWeeklyBudget(window.label) ? ` · ${missingWeekly} 个账号未返回总周额度` : ""}${partial ? " · * 仅统计已返回该窗口的账号，不代表全池额度" : ""}`,
        pace };
    });
  });
}
