import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, useLayoutEffect, useState } from "react";
import { within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { AccountLimitsPanelSnapshot } from "./contract.js";
import { normalizeAntigravityUsage } from "./usage.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

test("sources fold independently, persist across mounts and absent proxies add no empty section", async t => {
  installTestPluginRuntime();
  dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [
    { id: "proxy", source: "cliproxy", displayName: "proxy", status: "connected", providers: [], error: null },
    { id: "pool", source: "account-pool", displayName: "pool", status: "connected", providers: [], error: null },
  ] };
  const render = () => renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  let slot = render();
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const summary = await slot.findByLabelText("CLI Proxy 来源");
  assert.equal(summary.parentElement!.hasAttribute("open"), true);
  await act(async () => { summary.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(summary.parentElement!.hasAttribute("open"), false);
  assert.equal(slot.getByLabelText("BB Account Pooler 来源").parentElement!.hasAttribute("open"), true);
  assert.equal(slot.inspection.rpcCalls.length, 1);
  slot.lifecycle.unmount();
  slot = render();
  assert.equal((await slot.findByLabelText("CLI Proxy 来源")).parentElement!.hasAttribute("open"), false);
  slot.lifecycle.unmount();
  snapshot.machines = snapshot.machines.filter(machine => machine.source === "account-pool");
  slot = render();
  await slot.findByLabelText("BB Account Pooler 来源");
  assert.equal(slot.queryByLabelText("CLI Proxy 来源"), null);
});

test("周额度建议覆盖两种来源和账号/池视图，模型上限与缺总周池不冒充总周建议", async t => {
  installTestPluginRuntime();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-15T00:00:00Z") });
  const app = await loadPluginApp(() => import("./app.js"));
  for (const source of ["cliproxy", "account-pool"] as const) {
    dom.window.localStorage.clear();
    const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const make = (key: string, remaining: number | null, hours: number) => ({ key, label: key, weight: 1, updatedAt: at(0),
      usage: { status: "ok" as const, planLabel: null, windows: [
        { label: "5-hour limit", usedPercent: 20, resetsAt: at(1) },
        ...(remaining === null ? [] : [{ ...(source === "account-pool" ? { id: "weekly-all" } : {}), label: "Weekly limit", usedPercent: 100 - remaining, resetsAt: at(hours) }]),
        { label: "Weekly scoped limit", usedPercent: 100, resetsAt: at(24) },
      ] } });
    const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: source, source, displayName: source, status: "connected", error: null,
      providers: [{ id: source === "cliproxy" ? "cliproxy-claude" : "account-pool:claude-code", displayName: "Claude", updatedAt: at(0),
        usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
          make("宽裕", 50, 24), make("正常", 80, 144), make("紧张", 20, 144), make("缺总周", null, 24),
        ] }, { id: "cliproxy-codex", displayName: "Codex", updatedAt: at(0), accounts: [],
          usage: { status: "ok", planLabel: null, windows: [
            { accountLabel: "旧版账号", label: "旧版账号 · Weekly limit", usedPercent: 50, resetsAt: at(24) },
          ] } }],
    }] };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
    t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
    await slot.findByText("Claude");
    for (const [name, advice] of [["宽裕", "可多用"], ["正常", "正常用"], ["紧张", "节约用"]]) {
      const account = within(slot.getByRole("region", { name: `${name} 的额度` }));
      assert.ok(account.getByRole("note", { name: new RegExp(`^周额度建议：${advice}`, "u") }));
      assert.equal(account.getAllByRole("note").length, 1);
    }
    assert.equal(within(slot.getByRole("region", { name: "缺总周 的额度" })).queryByRole("note"), null);
    assert.ok(within(slot.getByRole("region", { name: "旧版账号 的额度" })).getByRole("note", { name: /^周额度建议：可多用/u }));
    await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
    const pool = within(slot.getByRole("region", { name: "含全模型周额度 的池额度" }));
    assert.ok(pool.getByRole("note", { name: /^周额度建议：正常用/u }));
    assert.equal(within(slot.getByRole("region", { name: "未报告全模型周额度 的池额度" })).queryByRole("note"), null);
    await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
    assert.ok(pool.getByRole("note", { name: /^周额度建议：正常用/u }));
    await act(async () => { t.mock.timers.tick(61 * 60_000); });
    assert.ok(pool.getByRole("note", { name: /^周额度建议：暂不判断/u }));
    assert.equal(slot.inspection.rpcCalls.length, 1);
    slot.lifecycle.unmount();
  }
});

test("两种来源的池恢复分段以悬停提示展示，切换模式或跨过重置时间不增加实际余量和请求", async t => {
  installTestPluginRuntime();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-15T00:00:00Z") });
  const app = await loadPluginApp(() => import("./app.js"));
  for (const source of ["cliproxy", "account-pool"] as const) {
    dom.window.localStorage.clear();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const make = (key: string, weight: number, weekly: number | null, reset: string) => ({ key, label: key, weight,
      usage: { status: "ok" as const, planLabel: null, windows: [
        { ...(source === "account-pool" ? { id: "session" } : {}), label: "5-hour limit", usedPercent: 50, resetsAt: at(3_600_000) },
        ...(weekly === null ? [] : [{ ...(source === "account-pool" ? { id: "weekly-all" } : {}), label: "Weekly limit", usedPercent: weekly, resetsAt: reset }]),
        { ...(source === "account-pool" ? { id: "model-fable" } : {}), label: "Weekly scoped limit", usedPercent: 50, resetsAt: at(7_200_000) },
      ] } });
    const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: source, source, displayName: source, status: "connected", error: null,
      providers: [{ id: source === "cliproxy" ? "cliproxy-claude" : "account-pool:claude-code", displayName: "Claude", updatedAt: null,
        usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
          make("soon", 2, 100, at(30_000)), make("later", 1, 40, at(10_800_000)), make("separate", 100, null, at(999_999)),
        ] }],
    }] };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
    t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
    await slot.findByText("Claude");
    assert.equal(slot.queryByRole("button", { name: /恢复计划/u }), null);
    await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
    const group = within(slot.getByRole("region", { name: "含全模型周额度 的池额度" }));
    const weekly = () => group.getByRole("progressbar", { name: /^(7d) (剩余|已用)额度$/u });
    assert.equal(weekly().getAttribute("aria-valuenow"), "20");
    assert.equal(slot.queryByRole("button", { name: /恢复计划/u }), null);
    assert.equal(slot.queryByRole("dialog", { hidden: true }), null);
    assert.ok(group.getByTitle(/预计恢复 66.7 个百分点 · 预计剩余 86.7%/u));
    assert.ok(group.getByTitle(/预计恢复 13.3 个百分点 · 预计剩余 100%/u));
    await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
    assert.equal(weekly().getAttribute("aria-valuenow"), "80");
    assert.ok(group.getByTitle(/预计恢复 66.7 个百分点 · 预计剩余 86.7%/u));
    await act(async () => { t.mock.timers.tick(60_000); });
    assert.equal(weekly().getAttribute("aria-valuenow"), "80");
    assert.ok(group.getByTitle("已到重置时间，待刷新 · 66.7 个百分点"));
    assert.ok(group.getByTitle(/预计恢复 13.3 个百分点 · 预计剩余 33.3%/u));
    await act(async () => { slot.getByRole("button", { name: "账号" }).click(); });
    const account = within(slot.getByRole("region", { name: "later 的额度" }));
    assert.ok(account.getByText("还剩 2 小时 59 分钟重置"));
    assert.equal(slot.inspection.rpcCalls.length, 1);
    slot.lifecycle.unmount();
  }
});

test("概览统计账号记录、去掉重复身份标签，并保留多个模型各自的上限与重置时间", async t => {
  installTestPluginRuntime();
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.hide-failures", "false");
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-15T00:00:00Z") });
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "local", source: "cliproxy", displayName: "本机", status: "connected", error: null,
    providers: [
      { id: "cliproxy-claude", displayName: "Claude", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
        { key: "work", label: "工作账号", weight: 1, usage: { status: "ok", planLabel: "工作账号", windows: [
          { label: "Weekly limit", usedPercent: 100, resetsAt: "2026-10-16T00:00:00Z" },
          { label: "Weekly scoped limit", usedPercent: 70, resetsAt: "2026-10-17T00:00:00Z" },
          { label: "Weekly Opus limit", usedPercent: 20, resetsAt: "2026-10-18T00:00:00Z" },
        ] } },
        { key: "other", label: "备用账号", weight: 1, usage: { status: "ok", planLabel: "Team Premium", windows: [] } },
        { key: "expired", label: "过期账号", weight: 1, usage: { status: "expired" } },
      ] },
      { id: "cliproxy-codex", displayName: "Codex", updatedAt: null, accounts: [], usage: { status: "ok", planLabel: null,
        windows: [{ accountLabel: "旧版账号", label: "Weekly limit", usedPercent: 25, resetsAt: null }] } },
    ] }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Claude");
  assert.ok(slot.getByRole("heading", { level: 1, name: "账户额度" }));
  const overview = within(slot.getByLabelText("额度记录概览"));
  assert.ok(overview.getByText("2"));
  assert.ok(overview.getByText("4"));
  const work = within(slot.getByRole("region", { name: "工作账号 的额度" }));
  assert.equal(work.getAllByText("工作账号").length, 1);
  assert.ok(slot.getByText("Team Premium"));
  assert.ok(slot.getByText("账号登录已过期。"));
  const caps = within(work.getByRole("group", { name: "模型周上限" }));
  assert.equal(caps.getByRole("progressbar", { name: "Weekly scoped limit 剩余额度" }).getAttribute("aria-valuenow"), "30");
  assert.equal(caps.getByRole("progressbar", { name: "Weekly Opus limit 剩余额度" }).getAttribute("aria-valuenow"), "80");
  assert.ok(caps.getByText("还剩 2 天 0 小时重置"));
  assert.ok(caps.getByText("还剩 3 天 0 小时重置"));
  assert.equal(slot.getAllByText(/不可相加/).length, 1);
  assert.ok(slot.getByRole("region", { name: "旧版账号 的额度" }));
});

