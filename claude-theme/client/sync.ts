import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ValuesCache } from "./slot.ts";

/**
 * Where the host's copy of the custom theme (parameters and computed colours) waits between connections. Memory
 * survives a reconnect within one app session; web and desktop also keep it in localStorage, so a page reload paints
 * the custom theme as soon as the plugin loads, before the first read returns. The phone app has no storage for
 * plugins and reads the host's copy instead. The slot checks what comes back (`readPalette`) before using it.
 */
const MEMORY_KEY = "__paseoTerracottaCustomV1";
const STORAGE_PREFIX = "paseo-terracotta-custom-v1:";
const memoryStore = globalThis as unknown as Record<string, Map<string, unknown> | undefined>;
const memory = memoryStore[MEMORY_KEY] ?? (memoryStore[MEMORY_KEY] = new Map<string, unknown>());

interface TextStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

export function valuesCache(pluginId: string): ValuesCache {
  const name = STORAGE_PREFIX + pluginId;
  // Reading `localStorage` throws where storage is blocked; the phone app has none. Either way memory remains.
  const storage = () => (globalThis as { localStorage?: TextStorage }).localStorage;
  return {
    get() {
      try {
        if (!memory.has(name)) memory.set(name, JSON.parse(storage()?.getItem(name) ?? "null"));
      } catch {
        // An unreadable copy is no copy.
      }
      return memory.get(name);
    },
    set(values) {
      memory.set(name, values);
      try {
        storage()?.setItem(name, JSON.stringify(values));
      } catch {
        // Full or blocked storage only costs the next reload the wait for the host.
      }
    },
  };
}

type SettingsObserver = (
  events: ["status.plugin_settings_changed"],
  options: { signal: AbortSignal },
) => { subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void; release(): Promise<void> };

export function isSettingsChange(message: unknown, settingsId: string): boolean {
  const { type, payload } = (message ?? {}) as { type?: unknown; payload?: { status?: unknown; settingsId?: unknown } | null };
  // The event names the installed plugin id, which a plugin cannot know for sure; a stray match costs one read.
  return type === "status" && payload?.status === "plugin_settings_changed" && payload.settingsId === settingsId;
}

/**
 * Calls `changed` when `settingsId` changes on any device of this host, and after every reconnect (a change may have
 * been missed meanwhile). The first snapshot arrives with the subscription, when the caller reads anyway: skipped.
 * One event subscription, no polling.
 */
export function watchSetting(client: PluginClientContext, settingsId: string, changed: () => void): () => void {
  const lifetime = new AbortController();
  let snapshots = 0;
  try {
    const paseo = client.paseo as unknown as { observeEvents: SettingsObserver };
    const observation = paseo.observeEvents(["status.plugin_settings_changed"], { signal: lifetime.signal });
    const unsubscribe = observation.subscribe({
      snapshot: () => void (snapshots++ && changed()),
      update: (message) => void (isSettingsChange(message, settingsId) && changed()),
      error: () => undefined,
    });
    return () => {
      unsubscribe();
      lifetime.abort();
      void observation.release().catch(() => undefined);
    };
  } catch {
    // A host without event observation only misses live updates.
    lifetime.abort();
    return () => undefined;
  }
}
