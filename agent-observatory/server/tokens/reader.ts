import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { initialParser, parseLine } from "./parser";
import type { CallSink, LogFile } from "./types";

const CHUNK = 256 * 1024, MAX_LINE = 16 * 1024 * 1024;
/** A log path that has become a symlink is not followed (`ELOOP`); the next scan stops tracking it. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** No readFile, locks or writes on provider roots. Incomplete lines stay on disk, not in the checkpoint. */
export async function tailFile(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void): Promise<boolean> {
  let handle;
  try { handle = await open(file.path, OPEN_FLAGS); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOOP") return false; throw error; }
  try { return await tailOpen(file, handle, sink, onBytes); }
  finally { await handle.close(); }
}

async function tailOpen(file: LogFile, handle: Awaited<ReturnType<typeof open>>, sink: CallSink, onBytes?: (bytes: number) => void): Promise<boolean> {
  const details = await handle.stat();
  if (!details.isFile()) return false;
  const initialOffset = file.offset;
  const changed = details.dev !== file.dev || details.ino !== file.ino || details.size !== file.size || details.mtimeMs !== file.mtime;
  if (details.dev !== file.dev || details.ino !== file.ino || details.size < file.offset || details.size < file.size ||
      (details.size === file.size && details.mtimeMs !== file.mtime && file.offset === details.size)) {
    file.offset = 0; file.partialBytes = 0; file.state = initialParser(file.path, file.parentSession);
  }
  // The unchanged partial suffix remains on disk. Retrying it cannot complete a line and must not dirty the ledger.
  if (!changed && file.partialBytes > 0 && file.offset + file.partialBytes === details.size) return false;
  file.dev = details.dev; file.ino = details.ino; file.size = details.size; file.mtime = details.mtimeMs;
  if (file.offset >= details.size) return changed;
  let position = file.offset, committed = file.offset, carry = Buffer.alloc(0), skipping = false, yieldedAt = performance.now();
  const buffer = Buffer.allocUnsafe(CHUNK);
  while (position < details.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, details.size - position), position);
    if (!bytesRead) break;
    const chunkStart = position; position += bytesRead; onBytes?.(bytesRead);
    let begin = 0;
    for (let end = buffer.indexOf(10, begin); end !== -1 && end < bytesRead; end = buffer.indexOf(10, begin)) {
      if (!skipping) {
        const line = carry.length ? Buffer.concat([carry, buffer.subarray(begin, end)]) : buffer.subarray(begin, end);
        if (line.length <= MAX_LINE) parseLine(line.toString("utf8"), file, sink);
      }
      carry = Buffer.alloc(0); skipping = false; begin = end + 1;
      committed = chunkStart + begin; file.offset = committed;
      if (performance.now() - yieldedAt >= 20) { await yieldLoop(); yieldedAt = performance.now(); }
    }
    if (!skipping && begin < bytesRead) {
      carry = Buffer.concat([carry, buffer.subarray(begin, bytesRead)]);
      if (carry.length > MAX_LINE) { carry = Buffer.alloc(0); skipping = true; }
    }
    if (performance.now() - yieldedAt >= 20) { await yieldLoop(); yieldedAt = performance.now(); }
  }
  file.partialBytes = position - committed;
  return changed || file.offset !== initialOffset;
}
