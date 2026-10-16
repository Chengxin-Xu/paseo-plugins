import { createClientChunkRpc } from "./client-chunk";

/** The settings screens arrive as one lazy chunk, fetched the first time one of them opens. */
export const getClientChunk = createClientChunkRpc("theme.client-chunk.get", ["ui"]);
