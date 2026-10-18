import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { accountLimitsPanelRpcContract, type AccountLimitsReadInput } from "./contract.js";
import type { QuotaUiStore } from "./quota-presentation.js";

const preferenceEvent = "account-limits:preferences";
const fallback = new Map<string, string>();
function useStoredQuotaPreference(name: string, initial: string): [string, (next: string) => void] {
  const key = `account-limits.${name}`;
  const subscribe = useCallback((listener: () => void) => {
    window.addEventListener("storage", listener);
    window.addEventListener(preferenceEvent, listener);
    return () => { window.removeEventListener("storage", listener); window.removeEventListener(preferenceEvent, listener); };
  }, []);
  const get = useCallback(() => {
    if (fallback.has(key)) return fallback.get(key)!;
    try { const value = window.localStorage.getItem(key); return value ?? initial; }
    catch { return fallback.get(key) ?? initial; }
  }, [key, initial]);
  const value = useSyncExternalStore(subscribe, get, () => initial);
  const change = useCallback((next: string) => {
    try { window.localStorage.setItem(key, String(next)); fallback.delete(key); }
    catch { fallback.set(key, String(next)); }
    window.dispatchEvent(new window.Event(preferenceEvent));
  }, [key]);
  return [value, change];
}

export function useQuotaPreference(name: string, initial = true): [boolean, (next: boolean) => void] {
  const [value, setValue] = useStoredQuotaPreference(name, String(initial));
  return [value !== "false", useCallback((next: boolean) => setValue(String(next)), [setValue])];
}

export function useQuotaChoicePreference<T extends string>(name: string, initial: T, choices: readonly T[]): [T, (next: T) => void] {
  const [value, setValue] = useStoredQuotaPreference(name, initial);
  return [choices.includes(value as T) ? value as T : initial, setValue];
}

export function useQuotaData(store: QuotaUiStore) {
  const rpc = useRpc<typeof accountLimitsPanelRpcContract>();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const refresh = useCallback((input: AccountLimitsReadInput = {}) => store.refresh(value => rpc.call("readAccountLimits", value), input), [store, rpc]);
  useEffect(() => { if (!store.getSnapshot().snapshot) void refresh(); }, [store, refresh]);
  return { ...state, refresh };
}
