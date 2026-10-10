import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { PaseoApi } from "../paseo-types";
import type { StatsRange } from "../../shared/stats";
import type { TokenImportLimits, TokenResponse, TokenSnapshot } from "../../shared/tokens";
import { StatsDirectory } from "../stats-directory";
import { telemetryDirectory } from "../telemetry";
import { addCall, emptyData, pruneData, settleCall, type TokenData } from "./data";
import { TokenIngester } from "./ingester";
import { TokenPersistence } from "./persistence";
import { providerRoots, rootIdentity, type RootContext } from "./roots";
import { buildTokenSnapshot } from "./snapshot";
import { DAY, dayOf, iso, safeError, type LogRoot } from "./types";

/** The daemon config is read for custom provider log roots at most this often. */
const DISCOVERY_MS = 5 * 60_000;
export interface TokenStoreOptions {
  directory?: string; agents?: StatsDirectory; roots?: LogRoot[]; now?: () => number;
  /** Deterministic tests and standalone verification can drive polling themselves. */
  poll?: boolean;
  /** Home, environment and launcher reads for provider root discovery (tests). */
  rootContext?: RootContext;
  /** Smaller import budgets (tests); the defaults are TOKEN_IMPORT_LIMITS. */
  limits?: Partial<TokenImportLimits>;
}
export class TokenStore {
  data: TokenData = emptyData();
  readonly ingester: TokenIngester;
  readonly directory: StatsDirectory;
  readonly persistence: TokenPersistence;
  readonly initialized: Promise<void>;
  readonly ready: Promise<void>;
  private readonly now: () => number;
  private change = 0;
  private dirty = false;
  private closed = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private lastScan = 0;
  private lastPrune = 0;
  private discoveredAt = -Infinity;
  private discovering: Promise<void> | null = null;
  private readonly rootContext: RootContext;
  private cached = new Map<string, Extract<TokenResponse, { mode: "full" }>>();
  constructor(options: TokenStoreOptions = {}) {
    this.now = options.now ?? Date.now; this.directory = options.agents ?? new StatsDirectory(this.now);
    this.rootContext = options.rootContext ?? { home: homedir(), env: process.env };
    this.persistence = new TokenPersistence(options.directory ?? telemetryDirectory());
    this.ingester = new TokenIngester({ roots: options.roots, now: this.now, limits: options.limits,
      onCall: (call, previous) => {
        addCall(this.data, call, previous, this.now());
        if (this.data.sessions.size > 5100) pruneData(this.data, this.now());
      }, onSettle: call => settleCall(this.data, call, this.now()), onChange: () => this.changed() });
    this.initialized = this.persistence.restore(this.ingester).then(async saved => {
      this.data = saved.data; this.change += saved.change;
      pruneData(this.data, this.now()); this.lastPrune = dayOf(this.now());
      await this.ingester.scan();
    });
    this.ready = this.initialized.then(() => this.ingester.backfillAll()).catch(error => {
      console.warn(`Token 导入失败（${safeError(error)}）。`);
    }).finally(() => {
      this.lastScan = this.now();
      if (options.poll !== false) this.schedulePoll();
    });
  }
  private changed(): void { this.change++; this.dirty = true; this.cached.clear(); this.scheduleWrite(); }
  private scheduleWrite(): void {
    if (this.closed || this.writeTimer) return;
    // Offsets are saved with the counts they produced, so a crash only re-reads the last minute of log bytes.
    this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush(); }, 60_000);
    this.writeTimer.unref?.();
  }
  private schedulePoll(): void {
    if (this.closed || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, 2000);
    this.pollTimer.unref?.();
  }
  async poll(forceScan = false): Promise<void> {
    await this.ready;
    if (this.closed) return;
    const now = this.now(), rescan = forceScan || now - this.lastScan >= 30_000;
    await this.ingester.poll(rescan);
    if (rescan) this.lastScan = now;
    if (dayOf(now) !== this.lastPrune) { pruneData(this.data, now); this.lastPrune = dayOf(now); this.changed(); }
    else for (const [key, call] of this.data.recent) if (call.at < now - 75 * 60_000) this.data.recent.delete(key);
  }
  /**
   * Custom providers (`extends: "claude" | "codex"`) that keep their logs elsewhere, from the daemon's provider config:
   * their `env` or launcher text (see ./roots). New roots are watched from the next scan. Read at most every 5 minutes.
   */
  discover(paseo: PaseoApi): Promise<void> {
    if (this.discovering) return this.discovering;
    if (this.closed || this.now() - this.discoveredAt < DISCOVERY_MS) return Promise.resolve();
    this.discoveredAt = this.now();
    this.discovering = (async () => {
      await this.initialized;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { config } = await Promise.race([paseo.config.get(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 10_000); timer.unref?.();
      })]).finally(() => clearTimeout(timer));
      const found = await providerRoots(config.providers as Record<string, unknown> | undefined, this.rootContext);
      const known = new Set(await Promise.all(this.ingester.roots.map(root => rootIdentity(root.path))));
      const fresh: LogRoot[] = [];
      for (const root of found) {
        const identity = await rootIdentity(root.path);
        if (!known.has(identity)) { known.add(identity); fresh.push({ source: root.source, path: root.path }); }
      }
      if (this.closed || !this.ingester.addRoots(fresh)) return;
      this.changed();
      void this.poll(true);
    })().catch(() => { /* the default roots keep working; the next read retries after the interval */ })
      .finally(() => { this.discovering = null; });
    return this.discovering;
  }
  coverage(): TokenSnapshot["coverage"] {
    return { earliestAt: this.data.earliestAt === null ? null : iso(this.data.earliestAt), latestAt: this.data.latestAt === null ? null : iso(this.data.latestAt),
      backfill: { ...this.ingester.backfill }, roots: this.ingester.roots.map(root => ({ ...root, path: root.path.slice(0, 1024) })), truncated: { ...this.ingester.truncated } };
  }
  async read(input: { range: StatsRange; utcOffsetMinutes: number; revision?: string }, paseo?: PaseoApi): Promise<TokenResponse> {
    await this.initialized;
    if (paseo) await this.directory.refresh(paseo);
    const now = this.now(), today = Math.floor((now + input.utcOffsetMinutes * 60_000) / DAY);
    if (dayOf(now) !== this.lastPrune) { pruneData(this.data, now); this.lastPrune = dayOf(now); this.changed(); }
    const revision = createHash("sha256").update(JSON.stringify([this.change, input.range, input.utcOffsetMinutes, today, this.directory.digest, this.ingester.roots, this.ingester.backfill, this.ingester.truncated])).digest("hex").slice(0, 24);
    if (input.revision === revision) return { mode: "unchanged", unchanged: true, revision };
    const cached = this.cached.get(revision); if (cached) return cached;
    const result: Extract<TokenResponse, { mode: "full" }> = { ...buildTokenSnapshot(this.data, input, now, this.directory, this.coverage()), mode: "full", unchanged: false, revision };
    this.cached.set(revision, result);
    if (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value!);
    return result;
  }
  /** Serialized writes cannot interleave checkpoints. No periodic write occurs while clean. */
  flush(durable = false): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    this.writes = this.writes.then(async () => {
      await this.initialized;
      if (!this.dirty) return;
      pruneData(this.data, this.now());
      const change = this.change, payload = this.persistence.serialize(this.data, this.ingester, change);
      if (await this.persistence.write(payload, durable)) this.dirty = this.change !== change;
    }).catch(error => { console.warn(`Token 保存失败（${safeError(error)}）。`); }).finally(() => { if (this.dirty) this.scheduleWrite(); });
    return this.writes;
  }
  async close(): Promise<void> {
    if (this.closed) { await this.writes; return; }
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.writeTimer) clearTimeout(this.writeTimer);
    await this.ingester.close(); await this.ready; await this.flush(true);
  }
}
