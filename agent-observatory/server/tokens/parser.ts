import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Candidate, CallSink, LedgerCall, LogFile, ParserState } from "./types";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, limit = 256): string => typeof value === "string" ? value.slice(0, limit) : "";
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const stamp = (value: unknown): number | null => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at >= 0 ? at : null;
};
export const callKey = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
export const validStart = (start: number | null, at: number): number | null => start !== null && at - start >= 100 && at - start <= 900_000 ? start : null;
export function initialParser(path: string, parentSession: string | null): ParserState {
  const name = basename(path, ".jsonl");
  const sessionId = parentSession ?? (name.startsWith("rollout-") ? name.match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)?.[1] ?? name : name);
  return { sessionId: sessionId.slice(0, 256), cwd: "", model: null, inputAt: null, lastTotal: null, open: null, openInputAt: null,
    sessions: [sessionId.slice(0, 256)], links: [], hasForks: false, metaSeen: false, pendingRecord: false, legacySessionId: sessionId.slice(0, 256) };
}
function remember(list: string[], id: string): void { if (id && !list.includes(id) && list.length < 256) list.push(id); }
function emit(file: LogFile, candidate: Candidate, start: number | null, sink: CallSink): void {
  const state = file.state, previous = state.open?.call.key === candidate.call.key ? state.open : null;
  const settled = previous ? null : state.open;
  if (previous) {
    candidate.call = { ...previous.call, at: Math.max(previous.call.at, candidate.call.at),
      output: Math.max(previous.call.output, candidate.call.output), reasoning: Math.max(previous.call.reasoning, candidate.call.reasoning) };
    candidate.call.start = validStart(state.openInputAt, candidate.call.at);
    candidate.forked = previous.forked;
  } else state.openInputAt = start;
  state.open = candidate;
  sink(candidate, previous, file, settled);
}

/** A cheap discriminator precedes JSON.parse; parsed objects never escape this function. */
export function parseLine(line: string, file: LogFile, sink: CallSink): void {
  if (file.source === "claude") {
    if (!/"type"\s*:\s*"(?:assistant|user)"/.test(line)) return;
  } else if (!/"(?:session_meta|turn_context|token_count|token_usage_record|user_message|function_call_output|custom_tool_call_output|task_started)"/.test(line) && !/"role"\s*:\s*"user"/.test(line)) return;
  let row: ObjectValue;
  try { row = object(JSON.parse(line)); } catch { return; }
  const state = file.state, at = stamp(row.timestamp);
  if (file.source === "claude") {
    const session = file.parentSession ?? (text(row.sessionId) || state.sessionId);
    state.sessionId = session; remember(state.sessions, session);
    if (typeof row.cwd === "string") state.cwd = text(row.cwd, 4096);
    const fork = object(row.forkedFrom), parent = text(fork.sessionId);
    remember(state.links, parent);
    if (row.type === "user") { if (at !== null) state.inputAt = at; return; }
    if (row.type !== "assistant" || at === null || row.isApiErrorMessage === true) return;
    const message = object(row.message), usage = object(message.usage), messageId = text(message.id, 1024);
    if (!messageId || message.model === "<synthetic>" || !Object.keys(usage).length) return;
    const model = text(message.model, 240) || null;
    const call: LedgerCall = { key: callKey(["claude", messageId, text(row.requestId, 1024)]), source: "claude", sessionId: session,
      cwd: state.cwd, model, at, start: validStart(state.inputAt, at), input: count(usage.input_tokens), cacheWrite: count(usage.cache_creation_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens), output: count(usage.output_tokens), reasoning: 0,
      subagent: file.parentSession !== null || row.isSidechain === true };
    const forked = !!row.forkedFrom; state.hasForks ||= forked;
    emit(file, { call, forked }, state.inputAt, sink);
    return;
  }
  const payload = object(row.payload);
  if (row.type === "session_meta") {
    // Fork rollouts can contain a second, copied parent session_meta. The first owns the file.
    if (state.metaSeen) {
      state.legacySessionId = text(payload.id) || state.legacySessionId;
      if (state.legacySessionId !== state.sessionId) remember(state.links, state.legacySessionId);
      return;
    }
    state.metaSeen = true;
    state.sessionId = text(payload.id) || state.sessionId;
    state.legacySessionId = state.sessionId;
    remember(state.sessions, state.sessionId);
    state.cwd = text(payload.cwd, 4096) || state.cwd;
    remember(state.links, text(payload.forked_from_id));
    return;
  }
  if (row.type === "turn_context") {
    state.model = text(payload.model, 240) || state.model; state.cwd = text(payload.cwd, 4096) || state.cwd; return;
  }
  if ((row.type === "event_msg" && (payload.type === "user_message" || payload.type === "task_started")) ||
      (row.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output" || (payload.type === "message" && payload.role === "user")))) {
    if (at !== null) state.inputAt = at;
    return;
  }
  const isRecord = row.type === "token_usage_record";
  if ((!isRecord && (row.type !== "event_msg" || payload.type !== "token_count")) || at === null) return;
  const info = object(payload.info), usage = object(isRecord ? payload.usage : info.last_token_usage);
  const total = object(isRecord ? payload.thread_token_usage : info.total_token_usage);
  if (!Object.keys(usage).length || !Object.keys(total).length) return;
  const cumulative = JSON.stringify([total.input_tokens, total.cached_input_tokens, total.cache_write_input_tokens, total.output_tokens, total.reasoning_output_tokens, total.total_tokens].map(count));
  if (!isRecord && state.pendingRecord && cumulative === state.lastTotal && state.open) {
    // The next tool result can arrive between the record and its token_count. It belongs to the NEXT call.
    emit(file, { ...state.open, call: { ...state.open.call, at } }, state.openInputAt, sink);
    state.pendingRecord = false;
    return;
  }
  if (state.lastTotal === cumulative) return;
  state.lastTotal = cumulative;
  if (isRecord) { state.sessionId = text(payload.thread_id) || state.sessionId; state.legacySessionId = state.sessionId; remember(state.sessions, state.sessionId); }
  const cached = count(usage.cached_input_tokens), written = count(usage.cache_write_input_tokens);
  const response = text(payload.response_id, 1024);
  const call: LedgerCall = { key: callKey(isRecord && response ? ["codex", response] : ["codex", state.legacySessionId, at, cumulative]), source: "codex", sessionId: state.sessionId,
    cwd: state.cwd, model: state.model, at, start: validStart(state.inputAt, at), input: Math.max(0, count(usage.input_tokens) - cached - written),
    cacheRead: cached, cacheWrite: written, output: count(usage.output_tokens), reasoning: count(usage.reasoning_output_tokens), subagent: false };
  emit(file, { call, forked: false }, state.inputAt, sink);
  state.inputAt = null; state.pendingRecord = isRecord;
}
