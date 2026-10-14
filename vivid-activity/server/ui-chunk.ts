import { createClientChunkHandler } from "./client-chunks";
import { PI_CHUNK } from "../shared/generated/pi-chunk-manifest";
import { UI_CHUNK } from "../shared/generated/ui-chunk-manifest";
import piCode from "./generated/pi-chunk.txt";
import code from "./generated/ui-chunk.txt";

export const getUiChunk = createClientChunkHandler([{ ...UI_CHUNK, code }, { ...PI_CHUNK, code: piCode }]);
