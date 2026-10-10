import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getSessionEvidence, restoreSession, type RestoreSessionResult } from "../shared/history";
import { object, string } from "../shared/timeline";
import { createProviderSubagentBridge } from "./provider-subagents";
import { fetchTrajectory } from "./trajectory";
import { rememberArchiveReadOrigin } from "./read-state";

export interface HistoryTransport { request(message: Record<string, unknown>, responseType: string): Promise<Record<string, unknown>> }
/**
 * Explicit session restoration. `refresh_agent_request` reopens persistence,
 * unlike PaseoApi.handle.refresh(), which is only a snapshot read. No prompt is
 * sent, no agent is created, and sibling archived agents are left archived.
 */
export async function restoreArchivedSession(paseo: PaseoApi, agentId: string, transport: HistoryTransport, rememberOrigin?: typeof rememberArchiveReadOrigin): Promise<RestoreSessionResult> {
  let result: RestoreSessionResult = { status: "failed", agentId, workspaceId: null, workspaceRestored: false,
    workspaceAction: null, message: "恢复未完成" };
  try {
    const handle = paseo.agents.ref(agentId);
    const initial = await handle.refresh();
    if (!initial?.agent) return { ...result, status: "needs_native", message: "此会话已不在当前宿主中，无法恢复。" };
    const agent = initial.agent;
    result.workspaceId = agent.workspaceId ?? null;
    if (!agent.archivedAt) return { ...result, status: "already_active", message: "原会话已处于可用状态，可直接打开。" };
    if (agent.status === "running" || agent.activeTurn) return { ...result, status: "needs_native", message: "会话仍有活动任务，请在原生会话中处理，避免中断执行。" };
    if (!agent.persistence || agent.providerUnavailable) return { ...result, status: "needs_native", message: "原会话缺少可恢复的持久化记录，或其提供方不可用。请在 Paseo 原生会话中检查。" };
    await rememberOrigin?.({agentId,archivedAt:agent.archivedAt,lastUserMessageAt:agent.lastUserMessageAt??null});
    if (agent.workspaceId) {
      const workspace = await paseo.workspaces.ref(agent.workspaceId).refresh();
      if (!workspace) {
        const inspection = await transport.request({ type: "workspace.recovery.inspect.request", workspaceId: agent.workspaceId }, "workspace.recovery.inspect.response");
        const state = object(inspection.state);
        if (state.kind !== "recoverable") {
          if (state.reason !== "workspace_not_archived") return { ...result, status: "needs_native", message: string(state.message) || "关联工作区无法安全恢复，请在 Paseo 中检查。" };
        } else {
          if (state.action !== "unarchive" && state.action !== "restore") return { ...result, status: "needs_native", message: "宿主要求的工作区恢复方式不受支持。" };
          const restored = await transport.request({ type: "workspace.recovery.restore.request", workspaceId: agent.workspaceId }, "workspace.recovery.restore.response");
          if (restored.accepted !== true) throw new Error(string(restored.error) || "宿主未接受工作区恢复");
          result = { ...result, workspaceRestored: true, workspaceAction: state.action };
        }
      }
    }
    // Another client may already have restored or started the session while its
    // workspace was being recovered. Never refresh an active session here.
    const current = await handle.refresh();
    if (!current?.agent) throw new Error("恢复过程中会话已不可用");
    if (!current.agent.archivedAt) return { ...result, status: "already_active", message: "原会话已恢复，可直接打开。" };
    if (current.agent.status === "running" || current.agent.activeTurn) return { ...result, status: "needs_native", message: "会话已开始执行，请打开原生会话查看。" };
    const refreshed = await transport.request({ type: "refresh_agent_request", agentId }, "status");
    if (refreshed.status !== "agent_refreshed" || refreshed.agentId !== agentId) throw new Error("宿主未确认原会话恢复");
    const confirmed = await handle.refresh();
    if (!confirmed?.agent || confirmed.agent.archivedAt) throw new Error("宿主尚未确认会话退出归档状态，请刷新后查看");
    return { ...result, status: "restored", message: result.workspaceRestored ? "关联工作区与原会话已恢复，未发送新任务。" : "原会话已恢复，未发送新任务。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "会话恢复失败";
    return { ...result, status: "failed", message: `${message.includes("宿主未响应") ? "宿主尚未确认恢复结果，操作可能继续执行，请刷新状态后确认。" : message.replaceAll("子任务", "会话")}${result.workspaceRestored ? "（工作区已恢复，会话需继续检查。）" : ""}` };
  }
}
export function registerHistory(server: PluginServerContext): () => void {
  const bridge = createProviderSubagentBridge({
    send(message) { if (!process.send) throw new Error("当前环境没有 Paseo 宿主通道"); process.send(message); },
    listen(listener) { process.on("message", listener); return () => process.off("message", listener); },
  }, 120000);
  const pending = new Map<string, Promise<RestoreSessionResult>>();
  server.handle(restoreSession, ({ agentId }, { paseo }) => {
    const existing = pending.get(agentId); if (existing) return existing;
    const operation = restoreArchivedSession(paseo, agentId, bridge, rememberArchiveReadOrigin).finally(() => pending.delete(agentId));
    pending.set(agentId, operation); return operation;
  });
  server.handle(getSessionEvidence, async ({ agentId }, { paseo }) => {
    const trajectory = await fetchTrajectory(paseo, agentId, { limit: 300, maxCharacters: 80000 });
    return { agentId, turns: trajectory.counts.userTurns, tools: trajectory.counts.tools, toolFailures: trajectory.counts.toolFailures,
      errors: trajectory.counts.errors, firstTimelineAt: trajectory.coverage.firstAt, lastTimelineAt: trajectory.coverage.lastAt,
      sampleSize: trajectory.rows.length, complete: trajectory.coverage.complete, hasOlder: trajectory.coverage.hasOlder,
      coverageReason: trajectory.coverage.reason, completionEvidence: trajectory.completionEvidence };
  });
  return () => { bridge.dispose(); pending.clear(); };
}
