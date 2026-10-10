import type { AgentRecord } from "./model";
import { isUnreadCompletion, timestamp } from "./model";
export type TimeRange = "24h" | "7d" | "30d" | "all";
export const DEFAULT_TIME_RANGE: TimeRange = "7d";
export const rangeLabels: Record<TimeRange, string> = { "24h": "24 小时", "7d": "最近 7 天", "30d": "最近 30 天", all: "全部时间" };
/** Best known execution timestamp; archival metadata alone is never execution. */
export function historyActivityTimestamp(agent: AgentRecord): number | null {
  if (!agent.archivedAt) return timestamp(agent.lastActivityAt) ?? timestamp(agent.updatedAt) ?? timestamp(agent.createdAt);
  const markers = [agent.lastExecutionAt, agent.lastUserMessageAt, agent.activeTurnStartedAt, agent.attentionTimestamp]
    .map(timestamp).filter((value): value is number => value !== null);
  if (markers.length) return Math.max(...markers);
  const archiveTime = timestamp(agent.archivedAt);
  const retained = [agent.lastActivityAt, agent.updatedAt].map(timestamp)
    .filter((value): value is number => value !== null && archiveTime !== null && value < archiveTime);
  return retained.length ? Math.max(...retained) : timestamp(agent.createdAt);
}
export function withinRange(agent: AgentRecord, range: TimeRange = DEFAULT_TIME_RANGE, now = Date.now()): boolean {
  if (range === "all") return true;
  if (!agent.archivedAt && ["running", "waiting", "initializing"].includes(agent.status)) return true;
  if (isUnreadCompletion(agent)) return true;
  if (!Number.isFinite(now)) return false;
  const since = now - (range === "24h" ? 1 : range === "7d" ? 7 : 30) * 86400_000;
  const time = historyActivityTimestamp(agent);
  return time !== null && time >= since && time <= now;
}
const rangeSpan = (range: TimeRange) => (range === "24h" ? 1 : range === "7d" ? 7 : 30) * 86400_000;
/** The earliest instant after `now` at which `withinRange` can change for one of these agents; Infinity if none. */
export function nextRangeChange(agents: readonly AgentRecord[], range: TimeRange, now: number): number {
  if (range === "all" || !Number.isFinite(now)) return Infinity;
  const span = rangeSpan(range);
  let next = Infinity;
  for (const agent of agents) {
    if (!agent.archivedAt && ["running", "waiting", "initializing"].includes(agent.status) || isUnreadCompletion(agent)) continue;
    const time = historyActivityTimestamp(agent);
    if (time === null) continue;
    if (time > now) next = Math.min(next, time);
    if (time + span + 1 > now) next = Math.min(next, time + span + 1);
  }
  return next;
}
/** The earliest instant after `now` at which one of these timestamps leaves the range window; Infinity if none. */
export function nextWindowExit(times: readonly number[], range: TimeRange, now: number): number {
  if (range === "all" || !Number.isFinite(now)) return Infinity;
  const span = rangeSpan(range);
  let next = Infinity;
  for (const time of times) if (Number.isFinite(time) && time + span + 1 > now) next = Math.min(next, time + span + 1);
  return next;
}
