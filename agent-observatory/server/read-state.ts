import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { archiveReadOriginSchema, getReadReceipts, markCompletionRead, readReceiptSchema, type ArchiveReadOrigin, type MarkCompletionReadInput, type MarkCompletionReadResult, type ReadReceipt, type ReadReceiptsResponse } from "../shared/read-state";
import { object } from "../shared/timeline";
import { createProviderSubagentBridge } from "./provider-subagents";
import { telemetryDirectory } from "./telemetry";
import { contentRevision } from "./revision";

const fileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), receipts: z.array(readReceiptSchema).max(2000), archiveOrigins: z.array(archiveReadOriginSchema).max(2000).default([]) });
export interface ReadReceiptStoreOptions { directory?: string; limit?: number }
/** Host-local completion/read metadata only: no titles, messages or prompts. */
export class ReadReceiptStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly limit: number;
  private receipts = new Map<string, ReadReceipt>();
  private archiveOrigins = new Map<string, ArchiveReadOrigin>();
  private error: string | null = null;
  private corrupt = false;
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(options: ReadReceiptStoreOptions = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "read-receipts.json");
    this.limit = Math.max(1, Math.min(2000, options.limit ?? 2000)); this.ready = this.load();
  }
  private async load() {
    try {
      if ((await stat(this.file)).size > 4_000_000) throw new Error("receipt storage is too large");
      const data = fileSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      for (const receipt of data.receipts) {
        const previous = this.receipts.get(receipt.agentId);
        if (!previous || Date.parse(receipt.completionAt) > Date.parse(previous.completionAt)
          || receipt.completionAt === previous.completionAt && Date.parse(receipt.readAt) > Date.parse(previous.readAt)) this.receipts.set(receipt.agentId, receipt);
      }
      for (const origin of data.archiveOrigins) {
        const previous = this.archiveOrigins.get(origin.agentId);
        if (!previous || Date.parse(origin.archivedAt) >= Date.parse(previous.archivedAt)) this.archiveOrigins.set(origin.agentId, origin);
      }
      this.trim();
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") { this.corrupt = true; this.error = "已读回执无法读取，原文件会在下次保存时保留备份。原生已读状态仍以宿主为准。"; }
    }
  }
  private trim() {
    const newest = [...this.receipts.values()].sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt)).slice(0, this.limit);
    this.receipts = new Map(newest.map(receipt => [receipt.agentId, receipt]));
    const origins = [...this.archiveOrigins.values()].sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt)).slice(0, this.limit);
    this.archiveOrigins = new Map(origins.map(origin => [origin.agentId, origin]));
  }
  async get(agentId: string): Promise<ReadReceipt | null> { await this.ready; const receipt = this.receipts.get(agentId); return receipt ? { ...receipt } : null; }
  async snapshot() { await this.ready; return { receipts: [...this.receipts.values()].map(receipt => ({ ...receipt })), archiveOrigins: [...this.archiveOrigins.values()].map(origin => ({ ...origin })), error: this.error }; }
  async read(revision?: string): Promise<ReadReceiptsResponse> {
    const snapshot = await this.snapshot(), current = contentRevision(snapshot);
    return revision === current ? { mode: "unchanged", unchanged: true, revision: current } : { ...snapshot, mode: "full", unchanged: false, revision: current };
  }
  async record(input: ReadReceipt): Promise<ReadReceipt> {
    await this.ready;
    const receipt = readReceiptSchema.parse(input), previous = this.receipts.get(receipt.agentId);
    if (Date.parse(receipt.readAt) < Date.parse(receipt.completionAt)) throw new Error("Read receipt cannot precede completion");
    if (previous && (Date.parse(previous.completionAt) > Date.parse(receipt.completionAt)
      || Date.parse(previous.completionAt) === Date.parse(receipt.completionAt) && Date.parse(previous.readAt) >= Date.parse(receipt.readAt))) return { ...previous };
    this.receipts.set(receipt.agentId, receipt); this.trim();
    await this.persist(); return { ...receipt };
  }
  async recordArchiveOrigin(input: ArchiveReadOrigin): Promise<ArchiveReadOrigin> {
    await this.ready;
    const origin = archiveReadOriginSchema.parse(input), previous = this.archiveOrigins.get(origin.agentId);
    if (previous && Date.parse(previous.archivedAt) > Date.parse(origin.archivedAt)) return { ...previous };
    if (origin.lastUserMessageAt && Date.parse(origin.lastUserMessageAt) > Date.parse(origin.archivedAt)) origin.lastUserMessageAt = null;
    if (previous?.archivedAt === origin.archivedAt && previous.lastUserMessageAt && !origin.lastUserMessageAt) origin.lastUserMessageAt = previous.lastUserMessageAt;
    this.archiveOrigins.set(origin.agentId, origin); this.trim();
    await this.persist(); return { ...origin };
  }
  private persist(): Promise<void> {
    const serialized = JSON.stringify({ version: 2, receipts: [...this.receipts.values()], archiveOrigins: [...this.archiveOrigins.values()] });
    this.writes = this.writes.then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (this.corrupt) { try { await rename(this.file, `${this.file}.backup`); } catch { /* missing previous file */ } this.corrupt = false; }
        await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, this.file); this.error = null;
      } catch { this.error = "原生已读已同步，但回执暂时无法写入磁盘；当前回执保留在内存。"; }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return this.writes;
  }
  async close() { await this.ready; await this.writes; }
}

let activeReadReceiptStore: ReadReceiptStore | null = null;
/** Call before a plugin-driven restore, including archives predating installation. */
export async function rememberArchiveReadOrigin(origin: ArchiveReadOrigin): Promise<ArchiveReadOrigin> {
  if (!activeReadReceiptStore) throw new Error("已读状态服务尚未初始化。");
  return activeReadReceiptStore.recordArchiveOrigin(origin);
}

