import { config, type AccountLimitsConfig, cliproxyProviderDisplayName, cliproxyProviderId } from "./config.js";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { accountLimitsHostContract, cliproxyUsageSnapshotSchema, type QuotaAccount, type ProviderSnapshot } from "./contract.js";
import { aggregateCliproxyUsage, cliproxyQueryError, discoverCliproxyAccounts, discoveredCliproxyGroups, readCliproxyManagementKey, readCliproxyProviderAccountUsages, usageError, type CliproxyProviderAccountUsage, type CliproxyUsageAccount, type CliproxyUsageOptions } from "./usage.js";
async function enabledCliproxyGroups(
  options: CliproxyUsageOptions,
  providerIds: readonly string[] | undefined,
  settings: AccountLimitsConfig,
): Promise<{ groups: Map<string, CliproxyUsageAccount[]>; authFiles: unknown }> {
  const { accounts, authFiles } = await discoverCliproxyAccounts(options, settings.cliproxy?.accounts ?? []);
  return { groups: discoveredCliproxyGroups(accounts, settings.enabledProviders.length ? settings.enabledProviders : accounts.map(account => cliproxyProviderId(account.provider)), providerIds), authFiles };
}

function compactAccountUsage(result: ProviderUsageResult): QuotaAccount["usage"] {
  if (!result.supported) return { status: "error", message: "Cliproxy quota querying is not supported on this machine." };
  switch (result.usage.status) {
    case "ok":
      return {
        status: "ok",
        planLabel: result.usage.planLabel,
        windows: result.usage.windows.map(window => ({
          label: window.label,
          usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
          resetsAt: window.resetsAt,
        })),
      };
    case "error": return { status: "error", message: result.usage.message };
    default: return { status: result.usage.status };
  }
}

function compactCliproxyUsage(result: ProviderUsageResult): ProviderSnapshot["providers"][number]["usage"] {
  if (!result.supported) return { status: "error", message: "Cliproxy quota querying is not supported on this machine." };
  switch (result.usage.status) {
    case "ok":
      return {
        status: "ok",
        planLabel: result.usage.planLabel,
        windows: result.usage.windows.map(window => ({
          accountLabel: typeof window.accountLabel === "string" ? window.accountLabel : null,
          label: window.label,
          usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
          resetsAt: window.resetsAt,
        })),
      };
    case "error": return { status: "error", message: result.usage.message };
    default: return { status: result.usage.status };
  }
}

export async function readProviderSnapshot(
  groups?: ReadonlyMap<string, readonly CliproxyUsageAccount[]>,
  options: Partial<CliproxyUsageOptions> = {},
  providerIds?: readonly string[],
  settings: AccountLimitsConfig = config,
): Promise<ProviderSnapshot> {
  if (!groups && !options.managementBaseUrl && !settings.cliproxy) return { providers: [] };
  const managementKey = options.managementKey ?? (settings.cliproxy ? await readCliproxyManagementKey(settings.cliproxy) : undefined);
  const query: CliproxyUsageOptions = {
    managementBaseUrl: options.managementBaseUrl ?? settings.cliproxy?.managementBaseUrl ?? "http://127.0.0.1:8317/v0/management",
    managementKey,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };
  const resolved = groups
    ? { groups, authFiles: query.authFiles }
    : await enabledCliproxyGroups(query, providerIds, settings);
  const queryWithFiles = { ...query, authFiles: resolved.authFiles };
  const providers = await Promise.all([...resolved.groups].map(async ([provider, accounts]) => {
    let entries: CliproxyProviderAccountUsage[] = [];
    let result: ProviderUsageResult;
    try {
      entries = await readCliproxyProviderAccountUsages(accounts, queryWithFiles);
      result = entries.length
        ? aggregateCliproxyUsage(provider, entries)
        : usageError("Cliproxy provider has no configured accounts.");
    } catch (error) {
      result = cliproxyQueryError(error, queryWithFiles.signal);
    }
    return {
      id: cliproxyProviderId(provider),
      displayName: cliproxyProviderDisplayName(provider),
      usage: compactCliproxyUsage(result),
      accounts: entries.map(entry => ({
        key: entry.key,
        label: entry.label,
        weight: entry.weight,
        usage: compactAccountUsage(entry.result),
      })),
    };
  }));
  return cliproxyUsageSnapshotSchema.parse({ providers });
}

export default experimental_defineHostEntry({
  contract: accountLimitsHostContract,
  handlers: {
    cliproxyStatus: () => ({ configured: config.cliproxy !== null }),
    readCliproxyUsage: ({ providerIds }, context) => readProviderSnapshot(undefined, { signal: context.signal }, providerIds),
  },
});
