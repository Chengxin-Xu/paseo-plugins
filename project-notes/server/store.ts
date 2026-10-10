import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { mkdir, rename, open, unlink, chmod, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { itemSchema, snapshotSchema, writeBoardInputSchema, type BoardSnapshot, type WriteBoardInput } from "../shared/schema";

const documentSchema = snapshotSchema.extend({ version: z.literal(1), receipts: z.array(z.object({ requestId: z.string(), hash: z.string(), itemId: z.string() })) });
type BoardDocument = z.infer<typeof documentSchema>;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Cross-process lock: the plugin subprocess and the CLI (bin/notes.mjs) may write the same board. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const READ_CONCURRENCY = 8;
const BOARD_FILE = /^[a-f0-9]{64}\.json$/;
const SINGLE = { invalid: "记录文件校验失败，已保留原文件；请先备份检查，不会自动清空。", tooLarge: "记录文件过大，请先备份整理后再继续。" };
const OVERVIEW = { invalid: "某个项目的手记文件校验失败，已保留原文件；不会把读取失败当作空看板。", tooLarge: "手记总览数据较大，请先备份整理后再读取。" };
/** A board as last read from disk. `token` hashes the file bytes: every change, from any process or a manual edit, yields a new token. */
export interface BoardEntry { snapshot: BoardSnapshot; token: string }
type CachedBoard = BoardEntry & { key: string };
/** Writers replace boards by rename, so a new inode, size, mtime or ctime means the parsed copy is stale. */
function statKey(s: BigIntStats) { return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
function missing(e: unknown) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
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

/** Project IDs are hashed. Only plugin-owned files are written. */
export class BoardStore {
  private queues = new Map<string, Promise<unknown>>();
  /** Parsed boards by file name. Polling re-stats files instead of re-reading and re-validating them. */
  private cache = new Map<string, CachedBoard>();
  constructor(private readonly root = defaultStorageRoot(), private readonly lock = { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS }) {}
  private filename(projectId: string): string {
    return path.join(this.root, createHash("sha256").update(projectId).digest("hex") + ".json");
  }
  /** Fresh read for read-modify-write under the lock; never served from the cache. */
  private async load(projectId: string): Promise<BoardDocument> {
    let raw: string;
    try {
      const h = await open(this.filename(projectId), "r");
      try {
        if ((await h.stat()).size > MAX_FILE_BYTES) throw new Error(SINGLE.tooLarge);
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
      if (current.size > MAX_FILE_BYTES) throw new Error(messages.tooLarge);
      const hit = this.cache.get(name);
      if (hit?.key === statKey(current)) return hit;
      const handle = await open(file, "r");
      let raw: string, key: string;
      try {
        // Key by the opened inode: another writer may rename a newer board into place meanwhile.
        const opened = await handle.stat({ bigint: true });
        if (opened.size > MAX_FILE_BYTES) throw new Error(messages.tooLarge);
        key = statKey(opened); raw = await handle.readFile("utf8");
      } finally { await handle.close(); }
      let doc: BoardDocument;
      try {
        doc = documentSchema.parse(JSON.parse(raw));
        if (path.basename(this.filename(doc.projectId)) !== name) throw new Error("project mismatch");
      } catch { throw new Error(messages.invalid); }
      const entry: CachedBoard = { key, token: createHash("sha256").update(raw).digest("hex").slice(0, 16), snapshot: this.snapshot(doc) };
      this.cache.set(name, entry);
      return entry;
    } catch (e) { if (missing(e)) { this.cache.delete(name); return null; } throw e; }
  }
  private async entry(projectId: string, messages: typeof SINGLE): Promise<BoardEntry | null> {
    await this.queues.get(projectId)?.catch(() => {});
    return this.cached(path.basename(this.filename(projectId)), messages);
  }
  async read(projectId: string): Promise<BoardSnapshot> {
    if (!projectId || projectId.length > 512) throw new Error("无效项目");
    return (await this.entry(projectId, SINGLE))?.snapshot ?? { projectId, revision: 0, items: [] };
  }
  /** Discover stored projects too, so removing a Paseo project never hides its notes. */
  async readAll(): Promise<BoardSnapshot[]> { return (await this.readEntries()).map(entry => entry.snapshot); }
  /** All boards with content tokens, sorted by project ID. Only boards whose file changed are re-read. */
  async readEntries(): Promise<BoardEntry[]> {
    let files;
    try { files = await readdir(this.root, { withFileTypes: true }); }
    catch (e) { if (missing(e)) { this.cache.clear(); return []; } throw e; }
    const names = files.filter(file => file.isFile() && BOARD_FILE.test(file.name)).map(file => file.name);
    const present = new Set(names);
    for (const name of this.cache.keys()) if (!present.has(name)) this.cache.delete(name);
    const stats = await mapLimit(names, READ_CONCURRENCY, name => stat(path.join(this.root, name), { bigint: true }).catch(e => { if (missing(e)) return null; throw e; }));
    let bytes = 0;
    for (const s of stats) if (s) { bytes += Number(s.size); if (s.size > MAX_FILE_BYTES || bytes > MAX_FILE_BYTES) throw new Error(OVERVIEW.tooLarge); }
    const entries = await mapLimit(names.map((name, index) => [name, stats[index]] as const), READ_CONCURRENCY, async ([name, known]) => {
      const entry = known ? await this.cached(name, OVERVIEW, known) : null;
      // A write may have started after directory discovery. Use its committed snapshot.
      return entry && this.queues.has(entry.snapshot.projectId) ? await this.entry(entry.snapshot.projectId, OVERVIEW) : entry;
    });
    return entries.filter((entry): entry is BoardEntry => entry !== null).sort((a, b) => a.snapshot.projectId.localeCompare(b.snapshot.projectId));
  }
  private async save(doc: BoardDocument): Promise<void> {
    const text = JSON.stringify(doc, null, 2) + "\n";
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("此项目记录已达到存储上限，请先导出整理。");
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const target = this.filename(doc.projectId), tmp = target + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await open(tmp, "wx", 0o600); await handle.writeFile(text, "utf8"); await handle.sync();
      await handle.close(); handle = undefined; await rename(tmp, target); this.cache.delete(path.basename(target));
      try { const dir = await open(this.root, "r"); try { await dir.sync(); } finally { await dir.close(); } } catch {}
    } finally { await handle?.close().catch(() => {}); await unlink(tmp).catch(() => {}); }
  }
  async write(raw: WriteBoardInput): Promise<{ board: BoardSnapshot; itemId: string; replayed: boolean }> {
    const input = writeBoardInputSchema.parse(raw);
    const previous = this.queues.get(input.projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.apply(input)); this.queues.set(input.projectId, next);
    try { return await next; } finally { if (this.queues.get(input.projectId) === next) this.queues.delete(input.projectId); }
  }
  /** Serializes read-modify-write across processes with an exclusive lock file next to the board. */
  private async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = this.filename(projectId) + ".lock";
    const deadline = Date.now() + this.lock.waitMs;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        try { await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8"); } finally { await handle.close(); }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > this.lock.staleMs) { await unlink(lock).catch(() => {}); continue; }
        } catch (se) { if ((se as NodeJS.ErrnoException).code === "ENOENT") continue; throw se; }
        if (Date.now() > deadline) throw new Error("这个项目的记录正被另一个进程修改，请稍后重试。");
        await sleep(20 + Math.floor(Math.random() * 60));
      }
    }
    try { return await fn(); } finally { await unlink(lock).catch(() => {}); }
  }
  private apply(input: WriteBoardInput) { return this.withLock(input.projectId, () => this.applyLocked(input)); }
  private async applyLocked(input: WriteBoardInput) {
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
    await this.save(doc); return { board: this.snapshot(doc), itemId, replayed: false };
  }
}
