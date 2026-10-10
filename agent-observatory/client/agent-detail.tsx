import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import { applyReadReceipt, completionReadState, formatTokens, knownCompletionAt, ownTurnRunning, type AgentRecord } from "../shared/model";
import type { TelemetrySnapshot } from "../shared/telemetry";
import { getSessionEvidence, restoreSession } from "../shared/history";
import { getAgentResult, mergeAgentResult, type AgentResultState } from "../shared/results";
import { markCompletionRead, type ReadReceipt } from "../shared/read-state";
import { ActionMenu, Banner, BottomBar, Button, IconButton, MetaLine, Skeleton, Spacer, Tabs, Toolbar, compactNumber, fontSize, formatDuration, relativeTime, space, type ButtonVariant, type MenuAction } from "./kit";
import { IdentityLine, InfoButton, KeyValue, PaneLabel, StatRow, checkoutName, providerLine, useClock } from "./ui";
import { EventGlyph, PhaseLine, hueColor, tint } from "./status";
import { Sweep } from "./motion";
import { CodeBlock, TimelineContent } from "./timeline-view";
import { ResultView, permissionRequests } from "./result-view";
import { SubtasksView } from "./subtasks-view";
import { InsightsPanel } from "./insights";
import { useTimeline } from "./use-timeline";
import { useDigest } from "./use-digest";
import { AgentDigest } from "./agent-digest";
import { readingMemory } from "./reading-cache";
import { readReceiptQueryKey } from "./use-read-receipts";
import { useForeground } from "./use-foreground";
import { RecordedRunResult, ScheduleRunCard } from "./schedule-run-card";
import { useScheduleRun } from "./use-schedules";
import type { ScheduleFocus } from "./schedule-focus";
import { describeRunError, knownRunError } from "../shared/schedules";

interface AgentDetailProps { agent: AgentRecord; agents: AgentRecord[]; theme: PluginTheme; compact: boolean; navigation?: PluginSurfaceProps["navigation"]; onSelectAgent: (id: string) => void; onClose: () => void; telemetry?: TelemetrySnapshot; onReadNext?: (receipt: ReadReceipt) => void; onSnooze?: (agent: AgentRecord) => Promise<void>; queue?: { index: number; total: number }; initialEvidenceRef?: string;
  /** Opens 定时运行 on this Agent's schedule (and run). */ onOpenSchedules?: (focus: ScheduleFocus) => void }
// Each tab has its own colour, so the section you are in reads at a glance.
const tabs = [{ value: "result", label: "结果", icon: "FileCheck", tone: "green" }, { value: "digest", label: "复盘", icon: "ChartGantt", tone: "fuchsia" }, { value: "timeline", label: "时间线", icon: "ListTree", tone: "blue" }, { value: "children", label: "子任务", icon: "Workflow", tone: "violet" },
  { value: "diagnostics", label: "诊断", icon: "Stethoscope", tone: "orange" }, { value: "insights", label: "分析", icon: "Sparkles", tone: "pink" }] as const;
type DetailTab = typeof tabs[number]["value"];
type Action = { key: string; label: string; icon: string; onPress: () => void; busy?: boolean; disabled?: boolean };
const localTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未报告";

