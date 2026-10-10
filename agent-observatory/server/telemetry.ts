import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  agentTelemetrySchema,
  telemetryEventSchema,
  type TelemetryEvent,
  type TelemetryResponse,
  type TelemetrySnapshot,
  type TurnOutcome,
} from "../shared/telemetry";
import { AnalyticsAccumulator, type AnalyticsAgent, type ReportedUsage } from "./analytics";
import { latestUsageSamples, type AnalyticsResponse, type AnalyticsSnapshot } from "../shared/analytics";
import { contentRevision } from "./revision";

const MAX_AGENTS = 2_000;
const MAX_EVENTS = 500;
const MAX_ACTIVE_TURNS = 8;
const MAX_TURN_HISTORY = 32;
const MAX_PERMISSIONS = 32;
const MAX_PERMISSION_HISTORY = 64;
// Covers the bounded lifecycle records plus analytics attribution and usage samples.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_NAME = "telemetry.json";
// Coverage-only heartbeats are cheap to lose on a crash; they never trigger a prompt rewrite or fsync.
const COVERAGE_WRITE_MS = 10 * 60_000;

type ObservedAgent = AnalyticsAgent & { title: string | null };

const agentStateSchema = z.object({
  summary: agentTelemetrySchema,
  updatedAt: z.number().finite().nonnegative(),
  latestTurnKey: z.string().max(80).nullable(),
  activeTurns: z.array(z.object({ key: z.string().max(80), at: z.number().finite().nonnegative() })).max(MAX_ACTIVE_TURNS),
  endedTurns: z.array(z.string().max(80)).max(MAX_TURN_HISTORY),
  pendingPermissions: z.array(z.object({ key: z.string().max(80), at: z.number().finite().nonnegative() })).max(MAX_PERMISSIONS),
  resolvedPermissions: z.array(z.string().max(80)).max(MAX_PERMISSION_HISTORY),
  permissionWaitStartedAt: z.number().finite().nonnegative().nullable(),
});

const savedStateSchema = z.object({
  version: z.literal(1),
  startedAt: z.iso.datetime(),
  agents: z.array(agentStateSchema).max(MAX_AGENTS),
  events: z.array(telemetryEventSchema).max(MAX_EVENTS),
  analytics: z.unknown().optional(),
});

type AgentState = z.infer<typeof agentStateSchema>;

export type TelemetryObservation =
  | { type: "created" | "archived"; agent: ObservedAgent }
  | { type: "turn_started"; agent: ObservedAgent; turnId: string | null }
  // `asks`: whether the turn's final reply hands the next step to the user (see shared/reply.ts); null without a final reply.
  | { type: "turn_ended"; agent: ObservedAgent; turnId: string | null; outcome: TurnOutcome; asks?: boolean | null }
  | { type: "permission_requested"; agent: ObservedAgent; requestId: string }
  | { type: "permission_resolved"; agent: ObservedAgent; requestId: string; allowed: boolean };

export interface TelemetryStoreOptions {
  /** Test overrides keep all writes inside a temporary directory. */
  directory?: string;
  now?: () => number;
  maxAgents?: number;
  maxEvents?: number;
  writeDelayMs?: number;
  coverageWriteMs?: number;
}

export function telemetryDirectory(): string {
  const configured = process.env.PASEO_HOME?.trim();
  const paseoHome = configured && isAbsolute(configured) ? configured : join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "agent-observatory");
}

