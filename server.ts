import { createQuotaReader } from "./sources.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  accountLimitsHostContract,
  accountLimitsPanelRpcContract,
  accountLimitsPanelSnapshotSchema,
  cliproxyUsageSnapshotSchema,
  type AccountLimitsPanelReadInput,
  type AccountLimitsPanelSnapshot,
  type ProviderSnapshot,
} from "./contract.js";
import { createCliproxyUsageSource } from "./usage-source.js";
import { usageFetchMethod, usageListMethod, usageSourceRpcContract } from "./usage-source-contract.js";
import { createAccountPoolPanelReader } from "./account-pool-panel.js";

export const CLIPROXY_USAGE_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
export const CLIPROXY_USAGE_REFRESH_SCHEDULE_NAME = "refresh-cliproxy-usage";
export const CLIPROXY_USAGE_REFRESH_CRON = "*/30 * * * *";

type PanelProvider = AccountLimitsPanelSnapshot["machines"][number]["providers"][number];
type CachedProvider = Omit<PanelProvider, "updatedAt"> & { updatedAtMs: number };

interface PanelCacheRecord {
  fullSnapshotUpdatedAtMs: number | null;
  providers: CachedProvider[];
}

interface PanelCache {
  read(hostId: string): PanelCacheRecord | null;
  replaceAll(hostId: string, providers: ProviderSnapshot["providers"], updatedAtMs: number): void;
  update(hostId: string, providers: ProviderSnapshot["providers"], updatedAtMs: number): void;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  transaction(action: () => void): () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function cachedProviders(providers: ProviderSnapshot["providers"], updatedAtMs: number): CachedProvider[] {
  return providers.map(provider => ({ ...provider, updatedAtMs }));
}

export function createInMemoryPanelCache(): PanelCache {
  const records = new Map<string, PanelCacheRecord>();
  return {
    read(hostId) {
      const record = records.get(hostId);
      if (!record) return null;
      return { fullSnapshotUpdatedAtMs: record.fullSnapshotUpdatedAtMs, providers: record.providers.map(provider => ({ ...provider })) };
    },
    replaceAll(hostId, providers, updatedAtMs) {
      records.set(hostId, { fullSnapshotUpdatedAtMs: updatedAtMs, providers: cachedProviders(providers, updatedAtMs) });
    },
    update(hostId, providers, updatedAtMs) {
      const record = records.get(hostId) ?? { fullSnapshotUpdatedAtMs: null, providers: [] };
      const byId = new Map(record.providers.map(provider => [provider.id, provider]));
      for (const provider of cachedProviders(providers, updatedAtMs)) byId.set(provider.id, provider);
      records.set(hostId, { ...record, providers: [...byId.values()] });
    },
  };
}

export function createSqlitePanelCache(database: SqliteDatabase): PanelCache {
  const readMeta = database.prepare("SELECT full_snapshot_updated_at_ms FROM cliproxy_usage_cache_hosts WHERE host_id = ?");
  const readProviders = database.prepare("SELECT provider_json, updated_at_ms FROM cliproxy_usage_cache_providers WHERE host_id = ? ORDER BY rowid");
  const deleteProviders = database.prepare("DELETE FROM cliproxy_usage_cache_providers WHERE host_id = ?");
  const writeProvider = database.prepare("INSERT INTO cliproxy_usage_cache_providers (host_id, provider_id, provider_json, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(host_id, provider_id) DO UPDATE SET provider_json = excluded.provider_json, updated_at_ms = excluded.updated_at_ms");
  const writeMeta = database.prepare("INSERT INTO cliproxy_usage_cache_hosts (host_id, full_snapshot_updated_at_ms) VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET full_snapshot_updated_at_ms = excluded.full_snapshot_updated_at_ms");

  return {
    read(hostId) {
      const meta = asRecord(readMeta.get(hostId));
      // 旧格式缓存行解析失败时丢弃；一行都不剩视同无缓存，由调用方重新读取。
      const rows = readProviders.all(hostId);
      const providers = rows.flatMap(row => {
        const record = asRecord(row);
        const updatedAtMs = asTimestamp(record?.updated_at_ms);
        if (updatedAtMs === null || typeof record?.provider_json !== "string") return [];
        try {
          const parsed = cliproxyUsageSnapshotSchema.safeParse({ providers: [JSON.parse(record.provider_json)] });
          return parsed.success ? cachedProviders(parsed.data.providers, updatedAtMs) : [];
        } catch { return []; }
      });
      if (rows.length > 0 && providers.length === 0) return null;
      if (!meta && providers.length === 0) return null;
      return { fullSnapshotUpdatedAtMs: asTimestamp(meta?.full_snapshot_updated_at_ms), providers };
    },
    replaceAll(hostId, providers, updatedAtMs) {
      database.transaction(() => {
        deleteProviders.run(hostId);
        for (const provider of providers) writeProvider.run(hostId, provider.id, JSON.stringify(provider), updatedAtMs);
        writeMeta.run(hostId, updatedAtMs);
      })();
    },
    update(hostId, providers, updatedAtMs) {
      database.transaction(() => {
        for (const provider of providers) writeProvider.run(hostId, provider.id, JSON.stringify(provider), updatedAtMs);
      })();
    },
  };
}

interface PanelHost {
  id: string;
  name: string;
  status: string;
}

interface PanelSnapshotReaderDependencies {
  cache: PanelCache;
  listHosts(): Promise<readonly PanelHost[]>;
  readHost(hostId: string, providerIds?: readonly string[]): Promise<ProviderSnapshot>;
  now(): number;
  isConfigured?(hostId: string): Promise<boolean>;
}

function panelProviders(record: PanelCacheRecord): PanelProvider[] {
  return record.providers.map(({ updatedAtMs, ...provider }) => ({ ...provider, updatedAt: new Date(updatedAtMs).toISOString() }));
}

function cachedMachine(host: PanelHost, record: PanelCacheRecord, error: string | null = null) {
  return { id: host.id, displayName: host.name, status: "connected" as const, providers: panelProviders(record), error };
}

export function createPanelSnapshotReader(deps: PanelSnapshotReaderDependencies) {
  return async (input: AccountLimitsPanelReadInput): Promise<AccountLimitsPanelSnapshot> => {
    const now = deps.now();
    const machines = await Promise.all((await deps.listHosts()).map(async host => {
      const record = deps.cache.read(host.id);
      if (host.status === "disconnected") {
        if (!record?.providers.length) return null;
        return { id: host.id, displayName: host.name, status: "disconnected" as const, providers: [], error: null };
      }
      try {
        if (deps.isConfigured && !await deps.isConfigured(host.id)) {
          deps.cache.replaceAll(host.id, [], now);
          return null;
        }
      } catch {
        // A host without this plugin or prior data is not an enrolled source.
        if (!record?.providers.length) return null;
        return cachedMachine(host, record, "此机器暂时不可用，正在显示缓存。");
      }
      const requestedProviderIds = input.force && input.providerIds ? input.providerIds : undefined;
      const shouldReadAll = !requestedProviderIds && (input.force === true
        || !record
        || record.providers.length === 0
        || record.fullSnapshotUpdatedAtMs === null
        || now - record.fullSnapshotUpdatedAtMs >= CLIPROXY_USAGE_CACHE_MAX_AGE_MS);
      if (!shouldReadAll && !requestedProviderIds && record) return cachedMachine(host, record);
      try {
        const snapshot = await deps.readHost(host.id, requestedProviderIds);
        const updatedAtMs = deps.now();
        if (shouldReadAll) deps.cache.replaceAll(host.id, snapshot.providers, updatedAtMs);
        else deps.cache.update(host.id, snapshot.providers, updatedAtMs);
        return cachedMachine(host, deps.cache.read(host.id)!);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取此机器的 Cliproxy 额度失败。";
        return record
          ? cachedMachine(host, record, `刷新失败，正在显示缓存：${message}`)
          : { id: host.id, displayName: host.name, status: "error" as const, providers: [], error: message };
      }
    }));
    return accountLimitsPanelSnapshotSchema.parse({ machines: machines.filter(machine => machine !== null) });
  };
}

export function registerCliproxyUsageRefreshSchedule(
  background: Pick<BbPluginApi["background"], "schedule">,
  refresh: (input: AccountLimitsPanelReadInput) => unknown,
) {
  background.schedule(CLIPROXY_USAGE_REFRESH_SCHEDULE_NAME, CLIPROXY_USAGE_REFRESH_CRON, async () => {
    await refresh({ force: true });
  });
}

export default function accountLimitsPlugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: accountLimitsHostContract });
  const rawDatabase = bb.storage.database();
  bb.storage.migrate(rawDatabase, [
    "CREATE TABLE IF NOT EXISTS cliproxy_usage_cache_hosts (host_id TEXT PRIMARY KEY, full_snapshot_updated_at_ms INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS cliproxy_usage_cache_providers (host_id TEXT NOT NULL, provider_id TEXT NOT NULL, provider_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (host_id, provider_id))",
  ]);
  const database = rawDatabase as unknown as SqliteDatabase;
  const panelCache = createSqlitePanelCache(database);
  const readHostUsage = (hostId: string, providerIds?: readonly string[]) =>
    host.call("readCliproxyUsage", providerIds ? { providerIds: [...providerIds] } : {}, { hostId });
  const readPanelSnapshot = createPanelSnapshotReader({
    cache: panelCache,
    listHosts: () => bb.sdk.hosts.list(),
    readHost: readHostUsage,
    isConfigured: async hostId => (await host.call("cliproxyStatus", {}, { hostId })).configured,
    now: () => Date.now(),
  });
  const readAccountPool = createAccountPoolPanelReader({
    listResources: () => bb.sdk.plugins.callRpc({
      pluginId: "account-pool", method: usageListMethod, input: {},
      outputSchema: usageSourceRpcContract[usageListMethod].output,
      signal: AbortSignal.timeout(45_000),
    }),
    getResource: (resourceId, refresh) => bb.sdk.plugins.callRpc({
      pluginId: "account-pool", method: usageFetchMethod, input: { resourceId, refresh },
      outputSchema: usageSourceRpcContract[usageFetchMethod].output,
      signal: AbortSignal.timeout(45_000),
    }),
  });
  const readAccountLimits = createQuotaReader([
    { id: "cliproxy", displayName: "CLI Proxy", read: readPanelSnapshot },
    { id: "account-pool", displayName: "BB Account Pooler",
      available: async () => (await bb.sdk.plugins.list()).plugins.some(plugin => plugin.id === "account-pool" && plugin.enabled),
      read: readAccountPool },
  ]);
  bb.rpc.register(accountLimitsPanelRpcContract, {
    readCliproxyUsage: readPanelSnapshot,
    readAccountLimits,
  });
  bb.rpc.register(
    usageSourceRpcContract,
    createCliproxyUsageSource({
      readCache: hostId => panelCache.read(hostId),
      updateCache: (hostId, providers, updatedAtMs) => panelCache.update(hostId, providers, updatedAtMs),
      listHosts: () => bb.sdk.hosts.list(),
      readHost: (hostId, providerIds) => readHostUsage(hostId, providerIds),
      now: () => Date.now(),
    }),
    {
      experimental_discoverable: true,
      experimental_description: "Cliproxy provider pools and per-account quota windows read through the local account-limits cache.",
    },
  );
  registerCliproxyUsageRefreshSchedule(bb.background, readPanelSnapshot);
  bb.cli.register({
    name: "account-limits",
    summary: "Read configured quota sources",
    commands: [{ name: "show", summary: "Read account limits", usage: "bb account-limits [--host <id>]" }],
    async run(argv) {
      if (argv.includes("--help")) return { exitCode: 0, stdout: "Usage: bb account-limits [--host <id>]\n" };
      if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--host")) {
        return { exitCode: 2, stderr: "Usage: bb account-limits [--host <id>]\n" };
      }
      const snapshot = await readAccountLimits({});
      const cliproxy = { machines: snapshot.machines.filter(machine => machine.source === "cliproxy" && (argv.length === 0 || machine.id === argv[1])) };
      const accountPool = { machines: snapshot.machines.filter(machine => machine.source === "account-pool") };
      return { exitCode: 0, stdout: JSON.stringify({ cliproxy, accountPool }, null, 2) + "\n" };
    },
  });
}
