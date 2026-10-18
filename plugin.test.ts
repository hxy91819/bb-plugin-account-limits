import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeHostResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

test("installed plugin with no configured sources is empty through RPC and CLI and registers no agents", async () => {
  const hostCalls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "account-limits",
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "test-host", name: "test", status: "connected" })] },
      providers: { list: async () => [] },
      plugins: { list: async () => ({ plugins: [] }) },
    },
    experimental_callHostRpc: async call => {
      hostCalls.push(call.method);
      if (call.method === "cliproxyStatus") return { configured: false };
      throw new Error("An absent source tried a quota request");
    },
  });
  try {
    plugin(bb);
    assert.deepEqual(await harness.behavior.callRpc("readAccountLimits", {}), { machines: [] });
    const result = await harness.behavior.runCli([]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout!), { cliproxy: { machines: [] }, accountPool: { machines: [] }, bbProviders: { machines: [] } });
    assert.ok(hostCalls.every(method => method === "cliproxyStatus"));
    assert.equal(harness.inspection.registrations.providerRegistrations.length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

test("standalone source imports only public SDK and package-local modules", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^(react|sonner|jsdom|@testing-library\/react)$/u] });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.privateDependencies, []);
});

test("installed RPC and CLI include existing BB provider usage without optional sources", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "account-limits", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "test-host", name: "test", status: "connected" })] },
    providers: { list: async () => [{ id: "codex", displayName: "Codex" }] as never },
    system: { usageLimits: async () => ({ codex: { status: "ok", accountEmail: "demo@example.test", planLabel: "Pro",
      windows: [{ label: "Weekly limit", usedPercent: 42, resetsAt: null }] } }) },
    plugins: { list: async () => ({ plugins: [] }) },
  }, experimental_callHostRpc: async () => ({ configured: false }) });
  try {
    plugin(bb);
    const snapshot = await harness.behavior.callRpc("readAccountLimits", {}) as { machines: { source: string }[] };
    assert.equal(snapshot.machines[0]?.source, "bb-providers");
    const result = await harness.behavior.runCli([]);
    const output = JSON.parse(result.stdout!);
    assert.equal(output.bbProviders.machines[0].providers[0].accounts[0].usage.windows[0].usedPercent, 42);
    const calls = harness.inspection.sdk.callsTo("providers.list");
    assert.ok(calls.length > 0);
  } finally { await harness.lifecycle.dispose(); }
});
