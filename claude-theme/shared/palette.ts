import type { PluginThemeColors, PluginThemeContribution } from "@getpaseo/plugin";
import { contrast, fitContrast, luminance, oklch } from "./color.ts";

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
  /** Minimum contrast of `ring` on the surfaces in `ringOn` (`terminal.brightBlack` & `foregroundExtraMuted`). */
  readonly ringMinContrast: number;
  /** Surfaces `ring` must clear `ringMinContrast` on: the page, and in dark themes the workspace (`raised`) too. */
  readonly ringOn: readonly ("background" | "raised")[];
  /**
   * Floor for `mutedForeground` on the highlighted chrome it is painted on: the selected sidebar row (`border` in light
   * themes, `control` in dark ones) and the host's status badges (`surface3`, i.e. `border`, in both).
   */
  readonly mutedOnChrome: number;
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
  ringMinContrast: 4.5,
  // Paseo's dark workspace is `raised`, and `ring` is its timestamp / section-header colour there: the CLI's #888888
  // only reaches ~4.3:1 on it, so ring is lifted just enough (#8C8C8C in the neutral theme) to clear 4.5:1.
  ringOn: ["background", "raised"],
  // Status badges put muted 12px text on `border`, where the CLI's #999999 is only ~2.8:1: muted is lifted until it
  // clears the chrome floor there too (#B9B9B9 in the neutral theme), still well below the main text.
  mutedOnChrome: 4.1,
};

