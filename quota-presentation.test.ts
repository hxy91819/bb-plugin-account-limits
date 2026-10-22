import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaAlertTracker, createQuotaUiStore, visibleQuota, compactPoolSummaries, formatQuotaPercent } from "./quota-presentation.js";
import type { AccountLimitsPanelSnapshot } from "./contract.js";

const snapshot = (usedPercent = 85): AccountLimitsPanelSnapshot => ({ machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
  providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
    { key: "healthy", label: "Healthy", weight: 1, updatedAt: null, usage: { status: "ok", planLabel: null, windows: [{ id: "weekly", label: "Weekly limit", usedPercent, resetsAt: null }] } },
    { key: "failed", label: "Failed", weight: 1, usage: { status: "expired" } },
  ] }] }] });

test("failure hiding filters accounts and failed machines without changing the source snapshot", () => {
  const data = snapshot();
  data.machines.push({ id: "bad", displayName: "Bad", status: "error", error: "offline", providers: [] });
  const filtered = visibleQuota(data, true)!;
  assert.equal(filtered.machines.length, 1);
  assert.equal(filtered.machines[0]!.providers[0]!.accounts.length, 1);
  assert.equal(data.machines[0]!.providers[0]!.accounts.length, 2);
  assert.equal(visibleQuota(data, false), data);
});

test("shared quota store deduplicates concurrent loads and recovers after synchronous RPC failure", async () => {
  const store = createQuotaUiStore();
  let finish!: (value: AccountLimitsPanelSnapshot) => void;
  let reads = 0;
  const read = () => { reads++; return new Promise<AccountLimitsPanelSnapshot>(resolve => { finish = resolve; }); };
  const a = store.refresh(read);
  const b = store.refresh(read);
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(reads, 1);
  finish(snapshot());
  await a;
  await store.refresh(() => { throw new Error("offline"); });
  assert.equal(store.getSnapshot().error, "offline");
  assert.equal(store.getSnapshot().snapshot!.machines.length, 1);
  await store.refresh(async () => ({ machines: [] }));
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().loading, false);
});

test("quota reminders fire once per crossed threshold, re-arm after recovery, and ignore errors and overdue windows", () => {
  const track = createQuotaAlertTracker();
  assert.equal(track(snapshot(79)).length, 0);
  assert.equal(track(snapshot(80))[0]!.level, 1);
  assert.equal(track(snapshot(90)).length, 0);
  assert.equal(track(snapshot(95))[0]!.level, 2);
  assert.equal(track(snapshot(100)).length, 0);
  assert.equal(track(snapshot(20)).length, 0);
  assert.equal(track(snapshot(85))[0]!.level, 1);
  const cached = snapshot(99); cached.machines[0]!.error = "Showing cache";
  assert.equal(track(cached).length, 0);
  const expired = snapshot(100);
  const usage = expired.machines[0]!.providers[0]!.accounts[0]!.usage;
  if (usage.status === "ok") usage.windows[0]!.resetsAt = "2000-01-01T00:00:00Z";
  assert.equal(track(expired).length, 0);
});

test("Cursor budget summaries and threshold reminders retain independent identities and omit absent metrics", () => {
  const data = snapshot();
  const provider = data.machines[0]!.providers[0]!;
  provider.id = "acp-cursor-sdk";
  provider.displayName = "Cursor (SDK)";
  provider.accounts = [{ key: "cursor", label: "Cursor (SDK)", weight: 1, usage: { status: "ok", planLabel: "Team", windows: [
    { label: "Plan usage", usedPercent: 23, resetsAt: null },
    { label: "On-demand spend", usedPercent: 81, resetsAt: null },
  ] } }];
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => [metric.label, metric.usedPercent]), [["套餐", 23], ["按量", 81]]);
  const track = createQuotaAlertTracker();
  const baseline = structuredClone(data);
  if (baseline.machines[0]!.providers[0]!.accounts[0]!.usage.status === "ok") baseline.machines[0]!.providers[0]!.accounts[0]!.usage.windows[1]!.usedPercent = 79;
  assert.equal(track(baseline).length, 0);
  const alerts = track(data);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.title, /按量预算 已用 81%/u);
  assert.doesNotMatch(alerts[0]!.title, /套餐额度/u);
  const usage = provider.accounts[0]!.usage;
  if (usage.status !== "ok") throw new Error("fixture failed");
  usage.windows[0]!.usedPercent = 95;
  const planAlerts = track(data);
  assert.equal(planAlerts.length, 1);
  assert.match(planAlerts[0]!.title, /套餐额度 已用 95%/u);
  usage.windows.pop();
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => metric.label), ["套餐"]);
});