export function AgentDetail({ agent, agents, theme, compact, navigation, onSelectAgent, onClose, telemetry, onReadNext, onSnooze, queue, initialEvidenceRef, onOpenSchedules }: AgentDetailProps) {
  const { colors } = theme;
  const toast = useToast();
  const inset = compact ? space.lg : space.xl;
  const [tab, setTab] = useState<DetailTab>(initialEvidenceRef ? "timeline" : "result"), [focusRef, setFocusRef] = useState<string | null>(initialEvidenceRef ?? null), [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { if (initialEvidenceRef) { setFocusRef(initialEvidenceRef); setTab("timeline"); } }, [initialEvidenceRef]);
  const paseo = usePaseo(), memory = useMemo(() => readingMemory(paseo, `detail:${agent.id}`), [paseo, agent.id]);
  const timeline = useTimeline({ agentId: agent.id }, tab === "timeline");
  const digest = useDigest(agent.id, tab === "digest", ownTurnRunning(agent));
  const getResult = useRpc(getAgentResult), restore = useRpc(restoreSession), fetchEvidence = useRpc(getSessionEvidence), markRead = useRpc(markCompletionRead), queryCache = useQueryClient();
  const foreground = useForeground();
  const resultKey = ["observatory-result", agent.id, agent.lastUserMessageAt, knownCompletionAt(agent)];
  // An Agent a schedule created: its run's recorded reply is shown first. Reading an archived session's result loads it in
  // the host (ACP providers replay it), so for archived ones that waits for 「读取完整结果」.
  const scheduleRunId = agent.labels["paseo.schedule-run"] ?? null, scheduleId = agent.labels["paseo.schedule-id"] ?? null;
  const recordedFirst = !!scheduleRunId && !!agent.archivedAt;
  const [fullResult, setFullResult] = useState(false);
  // Nothing recorded (the schedule file is gone): read the session as for any other archived Agent.
  const recorded = useScheduleRun(recordedFirst && tab === "result" ? scheduleRunId : null, false);
  const waitForTap = recordedFirst && !fullResult && !(recorded.isSuccess && !recorded.data.output);
  const result = useQuery({ queryKey: resultKey, queryFn: async () => { const previous = queryCache.getQueryData<AgentResultState>(resultKey); return mergeAgentResult(previous, await getResult({ agentId: agent.id, expectedLastUserMessageAt: agent.lastUserMessageAt, expectedAttentionTimestamp: agent.attentionTimestamp ?? null, ...(previous?.revision ? { revision: previous.revision } : {}) })); }, enabled: tab === "result" && foreground && !waitForTap, staleTime: 2000,
    // A schedule Agent whose session failed to read shows its recorded reply instead; it retries only when asked.
    refetchInterval: query => !foreground || tab !== "result" || (scheduleRunId && query.state.status === "error") ? false : ownTurnRunning(agent) ? 5000 : 30000, retry: 1 });
  const pendingDetails = useQuery({ queryKey: ["observatory-pending", agent.id], queryFn: () => paseo.agents.ref(agent.id).refresh(), enabled: agent.pendingPermissionCount > 0 && foreground, refetchInterval: agent.pendingPermissionCount > 0 && foreground ? 10000 : false, staleTime: 3000, retry: 1 });
  const evidence = useQuery({ queryKey: ["observatory-session-evidence", agent.id], queryFn: () => fetchEvidence({ agentId: agent.id }), enabled: tab === "diagnostics", staleTime: 60000, retry: 1 });
  const [ownReadReceipt, setOwnReadReceipt] = useState<ReadReceipt | null>(null), [reading, setReading] = useState(false), [restoring, setRestoring] = useState(false), [archiving, setArchiving] = useState(false);
  const displayedAgent = ownReadReceipt ? applyReadReceipt(agent, ownReadReceipt) : agent, readState = completionReadState(displayedAgent);
  const observed = telemetry?.agents.find(row => row.agentId === agent.id), activity = (telemetry?.events ?? []).filter(row => row.agentId === agent.id).slice(0, 20);
  const acknowledge = async (next = false) => {
    if (reading || readState !== "unread" || !agent.attentionTimestamp) return;
    if (!result.data?.latestReply || result.data.source?.lastUserMessageAt !== agent.lastUserMessageAt || result.data.source?.attentionTimestamp !== agent.attentionTimestamp) { toast.show("结果正在更新，请等最新回复载入后再标记"); void result.refetch(); return; }
    setReading(true);
    try {
      const answer = await markRead({ agentId: agent.id, attentionTimestamp: agent.attentionTimestamp, lastUserMessageAt: agent.lastUserMessageAt });
      if (answer.status === "read" && answer.receipt) {
        const receipt = answer.receipt; setOwnReadReceipt(receipt);
        queryCache.setQueryData(readReceiptQueryKey, (previous: { receipts: ReadReceipt[]; error: string | null } | undefined) => ({ ...previous, receipts: [...(previous?.receipts ?? []).filter(item => item.agentId !== agent.id), receipt], error: null }));
        if (next) onReadNext?.(receipt); else toast.show(answer.message, { variant: "success" });
      } else toast.error(answer.message);
      void queryCache.invalidateQueries({ queryKey: readReceiptQueryKey });
    } catch (error) { toast.error(error instanceof Error ? error.message : "已读同步失败"); }
    finally { setReading(false); }
  };
  const openConversation = () => { try { Promise.resolve(navigation?.openAgent({ agentId: agent.id })).catch(error => toast.error(`会话打开失败：${error instanceof Error ? error.message : "请稍后重试"}`)); } catch (error) { toast.error(`会话打开失败：${error instanceof Error ? error.message : "请稍后重试"}`); } };
  const archiveOriginal = async () => { setArchiving(true); try { await paseo.agents.ref(agent.id).archive(); toast.show("已归档", { variant: "success" }); onClose(); } catch (error) { toast.error(error instanceof Error ? error.message : "归档失败，请重试"); } finally { setArchiving(false); } };
  const restoreOriginal = async () => { setRestoring(true); try { const answer = await restore({ agentId: agent.id }); toast.show(answer.message); if (answer.status === "restored" || answer.status === "already_active") openConversation(); } catch (error) { toast.error(error instanceof Error ? error.message : "恢复失败"); } finally { setRestoring(false); } };
  const snooze = onSnooze ? () => { void onSnooze(agent).catch(error => toast.error(error instanceof Error ? error.message : "稍后处理失败")); } : undefined;
  const openEvidence = (ref: string) => { setFocusRef(ref); setTab("timeline"); };
  const permissions = permissionRequests(pendingDetails.data?.agent ?? timeline.snapshot);
  const pending = agent.pendingPermissionCount;
  const unread = readState === "unread";

  const open: Action | null = navigation ? { key: "open", label: pending ? "处理审批" : "打开会话", icon: "ArrowUpRight", onPress: openConversation } : null;
  const read: Action | null = unread ? { key: onReadNext ? "next" : "read", label: onReadNext ? "已读并看下一个" : "标记已读", icon: onReadNext ? "ListChecks" : "Check", onPress: () => void acknowledge(!!onReadNext), busy: reading, disabled: result.isPending } : null;
  const archive: Action | null = !agent.archivedAt && readState === "read" ? { key: "archive", label: "归档", icon: "Archive", onPress: () => void archiveOriginal(), busy: archiving } : null;
  const restoreAction: Action | null = agent.archivedAt ? { key: "restore", label: restoring ? "正在恢复…" : "恢复会话", icon: "History", onPress: () => void restoreOriginal(), busy: restoring } : null;
  const snoozeAction: Action | null = unread && snooze ? { key: "snooze", label: "稍后处理", icon: "Clock3", onPress: snooze } : null;
  const ordered = (agent.archivedAt ? [restoreAction, open] : [open, read, compact ? null : snoozeAction, archive]).filter((item): item is Action => !!item);
  const variantOf = (action: Action, index: number): ButtonVariant => index === 0 ? "primary" : action.key === "read" || action.key === "next" || (agent.archivedAt && action.key === "open") ? "secondary" : "ghost";
  const menu: MenuAction[] = [
    ...(unread && onReadNext ? [{ key: "read-only", label: "标记已读", icon: "Check", hint: "留在当前结果", disabled: reading || result.isPending, onPress: () => void acknowledge(false) }] : []),
    ...(compact && snoozeAction ? [{ key: "snooze", label: "稍后处理", icon: "Clock3", hint: "1 小时后再提醒，有新结果会立即提醒", onPress: snoozeAction.onPress }] : []),
    // refetch() forces a read even while the query waits, which would load an archived schedule session.
    ...(tab === "result" && !waitForTap ? [{ key: "refresh", label: "刷新结果", icon: "RefreshCw", onPress: () => void result.refetch() }] : []),
    ...(agent.parentAgentId ? [{ key: "parent", label: "查看上级 Agent", icon: "CornerLeftUp", onPress: () => onSelectAgent(agent.parentAgentId!) }] : []),
    { key: "copy-id", label: "复制 Agent ID", icon: "Copy", onPress: () => { void copyText(agent.id).then(() => toast.show("已复制 Agent ID")).catch(() => toast.error("复制失败")); } },
  ];
  const header = <View style={{ gap: space.sm, paddingTop: compact ? space.lg : 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 26 }}>
      <PhaseLine theme={theme} agent={displayedAgent} />
      {!compact ? <><Spacer /><IconButton theme={theme} icon="X" label="关闭详情" size="sm" onPress={onClose} /></> : null}
    </View>
    <Text selectable numberOfLines={compact ? undefined : 3} style={{ color: colors.foreground, fontSize: fontSize.heading, fontWeight: "600", lineHeight: 26 }}>{agent.title}</Text>
    <IdentityLine theme={theme} agent={agent} compact={compact} />
    <LiveMeta theme={theme} agent={agent} totalRunMs={observed?.totalRunMs} tools={result.data?.metrics.tools} />
    {agent.background && agent.status === "running" && !agent.activeTurnStartedAt ? <Banner theme={theme} tone="info" icon="Workflow"
      message={`这一轮已结束，后台还有 ${agent.background.running} 个子任务在执行${agent.background.labels.length ? `：${agent.background.labels.join("、")}` : ""}`}
      action={{ label: "查看子任务", onPress: () => setTab("children") }} /> : null}
    {!compact && ordered.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: space.xs }}>
      {ordered.map((action, index) => <Button key={action.key} theme={theme} label={action.label} icon={action.icon} variant={variantOf(action, index)} busy={action.busy} disabled={action.disabled} onPress={action.onPress} />)}
      <IconButton theme={theme} icon="Ellipsis" label="更多操作" onPress={() => setMenuOpen(true)} />
      {queue ? <MetaLine theme={theme} parts={[`未读 ${queue.index} / ${queue.total}`]} /> : null}
    </View> : null}
    {!compact && !ordered.length ? <View style={{ alignItems: "flex-start" }}><IconButton theme={theme} icon="Ellipsis" label="更多操作" onPress={() => setMenuOpen(true)} /></View> : null}
  </View>;
  // Six sections: phones drop the icons and let the row scroll sideways instead of clipping the last tab.
  const tabBar = compact ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><Tabs theme={theme} value={tab} onChange={setTab} options={tabs.map(({ icon: _icon, ...option }) => option)} /></ScrollView>
    : <Tabs theme={theme} value={tab} onChange={setTab} options={tabs} />;
  const scrolled = compact ? <View style={{ gap: space.md }}>{header}{tabBar}</View> : undefined;
  const scheduleCard = scheduleRunId && scheduleId ? <ScheduleRunCard theme={theme} runId={scheduleRunId} scheduleId={scheduleId} running={agent.status === "running"}
    onOpenAll={onOpenSchedules ? () => onOpenSchedules({ scheduleId, runId: scheduleRunId }) : undefined} /> : null;
  // A schedule Agent whose session cannot be read (an ACP session cannot be resumed, the log is gone) still has the reply its run recorded.
  const recordedFallback = !!scheduleRunId && !recordedFirst && !!result.error && !result.data;
  const body = tab === "result" ? waitForTap ? <RecordedRunResult theme={theme} runId={scheduleRunId!} header={scrolled} lead={scheduleCard} inset={inset} onLoadFull={() => setFullResult(true)} />
    : recordedFallback ? <RecordedRunResult theme={theme} runId={scheduleRunId!} header={scrolled} lead={scheduleCard} inset={inset} loadLabel="重试读取会话" loadHint={null} loading={result.isFetching}
      notice={`会话读取失败：${describeRunError(result.error?.message)?.summary ?? "请稍后重试"}。下面是定时任务记录的回复。`} onLoadFull={() => void result.refetch()} />
    : <ResultView theme={theme} agent={agent} data={result.data} loading={result.isPending} error={result.error ? knownRunError(result.error.message) ?? result.error.message : undefined} header={scrolled} lead={scheduleCard} inset={inset} pending={pending} permissions={permissions} onResolvePermissions={navigation ? openConversation : undefined} onOpenEvidence={openEvidence} onRefresh={() => void result.refetch()} />
    : tab === "digest" ? <AgentDigest theme={theme} compact={compact} digest={digest.data} loading={digest.isPending} error={digest.error?.message} onRefresh={() => void digest.refetch()}
      onOpenSeq={(epoch, seq) => openEvidence(`${agent.id}:${epoch}:${seq}-${seq}`)} header={scrolled} inset={inset} />
    : tab === "timeline" ? <TimelineContent timeline={timeline} theme={theme} cacheKey={agent.id} focusRef={focusRef} header={scrolled} inset={inset} />
    : tab === "children" ? <SubtasksView agent={agent} agents={agents} theme={theme} inset={inset} onSelectAgent={onSelectAgent} header={scrolled} />
    : <ScrollView contentOffset={{ x: 0, y: memory.scroll }} onScroll={event => { memory.scroll = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl, gap: space.lg }}>
      {scrolled}
      <View style={{ paddingTop: compact ? 0 : space.lg }}>
        {tab === "insights" ? <InsightsPanel agent={agent} theme={theme} compact={compact} navigation={navigation} onOpenEvidence={({ ref }) => openEvidence(ref)} />
          : <Diagnostics theme={theme} agent={agent} compact={compact} observed={observed} activity={activity} evidence={evidence.data} evidenceLoading={evidence.isPending} evidenceError={!!evidence.error} />}
      </View>
    </ScrollView>;
  const actionMenu = <ActionMenu theme={theme} title="更多操作" open={menuOpen} onClose={() => setMenuOpen(false)} actions={menu} />;
  // A running turn sweeps a thin bar across the top of the pane.
  const blue = hueColor(theme, "run");
  const sweep = agent.status === "running" && !agent.archivedAt ? <Sweep color={blue} track={tint(blue, 0.14)} /> : <View style={{ height: 2 }} />;
  if (!compact) return <View testID="agent-detail" style={{ flex: 1, minHeight: 0 }}>
    {sweep}
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg - 2, gap: space.md }}>{header}{tabBar}</View>
    {body}
    {actionMenu}
  </View>;
  const bottom = (agent.archivedAt ? [open, restoreAction] : readState === "read" ? [archive, open] : [read, open]).filter((item): item is Action => !!item);
  return <View testID="agent-detail" style={{ flex: 1, minHeight: 0 }}>
    <Toolbar theme={theme}>
      <IconButton theme={theme} icon="ChevronLeft" label="返回列表" onPress={onClose} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{queue ? `未读 ${queue.index} / ${queue.total}` : "会话详情"}</Text>
      <IconButton theme={theme} icon="Ellipsis" label="更多操作" onPress={() => setMenuOpen(true)} />
    </Toolbar>
    {agent.status === "running" && !agent.archivedAt ? sweep : null}
    {body}
    {bottom.length ? <BottomBar theme={theme}>{bottom.map((action, index) => {
      const primary = index === bottom.length - 1;
      return <Button key={action.key} theme={theme} label={action.label} icon={primary ? undefined : action.key === "archive" ? action.icon : undefined} variant={primary ? "primary" : action.key === "archive" ? "ghost" : "secondary"} grow={action.key !== "archive"} busy={action.busy} disabled={action.disabled} onPress={action.onPress} />;
    })}</BottomBar> : null}
    {actionMenu}
  </View>;
}

