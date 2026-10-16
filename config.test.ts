import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig, loadLocalAccountLimitsConfig } from "./config.js";

test("fresh environments have no proxy or executable agent configuration", () => {
  assert.deepEqual(resolveConfig({}), { enabledProviders: [], cliproxy: null });
  assert.equal(resolveConfig({ cliproxy: null }).cliproxy, null);
  assert.equal(resolveConfig({ cliproxy: { managementBaseUrl: "http://localhost:8317/v0/management", enabled: false } }).cliproxy, null);
});

test("explicit proxy setup supports discovery, legacy provider filters and account weights", () => {
  const result = resolveConfig({ enabledProviders: ["cliproxy-claude"], cliproxy: {
    managementBaseUrl: "http://localhost:8317/v0/management", managementKeyEnv: "TEST_MANAGEMENT_KEY",
    accounts: [{ id: "work", provider: "claude", account: "work@example.com", poolWeight: 2 }],
  } });
  assert.equal(result.cliproxy?.accounts[0]?.poolWeight, 2);
  assert.deepEqual(result.enabledProviders, ["cliproxy-claude"]);
  assert.throws(() => resolveConfig({ cliproxy: { managementBaseUrl: "broken" } }));
});

test("missing or invalid local configuration never activates a guessed proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-config-"));
  const path = join(dir, "local.json");
  const warnings: string[] = [];
  try {
    assert.equal(resolveConfig(loadLocalAccountLimitsConfig([pathToFileURL(path)])).cliproxy, null);
    await writeFile(path, "invalid-json");
    const config = loadLocalAccountLimitsConfig([pathToFileURL(path)], message => warnings.push(message));
    assert.equal(resolveConfig(config).cliproxy, null);
    assert.equal(warnings.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
