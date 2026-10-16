import { cliproxyProviderDisplayName, cliproxyProviderId } from "./config.js";
import { orderQuotaWindows } from "./pool.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
export function usageError(message: string): ProviderUsageResult {
  return { supported: true, usage: { status: "error", message, planLabel: null, accountEmail: null } };
}
export interface CliproxyUsageAccount {
  provider: string;
  authIndex?: string;
  account?: string;
  label?: string;
  enabled?: boolean;
  cachedWindows?: Array<{
    label: string;
    usedPercentSignal: string;
    resetsAtSignal?: string;
    scale?: "fraction" | "percent";
  }>;
  poolWeight?: number;
}

export interface CliproxyUsageOptions {
  managementBaseUrl: string;
  managementKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  authFiles?: unknown;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function usageLabel(account: CliproxyUsageAccount): string {
  return account.label ?? account.account ?? account.authIndex ?? account.provider;
}

function managementHeaders(key: string | undefined): HeadersInit {
  return key ? { authorization: `Bearer ${key}` } : {};
}

function parseReset(value: unknown): string | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) {
    const seconds = Number(value);
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cliproxyRecordMatches(record: JsonRecord, account: CliproxyUsageAccount): boolean {
  if (String(record.provider ?? record.type ?? "").toLowerCase() !== account.provider.toLowerCase()) return false;
  if (account.authIndex) return record.auth_index === account.authIndex || record.authIndex === account.authIndex;
  const selected = account.account?.toLowerCase();
  if (!selected) return false;
  return [record.account, record.email, record.name, record.label]
    .some(value => typeof value === "string" && value.toLowerCase() === selected);
}

function cliproxyRecordAuthIndex(record: JsonRecord): string | null {
  return asString(record.auth_index) ?? asString(record.authIndex);
}

function cliproxyRecordProvider(record: JsonRecord): string | null {
  const provider = asString(record.provider) ?? asString(record.type);
  return provider ? provider.toLowerCase() : null;
}

function cliproxyRecordIdentity(record: JsonRecord): string | null {
  return asString(record.email) ?? asString(record.account) ?? asString(record.label) ?? asString(record.name);
}

export function cliproxyAccountsFromAuthFiles(
  raw: unknown,
  configured: readonly CliproxyUsageAccount[] = [],
): CliproxyUsageAccount[] {
  const response = asRecord(raw);
  const files = response && Array.isArray(response.files)
    ? response.files.map(asRecord).filter((value): value is JsonRecord => value !== null)
    : [];
  const accounts: CliproxyUsageAccount[] = [];
  for (const record of files) {
    const provider = cliproxyRecordProvider(record);
    const authIndex = cliproxyRecordAuthIndex(record);
    if (!provider || !authIndex) continue;
    const identity = cliproxyRecordIdentity(record);
    const match = configured.find(account => cliproxyRecordMatches(record, account));
    if (match?.enabled === false) continue;
    accounts.push({
      provider,
      authIndex,
      ...(identity ? { account: identity } : {}),
      label: match?.label ?? identity ?? authIndex,
      ...(match?.cachedWindows ? { cachedWindows: match.cachedWindows } : {}),
      ...(match?.poolWeight !== undefined ? { poolWeight: match.poolWeight } : {}),
    });
  }
  return accounts;
}

export function discoveredCliproxyGroups(
  accounts: readonly CliproxyUsageAccount[],
  enabledProviders: readonly string[],
  providerIds?: readonly string[],
): Map<string, CliproxyUsageAccount[]> {
  const selected = providerIds ? new Set(providerIds) : null;
  const groups = new Map<string, CliproxyUsageAccount[]>();
  for (const account of accounts) {
    const provider = account.provider.toLowerCase();
    const providerId = cliproxyProviderId(provider);
    if (!enabledProviders.includes(providerId)) continue;
    if (selected && !selected.has(providerId)) continue;
    const group = groups.get(provider);
    if (group) group.push(account);
    else groups.set(provider, [account]);
  }
  return groups;
}

export async function discoverCliproxyAccounts(
  options: CliproxyUsageOptions,
  configured: readonly CliproxyUsageAccount[] = [],
): Promise<{ accounts: CliproxyUsageAccount[]; authFiles: unknown }> {
  const authFiles = options.authFiles ?? await readCliproxyAuthFiles(options);
  return { accounts: cliproxyAccountsFromAuthFiles(authFiles, configured), authFiles };
}

function getSelectedCliproxyRecord(raw: unknown, account: CliproxyUsageAccount): JsonRecord | ProviderUsageResult {
  const response = asRecord(raw);
  const files = response && Array.isArray(response.files) ? response.files.map(asRecord).filter((value): value is JsonRecord => value !== null) : [];
  const matches = files.filter(record => cliproxyRecordMatches(record, account));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return usageError("Cliproxy account selector matches more than one credential; configure authIndex.");
  return usageError("Cliproxy account was not found; check the configured provider and selector.");
}

function isUsageResult(value: JsonRecord | ProviderUsageResult): value is ProviderUsageResult {
  return "supported" in value;
}

function hasOkUsage(result: ProviderUsageResult): boolean {
  return asRecord(result.usage)?.status === "ok";
}

function labelForClaudeLimit(limit: JsonRecord): string {
  const kind = asString(limit.kind) ?? asString(limit.group) ?? "quota";
  const labels: Record<string, string> = {
    session: "5-hour limit",
    weekly_all: "Weekly limit",
    weekly_scoped: "Weekly scoped limit",
  };
  return labels[kind] ?? kind.replaceAll("_", " ");
}

export function normalizeClaudeUsage(raw: unknown, account: CliproxyUsageAccount): ProviderUsageResult {
  const response = asRecord(raw);
  const limits = response && Array.isArray(response.limits) ? response.limits.map(asRecord).filter((value): value is JsonRecord => value !== null) : [];
  const windows = limits.flatMap(limit => {
    const usedPercent = Number(limit.percent);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return [];
    return [{ label: labelForClaudeLimit(limit), usedPercent, resetsAt: parseReset(limit.resets_at) }];
  });
  if (!windows.length) return usageError("Cliproxy returned an unrecognized Claude quota response.");
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: usageLabel(account), windows } };
}

