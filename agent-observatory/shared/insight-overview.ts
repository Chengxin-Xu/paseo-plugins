import { t } from "./text";
/**
 * 智能分析 → 总览 (2.7). Two layers over the per-Agent reports of shared/insights.ts:
 * - `observatory.insights.overview`: a deterministic roll-up of recent reports (no model call), revisioned.
 * - 建议: a model reads the recent reports and writes cross-Agent themes and actionable suggestions. Suggestion jobs
 *   share the analysis queue and runner with reports; the user marks each suggestion adopted / done / dismissed.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { insightReportSchema, insightRunnerInfoSchema, insightRunnerSchema } from "./insights";
import { statsTimeZoneSchema } from "./stats";

type Finding = z.infer<typeof insightReportSchema>["findings"][number];
export const FINDING_CATEGORIES = ["failure", "loop", "efficiency", "coordination", "quality"] as const satisfies readonly Finding["category"][];
export const FINDING_SEVERITIES = ["high", "medium", "low"] as const satisfies readonly Finding["severity"][];
export const OVERVIEW_DAYS = [7, 30] as const;
export type OverviewDays = (typeof OVERVIEW_DAYS)[number];
const days = z.union([z.literal(7), z.literal(30)]);
const count = z.number().int().nonnegative();
const health = z.enum(["healthy", "watch", "blocked"]);
const findingStatus = z.enum(["open", "resolved", "false_positive"]);

/** Where a suggestion or theme came from: a report (`findingId` null) or one finding of it. */
export const suggestionEvidenceSchema = z.object({
  jobId: z.string().max(128), findingId: z.string().max(80).nullable(), agentId: z.string().max(256),
  agentTitle: z.string().max(240), projectName: z.string().max(240), title: z.string().max(180),
  severity: z.enum(FINDING_SEVERITIES).nullable(), category: z.enum(FINDING_CATEGORIES).nullable(),
});
/** The model's output (JSON schema given to the runner). Evidence strings are the prompt's refs ("R3", "R3#f2"). */
export const suggestionReportSchema = z.object({
  /** One sentence: the state of the Agents' work over the window. */
  headline: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  /** Problems seen across Agents, most important first. */
  themes: z.array(z.object({
    id: z.string().min(1).max(80), title: z.string().min(1).max(160), detail: z.string().max(1200),
    category: z.enum(FINDING_CATEGORIES), severity: z.enum(FINDING_SEVERITIES),
    trend: z.enum(["new", "recurring", "improving"]),
    evidence: z.array(z.string().max(160)).max(12),
  })).max(8),
  /** What to change, most valuable first. */
  actions: z.array(z.object({
    id: z.string().min(1).max(80), title: z.string().min(1).max(160),
    /** Why, citing the pattern and its cost. */
    why: z.string().max(1200),
    steps: z.array(z.string().max(400)).max(6),
    scope: z.enum(["instructions", "workflow", "profile", "project", "code", "tooling"]),
    impact: z.enum(["high", "medium", "low"]), effort: z.enum(["small", "medium", "large"]),
    /** Project names as they appear in the reports; empty = every project. */
    projects: z.array(z.string().max(160)).max(6),
    evidence: z.array(z.string().max(160)).max(12),
    /** Ready-to-paste text for AGENTS.md / CLAUDE.md / a profile's notes, when the fix is an instruction. */
    instruction: z.string().max(2000).nullable(),
    /** A self-contained prompt an Agent can execute to make the change, when the fix is work. */
    task: z.string().max(3000).nullable(),
  })).min(1).max(8),
  wins: z.array(z.string().max(600)).max(5),
  watch: z.array(z.string().max(600)).max(5),
});
export const actionFeedbackSchema = z.object({ status: z.enum(["open", "adopted", "done", "dismissed"]), updatedAt: z.string() });
const offsetMinutes = z.number().int().min(-840).max(840);
/**
 * The days a suggestion read: from local midnight `days − 1` days back to `to` (grok-F3). `timeZone`: the device zone
 * they were cut in; `utcOffsetMinutes`: its offset then (alone: a fixed offset). Neither (jobs from 2.13 and older, or
 * automatic work before any client reported its zone): UTC days, which the page says.
 */
