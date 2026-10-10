import type { StatsMetrics, StatsTool } from "../shared/stats";

/** Internal, compact storage types. Directory descriptors never cross the RPC boundary. */
export type StatsHour = StatsMetrics & { hour: string };
export type StatsAttribution = StatsMetrics & { agentId: string; day: string; lastActiveAt: string };
export interface StatsToolDay { day: string; tools: StatsTool[]; kinds?: StatsTool[] }
export interface StatsAgentRecord {
  agentId: string; lastKey: string | null; maxTurnMs: number; maxTurnAt: string | null; updatedAt: number;
}
export interface StatsDirectoryAgent {
  id: string; createdAt: string; provider: string; model: string | null; parentAgentId: string | null;
  projectKey: string; projectName: string; status: string; archivedAt: string | null; title: string | null;
  requiresAttention: boolean; attentionReason: string | null; pendingPermissions: number; activeTurn: boolean;
  /** Latest user message; a final reply written after it decides 待回复. */
  lastUserMessageAt?: string | null;
  /** Native last update: an upper bound for when the last turn ended. */
  updatedAt?: string | null;
  contextUsed: number | null; contextMax: number | null;
  /** Provider session id (`persistence.sessionId`), for matching provider logs. */
  sessionId: string | null;
  /** Exact working directory, used to attribute provider logs to the Paseo project. */
  cwd?: string;
  /** Paseo workspace, and the `paseo.schedule-id` / `paseo.schedule-run` labels a schedule stamps on the Agents it creates (定时运行). */
  workspaceId?: string | null;
  scheduleId?: string | null;
  scheduleRunId?: string | null;
}

export const STATS_HOUR_MS = 3_600_000;
export const STATS_DAY_MS = 86_400_000;
export const statsHour = (at: number): string => new Date(Math.floor(at / STATS_HOUR_MS) * STATS_HOUR_MS).toISOString();
export const statsDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
