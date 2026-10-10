import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { wirePageFromEntries, type FoldIndexInput, type FoldIndexOutput, type WireTurn } from "../shared/fold-index.js";

const DEFAULT_LIMIT = 150;

type TimelinePayload = {
  epoch?: unknown;
  entries?: unknown;
  startCursor?: unknown;
  endCursor?: unknown;
  hasOlder?: unknown;
  hasNewer?: unknown;
  reset?: unknown;
  staleCursor?: unknown;
  gap?: unknown;
  agent?: { status?: unknown; activeTurn?: { turnId?: unknown; startedAt?: unknown } | null } | null;
  error?: unknown;
};

function cursor(value: unknown): FoldIndexOutput["startCursor"] {
  const raw = value as { epoch?: unknown; seq?: unknown } | null;
  return raw && typeof raw.epoch === "string" && raw.epoch && typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0
    ? { epoch: raw.epoch, seq: raw.seq }
    : null;
}

const EMPTY = {
  epoch: "",
  rows: [],
  startCursor: null,
  endCursor: null,
  hasOlder: false,
  hasNewer: false,
  reset: false,
  running: null,
} as const;
const UNAVAILABLE: FoldIndexOutput = { status: "unavailable", ...EMPTY, rows: [] };
const MISSING: FoldIndexOutput = { status: "missing", ...EMPTY, rows: [] };

/**
 * 本地补丁（0.3.0-local.3）：每一轮的开始时间。投影时间线只告诉我们每条属于哪一轮（`turnId`），不告诉一轮何时开始；
 * Claude Code 自己醒来的「自主轮」连用户消息都没有。插件服务端在 `agent.turn_started` 时记下时刻，读索引时再用 Agent 快照里的
 * `activeTurn.startedAt` 校正。只记在内存里：插件重载或 daemon 重启后，之前的自主轮就不知道开始时间了（客户端那时不显示用时）。
 */
const TURN_MEMO_LIMIT = 20_000;
const turnStarts = new Map<string, number>();
const turnKey = (agentId: string, turnId: string) => `${agentId}\u0000${turnId}`;

export function noteTurnStarted(agentId: string, turnId: string | null | undefined, at: number = Date.now()): void {
  if (!agentId || !turnId || !Number.isFinite(at) || at <= 0) return;
  const key = turnKey(agentId, turnId);
  // A later start for the same id is a reopened session reusing the id: the newest wins.
  turnStarts.delete(key);
  turnStarts.set(key, at);
  if (turnStarts.size > TURN_MEMO_LIMIT) {
    let drop = turnStarts.size - TURN_MEMO_LIMIT / 2;
    for (const old of turnStarts.keys()) {
      if (drop-- <= 0) break;
      turnStarts.delete(old);
    }
  }
}

export function knownTurnStart(agentId: string, turnId: string): number | null {
  return turnStarts.get(turnKey(agentId, turnId)) ?? null;
}

/** For tests. */
export function forgetTurnStarts(): void {
  turnStarts.clear();
}

function isMissing(message: unknown): boolean {
  return typeof message === "string" && /not found/i.test(message);
}

/**
 * Reads one page of the Agent's projected timeline inside the daemon and returns its compact index. Only Agents a client
 * is showing ask for this, and showing an Agent already loads it, so the read does not wake idle sessions.
 */
export async function handleFoldIndex(input: FoldIndexInput, context: PluginHandlerContext): Promise<FoldIndexOutput> {
  let payload: TimelinePayload;
  try {
    const handle = context.paseo.agents.ref(input.agentId);
    payload = (await handle.timeline.refetch({
      direction: input.direction,
      ...(input.cursor && input.direction !== "tail" ? { cursor: input.cursor } : {}),
      limit: input.limit ?? DEFAULT_LIMIT,
      projection: "projected",
    })) as TimelinePayload;
  } catch (error) {
    // A provider subagent's own view has an id the daemon cannot read: say so, so the client stops asking.
    return isMissing(error instanceof Error ? error.message : String(error)) ? MISSING : UNAVAILABLE;
  }
  if (typeof payload.error === "string" && payload.error) return isMissing(payload.error) ? MISSING : UNAVAILABLE;
  const activeTurn = payload.agent?.activeTurn;
  let active: WireTurn | null = null;
  if (activeTurn && typeof activeTurn.turnId === "string" && activeTurn.turnId) {
    const startedAt = typeof activeTurn.startedAt === "string" ? Date.parse(activeTurn.startedAt) : NaN;
    if (Number.isFinite(startedAt) && startedAt > 0) noteTurnStarted(input.agentId, activeTurn.turnId, startedAt);
    active = { id: activeTurn.turnId.slice(0, 200), at: knownTurnStart(input.agentId, activeTurn.turnId) };
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const { rows, turns } = wirePageFromEntries(entries, (turnId) => knownTurnStart(input.agentId, turnId));
  const status = payload.agent?.status;
  return {
    status: "ok",
    epoch: typeof payload.epoch === "string" ? payload.epoch : "",
    rows,
    startCursor: cursor(payload.startCursor),
    endCursor: cursor(payload.endCursor),
    hasOlder: payload.hasOlder === true,
    hasNewer: payload.hasNewer === true,
    reset: payload.reset === true || payload.staleCursor === true || payload.gap === true,
    running: typeof status === "string" ? status === "running" : null,
    now: Date.now(),
    turns,
    active,
  };
}
