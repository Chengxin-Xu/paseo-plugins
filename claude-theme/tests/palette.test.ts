import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, luminance } from "../shared/color.ts";
import { THEMES } from "../shared/palette.ts";

const HEX = /^#[0-9A-F]{6}$/;

// Clients save a choice as "<plugin id>/theme/<theme id>", so an id that changes silently
// drops everyone who picked that theme back to the default. Display names may change; ids may not.
test("registers the whole family under its saved ids", () => {
  assert.deepEqual(
    THEMES.map((theme) => theme.id),
    ["claude-code-dark", "claude-code-light", "cocoa-night", "blueberry-night", "sakura-latte", "matcha-latte"],
  );
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
  assert.equal(THEMES.filter((theme) => theme.appearance === "dark").length, 3);
  assert.equal(THEMES.filter((theme) => theme.appearance === "light").length, 3);
});

// The palettes are generated, so this is the guard that the recipe still lands on the values
// extracted from the Claude Code CLI rather than drifting when a constant is tweaked.
test("the recipe still reproduces the CLI's dark palette", () => {
  const dark = THEMES.find((theme) => theme.id === "claude-code-dark")?.colors;
  assert.deepEqual(dark, {
    background: "#1A1A1A",
    raised: "#262626", // composerSidebarBackground
    control: "#373737", // userMessageBackground
    border: "#505050", // subtle
    foreground: "#FFFFFF", // text
    mutedForeground: "#999999", // inactive
    ring: "#888888", // promptBorder
    accent: "#D77757", // claude
  });

  const blueberry = THEMES.find((theme) => theme.id === "blueberry-night")?.colors;
  assert.equal(blueberry?.accent, "#B1B9F9", "should be the CLI's permission lavender");
});

// The listing is unofficial, so no theme may be named after Anthropic's products.
test("display names stay clear of the Claude and Anthropic names", () => {
  assert.deepEqual(
    THEMES.map((theme) => theme.name),
    ["🌑 Charcoal Night", "☁️ Oat Latte", "🍫 Cocoa Night", "🫐 Blueberry Night", "🌸 Sakura Latte", "🍵 Matcha Latte"],
  );
  for (const { name } of THEMES) assert.doesNotMatch(name, /claude|anthropic/i);
});

const TOKENS = ["accent", "background", "border", "control", "foreground", "mutedForeground", "raised", "ring"];

for (const theme of THEMES) {
  const { name, appearance, colors } = theme;
  // The app validates contributions with a strict schema (Paseo 0.11): no extra keys, a
  // trimmed name of 1 to 60 characters, and hex colours. One bad field drops the theme.
  test(`${name} matches the app's theme schema`, () => {
    assert.deepEqual(Object.keys(theme).sort(), ["appearance", "colors", "id", "name"]);
    assert.deepEqual(Object.keys(colors).sort(), TOKENS);
    assert.equal(name, name.trim());
    assert.ok(name.length >= 1 && name.length <= 60, `name is ${name.length} characters`);
    for (const [token, value] of Object.entries(colors)) {
      assert.match(value, HEX, `${token} is not #RRGGBB`);
    }
  });

  // Accent and muted text land on cards as often as on the page, so both surfaces must clear AA.
  test(`${name} keeps text legible on its own surfaces`, () => {
    assert.ok(contrast(colors.foreground, colors.background) >= 7, "body text below 7:1");
    for (const surface of [colors.background, colors.raised]) {
      assert.ok(contrast(colors.mutedForeground, surface) >= 4.5, `muted text below 4.5:1 on ${surface}`);
      assert.ok(contrast(colors.accent!, surface) >= 4.5, `accent below 4.5:1 on ${surface}`);
    }
  });

  // background → raised → control → border must step steadily away from the page so
  // cards, inputs and borders stay distinguishable once Paseo expands the palette.
  test(`${name} stacks its surfaces in one direction`, () => {
    const ladder = [colors.background, colors.raised, colors.control, colors.border].map(luminance);
    for (let index = 1; index < ladder.length; index += 1) {
      const previous = ladder[index - 1]!;
      const current = ladder[index]!;
      if (appearance === "dark") assert.ok(current > previous, `step ${index} does not brighten`);
      else assert.ok(current < previous, `step ${index} does not darken`);
    }
  });

  test(`${name} is named with a leading emoji`, () => {
    assert.match(name, /^\p{Extended_Pictographic}/u, "themes are listed by emoji in Settings → Appearance");
  });
}

// One perceptual ladder for every theme means legibility should not wander across the family.
test("the family reads consistently whatever the hue", () => {
  for (const appearance of ["dark", "light"] as const) {
    const family = THEMES.filter((theme) => theme.appearance === appearance);
    const ratios = family.map(({ colors }) => contrast(colors.mutedForeground, colors.background));
    const spread = Math.max(...ratios) - Math.min(...ratios);
    assert.ok(spread < 0.25, `${appearance} muted contrast varies by ${spread.toFixed(2)} across the family`);
  }
});
