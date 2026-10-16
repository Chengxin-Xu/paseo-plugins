import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ChunkExtras } from "./client/lazy-chunk";
import { followText } from "./shared/i18n";
import { FoldChanges } from "./client/fold-changes";
import { RunningLoader } from "./client/loaders";

/**
 * 0.8.0: the running animations other than the spinner (client/loaders.tsx) and the change list of an expanded fold
 * summary (client/fold-changes.tsx), in a lazy chunk of their own (client/fx.ts). The default spinner needs neither, so
 * the resident timeline leaves them out.
 */
export default function chunk() {
  return { api: 1, createSurfaces(_client: PluginClientContext, extras?: ChunkExtras) { followText(extras?.text); return { RunningLoader, FoldChanges }; } };
}