test("初次读取有加载状态，空数据可刷新，刷新失败保留页面并恢复操作", async t => {
  installTestPluginRuntime();
  dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  let resolveInitial!: (snapshot: AccountLimitsPanelSnapshot) => void;
  const initial = new Promise<AccountLimitsPanelSnapshot>(resolve => { resolveInitial = resolve; });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: (input: unknown) => {
    if ((input as { force?: boolean }).force) throw new Error("暂时无法刷新");
    return initial;
  } } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  assert.ok(slot.getByRole("status").textContent?.includes("正在读取账户额度"));
  assert.equal((slot.getByRole("button", { name: "刷新全部" }) as HTMLButtonElement).disabled, true);
  await act(async () => { resolveInitial({ machines: [] }); });
  assert.ok(await slot.findByText("暂无已接入的额度来源。请在 BB 配置支持额度查询的账户，也可接入 Account Pooler 或 CLI Proxy。"));
  await act(async () => { slot.getByRole("button", { name: "刷新全部" }).click(); });
  assert.equal(slot.getByRole("alert").textContent, "暂时无法刷新");
  assert.ok(slot.getByText("暂无已接入的额度来源。请在 BB 配置支持额度查询的账户，也可接入 Account Pooler 或 CLI Proxy。"));
  assert.equal((slot.getByRole("button", { name: "刷新全部" }) as HTMLButtonElement).disabled, false);
  assert.deepEqual(slot.inspection.rpcCalls.map(call => call.input), [{}, { force: true }]);
});

test("Claude 将模型周上限置于总周额度之下，两种来源及账号和池视图都保持原始百分比", async t => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  for (const source of ["cliproxy", "account-pool"] as const) {
    dom.window.localStorage.clear();
    const windows = [
      { label: "5-hour limit", usedPercent: 0, resetsAt: null },
      { label: "Weekly limit", usedPercent: 100, resetsAt: "2026-10-20T00:00:00Z" },
      { label: source === "cliproxy" ? "Weekly scoped limit" : "Weekly · fable", usedPercent: 27, resetsAt: "2026-10-21T00:00:00Z" },
    ];
    const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: source, source, displayName: source,
      status: "connected", error: null, providers: [{
        id: source === "cliproxy" ? "cliproxy-claude" : "account-pool:claude-code", displayName: "Claude",
        updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] },
        accounts: [
          { key: "regular", label: "总周已耗尽", weight: 1, usage: { status: "ok", planLabel: null, windows } },
          { key: "missing", label: "未报总周", weight: 1, usage: { status: "ok", planLabel: null, windows: windows.filter(w => w.label !== "Weekly limit") } },
        ],
      }],
    }] };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
    t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
    await slot.findByText("Claude");
    const regular = within(slot.getByRole("region", { name: "总周已耗尽 的额度" }));
    const weekly = within(regular.getByRole("group", { name: "周额度" }));
    assert.ok(weekly.getByText("总周额度"));
    assert.ok(weekly.getByText("总周额度已用尽"));
    assert.equal(slot.getAllByText(/不可相加/).length, 1);
    assert.equal(weekly.getByRole("progressbar", { name: "Weekly limit 剩余额度" }).getAttribute("aria-valuenow"), "0");
    const scoped = within(weekly.getByRole("group", { name: "模型周上限" }));
    assert.ok(scoped.getByText("Fable 周上限"));
    assert.equal(scoped.getByRole("progressbar").getAttribute("aria-valuenow"), "73");
    assert.match(scoped.getByRole("progressbar").getAttribute("aria-valuetext")!, /以 Fable 自身周上限计算/);
    assert.ok(scoped.getByText(/重置/));
    const missing = within(slot.getByRole("region", { name: "未报总周 的额度" }));
    assert.ok(missing.getByText("总周额度未返回"));
    assert.equal(missing.getAllByRole("progressbar").length, 2);
    assert.ok(!missing.queryByText("总周额度已用尽"));
    await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
    assert.equal(scoped.getByRole("progressbar").getAttribute("aria-valuenow"), "27");
    assert.equal(weekly.getByRole("progressbar", { name: "Weekly limit 已用额度" }).getAttribute("aria-valuenow"), "100");
    await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
    const regularPool = within(slot.getByRole("region", { name: "含全模型周额度 的池额度" }));
    const poolWeekly = within(regularPool.getByRole("group", { name: "周额度" }));
    assert.equal(slot.getAllByText(/不可相加/).length, 1);
    assert.equal(within(poolWeekly.getByRole("group", { name: "模型周上限" })).getByRole("progressbar").getAttribute("aria-valuenow"), "27");
    assert.ok(within(slot.getByRole("region", { name: "未报告全模型周额度 的池额度" })).getByText("总周额度未返回"));
    slot.lifecycle.unmount();
  }
});

test("Antigravity 面板显示实际套餐，周额度耗尽时不显示停用的 5h 余量", async t => {
  installTestPluginRuntime();
  dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const accounts = ["Ultra", "Pro"].map(tier => {
    const usage = normalizeAntigravityUsage({ groups: [
      { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 1 }] },
      { displayName: "Claude and GPT models", buckets: [
        { window: "weekly", remainingFraction: tier === "Pro" ? 0 : 1 },
        { window: "5h", remainingFraction: 1, disabled: tier === "Pro" },
      ] },
    ] }, { provider: "antigravity", authIndex: tier }, `Google AI ${tier}`);
    assert.ok(usage.supported && usage.usage.status === "ok");
    return { key: tier, label: `${tier} account`, weight: 1,
      usage: { status: "ok" as const, planLabel: usage.usage.planLabel, windows: usage.usage.windows } };
  });
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{
    id: "test-host", source: "cliproxy", displayName: "本机", status: "connected", error: null,
    providers: [{ id: "cliproxy-antigravity", displayName: "Gemini · Antigravity", updatedAt: null,
      usage: { status: "ok", planLabel: null, windows: [] }, accounts }],
  }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Google AI Ultra");
  await slot.findByText("Google AI Pro");
  const pro = within(slot.getByRole("region", { name: "Pro account 的额度" }));
  assert.equal(pro.queryByRole("progressbar", { name: "Claude and GPT models: 5-hour limit 剩余额度" }), null);
  assert.equal(pro.getByRole("progressbar", { name: "Claude and GPT models: Weekly limit 剩余额度" }).getAttribute("aria-valuenow"), "0");
  const ultra = within(slot.getByRole("region", { name: "Ultra account 的额度" }));
  assert.equal(ultra.getByRole("progressbar", { name: "Claude and GPT models: 5-hour limit 剩余额度" }).getAttribute("aria-valuenow"), "100");
});

test("Claude 池视图把没有全模型周额度的账号单独合并，两种来源共用分组", async t => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  for (const source of ["cliproxy", "account-pool"] as const) {
    dom.window.localStorage.clear();
    const account = (key: string, percent: number, weekly: boolean, weight: number) => ({
      key, label: key, weight, usage: { status: "ok" as const, planLabel: null, windows: [
        { label: "5-hour limit", usedPercent: percent, resetsAt: null },
        ...(weekly ? [{ label: "Weekly limit", usedPercent: 50, resetsAt: null }] : []),
        { label: "Weekly scoped limit", usedPercent: percent, resetsAt: null },
      ] },
    });
    const snapshot: AccountLimitsPanelSnapshot = { machines: [{
      id: source, source, displayName: source, status: "connected", error: null,
      providers: [{ id: source === "cliproxy" ? "cliproxy-claude" : "account-pool:claude-code",
        displayName: "Claude", updatedAt: null,
        usage: { status: "ok", planLabel: null, windows: [] },
        accounts: [account("有周额度 A", 20, true, 2), account("有周额度 B", 80, true, 1),
          account("未报周额度 A", 0, false, 2), account("未报周额度 B", 30, false, 1)],
      }],
    }] };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
    t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
    await slot.findByText("Claude");
    await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
    const regular = within(slot.getByRole("region", { name: "含全模型周额度 的池额度" }));
    const withoutWeekly = within(slot.getByRole("region", { name: "未报告全模型周额度 的池额度" }));
    assert.equal(regular.getByRole("progressbar", { name: "5h 剩余额度" }).getAttribute("aria-valuenow"), "60");
    assert.equal(withoutWeekly.getByRole("progressbar", { name: "5h 剩余额度" }).getAttribute("aria-valuenow"), "90");
    assert.equal(regular.getByRole("progressbar", { name: "7d 剩余额度" }).getAttribute("aria-valuenow"), "50");
    assert.equal(withoutWeekly.queryByRole("progressbar", { name: "7d 剩余额度" }), null);
    assert.equal(withoutWeekly.getByRole("progressbar", { name: "scoped 剩余额度" }).getAttribute("aria-valuenow"), "90");
    assert.ok(regular.getAllByText(/覆盖 2\/2/).length > 0);
    assert.ok(withoutWeekly.getAllByText(/覆盖 2\/2/).length > 0);
    await act(async () => { slot.getByRole("button", { name: "账号" }).click(); });
    assert.ok(slot.getByRole("region", { name: "未报周额度 A 的额度" }));
    slot.lifecycle.unmount();
  }
});

