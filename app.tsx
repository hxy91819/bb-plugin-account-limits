import { useEffect, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { definePluginApp, experimental_Icon as BbIcon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { accountLimitsPanelRpcContract, type AccountLimitsPanelSnapshot, type QuotaAccount, type ProviderSnapshot, type QuotaSourceId } from "./contract.js";
import { aggregateCliproxyPool, groupAccountPools, groupAccountTypes, normalizeCliproxyWindow, orderQuotaWindows, type PoolWindow } from "./pool.js";
import { AntigravityIcon, GrokIcon } from "./provider-icons.js";
import { createQuotaUiStore, createQuotaAlertTracker, visibleQuota, compactPoolSummaries, formatQuotaPercent, quotaWindowDisplayLabel, quotaWindowPeriod, type QuotaUiStore } from "./quota-presentation.js";
import { useQuotaData, useQuotaPreference, useQuotaChoicePreference } from "./quota-ui.js";
import { panelStyles } from "./panel-styles.js";
import { buildPoolRecovery, type PoolRecovery } from "./pool-recovery.js";
import { buildWeeklyPace, isWeeklyBudget, type WeeklyPace } from "./weekly-pace.js";
import { buildNextWeeklyReset, type NextWeeklyReset, type ResetAccount } from "./pool-reset.js";

function compactReset(value: string | null, now: number): string {
  const resetAt = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(resetAt)) return "重置时间未知";
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return "已到重置时间，待刷新";
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return "不到 1 分钟重置";
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const duration = days > 0 ? `${days} 天 ${hours % 24} 小时`
    : hours > 0 ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
  return `还剩 ${duration}重置`;
}

function updatedLabel(value: string | null): string {
  if (value === null) return "测量时间未知";
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

type OkUsage = Extract<ProviderSnapshot["providers"][number]["usage"], { status: "ok" }>;
type QuotaWindow = OkUsage["windows"][number];
type PanelProvider = AccountLimitsPanelSnapshot["machines"][number]["providers"][number];
type DisplayMode = "remaining" | "used";
type PanelView = "accounts" | "pool";

function displayWindowLabel(window: QuotaWindow): string {
  const prefix = window.accountLabel ? `${window.accountLabel} · ` : "";
  return prefix && window.label.startsWith(prefix) ? window.label.slice(prefix.length) : window.label;
}

function shortWindowLabel(label: string): string {
  const exact: Record<string, string> = {
    "5-hour limit": "5h",
    "Five-hour limit": "5h",
    "Weekly limit": "周",
    "Weekly scoped limit": "Fable",
    "Current limit": "当前",
    "Secondary limit": "次级",
  };
  if (exact[label]) return exact[label];
  return label
    .replaceAll("Gemini Models: ", "Gemini ")
    .replaceAll("Claude and GPT models: ", "C/GPT ")
    .replaceAll("5-hour limit", "5h")
    .replaceAll("Weekly limit", "周")
    .replace(/\b7d\b/gu, "周")
    .replace(/(\d+)-minute limit/u, "$1m");
}

function groupWindowsByAccount(windows: readonly QuotaWindow[]) {
  const groups = new Map<string, QuotaWindow[]>();
  for (const window of windows) {
    const accountLabel = window.accountLabel ?? "账户额度";
    const group = groups.get(accountLabel);
    if (group) group.push(window);
    else groups.set(accountLabel, [window]);
  }
  return [...groups.entries()];
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

type MeterWindow = QuotaWindow & { detail?: string; displayLabel?: string; recovery?: PoolRecovery | null; pace?: WeeklyPace | null; pooled?: boolean; nextReset?: NextWeeklyReset };

function accountWindows(account: QuotaAccount, now: number, updatedAt: string | null): MeterWindow[] {
  if (account.usage.status !== "ok") return [];
  return account.usage.windows.map(window => ({ ...window, accountLabel: null,
    pace: isWeeklyBudget(window.label) ? buildWeeklyPace([account], window.id ?? normalizeCliproxyWindow(window.label).id, now, updatedAt) : null,
  }));
}

function recoveryNumber(value: number): string {
  return value > 0 && value < 0.1 ? "<0.1" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

function recoveryStrength(index: number, count: number): number {
  return 100 - 60 * index / Math.max(1, count - 1);
}

function RecoverySegments({ recovery, mode, now }: { recovery: PoolRecovery; mode: DisplayMode; now: number }) {
  const segments = [
    ...(mode === "remaining" ? [{ key: "remaining", percent: recovery.remainingPercent, kind: "current", strength: 100, title: `当前剩余 ${recoveryNumber(recovery.remainingPercent)}%` }] : []),
    { key: "overdue", percent: recovery.overduePercent, kind: "unresolved", strength: 40, title: `已到重置时间，待刷新 · ${recoveryNumber(recovery.overduePercent)} 个百分点` },
    ...recovery.steps.map((step, index) => ({ key: step.resetsAt, percent: step.gainPercent, kind: "future",
      strength: recoveryStrength(index, recovery.steps.length) * (mode === "remaining" ? 0.45 : 1),
      title: `${compactReset(step.resetsAt, now)} · 预计恢复 ${recoveryNumber(step.gainPercent)} 个百分点 · 预计剩余 ${recoveryNumber(step.remainingPercent)}%`,
    })),
    { key: "unknown", percent: recovery.unknownPercent, kind: "unresolved", strength: 40, title: `重置时间未知 · ${recoveryNumber(recovery.unknownPercent)} 个百分点，未计入定时预测` },
  ];
  return <>{segments.filter(segment => segment.percent > 0).map(segment => <span key={segment.key}
    className={`limits-recovery-segment limits-recovery-segment--${segment.kind}`} aria-hidden="true" title={segment.title}
    style={{ width: `${segment.percent}%`, "--recovery-strength": `${segment.strength}%` } as CSSProperties} />)}</>;
}

function PanelIcon({ name, spinning = false }: { name: "refresh" | "accounts" | "pool" | "info" | "layers" | "settings" | "open" | "collapse"; spinning?: boolean }) {
  if (name === "refresh") return <BbIcon name="RotateCcw" className={`limits-icon${spinning ? " limits-icon--spin" : ""}`} aria-hidden="true" />;
  const paths = {
    accounts: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></>,
    pool: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></>,
    open: <><path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
    collapse: <path d="m6 9 6 6 6-6"/>,
    layers: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><path d="M14 17.5h7M17.5 14v7" /></>,
  };
  return <svg className={`limits-icon${spinning ? " limits-icon--spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function ProviderMark({ id, name }: { id: string; name: string }) {
  if (id.includes("antigravity")) return <AntigravityIcon className="limits-mark-icon" />;
  if (id.includes("xai")) return <GrokIcon className="limits-mark-icon" />;
  if (id.includes("claude")) return <svg className="limits-mark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 2v20M2 12h20M5 5l14 14M5 19 19 5M3 8l18 8M8 3l8 18M3 16l18-8M8 21 16 3" /></svg>;
  return <span className="limits-mark-letter" aria-hidden="true">{id.includes("codex") ? "⌘" : name.slice(0, 1).toUpperCase()}</span>;
}

function resetAccountLabel(account: ResetAccount): string {
  if (account.state === "unknown") return "余量待确认";
  if (account.state === "exhausted") return "周额已用尽";
  return `周剩 ${recoveryNumber(account.remainingPercent!)}%${account.state === "blocked" ? "，5h 暂受限" : ""}`;
}

function NextReset({ summary, now }: { summary: NextWeeklyReset; now: number }) {
  const prefix = summary.unknownAccounts > 0 ? "最近已知重置" : "最近重置";
  if (summary.resetsAt === null) return <p className="limits-reset limits-next-reset">最近重置时间未知</p>;
  const countdown = compactReset(summary.resetsAt, now).replace(/^还剩 /u, "").replace(/重置$/u, "").replaceAll(" ", "");
  const counts = { available: 0, exhausted: 0, blocked: 0, unknown: 0 };
  for (const account of summary.accounts) counts[account.state] += 1;
  const states = summary.accounts.length === 1 ? [resetAccountLabel(summary.accounts[0]!)] : [
    counts.available > 0 ? `${counts.available} 有余量` : "",
    counts.exhausted > 0 ? `${counts.exhausted} 已耗尽` : "",
    counts.blocked > 0 ? `${counts.blocked} 5h 暂受限` : "",
    counts.unknown > 0 ? `${counts.unknown} 待确认` : "",
  ].filter(Boolean);
  const prioritize = summary.accounts.some(account => account.prioritize);
  const details = summary.accounts.map(account => `${account.label}：${resetAccountLabel(account)}${account.prioritize ? "，建议先用" : ""}${account.state === "unknown" ? `（${account.reason}）` : ""}`).join("；")
    + (summary.unknownAccounts > 0 ? `；另有 ${summary.unknownAccounts} 个账号的周窗口或重置时间未知。` : "");
  return <p className="limits-reset limits-next-reset" role="note" aria-label={`${prefix}账号：${countdown}。${details}`} title={details}>
    <span className="limits-next-reset-time">{prefix}：{countdown}</span>
    <span className="limits-next-reset-divider" aria-hidden="true"> · </span>
    <span className="limits-next-reset-count">{summary.accounts.length} 个账号 · </span>
    <span className="limits-next-reset-state" data-state={counts.unknown === summary.accounts.length ? "unknown" : counts.exhausted === summary.accounts.length ? "exhausted" : "available"}>{states.map((state, index) => <span key={state} className={states.length > 1 ? "limits-next-reset-category" : undefined}>{state}{index < states.length - 1 ? "、" : ""}</span>)}</span>
    {prioritize && <span className="limits-next-reset-priority">建议先用</span>}
  </p>;
}

function WindowMeter({ window, now, mode }: { window: MeterWindow; now: number; mode: DisplayMode }) {
  const label = displayWindowLabel(window);
  const remaining = remainingPercent(window.usedPercent);
  const percent = mode === "used" ? 100 - remaining : remaining;
  const reset = compactReset(window.resetsAt, now);
  const depleted = remaining <= 10;
  const expiringAdvice = window.pooled && window.pace && window.pace.expiringAccounts.length > 0
    ? `优先使用 ${window.pace.expiringAccounts.join("、")}：24 小时内重置，其周余量合计占当前池 ${recoveryNumber(window.pace.expiringRemainingPercent)} 个百分点。需优先使用这些账号，整池节奏仍为${window.pace.label}。`
    : null;
  return <li className="limits-meter" data-pace={window.pace?.level} data-depleted={depleted || undefined} data-warning={remaining <= 20 && !depleted || undefined}>
    <div className="limits-meter-heading">
      <div className="limits-meter-title">
        <span className="limits-meter-label" title={window.displayLabel ?? shortWindowLabel(label)}>{window.displayLabel ?? shortWindowLabel(label)}</span>
      </div>
      <span className="limits-meter-number">{`${formatQuotaPercent(percent, window.pooled ? 1 : 0)}%`}</span>
    </div>
    <div className={`limits-meter-track${window.recovery && window.recovery.usedPercent > 0 ? " limits-meter-track--recovery" : ""}`} role="progressbar" aria-label={`${label} ${mode === "used" ? "已用" : "剩余"}额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} title={`${label} · ${reset}`}>
      {window.recovery && window.recovery.usedPercent > 0 ? <RecoverySegments recovery={window.recovery} mode={mode} now={now} /> : <div className="limits-meter-fill" style={{ width: `${percent}%` }} />}
    </div>
    {window.pace && <div className="limits-meter-advice">
      {expiringAdvice && <span className="limits-pace" data-level="generous" role="note"
        aria-label={`临期使用建议：临期额度可多用。${expiringAdvice}`} title={expiringAdvice}>
        <span className="limits-pace-scope">临期额度</span><span>可多用</span>
      </span>}
      <span className="limits-pace" data-level={window.pace.level} role="note"
          aria-label={`周额度建议：${window.pace.label}。${window.pooled ? "整池节奏。" : ""}${window.pace.reason}`} title={window.pace.reason}>{window.pooled ? <><span className="limits-pace-scope">整池节奏</span><span>{window.pace.label}</span></> : window.pace.label}</span>
    </div>}
    {window.nextReset
      ? <><NextReset summary={window.nextReset} now={now} /><p className="limits-reset limits-pool-coverage">{window.detail}</p></>
      : <p className="limits-reset">{window.detail ? `${reset} · ${window.detail}` : reset}</p>}
  </li>;
}

function modelWeeklyName(label: string): string | null {
  if (/^(weekly scoped limit|scoped)$/iu.test(label)) return "Fable";
  const model = /\b(fable|opus|sonnet|haiku)\b/iu.exec(label)?.[1];
  return model && /\b(weekly|7d)\b/iu.test(label) ? model[0].toUpperCase() + model.slice(1).toLowerCase() : null;
}

function MeterList({ windows, now, mode }: { windows: readonly MeterWindow[]; now: number; mode: DisplayMode }) {
  const columns = Math.min(Math.max(windows.length, 1), 4);
  return <ul className="limits-meters" data-columns={columns} style={{ "--quota-columns": columns } as CSSProperties}>
    {windows.map((window, index) => <WindowMeter key={`${window.label}-${index}`} window={window} now={now} mode={mode} />)}
  </ul>;
}

function ModelCap({ window, now, mode }: { window: MeterWindow; now: number; mode: DisplayMode }) {
  const remaining = remainingPercent(window.usedPercent);
  const percent = mode === "used" ? 100 - remaining : remaining;
  const reset = compactReset(window.resetsAt, now);
  return <li className="limits-cap">
    <div className="limits-cap-heading">
      <span className="limits-cap-label">{modelWeeklyName(window.label)} 周上限</span>
      <span className="limits-cap-value" data-depleted={remaining <= 10 || undefined} role="progressbar"
        aria-label={`${window.label} ${mode === "used" ? "已用" : "剩余"}额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-valuetext={`${mode === "used" ? "已用" : "剩余"} ${formatQuotaPercent(percent, window.pooled ? 1 : 0)}%，以 ${modelWeeklyName(window.label)} 自身周上限计算`}>
        <span className="limits-cap-mode">{mode === "used" ? "已用" : "剩余"}</span> {formatQuotaPercent(percent, window.pooled ? 1 : 0)}%
      </span>
    </div>
    <p className="limits-reset">{window.detail ? `${reset} · ${window.detail}` : reset}</p>
  </li>;
}

function SessionStatus({ window, now, mode }: { window: MeterWindow; now: number; mode: DisplayMode }) {
  const remaining = remainingPercent(window.usedPercent);
  const percent = mode === "used" ? 100 - remaining : remaining;
  const label = displayWindowLabel(window);
  return <li className="limits-session" data-exhausted={remaining === 0 || undefined} title={window.detail}>
    <span className="limits-session-label">5h</span>
    <span className="limits-session-value" role="progressbar" aria-label={`${label} ${mode === "used" ? "已用" : "剩余"}额度`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span className="limits-session-mode">{mode === "used" ? "已用" : "剩余"}</span> {formatQuotaPercent(percent, window.pooled ? 1 : 0)}%</span>
    {remaining === 0 && <span className="limits-session-blocked">暂受限</span>}
    <span className="limits-session-reset">{compactReset(window.resetsAt, now)}</span>
    {window.detail && <span className="limits-session-detail">{window.detail}</span>}
  </li>;
}

/** Weekly budgets lead; 5h and model caps remain distinct, subordinate constraints. */
function QuotaWindows({ providerId, windows, now, mode }: {
  providerId: string; windows: readonly MeterWindow[]; now: number; mode: DisplayMode;
}) {
  const ordered = orderQuotaWindows(windows).map(window => ({ ...window, label: displayWindowLabel(window), accountLabel: null, displayLabel: window.displayLabel ?? quotaWindowDisplayLabel(providerId, displayWindowLabel(window)) }));
  const claude = ["claude", "claude-code", "cliproxy-claude", "account-pool:claude-code"].includes(providerId);
  const modelWindows = claude ? ordered.filter(window => modelWeeklyName(window.label) !== null) : [];
  const groups = new Map<string, { weekly: MeterWindow[]; sessions: MeterWindow[] }>();
  const getGroup = (family: string) => {
    let group = groups.get(family);
    if (!group) { group = { weekly: [], sessions: [] }; groups.set(family, group); }
    return group;
  };
  const otherWindows: MeterWindow[] = [];
  for (const window of ordered) {
    if (modelWindows.includes(window)) continue;
    const period = quotaWindowPeriod(window.label);
    if (!period) { otherWindows.push(window); continue; }
    const group = getGroup(period.family);
    (period.period === "7d" ? group.weekly : group.sessions).push(window);
  }
  if (modelWindows.length) getGroup("");
  if (!groups.size) return <MeterList windows={otherWindows} now={now} mode={mode} />;
  return <div className="limits-budget-grid">
    {[...groups].map(([family, group]) => {
      const totalLabel = claude && !family ? "总周额度" : `${family ? `${family} ` : ""}周额度`;
      return <div key={family} role="group" aria-label={family ? `${family} 周额度` : "周额度"} className="limits-weekly">
        {group.weekly.length
          ? <MeterList windows={group.weekly.map(window => ({ ...window, displayLabel: claude && !family ? "总周额度" : window.displayLabel }))} now={now} mode={mode} />
          : <div className="limits-weekly-unknown"><span>{totalLabel}</span><span className="limits-unknown-value">—</span><span className="limits-reset">{totalLabel}未返回</span></div>}
        {claude && !family && group.weekly.some(window => window.usedPercent >= 100) && <p className="limits-exhausted">总周额度已用尽</p>}
        {group.sessions.length > 0 && <ul className="limits-sessions" aria-label={`${family ? `${family} ` : ""}5h 短期限制`}>
          {group.sessions.map((window, index) => <SessionStatus key={`${window.label}-${index}`} window={window} now={now} mode={mode} />)}
        </ul>}
        {!family && modelWindows.length > 0 && <div role="group" aria-label="模型周上限" className="limits-caps">
          <ul>{modelWindows.map((window, index) => <ModelCap key={`${window.label}-${index}`} window={window} now={now} mode={mode} />)}</ul>
        </div>}
      </div>;
    })}
    {otherWindows.length > 0 && <div className="limits-other-windows"><MeterList windows={otherWindows} now={now} mode={mode} /></div>}
  </div>;
}

function poolWindowDetail(window: PoolWindow, totalAccounts: number): string {
  const exhausted = window.exhausted > 0 ? ` · 全池 ${window.exhausted} 账号已耗尽` : "";
  return `${window.accounts} 个账号汇总 · 覆盖 ${window.accounts}/${totalAccounts}${exhausted}`;
}

function PoolUsage({ provider, now, mode }: { provider: PanelProvider; now: number; mode: DisplayMode }) {
  return <div className="limits-pools">
    {groupAccountPools(provider.id, provider.accounts).map(group => <section key={group.id}
      className="limits-pool"
      aria-label={group.label ? `${group.label} 的池额度` : undefined}>
      {group.label && <h3 className="limits-pool-label"><PanelIcon name="pool" />{group.label}</h3>}
      <PoolGroupUsage providerId={provider.id} accounts={group.accounts} providerUsage={provider.usage} updatedAt={provider.updatedAt} now={now} mode={mode} />
    </section>)}
  </div>;
}

function PoolGroupUsage({ providerId, accounts, providerUsage, updatedAt, now, mode }: {
  providerId: string;
  accounts: readonly PanelProvider["accounts"][number][];
  providerUsage: PanelProvider["usage"]; updatedAt: string | null; now: number; mode: DisplayMode;
}) {
  const pool = aggregateCliproxyPool(accounts);
  if (pool.status !== "ok") {
    const message = accounts.length === 0 && providerUsage.status === "error" ? providerUsage.message : pool.message;
    return <p className="limits-message limits-message--error">{message}</p>;
  }
  if (pool.windows.length === 0) return <p className="limits-message">未报告额度窗口。</p>;
  return <QuotaWindows providerId={providerId} windows={pool.windows.map(window => ({
    accountLabel: null, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
    detail: poolWindowDetail(window, pool.totalAccounts),
    pooled: true,
    nextReset: isWeeklyBudget(window.label) ? buildNextWeeklyReset(accounts, window.id, now, updatedAt) : undefined,
    recovery: buildPoolRecovery(accounts, window.id, now),
    pace: isWeeklyBudget(window.label) ? buildWeeklyPace(accounts, window.id, now, updatedAt) : null,
  }))} now={now} mode={mode} />;
}

function Usage({ providerId, usage, now, mode, updatedAt = null }: { providerId: string; usage: ProviderSnapshot["providers"][number]["usage"]; now: number; mode: DisplayMode; updatedAt?: string | null }) {
  if (usage.status === "ok") {
    if (usage.windows.length === 0) return <p className="limits-message">未报告额度窗口。</p>;
    return <div className="limits-accounts">
      {groupWindowsByAccount(usage.windows).map(([accountLabel, windows]) => <section key={accountLabel} aria-label={`${accountLabel} 的额度`} className="limits-account">
        <h3 className="limits-account-name" title={accountLabel}>{accountLabel}</h3>
        <QuotaWindows providerId={providerId} windows={accountWindows({ key: accountLabel, label: accountLabel, weight: 1,
          usage: { status: "ok", planLabel: usage.planLabel, windows: windows.map(window => ({ ...window, label: displayWindowLabel(window) })) } }, now, updatedAt)} now={now} mode={mode} />
      </section>)}
    </div>;
  }
  const messages: Record<Exclude<typeof usage.status, "ok" | "error">, string> = {
    unauthenticated: "账号尚未登录。",
    expired: "账号登录已过期。",
    not_installed: "查询组件尚未安装。",
  };
  return <p className="limits-message limits-message--error">{usage.status === "error" ? usage.message : messages[usage.status]}</p>;
}

function AccountUsage({ provider, now, mode }: { provider: PanelProvider; now: number; mode: DisplayMode }) {
  if (provider.accounts.length === 0) return <Usage providerId={provider.id} usage={provider.usage} now={now} mode={mode} updatedAt={provider.updatedAt} />;
  return <div className="limits-accounts">
    {provider.accounts.map((account, index) => <section key={account.key} aria-label={`${account.label} 的额度`}
      className="limits-account">
      <div className="limits-identity">
        <span className="limits-account-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div className="limits-identity-text">
          <h3 className="limits-account-name" title={account.label}>{account.label}</h3>
          <div className="limits-account-meta">
            {account.usage.status === "ok" && account.usage.planLabel && account.usage.planLabel.trim() !== account.label.trim() && <span className="limits-plan">{account.usage.planLabel}</span>}
            {account.updatedAt !== undefined && <span>{updatedLabel(account.updatedAt)}</span>}
          </div>
        </div>
      </div>
      {account.usage.status === "ok"
        ? account.usage.windows.length === 0
          ? <p className="limits-message">未报告额度窗口。</p>
          : <QuotaWindows providerId={provider.id} windows={accountWindows(account, now, provider.updatedAt)} now={now} mode={mode} />
        : <Usage providerId={provider.id} usage={account.usage} now={now} mode={mode} />}
    </section>)}
  </div>;
}

function accountCountLabel(planLabel: string | null): string | null {
  const match = planLabel?.match(/(\d+\/\d+)\s+accounts$/u);
  return match?.[1] ?? planLabel;
}

function ModelLimitNote({ provider }: { provider: PanelProvider }) {
  if (!["claude", "claude-code", "cliproxy-claude", "account-pool:claude-code"].includes(provider.id)) return null;
  const windows = provider.accounts.length > 0
    ? provider.accounts.flatMap(account => account.usage.status === "ok" ? account.usage.windows.map(window => ({ ...window, accountLabel: null })) : [])
    : provider.usage.status === "ok" ? provider.usage.windows : [];
  if (!windows.some(window => modelWeeklyName(displayWindowLabel(window)) !== null)) return null;
  return <p className="limits-footnote"><PanelIcon name="info" /><span>模型上限不是额外额度：订阅内使用同时计入总周，百分比分别计算，不可相加。总周缺失时，总余量未知。</span></p>;
}

const sourceNames: Record<QuotaSourceId, string> = { cliproxy: "CLI Proxy", "account-pool": "BB Account Pooler", "bb-providers": "BB 已有账户" };
const collapsedSourcesKey = "account-limits.collapsed-sources.v1";
function SourceGroup({ source, machines, children }: { source: QuotaSourceId; machines: AccountLimitsPanelSnapshot["machines"]; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(collapsedSourcesKey) ?? "{}")[source] === true; }
    catch { return false; }
  });
  const providers = machines.flatMap(machine => machine.providers);
  const accounts = providers.reduce((count, provider) => count + (provider.accounts.length || (provider.usage.status === "ok" ? groupWindowsByAccount(provider.usage.windows).length : 0)), 0);
  return <details className="limits-source-group" open={!collapsed} onToggle={event => {
    const next = !event.currentTarget.open;
    if (next === collapsed) return;
    setCollapsed(next);
    try {
      const saved = JSON.parse(window.localStorage.getItem(collapsedSourcesKey) ?? "{}");
      window.localStorage.setItem(collapsedSourcesKey, JSON.stringify({ ...saved, [source]: next }));
    } catch { /* Folding still works when storage is unavailable. */ }
  }}>
    <summary className="limits-source-summary" aria-label={`${sourceNames[source]} 来源`}>
      <span className="limits-source-chevron" aria-hidden="true">›</span>
      <span className="limits-source-title">{sourceNames[source]}</span>
      <span className="limits-source-count">{providers.length} 服务 · {accounts} 账号</span>
      {machines.some(machine => machine.error || machine.status !== "connected") && <span className="limits-source-warning">需要关注</span>}
    </summary>
    <div className="limits-source-content">{children}</div>
  </details>;
}

function QuotaMark() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19a10 10 0 1 1 16 0Z"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none"/></svg>;
}

function AccountLimitsPanel({ store }: { store: QuotaUiStore }) {
  const [hideFailures, setHideFailures] = useQuotaPreference("hide-failures");
  const [reminders, setReminders] = useQuotaPreference("reminders");
  const [mode, changeMode] = useQuotaChoicePreference<DisplayMode>("display-mode", "remaining", ["remaining", "used"]);
  const [view, changeView] = useQuotaChoicePreference<PanelView>("view", "accounts", ["accounts", "pool"]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const { snapshot: rawSnapshot, error, loading, refresh } = useQuotaData(store);
  const snapshot = visibleQuota(rawSnapshot, hideFailures);
  const load = (force = false) => refresh(force ? { force: true } : {});
  const refreshProvider = (providerId: string, source: QuotaSourceId) => refresh({ source, providerIds: [providerId], force: true });

  const sourceGroups = (["bb-providers", "account-pool", "cliproxy"] as const).map(source => ({ source,
    machines: snapshot?.machines.filter(machine => (machine.source ?? "cliproxy") === source) ?? [],
  })).filter(group => group.machines.length > 0);
  const providers = snapshot?.machines.flatMap(machine => machine.providers) ?? [];
  const accountCount = providers.reduce((count, provider) => count + (provider.accounts.length ||
    (provider.usage.status === "ok" ? groupWindowsByAccount(provider.usage.windows).length : 0)), 0);
  return <main className="limits-panel">
    <style>{panelStyles}</style>
    <div className="limits-shell">
      <header className="limits-hero">
        <div className="limits-title-wrap">
          <div className="limits-emblem"><QuotaMark /></div>
          <div><h1 className="limits-title">账户额度</h1><p className="limits-subtitle">订阅窗口与模型上限，一处查看。</p></div>
        </div>
        <div className="limits-overview" aria-label="额度记录概览">
          <div className="limits-stat"><span className="limits-stat-number">{snapshot ? providers.length : "—"}</span><span className="limits-stat-label">接入服务</span></div>
          <div className="limits-stat" title="按展示的账号行计数，不代表独立订阅或额度池。"><span className="limits-stat-number">{snapshot ? accountCount : "—"}</span><span className="limits-stat-label">账号记录</span></div>
        </div>
      </header>
      <div className="limits-toolbar">
        <div className="limits-segments" role="group" aria-label="额度视图">
          {(["accounts", "pool"] as const).map(value => <button key={value} type="button" aria-pressed={view === value}
            className="limits-segment"
            onClick={() => changeView(value)}><PanelIcon name={value === "pool" ? "pool" : "accounts"} />{value === "pool" ? "池" : "账号"}</button>)}
        </div>
        <div className="limits-toolbar-end">
          <div className="limits-segments" role="group" aria-label="额度显示模式">
            {(["remaining", "used"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value}
              className="limits-segment" aria-label={value === "used" ? "已用（Used）" : "剩余"}
              onClick={() => changeMode(value)}>{value === "used" ? "已用" : "剩余"}</button>)}
          </div>
          <button type="button" className="limits-button"
            disabled={loading} onClick={() => void load(true)}><PanelIcon name="refresh" spinning={loading} />{loading && snapshot ? "刷新中" : "刷新全部"}</button>
        </div>
      </div>
      <div className="limits-preferences"><label className="limits-preference"><input type="checkbox" checked={hideFailures} onChange={event => setHideFailures(event.target.checked)} />隐藏获取失败</label>
      <label className="limits-preference"><input type="checkbox" checked={reminders} onChange={event => setReminders(event.target.checked)} />资源池提醒（已用 80% / 95%）</label></div>
      {view === "pool" && providers.length > 0 && <p className="limits-recovery-legend"><span className="limits-recovery-key" aria-hidden="true" />{mode === "used"
        ? "已用部分按预计恢复批次分段，深色较近、浅色较远；斜纹为时间未知或待刷新。"
        : "实色为当前剩余，浅色分段为预计恢复（由近到远）；斜纹为时间未知或待刷新。"}</p>}
      {error && <p role="alert" className="limits-alert">{error}</p>}
      {!snapshot && loading && <p className="limits-loading" role="status"><PanelIcon name="refresh" spinning />正在读取账户额度…</p>}
      {snapshot && snapshot.machines.length === 0 && <p className="limits-empty">{rawSnapshot?.machines.length ? "暂无可显示的额度。可关闭隐藏获取失败查看失败记录。" : "暂无已接入的额度来源。请在 BB 配置支持额度查询的账户，也可接入 Account Pooler 或 CLI Proxy。"}</p>}
      {sourceGroups.map(group => <SourceGroup key={group.source} source={group.source} machines={group.machines}>
      {group.machines.map(machine => <section key={machine.id} className="limits-source-section" aria-label={`${machine.displayName} 的账户额度`}>
        {group.machines.length > 1 && <h2 className="limits-source-label">{machine.displayName}</h2>}
        {machine.status === "disconnected" && <p className="limits-empty">此机器未连接，无法读取额度。</p>}
        {machine.status === "error" && <p className="limits-alert">{machine.error ?? "读取此机器的额度失败。"}</p>}
        {machine.status === "connected" && machine.error && <p role="alert" className="limits-alert">{machine.error}</p>}
        {machine.status === "connected" && machine.providers.length === 0 && <p className="limits-empty">{machine.source === "account-pool" ? "Account Pooler 尚未添加账号。" : "没有启用的 Cliproxy 账户额度。"}</p>}
        {machine.status === "connected" && machine.providers.map(provider => <article key={provider.id} className="limits-provider" aria-label={`${provider.displayName} · ${machine.source === "bb-providers" ? "BB 已有账户" : machine.source === "account-pool" ? "Account Pooler" : "Cliproxy"}`}>
          <header className="limits-provider-head">
            <div className={`limits-provider-mark${provider.id.includes("claude") ? " limits-provider-mark--claude" : provider.id.includes("codex") ? " limits-provider-mark--codex" : ""}`}><ProviderMark id={provider.id} name={provider.displayName} /></div>
            <div className="limits-provider-title">
              <h2 className="limits-provider-name">{provider.displayName}</h2>
              <span className="limits-source-badge">{machine.source === "bb-providers" ? "BB 已有账户" : machine.source === "account-pool" ? "Account Pooler" : "Cliproxy"}</span>
              {provider.usage.status === "ok" && accountCountLabel(provider.usage.planLabel) && <span className="limits-provider-count">{accountCountLabel(provider.usage.planLabel)}</span>}
            </div>
            <div className="limits-provider-actions">
              <span className="limits-updated">{updatedLabel(provider.updatedAt)}</span>
              <button type="button" aria-label={`刷新 ${machine.source === "account-pool" ? "Account Pooler " : ""}${provider.displayName} 额度`} title="刷新此服务" className="limits-button limits-refresh" onClick={() => void refreshProvider(provider.id, machine.source ?? "cliproxy")} disabled={loading}>
                <PanelIcon name="refresh" spinning={loading} />
              </button>
            </div>
          </header>
          <div className="limits-provider-body">{view === "pool" ? <PoolUsage provider={provider} now={now} mode={mode} /> : <AccountUsage provider={provider} now={now} mode={mode} />}</div>
          <ModelLimitNote provider={provider} />
        </article>)}
      </section>)}
      </SourceGroup>)}
    </div>
  </main>;
}

function CompactQuota({ store, dismiss }: { store: QuotaUiStore; dismiss(): void }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const owner = panel.ownerDocument;
    let disposed = false;
    let restoreOutsideFocus: HTMLElement | null = null;
    const onOutsideClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.composedPath().includes(panel)) return;
      // Capture avoids consuming the click that mounts us. Defer closing until
      // the host's footer toggle has run, so it cannot immediately reopen us.
      queueMicrotask(() => {
        if (disposed || !panel.isConnected) return;
        const focused = owner.activeElement;
        // BB restores focus to its trigger on dismissal. Preserve the target
        // the user just activated; passive unmount cleanup runs after the host's
        // layout focus restoration, so it does not steal input/composer focus.
        if (focused instanceof HTMLElement && focused !== owner.body && !panel.contains(focused)) {
          restoreOutsideFocus = focused;
        }
        dismiss();
      });
    };
    // Native click excludes touch scrolling; no touch/pointer default is blocked.
    owner.addEventListener("click", onOutsideClick, true);
    return () => {
      disposed = true;
      owner.removeEventListener("click", onOutsideClick, true);
      if (restoreOutsideFocus?.isConnected && owner.activeElement !== restoreOutsideFocus) {
        restoreOutsideFocus.focus({ preventScroll: true });
      }
    };
  }, [dismiss]);
  const { snapshot: rawSnapshot, error, loading, refresh } = useQuotaData(store);
  const [hideFailures, setHideFailures] = useQuotaPreference("hide-failures");
  const [reminders, setReminders] = useQuotaPreference("reminders");
  const navigate = useBbNavigate();
  const [mode] = useQuotaChoicePreference<DisplayMode>("display-mode", "remaining", ["remaining", "used"]);
  const [view] = useQuotaChoicePreference<PanelView>("view", "accounts", ["accounts", "pool"]);
  const [selected, setSelected] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const snapshot = visibleQuota(rawSnapshot, hideFailures);
  const entries = snapshot?.machines.flatMap(machine => machine.providers.flatMap(provider =>
    groupAccountTypes(provider.accounts).map(type => ({
      key: JSON.stringify([machine.source, machine.id, provider.id, type.id]), machine,
      provider: { ...provider, accounts: [...type.accounts] },
      name: `${provider.displayName}${type.label ? ` · ${type.label.replace(/^Google AI /iu, "")}` : ""}`,
    })))) ?? [];
  const active = entries.find(entry => entry.key === selected) ?? entries[0];
  return <section ref={panelRef} className="limits-panel limits-compact" aria-label="账户额度精简版">
    <style>{panelStyles}</style>
    <header className="limits-compact-head">
      <span className="limits-compact-brand"><QuotaMark /><strong>账户额度</strong></span>
      <button type="button" className="limits-compact-action" aria-label="刷新精简额度" title="刷新额度" disabled={loading} onClick={() => void refresh({ force: true })}><PanelIcon name="refresh" spinning={loading} /></button>
      <details className="limits-compact-settings">
        <summary aria-label="额度显示设置" title="显示设置"><PanelIcon name="settings" /></summary>
        <div className="limits-compact-options">
          <label><input type="checkbox" checked={hideFailures} onChange={event => setHideFailures(event.target.checked)} />隐藏失败</label>
          <label><input type="checkbox" checked={reminders} onChange={event => setReminders(event.target.checked)} />资源池提醒</label>
          <span>按池汇总，已用 80% / 95% 时提醒</span>
        </div>
      </details>
      <button type="button" className="limits-compact-action" aria-label="完整页面" title="打开完整页面" onClick={() => { navigate.toPluginPanel("account-limits"); dismiss(); }}><PanelIcon name="open" /></button>
      <button type="button" className="limits-compact-action" aria-label="收起账户额度" title="收起" onClick={dismiss}><PanelIcon name="collapse" /></button>
    </header>
    {error && <p role="alert" className="limits-alert">{error}</p>}
    {entries.length > 0 && <div className="limits-compact-services" aria-label="额度服务">
      {entries.map(entry => {
        const metrics = compactPoolSummaries(entry.provider, now).map(metric => ({ ...metric,
          percent: metric.usedPercent === null ? null : formatQuotaPercent(mode === "used" ? metric.usedPercent : 100 - metric.usedPercent, 1),
          tone: metric.usedPercent === null ? "unknown" : metric.usedPercent >= 95 ? "critical" : metric.pace?.level === "conserve" || metric.pace?.level === "blocked" ? "warning" : metric.pace?.level === "generous" ? "generous" : metric.usedPercent >= 80 ? "warning" : "normal",
        }));
        const name = entry.name.replace(" (SDK)", "").replace(" · ", " ");
        const summary = metrics.map(metric => `${metrics.length === 1 ? metric.fullLabel : metric.label}${metric.percent === null ? " —" : `${mode === "used" ? "已用" : "剩余"} ${metric.percent}%${metric.partial ? "*" : ""}`}`).join("，");
        const detail = metrics.map(metric => `${metric.fullLabel}${metric.pace ? ` · ${metric.pace.label}` : ""} · ${metric.detail}`).join("；");
        return <button type="button" key={entry.key} className="limits-compact-service" data-tone={metrics.length === 1 ? metrics[0]!.tone : "normal"} aria-pressed={entry.key === active?.key}
          aria-label={entry.name}
          title={`${entry.machine.displayName} · ${sourceNames[entry.machine.source ?? "cliproxy"]}${summary ? ` · ${summary}（池汇总，各项分别统计） · ${detail}` : ""}`}
          onClick={() => setSelected(entry.key)}><span className="limits-compact-service-name">{name}</span>{metrics.length > 1 ? <span className="limits-compact-service-metrics">{metrics.map(metric => <span key={metric.key} className="limits-compact-service-metric" data-tone={metric.tone}><span>{metric.label}</span><strong>{metric.percent === null ? "—" : `${metric.percent}%${metric.partial ? "*" : ""}`}</strong></span>)}</span> : <span className="limits-compact-service-value">{metrics[0]?.percent === undefined || metrics[0].percent === null ? "—" : `${metrics[0].percent}%${metrics[0].partial ? "*" : ""}`}</span>}</button>;
      })}
    </div>}
    <div className="limits-compact-body">
      {active ? <>
        {active.machine.error && <p role="alert" className="limits-alert">{active.machine.error}</p>}
        {active.machine.status === "disconnected" ? <p className="limits-empty">此机器未连接，无法读取额度。</p> : <>
          <div className="limits-compact-context"><span title={`${sourceNames[active.machine.source ?? "cliproxy"]} · ${active.machine.displayName}`}>{sourceNames[active.machine.source ?? "cliproxy"]}</span><span>{mode === "used" ? "已用额度" : "剩余额度"} · {view === "pool" ? "池" : "账号"}</span></div>
          {view === "pool" ? <PoolUsage provider={active.provider} now={now} mode={mode} /> : active.provider.accounts.length ? active.provider.accounts.map(account => <section key={account.key} className="limits-compact-account" aria-label={`${account.label} 的额度`}>
            <div className="limits-compact-identity"><h3 title={account.label}>{account.label}</h3>{account.usage.status === "ok" && account.usage.planLabel && <span title={account.usage.planLabel}>{account.usage.planLabel}</span>}</div>
            {account.usage.status === "ok" ? account.usage.windows.length ? <QuotaWindows providerId={active.provider.id} windows={accountWindows(account, now, active.provider.updatedAt).map(window => ({ ...window, displayLabel: shortWindowLabel(window.label) === "周" ? "周额度" : undefined }))} now={now} mode={mode} /> : <p className="limits-message">未报告额度窗口。</p>
              : <Usage providerId={active.provider.id} usage={account.usage} now={now} mode={mode} />}
          </section>) : <AccountUsage provider={active.provider} now={now} mode={mode} />}
          <ModelLimitNote provider={active.provider} />
        </>}
      </> : <p className="limits-empty">{loading ? "正在读取额度…" : rawSnapshot?.machines.length ? "暂无可显示的额度，可关闭隐藏失败查看详情。" : "暂无已接入的额度来源。"}</p>}
      {!hideFailures && snapshot?.machines.filter(machine => machine.providers.length === 0 && machine.error).map(machine => <p key={`${machine.source}:${machine.id}`} className="limits-alert">{machine.displayName}：{machine.error}</p>)}
    </div>
  </section>;
}

function QuotaMonitor({ store }: { store: QuotaUiStore }) {
  const { snapshot, refresh } = useQuotaData(store);
  const [reminders] = useQuotaPreference("reminders");
  const [track] = useState(() => {
    try { return createQuotaAlertTracker(window.localStorage); }
    catch { return createQuotaAlertTracker(); }
  });
  useEffect(() => {
    if (!snapshot || !reminders) return;
    const alerts = track(snapshot);
    for (const alert of alerts) toast.warning(alert.title, { id: `account-limits:${alert.key}`, duration: 8_000, position: "top-right" });
  }, [snapshot, reminders, track]);
  useEffect(() => {
    let lastRead = Date.now();
    let disposed = false;
    const update = () => {
      if (disposed || document.visibilityState === "hidden" || Date.now() - lastRead < 5 * 60_000) return;
      lastRead = Date.now();
      void refresh().catch(() => { /* The shared store renders the read error. */ });
    };
    const timer = setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [refresh]);
  return null;
}

export default definePluginApp(app => {
  // Provider Usage resolves these marks by resource providerId, including IDs
  // without an executable agent provider. Keep them scoped to Cliproxy.
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "cliproxy-xai", icon: GrokIcon });
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "cliproxy-antigravity", icon: AntigravityIcon });
  const store = createQuotaUiStore();
  app.experimental_sidebarFooter.register({
    kind: "disclosure", id: "quota", label: "账户额度", icon: "account-limits/quota",
    component: ({ dismiss }) => <CompactQuota store={store} dismiss={dismiss} />,
  });
  app.slots.experimental_appOverlay({ id: "quota-monitor", component: () => <QuotaMonitor store={store} /> });
  app.slots.navPanel({
    id: "account-limits",
    title: "账户额度",
    // 导航图标优先于插件品牌图标，与 package.json 的 bb.branding.icon 保持一致。
    icon: "account-limits/quota",
    path: "account-limits",
    component: () => <AccountLimitsPanel store={store} />,
  });
});
