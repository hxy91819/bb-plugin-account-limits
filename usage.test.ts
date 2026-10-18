import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cliproxyAccountsFromAuthFiles, discoveredCliproxyGroups, normalizeAntigravityUsage, normalizeClaudeUsage, normalizeCliproxyCachedUsage, normalizeCliproxyCodexUsage, normalizeGrokUsage, normalizeKimiUsage, readCliproxyProviderUsage, readCliproxyUsage } from "./usage.js";

test("Claude usage converts Cliproxy's official usage response into BB windows", () => {
  const result = normalizeClaudeUsage({ limits: [
    { kind: "session", percent: 8, resets_at: "2026-09-09T11:00:00+00:00" },
    { kind: "weekly_all", percent: 63, resets_at: "2026-09-12T10:00:00+00:00" },
    { kind: "weekly_scoped", percent: 95, resets_at: "2026-09-12T10:00:00+00:00" },
  ] }, { provider: "claude", authIndex: "account-1", label: "Claude work" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "5-hour limit", usedPercent: 8, resetsAt: "2026-09-09T11:00:00.000Z" },
    { label: "Weekly limit", usedPercent: 63, resetsAt: "2026-09-12T10:00:00.000Z" },
    { label: "Weekly scoped limit", usedPercent: 95, resetsAt: "2026-09-12T10:00:00.000Z" },
  ]);
  for (const invalid of [{}, { limits: [{ kind: "session", percent: 101 }] }]) {
    const invalidResult = normalizeClaudeUsage(invalid, { provider: "claude", authIndex: "account-1" });
    assert.ok(invalidResult.supported && invalidResult.usage.status === "error");
  }
});

test("Grok usage exposes both the current period and product quota", () => {
  const result = normalizeGrokUsage({ config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-12T06:53:49.038097+00:00" },
    creditUsagePercent: 7,
    productUsage: [{ product: "GrokBuild", usagePercent: 7 }],
  } }, { provider: "xai", authIndex: "account-1", label: "Grok" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "Weekly limit", usedPercent: 7, resetsAt: "2026-09-12T06:53:49.038Z" },
    { label: "GrokBuild", usedPercent: 7, resetsAt: "2026-09-12T06:53:49.038Z" },
  ]);
});

test("Antigravity converts each authoritative quota bucket from remaining to used", () => {
  const result = normalizeAntigravityUsage({ groups: [
    { displayName: "Gemini Models", buckets: [
      { window: "weekly", remainingFraction: 0.79, resetTime: "2026-09-12T10:00:00Z" },
      { window: "5h", remainingFraction: 0.84, resetTime: "2026-09-09T11:00:00Z" },
    ] },
    { displayName: "Claude and GPT models", buckets: [
      { window: "weekly", remainingFraction: 1, resetTime: "2026-09-12T10:00:00Z" },
    ] },
  ] }, { provider: "antigravity", authIndex: "account-1", label: "Gemini · 账号 1" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "Gemini Models: 5-hour limit", usedPercent: 16, resetsAt: "2026-09-09T11:00:00.000Z" },
    { label: "Gemini Models: Weekly limit", usedPercent: 21, resetsAt: "2026-09-12T10:00:00.000Z" },
    { label: "Claude and GPT models: Weekly limit", usedPercent: 0, resetsAt: "2026-09-12T10:00:00.000Z" },
  ]);
  for (const invalid of [{}, { groups: [{ buckets: [{ remainingFraction: 1.01 }] }] }]) {
    const invalidResult = normalizeAntigravityUsage(invalid, { provider: "antigravity", authIndex: "account-1" });
    assert.ok(invalidResult.supported && invalidResult.usage.status === "error");
  }
});

test("Antigravity disabled quota windows never appear as available capacity", () => {
  const result = normalizeAntigravityUsage({ groups: [
    { displayName: "Gemini Models", buckets: [
      { window: "5h", remainingFraction: 0.8, disabled: false },
    ] },
    { displayName: "Claude and GPT models", buckets: [
      { window: "weekly", remainingFraction: 0 },
      { window: "5h", remainingFraction: 1, disabled: true },
    ] },
  ] }, { provider: "antigravity", authIndex: "account-pro" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "Gemini Models: 5-hour limit", usedPercent: 20, resetsAt: null },
    { label: "Claude and GPT models: Weekly limit", usedPercent: 100, resetsAt: null },
  ]);
});

