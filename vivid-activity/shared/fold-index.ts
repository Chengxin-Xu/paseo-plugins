import { defineRpc } from "@getpaseo/plugin";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { reasoningKey, toolKey, type IndexRow, type StepStatus } from "./fold";
import { isForegroundNotice, readTaskNotice } from "./notice";
import { extractApplyPatchEdits, isApplyPatchTool, normalizeToolCallDetail, resolveToolCallPresentation } from "./presentation";
import { lookFor, type LookKey } from "./vivid-model";

/**
 * 本地补丁：折叠用的时间线索引。插件服务端在 daemon 本机读 Agent 的投影时间线（`timeline.refetch`），只回传每条的
 * 位置、时间、种类、折叠键、状态和类别，不回传工具输出——手机经 relay 时一页只有几 KB。
 */
const cursorSchema = z.object({ epoch: z.string().min(1).max(200), seq: z.number().int().nonnegative() });

export const LOOK_KEYS = [
  "think", "read", "list", "edit", "write", "shell", "search", "web", "agent", "plan", "mcp", "paseo", "ask", "skill", "other",
] as const satisfies readonly LookKey[];

/** Wire form of an IndexRow (short keys: a few hundred rows per page). */
export const wireRowSchema = z.object({
  s: z.number().int().nonnegative(),
  /** seqEnd when it differs from s (the entry was updated after it began). */
  e: z.number().int().nonnegative().optional(),
  at: z.number().nonnegative(),
  k: z.enum(["r", "t", "b", "x"]),
  key: z.string().max(400).optional(),
  st: z.enum(["running", "completed", "failed", "canceled"]).optional(),
  look: z.enum(LOOK_KEYS).optional(),
  ref: z.string().max(400).optional(),
  fg: z.boolean().optional(),
  w: z.string().max(40).optional(),
  /** Index of the entry's turn in the page's `turns` table (0.3.0-local.3). */
  u: z.number().int().nonnegative().optional(),
});
export type WireRow = z.output<typeof wireRowSchema>;

/** A turn of the page: Paseo's `turnId` and its start when the plugin server knows it (`turn_started`, `activeTurn`). */
const turnSchema = z.object({ id: z.string().min(1).max(200), at: z.number().nonnegative().nullable() });
export type WireTurn = z.output<typeof turnSchema>;

export const foldIndexRpc = defineRpc({
  name: "fold-index",
  input: z.object({
    agentId: z.string().min(1).max(256),
    direction: z.enum(["tail", "after", "before"]),
    cursor: cursorSchema.nullable().optional(),
    limit: z.number().int().min(1).max(400).optional(),
  }),
  output: z.object({
    /** missing: the daemon has no such Agent (a provider subagent's own view, say); asking again will not help. */
    status: z.enum(["ok", "unavailable", "missing"]),
    epoch: z.string(),
    rows: z.array(wireRowSchema),
    startCursor: cursorSchema.nullable(),
    endCursor: cursorSchema.nullable(),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    /** The cursor was stale or the history was replaced: drop what you have and read the tail again. */
    reset: z.boolean(),
    /** The Agent's turn is running (from the snapshot that came with the page); null when unknown. */
    running: z.boolean().nullable(),
    /** The daemon's clock when it answered: live timers run on daemon time. */
    now: z.number().nonnegative().optional(),
    /** Turns of the rows (`u` indexes into it). */
    turns: z.array(turnSchema).max(1000).optional(),
    /** The turn running now, from the Agent snapshot; null when none is. */
    active: turnSchema.nullable().optional(),
  }),
});
export type FoldIndexInput = z.input<typeof foldIndexRpc.input>;
export type FoldIndexOutput = z.output<typeof foldIndexRpc.output>;

type ToolItem = {
  type: "tool_call";
  callId: string;
  name: string;
  status: StepStatus;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
};

/**
 * Tool calls this plugin leaves to Paseo, mirroring `client/transform.ts`: plans (approval cards) and the `speak`
 * shape Paseo renders as a spoken message.
 */