const window = z.object({ days, from: z.string(), to: z.string(), reports: count, findings: count, agents: count,
  timeZone: z.string().max(64).nullable().optional(), utcOffsetMinutes: offsetMinutes.optional() });
export const suggestionJobSchema = z.object({
  id: z.string().max(128), createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["queued", "collecting", "analyzing", "completed", "failed", "canceled", "skipped"]),
  trigger: z.enum(["manual", "auto"]), stage: z.string().max(400),
  window,
  runner: insightRunnerInfoSchema,
  usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), costUsd: z.number().nullable() }).nullable(),
  error: z.string().max(2000).nullable(),
  report: suggestionReportSchema.nullable(),
  /** Refs used by the report, resolved against the reports it read. Unknown refs are dropped. */
  evidence: z.record(z.string().max(160), suggestionEvidenceSchema).optional(),
  feedback: z.record(z.string().max(80), actionFeedbackSchema).optional(),
  /** Report job ids the model read. */
  basis: z.array(z.string().max(128)).max(120),
});
export const suggestionSummarySchema = z.object({
  id: z.string().max(128), createdAt: z.string(), updatedAt: z.string(), status: suggestionJobSchema.shape.status,
  trigger: z.enum(["manual", "auto"]), stage: z.string().max(400), window, runnerLabel: z.string().max(160), error: z.string().max(2000).nullable(),
  headline: z.string().max(200).nullable(), themes: count, actions: count,
  /** Actions still open (not adopted, done or dismissed). */
  openActions: count,
});

export const insightOverviewSchema = z.object({
  generatedAt: z.string(), days, utcOffsetMinutes: z.number().int(),
  /** The device zone the local days follow (each instant with its own offset); null: the fixed `utcOffsetMinutes`. */
  timeZone: z.string().max(64).nullable().optional(),
  /** Local dates, inclusive. */
  from: z.string(), to: z.string(),
  autoEnabled: z.boolean(), runnerLabel: z.string().max(160),
  totals: z.object({
    reports: count, agents: count, projects: count, auto: count, manual: count,
    /** Analyses that failed in the window (not Agents that failed). */
    failedRuns: count,
    openFindings: count, resolvedFindings: count, dismissedFindings: count,
    /** Open findings of high severity. */
    highOpen: count,
    /** Tokens the analyses used, when the runner reported them. */
    tokens: z.number().nonnegative().nullable(),
  }),
  health: z.object({ healthy: count, watch: count, blocked: count }),
  /** One entry per local day of the window, oldest first; each report counts on the day it finished. */
  daily: z.array(z.object({ day: z.string(), healthy: count, watch: count, blocked: count })).max(30),
  categories: z.array(z.object({ category: z.enum(FINDING_CATEGORIES), high: count, medium: count, low: count, open: count, resolved: count })).max(5),
  /** Most open findings first. */
  projects: z.array(z.object({ name: z.string().max(240), reports: count, openFindings: count, highOpen: count, blocked: count, lastAt: z.string() })).max(12),
  /** Agents that need a look: open high findings, then blocked/watch health, then open findings. Latest report per Agent. */
  agents: z.array(z.object({ agentId: z.string().max(256), title: z.string().max(240), projectName: z.string().max(240), reports: count,
    health: health.nullable(), openFindings: count, highOpen: count, lastJobId: z.string().max(128), lastAt: z.string() })).max(12),
  /** Open findings, most severe then newest (one report per Agent: its latest). */
  findings: z.array(z.object({ jobId: z.string().max(128), findingId: z.string().max(80), agentId: z.string().max(256), agentTitle: z.string().max(240),
    projectName: z.string().max(240), title: z.string().max(180), category: z.enum(FINDING_CATEGORIES), severity: z.enum(FINDING_SEVERITIES),
    status: findingStatus, at: z.string() })).max(16),
  /** Latest completed suggestion set, and the active or latest suggestion job when different. */
  suggestions: suggestionSummarySchema.nullable(),
  suggestionJob: suggestionSummarySchema.nullable(),
  /** When auto analysis would next write suggestions (needs 3 new reports and 20 h since the last automatic set). */
  nextSuggestionAt: z.string().nullable(),
  /** Completed reports since the latest suggestion set. */
  reportsSinceSuggestions: count,
});

