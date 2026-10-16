import { test } from "node:test";
import assert from "node:assert/strict";
import { customColors, customPalette, DEFAULT_CUSTOM } from "../shared/custom.ts";
import { DEFAULT_PALETTE } from "../shared/generated/themes.ts";
import { customThemeRpc as contractRpc, readPalette } from "../shared/params.ts";
import { customThemeRpc, customThemeSettings } from "../shared/settings.ts";

// Paseo keeps host settings in `$PASEO_HOME/plugin-settings/<plugin id>/<settings id>.json`, parses them with the
// plugin's schema on every read and write (on the plugin's server), and answers `invalid` when parsing fails. The custom
// theme must keep working with whatever is in that file, so its schema repairs values instead of rejecting them, and it
// computes the palette there, so clients receive ready colours.

test("the custom theme is a host setting, so every device of a host shares it", () => {
  assert.equal(customThemeSettings.id, "custom-theme");
  assert.equal(customThemeSettings.scope, "host");
  assert.equal(customThemeSettings.version, 1);
  assert.equal(customThemeRpc.read.name, "settings.custom-theme.read");
  assert.equal(customThemeRpc.write.name, "settings.custom-theme.write");
  assert.equal(customThemeRpc.reset.name, "settings.custom-theme.reset");
  assert.equal(customThemeRpc, contractRpc, "the resident stub calls the same contract without loading the schema");
});

test("a missing file reads as the default palette", async () => {
  // Paseo parses `{}` when the file does not exist yet.
  const parsed = await customThemeSettings.schema.parseAsync({});
  assert.deepEqual(parsed, { ...DEFAULT_CUSTOM, colors: customColors(DEFAULT_CUSTOM) });
  assert.deepEqual(readPalette(parsed), DEFAULT_PALETTE);
});

test("the server computes the palette clients register", async () => {
  for (const params of [
    { appearance: "light", surfaceHue: 120, surfaceTint: 35, accentHue: 300, accentVividness: 90 },
    { appearance: "dark", surfaceHue: 0, surfaceTint: 0, accentHue: 0, accentVividness: 0 },
    { appearance: "dark", surfaceHue: 359, surfaceTint: 100, accentHue: 359, accentVividness: 100 },
  ] as const) {
    assert.deepEqual(readPalette(await customThemeSettings.schema.parseAsync(params)), customPalette(params));
  }
});

test("hand-edited or damaged values are repaired, never rejected; stored colours are ignored", async () => {
  const parsed = await customThemeSettings.schema.parseAsync({
    appearance: "sepia",
    surfaceHue: 725.4,
    surfaceTint: -3,
    accentHue: "12",
    accentVividness: 140,
    colors: { background: "#000000" },
    extra: true,
  });
  const params = { appearance: DEFAULT_CUSTOM.appearance, surfaceHue: 5, surfaceTint: 0, accentHue: DEFAULT_CUSTOM.accentHue, accentVividness: 100 };
  assert.deepEqual(parsed, { ...params, colors: customColors(params) });
  assert.deepEqual(await customThemeSettings.schema.parseAsync(null).catch(() => "rejected"), "rejected", "the envelope itself must be an object");
});

test("what is written reads back the same, as plain JSON", async () => {
  const values = { appearance: "light", surfaceHue: 120, surfaceTint: 35, accentHue: 300, accentVividness: 90 } as const;
  const written = await customThemeSettings.schema.parseAsync(values);
  // Paseo stores `z.json().parse(parsed)` and parses it again on the next read.
  const stored = JSON.parse(JSON.stringify({ version: customThemeSettings.version, values: written }));
  assert.deepEqual(stored.values, written);
  assert.deepEqual(await customThemeSettings.schema.parseAsync(stored.values), written);
});
