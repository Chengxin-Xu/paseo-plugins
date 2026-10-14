import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, luminance } from "../shared/color.ts";
import { THEMES, evaluateThemeContrast, resolveHostSurfaces } from "../shared/palette.ts";

const HEX = /^#[0-9A-F]{6}$/;

// Clients save a choice as "<plugin id>/theme/<theme id>", so an id that changes silently
// drops everyone who picked that theme back to the default. Display names may change; ids may not.
test("registers the whole family under its saved ids", () => {
  assert.deepEqual(
    THEMES.map((theme) => theme.id),
    [
      "claude-code-dark",
      "claude-code-light",
      "cocoa-night",
      "blueberry-night",
      "sakura-latte",
      "matcha-latte",
      "harbor-night",
      "glacier-latte",
      "velvet-night",
      "orchid-latte",
      "lagoon-night",
      "lagoon-latte",
    ],
  );
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
  assert.equal(THEMES.filter((theme) => theme.appearance === "dark").length, 6);
  assert.equal(THEMES.filter((theme) => theme.appearance === "light").length, 6);
});

// The palettes are generated, so this is the guard that the recipe still lands on the values
// extracted from the Claude Code CLI rather than drifting when a constant is tweaked.
test("the recipe still reproduces the CLI's dark palette", () => {
  const dark = THEMES.find((theme) => theme.id === "claude-code-dark")?.colors;
  assert.deepEqual(dark, {
    background: "#1A1A1A",
    raised: "#262626", // composerSidebarBackground
    control: "#373737", // surface2 (inputs, dark popover, dark selected sidebar)
    border: "#505050", // subtle / surface3 (user message bubble)
    foreground: "#FFFFFF", // text
    // The CLI's inactive is #999999, but Paseo's status badges put muted 12px text on surface3 (#505050), where it is
    // only ~2.8:1. It is lifted until it clears the 4.1:1 chrome floor there, about what Paseo's own dark theme gives.
    mutedForeground: "#B9B9B9", // inactive (lifted)
    // The CLI's promptBorder is #888888, but Paseo paints `ring` as timestamp / header text on the dark workspace
    // (`raised`), where #888888 is only ~4.3:1. It is lifted the least amount that clears 4.5:1 there.
    ring: "#8C8C8C", // promptBorder (lifted) / foregroundExtraMuted / terminal.brightBlack
    accent: "#D77757", // claude
  });

  const blueberry = THEMES.find((theme) => theme.id === "blueberry-night")?.colors;
  assert.equal(blueberry?.accent, "#B1B9F9", "should be the CLI's permission lavender");
});

// The listing is unofficial, so no theme may be named after Anthropic's products.
test("display names stay clear of the Claude and Anthropic names", () => {
  assert.deepEqual(
    THEMES.map((theme) => theme.name),
    [
      "🌑 Charcoal Night",
      "☁️ Oat Latte",
      "🍫 Cocoa Night",
      "🫐 Blueberry Night",
      "🌸 Sakura Latte",
      "🍵 Matcha Latte",
      "⚓ Harbor Night",
      "🧊 Glacier Latte",
      "🔮 Velvet Night",
      "🌺 Orchid Latte",
      "🐬 Lagoon Night",
      "🌊 Lagoon Latte",
    ],
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

  // Models Paseo 0.11.1's real surface expansion (`buildLightSemanticColors` / `buildDarkSemanticColors`): every text
  // token on every surface the host paints it on.
  //   - workspace (page in light themes, `raised` in dark ones): foreground ≥ 7, muted / ring / accent ≥ 4.5;
  //   - sidebar, popovers, inputs: foreground ≥ 7, muted ≥ 4.1, ring ≥ 3.3, accent ≥ 3.7;
  //   - selected sidebar row (`border` in light themes, `control` in dark ones): foreground ≥ 7, muted ≥ 4.1,
  //     ring ≥ 3.3, accent ≥ 3.5;
  //   - status badges (muted 12px text on surface3 = `border`): muted ≥ 4.1;
  //   - user bubble: foreground ≥ 7; terminal: foreground ≥ 7, ring (brightBlack) ≥ 4.5;
  //   - `accentForeground` (`background`) on the accent primary button ≥ 4.5.
  // Below the workspace, muted and ring floors are deliberate compromises under the 4.5:1 that WCAG AA asks of small
  // text: at 4.5:1 the extra-muted timestamps would match muted text and the hierarchy would flatten.
  test(`${name} clears the Paseo 0.11 host surface contrast matrix`, () => {
    const host = resolveHostSurfaces(theme);
    assert.equal(host.surfaceSidebar, appearance === "light" ? colors.control : colors.background);
    assert.equal(host.surfaceWorkspace, appearance === "light" ? colors.background : colors.raised);
    assert.equal(host.userBubble, colors.border);
    assert.equal(host.foregroundExtraMuted, colors.ring);
    assert.equal(host.surface4, colors.ring);
    assert.equal(host.terminalBrightBlack, colors.ring);

    const checks = evaluateThemeContrast(theme);
    assert.equal(checks.length, 25);
    for (const check of checks) {
      assert.ok(
        check.pass,
        `${name} failed ${check.id} (${check.label}): ${check.ratio.toFixed(2)}:1 < ${check.minRatio}:1 (${check.foreground} on ${check.surface})`,
      );
    }

    // Light themes keep `ring` (extraMuted / placeholder) slightly lighter than `mutedForeground`
    // while still clearing ≥4.5:1 on `background` and ≥3.8:1 on `control`.
    // The gaps the 10-12 reviews found: ring on the dark workspace, muted text on the light selected row and on the
    // status badges (surface3) in every theme.
    if (appearance === "dark") assert.ok(contrast(colors.ring, colors.raised) >= 4.5, `${name} dark ring on the workspace below 4.5:1`);
    assert.ok(contrast(colors.mutedForeground, colors.border) >= 4.1, `${name} muted text on a status badge below 4.1:1`);
    // Muted text stays visibly secondary to the main text.
    assert.ok(contrast(colors.foreground, colors.mutedForeground) >= 1.7, `${name} muted text too close to the main text`);
    if (appearance === "light") {
      assert.ok(contrast(colors.ring, colors.background) >= 4.5, `${name} light ring on background below 4.5:1`);
      assert.ok(contrast(colors.ring, colors.raised) >= 4.1, `${name} light ring on raised below 4.1:1`);
      assert.ok(contrast(colors.ring, colors.control) >= 3.8, `${name} light ring on control below 3.8:1`);
      assert.ok(luminance(colors.ring) > luminance(colors.mutedForeground), `${name} ring should stay softer than mutedForeground`);
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
    const spread = (Math.max(...ratios) - Math.min(...ratios)) / (ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length);
    assert.ok(spread < 0.05, `${appearance} muted contrast varies by ${(spread * 100).toFixed(1)}% across the family`);
  }
});
