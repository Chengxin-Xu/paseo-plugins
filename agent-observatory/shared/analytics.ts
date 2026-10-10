import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const count = z.number().nonnegative().finite();
const sample = count.nullable();
export const activityMetricsSchema = z.object({
  eventCount: count, started: count, completed: count, failed: count, canceled: count,
  runMs: count, runSamples: count.default(0), waitMs: count,
  /** Peak reported samples, deliberately not additive provider billing totals. */
  inputTokens: sample, outputTokens: sample, cachedTokens: sample, costUsd: sample, usageSamples: count,
});
export const analyticsBucketSchema = activityMetricsSchema.extend({ bucketStart: z.iso.datetime(), coveredMs: count.optional() });
export const observationIntervalSchema = z.object({ start: z.iso.datetime(), end: z.iso.datetime() });
export const agentAnalyticsSchema = activityMetricsSchema.extend({
  agentId: z.string().min(1).max(256), provider: z.string().max(128), workspaceId: z.string().max(512).nullable(),
  projectId: z.string().max(1024).nullable(), projectName: z.string().max(240).nullable(), projectRootPath: z.string().max(2048).nullable(),
});
export const usageSampleSchema = z.object({
  id: z.string().max(128), agentId: z.string().max(256), provider: z.string().max(128),
  workspaceId: z.string().max(512).nullable(), projectId: z.string().max(1024).nullable(), at: z.iso.datetime(),
  inputTokens: sample, outputTokens: sample, cachedTokens: sample, costUsd: sample,
});
export const analyticsSnapshotSchema = z.object({
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), persistenceError: z.string().nullable(),
  usageBasis: z.literal("provider_reported_snapshot"), usageAggregation: z.literal("peak_per_bucket"),
  hours: z.array(analyticsBucketSchema).max(168), days: z.array(analyticsBucketSchema).max(28),
  agents: z.array(agentAnalyticsSchema).max(2_000), usage: z.array(usageSampleSchema).max(1_000),
  agentsTruncated: z.boolean(),
  coverageIntervals: z.array(observationIntervalSchema).max(2048).optional(),
  coverageResolutionMs: count.optional(),
  projectId: z.string().nullable().optional(),
  projectHistoryTruncated: z.boolean().optional(),
});
const revision = z.string().min(1).max(80);
/** The open coverage interval advances with every heartbeat; it travels with unchanged replies instead of bumping the revision. */
export const analyticsResponseSchema = z.discriminatedUnion("mode", [
  analyticsSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision, coverageTail: observationIntervalSchema.nullable() }),
]);
export const getAnalytics = defineRpc({ name: "observatory.analytics.get", input: z.object({ projectId: z.string().min(1).max(1024).optional(), revision: revision.optional() }), output: analyticsResponseSchema });
export type ActivityMetrics = z.infer<typeof activityMetricsSchema>;
export type AnalyticsBucket = z.infer<typeof analyticsBucketSchema>;
export type AgentAnalytics = z.infer<typeof agentAnalyticsSchema>;
export type UsageSample = z.infer<typeof usageSampleSchema>;
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
export type AnalyticsState = AnalyticsSnapshot & { revision?: string };
export type ObservationInterval = z.infer<typeof observationIntervalSchema>;

/** Client cache update; an unchanged reply only moves the open coverage interval forward. */
export function mergeAnalytics(previous: AnalyticsState | undefined, response: AnalyticsResponse | AnalyticsSnapshot): AnalyticsState {
  if (!("mode" in response)) return response;
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return snapshot; }
  if (!previous) throw new Error("本地分析缓存已失效，正在重新读取完整数据。");
  const intervals = previous.coverageIntervals ?? [], tail = response.coverageTail, last = intervals.at(-1);
  if (!tail || !last || last.start !== tail.start || last.end === tail.end) return previous;
  return { ...previous, coverageIntervals: [...intervals.slice(0, -1), { ...tail }] };
}
/** Usage charts read each Agent's first-listed and newest sample; older repeats never render. */
export function latestUsageSamples(samples: readonly UsageSample[]): UsageSample[] {
  const newest = new Map<string, UsageSample>(), listed = new Set<string>();
  for (const sample of samples) { const previous = newest.get(sample.agentId); if (!previous || Date.parse(sample.at) > Date.parse(previous.at)) newest.set(sample.agentId, sample); }
  return samples.filter(sample => { if (!listed.has(sample.agentId)) { listed.add(sample.agentId); return true; } return newest.get(sample.agentId) === sample; });
}

