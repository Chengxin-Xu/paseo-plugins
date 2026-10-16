import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createClientI18n } from "./client/i18n-client";
import { lazySurfaces } from "./client/lazy-chunk";
import { createSlot } from "./client/slot.ts";
import { valuesCache } from "./client/sync.ts";
import { FIXED_THEMES } from "./shared/generated/themes.ts";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { PLUGIN_ID } from "./shared/plugin-id.ts";
import { t } from "./shared/text.ts";
import { getClientChunk } from "./shared/ui-chunk";

/**
 * The resident part, sent with every connection: the twelve fixed themes and the custom slot as ready colours (computed
 * at build time and by the server), and two settings screens whose views, colour maths and full text load on first open
 * (`ui-chunk.client.tsx`). Connecting costs one settings read and the boot text; nothing polls.
 */
export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void | Promise<void>> = FIXED_THEMES.map((theme) => client.addTheme(theme));
  const i18n = createClientI18n(client, { pluginId: PLUGIN_ID, boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } }, load: "lazy" });
  const slot = createSlot(client, { name: () => t("boot.customThemeName"), cache: valuesCache(PLUGIN_ID) });
  // The theme's name follows the plugin's language.
  const stopText = i18n.subscribe(() => slot.rename());
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.settingsTitle"), text: i18n });
  const Editor = lazy("custom-theme");
  const CustomThemeSettings = (props: object) => <Editor {...props} slot={slot} />;
  cleanups.push(client.addSettingsScreen({ id: "custom-theme", title: t("boot.settingsTitle"), icon: "Palette", Component: CustomThemeSettings }));
  cleanups.push(client.addSettingsScreen({ id: "language", title: t("boot.languageTitle"), icon: "Languages", Component: lazy("language") }));
  cleanups.push(
    i18n.localized(() =>
      client.addCommandCenterItem({
        id: "custom-theme",
        title: t("boot.openCustomTheme"),
        icon: "Palette",
        context: "global",
        keywords: t("boot.keywords").split("|"),
        onSelect: (context) => context.openSettings("custom-theme"),
      }),
    ),
  );
  return () => {
    stopText();
    slot.dispose();
    for (const cleanup of cleanups.splice(0).reverse()) void cleanup();
    i18n.dispose();
  };
}
