import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeProviderPanelReader } from "./native-provider-panel.js";

const hosts = [{ id: "local", name: "Local", status: "connected" }, { id: "remote", name: "Remote", status: "connected" }];
const providers = [{ id: "codex", displayName: "Codex" }, { id: "claude-code", displayName: "Claude" }];
const ok = { status: "ok" as const, planLabel: "Pro", accountEmail: "demo@example.test", windows: [
  { label: "Weekly limit", usedPercent: 42, resetsAt: "2026-10-24T00:00:00Z" },
] };

test("BB providers are visible without Account Pooler or CLI Proxy; hosts and failures stay independent", async () => {
  const reader = createNativeProviderPanelReader({ listHosts: async () => hosts, listProviders: async () => providers,
    readUsage: async ({ hostId, providerId }) => {
      if (hostId === "remote") throw new Error("offline");
      return { [providerId]: providerId === "codex" ? ok : { status: "expired" } };
    },
  });
  const result = await reader({});
  assert.equal(result.machines.length, 2);
  const local = result.machines[0]!;
  assert.equal(local.source, "bb-providers");
  assert.equal(local.providers[0]!.accounts[0]!.usage.status, "ok");
  assert.equal(local.providers[0]!.usage.status === "ok" && local.providers[0]!.usage.windows[0]!.usedPercent, 42);
  assert.equal(local.providers[1]!.usage.status, "expired");
  assert.equal(result.machines[1]!.providers[0]!.usage.status, "error");
});

test("targeted refresh only queries the selected provider and preserves other cached providers", async () => {
  const calls: string[] = [];
  const reader = createNativeProviderPanelReader({ listHosts: async () => [hosts[0]!], listProviders: async () => providers,
    readUsage: async ({ providerId, refresh }) => { calls.push(`${providerId}:${refresh}`); return { [providerId]: ok }; },
  });
  await reader({});
  calls.length = 0;
  const result = await reader({ force: true, providerIds: ["codex"] });
  assert.deepEqual(calls, ["codex:true"]);
  assert.equal(result.machines[0]!.providers.length, 2);
});

test("unsupported usage is omitted and overage is displayed as exhausted", async () => {
  const reader = createNativeProviderPanelReader({ listHosts: async () => [hosts[0]!], listProviders: async () => providers,
    readUsage: async ({ providerId }) => providerId === "codex" ? {} : { [providerId]: { ...ok, windows: [{ ...ok.windows[0]!, usedPercent: 125 }] } },
  });
  const result = await reader({});
  assert.equal(result.machines[0]!.providers.length, 1);
  const provider = result.machines[0]!.providers[0]!;
  assert.equal(provider.usage.status === "ok" && provider.usage.windows[0]!.usedPercent, 100);
});

test("discovery failures preserve the last observation with a visible cache warning", async () => {
  let fail = false;
  const reader = createNativeProviderPanelReader({ listHosts: async () => [hosts[0]!],
    listProviders: async () => { if (fail) throw new Error("offline"); return providers; },
    readUsage: async ({ providerId }) => ({ [providerId]: ok }),
  });
  const original = await reader({});
  fail = true;
  const failed = await reader({});
  assert.equal(failed.machines[0]!.status, "connected");
  assert.deepEqual(failed.machines[0]!.providers, original.machines[0]!.providers);
  assert.match(failed.machines[0]!.error!, /缓存/u);
});

test("providers without verified fresh collection remain unknown even on forced reads", async () => {
  const reader = createNativeProviderPanelReader({ listHosts: async () => [hosts[0]!], listProviders: async () => providers,
    readUsage: async ({ providerId }) => ({ [providerId]: ok }),
  });
  for (const force of [false, true]) {
    const snapshot = await reader({ force });
    for (const provider of snapshot.machines[0]!.providers) {
      assert.equal(provider.updatedAt, null);
      assert.equal(provider.accounts[0]!.updatedAt, null);
    }
  }
});

test("targeted reads after reload keep unselected providers as unread rows without querying them", async () => {
  const calls: string[] = [];
  const reader = createNativeProviderPanelReader({ listHosts: async () => [hosts[0]!], listProviders: async () => providers,
    readUsage: async ({ providerId }) => { calls.push(providerId); return { [providerId]: ok }; },
  });
  const snapshot = await reader({ force: true, providerIds: ["codex"] });
  assert.deepEqual(calls, ["codex"]);
  assert.equal(snapshot.machines[0]!.providers.length, 2);
  assert.equal(snapshot.machines[0]!.providers[1]!.usage.status, "error");
});

test("initial discovery failure stays visible, and disconnected machines never query usage", async () => {
  let connected = true;
  let fail = true;
  let reads = 0;
  const reader = createNativeProviderPanelReader({
    listHosts: async () => [{ ...hosts[0]!, status: connected ? "connected" : "disconnected" }],
    listProviders: async () => { if (fail) throw new Error("offline"); return providers; },
    readUsage: async ({ providerId }) => { reads++; return { [providerId]: ok }; },
  });
  const failed = await reader({});
  assert.equal(failed.machines[0]!.status, "error");
  assert.equal(failed.machines[0]!.providers.length, 0);
  connected = false;
  assert.equal((await reader({})).machines.length, 0);
  connected = true;
  fail = false;
  await reader({});
  reads = 0;
  connected = false;
  assert.equal((await reader({})).machines[0]!.status, "disconnected");
  assert.equal(reads, 0);
});

test("verified native collectors restore weekly pacing and cached failures keep the original collection time", async () => {
  const { buildWeeklyPace } = await import("./weekly-pace.js");
  let now = Date.parse("2026-10-17T00:00:00Z");
  let failDiscovery = false;
  const reader = createNativeProviderPanelReader({
    listHosts: async () => [hosts[0]!],
    listProviders: async () => {
      if (failDiscovery) throw new Error("offline");
      return [{ id: "codex-personal", displayName: "Personal Codex", pluginId: "provider-codex" },
        { id: "claude-code", displayName: "Claude", pluginId: "provider-claude-code" },
        { id: "acp-custom", displayName: "Custom", pluginId: "provider-acp" }];
    },
    readUsage: async ({ providerId }) => ({ [providerId]: { ...ok, windows: [{ ...ok.windows[0]!, resetsAt: "2026-10-22T00:00:00Z" }] } }),
    now: () => now,
  });
  const snapshot = await reader({});
  const [codex, claude, thirdParty] = snapshot.machines[0]!.providers;
  assert.equal(codex!.updatedAt, "2026-10-17T00:00:00.000Z");
  assert.equal(claude!.updatedAt, codex!.updatedAt);
  assert.equal(thirdParty!.updatedAt, null);
  const account = codex!.accounts[0]!;
  assert.equal(account.usage.status, "ok");
  if (account.usage.status !== "ok") return;
  assert.notEqual(buildWeeklyPace([account], account.usage.windows[0]!.id!, now).level, "unknown");
  failDiscovery = true;
  now += 2 * 3_600_000;
  const cached = await reader({ force: true });
  assert.equal(cached.machines[0]!.providers[0]!.updatedAt, codex!.updatedAt);
  assert.equal(buildWeeklyPace(cached.machines[0]!.providers[0]!.accounts, account.usage.windows[0]!.id!, now).level, "unknown");
});