export function claimsToolCall(item: { name: string; detail?: { type?: unknown; input?: unknown } | null }): boolean {
  if (item.detail?.type === "plan") return false;
  if (item.name === "speak" && item.detail?.type === "unknown" && typeof item.detail.input === "string" && item.detail.input.trim()) return false;
  return true;
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
function isTodoInput(input: unknown): boolean {
  const todos = (input as { todos?: unknown } | null)?.todos;
  return Array.isArray(todos) && todos.every((todo) => {
    const entry = todo as { content?: unknown; status?: unknown } | null;
    return typeof entry?.content === "string" && TODO_STATUSES.has(String(entry.status));
  });
}
function isPlanInput(input: unknown): boolean {
  const plan = (input as { plan?: unknown } | null)?.plan;
  return Array.isArray(plan) && plan.every((step) => typeof (step as { step?: unknown } | null)?.step === "string");
}

/**
 * How Paseo 0.11.1 shows a tool call before any plugin sees it (`reduceTimelineToolCall`): task-list tools become the
 * native task rows (a boundary), Claude's TaskCreate/TaskUpdate/TaskList and unparsable Claude TodoWrite vanish (skip).
 * `provider` is the Agent's provider id. The host compares it with the literal built-in id "claude", so a custom provider
 * that extends claude is not special-cased by the host either; mirroring that keeps the fold index in step with what is
 * actually on screen. This is not a configuration default.
 */
export function hostToolDisposition(provider: string, item: { name: string; detail?: { type?: unknown; input?: unknown } | null }): "task" | "skip" | null {
  const name = item.name.trim().replace(/[.\s-]+/g, "_").toLowerCase();
  const input = item.detail?.type === "unknown" ? item.detail.input : null;
  const todo = name === "todowrite" || name === "todo_write";
  if (provider === "claude" && todo) return isTodoInput(input) ? "task" : "skip";
  if (provider === "claude" && (name === "taskcreate" || name === "taskupdate" || name === "tasklist")) return "skip";
  if (todo && isTodoInput(input)) return "task";
  if (name === "update_plan" && isPlanInput(input)) return "task";
  return null;
}

/** The row look the client draws for a tool call (apply_patch rows draw as edits). */
export function toolLook(item: Pick<ToolItem, "name" | "detail" | "metadata">): LookKey {
  if (readTaskNotice(item)) return "shell";
  if (isApplyPatchTool(item.name)) {
    const edits = extractApplyPatchEdits(item.detail, item.detail?.type === "unknown" ? item.detail.output : undefined, item.metadata);
    if (edits.length > 0) return edits.every((edit) => edit.operation === "add") ? "write" : "edit";
  }
  const detail = normalizeToolCallDetail(item.detail, item.name);
  return lookFor(item.name, detail, resolveToolCallPresentation({ name: item.name, detail }));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One projected timeline entry → its wire row. */
export function wireRowFromEntry(entry: unknown): WireRow | null {
  const source = record(entry);
  const item = record(source.item);
  const type = typeof item.type === "string" ? item.type : null;
  const seq = typeof source.seqStart === "number" ? source.seqStart : null;
  if (type === null || seq === null || !Number.isInteger(seq) || seq < 0) return null;
  const parsedAt = typeof source.timestamp === "string" ? Date.parse(source.timestamp) : NaN;
  const at = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : 0;
  const seqEnd = typeof source.seqEnd === "number" && Number.isInteger(source.seqEnd) && source.seqEnd > seq ? source.seqEnd : null;
  const base = { s: seq, ...(seqEnd !== null ? { e: seqEnd } : {}), at };
  if (type === "reasoning") {
    return typeof item.text === "string" ? { ...base, k: "r", key: reasoningKey(item.text) } : { ...base, k: "b", w: "reasoning" };
  }
  if (type !== "tool_call") return { ...base, k: "b", w: type.slice(0, 40) };
  const tool = item as unknown as ToolItem;
  if (typeof tool.callId !== "string" || typeof tool.name !== "string") return { ...base, k: "b", w: "tool" };
  const provider = typeof source.provider === "string" ? source.provider : "";
  const host = hostToolDisposition(provider, tool);
  if (host === "skip") return { ...base, k: "x", w: "hidden-tool" };
  if (host === "task") return { ...base, k: "b", w: "task" };
  if (!claimsToolCall(tool)) return { ...base, k: "b", w: tool.detail?.type === "plan" ? "plan" : "speak" };
  const status: StepStatus = ["running", "completed", "failed", "canceled"].includes(tool.status) ? tool.status : "completed";
  let look: LookKey = "other";
  try {
    look = toolLook(tool);
  } catch {
    look = "other";
  }
  const notice = readTaskNotice(tool);
  return {
    ...base,
    k: "t",
    key: toolKey(tool.callId),
    st: status,
    look,
    ...(notice?.ref ? { ref: notice.ref } : {}),
    ...(notice ? { fg: isForegroundNotice(notice) } : {}),
  };
}

/**
 * One page of projected entries → wire rows plus the table of their turns. `turnStart` gives the start the server knows
 * for a turn id (null when unknown).
 */
export function wirePageFromEntries(entries: readonly unknown[], turnStart: (turnId: string) => number | null): { rows: WireRow[]; turns: WireTurn[] } {
  const rows: WireRow[] = [];
  const turns: WireTurn[] = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    const row = wireRowFromEntry(entry);
    if (!row) continue;
    const turnId = record(entry).turnId;
    if (typeof turnId === "string" && turnId && turnId.length <= 200) {
      let u = index.get(turnId);
      if (u === undefined) {
        u = turns.length;
        index.set(turnId, u);
        turns.push({ id: turnId, at: turnStart(turnId) });
      }
      row.u = u;
    }
    rows.push(row);
  }
  return { rows, turns };
}

/** Wire row → IndexRow (client). `turns`: the page's turn table. */
export function indexRowFromWire(row: WireRow, turns?: readonly WireTurn[]): IndexRow {
  const turn = row.u !== undefined ? turns?.[row.u]?.id : undefined;
  const kind = row.k === "r" ? "reasoning" : row.k === "t" ? "tool" : row.k === "x" ? "skip" : "boundary";
  return {
    seq: row.s,
    ...(row.e !== undefined ? { seqEnd: row.e } : {}),
    at: row.at,
    kind,
    ...(row.key ? { key: row.key } : {}),
    ...(row.st ? { status: row.st } : {}),
    ...(row.look ? { look: row.look } : {}),
    ...(row.fg !== undefined ? { notice: { ref: row.ref ?? null, foreground: row.fg } } : {}),
    ...(row.w ? { what: row.w } : {}),
    ...(turn ? { turn } : {}),
  };
}
