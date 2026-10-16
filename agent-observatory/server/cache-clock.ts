// The transcript walk (`cacheStateOf`) is adapted from xhyumiracle/paseo-cache-clock/server/transcript.ts (MIT, see NOTICE).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getCacheClock, type CacheEntry, type CacheClockResponse } from "../shared/alerts";
import { quotaBaseOf } from "../shared/provider-bases";
import { contentRevision } from "./revision";
import type { PaseoApi } from "./paseo-types";
import type { StatsDirectoryAgent } from "./stats-types";

const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
/**
 * The tail read first, doubled until the walk settles, never more than the last MAX_CACHE_WINDOW bytes of a log: a cache write
 * further back than 4 MB of log is long cold anyway, and a log without cache details (a proxy) is never read whole.
 */
const FIRST_WINDOW = 256 * 1024;
export const MAX_CACHE_WINDOW = 4 * 1024 * 1024;
/** Sessions looked at per read: Claude-based, not archived, active in the last RECENT_MS, newest first. */
const MAX_SESSIONS = 60, RECENT_MS = 6 * 3_600_000, MAX_MEMO = 400;
/** A log path that became a symlink is not followed. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** What the last request of a session left in the prompt cache: when its cache was written, for how long, by which model. */
export interface CacheState { touchedAt: string; ttlMs: number; model: string }
/** A state; "compacted" when the conversation was compacted after the last request; null when the log does not settle it. */
export type CacheRead = CacheState | "compacted" | null;

interface Entry {
  type?: string; subtype?: string; uuid?: string; parentUuid?: string | null; timestamp?: string; isSidechain?: boolean; isCompactSummary?: boolean; requestId?: string;
  message?: { model?: string; usage?: { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } } };
}
const isRequest = (entry: Entry) => entry.type === "assistant" && !!entry.requestId && !!entry.message?.usage && entry.message.model !== "<synthetic>";
/** The TTL a request wrote with; a request writing both counts as the shorter (the newest part expires first); none wrote: undefined. */
function writeTtl(entry: Entry): number | undefined {
  const written = entry.message?.usage?.cache_creation;
  if (written?.ephemeral_5m_input_tokens) return TTL_MS["5m"];
  if (written?.ephemeral_1h_input_tokens) return TTL_MS["1h"];
  return undefined;
}
const parse = (line: string): Entry | undefined => { try { return JSON.parse(line) as Entry; } catch { return undefined; } };

/**
 * Walks a Claude Code transcript tail backwards along the `parentUuid` chain (the chain Claude Code resumes from, so forked
 * or resumed sessions sharing a file do not mix); lines off the chain are skipped by a substring check and never parsed. The
 * last request was sent after its nearest ancestor that is a user message or an earlier request, whose timestamp is a lower
 * bound on the send: `touchedAt + ttlMs` never runs past the real expiry. A compaction after it means the next request starts
 * cold. Undefined when the window is too short to tell (`atStart`: it reached the file's start).
 */
export function cacheStateOf(lines: readonly string[], atStart: boolean): CacheRead | undefined {
  let last: Entry | undefined, ttl: number | undefined, touchedAt: string | undefined, want: string | null | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (last && !line.includes(want!)) continue;
    const entry = parse(line);
    if (!entry) continue;
    if (!last) {
      if (entry.subtype === "compact_boundary" && !entry.isSidechain) return "compacted";
      if (!isRequest(entry) || entry.isSidechain) continue;
      last = entry; ttl = writeTtl(entry); want = entry.parentUuid;
    } else {
      if (entry.uuid !== want) continue;
      want = entry.parentUuid;
      if (entry.requestId === last.requestId) continue;
      const prior = entry.type === "assistant" && !!entry.requestId;
      if (prior || (entry.type === "user" && !entry.isCompactSummary)) touchedAt ??= entry.timestamp;
      // A request that only read the cache refreshes it at the TTL it was written with.
      if (ttl === undefined && isRequest(entry)) ttl = writeTtl(entry);
    }
    if (touchedAt && ttl !== undefined) return Number.isFinite(Date.parse(touchedAt)) ? { touchedAt, ttlMs: ttl, model: last.message?.model ?? "" } : null;
    if (!want) return null;
  }
  return atStart ? null : undefined;
}