const withCodexPool = () => {
  const data = snapshot();
  const pool = structuredClone(data.machines[0]!);
  pool.id = "pool"; pool.source = "account-pool";
  pool.providers[0]!.id = "account-pool:codex";
  data.machines.push(pool);
  const cursor = structuredClone(data.machines[0]!.providers[0]!);
  cursor.id = "acp-cursor-sdk"; cursor.displayName = "Cursor (SDK)";
  data.machines[0]!.providers.push(cursor);
  return data;
};

test("usable Codex pool replaces native Codex in both display modes and reminders while retaining Cursor and raw data", () => {
  const data = withCodexPool();
  const raw = structuredClone(data);
  for (const hideFailures of [true, false]) {
    const visible = visibleQuota(data, hideFailures)!;
    assert.deepEqual(visible.machines.flatMap(machine => machine.providers.map(provider => provider.id)), ["acp-cursor-sdk", "account-pool:codex"]);
  }
  const track = createQuotaAlertTracker();
  const low = structuredClone(data);
  for (const machine of low.machines) for (const provider of machine.providers) for (const account of provider.accounts) {
    if (account.usage.status === "ok") for (const window of account.usage.windows) window.usedPercent = 79;
  }
  track(low);
  const alerts = track(data);
  assert.equal(alerts.length, 2);
  assert.deepEqual(data, raw);
});

test("native Codex remains a fallback for unavailable, cached, empty or non-Codex pools", () => {
  for (const kind of ["offline", "cached", "empty", "failed", "claude"] as const) {
    const data = withCodexPool();
    const pool = data.machines[1]!;
    if (kind === "offline") pool.status = "disconnected";
    if (kind === "cached") pool.error = "Showing cached usage";
    if (kind === "empty") pool.providers = [];
    if (kind === "failed") pool.providers[0]!.accounts = [];
    if (kind === "claude") pool.providers[0]!.id = "account-pool:claude-code";
    for (const hideFailures of [true, false]) assert(visibleQuota(data, hideFailures)!.machines[0]!.providers.some(provider => provider.id === "codex"), kind);
  }
});


test("compact Claude pools keep unknown weeks and model caps outside the measured all-model week", () => {
  const data = snapshot(); const provider = data.machines[0]!.providers[0]!;
  provider.id = "cliproxy-claude";
  const make = (key: string, weight: number, weekly: number | null) => ({ key, label: key, weight,
    usage: { status: "ok" as const, planLabel: null, windows: [
      ...(weekly === null ? [] : [{ label: "Weekly limit", usedPercent: weekly, resetsAt: null }]),
      { label: "5-hour limit", usedPercent: 100, resetsAt: null },
      { label: "Weekly scoped limit", usedPercent: 100, resetsAt: null },
    ] } });
  provider.accounts = [make("empty", 1, 100), make("full", 3, 0), make("unknown-team", 100, null)];
  const raw = structuredClone(provider);
  const summaries = compactPoolSummaries(provider, Date.now());
  assert.deepEqual(summaries.map(metric => [metric.label, metric.usedPercent]), [["周", 25]]);
  assert.equal(summaries[0]!.partial, true);
  assert.match(summaries[0]!.detail, /覆盖 2\/3/u);
  assert.match(summaries[0]!.detail, /1 个账号未返回总周额度/u);
  assert.deepEqual(provider, raw);
  for (const id of ["claude", "claude-code", "cliproxy-claude", "account-pool:claude-code"]) {
    provider.id = id;
    assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => [metric.usedPercent, metric.partial]), [[25, true]]);
  }
  provider.accounts = [make("full", 3, 0), { key: "failed", label: "Failed", weight: 100,
    usage: { status: "error", message: "Unavailable" } }];
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => [metric.usedPercent, metric.partial]), [[0, true]]);
  provider.accounts = [make("only-unknown", 1, null)];
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => [metric.usedPercent, metric.partial]), [[null, false]]);
});

