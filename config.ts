import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
const cliproxyCachedWindowSchema = z.object({
  label: z.string().min(1),
  usedPercentSignal: z.string().min(1),
  resetsAtSignal: z.string().min(1).optional(),
  scale: z.enum(["fraction", "percent"]).optional(),
});

const cliproxyAccountSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  authIndex: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  cachedWindows: z.array(cliproxyCachedWindowSchema).optional(),
  poolWeight: z.number().positive().optional(),
}).refine(account => account.authIndex !== undefined || account.account !== undefined, {
  message: "either authIndex or account is required",
});

const cliproxyConfigSchema = z.object({
  managementBaseUrl: z.string().url(),
  managementKeyEnv: z.string().min(1).optional(),
  managementKeyFile: z.string().min(1).optional(),
  accounts: z.array(cliproxyAccountSchema).default([]),
});

export const localConfigSchema = z.object({
  // Legacy provider selection remains an optional filter; empty means discover all.
  enabledProviders: z.array(z.string().min(1)).optional(),
  cliproxy: cliproxyConfigSchema.extend({ enabled: z.boolean().optional() }).nullable().optional(),
});

export type CliproxyAccount = z.infer<typeof cliproxyAccountSchema>;
export type CliproxyConfig = z.infer<typeof cliproxyConfigSchema> & { enabled?: boolean };
export type AccountLimitsConfig = { enabledProviders: string[]; cliproxy: CliproxyConfig | null };
export function resolveConfig(input: unknown): AccountLimitsConfig {
  const parsed = localConfigSchema.parse(input);
  return { enabledProviders: parsed.enabledProviders ?? [], cliproxy: parsed.cliproxy?.enabled === false ? null : parsed.cliproxy ?? null };
}
export function cliproxyProviderId(provider: string): string {
  return `cliproxy-${provider.toLowerCase()}`;
}

export function cliproxyProviderDisplayName(provider: string): string {
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    xai: "Grok",
    antigravity: "Gemini · Antigravity",
    kimi: "Kimi",
    zai: "Z.ai",
  };
  const normalized = provider.toLowerCase();
  return labels[normalized] ?? provider;
}

export function loadLocalAccountLimitsConfigFile(
  file: URL,
  warn: (message: string) => void,
): Partial<AccountLimitsConfig> | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    warn(`local config unreadable (${(error as Error).message}); trying next candidate.`);
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    warn("local config is not valid JSON; trying next candidate.");
    return null;
  }
  const parsed = localConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    warn(`local config failed validation at ${issue.path.join(".") || "(root)"}: ${issue.message}; trying next candidate.`);
    return null;
  }
  // optional 字段可能以 undefined 落在结果里；过滤掉，避免覆盖默认值时引入 undefined。
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as Partial<AccountLimitsConfig>;
}

/**
 * 解析顺序（命中即停）：
 * 1. ACCOUNT_LIMITS_LOCAL_CONFIG 环境变量指向的文件；
 * 2. $XDG_CONFIG_HOME/bb/account-limits/local.json（默认 ~/.config）——机器级稳定位置，
 *    host bundle 会被 BB 复制到 plugin-host-artifacts 的哈希目录运行，插件内相对路径在 host 侧不可靠；
 * 3. 插件根 ../account-limits.local.json —— 上游兼容与开发场景（server 侧 path 安装时可用）。
 * 全部缺失时静默使用内置默认值。
 */
export function localAccountLimitsConfigCandidates(): URL[] {
  const candidates: URL[] = [];
  const fromEnv = process.env.ACCOUNT_LIMITS_LOCAL_CONFIG;
  if (fromEnv) candidates.push(pathToFileURL(fromEnv));
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  candidates.push(pathToFileURL(join(xdg, "bb", "account-limits", "local.json")));
  candidates.push(new URL("../account-limits.local.json", import.meta.url));
  return candidates;
}

export function loadLocalAccountLimitsConfig(
  candidates: URL[] = localAccountLimitsConfigCandidates(),
  warn: (message: string) => void = message => console.warn(`[account-limits] ${message}`),
): Partial<AccountLimitsConfig> {
  for (const file of candidates) {
    const overrides = loadLocalAccountLimitsConfigFile(file, warn);
    if (overrides !== null) return overrides;
  }
  return {};
}

export const config = resolveConfig(loadLocalAccountLimitsConfig());