/** The last `bytes` of a log (whole lines only; a cut first line is dropped), or null when it is not a plain file. */
async function readTail(path: string, bytes: number): Promise<{ lines: string[]; atStart: boolean; key: string } | null> {
  const handle = await open(path, OPEN_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const start = Math.max(0, info.size - bytes), buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return { lines, atStart: start === 0, key: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
  } finally { await handle.close(); }
}

/** One log's state, read again only when the log changed (device, inode, size and modification time). */
export function createCacheReader(options: { maxWindow?: number } = {}) {
  const memo = new Map<string, { key: string; state: CacheRead }>(), maxWindow = options.maxWindow ?? MAX_CACHE_WINDOW;
  return async (path: string, identity: string | null = null): Promise<CacheRead> => {
    const known = memo.get(path);
    if (known && identity !== null && known.key === identity) return known.state;
    let state: CacheRead = null, key = identity;
    for (let bytes = FIRST_WINDOW; ; bytes *= 2) {
      const tail = await readTail(path, bytes);
      if (!tail) { state = null; break; }
      key = tail.key;
      if (known && known.key === key) return known.state;
      const found = cacheStateOf(tail.lines, tail.atStart);
      if (found !== undefined) { state = found; break; }
      if (tail.atStart || bytes >= maxWindow) break;
    }
    memo.delete(path);
    if (key) memo.set(path, { key, state });
    while (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value!);
    return state;
  };
}

/** A Claude model name without the context suffix (`[1m]`) and the release date; cut to 200 characters first (the log's value is unbounded). */
const modelName = (value: string | null | undefined) => (value ?? "").slice(0, 200).toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").trim();
/**
 * Whether the Agent now runs another model than the one that wrote the cache. Only two full Claude model names that differ
 * count: an alias (`opus`, `default`) or no model on record cannot tell, so the cache is not called cold for it.
 */
export function modelChanged(cacheModel: string, agentModel: string | null | undefined): boolean {
  const written = modelName(cacheModel), current = modelName(agentModel);
  if (!written.startsWith("claude-") || !current.startsWith("claude-")) return false;
  return !written.startsWith(current) && !current.startsWith(written);
}

/** The entry a session's state gives (an expired one stays: the device shows it cold). Null when the log cannot tell. */
export function cacheEntryOf(agent: Pick<StatsDirectoryAgent, "id" | "model">, state: CacheRead): CacheEntry | null {
  if (!state) return null;
  if (state === "compacted") return { agentId: agent.id, touchedAt: null, expiresAt: null, ttl: null, cold: "compacted" };
  const touched = Date.parse(state.touchedAt), ttl = state.ttlMs === TTL_MS["1h"] ? "1h" : "5m";
  if (!Number.isFinite(touched)) return null;
  return { agentId: agent.id, touchedAt: new Date(touched).toISOString(), expiresAt: new Date(touched + TTL_MS[ttl]).toISOString(), ttl,
    cold: modelChanged(state.model, agent.model) ? "model" : null };
}

export interface CacheClockDeps {
  /** The once-a-minute Agent walk (server/stats-directory.ts); refreshed by reads. */
  directory: { agents: readonly StatsDirectoryAgent[]; refresh(paseo: PaseoApi): Promise<void> };
  /** Custom provider id → the provider it extends (server/provider-bases.ts). */
  bases(): Promise<Record<string, string>>;
  /** A session's own Claude Code log, as the token scans indexed it (custom `CLAUDE_CONFIG_DIR` included), or null. */
  transcript(sessionId: string): { path: string; identity: string } | null;
  /** Looks for custom provider log roots (rate limited): after a restart no hook may have run yet when a view first asks. */
  discover?(paseo: PaseoApi): void;
  now?: () => number;
}

/**
 * `observatory.cache.get`: the cache clock of each recent Claude-based session (`extends` decides, never the provider id), with
 * a revision, so an unchanged answer is a few bytes. The device counts down on its own; this is read every half minute while a
 * view that shows it is open. One read at a time; logs are read again only once they changed.
 */
export function registerCacheClock(server: Pick<PluginServerContext, "handle">, deps: CacheClockDeps) {
  const read = createCacheReader(), now = deps.now ?? Date.now;
  let pending: Promise<CacheEntry[]> | null = null;
  const compute = async (): Promise<CacheEntry[]> => {
    const bases = await deps.bases().catch(() => ({}) as Record<string, string>), at = now();
    const recent = deps.directory.agents.filter(agent => !agent.archivedAt && agent.sessionId && quotaBaseOf(agent.provider, bases) === "claude"
      && at - Math.max(Date.parse(agent.updatedAt ?? "") || 0, Date.parse(agent.lastUserMessageAt ?? "") || 0, Date.parse(agent.createdAt) || 0) <= RECENT_MS)
      .sort((a, b) => (Date.parse(b.updatedAt ?? b.createdAt) || 0) - (Date.parse(a.updatedAt ?? a.createdAt) || 0)).slice(0, MAX_SESSIONS);
    const entries: CacheEntry[] = [];
    for (const agent of recent) {
      const log = deps.transcript(agent.sessionId!);
      if (!log) continue;
      const entry = cacheEntryOf(agent, await read(log.path, log.identity).catch(() => null));
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => a.agentId.localeCompare(b.agentId));
  };
  server.handle(getCacheClock, async (input, { paseo }): Promise<CacheClockResponse> => {
    deps.discover?.(paseo);
    await Promise.race([deps.directory.refresh(paseo).catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 3_000); timer.unref?.(); })]);
    pending ??= compute().finally(() => { pending = null; });
    const agents = await pending, revision = contentRevision(agents);
    return input.revision === revision ? { mode: "unchanged", revision } : { mode: "full", revision, agents };
  });
}
