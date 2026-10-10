import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { STATS_RANGES } from "./stats";

/**
 * Token ledger (Token 页 / 实时流速 / per-Agent tokens in 复盘).
 *
 * Paseo does not expose per-call usage to plugins (`lastUsage` is an in-memory snapshot of the latest call or turn,
 * missing for archived agents and most providers), so the server reads the providers' own local session logs, the
 * way ccusage / TokenTracker do:
 * - Claude Code, and custom providers that extend it: `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl` and
 *   `<session>/subagents/*.jsonl`; one line per content block, deduplicated by `message.id` + `requestId`.
 * - Codex, and custom providers that extend it: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, `event_msg` /
 *   `token_count` (`last_token_usage`, deduplicated by `total_token_usage`).
 * The directories are the standard ones plus any a custom provider sets in its config or launcher (server/tokens/roots).
 * Everything on the host is counted (not only Paseo-started sessions); sessions are matched to Paseo agents through
 * `persistence.sessionId`. Only counters, model names, working directories and session ids are retained — never
 * prompts, outputs or file contents.
 *
 * Normalisation: `input` is fresh input only (neither written to nor read from the prompt cache); `cacheWrite` and
 * `cacheRead` are the cached parts, so input + cacheWrite + cacheRead is everything the model read and
 * input + cacheWrite + cacheRead + output is the total. Codex reports cached tokens inside `input_tokens`; they are
 * split out. `reasoning` is the part of `output` the provider reports as reasoning (Codex only).
 */
const count = z.number().int().nonnegative();
const duration = z.number().nonnegative().finite();
const iso = z.iso.datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rate = z.number().nonnegative().finite();

export const TOKEN_SOURCES = ["claude", "codex"] as const;
export type TokenSource = typeof TOKEN_SOURCES[number];
export const tokenSourceNames: Record<TokenSource, string> = { claude: "Claude Code", codex: "Codex" };

export const tokenCountsSchema = z.object({
  /** Model responses (API calls). */
  calls: count,
  input: count, cacheWrite: count, cacheRead: count, output: count, reasoning: count,
  /**
   * Response time summed over calls whose request start is known (previous log line), and those calls' output.
   * Output speed (TPS) = genOutput / genMs × 1000. Response time includes time to first token.
   */
  genMs: duration, genOutput: count,
});
export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export const tokenDaySchema = tokenCountsSchema.extend({ day });
export type TokenDay = z.infer<typeof tokenDaySchema>;

/** One breakdown row (model, source, project). Counts cover the selected range. */
export const tokenRowSchema = tokenCountsSchema.extend({
  key: z.string().min(1).max(1024),
  label: z.string().max(240),
  /** Vendor of the model (see `vendorOf` in ./stats); null for sources and projects. */
  vendor: z.string().max(40).nullable(),
  /** Distinct provider sessions with calls in the range. */
  sessions: count,
  lastAt: iso.nullable(),
});
export type TokenRow = z.infer<typeof tokenRowSchema>;

/** A provider session (one log file plus its subagent logs), matched to a Paseo agent when possible. */
export const tokenSessionSchema = tokenCountsSchema.extend({
  sessionId: z.string().min(1).max(256),
  source: z.enum(TOKEN_SOURCES),
  /** Model with the most calls in the range. */
  model: z.string().max(240).nullable(),
  project: z.string().max(240),
  agentId: z.string().max(256).nullable(),
  title: z.string().max(240).nullable(),
  firstAt: iso, lastAt: iso,
  /** Calls made by the session's subagents (included in the counts). */
  subagentCalls: count,
});
export type TokenSession = z.infer<typeof tokenSessionSchema>;

