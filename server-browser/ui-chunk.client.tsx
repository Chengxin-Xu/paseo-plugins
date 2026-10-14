import type { PluginClientContext, PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ServerBrowserSurface, ServerBrowserWorkspacePanel } from "./client/browser";
import { clearFrameCache } from "./client/frame-cache";
import type { ChunkLifetime } from "./client/chunk-lifetime";

// Paseo freezes exports before the module body runs; keep this declaration hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }
function createSurfaces(client: PluginClientContext) {
  const openOverview = () => {
    if (typeof client.openScreen === "function") client.openScreen({ screenId: "server-browser" });
    else client.openSurface("server-browser");
  };
  // Register the cache from this evaluated chunk, never a second copy imported by the stub.
  // A surface rendered after entry teardown stays empty and releases that cache immediately.
  function Browser({ chunkLifetime, ...props }: PluginScreenProps & { chunkLifetime: ChunkLifetime }) {
    return chunkLifetime.attach(clearFrameCache) ? <ServerBrowserSurface {...props} /> : null;
  }
  function Workspace({ chunkLifetime, ...props }: PluginWorkspacePanelProps & { chunkLifetime: ChunkLifetime }) {
    return chunkLifetime.attach(clearFrameCache) ? <ServerBrowserWorkspacePanel {...props} onOpenOverview={openOverview} /> : null;
  }
  return { "server-browser": Browser, "workspace-browser": Workspace };
}
