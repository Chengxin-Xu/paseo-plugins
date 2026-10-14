import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { mkdir, rename, open, unlink, chmod, readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { BOARD_FILE_LIMIT_BYTES, OVERVIEW_LIMIT_BYTES, fieldsSchema, noteVersionSchema, itemSchema, snapshotSchema, writeBoardInputSchema, type BoardSnapshot, type NoteVersion, type UnavailableBoard, type WriteBoardInput } from "../shared/schema";

const storedItemSchema = itemSchema.extend({ history: z.array(noteVersionSchema).optional(), historyKeys: z.array(z.string()).optional() });
const historySchema = z.object({ projectId: z.string(), itemId: z.string().uuid(), versions: z.array(noteVersionSchema), protectedKeys: z.array(z.string()).default([]), committedKeys: z.array(z.string()).optional() });
const documentSchema = snapshotSchema.extend({ items: z.array(storedItemSchema), version: z.union([z.literal(1), z.literal(2)]), pendingHistory: z.array(z.union([z.string().uuid(), z.object({ itemId: z.string().uuid(), keys: z.array(z.string()) })])).optional(), receipts: z.array(z.object({ requestId: z.string(), hash: z.string(), stableHash: z.string().optional(), itemId: z.string(), removedIds: z.array(z.string().uuid()).optional() })) });
const versionKey = (version: NoteVersion) => createHash("sha256").update(JSON.stringify(version)).digest("hex");
type BoardDocument = z.infer<typeof documentSchema>;
/** Cross-process lock: the plugin subprocess and the CLI (bin/notes.mjs) may write the same board. */
const LOCK_WAIT_MS = 10_000;
/**
 * A lock whose holder cannot be checked from here (unreadable, or written on another host or in another PID namespace)
 * is reclaimed only after this long. A holder keeps its lock for one read-modify-write of a board of at most 32 MiB,
 * normally well under a second, so a minute is clearly overdue.
 */
const LOCK_STALE_MS = 60_000;
const READ_CONCURRENCY = 8;
const BOARD_FILE = /^[a-f0-9]{64}\.json$/;
const SINGLE = { invalid: "记录文件校验失败，已保留原文件；请先备份检查，不会自动清空。", tooLarge: "记录文件过大，请先备份整理后再继续。" };
const OVERVIEW = { invalid: "某个项目的手记文件校验失败，已保留原文件；不会把读取失败当作空看板。", tooLarge: SINGLE.tooLarge };
/** A board as last read from disk. `token` hashes the file bytes: every change, from any process or a manual edit, yields a new token. */
export interface BoardEntry { snapshot: BoardSnapshot; token: string }
/** A board the overview left out, with its file name (the SHA-256 of its project ID). */
export interface SkippedBoard extends UnavailableBoard { file: string }
/** The overview: every board within the size limits, plus the ones left out. */
export interface BoardEntries { entries: BoardEntry[]; unavailable: SkippedBoard[] }
export interface StoreOptions { waitMs?: number; staleMs?: number; maxFileBytes?: number; maxTotalBytes?: number }
type CachedBoard = BoardEntry & { key: string };
/** Writers replace boards by rename, so a new inode, size, mtime or ctime means the parsed copy is stale. */
function statKey(s: BigIntStats) { return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
function missing(e: unknown) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
/** A board file over the per-board limit. The overview leaves it out; reading or writing that board alone fails. */
class BoardTooLarge extends Error { constructor(message: string, readonly bytes: number) { super(message); } }
async function mapLimit<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length); let next = 0;
  const worker = async () => { while (next < values.length) { const index = next++; results[index] = await fn(values[index]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}
/** The daemon's home: `PASEO_HOME` (a leading `~` expands), else Paseo's default `~/.paseo`. */
export function paseoHome(env: Record<string, string | undefined> = process.env): string {
  let home = env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
  if (home === "~") home = homedir();
  else if (home.startsWith("~/")) home = path.join(homedir(), home.slice(2));
  return path.resolve(home);
}
export function defaultStorageRoot(env: Record<string, string | undefined> = process.env): string {
  return path.join(paseoHome(env), "plugin-data", "project-notes", "boards");
}

/**
 * Who holds a board lock. The lock file holds one JSON line: pid, a random token for this holder, host name, PID namespace
 * and (Linux) process start time. 0.8.0 and earlier wrote `<pid> <time>`, which still parses: no token, same host.
 */
interface LockOwner { pid: number; token: string | null; host: string | null; ns: string | null; start: string | null }
const pidSchema = z.number().int().positive().max(0x7fffffff);
const lockSchema = z.object({ pid: pidSchema, token: z.string().min(1), host: z.string(), ns: z.string().nullable(), start: z.string().nullable() });
function parseOwner(raw: string): LockOwner | null {
  try { return lockSchema.parse(JSON.parse(raw)); } catch { /* not the current format */ }
  const legacy = /^(\d+) \S+\n?$/.exec(raw), pid = pidSchema.safeParse(Number(legacy?.[1]));
  return pid.success ? { pid: pid.data, token: null, host: null, ns: null, start: null } : null;
}
/** Linux start time of a process (field 22 of /proc/<pid>/stat, clock ticks since boot); null elsewhere. */
async function startTime(pid: number | "self"): Promise<string | null> {
  try {
    const line = await readFile(`/proc/${pid}/stat`, "utf8");
    // Field 2 is the command name in parentheses and may contain spaces, so count the fields after the last ")".
    return line.slice(line.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}
type Identity = { host: string; ns: string | null; start: string | null };
let identity: Promise<Identity> | undefined;
/** This process as its lock files describe it. */
function self(): Promise<Identity> {
  return identity ??= Promise.all([readlink("/proc/self/ns/pid").catch(() => null), startTime("self")]).then(([ns, start]) => ({ host: hostname(), ns, start }));
}
/** "gone": the holder exited, so its lock can go at once. "alive": wait for it. "unknown": its pid means nothing here. */
async function holderState(owner: LockOwner | null): Promise<"alive" | "gone" | "unknown"> {
  if (!owner) return "unknown";
  const me = await self();
  // A pid only names a process on the same host and in the same PID namespace (a sandboxed CLI may have its own).
  if (owner.host !== null && (owner.host !== me.host || owner.ns !== me.ns)) return "unknown";
  try { process.kill(owner.pid, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return "gone"; } // EPERM: it runs as another user
  if (owner.start && me.start) {
    const start = await startTime(owner.pid);
    if (start !== null && start !== owner.start) return "gone"; // the pid now names a different process
  }
  return "alive";
}
interface SeenLock { owner: LockOwner | null; ageMs: number }
/** Reads a lock file once, content and age from the same open file; null when there is none. */
async function inspect(lock: string): Promise<SeenLock | null> {
  let handle;
  try { handle = await open(lock, "r"); } catch (e) { if (missing(e)) return null; throw e; }
  try {
    const info = await handle.stat(), buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { owner: parseOwner(buffer.subarray(0, bytesRead).toString("utf8")), ageMs: Date.now() - info.mtimeMs };
  } finally { await handle.close(); }
}

/** Project IDs are hashed. Only plugin-owned files are written. */
export class BoardStore {
  private queues = new Map<string, Promise<unknown>>();
  /** Parsed boards by file name. Polling re-stats files instead of re-reading and re-validating them. */
  private cache = new Map<string, CachedBoard>();
  /** Project IDs of board files this store has read or written, so a board left out of the overview can be named. */
  private names = new Map<string, string>();
  private readonly options: Required<StoreOptions>;
  constructor(private readonly root = defaultStorageRoot(), options: StoreOptions = {}) {
    this.options = { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, maxFileBytes: BOARD_FILE_LIMIT_BYTES, maxTotalBytes: OVERVIEW_LIMIT_BYTES, ...options };
  }
  /** The board's file name: the SHA-256 of its project ID. */
  boardFile(projectId: string): string { return createHash("sha256").update(projectId).digest("hex") + ".json"; }
  private filename(projectId: string): string { return path.join(this.root, this.boardFile(projectId)); }
  /** Fresh read for read-modify-write under the lock; never served from the cache. */
  private async load(projectId: string): Promise<BoardDocument> {
    let raw: string;
    try {
      const h = await open(this.filename(projectId), "r");
      try {
        const size = (await h.stat()).size;
        if (size > this.options.maxFileBytes) throw new BoardTooLarge(SINGLE.tooLarge, size);
        raw = await h.readFile("utf8");
      } finally { await h.close(); }
    } catch (e) {
      if (missing(e)) return { version: 2, projectId, revision: 0, items: [], receipts: [] };
      throw e;
    }
    try {
      const doc = documentSchema.parse(JSON.parse(raw));
      if (doc.projectId !== projectId) throw new Error("project mismatch");
      return doc;
    } catch { throw new Error(SINGLE.invalid); }
  }
  private snapshot(doc: BoardDocument): BoardSnapshot {
    return { projectId: doc.projectId, revision: doc.revision, items: doc.items.map(({ history: _history, historyKeys: _keys, ...item }) => item) };
  }
  private historyFile(projectId: string, itemId: string) { return path.join(this.root, "history", `${this.boardFile(projectId).slice(0, -5)}.${itemId}.json`); }
  private async historyData(projectId: string, itemId: string): Promise<z.infer<typeof historySchema>> {
    let raw: string;
    try { raw = await readFile(this.historyFile(projectId, itemId), "utf8"); }
    catch (error) { if (missing(error)) return { projectId, itemId, versions: [], protectedKeys: [] }; throw error; }
    try {
      const saved = historySchema.parse(JSON.parse(raw));
      if (saved.projectId !== projectId || saved.itemId !== itemId) throw new Error("history mismatch");
      return saved;
    } catch { throw new Error("修改快照文件校验失败，已保留原文件和看板；请先备份检查。"); }
  }
  private async history(projectId: string, itemId: string, expectedKeys: readonly string[] = []) {
    const { versions } = await this.historyData(projectId, itemId), present = new Set(versions.map(versionKey));
    if (expectedKeys.some(key => !present.has(key))) throw new Error("修改快照文件缺失或不完整，已保留看板；请从同一份备份恢复历史文件。");
    return versions;
  }
  private async saveHistory(projectId: string, itemId: string, versions: NoteVersion[], owned: () => Promise<void>, options: { protect?: string[]; retain?: string[]; committed?: string[] } = {}) {
    const saved = await this.historyData(projectId, itemId);
    const protectedKeys = [...new Set([...saved.protectedKeys, ...(options.protect ?? [])])];
    const committedKeys = options.committed ?? saved.committedKeys ?? [];
    // Migration originals and committed references survive until the corresponding main-file transaction completes.
    const retain = options.retain ? new Set([...protectedKeys, ...committedKeys, ...options.retain]) : null;
    const kept = retain ? versions.filter(version => retain.has(versionKey(version))) : versions;
    await this.atomicWrite(this.historyFile(projectId, itemId), JSON.stringify({ projectId, itemId, versions: kept, protectedKeys, committedKeys }) + "\n", owned);
  }
  private needsMigration(doc: BoardDocument) {
    return doc.version === 1 || doc.items.some(item => item.history !== undefined || item.historyKeys === undefined || item.historyCount === undefined);
  }
  private async hasMissingReferences(doc: BoardDocument) {
    const empty = doc.items.filter(item => item.historyKeys?.length === 0);
    if (!empty.length) return false;
    const files = new Set(await readdir(path.join(this.root, "history")).catch(error => { if (missing(error)) return []; throw error; }));
    for (const item of empty) {
      if (files.has(path.basename(this.historyFile(doc.projectId, item.id))) && (await this.historyData(doc.projectId, item.id)).committedKeys?.length) return true;
    }
    return false;
  }
  /** Versions already embedded in v1 are committed. A sidecar is authoritative if the main file lost its references. */
  private async migrate(doc: BoardDocument, owned: () => Promise<void>) {
    if (!this.needsMigration(doc) && !await this.hasMissingReferences(doc)) return;
    let changed = doc.version !== 2;
    // Empty references can also have been stripped by a writer. List names once; never read bodies for ordinary empty notes.
    const candidates = doc.items.some(item => item.historyKeys?.length === 0);
    const files = new Set(candidates ? await readdir(path.join(this.root, "history")).catch(error => { if (missing(error)) return []; throw error; }) : []);
    for (const item of doc.items) {
      const legacy = doc.version === 1 || item.history !== undefined || item.historyKeys === undefined || item.historyCount === undefined;
      const empty = !item.historyKeys?.length && files.has(path.basename(this.historyFile(doc.projectId, item.id)));
      if (!legacy && !empty) continue;
      const saved = await this.historyData(doc.projectId, item.id), embedded = item.history ?? [];
      const versions = [...new Map([...saved.versions, ...embedded].map(version => [versionKey(version), version])).values()];
      const prior = item.historyKeys?.length ? item.historyKeys : saved.committedKeys ?? item.historyKeys ?? saved.protectedKeys;
      const keys = [...new Set([...prior, ...embedded.map(versionKey)])];
      // No ordinary version is pruned while rebuilding missing references.
      if ((versions.length || keys.length) && (legacy || JSON.stringify(saved.committedKeys) !== JSON.stringify(keys))) {
        await this.saveHistory(doc.projectId, item.id, versions, owned, { protect: embedded.map(versionKey), committed: keys });
      }
      if (item.history !== undefined || JSON.stringify(item.historyKeys) !== JSON.stringify(keys) || item.historyCount !== Math.min(10, keys.length)) changed = true;
      item.historyKeys = keys; item.historyCount = Math.min(10, keys.length); delete item.history;
    }
    // Every sidecar and its directory is durable before v1 history is removed and the format is sealed against old writers.
    if (changed) await this.save(doc, owned, true);
  }
  /** Main-file references decide the commit. A crash before this sidecar acknowledgement leaves a durable retry marker. */
  private async drainHistory(doc: BoardDocument, owned: () => Promise<void>) {
    if (!doc.pendingHistory?.length) return;
    for (const pending of doc.pendingHistory) {
      const id = typeof pending === "string" ? pending : pending.itemId;
      const item = doc.items.find(item => item.id === id); if (!item) continue;
      const saved = await this.historyData(doc.projectId, id);
      // New transactions redundantly carry their intended keys: losing the item fields must not acknowledge old keys.
      // A legacy marker without that intent is safe to finish only while the main file still carries its references.
      if (typeof pending === "string" && (item.historyKeys === undefined || (item.historyKeys.length === 0 && saved.committedKeys?.length))) throw new Error("历史提交记录不完整，已保留全部快照；请恢复同一份完整看板备份后重试。");
      const keys = typeof pending === "string" ? item.historyKeys! : pending.keys;
      await this.saveHistory(doc.projectId, id, saved.versions, owned, { committed: keys });
      item.historyKeys = keys; item.historyCount = Math.min(10, keys.length);
    }
    delete doc.pendingHistory; await this.save(doc, owned, true);
  }
  async readHistory(projectId: string, itemId: string): Promise<{ versions: NoteVersion[]; missing: boolean; missingCount: number; itemRevision: number }> {
    if (!projectId || projectId.length > 512 || !z.string().uuid().safeParse(itemId).success) throw new Error("无效手记");
    await this.queues.get(projectId)?.catch(() => {});
    return this.withLock(projectId, async owned => {
      const doc = await this.load(projectId); await this.drainRemovals(doc, owned); await this.drainHistory(doc, owned); await this.migrate(doc, owned);
      const item = doc.items.find(item => item.id === itemId);
      if (!item) throw new Error("这条记录已不存在，请刷新。");
      const { versions } = await this.historyData(projectId, itemId), present = new Set(versions.map(versionKey));
      const allKeys = item.historyKeys ?? [], keys = new Set(allKeys.slice(-10));
      const missingCount = allKeys.filter(key => !present.has(key)).length;
      return { versions: versions.filter(version => keys.has(versionKey(version))).slice(-10), missing: missingCount > 0, missingCount, itemRevision: item.revision };
    });
  }
  private async removeHistories(projectId: string, itemIds: readonly string[], owned: () => Promise<void>) {
    if (!itemIds.length) return;
    for (const itemId of itemIds) {
      await owned(); await unlink(this.historyFile(projectId, itemId)).catch(error => { if (!missing(error)) throw error; });
    }
    await this.syncDirectory(path.join(this.root, "history")).catch(error => { if (!missing(error)) throw error; });
  }
  /** The board commit records exactly which histories the user confirmed deleting. Finish that work after a crash. */
  private async drainRemovals(doc: BoardDocument, owned: () => Promise<void>) {
    const pending = new Set(doc.receipts.flatMap(receipt => receipt.removedIds ?? []));
    if (!pending.size) return;
    // A manually restored backup can bring a note back beside an old receipt. Its current history must survive.
    const present = new Set(doc.items.map(item => item.id));
    await this.removeHistories(doc.projectId, [...pending].filter(id => !present.has(id)), owned);
    for (const receipt of doc.receipts) delete receipt.removedIds;
    await this.save(doc, owned, true);
  }
  /** Null when the board file does not exist. Cached snapshots are shared: callers must not mutate them. */
  private async cached(name: string, messages: typeof SINGLE, known?: BigIntStats | null): Promise<CachedBoard | null> {
    const file = path.join(this.root, name);
    try {
      const current = known ?? await stat(file, { bigint: true });
      if (current.size > this.options.maxFileBytes) throw new BoardTooLarge(messages.tooLarge, Number(current.size));
      const hit = this.cache.get(name);
      if (hit?.key === statKey(current)) return hit;
      const handle = await open(file, "r");
      let raw: string, key: string;
      try {
        // Key by the opened inode: another writer may rename a newer board into place meanwhile.
        const opened = await handle.stat({ bigint: true });
        if (opened.size > this.options.maxFileBytes) throw new BoardTooLarge(messages.tooLarge, Number(opened.size));
        key = statKey(opened); raw = await handle.readFile("utf8");
      } finally { await handle.close(); }
      let doc: BoardDocument;
      try {
        doc = documentSchema.parse(JSON.parse(raw));
        if (this.boardFile(doc.projectId) !== name) throw new Error("project mismatch");
      } catch { throw new Error(messages.invalid); }
      if (this.needsMigration(doc) || doc.pendingHistory?.length || doc.receipts.some(receipt => receipt.removedIds?.length) || await this.hasMissingReferences(doc)) {
        await this.withLock(doc.projectId, async owned => { const latest = await this.load(doc.projectId); await this.drainRemovals(latest, owned); await this.drainHistory(latest, owned); await this.migrate(latest, owned); });
        if (statKey(await stat(file, { bigint: true })) !== key) return this.cached(name, messages);
      }
      const entry: CachedBoard = { key, token: createHash("sha256").update(raw).digest("hex").slice(0, 16), snapshot: this.snapshot(doc) };
      this.cache.set(name, entry); this.names.set(name, doc.projectId);
      return entry;
    } catch (e) { if (missing(e)) { this.cache.delete(name); return null; } throw e; }
  }
  private async entry(projectId: string, messages: typeof SINGLE): Promise<BoardEntry | null> {
    await this.queues.get(projectId)?.catch(() => {});
    return this.cached(this.boardFile(projectId), messages);
  }
  async read(projectId: string): Promise<BoardSnapshot> {
    if (!projectId || projectId.length > 512) throw new Error("无效项目");
    return (await this.entry(projectId, SINGLE))?.snapshot ?? { projectId, revision: 0, items: [] };
  }
  /** Every board within the size limits; readEntries() also reports the ones left out. */
  async readAll(): Promise<BoardSnapshot[]> { return (await this.readEntries()).entries.map(entry => entry.snapshot); }
  /**
   * All boards with content tokens, sorted by project ID. Stored boards are discovered too, so removing a Paseo project
   * never hides its notes. Only boards whose file changed are re-read. A board over the per-board limit, or past the
   * overview's total, is left out and reported instead of failing the whole overview.
   */
  async readEntries(): Promise<BoardEntries> {
    let files;
    try { files = await readdir(this.root, { withFileTypes: true }); }
    catch (e) { if (missing(e)) { this.cache.clear(); this.names.clear(); return { entries: [], unavailable: [] }; } throw e; }
    const names = files.filter(file => file.isFile() && BOARD_FILE.test(file.name)).map(file => file.name);
    const present = new Set(names);
    for (const name of this.cache.keys()) if (!present.has(name)) this.cache.delete(name);
    for (const name of this.names.keys()) if (!present.has(name)) this.names.delete(name);
    const stats = await mapLimit(names, READ_CONCURRENCY, name => stat(path.join(this.root, name), { bigint: true }).catch(e => { if (missing(e)) return null; throw e; }));
    // Smallest boards first: what does not fit is left out, never the whole overview, and the most projects stay visible.
    const sized = names.flatMap((name, index) => { const known = stats[index]; return known ? [{ name, known, bytes: Number(known.size) }] : []; })
      .sort((a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name));
    const unavailable: SkippedBoard[] = [], readable: typeof sized = [];
    const skip = (file: string, bytes: number, reason: SkippedBoard["reason"]) => { unavailable.push({ file, projectId: this.names.get(file) ?? null, bytes, reason }); };
    let total = 0;
    for (const board of sized) {
      if (board.bytes > this.options.maxFileBytes) skip(board.name, board.bytes, "file");
      else if (total + board.bytes > this.options.maxTotalBytes) skip(board.name, board.bytes, "total");
      else { total += board.bytes; readable.push(board); }
    }
    const entries = await mapLimit(readable, READ_CONCURRENCY, async ({ name, known }) => {
      try {
        const entry = await this.cached(name, OVERVIEW, known);
        // A write may have started after directory discovery. Use its committed snapshot.
        return entry && this.queues.has(entry.snapshot.projectId) ? await this.entry(entry.snapshot.projectId, OVERVIEW) : entry;
      } catch (e) {
        if (e instanceof BoardTooLarge) { skip(name, e.bytes, "file"); return null; } // grew past the limit since the stat
        throw e;
      }
    });
    return {
      entries: entries.filter((entry): entry is BoardEntry => entry !== null).sort((a, b) => a.snapshot.projectId.localeCompare(b.snapshot.projectId)),
      unavailable: unavailable.sort((a, b) => a.file.localeCompare(b.file)),
    };
  }
  private async syncDirectory(folder: string) {
    let dir;
    try { dir = await open(folder, "r"); await dir.sync(); }
    catch (error) {
      // Windows can refuse either opening or syncing a directory. File fsync remains mandatory on every platform.
      if (!["EINVAL", "ENOTSUP", "EBADF", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { await dir?.close(); }
  }
  private async atomicWrite(target: string, text: string, owned: () => Promise<void>) {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const folder = path.dirname(target);
    await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(folder, 0o700);
    const tmp = target + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await open(tmp, "wx", 0o600); await handle.writeFile(text, "utf8"); await handle.sync();
      await handle.close(); handle = undefined;
      await owned(); await rename(tmp, target);
      await this.syncDirectory(folder);
      if (folder !== this.root) await this.syncDirectory(this.root);
    } finally { await handle?.close().catch(() => {}); await unlink(tmp).catch(() => {}); }
  }
  private async save(doc: BoardDocument, owned: () => Promise<void>, cleanup = false, limitMessage = "此项目记录已达到存储上限，请先清空回收站或导出整理。"): Promise<void> {
    doc.version = 2;
    // Compact main files hold only current content. Reserve enough room to trash every active note, even at the limit.
    const reserve = cleanup ? 0 : doc.items.filter(item => item.deletedAt === null).length * 32 + 384;
    let text = JSON.stringify(doc) + "\n";
    // Cleanup must remain possible near the limit; discard oldest retry receipts before refusing it.
    while (cleanup && Buffer.byteLength(text) > this.options.maxFileBytes && doc.receipts.length > 1) {
      doc.receipts.shift(); text = JSON.stringify(doc) + "\n";
    }
    if (Buffer.byteLength(text) + reserve > this.options.maxFileBytes) throw new Error(limitMessage);
    const target = this.filename(doc.projectId);
    await this.atomicWrite(target, text, owned);
    this.cache.delete(path.basename(target)); this.names.set(path.basename(target), doc.projectId);
  }
  async write(raw: WriteBoardInput): Promise<{ board: BoardSnapshot; itemId: string; replayed: boolean }> {
    const input = writeBoardInputSchema.parse(raw);
    const previous = this.queues.get(input.projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.apply(input)); this.queues.set(input.projectId, next);
    try { return await next; } finally { if (this.queues.get(input.projectId) === next) this.queues.delete(input.projectId); }
  }
  /**
   * Serializes read-modify-write across processes with an exclusive lock file next to the board. A waiter takes a lock
   * over only when its holder has exited (or, when the holder cannot be checked, once the lock is clearly overdue), and
   * a holder removes the lock only while it is still its own.
   */
  private async withLock<T>(projectId: string, fn: (owned: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = this.filename(projectId) + ".lock", token = randomUUID(), me = await self();
    const record = JSON.stringify({ pid: process.pid, token, host: me.host, ns: me.ns, start: me.start, at: new Date().toISOString() }) + "\n";
    const deadline = Date.now() + this.options.waitMs;
    for (;;) {
      let handle;
      try { handle = await open(lock, "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      if (handle) {
        try { await handle.writeFile(record, "utf8"); await handle.close(); }
        catch (e) { await handle.close().catch(() => {}); await unlink(lock).catch(() => {}); throw e; }
        break;
      }
      const seen = await inspect(lock);
      if (!seen) continue; // released meanwhile
      if (await this.reclaimable(seen) && await this.reclaim(lock)) continue;
      if (Date.now() > deadline) throw new Error(`这个项目的记录正被另一个进程修改${seen.owner ? `（pid ${seen.owner.pid}）` : ""}，请稍后重试。`);
      await sleep(20 + Math.floor(Math.random() * 60));
    }
    try { return await fn(() => this.assertOwned(lock, token)); }
    finally { await this.release(lock, token); }
  }
  private async reclaimable(seen: SeenLock): Promise<boolean> {
    const state = await holderState(seen.owner);
    return state === "gone" || (state === "unknown" && seen.ageMs > this.options.staleMs);
  }
  /**
   * Removes a lock judged stale. Two waiters can judge the same stale lock; the slower one must not then delete the lock
   * the faster one has taken since. So a guard file admits one reclaimer at a time, and the lock is judged again under it.
   */
  private async reclaim(lock: string): Promise<boolean> {
    const guard = lock + ".reclaim";
    let handle;
    try { handle = await open(guard, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A guard lives for one check and one unlink. One this old was left by a reclaimer that died in between.
      const age = await stat(guard).then(info => Date.now() - info.mtimeMs, () => 0);
      if (age > this.options.staleMs) await unlink(guard).catch(() => {});
      return false;
    }
    try {
      const seen = await inspect(lock);
      if (!seen) return true;
      if (!(await this.reclaimable(seen))) return false;
      await unlink(lock).catch(e => { if (!missing(e)) throw e; });
      return true;
    } finally { await handle.close().catch(() => {}); await unlink(guard).catch(() => {}); }
  }
  /** Checked right before a board is committed: a writer whose lock was taken over must not overwrite the new holder's work. */
  private async assertOwned(lock: string, token: string): Promise<void> {
    if ((await inspect(lock))?.owner?.token !== token) throw new Error("写入期间这个项目的锁被其他进程接管，这次修改没有保存，请刷新后重试。");
  }
  /** Removes the lock only while it is still this writer's: a lock taken over meanwhile belongs to another writer now. */
  private async release(lock: string, token: string): Promise<void> {
    try { if ((await inspect(lock))?.owner?.token === token) await unlink(lock); }
    catch { /* a lock that cannot be read or removed waits for the holder check */ }
  }
  private apply(input: WriteBoardInput) { return this.withLock(input.projectId, owned => this.applyLocked(input, owned)); }
  private async applyLocked(input: WriteBoardInput, owned: () => Promise<void>) {
    const doc = await this.load(input.projectId);
    await this.drainRemovals(doc, owned);
    await this.drainHistory(doc, owned);
    await this.migrate(doc, owned);
    const hash = createHash("sha256").update(JSON.stringify(input.operation)).digest("hex");
    // A CLI retry resolves the current revision again. Its intent, unlike that precondition, stays the same.
    const { expectedRevision: _revision, ...intent } = input.operation as WriteBoardInput["operation"] & { expectedRevision?: number };
    const stableHash = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
    const receipt = doc.receipts.find(x => x.requestId === input.requestId);
    if (receipt) {
      if (receipt.stableHash ? receipt.stableHash !== stableHash : receipt.hash !== hash) throw new Error("请求标识已用于另一项修改，请刷新后重试。");
      return { board: this.snapshot(doc), itemId: receipt.itemId, replayed: true };
    }
    const contentSize = () => Buffer.byteLength(JSON.stringify(doc.items.map(item => ({ ...fieldsSchema.parse(item), deletedAt: item.deletedAt }))));
    const beforeContentBytes = contentSize();
    const now = new Date().toISOString(), op = input.operation; let itemId: string;
    let removedIds: string[] = [];
    if (op.type === "create") {
      if (doc.items.length >= 4000) throw new Error("此项目已达到 4000 条记录上限，请先导出整理。");
      itemId = randomUUID(); doc.items.unshift(storedItemSchema.parse({ ...op.fields, id: itemId, projectId: input.projectId, revision: 1, createdAt: now, updatedAt: now, deletedAt: null, historyCount: 0, historyKeys: [] }));
    } else if (op.type === "emptyTrash") {
      if (doc.revision !== op.expectedRevision) throw new Error("回收站已在另一台设备更新，请刷新后重新确认。");
      removedIds = doc.items.filter(item => item.deletedAt !== null).map(item => item.id);
      itemId = ""; doc.items = doc.items.filter(item => item.deletedAt === null);
    } else {
      itemId = op.id; const index = doc.items.findIndex(x => x.id === op.id);
      if (index < 0) throw new Error("这条记录已不存在，请刷新。");
      const existing = doc.items[index]!;
      if (existing.revision !== op.expectedRevision) throw new Error("这条记录已在另一台设备更新。你的草稿仍保留，请刷新记录后重新编辑。");
      if (op.type !== "restore" && op.type !== "purge" && op.type !== "repairHistory" && existing.deletedAt) throw new Error("这条记录已在回收站，请先恢复。");
      if (op.type === "restore" && !existing.deletedAt) throw new Error("这条记录已经恢复，请刷新。");
      if (op.type === "purge") {
        if (!existing.deletedAt) throw new Error("请先把这条记录移入回收站。");
        removedIds.push(itemId); doc.items.splice(index, 1);
      } else if (op.type === "repairHistory") {
        const saved = await this.historyData(input.projectId, itemId), present = new Set(saved.versions.map(versionKey));
        existing.historyKeys = (existing.historyKeys ?? saved.committedKeys ?? []).filter(key => present.has(key));
        existing.historyCount = Math.min(10, existing.historyKeys.length);
        existing.revision++; existing.updatedAt = now;
        doc.pendingHistory = [{ itemId, keys: [...existing.historyKeys] }];
      } else {
        const keys = new Set(existing.historyKeys?.slice(-10));
        const versions = op.type === "restoreVersion" ? (await this.history(input.projectId, itemId, existing.historyKeys)).filter(entry => keys.has(versionKey(entry))).slice(-10) : [];
        const version = versions.find(entry => entry.revision === (op.type === "restoreVersion" ? op.revision : -1));
        if (op.type === "restoreVersion" && !version) throw new Error("这个修改快照已不在最近 10 版中，请刷新。");
        const changes = op.type === "update" ? op.fields : version ? fieldsSchema.parse(version) : { deletedAt: op.type === "delete" ? now : null };
        const contentChanged = ("title" in changes && changes.title !== existing.title) || ("body" in changes && changes.body !== existing.body) || ("kind" in changes && changes.kind !== existing.kind);
        if (contentChanged) {
          const history = await this.history(input.projectId, itemId, existing.historyKeys);
          const candidate = noteVersionSchema.parse(existing);
          if (!history.some(entry => JSON.stringify(entry) === JSON.stringify(candidate))) history.push(candidate);
          // Do not trim before the board commits: a failed main write must not evict a valid old version.
          await this.saveHistory(input.projectId, itemId, history, owned, { retain: [...(existing.historyKeys ?? []), versionKey(candidate)], committed: existing.historyKeys ?? [] });
          existing.historyKeys = [...new Set([...(existing.historyKeys ?? []), versionKey(candidate)])].slice(-10);
          existing.historyCount = existing.historyKeys.length;
          doc.pendingHistory = [{ itemId, keys: [...existing.historyKeys] }];
        }
        doc.items[index] = storedItemSchema.parse({ ...existing, ...changes, revision: existing.revision + 1, updatedAt: now });
      }
    }
    doc.revision++; doc.receipts.push({ requestId: input.requestId, hash, stableHash, itemId, ...(removedIds.length ? { removedIds } : {}) }); doc.receipts = doc.receipts.slice(-300);
    const cleanup = ["delete", "purge", "emptyTrash", "restore", "repairHistory"].includes(op.type) || (op.type !== "create" && contentSize() <= beforeContentBytes);
    const limitMessage = op.type === "restore" ? "这条手记暂时无法恢复，请先导出整理其他手记后重试；它仍保留在回收站。" : undefined;
    await this.save(doc, owned, cleanup, limitMessage);
    await this.drainHistory(doc, owned);
    if (removedIds.length) await this.drainRemovals(doc, owned);
    // Keep all migrated versions on disk. Reads expose the latest ten committed content versions.
    return { board: this.snapshot(doc), itemId, replayed: false };
  }
}
