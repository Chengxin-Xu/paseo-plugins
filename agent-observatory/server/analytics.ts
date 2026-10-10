import { z } from "zod";
import { agentAnalyticsSchema, analyticsBucketSchema, usageSampleSchema, emptyActivityMetrics, observationIntervalSchema, coveredDuration,
  type ActivityMetrics, type AgentAnalytics, type AnalyticsBucket, type AnalyticsSnapshot, type UsageSample, type ObservationInterval } from "../shared/analytics";
import type { TelemetryEvent } from "../shared/telemetry";

const HOUR = 3_600_000, DAY = 86_400_000;
const attributedBucketSchema = analyticsBucketSchema.extend({ agentId: z.string(), projectId: z.string().nullable(), period: z.enum(["hour", "day"]) });
const stateSchema = z.object({ startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  hours: z.array(analyticsBucketSchema).max(168), days: z.array(analyticsBucketSchema).max(28),
  agents: z.array(agentAnalyticsSchema).max(2_000), usage: z.array(usageSampleSchema).max(1_000),
  agentsTruncated: z.boolean(), coverageIntervals: z.array(observationIntervalSchema).max(2048).optional(),
  attributedBuckets: z.array(attributedBucketSchema).max(18_000).optional(), attributionStartedAt: z.iso.datetime().optional(), projectHistoryTruncated: z.boolean().optional() });
