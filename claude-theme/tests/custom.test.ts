import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrast, luminance, maxChroma, toOklch } from "../shared/color.ts";
import {
  accentLightness,
  contrastReport,
  CUSTOM_THEME_ID,
  customSpec,
  customTheme,
  DEFAULT_CUSTOM,
  FALLBACK_CUSTOM_NAME,
  matchingPreset,
  normalizeParams,
  paletteInUse,
  SURFACE_SWATCH_LIGHTNESS,
  stepParam,
  themeName,
  type CustomParams,
} from "../shared/custom.ts";
import { paletteFor, THEMES } from "../shared/palette.ts";

const HEX = /^#[0-9A-F]{6}$/;
const TOKENS = ["accent", "background", "border", "control", "foreground", "mutedForeground", "raised", "ring"];

// The custom slot reuses the family's recipe, so these are the same guarantees the fixed themes are tested for, over
// the whole range a user can reach with the sliders.
test("every reachable combination clears the 25-check matrix and keeps the family's hierarchy", () => {
  let combinations = 0;
  for (const appearance of ["dark", "light"] as const) {
    for (let surfaceHue = 0; surfaceHue < 360; surfaceHue += 30) {
      for (const surfaceTint of [0, 40, 80, 100]) {
        for (let accentHue = 0; accentHue < 360; accentHue += 30) {
          for (const accentVividness of [0, 50, 100]) {
            const params = { appearance, surfaceHue, surfaceTint, accentHue, accentVividness };
            const theme = customTheme(params, "x");
            const { colors } = theme;
            const label = JSON.stringify(params);
            const { checks, failed } = contrastReport(theme);
            assert.equal(checks.length, 25);
            assert.deepEqual(failed.map((check) => `${check.id} ${check.ratio.toFixed(2)}`), [], label);
            const ladder = [colors.background, colors.raised, colors.control, colors.border].map(luminance);
            for (let index = 1; index < ladder.length; index += 1) {
              assert.ok(appearance === "dark" ? ladder[index]! > ladder[index - 1]! : ladder[index]! < ladder[index - 1]!, `${label}: surface ${index} out of order`);
            }
            assert.ok(contrast(colors.foreground, colors.mutedForeground) >= 1.7, `${label}: secondary text too close to the main text`);
            // `ring` (timestamps, placeholders) stays softer than secondary text.
            if (appearance === "light") assert.ok(luminance(colors.ring) > luminance(colors.mutedForeground), label);
            else assert.ok(luminance(colors.ring) < luminance(colors.mutedForeground), label);
            combinations += 1;
          }
        }
      }
    }
  }
  assert.equal(combinations, 3456);
});

test("the twelve fixed themes keep their 0.5.1 colours", () => {
  const shipped = JSON.parse(readFileSync(new URL("./fixtures/presets-0.5.1.json", import.meta.url), "utf8")) as Record<string, unknown>;
  delete shipped.$comment;
  assert.deepEqual(Object.fromEntries(THEMES.map((theme) => [theme.id, theme.colors])), shipped);
});

test("the default is a vivid dark theme of its own", () => {
  const theme = customTheme(DEFAULT_CUSTOM, "x");
  assert.equal(theme.appearance, "dark");
  assert.deepEqual(contrastReport(theme).failed, []);
  assert.equal(matchingPreset(theme.colors), null);
  assert.ok(toOklch(theme.colors.accent!).c >= 0.15, `accent ${theme.colors.accent} is not vivid`);
  assert.ok(toOklch(theme.colors.border).c >= 0.03, `surfaces ${theme.colors.border} are not tinted`);
  // Pink: clear of the blue, amber, red and green that mean running, waiting, failed and done.
  const hue = toOklch(theme.colors.accent!).h;
  assert.ok(hue > 330 || hue < 5, `accent hue ${hue.toFixed(0)}`);
});

test("the contribution has the app's strict shape and the fixed id", () => {
  for (const appearance of ["dark", "light"] as const) {
    const theme = customTheme({ ...DEFAULT_CUSTOM, appearance }, "🎨 Custom");
    assert.deepEqual(Object.keys(theme).sort(), ["appearance", "colors", "id", "name"]);
    assert.equal(theme.id, CUSTOM_THEME_ID);
    assert.equal(theme.appearance, appearance);
    assert.deepEqual(Object.keys(theme.colors).sort(), TOKENS);
    for (const [token, value] of Object.entries(theme.colors)) assert.match(value, HEX, token);
  }
});

test("stored values are rounded into range, hues wrap, and anything unusable takes the default", () => {
  assert.deepEqual(normalizeParams(undefined), DEFAULT_CUSTOM);
  assert.deepEqual(normalizeParams({}), DEFAULT_CUSTOM);
  assert.deepEqual(normalizeParams("light"), DEFAULT_CUSTOM);
  assert.deepEqual(normalizeParams({ appearance: "light", surfaceHue: 725.4, surfaceTint: -3, accentHue: -10, accentVividness: 140 }), {
    appearance: "light",
    surfaceHue: 5,
    surfaceTint: 0,
    accentHue: 350,
    accentVividness: 100,
  });
  assert.deepEqual(normalizeParams({ appearance: "sepia", surfaceHue: "12", surfaceTint: Number.NaN, accentHue: null, accentVividness: Infinity }), DEFAULT_CUSTOM);
});

