import { fixtureStats } from "./stats-fixture";
import { fixtureTokenLive, fixtureTokens } from "./tokens-fixture";
import { fixtureDigest } from "./digest-fixture";
import { fixtureScheduleList, fixtureScheduleRun } from "./schedules-fixture";
import { fixtureModels, fixtureOverview, fixtureProfiles, fixtureReportJobs, fixtureRunners, fixtureSuggestions, fixtureSuggestionsState, richInsightScenarios, runnerLabelFor } from "./insights-overview-fixture";
import { useEffect, useMemo, useState } from "react";
import * as Lucide from "lucide-react";
import { createPortal } from "react-dom";
import { ScrollView, FlatList, TextInput } from "react-native-web";
import { defaultViewPreferences } from "../shared/preferences";
import { normalizeTimelinePage, projectTimelineRows } from "../shared/timeline";
import { fixtureAnalytics, fixtureArchiveOrigins, fixtureInsight, fixtureInsightState, fixtureProjectAnalytics, fixtureReadReceipts, fixtureTelemetry, fixtureTimeline, longFirstInput, longLatestReply, longFixtureTimeline, nativeChildren, nativeTimeline, rawAgents, subscribeFixtureAgents, updateFixtureAgent } from "./fixtures";

let insightSequence = 0;
let fixtureRevision = 0;
const revisioned = new Set(["observatory.telemetry.get", "observatory.analytics.get", "observatory.read-state.list", "observatory.results.get", "observatory.stats.get", "observatory.tokens.get", "observatory.digest.get", "observatory.insights.overview"]);
let preferencesRevision=0;const preferencePages=new Map();let preferenceSnoozes=[];
// ?storedQuery= simulates search text synced by an older version (the server now strips it; the client must ignore it too).
const storedQuery=typeof location==="undefined"?null:new URLSearchParams(location.search).get("storedQuery");
const preferenceSnapshot=(key)=>structuredClone({revision:preferencesRevision,view:preferencePages.get(key)?.view??{...defaultViewPreferences(key),...(storedQuery&&!key.endsWith("archives")?{query:storedQuery}:{})},savedViews:preferencePages.get(key)?.savedViews??[],snoozes:preferenceSnoozes.filter(s=>Date.parse(s.until)>Date.now()),error:null});
globalThis.__previewRpcCalls = [];
globalThis.__previewAgentOperations = [];
globalThis.__previewTimelineCalls = [];
const timelineListeners = new Map();
globalThis.__previewGetPreferences = preferenceSnapshot;
globalThis.__previewGetAgent = id => structuredClone(rawAgents.find(agent => agent.id === id));
globalThis.__previewTimelineActive = id => timelineListeners.get(id)?.size ?? 0;
globalThis.__previewEmitTimeline = (id,event) => {for(const listener of timelineListeners.get(id)??[])listener({agentId:id,event});};
const scenarioName=()=>new URLSearchParams(globalThis.location?.search??"").get("scenario");
if(richInsightScenarios.has(scenarioName()))fixtureInsightState.jobs.push(...fixtureReportJobs());
let createdSequence=0;

