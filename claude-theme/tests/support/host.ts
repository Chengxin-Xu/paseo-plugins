import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CUSTOM_THEME_ID, type CustomParams } from "../../shared/params.ts";
import { customThemeRpc, customThemeSettings } from "../../shared/settings.ts";

/** Lets every pending promise chain run; the fakes below never touch real I/O. */
export const settle = async () => {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Paseo's settings store as plugins see it: a revision per write, stale revisions refused, and values parsed by the
 * plugin's schema on the plugin's server, which is where `colors` gets filled in.
 */
export function hostStore(initial?: CustomParams) {
  let revision = initial ? "r0" : "missing";
  let values: unknown = initial ? { ...initial } : undefined;
  let counter = 0;
  const store = {
    reads: 0,
    writes: [] as unknown[],
    resets: 0,
    failReads: false,
    failWrites: false,
    /** Reads never answer. */
    hangReads: false,
    /** A file the schema cannot take (one written by a newer plugin version). */
    unreadable: false,
    /** While set, writes wait for `release()`. */
    held: null as null | { release(): void; wait: Promise<void> },
    async read() {
      store.reads += 1;
      if (store.hangReads) return new Promise<never>(() => undefined);
      if (store.failReads) throw new Error("host unreachable");
      if (store.unreadable) return { status: "invalid" as const, revision, error: "Settings were saved by a newer plugin version" };
      return { status: "ready" as const, revision, values: await customThemeSettings.schema.parseAsync(values ?? {}) };
    },
    async write(input: { revision: string; values: unknown }) {
      store.writes.push(input.values);
      if (store.held) await store.held.wait;
      if (store.failWrites) throw new Error("socket closed");
      if (input.revision !== revision) return { status: "conflict" as const, error: "Settings changed on another client. Reload before saving again." };
      if (store.unreadable) return { status: "invalid" as const, error: "Reload or reset settings before saving a different schema version" };
      values = await customThemeSettings.schema.parseAsync(input.values);
      revision = `r${++counter}`;
      return { status: "saved" as const, revision, values };
    },
    async reset(input: { revision: string }) {
      store.resets += 1;
      if (input.revision !== revision) return { status: "conflict" as const, error: "conflict" };
      store.unreadable = false;
      values = await customThemeSettings.schema.parseAsync({});
      revision = `r${++counter}`;
      return { status: "saved" as const, revision, values };
    },
    /** Another device saves. */
    external(next: CustomParams) {
      values = { ...next };
      revision = `r${++counter}`;
    },
    hold() {
      let release = () => undefined as void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.held = {
        release: () => {
          store.held = null;
          release();
        },
        wait,
      };
    },
  };
  return store;
}

/** What the host's settings would hold for `params`: the parameters plus the colours the server computes. */
export const hostValues = (params: CustomParams) => customThemeSettings.schema.parseAsync({ ...params });

/** The app's theme registry: one theme per id, as Paseo enforces ("Duplicate theme"). */
export function registry() {
  const themes = new Map<string, PluginThemeContribution>();
  const log: string[] = [];
  return {
    themes,
    log,
    addTheme(theme: PluginThemeContribution) {
      if (themes.has(theme.id)) throw new Error(`Duplicate theme: ${theme.id}`);
      themes.set(theme.id, theme);
      log.push(`add ${theme.name}`);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        themes.delete(theme.id);
        log.push("remove");
      };
    },
    current: () => themes.get(CUSTOM_THEME_ID),
  };
}

/** The parts of the client context the slot and the settings screen use: theme registration, the setting's calls and its change events. */
export function fakeClient(store: ReturnType<typeof hostStore>, app: ReturnType<typeof registry>) {
  const observers = new Set<{ snapshot(): void; update(message: unknown): void }>();
  const client = {
    addTheme: (theme: PluginThemeContribution) => app.addTheme(theme),
    rpc(contract: unknown, input: never) {
      if (contract === customThemeRpc.read) return store.read();
      if (contract === customThemeRpc.write) return store.write(input);
      if (contract === customThemeRpc.reset) return store.reset(input);
      throw new Error(`unexpected call ${(contract as { name?: string }).name}`);
    },
    paseo: {
      observeEvents: () => ({
        subscribe(observer: { snapshot(): void; update(message: unknown): void }) {
          observers.add(observer);
          return () => void observers.delete(observer);
        },
        release: async () => undefined,
      }),
    },
  } as unknown as PluginClientContext;
  return {
    client,
    observers,
    /** The host announces that the setting changed (on any device). */
    changed() {
      for (const observer of Array.from(observers)) observer.update({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "any", settingsId: "custom-theme" } });
    },
  };
}