test("账户额度导航使用插件的额度图标", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.navPanels.find(panel => panel.path === "account-limits");
  const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(panel?.icon, "account-limits/quota");
  assert.equal(manifest.bb.branding.experimental_icons.quota, manifest.bb.branding.icon);
});

test("账户额度页面注册为导航面板并显示独立 Cliproxy 数据", async () => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  assert.equal(app.navPanels.length, 1);
  assert.equal(app.navPanels[0]?.path, "account-limits");

  const snapshot: AccountLimitsPanelSnapshot = {
    machines: [{
      id: "host-local",
      displayName: "本机",
      status: "connected",
      error: null,
      providers: [{
        id: "cliproxy-claude",
        displayName: "Claude",
        updatedAt: "2026-09-09T01:30:22.000Z",
        usage: {
          status: "ok",
          planLabel: "Claude · Cliproxy · 2/2 accounts",
          windows: [
            { accountLabel: "Claude 工作账号", label: "Claude 工作账号 · Weekly limit", usedPercent: 25, resetsAt: "2026-09-15T01:30:22.000Z" },
            { accountLabel: "Claude 个人账号", label: "Claude 个人账号 · 5-hour limit", usedPercent: 50, resetsAt: "2026-09-10T01:30:22.000Z" },
          ],
        },
        accounts: [
          { key: "claude-work", label: "Claude 工作账号", weight: 1, usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 25, resetsAt: "2026-09-15T01:30:22.000Z" }] } },
          { key: "claude-personal", label: "Claude 个人账号", weight: 1, usage: { status: "ok", planLabel: null, windows: [{ label: "5-hour limit", usedPercent: 50, resetsAt: "2026-09-10T01:30:22.000Z" }] } },
        ],
      }],
    }],
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: { readAccountLimits: () => snapshot },
  });
  await slot.findByText("Claude");
  assert.ok(slot.getByText("2/2"));
  assert.ok(slot.getByRole("region", { name: "Claude 工作账号 的额度" }));
  assert.ok(slot.getByRole("region", { name: "Claude 个人账号 的额度" }));
  await act(async () => {
    slot.getByRole("button", { name: "刷新 Claude 额度" }).click();
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(slot.getByRole("progressbar", { name: "Weekly limit 剩余额度" }).getAttribute("aria-valuenow"), "75");
  assert.deepEqual(slot.inspection.rpcCalls, [
    { method: "readAccountLimits", input: {} },
    { method: "readAccountLimits", input: { source: "cliproxy", providerIds: ["cliproxy-claude"], force: true } },
  ]);
  await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
  const usedMeter = slot.getByRole("progressbar", { name: "Weekly limit 已用额度" });
  assert.equal(usedMeter.getAttribute("aria-valuenow"), "25");
  assert.equal((usedMeter.firstElementChild as HTMLElement).style.width, "25%");
  assert.ok(slot.getByText("25%"));
  assert.equal(slot.inspection.rpcCalls.length, 2);
  slot.lifecycle.unmount();

  const restored = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  await restored.findByText("Claude");
  assert.equal(restored.getByRole("button", { name: "已用（Used）" }).getAttribute("aria-pressed"), "true");
  assert.equal(restored.getByRole("progressbar", { name: "Weekly limit 已用额度" }).getAttribute("aria-valuenow"), "25");
  await act(async () => { restored.getByRole("button", { name: "剩余" }).click(); });
  assert.equal(restored.getByRole("progressbar", { name: "Weekly limit 剩余额度" }).getAttribute("aria-valuenow"), "75");
  restored.lifecycle.unmount();
  const remaining = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  await remaining.findByText("Claude");
  assert.equal(remaining.getByRole("button", { name: "剩余" }).getAttribute("aria-pressed"), "true");
  remaining.lifecycle.unmount();
  dom.window.localStorage.clear();
});

test("池视图把同供应商账号额度聚合成一池并记住选择", async () => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = {
    machines: [{
      id: "host-local",
      displayName: "本机",
      status: "connected",
      error: null,
      providers: [{
        id: "cliproxy-claude",
        displayName: "Claude",
        updatedAt: "2026-09-09T01:30:22.000Z",
        usage: { status: "ok", planLabel: "Claude · Cliproxy · 2/2 accounts", windows: [
          { accountLabel: "Claude 工作账号", label: "Claude 工作账号 · Weekly limit", usedPercent: 20, resetsAt: "2026-09-15T01:30:22.000Z" },
          { accountLabel: "Claude 个人账号", label: "Claude 个人账号 · Weekly limit", usedPercent: 60, resetsAt: "2026-09-12T01:30:22.000Z" },
        ] },
        accounts: [
          { key: "k1", label: "Claude 工作账号", weight: 3, usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 20, resetsAt: "2026-09-15T01:30:22.000Z" }] } },
          { key: "k2", label: "Claude 个人账号", weight: 1, usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 60, resetsAt: "2026-09-12T01:30:22.000Z" }] } },
        ],
      }],
    }],
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  await slot.findByText("Claude");
  assert.ok(slot.getByRole("region", { name: "Claude 工作账号 的额度" }));
  await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
  // (3×20 + 1×60) / 4 = 30，剩余模式显示 70%；覆盖 2/2。
  const meter = slot.getByRole("progressbar", { name: "7d 剩余额度" });
  assert.equal(meter.getAttribute("aria-valuenow"), "70");
  assert.ok(slot.getByText(/覆盖 2\/2/));
  assert.equal(slot.queryByRole("region", { name: "Claude 工作账号 的额度" }), null);
  slot.lifecycle.unmount();

  const restored = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  await restored.findByText("Claude");
  assert.equal(restored.getByRole("button", { name: "池" }).getAttribute("aria-pressed"), "true");
  assert.ok(restored.getByRole("progressbar", { name: "7d 剩余额度" }));
  restored.lifecycle.unmount();
  dom.window.localStorage.clear();
});

test("各账号额度直接显示重置倒计时，并随时间更新而不重新查询", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-09-27T00:00:00Z") });
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  const cases = [
    ["2026-09-29T03:40:00Z", "还剩 2 天 3 小时重置"],
    ["2026-09-27T03:17:00Z", "还剩 3 小时 17 分钟重置"],
    ["2026-09-27T00:02:00Z", "还剩 2 分钟重置"],
    ["2026-09-27T00:00:30Z", "不到 1 分钟重置"],
    ["2026-09-27T00:00:00Z", "已到重置时间，待刷新"],
    [null, "重置时间未知"],
  ] as const;
  const snapshot: AccountLimitsPanelSnapshot = {
    machines: [{ id: "local", displayName: "本机", status: "connected", error: null,
      providers: [{ id: "cliproxy-claude", displayName: "Claude", updatedAt: "2026-09-27T00:00:00Z",
        usage: { status: "ok", planLabel: null, windows: cases.map(([resetsAt], index) => ({
          accountLabel: `账号 ${index}`, label: "Weekly limit", usedPercent: 25, resetsAt,
        })) },
        accounts: cases.map(([resetsAt], index) => ({
          key: `account-${index}`, label: `账号 ${index}`, weight: 1,
          usage: { status: "ok" as const, planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 25, resetsAt }] },
        })),
      }],
    }],
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => slot.lifecycle.unmount());
  await slot.findByText("Claude");
  for (const [index, [, expected]] of cases.entries()) {
    const account = slot.getByRole("region", { name: `账号 ${index} 的额度` });
    assert.ok(account.textContent?.includes(expected), `${expected} must be visible in the account row`);
    assert.ok(!account.textContent?.includes("2026-"));
  }
  await act(async () => { t.mock.timers.tick(60_000); });
  assert.ok(slot.getByText("还剩 1 分钟重置"));
  assert.ok(slot.getByText("还剩 3 小时 16 分钟重置"));
  assert.ok(slot.getByRole("region", { name: "账号 3 的额度" }).textContent?.includes("已到重置时间，待刷新"));
  assert.equal(slot.inspection.rpcCalls.length, 1);
});