function xaiPeriodLabel(value: unknown): string {
  const type = asString(value)?.toLowerCase() ?? "";
  if (type.includes("week")) return "Weekly limit";
  if (type.includes("month")) return "Monthly limit";
  return "Current period";
}

export function normalizeGrokUsage(raw: unknown, account: CliproxyUsageAccount): ProviderUsageResult {
  const response = asRecord(raw);
  const quota = response && asRecord(response.config);
  if (!quota) return usageError("Cliproxy returned an unrecognized Grok quota response.");
  const period = asRecord(quota.currentPeriod);
  const resetsAt = parseReset(period?.end ?? quota.billingPeriodEnd);
  const windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }> = [];
  const periodUsage = Number(quota.creditUsagePercent);
  if (Number.isFinite(periodUsage) && periodUsage >= 0 && periodUsage <= 100) {
    windows.push({
      label: xaiPeriodLabel(period?.type),
      usedPercent: periodUsage,
      resetsAt,
    });
  }
  const products = Array.isArray(quota.productUsage) ? quota.productUsage.map(asRecord) : [];
  for (const product of products) {
    if (!product) continue;
    const name = asString(product.product);
    const usedPercent = Number(product.usagePercent);
    if (!name || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    windows.push({ label: name, usedPercent, resetsAt });
  }
  if (!windows.length) return usageError("Cliproxy returned no usable Grok quota windows.");
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: usageLabel(account), windows } };
}

function antigravityLimitLabel(displayName: string): string {
  // Match a fixed-size suffix, then trim its preceding whitespace in linear time.
  const suffix = /\sremaining$/i.exec(displayName);
  return suffix ? displayName.slice(0, suffix.index).trimEnd() : displayName;
}

function antigravityBucketLabel(group: JsonRecord, bucket: JsonRecord): string {
  const groupLabel = asString(group.displayName) ?? "Antigravity";
  const window = asString(bucket.window)?.toLowerCase();
  const limitLabel = window === "weekly" ? "Weekly limit"
    : window === "5h" ? "5-hour limit"
      : antigravityLimitLabel(asString(bucket.displayName) ?? "Quota");
  return `${groupLabel}: ${limitLabel}`;
}

