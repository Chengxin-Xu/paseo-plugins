import { createClientChunkRpc } from "./client-chunk";
export const getClientChunk = createClientChunkRpc("browser.client-chunk.get", ["ui"]);