export function emptyActivityMetrics(): ActivityMetrics {
  return { eventCount: 0, started: 0, completed: 0, failed: 0, canceled: 0, runMs: 0, runSamples: 0, waitMs: 0,
    inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null, usageSamples: 0 };
}
/** Only lifecycle counts/durations are additive. Unknown usage stays null; samples use a maximum. */
export function sumActivityMetrics(rows: readonly ActivityMetrics[]): ActivityMetrics {
  const result = emptyActivityMetrics();
  for (const row of rows) {
    for (const key of ["eventCount", "started", "completed", "failed", "canceled", "runMs", "runSamples", "waitMs", "usageSamples"] as const) result[key] += row[key];
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const) {
      if (row[key] !== null) result[key] = result[key] === null ? row[key] : Math.max(result[key], row[key]);
    }
  }
  return result;
}
export interface HourlyHeatmapCell {
  day: string; hour: number; bucketStart: string; observed: boolean; isFuture: boolean;
  value: number | null; metrics: AnalyticsBucket | null;
  coverage: "full" | "partial" | "none" | "unknown"; coveredMs: number | null;
}
export function coveredDuration(intervals: readonly ObservationInterval[], from: number, to: number): number {
  if (to <= from) return 0;
  const ranges = intervals.map(interval => [Math.max(from, Date.parse(interval.start)), Math.min(to, Date.parse(interval.end))] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [start, stop] of ranges) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return total;
}
/** Seven UTC calendar days with explicit pre-observation/future cells rather than invented zeros. */
export function buildHourlyHeatmap(hours: readonly AnalyticsBucket[], options: {
  now?: number; startedAt?: string; days?: number; metric?: keyof ActivityMetrics; coverageIntervals?: readonly ObservationInterval[];
} = {}): HourlyHeatmapCell[] {
  const now = options.now ?? Date.now();
  const days = Math.min(7, Math.max(1, Math.floor(options.days ?? 7)));
  const dayMs = 86_400_000, hourMs = 3_600_000;
  const start = Math.floor(now / dayMs) * dayMs - (days - 1) * dayMs;
  const observedSince = options.startedAt ? Date.parse(options.startedAt) : -Infinity;
  const currentHour = Math.floor(now / hourMs) * hourMs;
  const buckets = new Map(hours.map(bucket => [bucket.bucketStart, bucket]));
  return Array.from({ length: days * 24 }, (_, index) => {
    const at = start + index * hourMs;
    const bucketStart = new Date(at).toISOString();
    const metrics = buckets.get(bucketStart) ?? null;
    const isFuture = at > currentHour;
    const coveredMs = options.coverageIntervals === undefined ? null : coveredDuration(options.coverageIntervals, at, Math.min(at + hourMs, now));
    const observed = !isFuture && (coveredMs === null ? at + hourMs > observedSince : coveredMs > 0);
    const coverage: HourlyHeatmapCell["coverage"] = coveredMs === null ? "unknown" : coveredMs <= 0 ? "none" : coveredMs >= Math.min(hourMs, now - at) - 1 ? "full" : "partial";
    const metric = options.metric ?? "eventCount";
    const additive = !["inputTokens", "outputTokens", "cachedTokens", "costUsd"].includes(metric);
    return { day: bucketStart.slice(0, 10), hour: index % 24, bucketStart, observed, isFuture, coverage, coveredMs,
      value: observed ? metrics?.[metric] ?? (additive ? 0 : null) : null, metrics };
  });
}
