import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaAlertTracker, createQuotaUiStore, visibleQuota, cursorQuotaSummaries } from "./quota-presentation.js";
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
  assert.deepEqual(cursorQuotaSummaries(provider).map(metric => [metric.label, metric.usedPercent]), [["套餐", 23], ["按量", 81]]);
  const track = createQuotaAlertTracker();
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
  assert.deepEqual(cursorQuotaSummaries(provider).map(metric => metric.label), ["套餐"]);
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
  const alerts = createQuotaAlertTracker()(data);
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
