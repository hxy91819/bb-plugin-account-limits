import assert from "node:assert/strict";
import { test } from "node:test";
import type { QuotaAccount } from "./contract.js";
import { aggregateCliproxyPool, groupAccountPools, groupProviderAccountTypes } from "./pool.js";
import { buildPoolRecovery } from "./pool-recovery.js";
import { buildWeeklyPace } from "./weekly-pace.js";

const now = Date.parse("2026-11-01T00:00:00Z");
function account(key: string, plan: string, used: number, weekly = true): QuotaAccount {
  return { key, label: `Fictional ${key}`, weight: 1, updatedAt: new Date(now).toISOString(), usage: { status: "ok", planLabel: plan, windows: [
    { label: "5-hour limit", usedPercent: 95, resetsAt: "2026-11-01T03:00:00Z" },
    ...(weekly ? [{ label: "Weekly limit", usedPercent: used, resetsAt: "2026-11-05T00:00:00Z" }] : []),
    { label: "Weekly scoped limit", usedPercent: 99, resetsAt: "2026-11-05T00:00:00Z" },
  ] } };
}

test("eight Claude accounts share a weighted total week, with Team estimates and unchanged raw detail", () => {
  const accounts = [account("a", "Pro", 100), account("b", "Max 5x", 40),
    account("c", "Max 20x", 20), account("d", "Ultra", 80), account("e", "Ultra (cached)", 100), account("f", "Ultra", 100),
    account("g", "Team 5x · team_tier_1", 50), account("h", "Team 5x · team_tier_2", 30)];
  const original = structuredClone(accounts);
  const types = groupProviderAccountTypes("cliproxy-claude", accounts);
  assert.equal(types.length, 1);
  assert.equal(types[0]!.accounts.length, 8);
  assert.match(types[0]!.label!, /含估算/u);
  assert.match(types[0]!.note!, /Team.*×5.*估算.*并非官方/u);
  const groups = groupAccountPools("cliproxy-claude", accounts);
  assert.equal(groups.length, 1);
  const pool = aggregateCliproxyPool(groups[0]!.accounts);
  assert.equal(pool.status, "ok"); if (pool.status !== "ok") return;
  assert.equal(pool.totalAccounts, 8);
  assert.deepEqual(pool.windows.map(w => w.id), ["7d"]);
  assert.ok(Math.abs((100 - pool.windows[0]!.usedPercent) - 1900 / 56) < 1e-10);
  const recovery = buildPoolRecovery(groups[0]!.accounts, "7d", now)!;
  assert.equal(recovery.usedPercent, pool.windows[0]!.usedPercent);
  assert.equal(recovery.steps.at(-1)!.remainingPercent, 100);
  assert.equal(buildWeeklyPace(groups[0]!.accounts, "7d", now).remainingPercent, recovery.remainingPercent);
  assert.deepEqual(accounts, original);
  assert.equal(types[0]!.accounts[0]!.usage.status === "ok" && types[0]!.accounts[0]!.usage.windows.length, 3);
});

test("missing weeks and unidentified plans stay explicit; session exhaustion still blocks weekly pacing", () => {
  const known = account("a", "Ultra", 50), missing = account("b", "Team 5x · team_tier_1", 0, false);
  const groups = groupAccountPools("cliproxy-claude", [known, missing, account("c", "Max", 10), account("d", "constructor", 20)]);
  assert.equal(groups.length, 4);
  assert.equal(groups[0]!.kind, "default");
  assert.equal(groups[1]!.kind, "without-weekly");
  const pool = aggregateCliproxyPool(groups[0]!.accounts);
  assert.ok(pool.status === "ok"); assert.equal(pool.windows[0]!.usedPercent, 50);
  assert.equal(aggregateCliproxyPool(groups[1]!.accounts).status, "ok");
  const blocked = account("blocked", "Team 5x · team_tier_1", 20);
  assert.ok(blocked.usage.status === "ok"); blocked.usage.windows[0]!.usedPercent = 100;
  const input = groupAccountPools("cliproxy-claude", [blocked])[0]!.accounts;
  assert.equal(buildWeeklyPace(input, "7d", now).level, "blocked");
  assert.equal(groupAccountPools("cliproxy-antigravity", [known, missing]).length, 2);
  assert.equal(groupAccountPools("claude-code", [known, missing]).length, 2);
});

test("configured capacity factors apply consistently without changing the 1/5/10 weekly policy", () => {
  const pro = account("a", "Pro", 100); pro.weight = 2;
  const ultra = account("b", "Ultra", 0);
  const pool = aggregateCliproxyPool(groupAccountPools("cliproxy-claude", [pro, ultra])[0]!.accounts);
  assert.ok(pool.status === "ok"); assert.equal(pool.windows[0]!.usedPercent, 200 / 12);
});