const LIGHT: Recipe = {
  surfaceL: [0.982, 0.948, 0.918, 0.872], // #FAF9F5 #F0EEE6 #E8E4D7 #DAD5C4
  surfaceC: [0.22, 0.45, 0.75, 1.0],
  foregroundL: 0.191,
  foregroundC: 0.2,
  mutedL: 0.524,
  mutedC: 0.4,
  // Paseo 0.11 maps `ring` to `foregroundExtraMuted` (timestamps, section headers, toolbar icons),
  // `surface4` (composer placeholder) and `terminal.brightBlack` as well as focus rings.
  // L=0.548 keeps `ring` one step lighter than `mutedForeground` (0.524) while clearing ≥4.5:1 on
  // `background` (~4.6–4.7:1), ≥4.1:1 on `raised`, and ≥3.8:1 on `control` (light sidebar & inputs).
  ringL: 0.548,
  ringC: 0.5,
  accentL: 0.542,
  ringMinContrast: 4.5,
  ringOn: ["background"],
  // The selected sidebar row and the status badges are `border` (L 0.872) in light themes: muted text there needs a
  // slightly darker shade.
  mutedOnChrome: 4.1,
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

export interface ThemeSpec {
  readonly id: string;
  readonly name: string;
  readonly appearance: "light" | "dark";
  /** Hue every surface shares, in OKLCH degrees. */
  readonly surfaceHue: number;
  /** Chroma of `border`, the most saturated surface; the others ramp down from it. */
  readonly surfaceChroma: number;
  readonly accentHue: number;
  readonly accentChroma: number;
  /** Optional overrides for themes whose anchor or vivid accent sits at a specific lightness. */
  readonly foregroundL?: number;
  readonly accentL?: number;
}

/**
 * Exact surface & semantic mapping performed by Paseo 0.11's `buildLightPluginTheme` and
 * `buildDarkPluginTheme` (`@getpaseo/server` web bundle `buildLightSemanticColors` / `buildDarkSemanticColors`).
 */
export interface HostThemeSurfaces {
  readonly surface0: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly surface3: string;
  readonly surface4: string;
  readonly surfaceWorkspace: string;
  readonly surfaceSidebar: string;
  readonly surfaceSidebarHover: string;
  readonly surfaceSidebarSelected: string;
  readonly popover: string;
  readonly input: string;
  readonly userBubble: string;
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly foregroundExtraMuted: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly ring: string;
  readonly terminalBackground: string;
  readonly terminalForeground: string;
  readonly terminalBlack: string;
  readonly terminalBrightBlack: string;
}

export function resolveHostSurfaces(theme: PluginThemeContribution): HostThemeSurfaces {
  const { appearance, colors } = theme;
  const accent = colors.accent ?? colors.foreground;
  const isLight = appearance === "light";
  return {
    surface0: colors.background,
    surface1: colors.raised,
    surface2: colors.control,
    surface3: colors.border,
    surface4: colors.ring,
    surfaceWorkspace: isLight ? colors.background : colors.raised,
    surfaceSidebar: isLight ? colors.control : colors.background,
    surfaceSidebarHover: colors.raised,
    surfaceSidebarSelected: isLight ? colors.border : colors.control,
    popover: isLight ? colors.background : colors.control,
    input: colors.control,
    userBubble: colors.border,
    foreground: colors.foreground,
    foregroundMuted: colors.mutedForeground,
    foregroundExtraMuted: colors.ring,
    accent,
    accentForeground: colors.background,
    ring: colors.ring,
    terminalBackground: colors.background,
    terminalForeground: colors.foreground,
    terminalBlack: isLight ? colors.foreground : colors.control,
    terminalBrightBlack: colors.ring,
  };
}

export interface ContrastCheck {
  readonly id: string;
  readonly label: string;
  readonly foreground: string;
  readonly surface: string;
  readonly ratio: number;
  readonly minRatio: number;
  readonly pass: boolean;
}

/**
 * Text tokens a host surface carries, with the contrast each must clear there. The reading surface (the chat) gets
 * WCAG AA for body text. On chrome (sidebar, its selected row, popovers, inputs, badges) `muted` and `ring` are 12px
 * secondary text, and their floors are deliberate compromises below the 4.5:1 AA asks of small text: extra-muted
 * timestamps at 4.5:1 on a highlighted row would be as strong as muted text and flatten the hierarchy. The README
 * lists the resulting numbers.
 */
type Floors = Partial<Record<"foreground" | "muted" | "ring" | "accent", number>>;
const READING: Floors = { foreground: 7, muted: 4.5, ring: 4.5, accent: 4.5 };
const CHROME: Floors = { foreground: 7, muted: 4.1, ring: 3.3, accent: 3.7 };
const SELECTED: Floors = { foreground: 7, muted: 4.1, ring: 3.3, accent: 3.5 };

/**
 * Every text token (`foreground`, `mutedForeground`, `ring` as extra-muted text and placeholder, `accent`) against every
 * surface the Paseo 0.11 host really paints it on (`resolveHostSurfaces`), each with its own floor: the reading surface
 * (workspace) asks the most, sidebar chrome, popovers and inputs a little less, the selected row least.
 */
export function evaluateThemeContrast(theme: PluginThemeContribution): readonly ContrastCheck[] {
  const { colors } = theme;
  const host = resolveHostSurfaces(theme);
  const surfaces: readonly { readonly id: string; readonly label: string; readonly bg: string; readonly floors: Floors }[] = [
    { id: "workspace", label: "workspace (the chat; page in light themes, raised in dark ones)", bg: host.surfaceWorkspace, floors: READING },
    { id: "sidebar", label: "sidebar", bg: host.surfaceSidebar, floors: CHROME },
    { id: "sidebar-selected", label: "selected sidebar row", bg: host.surfaceSidebarSelected, floors: SELECTED },
    { id: "popover", label: "popover & menus", bg: host.popover, floors: CHROME },
    { id: "input", label: "inputs (ring is the placeholder)", bg: host.input, floors: CHROME },
    { id: "user-bubble", label: "user message bubble", bg: host.userBubble, floors: { foreground: 7 } },
    { id: "badge", label: "status badge (muted 12px text on surface3)", bg: host.surface3, floors: { muted: CHROME.muted! } },
    { id: "terminal", label: "terminal (ring is brightBlack)", bg: host.terminalBackground, floors: { foreground: 7, ring: 4.5 } },
  ];
  const tokens = { foreground: colors.foreground, muted: colors.mutedForeground, ring: colors.ring, accent: host.accent } as const;
  const checks: ContrastCheck[] = [];
  const add = (id: string, label: string, foreground: string, surface: string, minRatio: number) => {
    const ratio = contrast(foreground, surface);
    checks.push({ id, label, foreground, surface, ratio, minRatio, pass: ratio >= minRatio });
  };
  for (const surface of surfaces) {
    for (const [token, minRatio] of Object.entries(surface.floors) as [keyof typeof tokens, number][]) {
      add(`${token}-on-${surface.id}`, `${token} on ${surface.label}`, tokens[token], surface.bg, minRatio);
    }
  }
  add("accent-button", "accentForeground (background) on the accent button", host.accentForeground, host.accent, 4.5);
  return checks;
}

/** Of several fitted shades of one token, the one furthest from the surfaces: darkest in light themes, lightest in dark ones. */
function furthest(appearance: ThemeSpec["appearance"], shades: readonly string[]): string {
  return [...shades].sort((a, b) => (appearance === "light" ? luminance(a) - luminance(b) : luminance(b) - luminance(a)))[0]!;
}

export function paletteFor(spec: ThemeSpec): PluginThemeColors {
  const recipe = spec.appearance === "dark" ? DARK : LIGHT;
  const surface = (index: 0 | 1 | 2 | 3) =>
    oklch(recipe.surfaceL[index], spec.surfaceChroma * recipe.surfaceC[index], spec.surfaceHue);
  const background = surface(0);
  const raised = surface(1);
  const control = surface(2);
  const border = surface(3);
  return {
    background,
    raised,
    control,
    border,
    foreground: fitContrast(
      spec.foregroundL ?? recipe.foregroundL,
      spec.surfaceChroma * recipe.foregroundC,
      spec.surfaceHue,
      [background, raised, control, border],
      7,
    ),
    mutedForeground: furthest(spec.appearance, [
      fitContrast(recipe.mutedL, spec.surfaceChroma * recipe.mutedC, spec.surfaceHue, [background, raised], 4.5),
      fitContrast(recipe.mutedL, spec.surfaceChroma * recipe.mutedC, spec.surfaceHue, spec.appearance === "light" ? [border] : [control, border], recipe.mutedOnChrome),
    ]),
    ring: fitContrast(
      recipe.ringL,
      spec.surfaceChroma * recipe.ringC,
      spec.surfaceHue,
      recipe.ringOn.map((name) => (name === "raised" ? raised : background)),
      recipe.ringMinContrast,
    ),
    accent: fitContrast(
      spec.accentL ?? recipe.accentL,
      spec.accentChroma,
      spec.accentHue,
      [background, raised],
      4.5,
    ),
  };
}

/**
 * Ids are what a client saves when someone picks a theme (`<plugin id>/theme/<theme id>`), so
 * they never change. The first two keep their pre-0.4 ids although their display names no
 * longer use the Claude Code product name; renaming only the label keeps every saved choice.
 */
export const SPECS: readonly ThemeSpec[] = [
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
  {
    id: "harbor-night",
    name: "⚓ Harbor Night",
    appearance: "dark",
    // Deep navy slate paired with vivid electric cyan: separates active controls cleanly from
    // red/amber status indicators.
    surfaceHue: 245,
    surfaceChroma: 0.042,
    accentHue: 210,
    accentChroma: 0.145,
    accentL: 0.76,
  },
  {
    id: "glacier-latte",
    name: "🧊 Glacier Latte",
    appearance: "light",
    // Crisp cool-white ice surfaces with a saturated cobalt blue accent.
    surfaceHue: 245,
    surfaceChroma: 0.038,
    accentHue: 255,
    accentChroma: 0.17,
  },
  {
    id: "velvet-night",
    name: "🔮 Velvet Night",
    appearance: "dark",
    // Deep plum-violet surfaces with a luminous rose-magenta accent.
    surfaceHue: 308,
    surfaceChroma: 0.042,
    accentHue: 345,
    accentChroma: 0.165,
    accentL: 0.74,
  },
  {
    id: "orchid-latte",
    name: "🌺 Orchid Latte",
    appearance: "light",
    // Soft lavender-tinted daylight surfaces with a vivid berry-magenta accent.
    surfaceHue: 308,
    surfaceChroma: 0.045,
    accentHue: 340,
    accentChroma: 0.165,
  },
  {
    id: "lagoon-night",
    name: "🐬 Lagoon Night",
    appearance: "dark",
    // Deep ocean-teal surfaces with a warm sunlit gold accent for high-contrast scanning.
    surfaceHue: 205,
    surfaceChroma: 0.04,
    accentHue: 78,
    accentChroma: 0.155,
    accentL: 0.8,
  },
  {
    id: "lagoon-latte",
    name: "🌊 Lagoon Latte",
    appearance: "light",
    // Seafoam-tinted light surfaces with a deep ocean-cyan accent, fitted automatically to ≥4.5:1.
    surfaceHue: 205,
    surfaceChroma: 0.042,
    accentHue: 200,
    accentChroma: LIGHT_ACCENT_CHROMA,
  },
];

export const THEMES: readonly PluginThemeContribution[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  appearance: spec.appearance,
  colors: paletteFor(spec),
}));
