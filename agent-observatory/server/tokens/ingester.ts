import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { initialParser } from "./parser";
import { tailFile } from "./reader";
import { defaultRoots, MAX_ROOTS } from "./roots";
import { DAY, safeError, type Backfill, type Candidate, type LedgerCall, type LogFile, type LogRoot } from "./types";
import { TOKEN_IMPORT_LIMITS, type TokenImportLimits } from "../../shared/tokens";
/** Work and memory budgets (TOKEN_IMPORT_LIMITS): logs tracked, their total bytes, dedupe keys and directory entries per scan. */
export type IngesterLimits = TokenImportLimits;
export interface IngesterTruncation { files: boolean; bytes: boolean; index: boolean; scan: boolean }
export interface IngesterOptions {
  roots?: LogRoot[]; now?: () => number; limits?: Partial<IngesterLimits>;
  onCall: (call: LedgerCall, previous: LedgerCall | null) => void;
  /** A distinct next response closes the previous call; EOF stays open for later blocks. */
  onSettle?: (call: LedgerCall) => void;
  onChange?: () => void;
}

/**
 * Dedupe keys are kept this long. Past the floor an unseen call can only be copied history (a resumed or forked session
 * re-writes old lines with their original timestamps), so it is dropped instead of being counted twice.
 */
const SEEN_DAYS = 60;

