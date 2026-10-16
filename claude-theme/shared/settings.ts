import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { customColors } from "./custom.ts";
import { CUSTOM_SETTINGS_ID, DEFAULT_CUSTOM, normalizeParam, type Appearance, type NumericParam } from "./params.ts";

/**
 * The custom theme's parameters, kept by the host in `$PASEO_HOME/plugin-settings/<plugin id>/custom-theme.json`, so
 * every device connected to that host shows the same custom theme. Paseo parses the document with this schema on the
 * plugin's server whenever it is read or written, so the schema also fills in `colors`, the palette computed from the
 * parameters: clients get a ready palette and never need the colour maths to show the theme. Stored colours are
 * ignored and computed again. Reading never fails on a hand-edited file: each value is rounded into range (hues wrap),
 * and anything unusable takes its default.
 */
// `optional()` first: Paseo parses `{}` for a missing file, and a transform alone would make every key required.
const number = (name: NumericParam) => z.unknown().optional().transform((value): number => normalizeParam(name, value) ?? DEFAULT_CUSTOM[name]);

export const customThemeSettings = defineSettings({
  id: CUSTOM_SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: z
    .object({
      appearance: z.unknown().optional().transform((value): Appearance => (value === "light" || value === "dark" ? value : DEFAULT_CUSTOM.appearance)),
      surfaceHue: number("surfaceHue"),
      surfaceTint: number("surfaceTint"),
      accentHue: number("accentHue"),
      accentVividness: number("accentVividness"),
    })
    .transform((params) => ({ ...params, colors: customColors(params) })),
});

export { customThemeRpc } from "./params.ts";