test("统一页面同时显示两种来源，共用池与账号切换，刷新 Account Pooler 保留 Cliproxy 并移除旧账号", async t => {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.hide-failures", "false");
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  const account = (key: string, percent: number) => ({ key, label: key, weight: 1,
    usage: { status: "ok" as const, planLabel: "Pro", windows: [{ label: "Weekly limit", usedPercent: percent, resetsAt: null }] } });
  const provider = (id: string, accounts: ReturnType<typeof account>[]) => ({
    id, displayName: id.endsWith("codex") ? "Codex" : "Claude", updatedAt: "2026-10-05T10:00:00Z",
    accounts, usage: { status: "ok" as const, planLabel: null, windows: accounts.flatMap(a => a.usage.windows.map(w => ({ ...w, accountLabel: a.label }))) },
  });
  const cliproxy: AccountLimitsPanelSnapshot["machines"][number] = {
    id: "local", displayName: "本机", status: "connected", error: null,
    providers: [provider("cliproxy-codex", [account("Cliproxy 账号", 20)])],
  };
  const pool: AccountLimitsPanelSnapshot["machines"][number] = {
    id: "source:account-pool", source: "account-pool", displayName: "Account Pooler", status: "connected", error: null,
    providers: [provider("account-pool:codex", [account("Pool A", 20), account("Pool B", 60)]),
      provider("account-pool:claude-code", [account("将被移除的账号", 30)])],
  };
  pool.providers[0]!.accounts.push({ key: "failed", label: "Pool 失败账号", weight: 1, usage: { status: "expired" } });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: (raw: unknown) => {
    const input = raw as { source?: string; force?: boolean };
    if (input.source === "account-pool") return { machines: [{ ...pool, providers: [provider("account-pool:codex", [account("Pool A", 80)])] }] };
    return { machines: [cliproxy, pool] };
  } } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByRole("region", { name: "Account Pooler 的账户额度" });
  const poolSection = () => within(slot.getByRole("region", { name: "Account Pooler 的账户额度" }));
  const clipSection = () => within(slot.getByRole("region", { name: "本机 的账户额度" }));
  assert.ok(poolSection().getByRole("region", { name: "Pool A 的额度" }));
  assert.ok(poolSection().getByRole("region", { name: "Pool B 的额度" }));
  assert.ok(poolSection().getByText("账号登录已过期。"));
  assert.ok(clipSection().getByText("Cliproxy"));
  await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
  assert.equal(poolSection().getAllByRole("progressbar")[0]!.getAttribute("aria-valuenow"), "60");
  assert.equal(clipSection().getByRole("progressbar").getAttribute("aria-valuenow"), "80");
  assert.ok(poolSection().getByText(/覆盖 2\/2/));
  assert.equal(poolSection().queryByRole("region", { name: "Pool A 的额度" }), null);
  await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(poolSection().getAllByRole("progressbar")[0]!.getAttribute("aria-valuenow"), "40");
  await act(async () => {
    slot.getByRole("button", { name: "刷新 Account Pooler Codex 额度" }).click();
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(poolSection().getByRole("progressbar").getAttribute("aria-valuenow"), "80");
  assert.equal(clipSection().getByRole("progressbar").getAttribute("aria-valuenow"), "20");
  assert.equal(poolSection().queryByRole("button", { name: "刷新 Account Pooler Claude 额度" }), null);
  assert.deepEqual(slot.inspection.rpcCalls, [
    { method: "readAccountLimits", input: {} },
    { method: "readAccountLimits", input: { source: "account-pool", providerIds: ["account-pool:codex"], force: true } },
  ]);
  await act(async () => { slot.getByRole("button", { name: "账号" }).click(); });
  assert.ok(poolSection().getByRole("region", { name: "Pool A 的额度" }));
  assert.equal(poolSection().queryByRole("region", { name: "Pool B 的额度" }), null);
});

test("Gemini 缓存窗口在账号和池视图按周主、5h 次排列，并保留模型分组", async t => {
  dom.window.localStorage.clear();
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  const windows = [
    { label: "Gemini Models: Weekly limit", usedPercent: 21, resetsAt: null },
    { label: "Gemini Models: 5-hour limit", usedPercent: 16, resetsAt: null },
    { label: "Claude and GPT models: Weekly limit", usedPercent: 31, resetsAt: null },
    { label: "Claude and GPT models: 5-hour limit", usedPercent: 26, resetsAt: null },
  ];
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{
    id: "local", displayName: "本机", status: "connected", error: null,
    providers: [{ id: "cliproxy-antigravity", displayName: "Gemini", updatedAt: "2026-10-05T10:00:00Z",
      accounts: [{ key: "gem", label: "Gemini 账号", weight: 1, usage: { status: "ok", planLabel: null, windows } }],
      usage: { status: "ok", planLabel: null, windows: windows.map(window => ({ ...window, accountLabel: "Gemini 账号" })) },
    }],
  }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Gemini 账号");
  assert.deepEqual(slot.getAllByRole("progressbar").map(meter => meter.getAttribute("aria-label")), [
    "Gemini Models: Weekly limit 剩余额度", "Gemini Models: 5-hour limit 剩余额度",
    "Claude and GPT models: Weekly limit 剩余额度", "Claude and GPT models: 5-hour limit 剩余额度",
  ]);
  await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
  assert.deepEqual(slot.getAllByRole("progressbar").map(meter => meter.getAttribute("aria-label")), [
    "Gem 7d 剩余额度", "Gem 5h 剩余额度", "C/G 7d 剩余额度", "C/G 5h 剩余额度",
  ]);
  assert.deepEqual(windows.map(window => window.usedPercent), [21, 16, 31, 26]);
});

test("BB native accounts render without optional sources and targeted refresh preserves other sources", async t => {
  installTestPluginRuntime();
  dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const native: AccountLimitsPanelSnapshot["machines"][number] = { id: "bb:local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
    providers: [{ id: "codex", displayName: "Native Codex", updatedAt: null,
      usage: { status: "ok", planLabel: "Pro", windows: [] }, accounts: [{ key: "codex", label: "demo@example.test", weight: 1,
        usage: { status: "ok", planLabel: "Pro", windows: [{ label: "Weekly limit", usedPercent: 40, resetsAt: null }] } }] }] };
  const pool: AccountLimitsPanelSnapshot["machines"][number] = { id: "pool", source: "account-pool", displayName: "Pool", status: "connected", error: null, providers: [] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: (raw: unknown) => ({ machines: (raw as { source?: string }).source ? [native] : [native, pool] }) } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByLabelText("BB 已有账户 来源");
  assert.ok(slot.getByText("demo@example.test"));
  assert.ok(slot.getByRole("progressbar", { name: /Weekly limit 剩余额度/u }));
  await act(async () => { slot.getByRole("button", { name: "刷新 Native Codex 额度" }).click(); });
  assert.ok(slot.getByLabelText("BB 已有账户 来源"));
  assert.ok(slot.getByLabelText("BB Account Pooler 来源"));
  assert.deepEqual(slot.inspection.rpcCalls.at(-1)?.input, { source: "bb-providers", providerIds: ["codex"], force: true });
});

test("failed accounts are hidden by default, can be restored, and the preference survives remount", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
    providers: [{ id: "claude-code", displayName: "Claude", updatedAt: null, usage: { status: "expired" },
      accounts: [{ key: "failed", label: "Failed account", weight: 1, usage: { status: "expired" } }] }] }] };
  const render = () => renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  let slot = render();
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText(/暂无可显示的额度/u);
  assert.equal((slot.getByRole("checkbox", { name: "隐藏获取失败" }) as HTMLInputElement).checked, true);
  assert.equal(slot.queryByText("Failed account"), null);
  await act(async () => { slot.getByRole("checkbox", { name: "隐藏获取失败" }).click(); });
  assert.ok(slot.getByText("Failed account"));
  assert.ok(slot.getByText("账号登录已过期。"));
  slot.lifecycle.unmount(); slot = render();
  assert.ok(await slot.findByText("Failed account"));
});

test("sidebar compact view shares data and preferences with full page and opens the full dashboard", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  assert.equal(footer.kind, "disclosure");
  if (footer.kind !== "disclosure") return;
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
    providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
      { key: "ok", label: "Healthy", weight: 1, usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 96, resetsAt: null }] } },
      { key: "bad", label: "Failed", weight: 1, usage: { status: "error", message: "No quota" } },
    ] }] }] };
  let reads = 0; let dismissed = 0;
  const rpc = { readAccountLimits: () => { reads++; return snapshot; } };
  const compact = renderSlot(footer, { dismiss: () => { dismissed++; } }, { rpc });
  t.after(() => { compact.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await compact.findByText("Healthy");
  assert.ok(compact.getByRole("button", { name: "Codex" }));
  assert.equal(compact.queryByText("Failed"), null);
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
  t.after(() => full.lifecycle.unmount());
  await within(full.container).findByText("Healthy");
  assert.equal(reads, 1);
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(within(compact.container).getByRole("progressbar", { name: "Weekly limit 已用额度" }).getAttribute("aria-valuenow"), "96");
  assert.ok(within(compact.container).getByRole("button", { name: "Codex" }));
  assert.ok(within(compact.container).getByText("已用额度 · 账号"));
  await act(async () => { within(full.container).getByRole("button", { name: "池" }).click(); });
  assert.ok(within(compact.container).getByText("已用额度 · 池"));
  assert.equal(within(compact.container).queryByText("Healthy"), null);
  await act(async () => { within(full.container).getByRole("button", { name: "账号" }).click(); within(full.container).getByRole("button", { name: "剩余" }).click(); });
  assert.equal(within(compact.container).getByRole("progressbar", { name: "Weekly limit 剩余额度" }).getAttribute("aria-valuenow"), "4");
  assert.equal(reads, 1);
  await act(async () => { compact.getByLabelText("额度显示设置").click(); });
  await act(async () => { compact.getByRole("checkbox", { name: "隐藏失败" }).click(); });
  assert.ok(within(compact.container).getByText("Failed"));
  assert.ok(within(full.container).getByText("Failed"));
  const beforeOpenFull = dismissed;
  await act(async () => { compact.getByRole("button", { name: "完整页面" }).click(); });
  assert.equal(dismissed, beforeOpenFull + 1);
  assert.equal(compact.inspection.navigateCalls.length, 1);
});

test("collapsed footer monitoring checks thresholds without duplicate alerts and stops on unmount", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-17T00:00:00Z") });
  const { toast } = await import("sonner");
  const warnings: string[] = [];
  t.mock.method(toast, "warning", (message: unknown) => { warnings.push(String(message)); return 1; });
  const app = await loadPluginApp(() => import("./app.js"));
  let used = 85; let reads = 0;
  const overlay = renderSlot(app.appOverlays[0]!, {}, { rpc: { readAccountLimits: () => {
    reads++;
    return { machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
      providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
        { key: "ok", label: "Healthy", weight: 1, usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: used, resetsAt: null }] } },
      ] }] }] };
  } } });
  t.after(() => { overlay.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(reads, 1); assert.equal(warnings.length, 0);
  used = 96;
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(reads, 2); assert.equal(warnings.length, 1);
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(reads, 3); assert.equal(warnings.length, 1);
  overlay.lifecycle.unmount();
  await act(async () => { t.mock.timers.tick(5 * 60_000); });
  assert.equal(reads, 3);
});

