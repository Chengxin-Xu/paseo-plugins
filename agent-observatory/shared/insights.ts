import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Who writes reports and suggestions. `auto` (the default) picks at run time: the Grok CLI when it is installed,
 * otherwise an enabled Paseo provider (Claude Code, then Codex, then any other that can analyse safely) with its
 * default model. `grok` is the Grok CLI (grok-4.7 · xhigh, tools disabled, empty temp directory). `profile` /
 * `provider` start a Paseo agent with that profile or provider/model as a sub-agent of the analysed Agent (its
 * workspace, the provider's safest mode, every tool permission prompt denied), archived when done.
 */
export const insightRunnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("grok") }),
  z.object({ kind: z.literal("profile"), profileId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("provider"), provider: z.string().min(1).max(120), model: z.string().min(1).max(240).nullable(), thinkingOptionId: z.string().min(1).max(120).nullable() }),
]);
/** What actually ran a job, resolved when it started (a profile can change later). */
export const insightRunnerInfoSchema = z.object({
  /** `auto` only while a queued job waits for its runner to be picked. */
  kind: z.enum(["auto", "grok", "profile", "provider"]),
  /** "Grok 4.7 · xhigh", the profile name, or "Claude Code · claude · Opus 5.5 · max". */
  label: z.string().max(160),
  provider: z.string().max(120).nullable(),
  model: z.string().max(240).nullable(),
  thinkingOptionId: z.string().max(120).nullable(),
  modeId: z.string().max(80).nullable(),
  /** The Paseo analysis agent (archived when done), openable from the report; null for the built-in Grok CLI. */
  sessionAgentId: z.string().max(256).nullable(),
});
export const insightSettingsSchema = z.object({
  /** Off by default; 2.7 switched every earlier saved setting off once. */
  autoEnabled: z.boolean(),
  minTurns: z.number().int().min(2).max(20),
  minTools: z.number().int().min(1).max(100),
  cooldownHours: z.number().min(1).max(168),
  runner: insightRunnerSchema.default({ kind: "auto" }),
});
export const insightReportSchema = z.object({
  summary: z.string().min(1).max(4000),
  health: z.enum(["healthy", "watch", "blocked"]),
  confidence: z.enum(["high", "medium", "low"]),
  findings: z.array(z.object({
    id: z.string().max(80),
    severity: z.enum(["high", "medium", "low"]),
    category: z.enum(["failure", "loop", "efficiency", "coordination", "quality"]),
    title: z.string().max(180),
    detail: z.string().max(4000),
    evidence: z.array(z.string().max(300)).max(12),
    recommendation: z.string().max(2500),
  })).max(12),
  strengths: z.array(z.string().max(1500)).max(8),
  nextActions: z.array(z.string().max(1500)).max(8),
  limitations: z.array(z.string().max(1500)).max(8),
});
/** Collected source excerpts matched to exact report references, not model-created quotations. */
export const insightEvidenceSchema = z.object({
  ref: z.string().min(1).max(300),
  at: z.string().nullable(),
  kind: z.string().max(100),
  toolName: z.string().max(200).nullable(),
  text: z.string().max(2000),
});
export const insightSourceSchema = z.object({
  epoch: z.string(), endSeq: z.number().int().nonnegative(), capturedAt: z.string(),
  userTurns: z.number().int().nonnegative(), lastTurnId: z.string().nullable(),
  observedTurnCounter: z.number().int().nonnegative(),
  observedGeneration: z.number().int().nonnegative().optional(),
});
export const findingFeedbackSchema = z.object({ status: z.enum(["open", "resolved", "false_positive"]), updatedAt: z.string() });
export const insightJobSchema = z.object({
  id: z.string(), agentId: z.string(), agentTitle: z.string(), projectName: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["queued", "collecting", "analyzing", "completed", "failed", "canceled", "skipped"]),
  trigger: z.enum(["manual", "auto"]), stage: z.string(),
  eligibility: z.object({ eligible: z.boolean(), turnCount: z.number(), toolCount: z.number(), reason: z.string() }).nullable(),
  coverage: z.object({ rows: z.number(), truncated: z.boolean(), oldestAt: z.string().nullable(), newestAt: z.string().nullable(), characters: z.number() }).nullable(),
  report: insightReportSchema.nullable(),
  evidence: z.array(insightEvidenceSchema).max(80).optional(),
  /** Model id ("grok-4.7", "claude-opus-5-5[1m]" …) and thinking option; reports before 2.7 are always Grok 4.6/4.7 · xhigh. */
  model: z.string().min(1).max(240), effort: z.string().max(120).nullable(),
  runner: insightRunnerInfoSchema.optional(),
  usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), costUsd: z.number().nullable() }).nullable(),
  error: z.string().nullable(),
  source: insightSourceSchema.optional(),
  freshness: z.object({ state: z.enum(["current", "new_activity", "unknown"]), newTurns: z.number().int().nonnegative().nullable(), latestTurnAt: z.string().nullable() }).optional(),
  reviewContext: z.object({ mode: z.enum(["full", "incremental"]), baseJobId: z.string().nullable(), newRows: z.number().int().nonnegative(), unresolvedFindings: z.number().int().nonnegative() }).optional(),
  findingFeedback: z.record(z.string(), findingFeedbackSchema).optional(),
  nextAutoAt: z.string().nullable().optional(),
  skipCount: z.number().int().positive().optional(),
});
export const insightJobSummarySchema = insightJobSchema.omit({ report: true, evidence: true }).extend({
  reportAvailable: z.boolean(), summary: z.string().nullable(), health: z.enum(["healthy", "watch", "blocked"]).nullable(),
  findings: z.number().int().nonnegative(), resolvedFindings: z.number().int().nonnegative(),
});
export const listInsightJobs = defineRpc({
  name: "observatory.insights.list", input: z.object({ agentId: z.string().min(1).max(256).optional(), revision: z.number().int().nonnegative().optional() }),
  /** `runnerLabel`: the configured runner's display label (2.7). */
  output: z.object({ settings: insightSettingsSchema, runnerLabel: z.string().max(160).optional(), jobs: z.array(insightJobSummarySchema).max(140),
    persistenceError: z.string().nullable(), available: z.boolean(), revision: z.number().int().nonnegative(), unchanged: z.boolean(), activeCount: z.number().int().nonnegative(), nextScheduledAt: z.string().nullable().optional() }),
});
export const getInsightReport = defineRpc({ name: "observatory.insights.report", input: z.object({ jobId: z.string().min(1).max(128) }),
  output: z.object({ job: insightJobSchema.nullable(), revision: z.number().int().nonnegative() }) });