test("steppers move by 5, wrap hues and stop tint and vividness at their ends", () => {
  const base: CustomParams = { appearance: "dark", surfaceHue: 355, surfaceTint: 100, accentHue: 2, accentVividness: 0 };
  assert.equal(stepParam(base, "surfaceHue", 1).surfaceHue, 0);
  assert.equal(stepParam(base, "accentHue", -1).accentHue, 357);
  assert.equal(stepParam(base, "surfaceTint", 1).surfaceTint, 100);
  assert.equal(stepParam(base, "surfaceTint", -1).surfaceTint, 95);
  assert.equal(stepParam(base, "accentVividness", -1).accentVividness, 0);
  assert.equal(stepParam(base, "accentVividness", 1).accentVividness, 5);
});

test("dark accents sit where their hue is most colourful; light ones keep the recipe's lightness", () => {
  for (let hue = 0; hue < 360; hue += 10) {
    assert.equal(accentLightness("light", hue), undefined);
    const lightness = accentLightness("dark", hue)!;
    assert.ok(lightness >= 0.68 && lightness <= 0.82, `hue ${hue}: ${lightness}`);
    for (let other = 0.68; other <= 0.82; other += 0.01) {
      assert.ok(maxChroma(lightness, hue) >= maxChroma(other, hue) - 1e-3, `hue ${hue}: ${other.toFixed(2)} holds more chroma than ${lightness}`);
    }
  }
  // Yellow is bright at its most colourful, red and blue are deep.
  assert.equal(accentLightness("dark", 100), 0.82);
  assert.equal(accentLightness("dark", 25), 0.68);
  assert.equal(accentLightness("dark", 265), 0.68);
});

test("vividness scales the accent by what its hue can show, and tint scales the surfaces", () => {
  const grey = customSpec({ ...DEFAULT_CUSTOM, accentVividness: 0, surfaceTint: 0 });
  assert.equal(grey.accentChroma, 0);
  assert.equal(grey.surfaceChroma, 0);
  for (const accentHue of [30, 100, 160, 265]) {
    const full = customSpec({ ...DEFAULT_CUSTOM, accentHue, accentVividness: 100 });
    assert.ok(Math.abs(full.accentChroma - maxChroma(full.accentL!, accentHue)) < 1e-9);
    const half = customSpec({ ...DEFAULT_CUSTOM, accentHue, accentVividness: 50 });
    assert.ok(Math.abs(half.accentChroma * 2 - full.accentChroma) < 1e-9);
  }
  // The tint slider's strip is drawn at the recipe's border lightness.
  for (const appearance of ["dark", "light"] as const) {
    const spec = customSpec({ ...DEFAULT_CUSTOM, appearance, surfaceTint: 0 });
    assert.ok(Math.abs(toOklch(paletteFor(spec).border).l - SURFACE_SWATCH_LIGHTNESS[appearance]) < 0.003, appearance);
  }
});

test("theme names stay within the app's 1 to 60 characters", () => {
  assert.equal(themeName("🎨 Custom"), "🎨 Custom");
  assert.equal(themeName("   "), FALLBACK_CUSTOM_NAME);
  assert.equal(themeName("\u0007\n"), FALLBACK_CUSTOM_NAME);
  assert.equal(themeName("🎨\tMine"), "🎨 Mine");
  const long = themeName(`🎨 ${"x".repeat(80)}`);
  assert.ok(long.length <= 60 && long.length > 50);
  // Cutting never splits an emoji's surrogate pair.
  const emoji = themeName("🎨".repeat(40));
  assert.equal(emoji.length, 60);
  assert.equal(Array.from(emoji).length, 30);
  const offset = themeName(`x${"🎨".repeat(40)}`);
  assert.equal(offset, `x${"🎨".repeat(29)}`, "a pair cut in half loses its orphaned first half");
});

test("the slot counts as in use only when the app paints exactly its colours", () => {
  const colors = customTheme(DEFAULT_CUSTOM, "x").colors;
  const host = {
    surface0: colors.background.toLowerCase(),
    surface1: colors.raised,
    surface2: colors.control,
    border: colors.border,
    foreground: colors.foreground,
    foregroundMuted: colors.mutedForeground,
    accent: colors.accent!,
  };
  assert.equal(paletteInUse(host, colors), true);
  assert.equal(paletteInUse({ ...host, accent: "#000000" }, colors), false);
  assert.equal(matchingPreset(colors), null);
  const preset = THEMES[3]!;
  assert.equal(matchingPreset({ ...preset.colors }), preset.id);
});