test("opening a page establishes a quiet baseline even when reminder history is absent", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-18T00:00:00Z") });
  const { toast } = await import("sonner");
  const warnings: string[] = [];
  t.mock.method(toast, "warning", (message: unknown) => { warnings.push(String(message)); return 1; });
  let used = 85; let resetsAt = "2026-10-24T00:00:00Z";
  let overlay: ReturnType<typeof renderSlot> | undefined;
  t.after(() => { overlay?.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const reenter = async () => {
    overlay?.lifecycle.unmount();
    const app = await loadPluginApp(() => import("./app.js"));
    overlay = renderSlot(app.appOverlays[0]!, {}, { rpc: { readAccountLimits: () => ({ machines: [{
      id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
      providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
        { key: "test", label: "Test account", weight: 1, usage: { status: "ok", planLabel: null, windows: [
          { id: "weekly", label: "Weekly limit", usedPercent: used, resetsAt },
        ] } },
      ] }],
    }] }) } });
    await act(async () => { await Promise.resolve(); });
  };
  await reenter(); assert.equal(warnings.length, 0);
  await reenter(); assert.equal(warnings.length, 0);
  dom.window.localStorage.removeItem("account-limits.alert-history.v1");
  await reenter(); assert.equal(warnings.length, 0);
  used = 96;
  await reenter(); assert.equal(warnings.length, 0);
  await reenter(); assert.equal(warnings.length, 0);
  used = 20;
  await reenter(); assert.equal(warnings.length, 0);
  used = 85;
  await reenter(); assert.equal(warnings.length, 0);
  resetsAt = "2026-10-31T00:00:00Z";
  await reenter(); assert.equal(warnings.length, 0);
  used = 96;
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(warnings.length, 1);
  await reenter(); assert.equal(warnings.length, 1);
});

test("reminders disabled at startup do not consume thresholds and the monitor never forces disclosure open", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.reminders", "false");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-17T00:00:00Z") });
  const { toast } = await import("sonner");
  const warnings: string[] = [];
  t.mock.method(toast, "warning", (message: unknown) => { warnings.push(String(message)); return 1; });
  const app = await loadPluginApp(() => import("./app.js"));
  let used = 85;
  const overlay = renderSlot(app.appOverlays[0]!, {}, { rpc: { readAccountLimits: () => ({ machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
    providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
      { key: "ok", label: "Healthy", weight: 1, usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: used, resetsAt: null }] } },
    ] }] }] }) } });
  t.after(() => { overlay.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const setReminders = async (enabled: boolean) => act(async () => {
    dom.window.localStorage.setItem("account-limits.reminders", String(enabled));
    dom.window.dispatchEvent(new dom.window.Event("storage"));
  });
  await act(async () => { await Promise.resolve(); });
  assert.equal(warnings.length, 0);
  assert.equal(app.experimentalSidebarFooterItems[0]!.runtime.getSnapshot().command, null);
  await setReminders(true);
  assert.equal(warnings.length, 0);
  await setReminders(false);
  used = 96;
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(warnings.length, 0);
  await setReminders(true);
  assert.equal(warnings.length, 1);
  await setReminders(false); await setReminders(true);
  assert.equal(warnings.length, 1);
});

test("hidden windows pause periodic reads; visibility and focus resume once and are cleaned up", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-17T00:00:00Z") });
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  t.after(() => { Reflect.deleteProperty(document, "visibilityState"); dom.window.localStorage.clear(); });
  const app = await loadPluginApp(() => import("./app.js"));
  let reads = 0;
  const overlay = renderSlot(app.appOverlays[0]!, {}, { rpc: { readAccountLimits: () => { reads++; return { machines: [] }; } } });
  t.after(() => overlay.lifecycle.unmount());
  await act(async () => { await Promise.resolve(); });
  assert.equal(reads, 1);
  visibility = "hidden";
  await act(async () => { t.mock.timers.tick(6 * 60_000); window.dispatchEvent(new window.Event("focus")); document.dispatchEvent(new window.Event("visibilitychange")); });
  assert.equal(reads, 1);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); await Promise.resolve(); });
  assert.equal(reads, 2);
  await act(async () => { window.dispatchEvent(new window.Event("focus")); document.dispatchEvent(new window.Event("visibilitychange")); });
  assert.equal(reads, 2);
  await act(async () => { t.mock.timers.tick(5 * 60_000 - 1); });
  assert.equal(reads, 2);
  await act(async () => { t.mock.timers.tick(1); window.dispatchEvent(new window.Event("focus")); await Promise.resolve(); });
  assert.equal(reads, 3);
  overlay.lifecycle.unmount();
  await act(async () => { t.mock.timers.tick(6 * 60_000); window.dispatchEvent(new window.Event("focus")); document.dispatchEvent(new window.Event("visibilitychange")); });
  assert.equal(reads, 3);
});

test("compact service cards show the weighted pool week instead of the worst account", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact panel");
  let reads = 0;
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "pool", source: "account-pool", displayName: "Pool", status: "connected", error: null,
    providers: [{ id: "account-pool:codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
      { key: "empty", label: "Empty", weight: 1, usage: { status: "ok", planLabel: null, windows: [
        { id: "week", label: "Weekly limit", usedPercent: 100, resetsAt: null },
        { id: "session", label: "5-hour limit", usedPercent: 100, resetsAt: null },
      ] } },
      { key: "full", label: "Full", weight: 3, usage: { status: "ok", planLabel: null, windows: [
        { id: "week", label: "Weekly limit", usedPercent: 0, resetsAt: null },
        { id: "session", label: "5-hour limit", usedPercent: 100, resetsAt: null },
      ] } },
    ] }] }] };
  const rpc = { readAccountLimits: () => { reads++; return snapshot; } };
  const compact = renderSlot(footer, { dismiss() {} }, { rpc });
  t.after(() => { compact.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const card = await compact.findByRole("button", { name: "Codex" });
  assert.equal(card.querySelector(".limits-compact-service-value")?.textContent, "75%");
  assert.match(card.title, /池.*周.*剩余 75%/u);
  assert.equal(card.getAttribute("data-tone"), "normal");
  assert.equal(within(compact.container).getByRole("progressbar", { name: "7d 剩余额度" }).getAttribute("aria-valuenow"), "75");
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
  t.after(() => full.lifecycle.unmount());
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(card.querySelector(".limits-compact-service-value")?.textContent, "25%");
  await act(async () => { within(full.container).getByRole("button", { name: "账号" }).click(); });
  assert.equal(card.querySelector(".limits-compact-service-value")?.textContent, "25%");
  assert.equal(reads, 1);
});

test("Gemini generous pace is colored independently from Claude/GPT in compact cards and meters", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  const now = Date.parse("2026-10-18T10:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact panel");
  const provider = { id: "cliproxy-antigravity", displayName: "Gemini", updatedAt: new Date(now).toISOString(),
    usage: { status: "ok" as const, planLabel: null, windows: [] }, accounts: [
      { key: "a", label: "Example", weight: 1, usage: { status: "ok" as const, planLabel: null, windows: [
        { label: "Gemini Models: Weekly limit", usedPercent: 50, resetsAt: new Date(now + 24 * 3600_000).toISOString() },
        { label: "Claude and GPT models: Weekly limit", usedPercent: 80, resetsAt: new Date(now + 144 * 3600_000).toISOString() },
        { label: "Gemini Models: 5-hour limit", usedPercent: 0, resetsAt: new Date(now + 3600_000).toISOString() },
        { label: "Claude and GPT models: 5-hour limit", usedPercent: 0, resetsAt: new Date(now + 3600_000).toISOString() },
      ] } },
    ] };
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "proxy", source: "cliproxy", displayName: "Proxy",
    status: "connected", error: null, providers: [provider] }] };
  const compact = renderSlot(footer, { dismiss() {} }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { compact.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const card = await compact.findByRole("button", { name: "Gemini" });
  const metrics = card.querySelectorAll(".limits-compact-service-metric");
  assert.equal(metrics[0]!.getAttribute("data-tone"), "generous");
  assert.equal(metrics[1]!.getAttribute("data-tone"), "warning");
  assert.match(card.title, /Gem.*可多用/u);
  assert.match(card.title, /C\/G.*节约用/u);
  assert.ok(within(compact.container).getByRole("note", { name: /^周额度建议：可多用/u }));
  assert.ok(compact.container.querySelector('.limits-meter[data-pace="generous"]'));
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => full.lifecycle.unmount());
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(metrics[0]!.getAttribute("data-tone"), "generous");
  provider.accounts[0]!.usage.windows[0]!.usedPercent = 80;
  provider.accounts[0]!.usage.windows[0]!.resetsAt = new Date(now + 3600_000).toISOString();
  await act(async () => { compact.getByRole("button", { name: "刷新精简额度" }).click(); });
  assert.equal(metrics[0]!.getAttribute("data-tone"), "generous");
  provider.accounts[0]!.usage.windows[2]!.usedPercent = 100;
  await act(async () => { compact.getByRole("button", { name: "刷新精简额度" }).click(); });
  assert.equal(metrics[0]!.getAttribute("data-tone"), "warning");
});

