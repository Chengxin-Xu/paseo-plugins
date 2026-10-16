import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { isSettingsChange, valuesCache, watchSetting } from "../client/sync.ts";

const VALUES = { appearance: "light", surfaceHue: 300, surfaceTint: 30, accentHue: 20, accentVividness: 70, colors: { background: "#FFF7F8" } };

test("the copy lives in memory for reconnects and in localStorage where there is one", (t) => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => void store.set(name, value) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const first = valuesCache("sync-test-a");
  assert.equal(first.get(), null);
  first.set(VALUES);
  assert.deepEqual(JSON.parse(store.get("paseo-terracotta-custom-v1:sync-test-a")!), VALUES);
  assert.deepEqual(valuesCache("sync-test-a").get(), VALUES, "another connection of the same app finds it");

  // A web reload starts with empty memory and reads storage; the slot checks what it gets (`readPalette`).
  store.set("paseo-terracotta-custom-v1:sync-test-b", JSON.stringify(VALUES));
  assert.deepEqual(valuesCache("sync-test-b").get(), VALUES);
  store.set("paseo-terracotta-custom-v1:sync-test-c", "{not json");
  assert.equal(valuesCache("sync-test-c").get(), undefined);
});

test("blocked storage leaves memory working", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  const cache = valuesCache("sync-test-blocked");
  assert.equal(cache.get(), undefined);
  cache.set(VALUES);
  assert.deepEqual(valuesCache("sync-test-blocked").get(), VALUES);
});

test("without storage (the phone app) the copy still survives in memory", () => {
  const cache = valuesCache("sync-test-memory");
  cache.set(VALUES);
  assert.deepEqual(valuesCache("sync-test-memory").get(), VALUES);
});

test("only this setting's change events count", () => {
  const event = (settingsId: unknown, status = "plugin_settings_changed") => ({ type: "status", payload: { status, pluginId: "any", settingsId } });
  assert.equal(isSettingsChange(event("custom-theme"), "custom-theme"), true);
  assert.equal(isSettingsChange(event("language"), "custom-theme"), false);
  assert.equal(isSettingsChange(event("custom-theme", "plugin_catalog_changed"), "custom-theme"), false);
  assert.equal(isSettingsChange({ type: "agent_update", payload: {} }, "custom-theme"), false);
  assert.equal(isSettingsChange(null, "custom-theme"), false);
});

test("watching follows changes and reconnects, skips the snapshot that comes with subscribing, and cleans up", () => {
  let observer: { snapshot(): void; update(message: unknown): void } | null = null;
  let released = 0;
  let signal: AbortSignal | null = null;
  const client = {
    paseo: {
      observeEvents(events: string[], options: { signal: AbortSignal }) {
        assert.deepEqual(events, ["status.plugin_settings_changed"]);
        signal = options.signal;
        return {
          subscribe(next: typeof observer) {
            observer = next;
            return () => {
              observer = null;
            };
          },
          release: async () => {
            released += 1;
          },
        };
      },
    },
  } as unknown as PluginClientContext;
  let calls = 0;
  const stop = watchSetting(client, "custom-theme", () => {
    calls += 1;
  });
  observer!.snapshot();
  assert.equal(calls, 0, "the start reads anyway");
  observer!.snapshot();
  assert.equal(calls, 1, "a reconnect may have missed a change");
  observer!.update({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "x", settingsId: "language" } });
  assert.equal(calls, 1);
  observer!.update({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "x", settingsId: "custom-theme" } });
  assert.equal(calls, 2);
  stop();
  assert.equal(observer, null);
  assert.equal(released, 1);
  assert.equal(signal!.aborted, true);
});

test("hosts without event observation only miss live updates", () => {
  const stop = watchSetting({ paseo: {} } as unknown as PluginClientContext, "custom-theme", () => assert.fail("no events"));
  stop();
  const broken = { paseo: { observeEvents: () => { throw new Error("unsupported"); } } } as unknown as PluginClientContext;
  watchSetting(broken, "custom-theme", () => assert.fail("no events"))();
});