export interface AnalyticsAgent {
  id: string; provider?: string; workspaceId?: string | null;
  projectId?: string | null; projectName?: string | null; projectRootPath?: string | null;
}
export interface ReportedUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalCostUsd?: number }
const valid = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const safeText = (value: string | null | undefined, maximum: number) => typeof value === "string" && value.length ? value.slice(0, maximum) : null;
function merge(target: ActivityMetrics, delta: ActivityMetrics) {
  for (const key of ["eventCount", "started", "completed", "failed", "canceled", "runMs", "runSamples", "waitMs", "usageSamples"] as const) target[key] += delta[key];
  for (const key of ["inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const) {
    if (delta[key] !== null) target[key] = target[key] === null ? delta[key] : Math.max(target[key], delta[key]);
  }
}

/** Serialized by TelemetryStore and persisted in the same atomic transaction. */
export class AnalyticsAccumulator {
  private startedAt: string;
  private updatedAt: string;
  private readonly hours = new Map<string, AnalyticsBucket>();
  private readonly days = new Map<string, AnalyticsBucket>();
  private readonly agents = new Map<string, AgentAnalytics>();
  private usage: UsageSample[] = [];
  private agentsTruncated = false;
  private readonly sessionStart: number;
  private lastHeartbeat: number;
  private coverageIntervals: ObservationInterval[];
  private attributedBuckets = new Map<string, z.infer<typeof attributedBucketSchema>>();
  private attributionStartedAt: string;
  private projectHistoryTruncated = false;
  constructor(now: number) { this.startedAt = this.updatedAt = this.attributionStartedAt = new Date(now).toISOString(); this.sessionStart = this.lastHeartbeat = now; this.coverageIntervals = [{ start: this.startedAt, end: this.startedAt }]; }

  restore(value: unknown): boolean {
    const result = stateSchema.safeParse(value);
    if (!result.success) return false;
    const state = result.data;
    this.startedAt = state.startedAt; this.updatedAt = state.updatedAt; this.agentsTruncated = state.agentsTruncated;
    this.hours.clear(); this.days.clear(); this.agents.clear();
    for (const bucket of state.hours) this.hours.set(bucket.bucketStart, bucket);
    for (const bucket of state.days) this.days.set(bucket.bucketStart, bucket);
    for (const agent of state.agents) this.agents.set(agent.agentId, agent);
    this.usage = state.usage;
    this.coverageIntervals = [...(state.coverageIntervals ?? []), { start: new Date(this.sessionStart).toISOString(), end: new Date(this.sessionStart).toISOString() }].slice(-2048);
    this.lastHeartbeat = this.sessionStart;
    this.attributedBuckets = new Map((state.attributedBuckets ?? []).map(bucket => [JSON.stringify([bucket.agentId, bucket.period, bucket.bucketStart, bucket.projectId]), bucket]));
    this.attributionStartedAt = state.attributionStartedAt ?? new Date(this.sessionStart).toISOString();
    this.projectHistoryTruncated = state.projectHistoryTruncated ?? false;
    return true;
  }
  serialize() {
    return { startedAt: this.startedAt, updatedAt: this.updatedAt, hours: [...this.hours.values()], days: [...this.days.values()],
      agents: [...this.agents.values()], usage: this.usage, agentsTruncated: this.agentsTruncated, coverageIntervals: this.coverageIntervals.map(interval => ({ ...interval })),
      attributedBuckets: [...this.attributedBuckets.values()], attributionStartedAt: this.attributionStartedAt, projectHistoryTruncated: this.projectHistoryTruncated };
  }
  snapshot(now: number, persistenceError: string | null, projectId?: string): AnalyticsSnapshot {
    this.prune(now);
    const state = this.serialize();
    const grouped = (period: "hour" | "day") => {
      const groups = new Map<string, AnalyticsBucket>();
      for (const item of this.attributedBuckets.values()) {
        if (item.period !== period || item.projectId !== projectId) continue;
        const bucket = groups.get(item.bucketStart) ?? { bucketStart: item.bucketStart, ...emptyActivityMetrics() };
        merge(bucket, item); groups.set(item.bucketStart, bucket);
      }
      return [...groups.values()];
    };
    const intervals = projectId ? state.coverageIntervals.map(interval => ({ start: new Date(Math.max(Date.parse(interval.start), Date.parse(this.attributionStartedAt))).toISOString(), end: interval.end })).filter(interval => interval.start <= interval.end) : state.coverageIntervals;
    const selectedAgents = projectId ? state.agents.map(agent => ({ ...agent, ...emptyActivityMetrics() })).filter(agent => {
      let found = false;
      for (const bucket of this.attributedBuckets.values()) if (bucket.period === "day" && bucket.projectId === projectId && bucket.agentId === agent.agentId) { merge(agent, bucket); found = true; }
      if (found && agent.projectId !== projectId) { agent.projectId = projectId; agent.projectName = projectId; }
      return found;
    }) : state.agents;
    return { startedAt: projectId ? this.attributionStartedAt : state.startedAt, updatedAt: state.updatedAt, agentsTruncated: state.agentsTruncated,
      coverageIntervals: intervals, persistenceError, usageBasis: "provider_reported_snapshot", usageAggregation: "peak_per_bucket", coverageResolutionMs: 30_000, projectId: projectId ?? null,
      projectHistoryTruncated: !!projectId && (this.projectHistoryTruncated || [...this.attributedBuckets.values()].some(bucket => bucket.projectId === null)),
      hours: (projectId ? grouped("hour") : state.hours).map(bucket => ({ ...bucket, coveredMs: coveredDuration(intervals, Date.parse(bucket.bucketStart), Date.parse(bucket.bucketStart) + HOUR) })).sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
      days: (projectId ? grouped("day") : state.days).map(bucket => ({ ...bucket, coveredMs: coveredDuration(intervals, Date.parse(bucket.bucketStart), Date.parse(bucket.bucketStart) + DAY) })).sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
      agents: selectedAgents.map(agent => ({ ...agent })), usage: state.usage.filter(sample => !projectId || sample.projectId === projectId).map(sample => ({ ...sample })) };
  }
  heartbeat(at: number): void {
    if (!Number.isFinite(at) || at < this.lastHeartbeat) return;
    const stamp = new Date(at).toISOString();
    const current = this.coverageIntervals.at(-1);
    // A missed heartbeat longer than 90s indicates suspended/offline collection.
    if (!current || at - this.lastHeartbeat > 90_000) this.coverageIntervals.push({ start: stamp, end: stamp });
    else current.end = stamp;
    this.lastHeartbeat = at;
    if (this.coverageIntervals.length > 2048) this.coverageIntervals = this.coverageIntervals.slice(-2048);
    this.prune(at);
  }
  recordEvent(event: TelemetryEvent, agent: AnalyticsAgent, waitMs = 0): void {
    const metrics = emptyActivityMetrics();
    metrics.eventCount = 1;
    metrics.started = event.type === "turn_started" ? 1 : 0;
    metrics.completed = event.type === "turn_completed" ? 1 : 0;
    metrics.failed = event.type === "turn_failed" ? 1 : 0;
    metrics.canceled = event.type === "turn_canceled" ? 1 : 0;
    metrics.runMs = event.type.startsWith("turn_") && event.type !== "turn_started" ? event.durationMs ?? 0 : 0;
    metrics.runSamples = event.type.startsWith("turn_") && event.type !== "turn_started" && event.durationMs !== undefined ? 1 : 0;
    metrics.waitMs = waitMs;
    this.recordMetrics(agent, Date.parse(event.at), metrics);
  }
  /** Reports whether placement metadata or unattributed history actually changed, so unchanged reads never rewrite storage. */
  updateAttribution(agent: AnalyticsAgent): boolean {
    const before = this.agents.get(agent.id), previous = before && JSON.stringify(before);
    let changed = previous !== JSON.stringify(this.agent(agent));
    if (agent.projectId) {
      for (const [key, bucket] of [...this.attributedBuckets]) if (bucket.agentId === agent.id && bucket.projectId === null) {
        this.attributedBuckets.delete(key);
        const targetKey = JSON.stringify([bucket.agentId, bucket.period, bucket.bucketStart, agent.projectId]);
        const target = this.attributedBuckets.get(targetKey);
        if (target) merge(target, bucket); else this.attributedBuckets.set(targetKey, { ...bucket, projectId: agent.projectId });
        changed = true;
      }
      for (const sample of this.usage) if (sample.agentId === agent.id && sample.projectId === null) { sample.projectId = agent.projectId; changed = true; }
    }
    return changed;
  }
  /** False for repeated sample IDs and reports without any usable value. */
  recordUsage(id: string, agent: AnalyticsAgent, at: string, usage: ReportedUsage): boolean {
    if (this.usage.some(sample => sample.id === id)) return false;
    const report = { inputTokens: valid(usage.inputTokens), outputTokens: valid(usage.outputTokens),
      cachedTokens: valid(usage.cachedInputTokens), costUsd: valid(usage.totalCostUsd) };
    if (Object.values(report).every(value => value === null)) return false;
    const current = this.agent(agent);
    this.usage.unshift({ id, agentId: agent.id, provider: current.provider, workspaceId: current.workspaceId,
      projectId: current.projectId, at, ...report });
    if (this.usage.length > 1_000) this.usage.length = 1_000;
    this.recordMetrics(agent, Date.parse(at), { ...emptyActivityMetrics(), ...report, usageSamples: 1 });
    return true;
  }
  private recordMetrics(agent: AnalyticsAgent, at: number, metrics: ActivityMetrics): void {
    if (!Number.isFinite(at)) return;
    this.heartbeat(at);
    this.updatedAt = new Date(Math.max(Date.parse(this.updatedAt), at)).toISOString();
    for (const [map, interval] of [[this.hours, HOUR], [this.days, DAY]] as const) {
      const key = new Date(Math.floor(at / interval) * interval).toISOString();
      const bucket = map.get(key) ?? { bucketStart: key, ...emptyActivityMetrics() };
      merge(bucket, metrics); map.set(key, bucket);
      const period = interval === HOUR ? "hour" : "day";
      const projectId = agent.projectId ?? this.agents.get(agent.id)?.projectId ?? null;
      const attributedKey = JSON.stringify([agent.id, period, key, projectId]);
      const attributed = this.attributedBuckets.get(attributedKey) ?? { agentId: agent.id, projectId, period, bucketStart: key, ...emptyActivityMetrics() };
      merge(attributed, metrics); this.attributedBuckets.set(attributedKey, attributed);
    }
    merge(this.agent(agent), metrics);
    this.prune(Math.max(at, Date.parse(this.updatedAt)));
  }
  private agent(agent: AnalyticsAgent): AgentAnalytics {
    const current = this.agents.get(agent.id) ?? { agentId: agent.id, provider: "unknown", workspaceId: null,
      projectId: null, projectName: null, projectRootPath: null, ...emptyActivityMetrics() };
    if (agent.provider) current.provider = safeText(agent.provider, 128) ?? "unknown";
    if (agent.workspaceId !== undefined) current.workspaceId = safeText(agent.workspaceId, 512);
    if (agent.projectId !== undefined) current.projectId = safeText(agent.projectId, 1024);
    if (agent.projectName !== undefined) current.projectName = safeText(agent.projectName, 240);
    if (agent.projectRootPath !== undefined) current.projectRootPath = safeText(agent.projectRootPath, 2048);
    this.agents.delete(agent.id); this.agents.set(agent.id, current);
    while (this.agents.size > 2_000) { this.agents.delete(this.agents.keys().next().value!); this.agentsTruncated = true; }
    return current;
  }
  private prune(now: number): void {
    this.coverageIntervals = this.coverageIntervals.filter(interval => Date.parse(interval.end) >= now - 28 * DAY).slice(-2048);
    for (const [key, bucket] of this.attributedBuckets) if (Date.parse(bucket.bucketStart) < (bucket.period === "hour" ? Math.floor(now / HOUR) * HOUR - 167 * HOUR : Math.floor(now / DAY) * DAY - 27 * DAY)) this.attributedBuckets.delete(key);
    while (this.attributedBuckets.size > 18_000) { this.attributedBuckets.delete(this.attributedBuckets.keys().next().value!); this.projectHistoryTruncated = true; }
    for (const [map, interval, limit] of [[this.hours, HOUR, 168], [this.days, DAY, 28]] as const) {
      const minimum = Math.floor(now / interval) * interval - (limit - 1) * interval;
      for (const key of map.keys()) if (Date.parse(key) < minimum) map.delete(key);
      if (map.size > limit) for (const key of [...map.keys()].sort().slice(0, map.size - limit)) map.delete(key);
    }
  }
}