test("compact Claude card shows the measurable weighted week with an explicit partial-data marker", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact panel");
  const make = (key: string, weight: number, weekly: number | null) => ({ key, label: key, weight,
    usage: { status: "ok" as const, planLabel: null, windows: [
      ...(weekly === null ? [] : [{ label: "Weekly limit", usedPercent: weekly, resetsAt: null }]),
      { label: "5-hour limit", usedPercent: 100, resetsAt: null },
      { label: "Weekly scoped limit", usedPercent: 100, resetsAt: null },
    ] } });
  const provider = { id: "cliproxy-claude", displayName: "Claude", updatedAt: null,
    usage: { status: "ok" as const, planLabel: null, windows: [] },
    accounts: [make("Empty", 1, 100), make("Full", 3, 0), make("Team", 100, null)] };
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "proxy", source: "cliproxy", displayName: "Proxy",
    status: "connected", error: null, providers: [provider] }] };
  const compact = renderSlot(footer, { dismiss() {} }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { compact.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const card = await compact.findByRole("button", { name: "Claude" });
  const value = () => card.querySelector(".limits-compact-service-value")?.textContent;
  assert.equal(value(), "75%*");
  assert.match(card.title, /覆盖 2\/3/u);
  assert.match(card.title, /1 个账号未返回总周额度/u);
  assert.match(card.title, /\*.*仅统计已返回.*不代表全池/u);
  assert.equal(card.querySelector(".limits-compact-service-metrics"), null);
  assert.ok(within(compact.container).getByText("总周额度未返回"));
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => full.lifecycle.unmount());
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(value(), "25%*");
  provider.accounts = provider.accounts.slice(0, 2);
  await act(async () => { compact.getByRole("button", { name: "刷新精简额度" }).click(); });
  assert.equal(value(), "25%");
  provider.accounts = [make("Team", 100, null)];
  await act(async () => { compact.getByRole("button", { name: "刷新精简额度" }).click(); });
  assert.equal(value(), "—");
  assert.doesNotMatch(card.title, /\*/u);
});

test("Cursor shows subscription and on-demand budgets separately and follows the shared display mode", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact panel");
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
    providers: [{ id: "acp-cursor-sdk", displayName: "Cursor (SDK)", updatedAt: null, usage: { status: "ok", planLabel: "Team", windows: [] }, accounts: [
      { key: "cursor", label: "Cursor (SDK)", weight: 1, usage: { status: "ok", planLabel: "Team", windows: [
        { label: "Plan usage", usedPercent: 23, resetsAt: "2026-11-01T00:00:00Z" },
        { label: "On-demand spend", usedPercent: 81, resetsAt: "2026-11-02T00:00:00Z" },
      ] } },
    ] }] }] };
  const rpc = { readAccountLimits: () => snapshot };
  const compact = renderSlot(footer, { dismiss() {} }, { rpc });
  t.after(() => { compact.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const cursor = await compact.findByRole("button", { name: "Cursor (SDK) · Team" });
  assert.equal(cursor.querySelectorAll(".limits-compact-service-metric").length, 2);
  assert.match(cursor.textContent!, /套餐77%按量19%/u);
  assert.match(cursor.title, /套餐剩余 77%，按量剩余 19%/u);
  const meters = compact.container.querySelectorAll(".limits-meter");
  assert.equal(meters[0]!.hasAttribute("data-warning"), false);
  assert.equal(meters[1]!.getAttribute("data-warning"), "true");
  assert.ok(within(compact.container).getByText("套餐额度"));
  assert.ok(within(compact.container).getByText("按量预算"));
  assert.equal(within(compact.container).getAllByRole("progressbar").length, 2);
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
  t.after(() => full.lifecycle.unmount());
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.match(cursor.title, /套餐已用 23%，按量已用 81%/u);
  assert.match(cursor.textContent!, /套餐23%按量81%/u);
  assert.equal(within(compact.container).getByRole("progressbar", { name: "Plan usage 已用额度" }).getAttribute("aria-valuenow"), "23");
  assert.equal(within(compact.container).getByRole("progressbar", { name: "On-demand spend 已用额度" }).getAttribute("aria-valuenow"), "81");
  assert.ok(within(full.container).getByText("套餐额度"));
  assert.ok(within(full.container).getByText("按量预算"));
});

test("池把整池节奏和最近账号余量分开显示，两种来源及百分比模式均不额外请求", async t => {
  installTestPluginRuntime();
  const now = new Date("2026-10-17T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const app = await loadPluginApp(() => import("./app.js"));
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  for (const source of ["cliproxy", "account-pool"] as const) {
    dom.window.localStorage.clear();
    dom.window.localStorage.setItem("account-limits.view", "pool");
    const weeklyId = source === "account-pool" ? "weekly-all" : "7d";
    const make = (key: string, remaining: number, hours: number) => ({ key, label: key, weight: 1, updatedAt: at(0),
      usage: { status: "ok" as const, planLabel: null, windows: [
        { id: weeklyId, label: "Weekly limit", usedPercent: 100 - remaining, resetsAt: at(hours) },
        { label: "5-hour limit", usedPercent: 20, resetsAt: at(1) },
        { label: "Weekly scoped limit", usedPercent: 50, resetsAt: at(0.5) },
      ] } });
    const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: source, source, displayName: source, status: "connected", error: null,
      providers: [{ id: source === "cliproxy" ? "cliproxy-claude" : "account-pool:claude-code", displayName: "Claude", updatedAt: at(0),
        usage: { status: "ok", planLabel: null, windows: [] }, accounts: [make("最近账号", 60, 7.5), make("B", 0, 144), make("C", 0, 144), make("D", 30, 144), make("E", 65, 144)] }],
    }] };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
    t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
    await slot.findByText("Claude");
    const weekly = within(slot.getByRole("group", { name: "周额度" }));
    const advice = weekly.getByRole("note", { name: /^周额度建议：节约用/u });
    assert.match(advice.textContent!, /整池节奏.*节约用/u);
    const next = () => weekly.getByRole("note", { name: /^最近重置账号/u });
    assert.match(next().textContent!, /最近重置：7小时30分钟.*1 个账号.*周剩 60%.*建议先用/u);
    assert.match(next().getAttribute("title")!, /最近账号：周剩 60%/u);
    assert.ok(weekly.getByText(/覆盖 5\/5 · 全池 2 账号已耗尽/u));
    await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
    assert.match(next().textContent!, /周剩 60%/u);
    assert.equal(slot.queryByRole("button", { name: /恢复计划/u }), null);
    assert.equal(slot.queryByRole("dialog", { hidden: true }), null);
    await act(async () => { slot.getByRole("button", { name: "账号" }).click(); });
    assert.equal(slot.queryByText("整池节奏"), null);
    assert.equal(slot.queryByRole("note", { name: /^最近重置账号/u }), null);
    assert.equal(slot.inspection.rpcCalls.length, 1);
    slot.lifecycle.unmount();
  }
});

test("最近重置摘要显示同批账号状态，越过重置时等待确认并保留缓存值", async t => {
  installTestPluginRuntime();
  const now = new Date("2026-10-17T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  const app = await loadPluginApp(() => import("./app.js"));
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const make = (key: string, remaining: number, hours = 0.5) => ({ key, label: key, weight: 1, updatedAt: at(0), usage: { status: "ok" as const, planLabel: null,
    windows: [{ label: "Weekly limit", usedPercent: 100 - remaining, resetsAt: at(hours) }] } });
  const blocked = make("有余量但受限", 42);
  blocked.usage.windows.push({ label: "5-hour limit", usedPercent: 100, resetsAt: at(0.25) });
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "proxy", source: "cliproxy", displayName: "proxy", status: "connected", error: null,
    providers: [{ id: "cliproxy-codex", displayName: "Codex", updatedAt: at(0), usage: { status: "ok", planLabel: null, windows: [] },
      accounts: [make("零余量", 0), blocked, make("少量", 0.01), make("晚重置", 80, 4)] }],
  }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Codex");
  const next = () => slot.getByRole("note", { name: /^最近重置账号/u });
  assert.match(next().textContent!, /3 个账号.*1 有余量、1 已耗尽、1 5h 暂受限/u);
  assert.match(next().getAttribute("title")!, /零余量：周额已用尽/u);
  assert.match(next().getAttribute("title")!, /有余量但受限：周剩 42%，5h 暂受限/u);
  assert.match(next().getAttribute("title")!, /少量：周剩 <0.1%/u);
  assert.equal(slot.queryByText("建议先用"), null);
  const bar = slot.getByRole("progressbar", { name: "7d 剩余额度" });
  const observed = bar.getAttribute("aria-valuenow");
  await act(async () => { t.mock.timers.tick(31 * 60_000); });
  assert.match(next().textContent!, /已到重置时间，待刷新.*3 个账号.*3 待确认/u);
  assert.equal(bar.getAttribute("aria-valuenow"), observed);
  assert.equal(slot.inspection.rpcCalls.length, 1);
});

test("部分重置时间未知时只称最近已知，旧测量与全部未知时不显示可用余量", async t => {
  installTestPluginRuntime();
  const now = new Date("2026-10-17T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  const app = await loadPluginApp(() => import("./app.js"));
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "proxy", source: "cliproxy", displayName: "proxy", status: "connected", error: null,
    providers: [{ id: "cliproxy-codex", displayName: "Codex", updatedAt: at(0), usage: { status: "ok", planLabel: null, windows: [] }, accounts: [
      { key: "known", label: "已知", weight: 1, updatedAt: at(0), usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 58, resetsAt: at(7.5) }] } },
      { key: "unknown", label: "未知时间", weight: 1, updatedAt: at(0), usage: { status: "ok", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 50, resetsAt: null }] } },
    ] }],
  }] };
  const render = () => renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  let slot = render();
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Codex");
  const next = () => slot.getByRole("note", { name: /^最近已知重置账号/u });
  assert.match(next().textContent!, /最近已知重置.*周剩 42%.*建议先用/u);
  assert.match(next().getAttribute("title")!, /另有 1 个账号的周窗口或重置时间未知/u);
  await act(async () => { t.mock.timers.tick(61 * 60_000); });
  assert.match(next().textContent!, /余量待确认/u);
  assert.doesNotMatch(next().textContent!, /周剩 42%/u);
  assert.equal(slot.queryByText("建议先用"), null);
  assert.equal(slot.inspection.rpcCalls.length, 1);
  slot.lifecycle.unmount();
  const account = snapshot.machines[0]!.providers[0]!.accounts[0]!;
  if (account.usage.status === "ok") account.usage.windows[0]!.resetsAt = null;
  slot = render();
  await slot.findByText("Codex");
  assert.ok(slot.getByText("最近重置时间未知"));
  assert.equal(slot.queryByRole("note", { name: /^最近.*重置账号/u }), null);
});

