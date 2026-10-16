import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QUICK_SETTINGS_ID, quickEntries, quickSettingsRpc, type QuickEntry } from "../shared/quick";

/** The quick prompt list (一键发送) as one live copy for the pills and the board. */
export interface QuickStore {
  /** Every entry, hidden ones included, in pill order. */
  entries(): QuickEntry[];
  /** The setting's revision (for saving), null before the first read. */
  revision(): string | null;
  ready(): boolean;
  subscribe(listener: () => void): () => void;
  version(): number;
  /** A save answered with these values: use them now (the host's change event re-reads them anyway). */
  adopt(values: unknown, revision: string): void;
  refresh(): Promise<void>;
  dispose(): void;
}

type Observer = (events: ["status.plugin_settings_changed"], options: { signal: AbortSignal }) => {
  subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void; release(): Promise<void>;
};
const isQuickChange = (message: unknown) => {
  const { type, payload } = (message ?? {}) as { type?: unknown; payload?: { status?: unknown; settingsId?: unknown } | null };
  return type === "status" && payload?.status === "plugin_settings_changed" && payload.settingsId === QUICK_SETTINGS_ID;
};

/**
 * Reads the setting after every (re)connect and whenever any app changes it (the host's settings event), so pills follow
 * an edit on another device at once without polling. Reads that overlap answer in order: only the last one counts.
 */
export function createQuickStore(client: Pick<PluginClientContext, "paseo" | "rpc">): QuickStore {
  let list: QuickEntry[] = [], revision: string | null = null, loaded = false, changes = 0, reads = 0, stopped = false;
  const listeners = new Set<() => void>(), lifetime = new AbortController();
  const publish = (values: unknown, next: string) => {
    const entries = quickEntries(values);
    if (loaded && next === revision && JSON.stringify(entries) === JSON.stringify(list)) return;
    list = entries; revision = next; loaded = true; changes++;
    for (const listener of [...listeners]) { try { listener(); } catch { /* One view's failure must not stop the others. */ } }
  };
  const refresh = async () => {
    const ticket = ++reads;
    try {
      const result = await client.rpc(quickSettingsRpc.read, {});
      if (stopped || ticket !== reads) return;
      // An unreadable file counts as an empty list; saving replaces it with a valid one.
      publish(result.status === "ready" ? result.values : {}, result.revision);
    } catch { /* Offline or reloading: the next connect reads again. */ }
  };
  let release = () => {};
  const observe = (client.paseo as { observeEvents?: unknown }).observeEvents;
  if (typeof observe === "function") {
    try {
      const observation = (observe as Observer).call(client.paseo, ["status.plugin_settings_changed"], { signal: lifetime.signal });
      const unsubscribe = observation.subscribe({ snapshot: () => void refresh(), update: message => { if (isQuickChange(message)) void refresh(); }, error: () => undefined });
      release = () => { unsubscribe(); void observation.release().catch(() => undefined); };
    } catch { void refresh(); }
  } else void refresh();
  return {
    entries: () => list,
    revision: () => revision,
    ready: () => loaded,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => changes,
    adopt(values, next) { reads++; publish(values, next); },
    refresh,
    dispose() { stopped = true; lifetime.abort(); release(); listeners.clear(); },
  };
}