function identifierKey(value: string | null, kind: "turn" | "permission"): string {
  return value === null ? "anonymous" : `${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  return /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

function bound(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(fallback, Math.floor(value)));
}

function remember(list: string[], key: string, maximum: number): void {
  if (!list.includes(key)) list.push(key);
  if (list.length > maximum) list.splice(0, list.length - maximum);
}

function elapsed(start: number, end: number): number {
  return Math.max(0, end - start);
}

/**
 * A small event ledger, deliberately separate from Paseo's session/timeline storage.
 * The mutation queue preserves hook arrival order, including during asynchronous loading.
 * The independent write queue serializes atomic replacements without delaying lifecycle hooks.
 * Lifecycle observations are written promptly with fsync; heartbeat-only coverage is written lazily,
 * and a payload identical to the last successful write is never rewritten.
 */
export class TelemetryStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxAgents: number;
  private readonly maxEvents: number;
  private readonly writeDelayMs: number;
  private readonly coverageWriteMs: number;
  private readonly agents = new Map<string, AgentState>();
  private readonly analytics: AnalyticsAccumulator;
  private events: TelemetryEvent[] = [];
  private startedAt: string;
  private persistenceError: string | null = null;
  private mutations: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private coverageWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private coverageDirty = false;
  private lastWrittenDigest: string | null = null;
  private closed = false;
  private readonly coverageTimer: ReturnType<typeof setInterval>;
  // Snapshot revisions: a per-process generation plus a counter bumped by every visible change.
  private readonly generation = randomUUID().slice(0, 8);
  private revision = 0;
  private baseRevision = 0;
  private evictedAt = 0;
  private readonly agentRevisions = new Map<string, number>();
  private readonly eventRevisions = new Map<string, number>();
  // Agents observed after this moment are loaded in the daemon; reading an unloaded Agent's timeline would make the
  // daemon load it (ACP providers replay the whole session and it looks freshly updated), so backfill waits for them.
  private readonly bootAt: number;

  constructor(options: TelemetryStoreOptions = {}) {
    this.directory = options.directory ?? telemetryDirectory();
    this.file = join(this.directory, FILE_NAME);
    this.now = options.now ?? Date.now;
    this.maxAgents = bound(options.maxAgents, MAX_AGENTS);
    this.maxEvents = bound(options.maxEvents, MAX_EVENTS);
    this.writeDelayMs = Math.max(0, options.writeDelayMs ?? 250);
    this.coverageWriteMs = Math.max(0, options.coverageWriteMs ?? COVERAGE_WRITE_MS);
    this.startedAt = new Date(this.now()).toISOString();
    this.bootAt = this.now();
    this.analytics = new AnalyticsAccumulator(this.now());
    this.mutations = this.load();
    this.coverageTimer = setInterval(() => { void this.recordHeartbeat(); }, 30_000);
    this.coverageTimer.unref?.();
  }

  record(observation: TelemetryObservation): Promise<void> {
    return this.recordEvent(observation).then(() => {});
  }

  /** The accepted event ID lets enrichment attach exactly once after an ended hook. */
  recordEvent(observation: TelemetryObservation): Promise<TelemetryEvent | null> {
    if (this.closed) return Promise.resolve(null);
    // Only an explicit metadata allowlist enters either the queue or the persisted state.
    // Hooks pass no prompts, error messages, permission payloads, or timeline content (a reply is reduced to one boolean).
    const agent = { id: observation.agent.id, title: observation.agent.title,
      provider: observation.agent.provider, workspaceId: observation.agent.workspaceId,
      projectId: observation.agent.projectId, projectName: observation.agent.projectName,
      projectRootPath: observation.agent.projectRootPath };
    let metadata: TelemetryObservation;
    switch (observation.type) {
      case "created": case "archived":
        metadata = { type: observation.type, agent };
        break;
      case "turn_started":
        metadata = { type: observation.type, agent, turnId: observation.turnId };
        break;
      case "turn_ended":
        metadata = { type: observation.type, agent, turnId: observation.turnId, outcome: observation.outcome, asks: typeof observation.asks === "boolean" ? observation.asks : null };
        break;
      case "permission_requested":
        metadata = { type: observation.type, agent, requestId: observation.requestId };
        break;
      case "permission_resolved":
        metadata = { type: observation.type, agent, requestId: observation.requestId, allowed: observation.allowed };
        break;
    }
    const at = this.now();
    const task = this.mutations.then(() => this.apply(metadata, at) ?? null).catch(() => {
      this.setError("An observation could not be collected. Live agent status remains available.");
      return null;
    });
    this.mutations = task.then(() => {});
    return task;
  }

  async analyticsSnapshot(projectId?: string): Promise<AnalyticsSnapshot> {
    await this.recordHeartbeat();
    await this.mutations;
    return this.analytics.snapshot(this.now(), this.persistenceError, projectId);
  }

  /**
   * Revisioned analytics read. The revision covers everything except the still-open coverage interval's end,
   * which advances with every heartbeat; an unchanged reply carries that interval so clients stay current.
   * Only the usage samples the dashboard renders (each Agent's first-listed and newest report) are sent.
   */
  async analyticsRead(input: { projectId?: string; revision?: string } = {}): Promise<AnalyticsResponse> {
    const snapshot = await this.analyticsSnapshot(input.projectId);
    const view: AnalyticsSnapshot = { ...snapshot, usage: latestUsageSamples(snapshot.usage) };
    const intervals = view.coverageIntervals ?? [], tail = intervals.at(-1) ?? null;
    const withoutCoverage = ({ coveredMs: _coveredMs, ...bucket }: AnalyticsSnapshot["hours"][number]) => bucket;
    const revision = contentRevision({ ...view, coverageIntervals: tail ? [...intervals.slice(0, -1), { start: tail.start }] : intervals,
      hours: view.hours.map(withoutCoverage), days: view.days.map(withoutCoverage) });
    if (input.revision === revision) return { mode: "unchanged", unchanged: true, revision, coverageTail: tail };
    return { ...view, mode: "full", unchanged: false, revision };
  }

  private recordHeartbeat(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const at = this.now();
    this.mutations = this.mutations.then(() => { this.analytics.heartbeat(at); this.coverageDirty = true; this.scheduleCoverageWrite(); });
    return this.mutations;
  }

  recordUsage(id: string, agent: AnalyticsAgent, at: string, usage: ReportedUsage | null): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Explicit primitive field copies keep mutable SDK snapshots out of the queue.
    const metadata = { id: agent.id, provider: agent.provider, workspaceId: agent.workspaceId,
      projectId: agent.projectId, projectName: agent.projectName, projectRootPath: agent.projectRootPath };
    const report = usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens, totalCostUsd: usage.totalCostUsd } : null;
    this.mutations = this.mutations.then(() => {
      const attributed = this.analytics.updateAttribution(metadata);
      const recorded = report ? this.analytics.recordUsage(id, metadata, at, report) : false;
      // Periodic directory samples usually repeat known values; only real changes reach storage.
      if (!attributed && !recorded) return;
      this.dirty = true;
      this.scheduleWrite();
    }).catch(() => {
      this.setError("A usage observation could not be collected. Lifecycle data remains available.");
    });
    return this.mutations;
  }

  async snapshot(agentId?: string): Promise<TelemetrySnapshot> {
    await this.mutations;
    return this.view(agentId);
  }

  /**
   * Revisioned read for polling clients: `unchanged` when nothing visible changed since `revision`,
   * otherwise only the summaries and events recorded after it. Reloads, evictions and unknown
   * revisions fall back to a complete snapshot.
   */
  async read(input: { agentId?: string; revision?: string } = {}): Promise<TelemetryResponse> {
    await this.mutations;
    const revision = `${this.generation}:${this.revision}`;
    const match = /^([0-9a-f]{8}):(\d+)$/.exec(input.revision ?? "");
    const since = match && match[1] === this.generation ? Number(match[2]) : null;
    if (since === this.revision) return { mode: "unchanged", unchanged: true, revision };
    if (since === null || since < this.baseRevision || since < this.evictedAt || since > this.revision) {
      return { ...this.view(input.agentId), mode: "full", unchanged: false, revision };
    }
    const changedAfter = (value: number | undefined) => (value ?? 0) > since;
    const eventCount = input.agentId === undefined ? this.events.length : this.events.filter(event => event.agentId === input.agentId).length;
    return { ...this.view(input.agentId, id => changedAfter(this.agentRevisions.get(id)), id => changedAfter(this.eventRevisions.get(id))),
      mode: "delta", unchanged: false, revision, eventCount };
  }

  private view(agentId?: string, agentChanged: (id: string) => boolean = () => true, eventChanged: (id: string) => boolean = () => true): TelemetrySnapshot {
    const states = [...this.agents.values()]
      .filter((state) => (agentId === undefined || state.summary.agentId === agentId) && agentChanged(state.summary.agentId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      startedAt: this.startedAt,
      persistenceError: this.persistenceError,
      agents: states.map((state) => ({ ...state.summary })),
      events: this.events.filter((event) => (agentId === undefined || event.agentId === agentId) && eventChanged(event.id)).map((event) => ({ ...event })),
    };
  }

  /**
   * Backfill for a turn the hooks missed or that predates reply tracking: `reply` is the final reply read from the
   * timeline tail after the user message sent at `userAt` (null when that turn has none). A reply after the latest known
   * end is also the evidence that the turn completed. Never records reply text, and never an event: nothing was observed live.
   */
  recordReply(agentId: string, userAt: string, reply: { at: string; asks: boolean } | null): Promise<void> {
    if (this.closed || !agentId || agentId.length > 256) return Promise.resolve();
    const user = Date.parse(userAt), at = reply ? Date.parse(reply.at) : NaN;
    if (!Number.isFinite(user)) return Promise.resolve();
    this.mutations = this.mutations.then(() => {
      const state = this.stateFor(agentId, this.now()), summary = state.summary;
      // A turn this method completed earlier may be corrected by a later read of the same turn.
      const backfilled = summary.turnEndedAt !== null && summary.turnStartedAt === summary.replyFor && summary.turnEndedAt === summary.replyAt;
      summary.replyFor = new Date(user).toISOString();
      if (reply && Number.isFinite(at) && at >= user) {
        summary.replyAt = new Date(at).toISOString();
        summary.replyAsks = reply.asks;
        if (backfilled || (Date.parse(summary.turnEndedAt ?? "") || 0) < user) {
          summary.turnStartedAt = summary.replyFor; summary.turnEndedAt = summary.replyAt; summary.outcome = "completed";
          state.activeTurns = state.activeTurns.filter((turn) => turn.at > at);
        }
      } else if ((Date.parse(summary.replyAt ?? "") || 0) < user) {
        summary.replyAt = null; summary.replyAsks = null;
      }
      this.markChanged(agentId);
      this.dirty = true;
      this.scheduleWrite();
    }).catch(() => {
      this.setError("A reply observation could not be collected. Lifecycle data remains available.");
    });
    return this.mutations;
  }

  /**
   * Whether the reply to the user message sent at `userAt` still has to be read from the timeline. A reply recorded as
   * newer than the Agent's own last update came from an import-time timestamp and is read again (then capped).
   */
  async needsReplyCheck(agentId: string, userAt: string, updatedAt?: string | null): Promise<boolean> {
    await this.mutations;
    const user = Date.parse(userAt), state = this.agents.get(agentId), summary = state?.summary;
    if (!Number.isFinite(user) || !state || !summary || state.updatedAt < this.bootAt) return false;
    const replyAt = Date.parse(summary.replyAt ?? "") || 0, updated = Date.parse(updatedAt ?? "");
    if (summary.replyFor && Number.isFinite(updated) && replyAt > updated + 60_000) return true;
    if (replyAt >= user) return false;
    return (Date.parse(summary.replyFor ?? "") || 0) !== user;
  }

  /** Agents whose latest final reply asks the user and who have not answered since (待回复), from in-memory summaries. */
  awaitingAgents(agents: Iterable<{ id: string; status: string; lastUserMessageAt?: string | null; archivedAt?: string | null; activeTurn?: boolean }>): Set<string> {
    const awaiting = new Set<string>();
    for (const agent of agents) {
      const summary = this.agents.get(agent.id)?.summary;
      if (!summary?.replyAsks || agent.archivedAt || agent.activeTurn || agent.status === "running" || agent.status === "initializing") continue;
      const since = Math.max(Date.parse(agent.lastUserMessageAt ?? "") || 0, Date.parse(summary.turnStartedAt ?? "") || 0);
      if ((Date.parse(summary.replyAt ?? "") || 0) >= since) awaiting.add(agent.id);
    }
    return awaiting;
  }

  /** Wait for queued observations and persist the newest complete state. Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.coverageWriteTimer !== null) {
      clearTimeout(this.coverageWriteTimer);
      this.coverageWriteTimer = null;
    }
    this.writes = this.writes.then(async () => {
      await this.mutations;
      if (!this.dirty && !this.coverageDirty) return;
      const durable = this.dirty;
      const payload = JSON.stringify({
        version: 1,
        startedAt: this.startedAt,
        agents: [...this.agents.values()],
        events: this.events,
        analytics: this.analytics.serialize(),
      });
      this.dirty = false;
      this.coverageDirty = false;
      const digest = createHash("sha256").update(payload).digest("base64");
      if (digest === this.lastWrittenDigest) return;
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(payload, "utf8");
          if (durable) await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.file);
        this.lastWrittenDigest = digest;
        this.setError(null);
      } catch (error) {
        this.dirty ||= durable;
        this.coverageDirty = true;
        this.setError(`Telemetry could not be saved (${errorCode(error)}). Live collection remains available.`);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }).catch(() => {
      this.dirty = true;
      this.setError("Telemetry could not be saved. Live collection remains available.");
    });
    return this.writes;
  }

  /** Plugin reload/disable removes handlers first, then calls this to drain pending writes. */
  async close(): Promise<void> {
    clearInterval(this.coverageTimer);
    await this.recordHeartbeat();
    this.closed = true;
    await this.flush();
  }

  private setError(message: string | null): void {
    if (this.persistenceError === message) return;
    this.persistenceError = message;
    this.revision += 1;
  }

  private async load(): Promise<void> {
    await this.restore();
    // Revisions handed out later always describe the restored state.
    this.baseRevision = ++this.revision;
  }

  private async restore(): Promise<void> {
    let content: string;
    try {
      const details = await stat(this.file);
      if (details.size > MAX_FILE_BYTES) {
        await this.recoverInvalidFile(false);
        return;
      }
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        this.persistenceError = `Saved telemetry could not be read (${errorCode(error)}). Live collection remains available.`;
      }
      return;
    }
    try {
      const saved = savedStateSchema.parse(JSON.parse(content));
      this.startedAt = saved.startedAt;
      const ordered = saved.agents.sort((a, b) => a.updatedAt - b.updatedAt).slice(-this.maxAgents);
      for (const state of ordered) this.agents.set(state.summary.agentId, state);
      this.events = saved.events.slice(0, this.maxEvents);
      if (saved.analytics !== undefined && !this.analytics.restore(saved.analytics)) {
        this.persistenceError = "Saved analytics was invalid. Existing lifecycle history has been preserved.";
      }
      this.lastWrittenDigest = createHash("sha256").update(content).digest("base64");
    } catch {
      await this.recoverInvalidFile();
    }
  }

  private async recoverInvalidFile(quarantine = true): Promise<void> {
    this.persistenceError = "Saved telemetry was invalid. A fresh observation history has been started.";
    // A single quarantine file replaces the previous one, keeping recovery disk use bounded.
    if (quarantine) await rename(this.file, `${this.file}.corrupt`).catch(() => {});
    else await unlink(this.file).catch(() => {});
    this.dirty = true;
    this.lastWrittenDigest = null;
  }

  private stateFor(agentId: string, at: number): AgentState {
    const existing = this.agents.get(agentId);
    if (existing) {
      existing.updatedAt = at;
      // Map iteration order is the eviction order; recent observations stay available.
      this.agents.delete(agentId);
      this.agents.set(agentId, existing);
      return existing;
    }
    const state: AgentState = {
      summary: {
        agentId,
        turnStartedAt: null,
        turnEndedAt: null,
        outcome: null,
        completedTurns: 0,
        failedTurns: 0,
        canceledTurns: 0,
        totalRunMs: 0,
        permissionWaitMs: 0,
      },
      updatedAt: at,
      latestTurnKey: null,
      activeTurns: [],
      endedTurns: [],
      pendingPermissions: [],
      resolvedPermissions: [],
      permissionWaitStartedAt: null,
    };
    this.agents.set(agentId, state);
    let evicted = false;
    while (this.agents.size > this.maxAgents) {
      const oldest = this.agents.keys().next().value!;
      this.agents.delete(oldest);
      this.agentRevisions.delete(oldest);
      evicted = true;
    }
    // A new summary is visible even when the observation itself turns out to be a duplicate.
    this.markChanged(agentId);
    if (evicted) this.evictedAt = this.revision;
    this.dirty = true;
    this.scheduleWrite();
    return state;
  }

  private markChanged(agentId: string): number {
    this.revision += 1;
    this.agentRevisions.set(agentId, this.revision);
    return this.revision;
  }

  private apply(observation: TelemetryObservation, at: number): TelemetryEvent | undefined {
    const { agent } = observation;
    if (!agent.id || agent.id.length > 256 || !Number.isFinite(at) || at < 0) return;
    const state = this.stateFor(agent.id, at);
    const waitBefore = state.summary.permissionWaitMs;
    const stamp = new Date(at).toISOString();
    let type: TelemetryEvent["type"];
    let label: string;
    let durationMs: number | undefined;

    switch (observation.type) {
      case "created":
        // A replayed creation should not clear already-observed lifecycle information.
        if (this.events.some((event) => event.agentId === agent.id && event.type === "created")) return;
        type = "created";
        label = "Agent created";
        break;
      case "turn_started": {
        const key = identifierKey(observation.turnId, "turn");
        if (state.activeTurns.some((turn) => turn.key === key)) return;
        if (key !== "anonymous" && state.endedTurns.includes(key)) return;
        if (key === "anonymous") state.endedTurns = state.endedTurns.filter((turn) => turn !== key);
        state.activeTurns.push({ key, at });
        state.activeTurns = state.activeTurns.slice(-MAX_ACTIVE_TURNS);
        state.latestTurnKey = key;
        state.summary.turnStartedAt = stamp;
        state.summary.turnEndedAt = null;
        state.summary.outcome = null;
        state.summary.replyAt = null;
        state.summary.replyAsks = null;
        type = "turn_started";
        label = "Turn started";
        break;
      }
      case "turn_ended": {
        const key = identifierKey(observation.turnId, "turn");
        if (state.endedTurns.includes(key)) return;
        const started = state.activeTurns.find((turn) => turn.key === key);
        if (started) {
          durationMs = elapsed(started.at, at);
          state.summary.totalRunMs += durationMs;
          state.activeTurns = state.activeTurns.filter((turn) => turn.key !== key);
        }
        remember(state.endedTurns, key, MAX_TURN_HISTORY);
        const count = observation.outcome === "completed" ? "completedTurns" : observation.outcome === "failed" ? "failedTurns" : "canceledTurns";
        state.summary[count] += 1;
        // A delayed end for a previous turn must not replace a newer active turn's state. An end whose start was never
        // delivered (a queued follow-up, a reload) is still the newest turn once every remaining "active" start predates
        // the latest known turn: those turns ended unobserved and must not freeze the summary.
        const latestKnown = Math.max(Date.parse(state.summary.turnStartedAt ?? "") || 0, Date.parse(state.summary.turnEndedAt ?? "") || 0);
        const unobservedIsNewest = !started && state.activeTurns.every((turn) => turn.at < latestKnown);
        if (state.latestTurnKey === key || (!started && state.activeTurns.length === 0) || unobservedIsNewest) {
          if (unobservedIsNewest) state.activeTurns = [];
          state.latestTurnKey = key;
          state.summary.turnStartedAt = started ? new Date(started.at).toISOString() : null;
          state.summary.turnEndedAt = stamp;
          state.summary.outcome = observation.outcome;
          const asks = observation.outcome === "completed" && typeof observation.asks === "boolean" ? observation.asks : null;
          state.summary.replyAt = asks === null ? null : stamp;
          state.summary.replyAsks = asks;
          this.finishPermissionWait(state, at);
          state.pendingPermissions = [];
        }
        type = `turn_${observation.outcome}`;
        label = observation.outcome === "completed" ? "Turn completed" : observation.outcome === "failed" ? "Turn failed" : "Turn canceled";
        break;
      }
      case "permission_requested": {
        const key = identifierKey(observation.requestId, "permission");
        if (state.pendingPermissions.some((request) => request.key === key) || state.resolvedPermissions.includes(key)) return;
        if (state.pendingPermissions.length === 0) state.permissionWaitStartedAt = at;
        state.pendingPermissions.push({ key, at });
        state.pendingPermissions = state.pendingPermissions.slice(-MAX_PERMISSIONS);
        type = "permission_requested";
        label = "Waiting for approval or input";
        break;
      }
      case "permission_resolved": {
        const key = identifierKey(observation.requestId, "permission");
        if (state.resolvedPermissions.includes(key)) return;
        const pending = state.pendingPermissions.find((request) => request.key === key);
        if (pending) durationMs = elapsed(pending.at, at);
        state.pendingPermissions = state.pendingPermissions.filter((request) => request.key !== key);
        remember(state.resolvedPermissions, key, MAX_PERMISSION_HISTORY);
        if (state.pendingPermissions.length === 0) this.finishPermissionWait(state, at);
        type = "permission_resolved";
        label = observation.allowed ? "Request approved" : "Request declined or cleared";
        break;
      }
      case "archived":
        this.finishPermissionWait(state, at);
        state.pendingPermissions = [];
        type = "archived";
        label = "Agent archived";
        break;
    }

    const event: TelemetryEvent = {
      id: randomUUID(),
      agentId: agent.id,
      agentTitle: (agent.title?.trim() || "Untitled agent").slice(0, 160),
      at: stamp,
      type,
      label,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    this.events.unshift(event);
    this.eventRevisions.set(event.id, this.markChanged(agent.id));
    this.analytics.recordEvent(event, agent, state.summary.permissionWaitMs - waitBefore);
    for (const dropped of this.events.splice(this.maxEvents)) this.eventRevisions.delete(dropped.id);
    this.dirty = true;
    this.scheduleWrite();
    return { ...event };
  }

  private finishPermissionWait(state: AgentState, at: number): void {
    if (state.permissionWaitStartedAt !== null) {
      state.summary.permissionWaitMs += elapsed(state.permissionWaitStartedAt, at);
      state.permissionWaitStartedAt = null;
    }
  }

  private scheduleWrite(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.writeDelayMs);
    this.timer.unref?.();
  }

  private scheduleCoverageWrite(): void {
    if (this.closed || this.timer !== null || this.coverageWriteTimer !== null) return;
    this.coverageWriteTimer = setTimeout(() => {
      this.coverageWriteTimer = null;
      void this.flush();
    }, this.coverageWriteMs);
    this.coverageWriteTimer.unref?.();
  }
}
