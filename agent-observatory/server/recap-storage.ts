import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RECAP_LIMITS } from "../shared/recap";
import { ensurePrivateDirectory } from "./paseo-home";

/** At most this many Agents keep a recap, newest first; a recap older than 30 days is dropped. */
export const MAX_RECAPS = 300;
export const RECAP_TTL_MS = 30 * 86_400_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FILE_NAME = "recaps.json";
const EMPTY = JSON.stringify({ version: 1, recaps: [] });
/** The set-aside copy, and the temporary file of a write a crash cut short. */
const LEFTOVER = /^recaps\.json\.(?:backup|[0-9a-f-]{36}\.tmp)$/;
const instant = z.iso.datetime().nullable();
export const storedRecapSchema = z.object({
  agentId: z.string().min(1).max(256),
  summary: z.string().min(1).max(RECAP_LIMITS.summaryStored * 2),
  next: z.string().max(RECAP_LIMITS.nextStored * 2).nullable(),
  reply: z.string().max(RECAP_LIMITS.replyStored * 2).nullable(),
  at: z.iso.datetime(),
  roundAt: instant,
  endedAt: instant,
  stale: z.boolean(),
  runner: z.string().max(160).nullable(),
});
export type StoredRecap = z.infer<typeof storedRecapSchema>;

/** The newest recap per Agent, the most recent `MAX_RECAPS`, none older than `RECAP_TTL_MS`. */
export function retainRecaps(recaps: readonly StoredRecap[], now: number): StoredRecap[] {
  const newest = new Map<string, StoredRecap>();
  for (const recap of recaps) {
    const at = Date.parse(recap.at);
    if (!Number.isFinite(at) || now - at > RECAP_TTL_MS) continue;
    const kept = newest.get(recap.agentId);
    if (!kept || Date.parse(kept.at) < at) newest.set(recap.agentId, recap);
  }
  return [...newest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.agentId.localeCompare(b.agentId)).slice(0, MAX_RECAPS);
}

/**
 * `recaps.json` in the plugin's data directory (0700; the file 0600, replaced atomically). A file that is not a regular file
 * (a symlink is never followed), too large or unreadable is set aside once as `recaps.json.backup` (replaced the next time,
 * deleted after 30 days) and the store starts empty; an entry that does not fit the schema is dropped. `clear` deletes every copy.
 */
export class RecapStorage {
  error = false;
  private writes: Promise<void> = Promise.resolve();
  private digest: string | null = null;
  private readonly file: string;
  constructor(private readonly directory: string) { this.file = join(directory, FILE_NAME); }
  async load(now: number): Promise<StoredRecap[]> {
    const recaps = await this.read(now);
    // A set-aside copy or a cut-short write holds nothing newer than its own time: past 30 days it goes, as its recaps would.
    for (const path of await this.leftovers()) {
      const info = await lstat(path).catch(() => null);
      if (info && now - info.mtimeMs > RECAP_TTL_MS) await unlink(path).catch(() => {});
    }
    // Recaps dropped on the way in (expired, beyond the limit, damaged) leave the disk now, not at the next change.
    void this.save(recaps, now);
    return recaps;
  }
  /** Deletes the file and every copy of it, whatever memory held; later saves start from nothing. */
  clear(): Promise<void> {
    this.writes = this.writes.then(async () => {
      let failed = false;
      for (const path of [this.file, ...await this.leftovers()]) await unlink(path).catch((error: { code?: string }) => { if (error.code !== "ENOENT") failed = true; });
      this.digest = failed ? null : this.hash(EMPTY);
    });
    return this.writes;
  }
  private async leftovers(): Promise<string[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    return names.filter(name => LEFTOVER.test(name)).map(name => join(this.directory, name));
  }
  /** The stored recaps; the digest becomes what the disk holds (nothing, when there is no file or it was set aside). */
  private async read(now: number): Promise<StoredRecap[]> {
    try {
      // O_NOFOLLOW: a symlink in its place is never read through.
      const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("not a readable recap file");
        text = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const raw = JSON.parse(text) as { version?: unknown; recaps?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.recaps) || raw.recaps.length > MAX_RECAPS * 4) throw new Error("not a recap file");
      const recaps = raw.recaps.flatMap(value => { const parsed = storedRecapSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
      this.digest = this.hash(text);
      return retainRecaps(recaps, now);
    } catch (error) {
      // No file yet: saving nothing never creates one.
      if ((error as { code?: string }).code === "ENOENT") { this.digest = this.hash(EMPTY); return []; }
      this.error = true;
      // Not set aside: the next save writes over it.
      this.digest = await rename(this.file, `${this.file}.backup`).then(() => this.hash(EMPTY), () => null);
      return [];
    }
  }
  private hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
  save(recaps: readonly StoredRecap[], now: number): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, recaps: retainRecaps(recaps, now) }), digest = this.hash(snapshot);
    this.writes = this.writes.then(async () => {
      if (digest === this.digest) return;
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        if (Buffer.byteLength(snapshot, "utf8") > MAX_FILE_BYTES) throw new Error("too large");
        await ensurePrivateDirectory(this.directory);
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(snapshot); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.file); this.digest = digest; this.error = false;
      } catch { this.error = true; }
      finally { await unlink(temp).catch(() => {}); }
    });
    return this.writes;
  }
  async close(): Promise<void> { await this.writes; }
}
