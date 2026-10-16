import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client.tsx";
import { valuesCache } from "../client/sync.ts";
import { customColors, CUSTOM_THEME_ID, type CustomParams } from "../shared/custom.ts";
import { FIXED_THEMES } from "../shared/generated/themes.ts";
import { THEMES } from "../shared/palette.ts";
import { PLUGIN_ID } from "../shared/plugin-id.ts";
import { customThemeSettings } from "../shared/settings.ts";

const SAVED: CustomParams = { appearance: "light", surfaceHue: 150, surfaceTint: 45, accentHue: 330, accentVividness: 85 };
const LATER: CustomParams = { appearance: "dark", surfaceHue: 20, surfaceTint: 70, accentHue: 190, accentVividness: 95 };

const settle = async () => {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

// Each test starts like a fresh page: no copy kept from an earlier connection.
beforeEach(() => {
  (globalThis as { __paseoTerracottaCustomV1?: Map<string, unknown> }).__paseoTerracottaCustomV1?.clear();
});

/** The parts of the client context the resident stub touches, recording what it registers. */
function fakeClient(saved: CustomParams, options: { hangReads?: boolean } = {}) {
  let stored: CustomParams = saved;
  let revision = 1;
  const themes = new Map<string, PluginThemeContribution>();
  const screens = new Map<string, { title: string; icon: string }>();
  const commands = new Map<string, { title: string; onSelect(context: unknown): void }>();
  const observers = new Set<{ snapshot(): void; update(message: unknown): void }>();
  const requests: string[] = [];
  const opened: string[] = [];
  const track = <Value>(map: Map<string, Value>, id: string, value: Value) => {
    if (map.has(id)) throw new Error(`Duplicate: ${id}`);
    map.set(id, value);
    return () => void map.delete(id);
  };
  const client = {
    addTheme: (theme: PluginThemeContribution) => track(themes, theme.id, theme),
    addSettingsScreen: (screen: { id: string; title: string; icon: string }) => track(screens, screen.id, screen),
    addCommandCenterItem: (item: { id: string; title: string; onSelect(context: unknown): void }) => track(commands, item.id, item),
    rpc: async (contract: { name: string }) => {
      requests.push(contract.name);
      // Paseo parses the stored values with the plugin's schema on its server, which fills in the colours.
      if (contract.name === "settings.custom-theme.read" && !options.hangReads) return { status: "ready", revision: `r${revision}`, values: await customThemeSettings.schema.parseAsync(stored) };
      // The language catalog stays on the boot text here.
      return new Promise(() => undefined);
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
    themes,
    screens,
    commands,
    requests,
    opened,
    observers,
    /** Another device saves the custom theme. */
    saveElsewhere(next: CustomParams) {
      stored = next;
      revision += 1;
      for (const observer of observers) observer.update({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "terracotta-themes", settingsId: "custom-theme" } });
    },
  };
}

test("registers the twelve fixed themes and the custom slot with the host's saved colours", async () => {
  const fake = fakeClient(SAVED);
  const cleanup = contribute(fake.client);
  await settle();
  assert.deepEqual([...fake.themes.keys()], [...THEMES.map((theme) => theme.id), CUSTOM_THEME_ID]);
  for (const theme of THEMES) assert.deepEqual(fake.themes.get(theme.id), theme);
  assert.deepEqual(FIXED_THEMES, THEMES);
  const custom = fake.themes.get(CUSTOM_THEME_ID)!;
  assert.equal(custom.appearance, "light");
  assert.deepEqual(custom.colors, customColors(SAVED));
  // The boot text follows the device: English or Chinese.
  assert.ok(["🎨 Custom", "🎨 自定义"].includes(custom.name), custom.name);
  assert.deepEqual(fake.requests.filter((name) => name.startsWith("settings.")), ["settings.custom-theme.read"]);
  await cleanup();
});

test("after a reload the kept copy paints the custom theme before the host answers", async () => {
  // A web reload keeps the host's last copy in localStorage (memory here): the slot registers it with the fixed themes,
  // so a selected custom theme never shows the default palette first.
  valuesCache(PLUGIN_ID).set(await customThemeSettings.schema.parseAsync(SAVED));
  const fake = fakeClient(SAVED, { hangReads: true });
  const cleanup = contribute(fake.client);
  const custom = fake.themes.get(CUSTOM_THEME_ID);
  assert.ok(custom, "registered during contribute, not after a read");
  assert.equal(custom.appearance, "light");
  assert.deepEqual(custom.colors, customColors(SAVED));
  await cleanup();
});

test("without a kept copy it waits for the host rather than flashing the default palette", async () => {
  const fake = fakeClient(SAVED, { hangReads: true });
  const cleanup = contribute(fake.client);
  await settle();
  assert.equal(fake.themes.get(CUSTOM_THEME_ID), undefined);
  await cleanup();
});

test("adds the custom theme and language settings screens and a command to open the first", async () => {
  const fake = fakeClient(SAVED);
  const cleanup = contribute(fake.client);
  assert.deepEqual([...fake.screens.keys()], ["custom-theme", "language"]);
  assert.equal(fake.screens.get("custom-theme")!.icon, "Palette");
  assert.equal(fake.screens.get("language")!.icon, "Languages");
  const command = fake.commands.get("custom-theme")!;
  command.onSelect({ openSettings: (id: string) => fake.opened.push(id) });
  assert.deepEqual(fake.opened, ["custom-theme"]);
  // Opening nothing downloads nothing: the screens' code is a lazy chunk.
  assert.ok(!fake.requests.some((name) => name.includes("client-chunk")));
  await cleanup();
});

test("a change saved on another device replaces the custom theme under the same id", async () => {
  const fake = fakeClient(SAVED);
  const cleanup = contribute(fake.client);
  await settle();
  fake.saveElsewhere(LATER);
  await settle();
  const custom = fake.themes.get(CUSTOM_THEME_ID)!;
  assert.equal(custom.appearance, "dark");
  assert.deepEqual(custom.colors, customColors(LATER));
  assert.equal([...fake.themes.keys()].filter((id) => id === CUSTOM_THEME_ID).length, 1);
  await cleanup();
});

test("cleanup removes everything it registered and stops listening", async () => {
  const fake = fakeClient(SAVED);
  const cleanup = contribute(fake.client);
  await settle();
  await cleanup();
  assert.equal(fake.themes.size, 0);
  assert.equal(fake.screens.size, 0);
  assert.equal(fake.commands.size, 0);
  assert.equal(fake.observers.size, 0);
});