/** Provider, usage and totals. A running turn's elapsed time ticks in the phase line instead. */
function LiveMeta({ theme, agent, totalRunMs, tools }: { theme: PluginTheme; agent: AgentRecord; totalRunMs?: number; tools?: number }) {
  const now = useClock(60_000);
  const runtime = !agent.activeTurnStartedAt && totalRunMs ? `累计运行 ${formatDuration(totalRunMs)}` : null;
  return <MetaLine theme={theme} numberOfLines={2} parts={[providerLine(agent), runtime, agent.usage.totalTokens !== null ? `${compactNumber(agent.usage.totalTokens)} tokens` : null, tools ? `${tools} 次工具调用` : null, agent.archivedAt ? `归档于 ${relativeTime(agent.archivedAt, now)}` : null]} />;
}

const sectionLooks: Record<string, { icon: string; tone: "blue" | "violet" | "orange" | "teal" }> = {
  执行上下文: { icon: "FolderGit2", tone: "blue" }, 会话历史: { icon: "History", tone: "violet" }, 用量: { icon: "Gauge", tone: "orange" }, 插件观察: { icon: "Eye", tone: "teal" }, 生命周期事件: { icon: "Activity", tone: "orange" },
};
function Diagnostics({ theme, agent, compact, observed, activity, evidence, evidenceLoading, evidenceError }: {
  theme: PluginTheme; agent: AgentRecord; compact: boolean; observed?: TelemetrySnapshot["agents"][number]; activity: TelemetrySnapshot["events"];
  evidence?: { turns: number; tools: number; toolFailures: number; complete: boolean; coverageReason: string | null }; evidenceLoading: boolean; evidenceError: boolean;
}) {
  const now = useClock(30_000);
  const usage = agent.usage;
  const section = (title: string, children: ReactNode, info?: readonly string[]) => <View style={{ gap: space.xs }}>
    <PaneLabel theme={theme} icon={sectionLooks[title]?.icon} tone={sectionLooks[title]?.tone} trailing={info ? <InfoButton theme={theme} title={`关于${title}`} lines={info} /> : undefined}>{title}</PaneLabel>
    {children}
  </View>;
  return <View style={{ gap: space.xl }}>
    {agent.lastError ? <Banner theme={theme} tone="danger" message={agent.lastError} /> : null}
    {section("执行上下文", <View>
      <KeyValue theme={theme} compact={compact} label="项目" value={agent.projectName} />
      <KeyValue theme={theme} compact={compact} label="项目根目录" value={agent.projectRootPath || "未报告"} mono />
      <KeyValue theme={theme} compact={compact} label="工作区" value={agent.workspaceName || agent.workspaceId || "尚未归属工作区"} />
      <KeyValue theme={theme} compact={compact} label="检出类型" value={agent.checkoutKind === "worktree" ? "独立 worktree" : checkoutName(agent)} />
      {agent.checkoutKind === "worktree" ? <><KeyValue theme={theme} compact={compact} label="Worktree 名称" value={agent.worktreeName || "未报告"} /><KeyValue theme={theme} compact={compact} label="Worktree 路径" value={agent.worktreePath || "未报告"} mono /></> : null}
      <KeyValue theme={theme} compact={compact} label="分支" value={agent.branch || "未报告 / 分离 HEAD"} mono={!!agent.branch} />
      <KeyValue theme={theme} compact={compact} label="Agent 工作目录" value={agent.cwd || "未报告"} mono />
      <KeyValue theme={theme} compact={compact} label="Agent ID" value={agent.id} mono />
      <KeyValue theme={theme} compact={compact} label="原始运行状态" value={agent.rawStatus} />
      <KeyValue theme={theme} compact={compact} label="创建时间" value={localTime(agent.createdAt)} />
      <KeyValue theme={theme} compact={compact} label="最近活动" value={localTime(agent.lastActivityAt)} />
      {agent.parentAgentId ? <KeyValue theme={theme} compact={compact} label="上级 Agent" value={agent.parentAgentId} mono /> : null}
    </View>)}
    {section("会话历史", evidenceLoading ? <Skeleton theme={theme} rows={1} /> : evidenceError ? <MetaLine theme={theme} parts={["历史证据暂不可用，切换标签后会重试"]} /> : evidence ? <View style={{ gap: space.sm }}>
      <StatRow theme={theme} stats={[{ label: "用户轮次", value: String(evidence.turns) }, { label: "工具执行", value: String(evidence.tools) }, { label: "工具失败", value: String(evidence.toolFailures), tone: evidence.toolFailures ? "danger" : undefined }]} />
      <MetaLine theme={theme} numberOfLines={2} parts={[evidence.complete ? "覆盖宿主保留的完整历史" : evidence.coverageReason || "只覆盖部分历史窗口"]} />
    </View> : null)}
    {section("用量", <View style={{ gap: space.sm }}>
      <StatRow theme={theme} stats={[{ label: "输入 tokens", value: formatTokens(usage.inputTokens) }, { label: "输出 tokens", value: formatTokens(usage.outputTokens) }, { label: "缓存命中", value: formatTokens(usage.cachedInputTokens) }, { label: "费用 USD", value: usage.costUsd === null ? "—" : `$${usage.costUsd.toFixed(4)}` }]} />
      {usage.contextTotal !== null ? <MetaLine theme={theme} parts={[`上下文 ${formatTokens(usage.contextUsed)} / ${formatTokens(usage.contextTotal)}`]} /> : null}
    </View>, ["只展示提供方最近一次报告的用量。", "没有报告的指标显示为 —，不当作 0。"])}
    {section("插件观察", <StatRow theme={theme} stats={[{ label: "完成轮次", value: observed ? String(observed.completedTurns) : "—" }, { label: "失败轮次", value: observed ? String(observed.failedTurns) : "—", tone: observed?.failedTurns ? "danger" : undefined }, { label: "累计运行", value: observed ? formatDuration(observed.totalRunMs) || "0 秒" : "—" }, { label: "等待审批", value: observed ? formatDuration(observed.permissionWaitMs) || "0 秒" : "—" }]} />,
      ["从插件开始观察后累计，不是会话的终身总量。"])}
    {activity.length ? section("生命周期事件", <View>{activity.map(event => <View key={event.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
      <EventGlyph theme={theme} type={event.type} size={14} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small }}>{event.label}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{relativeTime(event.at, now)}</Text>
    </View>)}</View>) : null}
    {Object.keys(agent.labels).length ? <CodeBlock theme={theme} label="Agent 标签" value={agent.labels} /> : null}
  </View>;
}