test("small Gemini pool usage stays visible instead of rounding to an empty quota bar", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  dom.window.localStorage.setItem("account-limits.display-mode", "used");
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact panel");
  const accounts = [0, 0, 0, 1.31474].map((usedPercent, i) => ({ key: `account-${i}`, label: `Example ${i}`, weight: 1,
    usage: { status: "ok" as const, planLabel: null, windows: [
      { label: "Gemini Models: Weekly limit", usedPercent, resetsAt: null },
      { label: "Gemini Models: 5-hour limit", usedPercent: 0, resetsAt: null },
    ] } }));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "proxy", source: "cliproxy", displayName: "Proxy", status: "connected", error: null,
    providers: [{ id: "cliproxy-antigravity", displayName: "Gemini", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] }, accounts }] }] };
  const rpc = { readAccountLimits: () => snapshot };
  const compact = renderSlot(footer, { dismiss() {} }, { rpc });
  t.after(() => { compact.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const card = await compact.findByRole("button", { name: "Gemini" });
  const value = () => card.querySelector('.limits-compact-service-value')?.textContent;
  assert.equal(value(), "0.3%");
  const bar = within(compact.container).getByRole("progressbar", { name: "Gem 7d 已用额度" });
  assert.ok(Number(bar.getAttribute("aria-valuenow")) > 0.32);
  assert.equal(bar.closest('.limits-meter')!.querySelector('.limits-meter-number')!.textContent, "0.3%");
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
  t.after(() => full.lifecycle.unmount());
  await act(async () => { within(full.container).getByRole("button", { name: "剩余" }).click(); });
  assert.equal(value(), "99.7%");
  accounts[3]!.usage.windows[0]!.usedPercent = 0.01;
  await act(async () => { compact.getByRole("button", { name: "刷新精简额度" }).click(); });
  assert.equal(value(), ">99.9%");
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(value(), "<0.1%");
  accounts[3]!.usage.windows[0]!.usedPercent = 0;
  await act(async () => { compact.getByRole("button", { name: "刷新精简额度" }).click(); });
  assert.equal(value(), "0%");
});

test("Ultra and Pro stay separate in full pools, compact cards, reset batches and pacing", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  const now = Date.parse("2026-10-22T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const at = (hours: number) => new Date(now + hours * 3600_000).toISOString();
  const make = (key: string, planLabel: string, used: number, hours: number, weight = 1) => ({ key, label: key, weight,
    usage: { status: "ok" as const, planLabel, windows: [
      { label: "Gemini Models: Weekly limit", usedPercent: used, resetsAt: at(hours) },
      { label: "Claude and GPT models: Weekly limit", usedPercent: 20, resetsAt: at(120) },
    ] } });
  const accounts = [make("Ultra one", "Google AI Ultra", 90, 120), make("Ultra two", "Google AI Ultra", 90, 120), make("Pro one", "Google AI Pro", 20, 12, 100)];
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "proxy", source: "cliproxy", displayName: "Proxy", status: "connected", error: null,
    providers: [{ id: "cliproxy-antigravity", displayName: "Gemini", updatedAt: at(0), usage: { status: "ok", planLabel: null, windows: [] }, accounts }] }] };
  const app = await loadPluginApp(() => import("./app.js"));
  const rpc = { readAccountLimits: () => snapshot };
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
  t.after(() => { full.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const ultra = within(await full.findByRole("region", { name: "Google AI Ultra 的池额度" }));
  const pro = within(full.getByRole("region", { name: "Google AI Pro 的池额度" }));
  assert.equal(ultra.getByRole("progressbar", { name: "Gem 7d 剩余额度" }).getAttribute("aria-valuenow"), "10");
  assert.equal(pro.getByRole("progressbar", { name: "Gem 7d 剩余额度" }).getAttribute("aria-valuenow"), "80");
  assert.ok(ultra.getByRole("note", { name: /^周额度建议：节约用/u }));
  assert.ok(pro.getByRole("note", { name: /^周额度建议：可多用/u }));
  assert.match(ultra.getAllByRole("note", { name: /^最近重置账号/u })[0]!.getAttribute("title")!, /Ultra one.*Ultra two/u);
  assert.doesNotMatch(ultra.getAllByRole("note", { name: /^最近重置账号/u })[0]!.getAttribute("title")!, /Pro one/u);
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact panel");
  const compact = renderSlot(footer, { dismiss() {} }, { rpc }); t.after(() => compact.lifecycle.unmount());
  const ultraCard = await compact.findByRole("button", { name: "Gemini · Ultra" });
  const proCard = compact.getByRole("button", { name: "Gemini · Pro" });
  assert.equal(ultraCard.querySelectorAll("strong")[0]!.textContent, "10%");
  assert.equal(proCard.querySelectorAll("strong")[0]!.textContent, "80%");
  assert.match(ultraCard.title, /覆盖 2\/2/u); assert.match(proCard.title, /覆盖 1\/1/u);
  assert.doesNotMatch(ultraCard.title, /\*/u); assert.doesNotMatch(proCard.title, /\*/u);
  await act(async () => { proCard.click(); });
  assert.equal(within(compact.container).getByRole("progressbar", { name: "Gem 7d 剩余额度" }).getAttribute("aria-valuenow"), "80");
  await act(async () => { within(full.container).getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(ultraCard.querySelectorAll("strong")[0]!.textContent, "90%");
  assert.equal(proCard.querySelectorAll("strong")[0]!.textContent, "20%");
});

test("compact disclosure closes on outside activation without swallowing clicks", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact disclosure");
  const outside = document.createElement("input");
  document.body.append(outside);
  let dismissed = 0; let activated = 0;
  outside.addEventListener("click", () => { activated++; });
  const slot = renderSlot(footer, { dismiss: () => { dismissed++; } }, { rpc: { readAccountLimits: () => ({ machines: [] }) } });
  t.after(() => { slot.lifecycle.unmount(); outside.remove(); dom.window.localStorage.clear(); });
  await slot.findByLabelText("额度显示设置");
  await act(async () => { slot.getByLabelText("额度显示设置").click(); });
  await act(async () => { slot.getByRole("checkbox", { name: "隐藏失败" }).click(); });
  assert.equal(dismissed, 0, "Settings and other internal controls keep the disclosure open");
  await act(async () => {
    for (const type of ["touchstart", "touchmove", "touchend", "pointercancel"]) {
      outside.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    }
  });
  assert.equal(dismissed, 0, "Scrolling does not activate outside dismissal");
  await act(async () => { outside.focus(); outside.click(); });
  assert.equal(dismissed, 1);
  assert.equal(activated, 1, "The outside input still receives its click");
  assert.equal(document.activeElement, outside, "The outside input remains focused");
});

test("outside dismissal waits for the native footer toggle and does not consume the opening click", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact disclosure");
  const trigger = document.createElement("button"); document.body.append(trigger);
  let opened = false; let dismissed = 0;
  let slot: ReturnType<typeof renderSlot> | undefined;
  trigger.addEventListener("click", () => {
    opened = !opened;
    if (opened && !slot) slot = renderSlot(footer, { dismiss: () => { opened = false; dismissed++; } }, { rpc: { readAccountLimits: () => ({ machines: [] }) } });
  });
  t.after(() => { slot?.lifecycle.unmount(); trigger.remove(); dom.window.localStorage.clear(); });
  await act(async () => { trigger.click(); });
  assert.equal(opened, true); assert.equal(dismissed, 0);
  await act(async () => { trigger.click(); });
  assert.equal(opened, false, "The host toggle must not reopen after outside dismissal");
  assert.equal(dismissed, 1);
});

test("outside dismissal removes listeners and abandons queued work on compact unmount", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact disclosure");
  const outside = document.createElement("button"); document.body.append(outside);
  let dismissed = 0;
  const render = () => renderSlot(footer, { dismiss: () => { dismissed++; } }, { rpc: { readAccountLimits: () => ({ machines: [] }) } });
  let slot = render();
  t.after(() => { slot.lifecycle.unmount(); outside.remove(); dom.window.localStorage.clear(); });
  await act(async () => { outside.click(); slot.lifecycle.unmount(); });
  assert.equal(dismissed, 0);
  await act(async () => { outside.click(); });
  assert.equal(dismissed, 0);
  slot = render();
  await act(async () => { outside.click(); });
  assert.equal(dismissed, 1, "Remounting must install only one live listener");
});

test("outside activation keeps input focus after the host closes and restores its trigger", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact disclosure");
  const Component = footer.component;
  const input = document.createElement("input"), trigger = document.createElement("button");
  document.body.append(input, trigger);
  const slot = renderSlot({ ...footer, component: function Host() {
    const [open, setOpen] = useState(true);
    useLayoutEffect(() => { if (!open) trigger.focus(); }, [open]);
    return open ? <Component dismiss={() => setOpen(false)} /> : null;
  } }, { dismiss() {} }, { rpc: { readAccountLimits: () => ({ machines: [] }) } });
  t.after(() => { slot.lifecycle.unmount(); input.remove(); trigger.remove(); dom.window.localStorage.clear(); });
  await act(async () => { input.focus(); input.click(); });
  assert.equal(slot.queryByLabelText("账户额度精简版"), null);
  assert.equal(document.activeElement, input);
});