const sdk = {
  agents: {
    create: async input => { globalThis.__previewAgentOperations.push({ type: "create", input }); throw new Error("开发预览不允许创建 Agent"); },
    list: async (options) => ({ entries: rawAgents.filter(agent => options?.filter?.includeArchived || !agent.archivedAt).map(agent => ({ agent: { ...agent } })), pageInfo: { nextCursor: null, hasMore: false } }),
    subscribe: subscribeFixtureAgents,
    ref: agentId => ({ refresh: async () => { const agent = rawAgents.find(agent => agent.id === agentId); return agent ? { agent: { ...agent }, project: null } : null; },
      archive: async () => {const agent=rawAgents.find(item=>item.id===agentId);if(!agent)throw new Error("模拟会话不存在");const archivedAt=new Date().toISOString();globalThis.__previewAgentOperations.push({type:"archive",agentId});const index=fixtureArchiveOrigins.findIndex(item=>item.agentId===agentId);if(index>=0)fixtureArchiveOrigins.splice(index,1);fixtureArchiveOrigins.push({agentId,archivedAt,lastUserMessageAt:agent.lastUserMessageAt??null});updateFixtureAgent(agentId,{archivedAt,updatedAt:archivedAt,status:"closed",requiresAttention:false,attentionReason:null,attentionTimestamp:null});return {archivedAt};},
      send: async input => { globalThis.__previewAgentOperations.push({ type: "send", agentId, input }); if (scenarioName() === "send-error") throw new Error("开发预览不允许发送新提示词"); }, timeline: {
      refetch: async (input = {}) => {globalThis.__previewTimelineCalls.push({agentId,...input});return scenarioName()==="long-history" ? longFixtureTimeline(agentId,input) : fixtureTimeline(agentId,input.direction);},
      subscribe: listener => {const listeners=timelineListeners.get(agentId)??new Set();listeners.add(listener);timelineListeners.set(agentId,listeners);return Object.assign(()=>listeners.delete(listener),{ready:Promise.resolve()});},
    } }),
  },
};
sdk.config = { get: async () => ({ requestId: "fixture-config", config: { agentProfiles: fixtureProfiles } }) };
sdk.workspaces = { ref: workspaceId => ({ agents: { create: async input => { globalThis.__previewAgentOperations.push({ type: "create", workspaceId, input }); return { id: `fixture-created-${++createdSequence}` }; } } }) };
export function usePaseo() { return sdk; }
export function useRpc(contract) {
  return useMemo(() => async input => {
    globalThis.__previewRpcCalls.push({ name: contract.name, input: { ...input } });
    let result;
    switch (contract.name) {
      case "observatory.preferences.get": result=preferenceSnapshot(input.viewKey);break;
      case "observatory.preferences.update": {
        if(input.expectedRevision!==preferencesRevision){result={...preferenceSnapshot(input.viewKey),status:"conflict"};break;}
        const old=preferenceSnapshot(input.viewKey);const value={view:{...old.view,...input.view},savedViews:[...old.savedViews]};
        if(input.saveView){const id=input.saveView.id??`view-${Date.now()}`;value.savedViews=[...value.savedViews.filter(v=>v.id!==id),{...input.saveView,id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];}
        if(input.deleteSavedViewId)value.savedViews=value.savedViews.filter(v=>v.id!==input.deleteSavedViewId);
        if(input.snooze)preferenceSnoozes=[...preferenceSnoozes.filter(s=>s.agentId!==input.snooze.agentId||Date.parse(s.completionAt)!==Date.parse(input.snooze.completionAt)),input.snooze];
        if(input.unsnooze)preferenceSnoozes=preferenceSnoozes.filter(s=>s.agentId!==input.unsnooze.agentId||s.completionAt!==input.unsnooze.completionAt);
        preferencePages.set(input.viewKey,value);preferencesRevision++;result={...preferenceSnapshot(input.viewKey),status:"updated"};break;
      }
      case "observatory.results.get": {
        if(scenarioName()==="schedule-session-error"&&input.agentId==="environment-closed")throw new Error("Request failed: acp does not support ACP session resume requestType=plugin.rpc.invoke.request code=handler_error");
        const page=fixtureTimeline(input.agentId);const rows=projectTimelineRows(normalizeTimelinePage(page).rows);const agent=rawAgents.find(a=>a.id===input.agentId);const first=rows.find(r=>r.item.type==="user_message"),last=[...rows].reverse().find(r=>r.item.type==="assistant_message"),user=[...rows].reverse().find(r=>r.item.type==="user_message");
        const source={lastUserMessageAt:agent?.lastUserMessageAt??null,attentionTimestamp:agent?.attentionTimestamp??null};
        if(input.expectedLastUserMessageAt!==undefined&&input.expectedLastUserMessageAt!==source.lastUserMessageAt||input.expectedAttentionTimestamp!==undefined&&input.expectedAttentionTimestamp!==source.attentionTimestamp)throw new Error("模拟结果版本已改变，请刷新查看最新结果");
        const ex=row=>row?{text:row.item.text||"",ref:`${input.agentId}:${page.epoch}:${row.seqStart}-${row.seqEnd}`,at:row.timestamp||null,truncated:false}:null;
        result={agentId:input.agentId,capturedAt:new Date().toISOString(),epoch:page.epoch,source,firstInput:first?{...ex(first),completeOrigin:true}:null,latestUserInput:ex(user),latestReply:ex(last),isRunning:agent?.status==="running",isFinal:agent?.attentionReason==="finished",artifacts:[],testEvidence:[],metrics:{tools:rows.filter(r=>r.item.type==="tool_call").length,failedTools:0,changedFiles:0,userTurns:1},coverage:{firstInputConfirmed:true,truncated:false,rows:rows.length,hasOlder:false,reason:null}};break;
      }
      case "observatory.insights.list": {
        const jobs=fixtureInsightState.jobs.filter(job=>!input.agentId||job.agentId===input.agentId).map(({report,evidence,...job})=>({...job,reportAvailable:!!report,summary:report?.summary??null,health:report?.health??null,findings:report?.findings.length??0,resolvedFindings:Object.values(job.findingFeedback??{}).filter(f=>f.status==="resolved").length}));
        result={...fixtureInsightState,runnerLabel:runnerLabelFor(fixtureInsightState.settings.runner),jobs,revision:insightSequence,unchanged:false,activeCount:jobs.filter(j=>["queued","collecting","analyzing"].includes(j.status)).length,nextScheduledAt:null};break;
      }
      case "observatory.insights.runners": result = fixtureRunners; break;
      case "observatory.insights.models": result = fixtureModels(input.provider); break;
      case "observatory.insights.overview": result = fixtureOverview(input.days, input.utcOffsetMinutes, scenarioName(), fixtureInsightState.settings, runnerLabelFor(fixtureInsightState.settings.runner)); break;
      case "observatory.insights.suggestions": {
        const all = fixtureSuggestions(Date.now(), scenarioName());
        result = { job: input.jobId ? fixtureSuggestionsState.jobs.find(job => job.id === input.jobId) ?? (all.job?.id === input.jobId ? all.job : null) : all.job, history: all.history }; break;
      }
      case "observatory.insights.suggest": {
        if (scenarioName() === "insights-suggest-error") throw new Error("模拟：分析队列已满，请稍后再试。");
        const now = new Date().toISOString(), label = runnerLabelFor(input.runner ?? fixtureInsightState.settings.runner);
        result = { id: `fixture-suggestions-new-${++insightSequence}`, createdAt: now, updatedAt: now, status: "queued", trigger: "manual", stage: "已加入分析队列",
          window: { days: input.days, from: now.slice(0, 10), to: now.slice(0, 10), reports: 0, findings: 0, agents: 0 },
          runner: { kind: (input.runner ?? fixtureInsightState.settings.runner).kind, label, provider: null, model: null, thinkingOptionId: null, modeId: null, sessionAgentId: null },
          usage: null, error: null, report: null, basis: [] };
        fixtureSuggestionsState.jobs.unshift(result); break;
      }
      case "observatory.insights.suggest-cancel": {
        const job = fixtureSuggestionsState.jobs.find(item => item.id === input.jobId); if (!job) throw new Error("模拟建议任务不存在");
        Object.assign(job, { status: "canceled", stage: "已取消", updatedAt: new Date().toISOString() }); result = job; break;
      }
      case "observatory.insights.action-feedback": {
        const all = fixtureSuggestions(Date.now(), scenarioName());
        if (!all.job || all.job.id !== input.jobId) throw new Error("模拟建议不存在");
        if (!all.job.report.actions.some(action => action.id === input.actionId)) throw new Error("这条建议已不在报告里");
        fixtureSuggestionsState.feedback[input.actionId] = { status: input.status, updatedAt: new Date().toISOString() };
        result = { ...all.job, feedback: { ...fixtureSuggestionsState.feedback } }; break;
      }
      case "observatory.insights.report": result={job:fixtureInsightState.jobs.find(job=>job.id===input.jobId)??null,revision:insightSequence};break;
      case "observatory.insights.feedback": {const job=fixtureInsightState.jobs.find(j=>j.id===input.jobId);job.findingFeedback={...job.findingFeedback,[input.findingId]:{status:input.status,updatedAt:new Date().toISOString()}};insightSequence++;result=job;break;}
      case "observatory.telemetry.get": result = fixtureTelemetry; break;
      case "observatory.analytics.get": result = fixtureProjectAnalytics(input.projectId); break;
      case "observatory.stats.get": if (scenarioName() === "stats-error") throw new Error("模拟统计读取失败"); result = fixtureStats(input.range, input.utcOffsetMinutes); break;
      case "observatory.tokens.get": if (scenarioName() === "tokens-error") throw new Error("模拟 Token 统计读取失败"); result = fixtureTokens(input.range, input.utcOffsetMinutes); break;
      case "observatory.tokens.live": if (scenarioName() === "tokens-error") throw new Error("模拟 Token 统计读取失败"); result = fixtureTokenLive(input.windowMinutes, input.utcOffsetMinutes, input.detail); break;
      case "observatory.digest.get": result = fixtureDigest(input.agentId); break;
      case "observatory.schedules.list": { const full = fixtureScheduleList(input.window ?? "recent", scenarioName()); result = input.revision === full.revision ? { mode: "unchanged", unchanged: true, revision: full.revision } : full; break; }
      case "observatory.schedules.run": result = fixtureScheduleRun(input.runId); if (scenarioName() === "schedule-no-reply") result = { ...result, output: null, prompt: null, note: "定时任务记录已不存在，可以读取会话记录查看最后回复。" }; break;
      case "observatory.read-state.list": result = { receipts: [...fixtureReadReceipts], archiveOrigins:[...fixtureArchiveOrigins], error: null }; break;
      case "observatory.read-state.mark": {
        const agent = rawAgents.find(candidate => candidate.id === input.agentId);
        const scenario = new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
        if (scenario === "read-error") { result = { agentId: input.agentId, status: "failed", receipt: null, message: "模拟宿主确认失败，未读状态已保留。" }; break; }
        if (!agent || agent.attentionReason !== "finished" || agent.requiresAttention !== true || agent.activeTurn || agent.pendingPermissions.length) {
          result = { agentId: input.agentId, status: "not_unread", receipt: null, message: "当前没有可标为已读的完成结果。" }; break;
        }
        if (agent.attentionTimestamp !== input.attentionTimestamp || (agent.lastUserMessageAt ?? null) !== input.lastUserMessageAt) {
          result = { agentId: input.agentId, status: "stale", receipt: null, message: "完成结果已更新，请刷新后确认。" }; break;
        }
        const receipt = { agentId: input.agentId, completionAt: agent.attentionTimestamp, lastUserMessageAt: agent.lastUserMessageAt ?? null, readAt: new Date().toISOString() };
        const old = fixtureReadReceipts.findIndex(item => item.agentId === input.agentId);
        if (old >= 0) fixtureReadReceipts.splice(old, 1);
        fixtureReadReceipts.unshift(receipt);
        updateFixtureAgent(agent.id, { requiresAttention: false, attentionReason: null, attentionTimestamp: null });
        result = { agentId: input.agentId, status: "read", receipt, message: "已标为已读，并与原生会话同步。" };
        break;
      }
      case "observatory.insights.state": result = { ...fixtureInsightState, jobs: fixtureInsightState.jobs.filter(job => !input.agentId || job.agentId === input.agentId) }; break;
      case "observatory.insights.start": {
        const runner = input.runner ?? fixtureInsightState.settings.runner;
        result = { ...fixtureInsight(input.agentId), id: `fixture-insight-${input.agentId}-${++insightSequence}`,
          runner: { kind: runner.kind === "auto" ? "grok" : runner.kind, label: runnerLabelFor(runner.kind === "auto" ? { kind: "grok" } : runner), provider: runner.kind === "provider" ? runner.provider : null,
            model: runner.kind === "provider" ? runner.model : runner.kind === "grok" || runner.kind === "auto" ? "grok-4.7" : null,
            thinkingOptionId: runner.kind === "provider" ? runner.thinkingOptionId : runner.kind === "grok" || runner.kind === "auto" ? "xhigh" : null, modeId: null,
            sessionAgentId: runner.kind === "grok" || runner.kind === "auto" ? null : "fixture-analysis-session" } };
        const scenario = new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
        if (input.agentId === "mobile-bootstrap") result = { ...result, status: "skipped", report: null, stage: "手动分析至少需要 2 轮对话和 2 次工具调用，当前轨迹尚不足。", eligibility: { eligible: false, turnCount: 1, toolCount: 1, reason: "手动分析至少需要 2 轮对话和 2 次工具调用，当前轨迹尚不足。" } };
        else if (scenario === "insights-progress") result = { ...result, status: "analyzing", report: null, stage: "正在结合工具结果分析执行轨迹" };
        else if (scenario === "insights-failed") result = { ...result, status: "failed", report: null, error: "模拟分析进程中断，请重试。", stage: "分析进程已退出" };
        fixtureInsightState.jobs.unshift(result);
        break;
      }
      case "observatory.insights.configure": if (input.autoEnabled !== undefined) fixtureInsightState.settings.autoEnabled = input.autoEnabled; if (input.runner) fixtureInsightState.settings.runner = input.runner; result = fixtureInsightState.settings; break;
      case "observatory.insights.cancel": {
        const found = fixtureInsightState.jobs.find(job => job.id === input.jobId);
        if (!found) throw new Error("模拟分析任务不存在");
        Object.assign(found, { status: "canceled", stage: "分析已取消", report: null, updatedAt: new Date().toISOString() });
        result = found;
        break;
      }
      case "observatory.history.evidence": {
        const historical = input.agentId === "archived-cycle" || input.agentId === "old-report";
        const timeline = historical ? fixtureTimeline(input.agentId) : null;
        result = { agentId: input.agentId, turns: historical ? 2 : 4, tools: historical ? 2 : 12, toolFailures: historical ? 0 : 1, errors: 0,
          firstTimelineAt: timeline?.rows[0]?.timestamp ?? new Date(Date.now() - 1800_000).toISOString(), lastTimelineAt: timeline?.rows.at(-1)?.timestamp ?? new Date().toISOString(),
          sampleSize: timeline?.rows.length ?? 28, complete: true, hasOlder: false, coverageReason: null, completionEvidence: { kind: "none", at: null } };
        break;
      }
      case "observatory.history.restore": {
        const agent = rawAgents.find(agent => agent.id === input.agentId);
        const countUsers = () => fixtureTimeline(input.agentId).rows.filter(row => row.item.type === "user_message").length;
        const before = { agentId: agent?.id, agentCount: rawAgents.length, userMessages: countUsers() };
        if(agent?.archivedAt){const existing=fixtureArchiveOrigins.findIndex(item=>item.agentId===agent.id);if(existing>=0)fixtureArchiveOrigins.splice(existing,1);fixtureArchiveOrigins.push({agentId:agent.id,archivedAt:agent.archivedAt,lastUserMessageAt:agent.lastUserMessageAt??null});}
        if (agent) updateFixtureAgent(agent.id, { archivedAt: null });
        globalThis.__previewRestoreAudit = { before, after: { agentId: agent?.id, agentCount: rawAgents.length, userMessages: countUsers() } };
        result = { status: "restored", agentId: input.agentId, workspaceId: agent?.workspaceId ?? null, workspaceRestored: false, workspaceAction: null, message: "模拟会话已恢复" }; break;
      }
      case "observatory.provider-subagents.list": result = { subagents: input.parentAgentId === "payment-root" ? nativeChildren : [], error: null, truncated: false }; break;
      case "observatory.provider-subagents.timeline": result = { page: nativeTimeline(input.parentAgentId, input.subagentId), error: null }; break;
      default: throw new Error(`No development fixture for ${contract.name}`);
    }
    if(contract.name==="observatory.results.get"&&scenarioName()==="long-history"){
      const epoch=`long-${input.agentId}`;
      result={...result,epoch,firstInput:{text:longFirstInput,ref:`${input.agentId}:${epoch}:1-1`,at:new Date(Date.now()-3600000).toISOString(),truncated:false,completeOrigin:true},latestReply:{text:longLatestReply,ref:`${input.agentId}:${epoch}:1200-1200`,at:new Date().toISOString(),truncated:false},metrics:{tools:1197,failedTools:0,changedFiles:32,userTurns:2},coverage:{firstInputConfirmed:true,truncated:false,rows:1200,hasOlder:false,reason:null}};
    }
    if(contract.name==="observatory.results.get"&&scenarioName()==="unknown-origin")result={...result,firstInput:result.firstInput?{...result.firstInput,completeOrigin:false}:null,coverage:{...result.coverage,firstInputConfirmed:false,truncated:true,hasOlder:true,reason:"模拟宿主仅保留部分历史"}};
    // Revisioned host replies (Paseo 0.9 plugin 2.1): fixtures are always complete snapshots.
    if(revisioned.has(contract.name)&&result&&typeof result==="object"&&!("mode" in result))result={...result,mode:"full",unchanged:false,revision:`fixture-${++fixtureRevision}`};
    return contract.output.parse(result);
  }, [contract.name]);
}

// Host stand-ins: real Lucide icons (the host resolves the same names from lucide-react-native and renders
// nothing for unknown ones, so unknown names are reported as preview errors), a themed modal and visible toasts.
export function Icon({ name, size = 16, color = "currentColor" }) {
  const Glyph = Lucide[name] ?? Lucide[`${name}Icon`];
  if (!Glyph) { console.error(`Unknown Lucide icon: ${name}`); return null; }
  return <Glyph size={size} color={color} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />;
}
export async function copyText(text) { globalThis.__previewClipboard = text; }
export { ScrollView, FlatList, TextInput };
const theme = () => globalThis.__previewTheme;
export function Modal({ title, open, onOpenChange, children }) {
  useEffect(() => { if (!open) return; const key = event => { if (event.key === "Escape") onOpenChange(false); }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, [open, onOpenChange]);
  if (!open) return null;
  const { colors } = theme();
  const phone = innerWidth < 700;
  return createPortal(<div onClick={event => { if (event.target === event.currentTarget) onOpenChange(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: phone ? "flex-end" : "center", justifyContent: "center", zIndex: 1000 }}>
    <div role="dialog" aria-modal="true" aria-label={title} style={{ width: phone ? "100%" : 460, maxWidth: "100%", maxHeight: phone ? "88vh" : "80vh", display: "flex", flexDirection: "column", background: colors.surface0, border: `1px solid ${colors.border}`, borderRadius: phone ? "14px 14px 0 0" : 12, overflow: "hidden", fontFamily: "inherit" }}>
      <div style={{ display: "flex", alignItems: "center", minHeight: 48, padding: "0 8px 0 16px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ flex: 1, color: colors.foreground, fontSize: 15, fontWeight: 500 }}>{title}</div>
        <button aria-label="关闭" onClick={() => onOpenChange(false)} style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 8, background: "transparent", cursor: "pointer" }}><Icon name="X" size={16} color={colors.foregroundMuted} /></button>
      </div>
      {children}
    </div>
  </div>, document.body);
}
Modal.Content = function Content({ children, contentContainerStyle }) {
  return <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={[{ padding: 24, gap: 16 }, contentContainerStyle]}>{children}</ScrollView>;
};

let toastSequence = 0;
const toastListeners = new Set();
let toasts = [];
function pushToast(message, variant) {
  const id = ++toastSequence;
  toasts = [...toasts.slice(-2), { id, message, variant }];
  globalThis.__previewToasts = [...(globalThis.__previewToasts ?? []), { message, variant }];
  for (const listener of toastListeners) listener();
  setTimeout(() => { toasts = toasts.filter(toast => toast.id !== id); for (const listener of toastListeners) listener(); }, 6000);
}
const toastApi = { show: (message, options) => pushToast(message, options?.variant ?? "default"), error: message => pushToast(message, "error") };
export function useToast() { return toastApi; }
export function ToastHost() {
  const [, setVersion] = useState(0);
  useEffect(() => { const listener = () => setVersion(value => value + 1); toastListeners.add(listener); return () => toastListeners.delete(listener); }, []);
  const { colors } = theme();
  return <div role="status" aria-live="polite" style={{ position: "fixed", left: 0, right: 0, bottom: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, pointerEvents: "none", zIndex: 2000 }}>
    {toasts.map(toast => <div key={toast.id} style={{ maxWidth: "min(420px, calc(100vw - 32px))", padding: "9px 14px", borderRadius: 10, background: colors.surface2, border: `1px solid ${toast.variant === "error" ? colors.statusDanger : colors.border}`, color: toast.variant === "error" ? colors.statusDanger : colors.foreground, fontSize: 13, lineHeight: "19px", boxShadow: "0 6px 24px rgba(0,0,0,0.18)" }}>{toast.message}</div>)}
  </div>;
}