export function normalizeAntigravityUsage(raw: unknown, account: CliproxyUsageAccount, planLabel: string | null = null): ProviderUsageResult {
  const response = asRecord(raw);
  const groups = response && Array.isArray(response.groups) ? response.groups.map(asRecord).filter((value): value is JsonRecord => value !== null) : [];
  const windows = groups.flatMap(group => {
    const buckets = Array.isArray(group.buckets) ? group.buckets.map(asRecord).filter((value): value is JsonRecord => value !== null) : [];
    return buckets.flatMap(bucket => {
      // 上游标为停用的窗口不适用于当前账号，不能把 remainingFraction=1 当作可用额度。
      if (bucket.disabled === true) return [];
      const remainingFraction = Number(bucket.remainingFraction);
      if (!Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) return [];
      return [{
        label: antigravityBucketLabel(group, bucket),
        usedPercent: Number(((1 - remainingFraction) * 100).toFixed(10)),
        resetsAt: parseReset(bucket.resetTime),
      }];
    });
  });
  if (!windows.length) return usageError("Cliproxy returned an unrecognized Antigravity quota response.");
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: planLabel ?? usageLabel(account), windows: orderQuotaWindows(windows) } };
}

function positiveNumber(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value.replaceAll(",", "")) : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function kimiWindowLabel(raw: JsonRecord, fallback: string): string {
  const duration = positiveNumber(raw.duration);
  const unit = asString(raw.timeUnit)?.toLowerCase();
  if (unit === "time_unit_minute" && duration === 300) return "5-hour limit";
  if (unit === "time_unit_minute" && duration === 10080) return "Weekly limit";
  return unit === "time_unit_minute" && duration ? `${duration}-minute limit` : fallback;
}

function kimiUsageWindow(raw: JsonRecord, label: string): { label: string; usedPercent: number; resetsAt: string | null } | null {
  const limit = positiveNumber(raw.limit);
  const used = typeof raw.used === "string" ? Number(raw.used.replaceAll(",", "")) : Number(raw.used);
  if (!limit || !Number.isFinite(used) || used < 0 || used > limit) return null;
  return { label, usedPercent: Number((used / limit * 100).toFixed(10)), resetsAt: parseReset(raw.resetTime) };
}

export function normalizeKimiUsage(raw: unknown, account: CliproxyUsageAccount): ProviderUsageResult {
  const response = asRecord(raw);
  if (!response) return usageError("Cliproxy returned an unrecognized Kimi quota response.");
  const windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }> = [];
  const weekly = asRecord(response.usage);
  if (weekly) {
    const window = kimiUsageWindow(weekly, "Weekly limit");
    if (window) windows.push(window);
  }
  const limits = Array.isArray(response.limits) ? response.limits.map(asRecord).filter((value): value is JsonRecord => value !== null) : [];
  for (const limit of limits) {
    const detail = asRecord(limit.detail);
    if (!detail) continue;
    const window = kimiUsageWindow(detail, kimiWindowLabel(asRecord(limit.window) ?? {}, "Current limit"));
    if (window) windows.push(window);
  }
  if (!windows.length) return usageError("Cliproxy returned an unrecognized Kimi quota response.");
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: usageLabel(account), windows } };
}

function codexWhamWindowLabel(value: JsonRecord, fallback: string): string {
  const seconds = positiveNumber(value.limit_window_seconds);
  if (seconds === 18_000) return "5-hour limit";
  if (seconds === 604_800) return "Weekly limit";
  return seconds ? `${Math.round(seconds / 60)}-minute limit` : fallback;
}

function codexWhamWindows(raw: JsonRecord, prefix: string): Array<{ label: string; usedPercent: number; resetsAt: string | null }> {
  const windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }> = [];
  for (const key of ["primary_window", "secondary_window"] as const) {
    const window = asRecord(raw[key]);
    if (!window) continue;
    const usedPercent = Number(window.used_percent);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const label = codexWhamWindowLabel(window, key === "primary_window" ? "Current limit" : "Secondary limit");
    windows.push({ label: prefix ? `${prefix}: ${label}` : label, usedPercent, resetsAt: parseReset(window.reset_at) });
  }
  return windows;
}

