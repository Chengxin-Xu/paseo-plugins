import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { mkdir, rename, open, unlink, chmod, readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { BOARD_FILE_LIMIT_BYTES, OVERVIEW_LIMIT_BYTES, itemSchema, snapshotSchema, writeBoardInputSchema, type BoardSnapshot, type UnavailableBoard, type WriteBoardInput } from "../shared/schema";

const documentSchema = snapshotSchema.extend({ version: z.literal(1), receipts: z.array(z.object({ requestId: z.string(), hash: z.string(), itemId: z.string() })) });
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
      if (missing(e)) return { version: 1, projectId, revision: 0, items: [], receipts: [] };
      throw e;
    }
    try {
      const doc = documentSchema.parse(JSON.parse(raw));
      if (doc.projectId !== projectId) throw new Error("project mismatch");
      return doc;
    } catch { throw new Error(SINGLE.invalid); }
  }
  private snapshot(doc: BoardDocument): BoardSnapshot { return { projectId: doc.projectId, revision: doc.revision, items: doc.items }; }
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
  private async save(doc: BoardDocument, owned: () => Promise<void>): Promise<void> {
    const text = JSON.stringify(doc, null, 2) + "\n";
    if (Buffer.byteLength(text) > this.options.maxFileBytes) throw new Error("此项目记录已达到存储上限，请先导出整理。");
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const target = this.filename(doc.projectId), tmp = target + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await open(tmp, "wx", 0o600); await handle.writeFile(text, "utf8"); await handle.sync();
      await handle.close(); handle = undefined;
      await owned();
      await rename(tmp, target); this.cache.delete(path.basename(target)); this.names.set(path.basename(target), doc.projectId);
      try { const dir = await open(this.root, "r"); try { await dir.sync(); } finally { await dir.close(); } } catch {}
    } finally { await handle?.close().catch(() => {}); await unlink(tmp).catch(() => {}); }
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
    const hash = createHash("sha256").update(JSON.stringify(input.operation)).digest("hex");
    const receipt = doc.receipts.find(x => x.requestId === input.requestId);
    if (receipt) {
      if (receipt.hash !== hash) throw new Error("请求标识已用于另一项修改，请刷新后重试。");
      return { board: this.snapshot(doc), itemId: receipt.itemId, replayed: true };
    }
    const now = new Date().toISOString(), op = input.operation; let itemId: string;
    if (op.type === "create") {
      if (doc.items.length >= 4000) throw new Error("此项目已达到 4000 条记录上限，请先导出整理。");
      itemId = randomUUID(); doc.items.unshift(itemSchema.parse({ ...op.fields, id: itemId, projectId: input.projectId, revision: 1, createdAt: now, updatedAt: now, deletedAt: null }));
    } else {
      itemId = op.id; const index = doc.items.findIndex(x => x.id === op.id);
      if (index < 0) throw new Error("这条记录已不存在，请刷新。");
      const existing = doc.items[index]!;
      if (existing.revision !== op.expectedRevision) throw new Error("这条记录已在另一台设备更新。你的草稿仍保留，请刷新记录后重新编辑。");
      if (op.type !== "restore" && existing.deletedAt) throw new Error("这条记录已在回收站，请先恢复。");
      if (op.type === "restore" && !existing.deletedAt) throw new Error("这条记录已经恢复，请刷新。");
      const changes = op.type === "update" ? op.fields : { deletedAt: op.type === "delete" ? now : null };
      doc.items[index] = itemSchema.parse({ ...existing, ...changes, revision: existing.revision + 1, updatedAt: now });
    }
    doc.revision++; doc.receipts.push({ requestId: input.requestId, hash, itemId }); doc.receipts = doc.receipts.slice(-300);
    await this.save(doc, owned); return { board: this.snapshot(doc), itemId, replayed: false };
  }
}
