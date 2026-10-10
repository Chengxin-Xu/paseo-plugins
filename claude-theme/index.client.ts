import type { PluginClientContext } from "@getpaseo/plugin/client";
import { THEMES } from "./shared/palette.ts";

export default function contribute(client: PluginClientContext) {
  const removers = THEMES.map((theme) => client.addTheme(theme));
  return () => {
    for (const remove of removers) remove();
  };
}
