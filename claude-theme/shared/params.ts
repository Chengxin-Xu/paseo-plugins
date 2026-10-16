import { settingsRpc, type PluginThemeColors, type PluginThemeContribution } from "@getpaseo/plugin";

/**
 * The custom theme's parameters, its computed palette and the host setting that keeps them, without the OKLCH recipe:
 * the resident client stub imports only this file (plus generated constants), so connecting a device never downloads
 * the colour maths. The recipe lives in `custom.ts`, used by the server (the setting's schema in `settings.ts` fills in
 * the colours whenever the setting is read or written) and by the settings screen's lazy chunk (live preview).
 */

/** The host setting (Paseo serves `settings.<id>.read/write/reset`); its schema stays on the server (`settings.ts`). */
export const CUSTOM_SETTINGS_ID = "custom-theme";
export const customThemeRpc = settingsRpc(CUSTOM_SETTINGS_ID);

/** Clients save a theme choice as `<plugin id>/theme/<theme id>`, so this id never changes. */
export const CUSTOM_THEME_ID = "custom";
/** Used when a translation leaves the theme name empty. */
export const FALLBACK_CUSTOM_NAME = "🎨 Custom";

export type Appearance = "dark" | "light";

export interface CustomParams {
  readonly appearance: Appearance;
  /** OKLCH hue every surface shares, 0–359°. */
  readonly surfaceHue: number;
  /** How strongly the surfaces carry that hue: 0 is neutral grey, 100 is `MAX_SURFACE_CHROMA` on `border`. */
  readonly surfaceTint: number;
  /** OKLCH hue of buttons, links and the selection, 0–359°. */
  readonly accentHue: number;
  /** Accent chroma as a share of the most sRGB can show at that hue and lightness: 0 is grey, 100 the most colourful. */
  readonly accentVividness: number;
}

export type NumericParam = Exclude<keyof CustomParams, "appearance">;

/** Slider ranges and the stepper's step; hues wrap around (359° + 5° is 4°). */
export const PARAM_RANGES: { readonly [Name in NumericParam]: { readonly min: number; readonly max: number; readonly step: number; readonly wrap: boolean } } = {
  surfaceHue: { min: 0, max: 359, step: 5, wrap: true },
  surfaceTint: { min: 0, max: 100, step: 5, wrap: false },
  accentHue: { min: 0, max: 359, step: 5, wrap: true },
  accentVividness: { min: 0, max: 100, step: 5, wrap: false },
};

/**
 * The slot's first look: deep teal surfaces with a hot pink accent. Pink stays clear of the blue, amber, red and green
 * that Paseo and the plugins use for running, waiting, failed and done, and no fixed theme of the family uses it.
 */
export const DEFAULT_CUSTOM: CustomParams = {
  appearance: "dark",
  surfaceHue: 215,
  surfaceTint: 60,
  accentHue: 350,
  accentVividness: 80,
};

/** A finite number rounded into range (hues wrap), else null. */
export function normalizeParam(name: NumericParam, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const range = PARAM_RANGES[name];
  const rounded = Math.round(value);
  if (range.wrap) return ((rounded % 360) + 360) % 360;
  return Math.min(range.max, Math.max(range.min, rounded));
}

/** Whatever was stored, as usable parameters: anything missing or malformed takes the default. */
export function normalizeParams(input: unknown): CustomParams {
  const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const number = (name: NumericParam) => normalizeParam(name, source[name]) ?? DEFAULT_CUSTOM[name];
  return {
    appearance: source.appearance === "light" || source.appearance === "dark" ? source.appearance : DEFAULT_CUSTOM.appearance,
    surfaceHue: number("surfaceHue"),
    surfaceTint: number("surfaceTint"),
    accentHue: number("accentHue"),
    accentVividness: number("accentVividness"),
  };
}

/** One stepper press: `direction` steps of the parameter's step, wrapping hues and stopping at the ends otherwise. */
export function stepParam(params: CustomParams, name: NumericParam, direction: 1 | -1): CustomParams {
  const next = params[name] + direction * PARAM_RANGES[name].step;
  return { ...params, [name]: normalizeParam(name, next) ?? params[name] };
}

/**
 * The name the host shows in Settings → Appearance. The app's schema wants 1 to 60 characters after trimming; a
 * translation that breaks that falls back to the English name instead of failing the registration.
 */
export function themeName(raw: string): string {
  // Control characters would garble the theme list; anything else a translation uses is kept. Cutting at 60 UTF-16
  // units may split a surrogate pair: its orphaned first half goes too.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60).replace(/[\ud800-\udbff]$/, "").trim();
  return name || FALLBACK_CUSTOM_NAME;
}

/** What the app needs to paint the custom theme. Computed from the parameters by the recipe (`custom.ts`). */
export interface CustomPalette {
  readonly appearance: Appearance;
  readonly colors: PluginThemeColors;
}

export const PALETTE_TOKENS = ["background", "raised", "control", "border", "foreground", "mutedForeground", "ring", "accent"] as const;
const HEX = /^#[0-9A-F]{6}$/;

/**
 * The palette in a settings document (`appearance` plus the server-computed `colors`), or null if anything is off. Only
 * the eight colours are kept: the app refuses a theme with anything else in it.
 */
export function readPalette(value: unknown): CustomPalette | null {
  const { appearance, colors } = (value ?? {}) as { appearance?: unknown; colors?: { [token: string]: unknown } | null };
  const picked: { [token: string]: string } = {};
  for (const token of PALETTE_TOKENS) {
    const hex = colors?.[token];
    if (typeof hex !== "string" || !HEX.test(hex)) return null;
    picked[token] = hex;
  }
  return appearance === "dark" || appearance === "light" ? { appearance, colors: picked as unknown as PluginThemeColors } : null;
}

/** Equal palettes give equal keys. */
export const paletteKey = (palette: CustomPalette): string => palette.appearance + PALETTE_TOKENS.map((token) => palette.colors[token]).join("");

/** The contribution `addTheme` takes, always under `CUSTOM_THEME_ID`. */
export function customContribution(palette: CustomPalette, name: string): PluginThemeContribution {
  return { id: CUSTOM_THEME_ID, name: themeName(name), appearance: palette.appearance, colors: { ...palette.colors } };
}