export const setFindingFeedback = defineRpc({ name: "observatory.insights.feedback",
  input: z.object({ jobId: z.string().min(1).max(128), findingId: z.string().max(80), status: findingFeedbackSchema.shape.status }),
  output: insightJobSchema });
export const getInsightState = defineRpc({
  name: "observatory.insights.state",
  input: z.object({ agentId: z.string().min(1).max(256).optional() }),
  output: z.object({ settings: insightSettingsSchema, jobs: z.array(insightJobSchema), persistenceError: z.string().nullable(), available: z.boolean() }),
});
export const startInsight = defineRpc({
  name: "observatory.insights.start",
  /** `runner` overrides the configured runner for this one analysis. */
  input: z.object({ agentId: z.string().min(1).max(256), question: z.string().max(2000).optional(), mode: z.enum(["full", "incremental"]).optional(), runner: insightRunnerSchema.optional() }),
  output: insightJobSchema,
});
export const cancelInsight = defineRpc({
  name: "observatory.insights.cancel", input: z.object({ jobId: z.string().min(1).max(128) }), output: insightJobSchema,
});
/** Partial update; turning auto off also cancels queued automatic jobs. */
export const updateInsightSettings = defineRpc({
  name: "observatory.insights.configure", input: z.object({ autoEnabled: z.boolean().optional(), runner: insightRunnerSchema.optional() }), output: insightSettingsSchema,
});
/**
 * How a runner will analyse: `none` = tools disabled (built-in Grok CLI); `read` = a read-only mode (plan / ask / codex
 * read-only); `ask` = no read-only mode, so every tool permission prompt is denied automatically.
 */
export const RUNNER_ACCESS = ["none", "read", "ask"] as const;
export const insightRunnerOptionSchema = z.object({
  runner: insightRunnerSchema,
  label: z.string().max(160),
  /** Profile notes or provider description, trimmed. */
  detail: z.string().max(400).nullable(),
  providerLabel: z.string().max(160).nullable(),
  modelLabel: z.string().max(240).nullable(),
  thinkingLabel: z.string().max(120).nullable(),
  available: z.boolean(),
  /** Why it cannot run, or a caution for `ask` access. */
  reason: z.string().max(300).nullable(),
  access: z.enum(RUNNER_ACCESS),
  /** The mode an analysis will use (not the profile's own mode). */
  modeId: z.string().max(80).nullable(),
});
export const insightProviderOptionSchema = z.object({
  provider: z.string().max(120), label: z.string().max(160), available: z.boolean(), reason: z.string().max(300).nullable(),
  access: z.enum(RUNNER_ACCESS), modeId: z.string().max(80).nullable(), defaultModel: z.string().max(240).nullable(),
});
/** Automatic choice, the Grok CLI, the host's agent profiles (daemon config) and enabled providers, from cached daemon snapshots (no provider probes). */
export const listInsightRunners = defineRpc({
  name: "observatory.insights.runners", input: z.object({}),
  output: z.object({ auto: insightRunnerOptionSchema, builtin: insightRunnerOptionSchema, profiles: z.array(insightRunnerOptionSchema).max(40), providers: z.array(insightProviderOptionSchema).max(40) }),
});
export const insightModelOptionSchema = z.object({
  id: z.string().max(240), label: z.string().max(240), isDefault: z.boolean(),
  thinking: z.array(z.object({ id: z.string().max(120), label: z.string().max(120) })).max(16), defaultThinkingOptionId: z.string().max(120).nullable(),
});
export const listInsightModels = defineRpc({
  name: "observatory.insights.models", input: z.object({ provider: z.string().min(1).max(120) }),
  output: z.object({ provider: z.string().max(120), models: z.array(insightModelOptionSchema).max(150) }),
});
export type InsightSettings = z.infer<typeof insightSettingsSchema>;
export type InsightRunner = z.infer<typeof insightRunnerSchema>;
export type InsightRunnerInfo = z.infer<typeof insightRunnerInfoSchema>;
export type InsightRunnerOption = z.infer<typeof insightRunnerOptionSchema>;
export type InsightProviderOption = z.infer<typeof insightProviderOptionSchema>;
export type InsightModelOption = z.infer<typeof insightModelOptionSchema>;
export type InsightRunners = z.infer<typeof listInsightRunners.output>;
export type InsightJob = z.infer<typeof insightJobSchema>;
export type InsightReport = z.infer<typeof insightReportSchema>;
export type InsightEvidence = z.infer<typeof insightEvidenceSchema>;
export type InsightState = z.infer<typeof getInsightState.output>;
export type InsightSource = z.infer<typeof insightSourceSchema>;
export type FindingFeedback = z.infer<typeof findingFeedbackSchema>;
export type InsightJobSummary = z.infer<typeof insightJobSummarySchema>;
export type InsightListState = z.infer<typeof listInsightJobs.output>;
export type EvidenceTarget = { agentId: string; ref: string };