/**
 * 7 / 30 days in the device's clock: `timeZone` (optional, as `observatory.stats.get` takes it) gives every past instant
 * its own offset when the server knows the zone and it agrees with `utcOffsetMinutes` now; without it, the fixed offset.
 */
export const getInsightOverview = defineRpc({
  name: "observatory.insights.overview",
  input: z.object({ days, utcOffsetMinutes: offsetMinutes, timeZone: statsTimeZoneSchema.optional(), revision: z.string().max(64).optional() }),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision: z.string() }),
    insightOverviewSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision: z.string() }),
  ]),
});
/** One suggestion job in full (default: the latest completed one) plus the history of suggestion jobs. */
export const getInsightSuggestions = defineRpc({
  name: "observatory.insights.suggestions", input: z.object({ jobId: z.string().min(1).max(128).optional() }),
  output: z.object({ job: suggestionJobSchema.nullable(), history: z.array(suggestionSummarySchema).max(20) }),
});
/** The device's clock cuts the window's days, as for the overview; without it, the zone a client reported last, or UTC. */
export const startInsightSuggestions = defineRpc({
  name: "observatory.insights.suggest", input: z.object({ days, runner: insightRunnerSchema.optional(), utcOffsetMinutes: offsetMinutes.optional(), timeZone: statsTimeZoneSchema.optional() }), output: suggestionJobSchema,
});
export const cancelInsightSuggestions = defineRpc({
  name: "observatory.insights.suggest-cancel", input: z.object({ jobId: z.string().min(1).max(128) }), output: suggestionJobSchema,
});
export const setActionFeedback = defineRpc({
  name: "observatory.insights.action-feedback",
  input: z.object({ jobId: z.string().min(1).max(128), actionId: z.string().min(1).max(80), status: actionFeedbackSchema.shape.status }),
  output: suggestionJobSchema,
});

export type InsightOverview = z.infer<typeof insightOverviewSchema>;
export type InsightOverviewResponse = z.infer<typeof getInsightOverview.output>;
export type SuggestionReport = z.infer<typeof suggestionReportSchema>;
export type SuggestionAction = SuggestionReport["actions"][number];
export type SuggestionTheme = SuggestionReport["themes"][number];
export type SuggestionJob = z.infer<typeof suggestionJobSchema>;
export type SuggestionSummary = z.infer<typeof suggestionSummarySchema>;
export type SuggestionEvidence = z.infer<typeof suggestionEvidenceSchema>;
export type ActionFeedback = z.infer<typeof actionFeedbackSchema>;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
const signed = (minutes: number) => `${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
/**
 * How a suggestion's days were cut when not in a device zone (grok-F3): 「按 UTC 日期」 (older jobs, or automatic work
 * before any client reported its zone) or 「按 UTC−07:00 的日期」 (a fixed offset). Null in a device zone: that is the norm.
 */
export function suggestionWindowNote(window: Pick<SuggestionJob["window"], "timeZone" | "utcOffsetMinutes">): string | null {
  if (window.timeZone) return null;
  return window.utcOffsetMinutes === undefined ? t("sharedInsightOverview.m001") : t("sharedInsightOverview.m002", { value1: signed(window.utcOffsetMinutes) });
}
export interface OverviewState { revision: string; data: InsightOverview }
export function mergeOverview(previous: OverviewState | undefined, response: InsightOverviewResponse): OverviewState {
  if (response.mode === "unchanged") {
    if (!previous || previous.revision !== response.revision) throw new Error(t("sharedInsightOverview.m003"));
    return previous;
  }
  const { mode: _mode, unchanged: _unchanged, revision, ...data } = response;
  return { revision, data };
}
