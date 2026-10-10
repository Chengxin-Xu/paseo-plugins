import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi, AgentTimelineItem } from "./paseo-types";
import { addStatsMetrics, emptyStatsMetrics, statsMetricsSchema, statsToolSchema, type StatsMetrics,
  type StatsRange, type StatsResponse, type StatsSnapshot, type StatsTool, type ToolKind } from "../shared/stats";
import type { ActivityMetrics, AnalyticsSnapshot } from "../shared/analytics";
import type { TelemetrySnapshot, TurnOutcome } from "../shared/telemetry";
import { telemetryDirectory, type TelemetryStore } from "./telemetry";
import { StatsDirectory } from "./stats-directory";
import { settleWithin, type BackgroundTracker } from "./background";
import { buildStatsSnapshot } from "./stats-snapshot";
import { extractTurnContent } from "./turn-content";
import { STATS_DAY_MS as DAY, STATS_HOUR_MS as HOUR, statsDay, statsHour,
  type StatsAgentRecord, type StatsAttribution, type StatsHour, type StatsToolDay } from "./stats-types";

const MAX_HOURS = 92 * 24, MAX_ATTRIBUTIONS = 20_000, MAX_AGENTS = 2_000, MAX_TOOL_DAYS = 92;
const MAX_TURN_MS = 12 * HOUR, WRITE_DELAY = 20_000, MAX_FILE_BYTES = 64 * 1024 * 1024;
const id = z.string().min(1).max(256), time = z.number().finite().nonnegative();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/), iso = z.iso.datetime();
const recordSchema = z.object({ agentId: id, lastKey: z.string().nullable(), maxTurnMs: time, maxTurnAt: iso.nullable(), updatedAt: time });
const savedSchema = z.object({ version: z.literal(1), change: z.number().int().nonnegative(), backfilled: z.boolean(),
  observedSince: iso.nullable(), contentSince: iso,
  hours: z.array(statsMetricsSchema.extend({ hour: iso })).max(MAX_HOURS),
  attributions: z.array(statsMetricsSchema.extend({ agentId: id, day, lastActiveAt: iso })).max(MAX_ATTRIBUTIONS),
  toolDays: z.array(z.object({ day, tools: z.array(statsToolSchema).max(60), kinds: z.array(statsToolSchema).max(8).optional() })).max(MAX_TOOL_DAYS),
  records: z.array(recordSchema).max(MAX_AGENTS), running: z.array(z.tuple([id, time])),
  permissions: z.array(z.object({ agentId: id, requests: z.array(z.tuple([z.string().max(64), time])).max(32) })),
});

export type StatsObservation =
  | { type: "turn_started"; agentId: string }
  | { type: "turn_ended"; agentId: string; outcome: TurnOutcome; timeline: readonly AgentTimelineItem[] }
  | { type: "permission_requested" | "permission_resolved"; agentId: string; requestId: string };
export interface StatsStoreOptions {
  directory?: string; now?: () => number;
  /** Shared directory walker (a private one is created when omitted). */
  agents?: StatsDirectory;
  telemetry?: Pick<TelemetryStore, "analyticsSnapshot" | "snapshot"> & Partial<Pick<TelemetryStore, "awaitingAgents">>;
  /** Provider subagents still working after their parent's turn (后台执行中). */
  background?: Pick<BackgroundTracker, "sync" | "runningIds">;
}

function activity(metrics: ActivityMetrics): StatsMetrics {
  return { ...emptyStatsMetrics(), turns: Math.floor(metrics.started), completed: Math.floor(metrics.completed),
    failed: Math.floor(metrics.failed), canceled: Math.floor(metrics.canceled), runMs: metrics.runMs,
    runSamples: Math.floor(metrics.runSamples), waitMs: metrics.waitMs };
}

/**
 * Hooks are synchronous and only inspect the new timeline suffix. Register them after `ready`:
 * this establishes the telemetry backfill boundary before live observation begins.
 * No prompt, tool arguments, outputs, or file paths are retained.
 */
