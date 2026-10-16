import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import { registerClientChunks } from "./server/ui-chunk";
import { PLUGIN_ID } from "./shared/plugin-id.ts";
import { customThemeSettings } from "./shared/settings.ts";

/**
 * The server part only keeps state for the client: the custom theme's parameters (a host setting, so every device of
 * the host shows the same theme), the plugin's languages, and the settings screens' code, sent when one first opens.
 * No network, no subprocesses; files only under the host's plugin-settings and this plugin's plugin-data folder.
 */
export default function contribute(server: PluginServerContext) {
  const locales = createLocaleService(server, { pluginId: PLUGIN_ID, builtins: BUILTIN_CATALOGS });
  server.registerSettings(customThemeSettings);
  registerClientChunks(server);
  return () => {
    locales.dispose();
  };
}