export function normalizeCliproxyCodexUsage(raw: unknown, account: CliproxyUsageAccount): ProviderUsageResult {
  const response = asRecord(raw);
  const primary = response && asRecord(response.rate_limit);
  if (!response || !primary) return usageError("Cliproxy returned an unrecognized Codex quota response.");
  const windows = codexWhamWindows(primary, "");
  const additional = Array.isArray(response.additional_rate_limits) ? response.additional_rate_limits.map(asRecord).filter((value): value is JsonRecord => value !== null) : [];
  for (const limit of additional) {
    const label = asString(limit.limit_name) ?? asString(limit.metered_feature) ?? "Additional limit";
    const rateLimit = asRecord(limit.rate_limit);
    if (rateLimit) windows.push(...codexWhamWindows(rateLimit, label));
  }
  if (!windows.length) return usageError("Cliproxy returned an unrecognized Codex quota response.");
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: asString(response.plan_type) ?? usageLabel(account), windows } };
}

function cachedQuotaSignals(record: JsonRecord): JsonRecord[] {
  const sources: JsonRecord[] = [];
  const quota = asRecord(record.quota);
  if (quota) sources.push(quota);
  const modelQuotas = asRecord(record.model_quotas);
  if (modelQuotas) {
    for (const value of Object.values(modelQuotas)) {
      const source = asRecord(value);
      if (source) sources.push(source);
    }
  }
  return sources.sort((left, right) => {
    const leftTime = Date.parse(asString(left.observed_at) ?? "") || 0;
    const rightTime = Date.parse(asString(right.observed_at) ?? "") || 0;
    return rightTime - leftTime;
  });
}

function signalWindowLabel(segment: string): string {
  const labels: Record<string, string> = {
    "5h": "5-hour limit",
    "7d": "Weekly limit",
    "7d_oi": "Weekly Opus limit",
  };
  return labels[segment.toLowerCase()] ?? segment.replaceAll("_", " ");
}

function readCachedSignal(sources: JsonRecord[], signalName: string): unknown {
  for (const source of sources) {
    const signals = asRecord(source.signals);
    if (!signals) continue;
    const match = Object.entries(signals).find(([name]) => name.toLowerCase() === signalName.toLowerCase());
    if (match) return match[1];
  }
  return undefined;
}

function normalizeConfiguredCachedWindows(sources: JsonRecord[], account: CliproxyUsageAccount): ProviderUsageResult | null {
  if (!account.cachedWindows?.length) return null;
  const windows = account.cachedWindows.flatMap(window => {
    const sourceValue = Number(readCachedSignal(sources, window.usedPercentSignal));
    const usedPercent = window.scale === "fraction" ? sourceValue * 100 : sourceValue;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return [];
    return [{
      label: window.label,
      usedPercent,
      resetsAt: window.resetsAtSignal ? parseReset(readCachedSignal(sources, window.resetsAtSignal)) : null,
    }];
  });
  if (!windows.length) return usageError("Cliproxy has no cached quota signals matching this account's configured windows.");
  return { supported: true, usage: {
    status: "ok", accountEmail: null, planLabel: `${usageLabel(account)} (cached)`, windows,
  } };
}