export const tokenSnapshotSchema = z.object({
  generatedAt: iso,
  range: z.enum(STATS_RANGES),
  utcOffsetMinutes: z.number().int(),
  from: day, to: day,
  totals: tokenCountsSchema,
  /** The equally long period right before `from`. */
  previous: tokenCountsSchema,
  allTime: tokenCountsSchema,
  /** One row per local day, oldest first, `from`…`to` inclusive (7 / 30 / 90 rows). */
  daily: z.array(tokenDaySchema).max(90),
  /** Total tokens by local hour of day (0–23) within the range. */
  hours: z.array(count).length(24),
  /** Sorted by total tokens; beyond the limits one "__other__" row (label 其他). */
  models: z.array(tokenRowSchema).max(24),
  sources: z.array(tokenRowSchema).max(TOKEN_SOURCES.length),
  projects: z.array(tokenRowSchema).max(24),
  /** Top sessions by total tokens in the range. */
  sessions: z.array(tokenSessionSchema).max(20),
  records: z.object({
    peakDay: z.object({ day, total: count }).nullable(),
    /** Fastest call with ≥ 1 s response time and ≥ 100 output tokens. */
    fastest: z.object({ tps: rate, model: z.string().max(240).nullable(), at: iso, output: count }).nullable(),
    /** Call with the most output tokens. */
    biggest: z.object({ output: count, model: z.string().max(240).nullable(), at: iso }).nullable(),
  }),
  /** Per-call output speed percentiles over the range (calls as in `records.fastest`). */
  speed: z.object({ p50: rate.nullable(), p90: rate.nullable() }),
  /** Share of total tokens in the range from sessions matched to Paseo agents (0–1), null without tokens. */
  paseoShare: z.number().min(0).max(1).nullable(),
  coverage: z.object({
    earliestAt: iso.nullable(), latestAt: iso.nullable(),
    /** First import of existing logs; counts grow while it runs. */
    backfill: z.object({ done: z.boolean(), files: count, filesDone: count, bytes: count, bytesDone: count }),
    roots: z.array(z.object({ source: z.enum(TOKEN_SOURCES), path: z.string().max(1024), files: count, error: z.string().max(240).nullable() })).max(8),
    /** A budget cut the import (2.12): too many logs, too many bytes, an oversized dedupe index, or a scan stopped early. */
    truncated: z.object({ files: z.boolean(), bytes: z.boolean(), index: z.boolean(), scan: z.boolean() }).optional(),
  }),
});
export type TokenSnapshot = z.infer<typeof tokenSnapshotSchema>;

/**
 * Budgets of the log import (server/tokens/ingester). The defaults are far above a heavy host (about 600 logs, 4.7 GB,
 * 61,000 dedupe keys and 1,600 directory entries in October 2026), so they only stop pathological trees:
 * `files` logs tracked at once (the newest win); `bytes` their total size, i.e. what a first import may read; `index`
 * dedupe keys kept (the newest; older calls then count as copied history); `scanEntries` directory entries one scan visits.
 */
export const TOKEN_IMPORT_LIMITS = { files: 20_000, bytes: 64 * 1024 ** 3, index: 750_000, scanEntries: 250_000 } as const;
export type TokenImportLimits = { -readonly [Key in keyof typeof TOKEN_IMPORT_LIMITS]: number };
const wan = (count: number) => `${count / 10_000} 万`;
/** Why the Token page is incomplete, in Chinese, or null when no budget cut the import. */
export function tokenTruncationNotice(truncated: { files: boolean; bytes: boolean; index: boolean; scan: boolean } | undefined, limits: TokenImportLimits = TOKEN_IMPORT_LIMITS): string | null {
  if (!truncated) return null;
  const reasons = [truncated.files ? `日志文件超过 ${wan(limits.files)}个，只统计最新的部分` : null, truncated.bytes ? `日志总量超过 ${limits.bytes / 1024 ** 3} GB，更早的文件没有导入` : null,
    truncated.scan ? `日志目录条目超过 ${wan(limits.scanEntries)}个，本次扫描提前结束` : null, truncated.index ? `去重索引超过 ${wan(limits.index)}条，最早的记录已截断` : null].filter(Boolean);
  return reasons.length ? `统计不完整：${reasons.join("；")}。` : null;
}