/** Owns file cursors and the global, persisted 64-bit dedupe index, not a full call history. */
export class TokenIngester {
  readonly roots: Array<LogRoot & { files: number; error: string | null }>;
  /** Roots added while running (a custom provider's config directory): their first import ignores `seenFloor`. */
  private readonly lateRoots = new Set<number>();
  readonly files = new Map<string, LogFile>();
  readonly seen = new Map<string, number>();
  /** Keys older than this were pruned from `seen`; null until the first prune after the initial import. */
  seenFloor: number | null = null;
  readonly backfill: Backfill = { done: false, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 };
  readonly diagnostics = { calls: 0, duplicates: 0, corrections: 0, bytesRead: 0 };
  readonly limits: IngesterLimits;
  /** Which budget cut the last scan (files, bytes, scan) or the dedupe index (until the plugin restarts). */
  readonly truncated: IngesterTruncation = { files: false, bytes: false, index: false, scan: false };
  private readonly now: () => number;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: IngesterOptions) {
    this.now = options.now ?? Date.now;
    this.limits = { ...TOKEN_IMPORT_LIMITS, ...options.limits };
    this.roots = (options.roots ?? defaultRoots()).slice(0, MAX_ROOTS).map(root => ({ ...root, files: 0, error: null }));
  }
  /**
   * Appends roots (never reorders: saved files refer to roots by index) and skips paths already watched. `late`
   * roots appear after the first import; nothing in them was seen before, so their first import keeps calls older
   * than the dedupe window instead of treating them as copied history. Returns how many were added.
   */
  addRoots(roots: readonly LogRoot[], late = true): number {
    let added = 0;
    for (const root of roots) {
      if (this.roots.length >= MAX_ROOTS) break;
      if (this.roots.some(other => resolve(other.path) === resolve(root.path))) continue;
      this.roots.push({ source: root.source, path: root.path, files: 0, error: null });
      if (late) this.lateRoots.add(this.roots.length - 1);
      added++;
    }
    return added;
  }
  private changed(): void { this.options.onChange?.(); }
  private consume(candidate: Candidate, previous: Candidate | null, phase: "original" | "fork" | "all", settled?: Candidate | null, fresh = false): void {
    if (settled?.accepted) this.options.onSettle?.(settled.call);
    const call = candidate.call;
    if (call.at < this.now() - 400 * DAY || call.at > this.now() + DAY) return;
    if ((phase === "original" && candidate.forked) || (phase === "fork" && !candidate.forked)) return;
    if (previous?.accepted && previous.call.key === call.key) {
      candidate.accepted = true;
      if (call.at === previous.call.at && call.start === previous.call.start && call.output === previous.call.output && call.reasoning === previous.call.reasoning) { this.diagnostics.duplicates++; return; }
      this.seen.set(call.key, call.at); this.diagnostics.corrections++;
      this.options.onCall(call, previous.call); this.changed(); return;
    }
    if (this.seen.has(call.key) || (!fresh && this.seenFloor !== null && call.at < this.seenFloor)) { this.diagnostics.duplicates++; return; }
    this.seen.set(call.key, call.at); candidate.accepted = true; this.diagnostics.calls++;
    if (this.seen.size > this.limits.index) this.trimSeen();
    this.options.onCall(call, null); this.changed();
  }
  /**
   * Keeps the newest 90 % of the index cap. Calls older than the oldest key kept are then treated like expired keys:
   * copied history, dropped instead of counted again.
   */
  private trimSeen(): void {
    const times = [...this.seen.values()].sort((a, b) => b - a), floor = times[Math.max(0, Math.floor(this.limits.index * 0.9) - 1)];
    for (const [key, at] of this.seen) if (at < floor) this.seen.delete(key);
    this.seenFloor = Math.max(this.seenFloor ?? floor, floor);
    this.truncated.index = true;
  }
  /**
   * Directory traversal ignores symlinks and tolerates vanished/unreadable entries. It visits at most `scanEntries`
   * entries; new logs are admitted newest first while the file and byte budgets last. A walk cut short keeps the
   * files it did not reach.
   */
  async scan(): Promise<LogFile[]> {
    const added: LogFile[] = [], found = new Set<string>(), candidates: Array<{ path: string; root: number; source: LogRoot["source"]; details: Stats }> = [];
    let lastYield = performance.now(), visited = 0, stopped = false;
    for (const [rootIndex, root] of this.roots.entries()) {
      root.files = 0; root.error = null;
      const walk = async (path: string, depth: number): Promise<void> => {
        let entries;
        try { entries = await readdir(path, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); return; }
        for (const entry of entries) {
          if (stopped || ++visited > this.limits.scanEntries) { stopped = true; return; }
          const child = join(path, entry.name);
          if (entry.isDirectory() && depth < 12) await walk(child, depth + 1);
          else if (entry.isFile() && entry.name.endsWith(".jsonl") && (root.source === "claude" || entry.name.startsWith("rollout-"))) {
            found.add(child); root.files++;
            if (!this.files.has(child)) {
              try { const details = await lstat(child); if (details.isFile()) candidates.push({ path: child, root: rootIndex, source: root.source, details }); }
              catch (error) { root.error = safeError(error); }
            }
          }
          if (performance.now() - lastYield >= 20) { await yieldLoop(); lastYield = performance.now(); }
        }
      };
      await walk(root.path, 0);
      if (stopped) break;
    }
    let bytes = 0, overFiles = false, overBytes = false;
    for (const file of this.files.values()) bytes += file.size;
    candidates.sort((a, b) => b.details.mtimeMs - a.details.mtimeMs || a.path.localeCompare(b.path));
    for (const { path, root, source, details } of candidates) {
      if (this.files.size >= this.limits.files) { overFiles = true; continue; }
      if (bytes + details.size > this.limits.bytes) { overBytes = true; continue; }
      const parentSession = source === "claude" && basename(dirname(path)) === "subagents" ? basename(dirname(dirname(path))) : null;
      const file: LogFile = { path, root, source, parentSession, dev: details.dev, ino: details.ino, size: details.size, mtime: details.mtimeMs, offset: 0, partialBytes: 0,
        state: initialParser(path, parentSession), imported: false };
      this.files.set(path, file); added.push(file); bytes += details.size;
    }
    if (!stopped) for (const [path, file] of this.files) if (!found.has(path) && !this.roots[file.root]?.error) {
      if (file.state.open?.accepted) this.options.onSettle?.(file.state.open.call);
      this.files.delete(path);
    }
    Object.assign(this.truncated, { files: overFiles, bytes: overBytes, scan: stopped });
    added.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    return added;
  }
  private async read(file: LogFile, phase: "original" | "fork" | "all", progress = false): Promise<void> {
    const oldState = file.state, fresh = !file.imported && this.lateRoots.has(file.root);
    try {
      if (await tailFile(file, (call, previous, _file, settled) => this.consume(call, previous, phase, settled, fresh), bytes => {
        this.diagnostics.bytesRead += bytes;
        if (progress) this.backfill.bytesDone = Math.min(this.backfill.bytes, this.backfill.bytesDone + bytes);
      })) this.changed();
    } catch (error) { const root = this.roots[file.root]; if (root) root.error = safeError(error); this.changed(); }
    finally { if (file.state !== oldState && oldState.open?.accepted) this.options.onSettle?.(oldState.open.call); }
  }
  /** Originals across all files win before copied fork history; the second pass only visits files with forks. */
  private async importFiles(files: LogFile[], progress = false): Promise<void> {
    for (const file of files) {
      if (this.closed) return;
      await this.read(file, file.imported ? "all" : "original", progress);
      if (progress) { this.backfill.filesDone++; this.changed(); }
    }
    for (const file of files) {
      if (this.closed) return;
      if (file.imported) continue;
      if (!file.state.hasForks || file.source !== "claude") { file.imported = true; continue; }
      const second: LogFile = { ...file, offset: 0, state: initialParser(file.path, file.parentSession) };
      await this.read(second, "fork");
      if (second.state.open?.accepted) file.state.open = second.state.open;
      file.imported = true;
    }
  }
  async backfillAll(): Promise<void> {
    await this.scan();
    const files = [...this.files.values()].sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    this.backfill.files = files.length; this.backfill.filesDone = 0;
    this.backfill.bytes = files.reduce((n, f) => n + f.size, 0);
    this.backfill.bytesDone = files.reduce((n, f) => n + Math.min(f.offset, f.size), 0);
    this.changed();
    await this.importFiles(files, true);
    this.backfill.done = !this.closed; this.changed();
  }
  poll(rescan = false): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.closed) return;
      const added = rescan ? await this.scan() : [];
      if (added.length) { await this.importFiles(added); this.changed(); }
      const newPaths = new Set(added.map(file => file.path));
      for (const file of this.files.values()) {
        if (this.closed) break;
        // The 30s rescan also stats cold files so a resumed old session becomes hot.
        if (!newPaths.has(file.path) && (rescan || file.mtime >= this.now() - 900_000)) await this.read(file, "all");
      }
      if (rescan) {
        const cutoff = this.now() - SEEN_DAYS * DAY;
        for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
        this.seenFloor = Math.max(this.seenFloor ?? cutoff, cutoff);
      }
    }).catch(() => {});
    return this.pending;
  }
  async close(): Promise<void> { this.closed = true; await this.pending; }
}
