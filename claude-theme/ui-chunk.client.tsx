import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CustomThemeScreen, type CustomThemeScreenProps } from "./client/editor.tsx";
import { LanguageScreen } from "./client/language-screen.tsx";
import type { ChunkExtras } from "./client/lazy-chunk";
import { settingsIo } from "./client/live-theme.ts";
import { followText } from "./shared/i18n";

// Paseo freezes exports before the module body runs; keep this declaration hoisted.
export default function chunk() {
  return { api: 1, createSurfaces };
}

function createSurfaces(client: PluginClientContext, extras?: ChunkExtras) {
  followText(extras?.text);
  // The settings screen writes the custom theme itself; the resident stub only reads it.
  const io = settingsIo(client);
  const CustomTheme = (props: CustomThemeScreenProps) => <CustomThemeScreen {...props} io={io} />;
  return { "custom-theme": CustomTheme, language: LanguageScreen };
}
