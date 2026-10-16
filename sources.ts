import { accountLimitsPanelSnapshotSchema, type AccountLimitsPanelReadInput, type AccountLimitsPanelSnapshot, type AccountLimitsReadInput, type QuotaSourceId } from "./contract.js";

/** Each adapter owns discovery, authentication and caching; the dashboard owns presentation. */
export interface QuotaSource {
  id: QuotaSourceId;
  displayName: string;
  available?(): Promise<boolean>;
  read(input: AccountLimitsPanelReadInput): Promise<AccountLimitsPanelSnapshot>;
}

export function createQuotaReader(sources: readonly QuotaSource[]) {
  return async ({ source, ...input }: AccountLimitsReadInput): Promise<AccountLimitsPanelSnapshot> => {
    const selected = sources.filter(adapter => !source || adapter.id === source);
    const results = await Promise.all(selected.map(async adapter => {
      try {
        if (adapter.available && !await adapter.available()) return [];
        const snapshot = await adapter.read(input);
        return snapshot.machines.map(machine => ({ ...machine, source: adapter.id }));
      } catch {
        return [{ id: `source:${adapter.id}`, source: adapter.id, displayName: adapter.displayName,
          status: "error" as const, providers: [], error: "读取此来源的额度失败，请重试。" }];
      }
    }));
    return accountLimitsPanelSnapshotSchema.parse({ machines: results.flat() });
  };
}
