import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ProviderSubagentSchema, providerSubagentsRpc, providerTimelineRpc } from "../shared/provider-subagents";
import { normalizeTimelinePage, projectTimelineRows, string } from "../shared/timeline";

/**
 * Raw session requests PaseoApi 0.9 still lacks (provider subagents, workspace recovery, refresh,
 * clear attention). They ride the plugin's existing IPC session as `paseo_frame` envelopes; no
 * second connection is opened. After the host closes that session (e.g. an expired heartbeat
 * lease), frames are dropped until the SDK re-attaches, so in-flight requests fail at once and new
 * ones wait for the re-attached session's first frame instead of timing out.
 */
export interface ProviderIpcPort {
  send(message: unknown): void;
  listen(listener: (message: unknown) => void): () => void;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : {};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const REQUEST_PREFIX = "observatory-read-";
export function createProviderSubagentBridge(port: ProviderIpcPort, timeoutMs = 8000) {
  const pending = new Map<string, { type: string; resolve(value: Record<string, unknown>): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout>; sent: boolean }>();
  const waiting: Array<() => void> = [];
  let disposed = false, hostOpen = true;
  const unsubscribe = port.listen((raw) => {
    const envelope = record(raw);
    if (envelope.type === "paseo_close") {
      hostOpen = false;
      for (const [id, item] of pending) if (item.sent) { pending.delete(id); clearTimeout(item.timer); item.reject(new Error("宿主未响应：插件会话已重新连接，请重试。")); }
      return;
    }
    if (envelope.type !== "paseo_frame" || envelope.isBinary !== false || typeof envelope.data !== "string") return;
    if (!hostOpen) { hostOpen = true; for (const send of waiting.splice(0)) send(); }
    // The plugin's own SDK connection shares this channel; skip parsing its (often large) frames.
    if (!envelope.data.includes(REQUEST_PREFIX)) return;
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(envelope.data)); } catch { return; }
    const message = parsed.type === "session" ? record(parsed.message) : parsed;
    const payload = record(message.payload);
    const id = typeof payload.requestId === "string" ? payload.requestId : "";
    const request = pending.get(id);
    if (!request || (message.type !== request.type && message.type !== "rpc_error")) return;
    pending.delete(id); clearTimeout(request.timer);
    if (payload.error || message.type === "rpc_error") request.reject(new Error(errorText(payload.error || "宿主拒绝了子任务读取请求")));
    else request.resolve(payload);
  });
  const request = (message: Record<string, unknown>, responseType: string): Promise<Record<string, unknown>> => {
    if (disposed) return Promise.reject(new Error("子任务观察通道已关闭"));
    if (pending.size >= 24) return Promise.reject(new Error("子任务读取繁忙，请稍后重试"));
    return new Promise((resolve, reject) => {
      const requestId = `${REQUEST_PREFIX}${randomUUID()}`;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("宿主未响应子任务请求。可重试，或确认 Paseo 宿主支持子任务观察。")); }, timeoutMs);
      const entry = { type: responseType, resolve, reject, timer, sent: false };
      pending.set(requestId, entry);
      const send = () => {
        if (pending.get(requestId) !== entry) return;
        try { port.send({ type: "paseo_frame", data: JSON.stringify({ type: "session", message: { ...message, requestId } }), isBinary: false }); entry.sent = true; }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
      };
      if (hostOpen) send(); else waiting.push(send);
    });
  };
  return { request, dispose() { if (disposed) return; disposed = true; unsubscribe(); waiting.length = 0;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("插件重新加载，子任务请求已取消")); }
    pending.clear(); } };
}
interface ContentBudget { characters: number; nodes: number; truncated: boolean }
/** A shared payload budget also bounds wide/nested tool outputs on mobile. */
function boundedData(value: unknown, budget: ContentBudget, depth = 0): unknown {
  if (depth > 8 || budget.characters <= 0 || --budget.nodes <= 0) { budget.truncated = true; return "[内容已截断]"; }
  if (typeof value === "string") {
    const limit = Math.min(24000, budget.characters); const result = value.slice(0, limit);
    budget.characters -= result.length;
    if (result.length < value.length) { budget.truncated = true; return `${result}\n… 内容已截断`; }
    return result;
  }
  if (Array.isArray(value)) { if (value.length > 200) budget.truncated = true; return value.slice(0, 200).map(item => boundedData(item, budget, depth + 1)); }
  if (value && typeof value === "object") {
    const entries = Object.entries(value); if (entries.length > 80) budget.truncated = true;
    return Object.fromEntries(entries.slice(0, 80).map(([key, item]) => [key.slice(0, 120), boundedData(item, budget, depth + 1)]));
  }
  return value;
}
export function boundProviderTimeline(payload: Record<string, unknown>): Record<string, unknown> {
  const budget: ContentBudget = { characters: 180000, nodes: 10000, truncated: false };
  // Paseo 0.8 limits projected *items*, but returns every canonical token row
  // covering those items. Project before limiting: slicing raw rows takes an old
  // prefix and can hide the latest twenty minutes of a live child conversation.
  const normalized = normalizeTimelinePage(payload);
  const projected = projectTimelineRows(normalized.rows);
  const direction = payload.reset === true ? "tail" : payload.direction;
  const cut = projected.length > 150;
  const selected = direction === "after" ? projected.slice(0, 150) : projected.slice(-150);
  const rows = new Array<Record<string, unknown>>(selected.length);
  // Prefer recent output when a large historical tool result exhausts the budget.
  const indexes = selected.map((_, index) => index);
  if (direction !== "after") indexes.reverse();
  for (const index of indexes) {
    const row = selected[index], item = row.item;
    const limited: Record<string, unknown> & { type: string } = { ...record(boundedData(item, budget)), type: item.type };
    if (item.type === "tool_call") {
      Object.assign(limited, { callId: string(item.callId).slice(0, 512), name: string(item.name).slice(0, 240), status: item.status });
      const detail = record(item.detail);
      if (!limited.detail || typeof limited.detail !== "object") {
        limited.detail = { type: string(detail.type) || "unknown", command: string(detail.command).slice(0, 320),
          filePath: string(detail.filePath).slice(0, 512), description: string(detail.description).slice(0, 320),
          output: "工具详情超出当前页容量；可在原生会话中查看。" };
      }
    } else if (typeof item.text === "string" && typeof limited.text !== "string") {
      limited.text = "内容超出当前页容量；可在原生会话中查看。";
    }
    rows[index] = { seq: row.seqEnd, seqStart: row.seqStart, seqEnd: row.seqEnd,
      sourceSeqRanges: row.sourceRanges ?? [{ startSeq: row.seqStart, endSeq: row.seqEnd }],
      timestamp: row.timestamp, turnId: row.turnId, providerMessageId: row.providerMessageId, item: limited };
  }
  const { rows: _rawRows, entries: _rawEntries, ...metadata } = payload;
  const firstSeq = selected.length ? Math.min(...selected.map(row => row.seqStart)) : undefined;
  const lastSeq = selected.length ? Math.max(...selected.map(row => row.seqEnd)) : undefined;
  return { ...metadata, rows, projection: "projected",
    startCursor: cut && direction !== "after" && firstSeq !== undefined ? { epoch: normalized.epoch, seq: firstSeq } : normalized.startCursor,
    endCursor: cut && direction === "after" && lastSeq !== undefined ? { epoch: normalized.epoch, seq: lastSeq } : normalized.endCursor,
    hasOlder: normalized.hasOlder || cut && direction !== "after", hasNewer: normalized.hasNewer || cut && direction === "after",
    truncated: budget.truncated || cut || normalized.truncated };
}
export function registerProviderSubagents(server: PluginServerContext): () => void {
  const bridge = createProviderSubagentBridge({
    send(message) { if (!process.send) throw new Error("当前环境没有 Paseo 宿主通道"); process.send(message); },
    listen(listener) { process.on("message", listener); return () => process.off("message", listener); },
  });
  server.handle(providerSubagentsRpc, async ({ parentAgentId }) => {
    try {
      const payload = await bridge.request({ type: "agent.provider_subagents.list.request", parentAgentId }, "agent.provider_subagents.list.response");
      if (!Array.isArray(payload.subagents)) throw new Error("宿主返回了无法识别的子任务数据");
      const summaries = payload.subagents.slice(0, 500).map(value => {
        const row = record(value);
        return { ...row, title: typeof row.title === "string" ? row.title.slice(0, 240) : row.title,
          description: typeof row.description === "string" ? row.description.slice(0, 1200) : row.description,
          subtitle: typeof row.subtitle === "string" ? row.subtitle.slice(0, 400) : row.subtitle,
          cwd: typeof row.cwd === "string" ? row.cwd.slice(0, 1024) : row.cwd };
      });
      const parsed = ProviderSubagentSchema.array().safeParse(summaries);
      if (!parsed.success) throw new Error("子任务格式与当前宿主不兼容");
      return { subagents: parsed.data, error: null, truncated: payload.subagents.length > 500 };
    } catch (error) { return { subagents: [], error: errorText(error), truncated: false }; }
  });
  server.handle(providerTimelineRpc, async (input) => {
    try {
      const payload = await bridge.request({ type: "agent.provider_subagents.timeline.get.request", ...input }, "agent.provider_subagents.timeline.get.response");
      if (!Array.isArray(payload.rows) && !Array.isArray(payload.entries)) throw new Error("宿主尚未提供此子任务的执行记录");
      return { page: boundProviderTimeline(payload), error: null };
    } catch (error) { return { page: null, error: errorText(error) }; }
  });
  return () => bridge.dispose();
}
