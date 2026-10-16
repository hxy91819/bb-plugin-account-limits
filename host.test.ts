import assert from "node:assert/strict";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readProviderSnapshot } from "./host.js";
import { usageError } from "./usage.js";
import { resolveConfig } from "./config.js";

test("unconfigured host performs no management or upstream network requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unconfigured source made a network request"); };
  try {
    assert.deepEqual(await readProviderSnapshot(undefined, {}, undefined, resolveConfig({})), { providers: [] });
  } finally { globalThis.fetch = originalFetch; }
});

test("Cliproxy snapshot accepts an empty enabled group set", async () => {
  const snapshot = await readProviderSnapshot(new Map(), { managementKey: "test" });
  assert.deepEqual(snapshot, { providers: [] });
});

test("Cliproxy snapshot keeps failed accounts alongside healthy ones", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth-files")) return new Response(JSON.stringify({ files: [
      { provider: "claude", auth_index: "auth-1" },
      { provider: "claude", auth_index: "auth-2" },
    ] }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (body.auth_index === "auth-2") return new Response(JSON.stringify({ status_code: 503, body: "{}" }), { status: 200 });
    return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({ limits: [
      { kind: "weekly_all", percent: 25, resets_at: "2026-09-12T10:00:00Z" },
    ] }) }), { status: 200 });
  };
  try {
    const groups = new Map([["claude", [
      { provider: "claude", authIndex: "auth-1", label: "账号 1" },
      { provider: "claude", authIndex: "auth-2", label: "账号 2" },
    ]]]);
    const snapshot = await readProviderSnapshot(groups, { managementKey: "test" });
    assert.equal(snapshot.providers.length, 1);
    const provider = snapshot.providers[0]!;
    assert.equal(provider.accounts.length, 2);
    assert.equal(provider.accounts[0]?.usage.status, "ok");
    assert.equal(provider.accounts[1]?.usage.status, "error");
    assert.notEqual(provider.accounts[0]?.key, provider.accounts[1]?.key);
    assert.equal(provider.accounts[0]?.weight, 1);
    // 供应商级压平窗口只保留成功账号，失败账号不丢。
    assert.equal(provider.usage.status, "ok");
    if (provider.usage.status === "ok") {
      assert.equal(provider.usage.windows.length, 1);
      assert.equal(provider.usage.windows[0]?.accountLabel, "账号 1");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Antigravity plan labels survive the management read and panel wire contract", async () => {
  const originalFetch = globalThis.fetch;
  const tiers: Record<string, { paidTier?: { name: string }; currentTier?: { name: string } }> = {
    ultra: { paidTier: { name: "Google AI Ultra" }, currentTier: { name: "Antigravity" } },
    pro: { paidTier: { name: "Google AI Pro" } },
    free: { currentTier: { name: "Antigravity" } },
    unknown: {},
  };
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/auth-files")) return new Response(JSON.stringify({
      files: Object.keys(tiers).map(auth_index => ({ provider: "antigravity", auth_index })),
    }));
    const body = JSON.parse(String(init?.body));
    const result = String(body.url).endsWith(":loadCodeAssist")
      ? { ...tiers[body.auth_index], cloudaicompanionProject: "test-project" }
      : { groups: [{ displayName: "Gemini Models", buckets: [{ window: "weekly", remainingFraction: 0.8 }] }] };
    return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify(result) }));
  };
  try {
    const accounts = Object.keys(tiers).map(authIndex => ({ provider: "antigravity", authIndex, label: `Account ${authIndex}` }));
    const snapshot = await readProviderSnapshot(new Map([["antigravity", accounts]]), {
      managementKey: "test",
      managementBaseUrl: "http://cliproxy.test/v0/management",
    });
    assert.deepEqual(snapshot.providers[0]!.accounts.map(account => {
      assert.equal(account.usage.status, "ok");
      return account.usage.status === "ok" ? account.usage.planLabel : null;
    }), ["Google AI Ultra", "Google AI Pro", "Antigravity", "Account unknown"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