export function normalizeCliproxyCachedUsage(raw: unknown, account: CliproxyUsageAccount): ProviderUsageResult {
  const record = asRecord(raw);
  if (!record) return usageError("Cliproxy returned an unrecognized credential record.");
  const sources = cachedQuotaSignals(record);
  const configured = normalizeConfiguredCachedWindows(sources, account);
  if (configured) return configured;
  const windows = new Map<string, { label: string; usedPercent: number; resetsAt: string | null }>();
  for (const source of sources) {
    const signals = asRecord(source.signals);
    if (!signals) continue;
    for (const [name, rawUtilization] of Object.entries(signals)) {
      const match = /^anthropic-ratelimit-unified-(.+)-utilization$/i.exec(name);
      if (!match) continue;
      const utilization = Number(rawUtilization);
      if (!Number.isFinite(utilization) || utilization < 0 || utilization > 1) continue;
      const segment = match[1].toLowerCase();
      if (windows.has(segment)) continue;
      const resetKey = name.replace(/-utilization$/i, "-reset");
      const resetValue = Object.entries(signals).find(([key]) => key.toLowerCase() === resetKey.toLowerCase())?.[1];
      windows.set(segment, {
        label: signalWindowLabel(segment),
        usedPercent: utilization * 100,
        resetsAt: parseReset(resetValue),
      });
    }
  }
  if (!windows.size) return usageError("Cliproxy has no cached quota signals for this account yet.");
  return { supported: true, usage: {
    status: "ok", accountEmail: null, planLabel: `${usageLabel(account)} (cached)`, windows: [...windows.values()],
  } };
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

async function fetchCliproxy(
  input: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (signal?.aborted) throw new Error("cliproxy-query-cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error("cliproxy-query-timed-out");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

interface CliproxyApiCall {
  method: string;
  url: string;
  header: Record<string, string>;
  data?: string;
}

async function callCliproxyApi(
  managementBaseUrl: string,
  managementKey: string | undefined,
  authIndex: string,
  request: CliproxyApiCall,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchCliproxy(`${managementBaseUrl}/api-call`, {
    method: "POST",
    headers: { ...managementHeaders(managementKey), "content-type": "application/json" },
    body: JSON.stringify({
      auth_index: authIndex,
      ...request,
    }),
  }, signal, timeoutMs);
  const envelope = asRecord(await readJson(response));
  const status = typeof envelope?.status_code === "number" ? envelope.status_code : response.status;
  const body = typeof envelope?.body === "string" ? (() => { try { return JSON.parse(envelope.body); } catch { return null; } })() : envelope?.body;
  return { status, body };
}

async function readClaudeUsageThroughCliproxy(
  managementBaseUrl: string,
  managementKey: string | undefined,
  authIndex: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  return callCliproxyApi(managementBaseUrl, managementKey, authIndex, {
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
  }, signal, timeoutMs);
}

async function readGrokUsageThroughCliproxy(
  managementBaseUrl: string,
  managementKey: string | undefined,
  authIndex: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  return callCliproxyApi(managementBaseUrl, managementKey, authIndex, {
    method: "GET",
    url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    header: {
      Authorization: "Bearer $TOKEN$",
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.91",
      accept: "*/*",
      "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (linux; x86_64)",
    },
  }, signal, timeoutMs);
}

async function readAntigravityUsageThroughCliproxy(
  managementBaseUrl: string,
  managementKey: string | undefined,
  authIndex: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; planLabel: string | null }> {
  const header = { Authorization: "Bearer $TOKEN$", Accept: "*/*", "Content-Type": "application/json", "User-Agent": "antigravity" };
  const load = await callCliproxyApi(managementBaseUrl, managementKey, authIndex, {
    method: "POST",
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    header,
    data: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  }, signal, timeoutMs);
  const loadBody = asRecord(load.body);
  const project = asString(loadBody?.cloudaicompanionProject);
  if (load.status < 200 || load.status >= 300 || !project) return { status: load.status, body: null, planLabel: null };
  const planLabel = asString(asRecord(loadBody?.paidTier)?.name) ?? asString(asRecord(loadBody?.currentTier)?.name);
  const quota = await callCliproxyApi(managementBaseUrl, managementKey, authIndex, {
    method: "POST",
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    header,
    data: JSON.stringify({ project }),
  }, signal, timeoutMs);
  return { ...quota, planLabel };
}

async function readKimiUsageThroughCliproxy(
  managementBaseUrl: string,
  managementKey: string | undefined,
  authIndex: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  return callCliproxyApi(managementBaseUrl, managementKey, authIndex, {
    method: "GET",
    url: "https://api.kimi.com/coding/v1/usages",
    header: { Authorization: "Bearer $TOKEN$" },
  }, signal, timeoutMs);
}

async function readCodexUsageThroughCliproxy(
  managementBaseUrl: string,
  managementKey: string | undefined,
  authIndex: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  return callCliproxyApi(managementBaseUrl, managementKey, authIndex, {
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    header: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "codex_cli_rs/0.76.0",
    },
  }, signal, timeoutMs);
}

async function readCliproxyAccountUsage(
  account: CliproxyUsageAccount,
  selected: JsonRecord,
  options: CliproxyUsageOptions,
): Promise<ProviderUsageResult> {
  const managementBaseUrl = options.managementBaseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const authIndex = asString(selected.auth_index) ?? asString(selected.authIndex);
  if (account.provider.toLowerCase() === "claude" && authIndex) {
    const upstream = await readClaudeUsageThroughCliproxy(managementBaseUrl, options.managementKey, authIndex, options.signal, timeoutMs);
    if (upstream.status >= 200 && upstream.status < 300) {
      const normalized = normalizeClaudeUsage(upstream.body, account);
      if (hasOkUsage(normalized)) return normalized;
    }
    const cached = normalizeCliproxyCachedUsage(selected, account);
    if (hasOkUsage(cached)) return cached;
    return usageError(`Cliproxy could not read Claude quota (${upstream.status}).`);
  }
  if (account.provider.toLowerCase() === "xai" && authIndex) {
    const upstream = await readGrokUsageThroughCliproxy(managementBaseUrl, options.managementKey, authIndex, options.signal, timeoutMs);
    if (upstream.status >= 200 && upstream.status < 300) {
      const normalized = normalizeGrokUsage(upstream.body, account);
      if (hasOkUsage(normalized)) return normalized;
    }
    const cached = normalizeCliproxyCachedUsage(selected, account);
    if (hasOkUsage(cached)) return cached;
    return usageError(`Cliproxy could not read Grok quota (${upstream.status}).`);
  }
  if (account.provider.toLowerCase() === "antigravity" && authIndex) {
    const upstream = await readAntigravityUsageThroughCliproxy(managementBaseUrl, options.managementKey, authIndex, options.signal, timeoutMs);
    if (upstream.status >= 200 && upstream.status < 300) {
      const normalized = normalizeAntigravityUsage(upstream.body, account, upstream.planLabel);
      if (hasOkUsage(normalized)) return normalized;
    }
    const cached = normalizeCliproxyCachedUsage(selected, account);
    if (hasOkUsage(cached)) return cached;
    return usageError(`Cliproxy could not read Antigravity quota (${upstream.status}).`);
  }
  if (account.provider.toLowerCase() === "kimi" && authIndex) {
    const upstream = await readKimiUsageThroughCliproxy(managementBaseUrl, options.managementKey, authIndex, options.signal, timeoutMs);
    if (upstream.status >= 200 && upstream.status < 300) {
      const normalized = normalizeKimiUsage(upstream.body, account);
      if (hasOkUsage(normalized)) return normalized;
    }
    const cached = normalizeCliproxyCachedUsage(selected, account);
    if (hasOkUsage(cached)) return cached;
    return usageError(`Cliproxy could not read Kimi quota (${upstream.status}).`);
  }
  if (account.provider.toLowerCase() === "codex" && authIndex) {
    const upstream = await readCodexUsageThroughCliproxy(managementBaseUrl, options.managementKey, authIndex, options.signal, timeoutMs);
    if (upstream.status >= 200 && upstream.status < 300) {
      const normalized = normalizeCliproxyCodexUsage(upstream.body, account);
      if (hasOkUsage(normalized)) return normalized;
    }
    const cached = normalizeCliproxyCachedUsage(selected, account);
    if (hasOkUsage(cached)) return cached;
    return usageError(`Cliproxy could not read Codex quota (${upstream.status}).`);
  }
  return normalizeCliproxyCachedUsage(selected, account);
}

export interface CliproxyProviderAccountUsage {
  /** 稳定且不含凭据的账号 key：authIndex 的 sha256 前 16 位。 */
  key: string;
  label: string;
  /** 池聚合权重（cliproxy.accounts[].poolWeight），默认 1。 */
  weight: number;
  result: ProviderUsageResult;
}

export function cliproxyAccountKey(account: CliproxyUsageAccount): string {
  const identity = account.authIndex ?? account.account ?? usageLabel(account);
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

export function aggregateCliproxyUsage(
  provider: string,
  entries: readonly CliproxyProviderAccountUsage[],
): ProviderUsageResult {
  const windows = entries.flatMap(entry => {
    const usage = asRecord(entry.result.usage);
    if (usage?.status !== "ok" || !Array.isArray(usage.windows)) return [];
    return usage.windows.flatMap(rawWindow => {
      const window = asRecord(rawWindow);
      if (!window) return [];
      const label = asString(window.label);
      const usedPercent = Number(window.usedPercent);
      if (!label || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return [];
      return [{
        label: `${entry.label} · ${label}`,
        accountLabel: entry.label,
        usedPercent,
        resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
      }];
    });
  });
  if (!windows.length) return usageError("Cliproxy did not return quota data for any configured account.");
  const displayName = cliproxyProviderDisplayName(provider);
  const successful = entries.filter(entry => hasOkUsage(entry.result)).length;
  return {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: `${displayName} · Cliproxy · ${successful}/${entries.length} accounts`,
      windows,
    },
  };
}

async function readCliproxyAuthFiles(options: CliproxyUsageOptions): Promise<unknown> {
  if (options.authFiles !== undefined) return options.authFiles;
  const managementBaseUrl = options.managementBaseUrl.replace(/\/$/, "");
  const response = await fetchCliproxy(`${managementBaseUrl}/auth-files`, {
    headers: managementHeaders(options.managementKey),
  }, options.signal, options.timeoutMs ?? 20_000);
  if (!response.ok) throw new Error(`cliproxy-credential-query-${response.status}`);
  return readJson(response);
}

export function cliproxyQueryError(error: unknown, signal: AbortSignal | undefined): ProviderUsageResult {
  if (signal?.aborted || (error as Error).message === "cliproxy-query-cancelled") return usageError("Cliproxy quota query cancelled.");
  if ((error as Error).message === "cliproxy-query-timed-out") return usageError("Cliproxy quota query timed out.");
  const status = /^cliproxy-credential-query-(\d+)$/u.exec((error as Error).message)?.[1];
  if (status) return usageError(`Cliproxy credential query failed (${status}).`);
  return usageError("Could not query Cliproxy quota.");
}

/**
 * Query a selected credential via CLIProxyAPI's authenticated management API.
 * Claude uses the proxy's token substitution for a fresh official usage read;
 * cached rate-limit signals provide a read-only fallback when the upstream call
 * is temporarily unavailable.
 */
export async function readCliproxyUsage(account: CliproxyUsageAccount, options: CliproxyUsageOptions): Promise<ProviderUsageResult> {
  try {
    const selected = getSelectedCliproxyRecord(await readCliproxyAuthFiles(options), account);
    if (isUsageResult(selected)) return selected;
    return await readCliproxyAccountUsage(account, selected, options);
  } catch (error) {
    return cliproxyQueryError(error, options.signal);
  }
}

/**
 * 按账号读取 Cliproxy 额度：每个账号返回独立结果，失败账号保留为 error 状态，
 * 不再压平丢失。auth-files 本身不可用时整体抛错，由调用方转成供应商级 error。
 */
export async function readCliproxyProviderAccountUsages(
  accounts: readonly CliproxyUsageAccount[],
  options: CliproxyUsageOptions,
): Promise<CliproxyProviderAccountUsage[]> {
  if (!accounts.length) return [];
  const authFiles = await readCliproxyAuthFiles(options);
  return Promise.all(accounts.map(async account => {
    let result: ProviderUsageResult;
    try {
      const selected = getSelectedCliproxyRecord(authFiles, account);
      result = isUsageResult(selected)
        ? selected
        : await readCliproxyAccountUsage(account, selected, options);
    } catch (error) {
      result = cliproxyQueryError(error, options.signal);
    }
    return { key: cliproxyAccountKey(account), label: usageLabel(account), weight: account.poolWeight ?? 1, result };
  }));
}

export async function readCliproxyProviderUsage(
  accounts: readonly CliproxyUsageAccount[],
  options: CliproxyUsageOptions,
): Promise<ProviderUsageResult> {
  if (!accounts.length) return usageError("Cliproxy provider has no configured accounts.");
  try {
    return aggregateCliproxyUsage(accounts[0]!.provider, await readCliproxyProviderAccountUsages(accounts, options));
  } catch (error) {
    return cliproxyQueryError(error, options.signal);
  }
}

export async function readCliproxyManagementKey(options: {
  managementKeyEnv?: string;
  managementKeyFile?: string;
}): Promise<string | undefined> {
  const fromEnv = options.managementKeyEnv ? process.env[options.managementKeyEnv]?.trim() : undefined;
  if (fromEnv) return fromEnv;
  if (!options.managementKeyFile) return undefined;
  try {
    const fromFile = (await readFile(options.managementKeyFile, "utf8")).trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}
