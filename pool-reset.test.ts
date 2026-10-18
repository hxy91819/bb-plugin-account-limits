import assert from "node:assert/strict";
import { test } from "node:test";
import type { QuotaAccount } from "./contract.js";
import { buildNextWeeklyReset } from "./pool-reset.js";

const now = Date.parse("2026-10-17T00:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
function account(key: string, remaining: number, hours: number): QuotaAccount {
  return { key, label: key, weight: 1, updatedAt: at(0), usage: { status: "ok", planLabel: null,
    windows: [{ label: "Weekly limit", usedPercent: 100 - remaining, resetsAt: at(hours) }] } };
}

test("nearest weekly batch includes completely unused accounts and never averages it with later accounts", () => {
  const accounts = [account("later", 0, 144), account("unused", 100, 7.5)];
  const before = JSON.stringify(accounts);
  const result = buildNextWeeklyReset(accounts, "7d", now);
  assert.equal(result.resetsAt, at(7.5));
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0]!.label, "unused");
  assert.equal(result.accounts[0]!.remainingPercent, 100);
  assert.equal(result.accounts[0]!.prioritize, true);
  assert.equal(JSON.stringify(accounts), before);
});

test("same-instant accounts retain individual remaining, exhausted and 5h-blocked states", () => {
  const blocked = account("blocked", 42, 7.5);
  if (blocked.usage.status === "ok") blocked.usage.windows.push({ label: "5-hour limit", usedPercent: 100, resetsAt: at(1) });
  const result = buildNextWeeklyReset([account("spent", 0, 7.5), blocked, account("little", 5, 7.5), account("later", 100, 8)], "7d", now);
  assert.deepEqual(result.accounts.map(a => [a.label, a.state, a.remainingPercent, a.prioritize]), [
    ["spent", "exhausted", 0, false], ["blocked", "blocked", 42, false], ["little", "available", 5, false],
  ]);
});

test("nearest reset uses the actual window ID and first matching observation, not a model cap", () => {
  const entry = account("a", 42, 7.5);
  if (entry.usage.status === "ok") entry.usage.windows = [
    { id: "fable", label: "Weekly scoped limit", usedPercent: 100, resetsAt: at(1) },
    { id: "weekly-all", label: "Weekly limit", usedPercent: 58, resetsAt: at(7.5) },
    { id: "weekly-all", label: "Weekly limit", usedPercent: 100, resetsAt: at(1) },
  ];
  const result = buildNextWeeklyReset([entry], "weekly-all", now);
  assert.equal(result.resetsAt, at(7.5));
  assert.equal(result.accounts[0]!.remainingPercent, 42);
  assert.equal(buildNextWeeklyReset([entry], "fable", now).resetsAt, null);
  assert.equal(buildNextWeeklyReset([entry], "7d", now).resetsAt, null);
});

test("Gemini group short limits do not block another group's upcoming weekly allowance", () => {
  const entry = account("a", 60, 7.5);
  if (entry.usage.status === "ok") entry.usage.windows = [
    { label: "Claude and GPT models: Weekly limit", usedPercent: 40, resetsAt: at(7.5) },
    { label: "Gemini Models: 5-hour limit", usedPercent: 100, resetsAt: at(1) },
  ];
  const result = buildNextWeeklyReset([entry], "C/G 7d", now);
  assert.equal(result.accounts[0]!.state, "available");
  assert.equal(result.accounts[0]!.prioritize, true);
});

test("stale, explicit-null and overdue measurements never become currently available or skip to a later reset", () => {
  for (const updatedAt of [null, at(-2), at(1)]) {
    const result = buildNextWeeklyReset([{ ...account("old", 60, 7.5), updatedAt }], "7d", now, at(0));
    assert.equal(result.accounts[0]!.state, "unknown");
    assert.equal(result.accounts[0]!.remainingPercent, null);
    assert.equal(result.accounts[0]!.prioritize, false);
  }
  const result = buildNextWeeklyReset([account("overdue", 60, -1), account("later", 80, 4)], "7d", now);
  assert.equal(result.resetsAt, at(-1));
  assert.deepEqual(result.accounts.map(a => a.label), ["overdue"]);
  assert.equal(result.accounts[0]!.state, "unknown");
  const legacy = { ...account("legacy", 42, 7.5), updatedAt: undefined };
  assert.equal(buildNextWeeklyReset([legacy], "7d", now, at(0)).accounts[0]!.remainingPercent, 42);
});

test("unknown windows and resets remain explicit while known upcoming batches can still be shown", () => {
  const unknownReset = account("unknown", 50, 7.5);
  if (unknownReset.usage.status === "ok") unknownReset.usage.windows[0]!.resetsAt = null;
  const failed: QuotaAccount = { key: "failed", label: "failed", weight: 1, usage: { status: "error", message: "offline" } };
  const result = buildNextWeeklyReset([account("known", 42, 7.5), unknownReset, failed], "7d", now);
  assert.equal(result.unknownAccounts, 2);
  assert.deepEqual(result.accounts.map(a => a.label), ["known"]);
  assert.deepEqual(buildNextWeeklyReset([unknownReset], "7d", now), { resetsAt: null, accounts: [], unknownAccounts: 1 });
});