export class StatsStore {
  readonly ready: Promise<void>;
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly directoryCache: StatsDirectory;
  private readonly replies?: Pick<TelemetryStore, "awaitingAgents">;
  private readonly background?: StatsStoreOptions["background"];
  private readonly hours = new Map<string, StatsHour>();
  private readonly attributions = new Map<string, StatsAttribution>();
  private readonly attributionDays = new Map<string, Set<string>>();
  private readonly toolDays = new Map<string, Map<string, StatsTool>>();
  private readonly toolKinds = new Map<string, Map<ToolKind, StatsTool>>();
  private readonly records = new Map<string, StatsAgentRecord>();
  private readonly running = new Map<string, number>();
  /** When each Agent's latest turn ended, to overrule a directory walk that still shows it running. */
  private readonly ended = new Map<string, number>();
  private readonly permissions = new Map<string, Map<string, number>>();
  private observedSince: string | null = null;
  private contentSince: string;
  private backfilled = false;
  private change = 0;
  private lastAdvance: number;
  private prunedHour = "";
  private dirty = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes = Promise.resolve();
  private memo = new Map<string, { revision: string; snapshot: StatsSnapshot }>();
  private initialized = false;
  private storageReadable = true;

  constructor(options: StatsStoreOptions = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "stats.json");
    this.now = options.now ?? Date.now; this.lastAdvance = this.now();
    this.contentSince = new Date(this.lastAdvance).toISOString();
    this.directoryCache = options.agents ?? new StatsDirectory(this.now);
    if (options.telemetry?.awaitingAgents) this.replies = options.telemetry as Pick<TelemetryStore, "awaitingAgents">;
    this.background = options.background;
    // Restore before returning the synchronous plugin contribution, so lifecycle IPC cannot
    // fall into an asynchronous reload gap. Writes remain off the lifecycle path.
    this.restore();
    if (this.backfilled) {
      this.initialized = true; this.ready = Promise.resolve(); this.prune(this.now());
      if (this.dirty) this.scheduleWrite();
      return;
    }
    this.ready = this.initialize(options.telemetry).catch(() => {
      // Storage/source errors cannot prevent the plugin's other contributions from loading.
      this.observedSince ??= this.contentSince;
      this.backfilled = true; this.changed();
    }).finally(() => {
      this.lastAdvance = this.now();
      this.contentSince = new Date(this.lastAdvance).toISOString();
      this.initialized = true;
      this.prune(this.now());
      if (this.dirty) this.scheduleWrite();
    });
  }

  record(observation: StatsObservation): void {
    if (this.closed || !this.initialized) return;
    try {
      const at = this.now();
      if (!observation.agentId || observation.agentId.length > 256 || !Number.isFinite(at) || at < 0) return;
      this.applySafely(observation, at);
    } catch { /* A malformed provider item must never escape a lifecycle hook. */ }
  }

  private applySafely(observation: StatsObservation, at: number): void {
    try {
      this.advance(at);
      const agentId = observation.agentId, state = this.agent(agentId, at);
      switch (observation.type) {
        case "turn_started":
          this.running.set(agentId, at);
          this.add(agentId, at, { turns: 1 });
          this.observePeak(at);
          break;
        case "turn_ended": {
          const start = this.running.get(agentId);
          const delta: Partial<StatsMetrics> = { [observation.outcome]: 1 };
          if (start !== undefined) {
            const ms = Math.max(0, at - start); delta.runMs = ms; delta.runSamples = 1;
            if (ms > state.maxTurnMs || state.maxTurnAt === null) { state.maxTurnMs = ms; state.maxTurnAt = new Date(at).toISOString(); }
          }
          this.running.delete(agentId);
          this.ended.delete(agentId); this.ended.set(agentId, at);
          while (this.ended.size > MAX_AGENTS) this.ended.delete(this.ended.keys().next().value!);
          this.add(agentId, at, delta);
          const content = extractTurnContent(observation.timeline, state.lastKey);
          state.lastKey = content.lastKey;
          this.add(agentId, at, content.metrics);
          this.addTools(at, content.tools);
          break;
        }
        case "permission_requested": {
          const requests = this.permissions.get(agentId) ?? new Map<string, number>();
          const key = createHash("sha256").update(observation.requestId).digest("hex");
          if (!requests.has(key)) {
            requests.set(key, at);
            while (requests.size > 32) requests.delete(requests.keys().next().value!);
            this.permissions.set(agentId, requests); this.add(agentId, at, { approvals: 1 });
          }
          break;
        }
        case "permission_resolved": {
          const requests = this.permissions.get(agentId), key = createHash("sha256").update(observation.requestId).digest("hex");
          const start = requests?.get(key);
          if (start !== undefined) { this.add(agentId, at, { waitMs: Math.max(0, at - start) }); requests!.delete(key); }
          if (!requests?.size) this.permissions.delete(agentId);
          break;
        }
      }
      this.changed(); this.prune(at);
    } catch { /* Keep all other lifecycle consumers operational. */ }
  }

  async read(input: { range: StatsRange; utcOffsetMinutes: number; revision?: string }, paseo: PaseoApi): Promise<StatsResponse> {
    await this.ready;
    await this.directoryCache.refresh(paseo);
    if (this.background) await settleWithin(this.background.sync(this.directoryCache.agents, this.directoryCache.refreshedAt), 4_000);
    const now = this.now();
    // Commit the partial advance once. A later read/end starts at this new boundary.
    this.advance(now);
    if (this.directoryCache.loaded) {
      const known = new Map(this.directoryCache.agents.map(agent => [agent.id, agent]));
      for (const [agentId, start] of this.running) {
        const agent = known.get(agentId);
        // Cached idle descriptors pre-dating a new hook cannot invalidate that turn.
        if (agent && agent.status !== "running" && !agent.activeTurn && start <= this.directoryCache.refreshedAt) {
          this.running.delete(agentId); this.changed();
        }
      }
    }
    this.prune(now);
    const awaiting = this.replies?.awaitingAgents(this.directoryCache.agents) ?? new Set<string>();
    const walkedAt = this.directoryCache.refreshedAt, background = this.background?.runningIds() ?? new Set<string>();
    // A turn that ended after the walk is over, even while the cached walk still shows it running.
    const ended = new Set([...this.ended].filter(([agentId, at]) => at > walkedAt && !this.running.has(agentId)).map(([agentId]) => agentId));
    const revision = createHash("sha256").update(JSON.stringify([this.change, this.directoryCache.digest,
      input.range, input.utcOffsetMinutes, statsDay(now + input.utcOffsetMinutes * 60_000), [...this.running.keys()].sort(), [...awaiting].sort(),
      [...background].sort(), [...ended].sort()])).digest("hex").slice(0, 24);
    if (input.revision === revision) return { mode: "unchanged", unchanged: true, revision };
    const key = `${input.range}:${input.utcOffsetMinutes}`, cached = this.memo.get(key);
    let snapshot = cached?.revision === revision ? cached.snapshot : undefined;
    if (!snapshot) {
      snapshot = buildStatsSnapshot({ now, range: input.range, utcOffsetMinutes: input.utcOffsetMinutes,
        hours: [...this.hours.values()], attributions: [...this.attributions.values()], toolDays: this.tools(),
        records: [...this.records.values()], running: this.running, directory: this.directoryCache.agents,
        observedSince: this.observedSince, contentSince: this.contentSince, directoryTruncated: this.directoryCache.truncated, awaiting,
        background, ended, walkedAt });
      this.memo.delete(key); this.memo.set(key, { revision, snapshot });
      while (this.memo.size > 12) this.memo.delete(this.memo.keys().next().value!);
    }
    return { ...snapshot, mode: "full", unchanged: false, revision };
  }

  private agent(agentId: string, at: number): StatsAgentRecord {
    const state = this.records.get(agentId) ?? { agentId, lastKey: null, maxTurnMs: 0, maxTurnAt: null, updatedAt: at };
    state.updatedAt = at; this.records.delete(agentId); this.records.set(agentId, state);
    while (this.records.size > MAX_AGENTS) {
      const old = this.records.keys().next().value!;
      // Cursor LRU eviction must not terminate an independently tracked active turn/request.
      this.records.delete(old);
    }
    return state;
  }

  private addHour(at: number, metrics: Partial<StatsMetrics>): void {
    const hour = statsHour(at), bucket = this.hours.get(hour) ?? { hour, ...emptyStatsMetrics() };
    addStatsMetrics(bucket, metrics); this.hours.set(hour, bucket);
  }
  private addAttribution(agentId: string, at: number, metrics: Partial<StatsMetrics>): void {
    const day = statsDay(at), key = JSON.stringify([agentId, day]);
    const bucket = this.attributions.get(key) ?? { agentId, day, lastActiveAt: new Date(at).toISOString(), ...emptyStatsMetrics() };
    addStatsMetrics(bucket, metrics); bucket.lastActiveAt = new Date(Math.max(at, Date.parse(bucket.lastActiveAt))).toISOString();
    this.attributions.set(key, bucket);
    const keys = this.attributionDays.get(day) ?? new Set<string>(); keys.add(key); this.attributionDays.set(day, keys);
    while (this.attributions.size > MAX_ATTRIBUTIONS) {
      const oldest = [...this.attributionDays.keys()].sort()[0], members = this.attributionDays.get(oldest)!;
      const dropped = members.values().next().value!; this.attributions.delete(dropped); members.delete(dropped);
      if (!members.size) this.attributionDays.delete(oldest);
    }
  }
  private add(agentId: string, at: number, metrics: Partial<StatsMetrics>): void { this.addHour(at, metrics); this.addAttribution(agentId, at, metrics); }

  private observePeak(at: number): void {
    const peakParallel = this.running.size;
    if (!peakParallel) return;
    this.addHour(at, { peakParallel });
    for (const agentId of this.running.keys()) this.addAttribution(agentId, at, { peakParallel });
  }

  private advance(at: number): void {
    if (at < this.lastAdvance) return;
    let cursor = this.lastAdvance;
    // Expire at the exact 12h boundary, including when no hooks/RPCs arrived in between.
    while (cursor < at && this.running.size) {
      for (const [agentId, started] of this.running) if (started + MAX_TURN_MS <= cursor) { this.running.delete(agentId); this.changed(); }
      if (!this.running.size) break;
      const end = Math.min(at, Math.floor(cursor / HOUR) * HOUR + HOUR, ...[...this.running.values()].map(start => start + MAX_TURN_MS));
      const busyMs = end - cursor, peakParallel = this.running.size;
      this.addHour(cursor, { busyMs, peakParallel });
      // Share wall time across concurrent participants, preserving additive attribution totals.
      for (const agentId of this.running.keys()) this.addAttribution(agentId, cursor, { busyMs: busyMs / peakParallel, peakParallel });
      cursor = end; this.changed();
    }
    for (const [agentId, started] of this.running) if (started + MAX_TURN_MS <= at) { this.running.delete(agentId); this.changed(); }
    this.lastAdvance = at;
    this.observePeak(at);
  }

  private addTools(at: number, tools: readonly StatsTool[]): void {
    if (!tools.length) return;
    const day = statsDay(at), map = this.toolDays.get(day) ?? new Map<string, StatsTool>();
    const kinds = this.toolKinds.get(day) ?? new Map<ToolKind, StatsTool>();
    for (const tool of tools) {
      const total = kinds.get(tool.kind) ?? { name: tool.kind, kind: tool.kind, calls: 0, failures: 0 };
      total.calls += tool.calls; total.failures += tool.failures; kinds.set(tool.kind, total);
      const key = JSON.stringify([tool.name, tool.kind]);
      if (!map.has(key) && map.size >= 60) continue;
      const current = map.get(key) ?? { ...tool, calls: 0, failures: 0 };
      current.calls += tool.calls; current.failures += tool.failures; map.set(key, current);
    }
    this.toolDays.set(day, map); this.toolKinds.set(day, kinds);
  }
  private tools(): StatsToolDay[] { return [...this.toolDays].map(([day, tools]) => ({ day, tools: [...tools.values()], kinds: [...(this.toolKinds.get(day)?.values() ?? [])] })); }

  private prune(at: number): void {
    const hour = statsHour(at);
    if (hour === this.prunedHour) return;
    this.prunedHour = hour;
    const minimum = Date.parse(hour) - (MAX_HOURS - 1) * HOUR;
    for (const key of this.hours.keys()) if (Date.parse(key) < minimum) { this.hours.delete(key); this.changed(); }
    const firstDay = statsDay(Math.floor(at / DAY) * DAY - (MAX_TOOL_DAYS - 1) * DAY);
    for (const key of this.toolDays.keys()) if (key < firstDay) { this.toolDays.delete(key); this.toolKinds.delete(key); this.changed(); }
  }
  private changed(): void { this.change++; this.dirty = true; if (this.initialized) this.scheduleWrite(); }
  private scheduleWrite(): void {
    if (this.closed || this.timer || !this.storageReadable) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, WRITE_DELAY);
    this.timer.unref?.();
  }

  private async initialize(telemetry: StatsStoreOptions["telemetry"]): Promise<void> {
    if (telemetry) {
      const [analytics, summaries] = await Promise.all([telemetry.analyticsSnapshot(), telemetry.snapshot()]);
      this.backfill(analytics, summaries);
    } else this.observedSince = this.contentSince;
    this.backfilled = true; this.changed();
  }
  private backfill(analytics: AnalyticsSnapshot, telemetry: TelemetrySnapshot): void {
    this.observedSince = analytics.startedAt;
    const covered = new Set<string>();
    for (const bucket of analytics.hours) { covered.add(bucket.bucketStart.slice(0, 10)); this.addHour(Date.parse(bucket.bucketStart), activity(bucket)); }
    for (const bucket of analytics.days) if (!covered.has(bucket.bucketStart.slice(0, 10))) this.addHour(Date.parse(bucket.bucketStart) + 12 * HOUR, activity(bucket));
    const lastActivity = new Map<string, number>();
    const remember = (agentId: string, stamp: string | null | undefined) => {
      const at = stamp ? Date.parse(stamp) : NaN;
      if (Number.isFinite(at)) lastActivity.set(agentId, Math.max(lastActivity.get(agentId) ?? 0, at));
    };
    for (const agent of telemetry.agents) { remember(agent.agentId, agent.turnEndedAt); remember(agent.agentId, agent.turnStartedAt); }
    for (const event of telemetry.events) remember(event.agentId, event.at);
    for (const sample of analytics.usage) remember(sample.agentId, sample.at);
    for (const agent of analytics.agents) this.addAttribution(agent.agentId, lastActivity.get(agent.agentId) ?? Date.parse(analytics.updatedAt), activity(agent));
  }

  private restore(): void {
    let content: string;
    try {
      const details = statSync(this.file);
      if (details.size > MAX_FILE_BYTES) { this.quarantine(); return; }
      content = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // An inaccessible valid file is not corrupt, and must not be replaced by a fresh ledger.
      this.storageReadable = false;
      console.warn("统计历史暂时无法读取；继续内存采集并保留原文件。");
      return;
    }
    try {
      const saved = savedSchema.parse(JSON.parse(content));
      this.observedSince = saved.observedSince; this.contentSince = saved.contentSince;
      this.change = saved.change; this.backfilled = saved.backfilled;
      for (const bucket of saved.hours) this.hours.set(bucket.hour, bucket);
      for (const bucket of saved.attributions) {
        const key = JSON.stringify([bucket.agentId, bucket.day]); this.attributions.set(key, bucket);
        const keys = this.attributionDays.get(bucket.day) ?? new Set<string>(); keys.add(key); this.attributionDays.set(bucket.day, keys);
      }
      for (const bucket of saved.toolDays) {
        this.toolDays.set(bucket.day, new Map(bucket.tools.map(tool => [JSON.stringify([tool.name, tool.kind]), tool])));
        const kinds = new Map<ToolKind, StatsTool>();
        for (const tool of bucket.kinds ?? bucket.tools) {
          const total = kinds.get(tool.kind) ?? { name: tool.kind, kind: tool.kind, calls: 0, failures: 0 };
          total.calls += tool.calls; total.failures += tool.failures; kinds.set(tool.kind, total);
        }
        this.toolKinds.set(bucket.day, kinds);
      }
      for (const record of saved.records.sort((a, b) => a.updatedAt - b.updatedAt)) this.records.set(record.agentId, record);
      for (const [agentId, start] of saved.running) if (start + MAX_TURN_MS > this.lastAdvance) this.running.set(agentId, start);
      for (const entry of saved.permissions) this.permissions.set(entry.agentId, new Map(entry.requests));
      // No unobserved process downtime is charged as busy time after restore.
    } catch { this.quarantine(); }
  }
  private quarantine(): void {
    try { renameSync(this.file, `${this.file}.corrupt`); }
    catch { this.storageReadable = false; }
    this.changed();
  }

  /** Atomic serialized writes; normal writes are delayed by 20s and close also fsyncs. */
  flush(durable = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.writes = this.writes.then(async () => {
      await this.ready;
      if (!this.storageReadable) return;
      if (!this.dirty) {
        if (durable) { const handle = await open(this.file, "r").catch(() => null); if (handle) { try { await handle.sync(); } finally { await handle.close(); } } }
        return;
      }
      const change = this.change;
      const payload = JSON.stringify({ version: 1, change, backfilled: this.backfilled, observedSince: this.observedSince, contentSince: this.contentSince,
        hours: [...this.hours.values()], attributions: [...this.attributions.values()], toolDays: this.tools(), records: [...this.records.values()],
        running: [...this.running], permissions: [...this.permissions].map(([agentId, requests]) => ({ agentId, requests: [...requests] })) });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(payload, "utf8"); if (durable) await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
        this.dirty = this.change !== change;
      } finally { await unlink(temporary).catch(() => {}); }
    }).catch(() => { this.dirty = true; }).finally(() => { if (this.dirty) this.scheduleWrite(); });
    return this.writes;
  }
  async close(): Promise<void> {
    if (this.closed) { await this.writes; return; }
    this.closed = true; await this.ready; this.advance(this.now()); this.prune(this.now()); await this.flush(true);
  }
}