test("Kimi converts its weekly and rolling-window token quotas into percentages", () => {
  const result = normalizeKimiUsage({
    subType: "kimi-code-pro",
    usage: { limit: "1,000", used: "250", remaining: "750", resetTime: "2026-09-12T10:00:00Z" },
    limits: [{
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "200", used: "10", remaining: "190", resetTime: "2026-09-09T13:00:00Z" },
    }],
  }, { provider: "kimi", authIndex: "account-1", label: "Kimi" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "Weekly limit", usedPercent: 25, resetsAt: "2026-09-12T10:00:00.000Z" },
    { label: "5-hour limit", usedPercent: 5, resetsAt: "2026-09-09T13:00:00.000Z" },
  ]);
  for (const invalid of [{}, { usage: { limit: "0", used: "0" } }, { usage: { limit: "100", used: "101" } }]) {
    const invalidResult = normalizeKimiUsage(invalid, { provider: "kimi", authIndex: "account-1" });
    assert.ok(invalidResult.supported && invalidResult.usage.status === "error");
  }
});

test("Cliproxy Codex exposes the main and additional model-family windows", () => {
  const result = normalizeCliproxyCodexUsage({
    plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1788951600 } },
    additional_rate_limits: [{
      limit_name: "Codex Spark",
      rate_limit: { secondary_window: { used_percent: 35, limit_window_seconds: 604_800, reset_at: 1789207200 } },
    }],
  }, { provider: "codex", authIndex: "account-1", label: "Codex" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "5-hour limit", usedPercent: 20, resetsAt: "2026-09-09T11:00:00.000Z" },
    { label: "Codex Spark: Weekly limit", usedPercent: 35, resetsAt: "2026-09-12T10:00:00.000Z" },
  ]);
  for (const invalid of [{}, { rate_limit: { primary_window: { used_percent: 101 } } }]) {
    const invalidResult = normalizeCliproxyCodexUsage(invalid, { provider: "codex", authIndex: "account-1" });
    assert.ok(invalidResult.supported && invalidResult.usage.status === "error");
  }
});

test("cached Claude rate-limit signals are a safe fallback and deduplicate model snapshots", () => {
  const result = normalizeCliproxyCachedUsage({ model_quotas: {
    latest: { observed_at: "2026-09-09T10:00:00Z", signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.05",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1788951600",
      "Anthropic-Ratelimit-Unified-7d-Utilization": "0.62",
      "Anthropic-Ratelimit-Unified-7d-Reset": "1789207200",
    } },
    old: { observed_at: "2026-09-09T09:00:00Z", signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.99",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1788948000",
    } },
  } }, { provider: "claude", authIndex: "account-1", label: "Claude work" });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "5-hour limit", usedPercent: 5, resetsAt: "2026-09-09T11:00:00.000Z" },
    { label: "Weekly limit", usedPercent: 62, resetsAt: "2026-09-12T10:00:00.000Z" },
  ]);
  const invalidResult = normalizeCliproxyCachedUsage({ quota: { signals: {} } }, { provider: "claude", authIndex: "account-1" });
  assert.ok(invalidResult.supported && invalidResult.usage.status === "error");
});

test("configured cached windows make new Cliproxy provider signals usable without a code change", () => {
  const result = normalizeCliproxyCachedUsage({ quota: { signals: {
    "X-Custom-Usage": "47.5",
    "X-Custom-Reset": "1788951600",
  } } }, {
    provider: "custom-provider",
    authIndex: "account-1",
    label: "Custom account",
    cachedWindows: [{
      label: "Monthly credits",
      usedPercentSignal: "x-custom-usage",
      resetsAtSignal: "x-custom-reset",
      scale: "percent",
    }],
  });
  assert.ok(result.supported && result.usage.status === "ok");
  assert.deepEqual(result.usage.windows, [
    { label: "Monthly credits", usedPercent: 47.5, resetsAt: "2026-09-09T11:00:00.000Z" },
  ]);
});

