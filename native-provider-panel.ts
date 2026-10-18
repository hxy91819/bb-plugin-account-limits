import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { accountLimitsPanelSnapshotSchema, type AccountLimitsPanelReadInput, type AccountLimitsPanelSnapshot, type QuotaAccount } from "./contract.js";

type UsageResponse = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>>;
type PanelProvider = AccountLimitsPanelSnapshot["machines"][number]["providers"][number];
export interface NativeProviderPanelDependencies {
  listHosts(): Promise<readonly { id: string; name: string; status: string }[]>;
  listProviders(hostId: string): Promise<readonly { id: string; displayName: string; pluginId?: string }[]>;
  now?(): number;
  readUsage(input: { hostId: string; providerId: string; refresh: boolean }): Promise<UsageResponse>;
}

function toProvider(id: string, displayName: string, usage: UsageResponse[string], collectedAt: number | null = null): PanelProvider {
  const label = ("accountEmail" in usage && typeof usage.accountEmail === "string" && usage.accountEmail) || displayName;
  const normalized: QuotaAccount["usage"] = usage.status === "ok"
    ? { status: "ok", planLabel: usage.planLabel, windows: usage.windows.map((window, index) => ({
        id: JSON.stringify([window.kind ?? "custom", window.id ?? index, window.model ?? null]),
        label: typeof window.model === "string" && !window.label.includes(window.model) ? `${window.label} · ${window.model}` : window.label,
        usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
        resetsAt: window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? new Date(window.resetsAt).toISOString() : null,
      })) }
    : usage.status === "error" ? { status: "error", message: usage.message || "读取 BB 账户额度失败。" } : { status: usage.status };
  // These built-in maintenance handlers fetch quota upstream on every request.
  // The completion of a successful collection is a valid local observation time.
  const updatedAt = usage.status === "ok" && collectedAt !== null ? new Date(collectedAt).toISOString() : null;
  return { id, displayName, updatedAt,
    accounts: [{ key: id, label, weight: 1, updatedAt, usage: normalized }],
    usage: normalized.status === "ok" ? { ...normalized, windows: normalized.windows.map(window => ({
      label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt, accountLabel: label,
    })) } : normalized,
  };
}

/** Reuses BB's provider maintenance API; credentials and provider discovery remain owned by BB. */
export function createNativeProviderPanelReader(deps: NativeProviderPanelDependencies) {
  const previous = new Map<string, Map<string, PanelProvider>>();
  return async (input: AccountLimitsPanelReadInput): Promise<AccountLimitsPanelSnapshot> => {
    const machines = [];
    for (const host of await deps.listHosts()) {
      const cached = previous.get(host.id) ?? new Map<string, PanelProvider>();
      if (host.status !== "connected") {
        if (cached.size) machines.push({ id: `bb:${host.id}`, source: "bb-providers" as const, displayName: host.name,
          status: "disconnected" as const, providers: [], error: null });
        continue;
      }
      try {
        const inventory = await deps.listProviders(host.id);
        const providers: PanelProvider[] = [];
        // Bound collection concurrency and isolate per-provider failures.
        for (let offset = 0; offset < inventory.length; offset += 3) {
          const entries = await Promise.all(inventory.slice(offset, offset + 3).map(async provider => {
            if (input.providerIds && !input.providerIds.includes(provider.id)) return cached.get(provider.id)
              ?? toProvider(provider.id, provider.displayName, { status: "error", message: "此 BB 账户额度尚未读取，请刷新此服务。", accountEmail: null, planLabel: null });
            try {
              const result = await deps.readUsage({ hostId: host.id, providerId: provider.id, refresh: input.force === true });
              const usage = result[provider.id];
              // Verified BB native Codex/Claude handlers collect fresh upstream usage;
              // third-party providers may return caches without an observation time.
              const freshCollection = provider.pluginId === "provider-codex" || provider.pluginId === "provider-claude-code";
              return usage ? toProvider(provider.id, provider.displayName, usage, freshCollection ? (deps.now?.() ?? Date.now()) : null) : null;
            } catch {
              return toProvider(provider.id, provider.displayName, { status: "error", message: "读取此 BB 账户额度失败，请重试。", accountEmail: null, planLabel: null });
            }
          }));
          providers.push(...entries.filter(entry => entry !== null));
        }
        previous.set(host.id, new Map(providers.map(provider => [provider.id, provider])));
        if (providers.length) machines.push({ id: `bb:${host.id}`, source: "bb-providers" as const, displayName: host.name,
          status: "connected" as const, providers, error: null });
      } catch {
        machines.push({ id: `bb:${host.id}`, source: "bb-providers" as const, displayName: host.name,
          status: cached.size ? "connected" as const : "error" as const,
          providers: [...cached.values()], error: cached.size
            ? "无法发现此机器的 BB 额度来源，正在显示上次读取的缓存。"
            : "无法发现此机器的 BB 额度来源，请重试。" });
      }
    }
    return accountLimitsPanelSnapshotSchema.parse({ machines });
  };
}