test("compact model-family weeks and Cursor budgets use independent weighted pool denominators", () => {
  const provider = snapshot().machines[0]!.providers[0]!;
  provider.id = "cliproxy-antigravity";
  const make = (key: string, weight: number, gem: number, partner: number) => ({ key, label: key, weight,
    usage: { status: "ok" as const, planLabel: null, windows: [
      { label: "Gemini Models: Weekly limit", usedPercent: gem, resetsAt: null },
      { label: "Claude and GPT models: Weekly limit", usedPercent: partner, resetsAt: null },
      { label: "Gemini Models: 5-hour limit", usedPercent: 100, resetsAt: null },
    ] } });
  provider.accounts = [make("a", 1, 100, 10), make("b", 3, 0, 90)];
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => [metric.label, metric.usedPercent]), [["Gem周", 25], ["C/G周", 70]]);
  provider.id = "acp-cursor-sdk";
  for (const account of provider.accounts) if (account.usage.status === "ok") {
    account.usage.windows[0]!.label = "Plan usage";
    account.usage.windows[1]!.label = "On-demand spend";
    account.usage.windows.pop();
  }
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => [metric.label, metric.usedPercent]), [["套餐", 25], ["按量", 70]]);
});

test("compact pools preserve legacy account grouping, short-window fallback and empty failures", () => {
  const provider = snapshot().machines[0]!.providers[0]!;
  provider.accounts = [];
  provider.usage = { status: "ok", planLabel: null, windows: [
    { accountLabel: "A", label: "A · Weekly limit", usedPercent: 100, resetsAt: null },
    { accountLabel: "B", label: "B · Weekly limit", usedPercent: 0, resetsAt: null },
  ] };
  assert.deepEqual(compactPoolSummaries(provider, Date.now()).map(metric => metric.usedPercent), [50]);
  provider.usage.windows = provider.usage.windows.map(window => ({ ...window, label: window.label.replace("Weekly limit", "5-hour limit") }));
  const short = compactPoolSummaries(provider, Date.now());
  assert.equal(short[0]!.usedPercent, 50);
  assert.equal(short[0]!.fullLabel, "池 5h");
  provider.usage = { status: "error", message: "Unavailable" };
  assert.deepEqual(compactPoolSummaries(provider, Date.now()), []);
});


test("persistent reminders use stable window identities and known reset cycles across tracker instances", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const data = snapshot(85); const usage = data.machines[0]!.providers[0]!.accounts[0]!.usage;
  if (usage.status !== "ok") throw new Error("Invalid fixture");
  usage.windows.push({ id: "session", label: "5-hour limit", usedPercent: 85, resetsAt: null });
  const existingPage = createQuotaAlertTracker(storage);
  const secondPage = createQuotaAlertTracker(storage);
  assert.equal(existingPage(data).length, 0);
  usage.windows.reverse();
  assert.equal(secondPage(data).length, 0);
  const week = usage.windows.find(window => window.id === "weekly")!;
  const reset = new Date(Date.now() + 7 * 86_400_000).toISOString();
  week.resetsAt = reset;
  assert.equal(existingPage(data).length, 0);
  week.resetsAt = reset.replace("Z", "+00:00");
  assert.equal(existingPage(data).length, 0);
  week.resetsAt = new Date(Date.parse(reset) + 7 * 86_400_000).toISOString();
  assert.equal(existingPage(data).length, 1);
  usage.windows.push({ ...week, usedPercent: 0 });
  assert.equal(existingPage(data).length, 0);
  assert.equal(existingPage(data).length, 0);
});

