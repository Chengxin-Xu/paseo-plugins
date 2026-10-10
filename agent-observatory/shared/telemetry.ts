import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** These are observations made while this plugin is enabled, not lifetime session totals. */
export const agentTelemetrySchema = z.object({
  agentId: z.string().min(1).max(256),
  turnStartedAt: z.iso.datetime().nullable(),
  turnEndedAt: z.iso.datetime().nullable(),
  outcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  completedTurns: z.number().int().nonnegative(),
  failedTurns: z.number().int().nonnegative(),
  canceledTurns: z.number().int().nonnegative(),
  totalRunMs: z.number().nonnegative(),
  permissionWaitMs: z.number().nonnegative(),
  /** The latest turn's final reply: when it was written and whether it hands the next step to the user (待回复). Never its text. */
  replyAt: z.iso.datetime().nullable().optional(),
  replyAsks: z.boolean().nullable().optional(),
  /** The user message (its time) a backfill already read the reply for, so each turn's tail is fetched at most once. */
  replyFor: z.iso.datetime().nullable().optional(),
});

export const telemetryEventSchema = z.object({
  id: z.string().min(1).max(128),
  agentId: z.string().min(1).max(256),
  agentTitle: z.string().max(160),
  at: z.iso.datetime(),
  type: z.enum([
    "created",
    "turn_started",
    "turn_completed",
    "turn_failed",
    "turn_canceled",
    "permission_requested",
    "permission_resolved",
    "archived",
  ]),
  label: z.string().max(160),
  durationMs: z.number().nonnegative().optional(),
});

export const telemetrySnapshotSchema = z.object({
  startedAt: z.iso.datetime(),
  persistenceError: z.string().nullable(),
  agents: z.array(agentTelemetrySchema).max(2_000),
  events: z.array(telemetryEventSchema).max(500),
});

const revision = z.string().min(1).max(80);
/**
 * `full` without a known revision; afterwards only summaries/events recorded after that revision (`delta`),
 * or a few bytes when nothing changed. A plugin reload issues a new revision generation and a full reply.
 */
export const telemetryResponseSchema = z.discriminatedUnion("mode", [
  telemetrySnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  // `eventCount` is how many events the server retains in this scope; the client trims to it after merging.
  telemetrySnapshotSchema.extend({ mode: z.literal("delta"), unchanged: z.literal(false), revision, eventCount: z.number().int().nonnegative().max(500) }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);

export const getTelemetry = defineRpc({
  name: "observatory.telemetry.get",
  input: z.object({ agentId: z.string().min(1).max(256).optional(), revision: revision.optional() }),
  output: telemetryResponseSchema,
});

export type AgentTelemetry = z.infer<typeof agentTelemetrySchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>;
export type TelemetryResponse = z.infer<typeof telemetryResponseSchema>;
export type TelemetryState = TelemetrySnapshot & { revision?: string };
export type TurnOutcome = NonNullable<AgentTelemetry["outcome"]>;

/** Client cache update: deltas replace changed summaries and prepend new events, trimmed to the server's retained count. */
export function mergeTelemetry(previous: TelemetryState | undefined, response: TelemetryResponse | TelemetrySnapshot): TelemetryState {
  if (!("mode" in response)) return response;
  if (response.mode !== "full" && !previous) throw new Error("本地观测缓存已失效，正在重新读取完整记录。");
  if (response.mode === "unchanged") return previous!;
  if (response.mode === "full" || !previous) { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return snapshot; }
  const { mode: _mode, unchanged: _unchanged, eventCount, ...snapshot } = response;
  const agentIds = new Set(snapshot.agents.map(agent => agent.agentId)), eventIds = new Set(snapshot.events.map(event => event.id));
  return { ...snapshot, agents: [...snapshot.agents, ...previous.agents.filter(agent => !agentIds.has(agent.agentId))],
    events: [...snapshot.events, ...previous.events.filter(event => !eventIds.has(event.id))].slice(0, eventCount) };
}