test("Cliproxy queries the selected credential, uses token substitution only inside management API, and falls back to cache", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/auth-files")) return new Response(JSON.stringify({ files: [{
      provider: "claude", auth_index: "account-1", model_quotas: { model: { signals: {
        "Anthropic-Ratelimit-Unified-5h-Utilization": "0.25",
        "Anthropic-Ratelimit-Unified-5h-Reset": "1788951600",
      } } },
    }] }), { status: 200 });
    return new Response(JSON.stringify({ status_code: 403, body: "{}" }), { status: 200 });
  };
  try {
    const result = await readCliproxyUsage({ provider: "claude", authIndex: "account-1", label: "Claude work" }, {
      managementBaseUrl: "http://cliproxy.test/v0/management",
      managementKey: "test-management-key",
    });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.equal(result.usage.planLabel, "Claude work (cached)");
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer test-management-key");
    const apiCall = JSON.parse(String(requests[1].init?.body));
    assert.deepEqual(apiCall.header, { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cliproxy discovery uses live auth-files instead of the local account whitelist", () => {
  const files = {
    files: [
      { provider: "claude", auth_index: "configured", email: "old@example.com", label: "old@example.com" },
      { provider: "claude", auth_index: "discovered", email: "new@example.com", account: "new@example.com" },
      { provider: "codex", auth_index: "codex-1", email: "codex@example.com" },
      { provider: "claude", email: "missing-index@example.com" },
      { provider: "devin", auth_index: "devin-1", email: "devin@example.com" },
      { provider: "claude", auth_index: "hidden", email: "hidden@example.com" },
    ],
  };
  const configured = [
    { id: "claude-old", provider: "claude", authIndex: "configured", label: "Claude · 账号 1" },
    { id: "claude-hidden", provider: "claude", authIndex: "hidden", enabled: false },
  ];
  const discovered = cliproxyAccountsFromAuthFiles(files, configured);
  assert.deepEqual(discovered, [
    { provider: "claude", authIndex: "configured", account: "old@example.com", label: "Claude · 账号 1" },
    { provider: "claude", authIndex: "discovered", account: "new@example.com", label: "new@example.com" },
    { provider: "codex", authIndex: "codex-1", account: "codex@example.com", label: "codex@example.com" },
    { provider: "devin", authIndex: "devin-1", account: "devin@example.com", label: "devin@example.com" },
  ]);
  const groups = discoveredCliproxyGroups(discovered, ["cliproxy-claude", "cliproxy-codex"], ["cliproxy-claude"]);
  assert.deepEqual([...groups.keys()], ["claude"]);
  assert.equal(groups.get("claude")?.length, 2);
});

test("Cliproxy provider aggregation keeps successful account limits when another account fails", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth-files")) return new Response(JSON.stringify({ files: [
      { provider: "claude", auth_index: "account-1" },
      { provider: "claude", auth_index: "account-2" },
    ] }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (body.auth_index === "account-2") return new Response(JSON.stringify({ status_code: 503, body: "{}" }), { status: 200 });
    return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({ limits: [
      { kind: "weekly_all", percent: 42, resets_at: "2026-09-12T10:00:00Z" },
    ] }) }), { status: 200 });
  };
  try {
    const result = await readCliproxyProviderUsage([
      { provider: "claude", authIndex: "account-1", label: "账号 1" },
      { provider: "claude", authIndex: "account-2", label: "账号 2" },
    ], { managementBaseUrl: "http://cliproxy.test/v0/management" });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.equal(result.usage.planLabel, "Claude · Cliproxy · 1/2 accounts");
    assert.deepEqual(result.usage.windows, [
      { accountLabel: "账号 1", label: "账号 1 · Weekly limit", usedPercent: 42, resetsAt: "2026-09-12T10:00:00.000Z" },
    ]);
    assert.equal(requests.filter(url => url.endsWith("/auth-files")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Antigravity uses the complete production quota summary after daily project discovery", async () => {
  const originalFetch = globalThis.fetch;
  const apiCalls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth-files")) return new Response(JSON.stringify({ files: [{ provider: "antigravity", auth_index: "account-1" }] }), { status: 200 });
    const call = JSON.parse(String(init?.body));
    apiCalls.push(call);
    if (call.url.endsWith(":loadCodeAssist")) {
      return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({ cloudaicompanionProject: "project-1" }) }), { status: 200 });
    }
    // Daily can succeed while silently omitting the entire Gemini family.
    const partnerGroup = { displayName: "Claude and GPT models", buckets: [
      { window: "weekly", remainingFraction: 0.7, resetTime: "2026-09-13T10:00:00Z" },
      { window: "5h", remainingFraction: 0.9, resetTime: "2026-09-09T12:00:00Z" },
    ] };
    const groups = call.url === "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
      ? [{ displayName: "Gemini Models", buckets: [
        { window: "weekly", remainingFraction: 0.5, resetTime: "2026-09-12T10:00:00Z" },
        { window: "5h", remainingFraction: 0.8, resetTime: "2026-09-09T11:00:00Z" },
      ] }, partnerGroup]
      : [partnerGroup];
    return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({ groups }) }), { status: 200 });
  };
  try {
    const result = await readCliproxyUsage({ provider: "antigravity", authIndex: "account-1", label: "Gemini · 账号 1" }, {
      managementBaseUrl: "http://cliproxy.test/v0/management",
    });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.deepEqual(result.usage.windows, [
      { label: "Gemini Models: 5-hour limit", usedPercent: 20, resetsAt: "2026-09-09T11:00:00.000Z" },
      { label: "Gemini Models: Weekly limit", usedPercent: 50, resetsAt: "2026-09-12T10:00:00.000Z" },
      { label: "Claude and GPT models: 5-hour limit", usedPercent: 10, resetsAt: "2026-09-09T12:00:00.000Z" },
      { label: "Claude and GPT models: Weekly limit", usedPercent: 30, resetsAt: "2026-09-13T10:00:00.000Z" },
    ]);
    assert.equal(apiCalls.length, 2);
    assert.match(String(apiCalls[0].url), /daily-cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist$/);
    assert.equal(apiCalls[1].url, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
    assert.deepEqual(JSON.parse(String(apiCalls[1].data)), { project: "project-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kimi reads the official coding-plan usage endpoint through Cliproxy", async () => {
  const originalFetch = globalThis.fetch;
  const apiCalls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth-files")) return new Response(JSON.stringify({ files: [{ provider: "kimi", auth_index: "account-1" }] }), { status: 200 });
    const call = JSON.parse(String(init?.body));
    apiCalls.push(call);
    return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({
      usage: { limit: "100", used: "20", remaining: "80", resetTime: "2026-09-12T10:00:00Z" },
      limits: [],
    }) }), { status: 200 });
  };
  try {
    const result = await readCliproxyUsage({ provider: "kimi", authIndex: "account-1", label: "Kimi" }, {
      managementBaseUrl: "http://cliproxy.test/v0/management",
    });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.deepEqual(result.usage.windows, [{ label: "Weekly limit", usedPercent: 20, resetsAt: "2026-09-12T10:00:00.000Z" }]);
    assert.equal(apiCalls.length, 1);
    assert.match(String(apiCalls[0].url), /^https:\/\/api\.kimi\.com\/coding\/v1\/usages$/);
    assert.deepEqual(apiCalls[0].header, { Authorization: "Bearer $TOKEN$" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex reads the authenticated web usage endpoint through Cliproxy", async () => {
  const originalFetch = globalThis.fetch;
  const apiCalls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth-files")) return new Response(JSON.stringify({ files: [{ provider: "codex", auth_index: "account-1" }] }), { status: 200 });
    const call = JSON.parse(String(init?.body));
    apiCalls.push(call);
    return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1788951600 } },
    }) }), { status: 200 });
  };
  try {
    const result = await readCliproxyUsage({ provider: "codex", authIndex: "account-1", label: "Codex" }, {
      managementBaseUrl: "http://cliproxy.test/v0/management",
    });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.deepEqual(result.usage.windows, [{ label: "5-hour limit", usedPercent: 20, resetsAt: "2026-09-09T11:00:00.000Z" }]);
    assert.equal(apiCalls.length, 1);
    assert.match(String(apiCalls[0].url), /^https:\/\/chatgpt\.com\/backend-api\/wham\/usage$/);
    assert.deepEqual(apiCalls[0].header, {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "codex_cli_rs/0.76.0",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cliproxy queries time out rather than leaving BB's usage refresh pending", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  try {
    const result = await readCliproxyUsage({ provider: "claude", authIndex: "account-1" }, {
      managementBaseUrl: "http://cliproxy.test/v0/management",
      timeoutMs: 10,
    });
    assert.ok(result.supported && result.usage.status === "error");
    assert.match(result.usage.message, /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Antigravity custom quota labels remove only a whitespace-delimited remaining suffix", () => {
  for (const [displayName, expected] of [
    ["Daily credits remaining", "Daily credits"],
    ["Daily credits \t\n REMAINING", "Daily credits"],
    ["remaining", "remaining"],
    ["creditsremaining", "creditsremaining"],
    ["credits remaining ", "credits remaining "],
    ["credits ", "credits "],
  ]) {
    const result = normalizeAntigravityUsage({ groups: [{ displayName: "Custom", buckets: [{ displayName, remainingFraction: 0.5 }] }] }, { provider: "antigravity" });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.equal(result.usage.windows[0].label, `Custom: ${expected}`);
  }
});

test("Antigravity handles long upstream quota names without blocking the host", () => {
  // Isolate the CPU-bound regression so a bad suffix matcher cannot hang the suite.
  execFileSync(process.execPath, ["--import=tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { normalizeAntigravityUsage } from "./usage.ts";
    const displayName = "credits" + " ".repeat(300_000) + "unknown";
    const result = normalizeAntigravityUsage({ groups: [{ displayName: "Custom", buckets: [{ displayName, remainingFraction: 0.5 }] }] }, { provider: "antigravity" });
    assert.ok(result.supported && result.usage.status === "ok");
    assert.equal(result.usage.windows[0].label, "Custom: " + displayName);
  `], { cwd: new URL(".", import.meta.url), timeout: 5_000, stdio: "pipe" });
});
