import type { AccountLimitsPanelSnapshot, AccountLimitsReadInput } from "./contract.js";

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

export interface QuotaAlert { key: string; level: number; title: string; }
export function quotaAlerts(snapshot: AccountLimitsPanelSnapshot): QuotaAlert[] {
  return preferCodexPool(snapshot).machines.flatMap(machine => machine.status !== "connected" || machine.error ? [] : machine.providers.flatMap(provider => {
    const accounts = provider.accounts.length ? provider.accounts : [{ key: "provider", label: provider.displayName, usage: provider.usage }];
    return accounts.flatMap(account => account.usage.status !== "ok" ? [] : account.usage.windows.flatMap((window, index) => {
      if (window.resetsAt && Date.parse(window.resetsAt) <= Date.now()) return [];
      const level = window.usedPercent >= 95 ? 2 : window.usedPercent >= 80 ? 1 : 0;
      return [{ key: JSON.stringify([machine.source, machine.id, provider.id, account.key, ("id" in window ? window.id : null) ?? window.label, index]), level,
        title: `${provider.displayName}${account.label === provider.displayName ? "" : ` · ${account.label}`} · ${quotaWindowDisplayLabel(provider.id, window.label) ?? window.label} 已用 ${Math.round(window.usedPercent)}%${level === 2 ? "，额度紧张" : "，请留意余量"}` }];
    }));
  }));
}

/** Reminder state is per browser session; recoveries allow a later new crossing. */
export function createQuotaAlertTracker() {
  const levels = new Map<string, number>();
  return (snapshot: AccountLimitsPanelSnapshot): QuotaAlert[] => quotaAlerts(snapshot).filter(alert => {
    const previous = levels.get(alert.key) ?? 0;
    levels.set(alert.key, alert.level);
    return alert.level > previous;
  });
}

/** Cursor subscription allowance and on-demand budget are separate denominators. */
export function quotaWindowDisplayLabel(providerId: string, label: string): string | undefined {
  if (!providerId.includes("cursor")) return undefined;
  if (/^plan usage$/iu.test(label)) return "套餐额度";
  if (/^on-demand spend$/iu.test(label)) return "按量预算";
  return undefined;
}

export function cursorQuotaSummaries(provider: AccountLimitsPanelSnapshot["machines"][number]["providers"][number]) {
  const windows = provider.accounts.length
    ? provider.accounts.flatMap(account => account.usage.status === "ok" ? account.usage.windows : [])
    : provider.usage.status === "ok" ? provider.usage.windows : [];
  return ([{ key: "plan", label: "套餐", fullLabel: "套餐额度" }, { key: "on-demand", label: "按量", fullLabel: "按量预算" }] as const).flatMap(metric => {
    const matches = windows.filter(window => quotaWindowDisplayLabel(provider.id, window.label) === metric.fullLabel);
    return matches.length ? [{ ...metric, usedPercent: Math.max(...matches.map(window => window.usedPercent)) }] : [];
  });
}
