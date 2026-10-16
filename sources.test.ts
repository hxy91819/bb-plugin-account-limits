import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaReader } from "./sources.js";

test("uninstalled sources are skipped without reading them; a failed source cannot hide another", async () => {
  let reads = 0;
  const reader = createQuotaReader([
    { id: "cliproxy", displayName: "CLI Proxy", available: async () => false,
      read: async () => { reads++; throw new Error("must not probe"); } },
    { id: "account-pool", displayName: "BB Account Pooler", read: async () => ({ machines: [
      { id: "pool", displayName: "BB Account Pooler", status: "connected", providers: [], error: null },
    ] }) },
  ]);
  const result = await reader({});
  assert.equal(reads, 0);
  assert.deepEqual(result.machines.map(machine => machine.source), ["account-pool"]);
  assert.deepEqual(await reader({ source: "cliproxy", force: true }), { machines: [] });
});

test("source refresh is selected through the adapter registry with its input preserved", async () => {
  const calls: unknown[] = [];
  const reader = createQuotaReader([
    { id: "cliproxy", displayName: "CLI Proxy", read: async input => { calls.push(input); throw new Error("offline"); } },
    { id: "account-pool", displayName: "BB Account Pooler", read: async () => ({ machines: [] }) },
  ]);
  const result = await reader({ source: "cliproxy", providerIds: ["cliproxy-claude"], force: true });
  assert.deepEqual(calls, [{ providerIds: ["cliproxy-claude"], force: true }]);
  assert.equal(result.machines[0]?.source, "cliproxy");
  assert.equal(result.machines[0]?.status, "error");
});
