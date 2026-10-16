import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getClientChunk } from "../shared/ui-chunk";
import { QUICK_CHUNK } from "../shared/generated/quick-chunk-manifest";
import { UI_CHUNK } from "../shared/generated/ui-chunk-manifest";
import { createClientChunkHandler } from "./client-chunks";
import quickCode from "./generated/quick-chunk.txt";
import code from "./generated/ui-chunk.txt";

export function registerClientChunks(server: Pick<PluginServerContext, "handle">) {
  return server.handle(getClientChunk, createClientChunkHandler([{ ...UI_CHUNK, code }, { ...QUICK_CHUNK, code: quickCode }]));
}
