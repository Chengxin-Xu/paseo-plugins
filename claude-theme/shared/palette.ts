import type { PluginThemeColors, PluginThemeContribution } from "@getpaseo/plugin";
import { oklch } from "./color.ts";

/**
 * Every palette here is derived, not hand-picked.
 *
 * The tonal skeleton below was measured from the theme object built into the Claude Code CLI
 * (2.1.263); see README for the token-by-token mapping. Feeding it a zero chroma reproduces
 * that dark palette byte for byte, so the rest of the family is literally the same theme at a
 * different hue: identical surface depth, identical text legibility, only the colour changes.
 */
interface Recipe {
  /** OKLCH lightness for background → raised → control → border. */
  readonly surfaceL: readonly [number, number, number, number];
  /** Share of `surfaceChroma` each surface carries. Deeper surfaces hold more colour. */
  readonly surfaceC: readonly [number, number, number, number];
  readonly foregroundL: number;
  readonly foregroundC: number;
  readonly mutedL: number;
  readonly mutedC: number;
  readonly ringL: number;
  readonly ringC: number;
  readonly accentL: number;
}

const DARK: Recipe = {
  surfaceL: [0.218, 0.269, 0.337, 0.431], // #1A1A1A #262626 #373737 #505050
  surfaceC: [0.45, 0.65, 0.85, 1.0],
  foregroundL: 0.97,
  foregroundC: 0.25,
  mutedL: 0.683, // #999999, Claude Code's inactive
  mutedC: 0.5,
  ringL: 0.627, // #888888, Claude Code's promptBorder
  ringC: 0.6,
  accentL: 0.67, // #D77757 sits exactly here
};

const LIGHT: Recipe = {
  surfaceL: [0.982, 0.948, 0.918, 0.872], // #FAF9F5 #F0EEE6 #E8E4D7 #DAD5C4
  surfaceC: [0.22, 0.45, 0.75, 1.0],
  foregroundL: 0.191,
  foregroundC: 0.2,
  mutedL: 0.524,
  mutedC: 0.4,
  ringL: 0.683,
  ringC: 0.5,
  accentL: 0.542,
};

/** The CLI's accent, `claude:"rgb(215,119,87)"`, measured in OKLCH. */
export const TERRACOTTA = { h: 39.1, c: 0.1286 } as const;

/** The CLI's `permission:"rgb(177,185,249)"`, the lavender it rings permission prompts with. */
export const PERIWINKLE = { h: 278.6, c: 0.091, l: 0.8025 } as const;

/**
 * Light themes all ask for the same accent chroma so no one theme shouts louder than another.
 * Hues that cannot hold it in sRGB quietly get as much as fits, keeping their hue intact.
 */
const LIGHT_ACCENT_CHROMA = 0.15;

interface ThemeSpec {
  readonly id: string;
  readonly name: string;
  readonly appearance: "light" | "dark";
  /** Hue every surface shares, in OKLCH degrees. */
  readonly surfaceHue: number;
  /** Chroma of `border`, the most saturated surface; the others ramp down from it. */
  readonly surfaceChroma: number;
  readonly accentHue: number;
  readonly accentChroma: number;
  /** Only for the two themes that earn an exception; see the notes on each spec. */
  readonly foregroundL?: number;
  readonly accentL?: number;
}

function paletteFor(spec: ThemeSpec): PluginThemeColors {
  const recipe = spec.appearance === "dark" ? DARK : LIGHT;
  const surface = (index: 0 | 1 | 2 | 3) =>
    oklch(recipe.surfaceL[index], spec.surfaceChroma * recipe.surfaceC[index], spec.surfaceHue);
  return {
    background: surface(0),
    raised: surface(1),
    control: surface(2),
    border: surface(3),
    foreground: oklch(
      spec.foregroundL ?? recipe.foregroundL,
      spec.surfaceChroma * recipe.foregroundC,
      spec.surfaceHue,
    ),
    mutedForeground: oklch(recipe.mutedL, spec.surfaceChroma * recipe.mutedC, spec.surfaceHue),
    ring: oklch(recipe.ringL, spec.surfaceChroma * recipe.ringC, spec.surfaceHue),
    accent: oklch(spec.accentL ?? recipe.accentL, spec.accentChroma, spec.accentHue),
  };
}

/**
 * Ids are what a client saves when someone picks a theme (`<plugin id>/theme/<theme id>`), so
 * they never change. The first two keep their pre-0.4 ids although their display names no
 * longer use the Claude Code product name; renaming only the label keeps every saved choice.
 */
const SPECS: readonly ThemeSpec[] = [
  {
    id: "claude-code-dark",
    name: "🌑 Charcoal Night",
    appearance: "dark",
    // Zero chroma is what makes this one faithful: the CLI's chrome is pure neutral grey
    // because a terminal is. Every value below comes back byte-identical to the CLI's.
    surfaceHue: 90,
    surfaceChroma: 0,
    accentHue: TERRACOTTA.h,
    accentChroma: TERRACOTTA.c,
    foregroundL: 1, // the CLI's text is pure #FFFFFF, not the family's softened off-white
  },
  {
    id: "claude-code-light",
    name: "☁️ Oat Latte",
    appearance: "light",
    surfaceHue: 94,
    surfaceChroma: 0.024,
    accentHue: TERRACOTTA.h,
    accentChroma: LIGHT_ACCENT_CHROMA,
  },
  {
    id: "cocoa-night",
    name: "🍫 Cocoa Night",
    appearance: "dark",
    // The warm reading of the dark anchor: a brown tint under the same ladder stops the
    // terracotta accent from looking bolted onto neutral grey.
    surfaceHue: 62,
    surfaceChroma: 0.021,
    accentHue: TERRACOTTA.h,
    accentChroma: TERRACOTTA.c,
  },
  {
    id: "blueberry-night",
    name: "🫐 Blueberry Night",
    appearance: "dark",
    surfaceHue: 274,
    surfaceChroma: 0.036,
    accentHue: PERIWINKLE.h,
    accentChroma: PERIWINKLE.c,
    accentL: PERIWINKLE.l, // keeps the CLI's permission lavender at its own brightness
  },
  {
    id: "sakura-latte",
    name: "🌸 Sakura Latte",
    appearance: "light",
    surfaceHue: 5,
    surfaceChroma: 0.058,
    accentHue: 10,
    accentChroma: LIGHT_ACCENT_CHROMA,
  },
  {
    id: "matcha-latte",
    name: "🍵 Matcha Latte",
    appearance: "light",
    // Green surfaces with the terracotta accent: near-complementary, so the accent reads as
    // a deliberate pop rather than another shade of the background.
    surfaceHue: 133,
    surfaceChroma: 0.048,
    accentHue: TERRACOTTA.h,
    accentChroma: LIGHT_ACCENT_CHROMA,
  },
];

export const THEMES: readonly PluginThemeContribution[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  appearance: spec.appearance,
  colors: paletteFor(spec),
}));
