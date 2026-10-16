import type { PluginThemeColors, PluginThemeContribution } from "@getpaseo/plugin";
import { maxChroma } from "./color.ts";
import { evaluateThemeContrast, paletteFor, THEMES, type ContrastCheck, type ThemeSpec } from "./palette.ts";
import { CUSTOM_THEME_ID, customContribution, FALLBACK_CUSTOM_NAME, type Appearance, type CustomPalette, type CustomParams } from "./params.ts";

/**
 * The custom slot's recipe: five numbers the user tunes, turned into a theme by the family's own recipe (`paletteFor`,
 * so the same lightness ladder and contrast fitting as the twelve fixed themes). Used by the server, which adds the
 * colours to the setting every time it is read or written, and by the settings screen for its live preview; the
 * resident client stub never loads it (`params.ts` has what it needs).
 */
export {
  CUSTOM_THEME_ID,
  DEFAULT_CUSTOM,
  FALLBACK_CUSTOM_NAME,
  PARAM_RANGES,
  normalizeParam,
  normalizeParams,
  stepParam,
  themeName,
  type Appearance,
  type CustomPalette,
  type CustomParams,
  type NumericParam,
} from "./params.ts";

/** `border`'s chroma at 100 % tint; the family's fixed themes sit between 0 and 0.058. */
export const MAX_SURFACE_CHROMA = 0.08;

/** The recipe's `border` lightness per appearance: the tint slider's strip shows the most coloured surface. */
export const SURFACE_SWATCH_LIGHTNESS: { readonly [Name in Appearance]: number } = { dark: 0.431, light: 0.872 };

/** Dark accents sit where their hue is most colourful within the family's range (Charcoal Night 0.67 to Blueberry 0.80). */
const DARK_ACCENT_LIGHTNESS = { min: 0.68, max: 0.82 } as const;

/**
 * The accent's OKLCH lightness. Light themes keep the recipe's 0.542 (fitted darker where a hue needs it); dark themes
 * take the lightness in their range where the hue holds the most chroma, so yellow and cyan accents come out bright
 * instead of olive and slate, and red and violet ones stay deep and saturated.
 */
export function accentLightness(appearance: Appearance, hue: number): number | undefined {
  if (appearance === "light") return undefined;
  let best: number = DARK_ACCENT_LIGHTNESS.min;
  let bestChroma = -1;
  for (let step = 0; step <= 14; step += 1) {
    const lightness = DARK_ACCENT_LIGHTNESS.min + step * 0.01;
    const chroma = maxChroma(lightness, hue);
    if (chroma > bestChroma + 1e-6) {
      best = lightness;
      bestChroma = chroma;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/** The recipe input for these parameters, the same shape as the fixed themes' `SPECS`. */
export function customSpec(params: CustomParams, name: string = FALLBACK_CUSTOM_NAME): ThemeSpec {
  const accentL = accentLightness(params.appearance, params.accentHue);
  const reference = accentL ?? 0.542;
  return {
    id: CUSTOM_THEME_ID,
    name,
    appearance: params.appearance,
    surfaceHue: params.surfaceHue,
    surfaceChroma: (params.surfaceTint / 100) * MAX_SURFACE_CHROMA,
    accentHue: params.accentHue,
    accentChroma: (params.accentVividness / 100) * maxChroma(reference, params.accentHue),
    ...(accentL === undefined ? {} : { accentL }),
  };
}

export function customColors(params: CustomParams): PluginThemeColors {
  return paletteFor(customSpec(params));
}

export function customPalette(params: CustomParams): CustomPalette {
  return { appearance: params.appearance, colors: customColors(params) };
}

/** The contribution `addTheme` takes, always under `CUSTOM_THEME_ID`. */
export function customTheme(params: CustomParams, name: string): PluginThemeContribution {
  return customContribution(customPalette(params), name);
}

export interface ContrastReport {
  readonly checks: readonly ContrastCheck[];
  readonly failed: readonly ContrastCheck[];
}

/** The same 25-check matrix the fixed themes are tested against (`evaluateThemeContrast`). */
export function contrastReport(theme: PluginThemeContribution): ContrastReport {
  const checks = evaluateThemeContrast(theme);
  return { checks, failed: checks.filter((check) => !check.pass) };
}

const TOKENS = ["background", "raised", "control", "border", "foreground", "mutedForeground", "ring", "accent"] as const;

/** The fixed theme with exactly these colours, if any: then the host cannot tell the two apart. */
export function matchingPreset(colors: PluginThemeColors): string | null {
  const preset = THEMES.find((theme) => TOKENS.every((token) => theme.colors[token]?.toUpperCase() === colors[token]?.toUpperCase()));
  return preset ? preset.id : null;
}

/** The colours a plugin view gets from the host (`PluginTheme`), for the ones a custom theme sets directly. */
export interface HostColors {
  readonly surface0: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly border: string;
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly accent: string;
}

/**
 * Whether the app is painting this palette now. A plugin cannot read the app's theme choice, but it does get the theme
 * colours, and these seven only match when the custom theme (or a fixed theme with the very same palette) is selected.
 */
export function paletteInUse(host: HostColors, colors: PluginThemeColors): boolean {
  const same = (a: string | undefined, b: string | undefined) => typeof a === "string" && typeof b === "string" && a.toUpperCase() === b.toUpperCase();
  return (
    same(host.surface0, colors.background) &&
    same(host.surface1, colors.raised) &&
    same(host.surface2, colors.control) &&
    same(host.border, colors.border) &&
    same(host.foreground, colors.foreground) &&
    same(host.foregroundMuted, colors.mutedForeground) &&
    same(host.accent, colors.accent)
  );
}