export interface CompletionReadTransport { request(message: Record<string, unknown>, responseType: string): Promise<Record<string, unknown>> }
export class CompletionReadController {
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, { token: string; promise: Promise<MarkCompletionReadResult> }>();
  private closed = false;
  constructor(private readonly store: ReadReceiptStore, private readonly transport: CompletionReadTransport, private readonly now: () => number = Date.now) {}
  bump(agentId: string) {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    if (this.generations.size > 4000) for (const id of this.generations.keys()) {
      if (!this.pending.has(id) && id !== agentId) { this.generations.delete(id); break; }
    }
  }
  async mark(paseo: PaseoApi, input: MarkCompletionReadInput): Promise<MarkCompletionReadResult> {
    const token = JSON.stringify([input.attentionTimestamp, input.lastUserMessageAt]);
    const existing = this.pending.get(input.agentId);
    if (existing?.token === token) return existing.promise;
    if (existing) return { agentId: input.agentId, status: "stale", receipt: await this.store.get(input.agentId), message: "此会话正在同步另一次已读操作，请刷新状态后重试。" };
    const promise = this.perform(paseo, input).finally(() => this.pending.delete(input.agentId));
    this.pending.set(input.agentId, { token, promise }); return promise;
  }
  private async perform(paseo: PaseoApi, input: MarkCompletionReadInput): Promise<MarkCompletionReadResult> {
    const { agentId } = input;
    const previous = await this.store.get(agentId);
    const result = (status: MarkCompletionReadResult["status"], message: string, receipt = previous): MarkCompletionReadResult => ({ agentId, status, receipt, message });
    if (this.closed) return result("failed", "已读同步正在关闭，请稍后重试。");
    const generation = this.generations.get(agentId) ?? 0;
    const changed = () => this.closed || generation !== (this.generations.get(agentId) ?? 0);
    const quiet = (agent: Record<string, unknown>) => !agent.archivedAt && ["idle", "closed"].includes(String(agent.status))
      && !agent.activeTurn && Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length === 0
      && agent.attentionReason !== "permission";
    const samePrompt = (agent: Record<string, unknown>) => (agent.lastUserMessageAt ?? null) === input.lastUserMessageAt;
    try {
      const handle = paseo.agents.ref(agentId), before = await handle.refresh();
      if (!before?.agent) return result("failed", "当前宿主找不到此会话。");
      const agent = object(before.agent);
      if (changed()) return result("stale", "会话在读取期间发生变化，请刷新后查看最新结果。");
      if (!quiet(agent) || !samePrompt(agent)) return result("stale", "会话已开始新任务、需要审批或已归档，本次未标记已读。");
      if (agent.requiresAttention !== true || agent.attentionReason !== "finished") return result("not_unread", "当前会话没有待查看的完成结果；原生状态已同步。");
      if (agent.attentionTimestamp !== input.attentionTimestamp) return result("stale", "已有更新的完成结果，请先查看最新结果。");
      // The native RPC (still in 0.9) has no compare-and-swap token. Exact preconditions,
      // lifecycle generations and postchecks detect races; never claim atomicity.
      const response = await this.transport.request({ type: "clear_agent_attention", agentId }, "clear_agent_attention_response");
      if (response.agentId !== agentId || !Array.isArray(response.agents)) return result("failed", "宿主未确认此会话的已读状态，请刷新后确认。");
      const acknowledged = response.agents.map(object).find(agent => agent.id === agentId);
      if (!acknowledged || changed() || !quiet(acknowledged) || !samePrompt(acknowledged) || acknowledged.requiresAttention !== false)
        return result("stale", "已读同步期间会话发生变化，请以最新原生状态为准。");
      const after = await handle.refresh();
      const confirmed = object(after?.agent);
      if (!after?.agent || changed() || !quiet(confirmed) || !samePrompt(confirmed) || confirmed.requiresAttention !== false)
        return result("stale", "会话已有新状态，本次未记录新的已读回执，请刷新查看。");
      const receipt = await this.store.record({ agentId, completionAt: input.attentionTimestamp,
        lastUserMessageAt: input.lastUserMessageAt, readAt: new Date(this.now()).toISOString() });
      return result("read", "已标记为已读，并同步到 Paseo。", receipt);
    } catch (error) {
      return result("failed", `已读同步未确认：${error instanceof Error ? error.message.replaceAll("子任务", "已读") : "宿主暂不可用"}。请刷新后确认状态。`);
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()].map(entry => entry.promise)); await this.store.close(); }
}

export function registerReadState(server: PluginServerContext): () => Promise<void> {
  const store = new ReadReceiptStore();
  activeReadReceiptStore = store;
  const bridge = createProviderSubagentBridge({
    send(message) { if (!process.send) throw new Error("当前环境没有 Paseo 宿主通道"); process.send(message); },
    listen(listener) { process.on("message", listener); return () => process.off("message", listener); },
  });
  const controller = new CompletionReadController(store, bridge);
  server.handle(getReadReceipts, ({ revision }) => store.read(revision));
  server.handle(markCompletionRead, (input, { paseo }) => controller.mark(paseo, input));
  const removers = [
    server.on("agent.turn_started", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.turn_ended", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.permission_requested", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.permission_resolved", ({ agent }) => controller.bump(agent.id)),
    server.on("agent.archived", async ({ agent, archivedAt }) => { controller.bump(agent.id); await store.recordArchiveOrigin({ agentId: agent.id, archivedAt, lastUserMessageAt: null }); }),
  ];
  return async () => { removers.forEach(remove => remove()); bridge.dispose(); await controller.close(); if (activeReadReceiptStore === store) activeReadReceiptStore = null; };
}
