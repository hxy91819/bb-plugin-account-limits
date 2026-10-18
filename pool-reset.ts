import type { QuotaAccount } from "./contract.js";
import { normalizeCliproxyWindow } from "./pool.js";
import { buildWeeklyPace, isWeeklyBudget } from "./weekly-pace.js";

export interface ResetAccount {
  key: string;
  label: string;
  state: "available" | "exhausted" | "blocked" | "unknown";
  /** Null means the observation cannot establish current weekly availability. */
  remainingPercent: number | null;
  prioritize: boolean;
  reason: string;
}

export interface NextWeeklyReset {
  resetsAt: string | null;
  accounts: ResetAccount[];
  /** Accounts whose matching weekly window or reset time is unknown. */
  unknownAccounts: number;
}

/**
 * Select the earliest reported weekly reset within this source/pool/window.
 * Include unused accounts (zero forecast gain), retain overdue observations
 * until refreshed, and reuse each account's existing pacing/quality checks.
 */
export function buildNextWeeklyReset(
  accounts: readonly QuotaAccount[], windowId: string, now: number,
  fallbackUpdatedAt: string | null = null,
): NextWeeklyReset {
  let earliest = Infinity;
  let unknownAccounts = 0;
  let batch: ResetAccount[] = [];
  for (const account of accounts) {
    const window = account.usage.status === "ok"
      ? account.usage.windows.find(window => (window.id ?? normalizeCliproxyWindow(window.label).id) === windowId)
      : undefined;
    const time = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (!window || !isWeeklyBudget(window.label) || !Number.isFinite(time)) {
      unknownAccounts += 1;
      continue;
    }
    if (time > earliest) continue;
    const pace = buildWeeklyPace([account], windowId, now, fallbackUpdatedAt);
    const state = pace.level === "unknown" ? "unknown"
      : pace.level === "exhausted" ? "exhausted"
        : pace.level === "blocked" ? "blocked" : "available";
    const entry: ResetAccount = {
      key: account.key, label: account.label, state,
      remainingPercent: pace.remainingPercent ?? null,
      prioritize: state === "available" && pace.expiringAccounts.length > 0,
      reason: pace.reason,
    };
    if (time < earliest) { earliest = time; batch = []; }
    batch.push(entry);
  }
  return { resetsAt: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null, accounts: batch, unknownAccounts };
}