test("invalid or unavailable reminder storage preserves per-page deduplication without crashing", () => {
  for (const initial of ["broken JSON", JSON.stringify([["fake", { level: 9, resetsAt: null }]])]) {
    let value = initial;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    const track = createQuotaAlertTracker(storage);
    assert.equal(track(snapshot()).length, 0);
    assert.equal(track(snapshot(96)).length, 1);
    assert.equal(track(snapshot(96)).length, 0);
    assert.equal(createQuotaAlertTracker(storage)(snapshot(96)).length, 0);
  }
  const unavailable = { getItem: (): string | null => { throw new Error("Storage blocked"); }, setItem: () => { throw new Error("Storage full"); } };
  const track = createQuotaAlertTracker(unavailable);
  assert.equal(track(snapshot()).length, 0);
  assert.equal(track(snapshot(96)).length, 1);
  assert.equal(track(snapshot(96)).length, 0);
});

test("failed and empty startup observations do not turn the first available quota into a new alert", () => {
  const track = createQuotaAlertTracker();
  assert.equal(track({ machines: [] }).length, 0);
  const failed = snapshot(96); failed.machines[0]!.error = "Cached quota";
  assert.equal(track(failed).length, 0);
  assert.equal(track(snapshot(85)).length, 0);
  assert.equal(track(snapshot(96)).length, 1);
  assert.equal(track(snapshot(96)).length, 0);
});

test("a quota window discovered after startup is seeded quietly before later threshold crossings", () => {
  const track = createQuotaAlertTracker();
  const data = snapshot(20);
  assert.equal(track(data).length, 0);
  const usage = data.machines[0]!.providers[0]!.accounts[0]!.usage;
  if (usage.status !== "ok") throw new Error("Invalid fixture");
  usage.windows.push({ id: "new-session", label: "5-hour limit", usedPercent: 85, resetsAt: null });
  assert.equal(track(data).length, 0);
  usage.windows[1]!.usedPercent = 96;
  assert.equal(track(data).length, 1);
});

test("quota percentages distinguish small values from exact zero and full capacity", () => {
  for (const [value, expected] of [[0, "0"], [0.001, "<0.1"], [0.1, "0.1"], [0.328685, "0.3"], [1, "1"], [25.3, "25"], [99.671315, "99.7"], [99.99, ">99.9"], [100, "100"]] as const) {
    assert.equal(formatQuotaPercent(value), expected);
  }
});

test("missing Claude weeks are marked within their own tier and never hidden by another tier", () => {
  const provider = snapshot().machines[0]!.providers[0]!; provider.id = "cliproxy-claude";
  const make = (key: string, planLabel: string, weekly: boolean) => ({ key, label: key, weight: 1,
    usage: { status: "ok" as const, planLabel, windows: [{ label: weekly ? "Weekly limit" : "Weekly scoped limit", usedPercent: 30, resetsAt: null }] } });
  provider.accounts = [make("pro-weekly", "Pro", true), make("pro-scoped", "Pro", false), make("team-scoped", "Team", false)];
  const metrics = compactPoolSummaries(provider, Date.now());
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0]!.usedPercent, 30); assert.equal(metrics[0]!.partial, true);
  assert.match(metrics[0]!.detail, /覆盖 1\/2/u); assert.match(metrics[0]!.detail, /1 个账号未返回/u);
  assert.equal(metrics[1]!.usedPercent, null); assert.match(metrics[1]!.detail, /Team/u);
});