test("weekly budgets lead every source, with matched 5h windows as secondary status", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const sources = ["cliproxy", "account-pool", "bb-providers"] as const;
  const snapshot: AccountLimitsPanelSnapshot = { machines: sources.map(source => ({
    id: source, source, displayName: source, status: "connected" as const, error: null,
    providers: ["codex", "claude", "antigravity"].map(kind => {
      const id = source === "account-pool" ? `account-pool:${kind === "claude" ? "claude-code" : kind}` : source === "cliproxy" ? `cliproxy-${kind}` : kind;
      const windows = kind === "antigravity" ? [
        { label: "Gemini Models: 5-hour limit", usedPercent: 12, resetsAt: null },
        { label: "Gemini Models: Weekly limit", usedPercent: 34, resetsAt: null },
        { label: "Claude and GPT models: 5-hour limit", usedPercent: 56, resetsAt: null },
        { label: "Claude and GPT models: Weekly limit", usedPercent: 78, resetsAt: null },
      ] : [
        { label: "5-hour limit", usedPercent: 100, resetsAt: null },
        { label: "Weekly limit", usedPercent: 19, resetsAt: null },
        ...(kind === "claude" ? [{ label: "Weekly scoped limit", usedPercent: 40, resetsAt: null }] : []),
      ];
      return { id, displayName: kind, updatedAt: null, usage: { status: "ok" as const, planLabel: null, windows: [] },
        accounts: [{ key: kind, label: `${source}-${kind}`, weight: 1, usage: { status: "ok" as const, planLabel: null, windows } }] };
    }),
  })) };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  for (const source of sources) for (const kind of ["codex", "claude", "antigravity"]) {
    if (source === "bb-providers" && kind === "codex") continue; // Usable Account Pooler Codex replaces the native duplicate.
    const account = await slot.findByRole("region", { name: `${source}-${kind} 的额度` });
    const meters = within(account).getAllByRole("progressbar");
    for (const short of meters.filter(meter => /5-hour/u.test(meter.getAttribute("aria-label")!))) {
      assert.equal(short.closest("li")!.querySelector(".limits-meter-track"), null, "5h is a status, not a competing main bar");
      const budget = short.closest('[role="group"]')!;
      assert.ok(within(budget as HTMLElement).getAllByRole("progressbar")[0]!.getAttribute("aria-label")!.includes("Weekly"));
    }
    if (kind === "antigravity") {
      const gem = meters.find(meter => meter.getAttribute("aria-label")!.startsWith("Gemini Models: Weekly"))!;
      const cg = meters.find(meter => meter.getAttribute("aria-label")!.startsWith("Claude and GPT models: Weekly"))!;
      assert.deepEqual(within(gem.closest('[role="group"]') as HTMLElement).getAllByRole("progressbar").map(m => m.getAttribute("aria-valuenow")), ["66", "88"]);
      assert.deepEqual(within(cg.closest('[role="group"]') as HTMLElement).getAllByRole("progressbar").map(m => m.getAttribute("aria-valuenow")), ["22", "44"]);
    } else assert.ok(within(account).getByText("暂受限"));
  }
  await act(async () => { slot.getByRole("button", { name: "池" }).click(); });
  assert.equal(slot.container.querySelectorAll(".limits-session").length, 11);
  await act(async () => { slot.getByRole("button", { name: "已用（Used）" }).click(); });
  const claude = within(slot.getByRole("article", { name: "claude · Cliproxy" }));
  assert.equal(claude.getByRole("progressbar", { name: "5h 已用额度" }).getAttribute("aria-valuenow"), "100");
  assert.equal(claude.getByRole("progressbar", { name: "7d 已用额度" }).getAttribute("aria-valuenow"), "19");
});

test("pool percentages use the whole pool, show decimal precision and count reporting accounts", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  dom.window.localStorage.setItem("account-limits.view", "pool");
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "pool", source: "account-pool", displayName: "Pool", status: "connected", error: null,
    providers: [{ id: "account-pool:codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] },
      accounts: [1, 18, 0].map((usedPercent, index) => ({ key: String(index), label: `Account ${index + 1}`, weight: 1,
        usage: { status: "ok", planLabel: "Pro", windows: [{ label: "Weekly limit", usedPercent, resetsAt: null }] } })),
    }],
  }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Codex");
  await act(async () => { slot.getByRole("button", { name: "池" }).click(); slot.getByRole("button", { name: "已用（Used）" }).click(); });
  assert.ok(slot.getByText("6.3%"));
  assert.ok(slot.getByText(/3 个账号汇总 · 覆盖 3\/3/u));
  const footer = app.experimentalSidebarFooterItems[0]!;
  if (footer.kind !== "disclosure") throw new Error("Missing compact disclosure");
  const compact = renderSlot(footer, { dismiss() {} }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => compact.lifecycle.unmount());
  assert.equal((await compact.findByRole("button", { name: "Codex · Pro" })).querySelector(".limits-compact-service-value")!.textContent, "6.3%");
  await act(async () => { slot.getByRole("button", { name: "剩余" }).click(); });
  assert.ok(within(slot.container).getByText("93.7%"));
  assert.equal(compact.getByRole("button", { name: "Codex · Pro" }).querySelector(".limits-compact-service-value")!.textContent, "93.7%");
});

test("5h-only observations stay secondary and explicitly leave weekly quota unknown", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "native", source: "bb-providers", displayName: "Native", status: "connected", error: null,
    providers: [{ id: "codex", displayName: "Codex", updatedAt: null, accounts: [], usage: { status: "ok", planLabel: null,
      windows: [{ accountLabel: "Legacy", label: "Legacy · 5-hour limit", usedPercent: 20, resetsAt: null }] } }],
  }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await slot.findByText("Legacy");
  assert.ok(slot.getByText("周额度未返回"));
  assert.equal(slot.getAllByRole("progressbar").length, 1);
  assert.equal(slot.getByRole("progressbar").getAttribute("aria-valuenow"), "80");
  assert.equal(slot.container.querySelectorAll(".limits-meter-track").length, 0);
});

test("native Codex model sessions stay attached to their own weekly quota", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  const app = await loadPluginApp(() => import("./app.js"));
  const snapshot: AccountLimitsPanelSnapshot = { machines: [{ id: "native", source: "bb-providers", displayName: "Native", status: "connected", error: null,
    providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] },
      accounts: [{ key: "native", label: "Native", weight: 1, usage: { status: "ok", planLabel: "Pro", windows: [
        { label: "Weekly limit · demo-a", usedPercent: 20, resetsAt: null },
        { label: "5-hour limit · demo-a", usedPercent: 80, resetsAt: null },
        { label: "5-hour limit · demo-b", usedPercent: 30, resetsAt: null },
      ] } }],
    }],
  }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { readAccountLimits: () => snapshot } });
  t.after(() => { slot.lifecycle.unmount(); dom.window.localStorage.clear(); });
  const a = within(await slot.findByRole("group", { name: "demo-a 周额度" }));
  assert.deepEqual(a.getAllByRole("progressbar").map(bar => bar.getAttribute("aria-valuenow")), ["80", "20"]);
  const b = within(slot.getByRole("group", { name: "demo-b 周额度" }));
  assert.ok(b.getByText("demo-b 周额度未返回"));
  assert.equal(b.getByRole("progressbar").getAttribute("aria-valuenow"), "70");
  assert.equal(slot.container.querySelectorAll(".limits-meter-track").length, 1);
});

test("quota monitor notifies the resource pool independent of account/pool and display mode", async t => {
  installTestPluginRuntime(); dom.window.localStorage.clear();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-26T00:00:00Z") });
  const { toast } = await import("sonner"); const warnings: string[] = [];
  t.mock.method(toast, "warning", (message: unknown) => { warnings.push(String(message)); return 1; });
  const app = await loadPluginApp(() => import("./app.js"));
  let percentages = [0, 0, 0]; let reads = 0;
  const rpc = { readAccountLimits: () => {
    reads++;
    return { machines: [{ id: "local", source: "bb-providers", displayName: "Local", status: "connected", error: null,
      providers: [{ id: "codex", displayName: "Codex", updatedAt: null, usage: { status: "ok", planLabel: null, windows: [] },
        accounts: percentages.map((usedPercent, index) => ({ key: String(index), label: `Account ${index}`, weight: 1,
          usage: { status: "ok", planLabel: "Pro", windows: [{ id: "weekly", label: "Weekly limit", usedPercent, resetsAt: null }] } })),
      }],
    }] };
  } };
  const monitor = renderSlot(app.appOverlays[0]!, {}, { rpc });
  const full = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
  t.after(() => { monitor.lifecycle.unmount(); full.lifecycle.unmount(); dom.window.localStorage.clear(); });
  await full.findByText("Codex");
  percentages = [100, 0, 0];
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(warnings.length, 0);
  percentages = [100, 100, 40];
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /资源池.*已用 80%.*3 个账号汇总/u);
  assert.doesNotMatch(warnings[0]!, /Account [0-9]/u);
  const before = reads;
  await act(async () => { full.getByRole("button", { name: "池" }).click(); full.getByRole("button", { name: "已用（Used）" }).click(); });
  assert.equal(warnings.length, 1); assert.equal(reads, before);
  await act(async () => { t.mock.timers.tick(5 * 60_000); await Promise.resolve(); });
  assert.equal(warnings.length, 1);
});