const revision = z.string().min(1).max(80);
const offset = z.number().int().min(-840).max(840);
export const tokenResponseSchema = z.discriminatedUnion("mode", [
  tokenSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export const getTokens = defineRpc({
  name: "observatory.tokens.get",
  input: z.object({ range: z.enum(STATS_RANGES), utcOffsetMinutes: offset, revision: revision.optional() }),
  output: tokenResponseSchema,
});
export type TokenState = TokenSnapshot & { revision?: string };
export function mergeTokens(previous: TokenState | undefined, response: TokenResponse): TokenState {
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return { ...snapshot, revision: response.revision }; }
  if (!previous) throw new Error("本地 Token 缓存已失效，正在重新读取。");
  return previous;
}

/** A session producing output right now (a call ended within the last 10 minutes). */
export const tokenLiveAgentSchema = z.object({
  sessionId: z.string().min(1).max(256),
  source: z.enum(TOKEN_SOURCES),
  agentId: z.string().max(256).nullable(),
  title: z.string().max(240).nullable(),
  model: z.string().max(240).nullable(),
  /** Output tokens per second over the last 2 minutes (spread over each call's response time). */
  outputPerSec: rate,
  /** Output tokens per bucket over the last 2 minutes (12 × 10 s), oldest first — the row's mini chart. */
  recent: z.array(count).length(12),
  output10m: count, calls10m: count,
  lastCallAt: iso,
});
export type TokenLiveAgent = z.infer<typeof tokenLiveAgentSchema>;

/**
 * Live throughput for the last `windowMinutes`. Each call's output is spread evenly over its response time
 * (start → end) across the buckets it overlaps; calls without a known start count in their end bucket. Input is
 * counted in the end bucket. The last bucket is the one containing `generatedAt` (partial).
 */
export const tokenLiveSchema = z.object({
  generatedAt: iso,
  bucketMs: z.literal(10_000),
  /** Start of the first bucket. */
  start: iso,
  output: z.array(count).max(360),
  input: z.array(count).max(360),
  calls: z.array(count).max(360),
  now: z.object({ outputPerSec: rate, inputPerSec: rate, callsPerMin: rate }),
  /** Highest 10 s bucket in the window, as tokens per second. */
  peak: z.object({ outputPerSec: rate, at: iso }).nullable(),
  /** Sorted by outputPerSec, then lastCallAt. */
  agents: z.array(tokenLiveAgentSchema).max(12),
  /** Total tokens since local midnight (for the hero), and output since local midnight. */
  today: z.object({ total: count, output: count, calls: count }),
});
export type TokenLive = z.infer<typeof tokenLiveSchema>;
export const TOKEN_LIVE_WINDOWS = [30, 60] as const;
export const getTokenLive = defineRpc({
  name: "observatory.tokens.live",
  input: z.object({
    windowMinutes: z.union([z.literal(30), z.literal(60)]),
    utcOffsetMinutes: offset,
    /** "agents" returns empty series (for the session list's running rows); "full" everything. */
    detail: z.enum(["full", "agents"]),
  }),
  output: tokenLiveSchema,
});

export function emptyTokenCounts(): TokenCounts {
  return { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, genMs: 0, genOutput: 0 };
}
export function addTokenCounts<T extends TokenCounts>(target: T, delta: Partial<TokenCounts>): T {
  for (const key of Object.keys(emptyTokenCounts()) as (keyof TokenCounts)[]) target[key] += delta[key] ?? 0;
  return target;
}
export const tokenTotal = (counts: Pick<TokenCounts, "input" | "cacheWrite" | "cacheRead" | "output">) => counts.input + counts.cacheWrite + counts.cacheRead + counts.output;
/** Everything the model read: fresh input plus cache writes and reads. */
export const tokenInput = (counts: Pick<TokenCounts, "input" | "cacheWrite" | "cacheRead">) => counts.input + counts.cacheWrite + counts.cacheRead;
/** Share of read input served from the prompt cache (0–1), null without input. */
export const cacheHitRate = (counts: Pick<TokenCounts, "input" | "cacheWrite" | "cacheRead">): number | null => {
  const read = tokenInput(counts);
  return read > 0 ? counts.cacheRead / read : null;
};
/** Output tokens per second over calls with a known response time, null below one second of samples. */
export const outputSpeed = (counts: Pick<TokenCounts, "genMs" | "genOutput">): number | null => counts.genMs >= 1000 ? counts.genOutput / counts.genMs * 1000 : null;
