import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, AppState, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelInsight, getInsightReport, listInsightJobs, setFindingFeedback, startInsight, type EvidenceTarget, type FindingFeedback, type InsightEvidence, type InsightJob, type InsightJobSummary, type InsightListState, type InsightReport, type InsightRunner } from "../shared/insights";
import { formatTokens, normalizeAgent, type AgentRecord } from "../shared/model";
import { ActionMenu, Badge, Banner, Button, Chip, EmptyState, IconButton, MetaLine, Row, SearchField, Segmented, Sheet, Skeleton, SplitView, StatusDot, Toolbar, fontSize, hairline, radius, relativeTime, space, toneColor, type MenuAction, type Tone } from "./kit";
import { PaneLabel, StateDot, monoFont } from "./ui";
import { PhasePill, Spinner, hueColor } from "./status";
import { isForeground } from "./use-foreground";
import { InsightSettingsSheet, runnerLabelOf } from "./insight-settings";
import { SendToAgentSheet, findingSource, isFindingMessage } from "./insight-actions";
import { DeferredList, useDeferredQueue, type DeferredQueue } from "./deferred";
import type { DeferredView } from "../shared/deferred-rpc";
import { InsightsOverview } from "./insights-overview";

const queryPrefix = ["agent-observatory", "insights"] as const;
const busyStatuses: readonly InsightJob["status"][] = ["queued", "collecting", "analyzing"];
const stateNames: Record<InsightJob["status"], string> = { get queued() { return t("coreInsights.waitingForAnalysis"); }, get collecting() { return t("coreInsights.readingExecutionTrace"); }, get analyzing() { return t("coreInsights.analyzing"); }, get completed() { return t("coreInsights.reportReady"); }, get failed() { return t("coreInsights.analysisFailed"); }, get canceled() { return t("coreInsights.canceled"); }, get skipped() { return t("coreInsights.notEligibleYet"); } };
const healthNames: Record<InsightReport["health"], string> = { get healthy() { return t("coreInsights.healthyExecution"); }, get watch() { return t("coreInsights.worthWatching"); }, get blocked() { return t("coreInsights.blocked"); } };
const healthTones: Record<InsightReport["health"], Tone> = { healthy: "success", watch: "warning", blocked: "danger" };
const confidenceNames: Record<InsightReport["confidence"], string> = { get high() { return t("coreInsights.high"); }, get medium() { return t("coreInsights.medium"); }, get low() { return t("coreInsights.low"); } };
const severityNames: Record<InsightReport["findings"][number]["severity"], string> = { get high() { return t("coreInsights.highPriority"); }, get medium() { return t("coreInsights.mediumPriority"); }, get low() { return t("coreInsights.lowPriority"); } };
const severityTones: Record<InsightReport["findings"][number]["severity"], Tone> = { high: "danger", medium: "warning", low: "neutral" };
const categoryNames: Record<InsightReport["findings"][number]["category"], string> = { get failure() { return t("coreInsights.errorsAndFailures"); }, get loop() { return t("coreInsights.repetitionAndLoops"); }, get efficiency() { return t("coreInsights.executionEfficiency"); }, get coordination() { return t("coreInsights.taskCoordination"); }, get quality() { return t("coreInsights.deliveryQuality"); } };
function jobTone(job: Pick<InsightJobSummary, "status" | "health">): Tone {
  if (busyStatuses.includes(job.status)) return "info";
  if (job.status === "failed") return "danger";
  if (job.status === "skipped") return "warning";
  if (job.status === "completed") return job.health ? healthTones[job.health] : "success";
  return "neutral";
}

function useInsights(agentId?: string) {
  const read = useRpc(listInsightJobs), start = useRpc(startInsight), cancel = useRpc(cancelInsight);
  const cache = useQueryClient(), paseo = usePaseo();
  const [active, setActive] = useState(isForeground(AppState.currentState));
  useEffect(() => { const listener = AppState.addEventListener("change", state => { setActive(isForeground(state)); if (state === "active") void cache.invalidateQueries({ queryKey: queryPrefix }); }); return () => listener.remove(); }, [cache]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = paseo.agents.subscribe(() => { if (!active || timer) return; timer = setTimeout(() => { timer = undefined; void cache.invalidateQueries({ queryKey: [...queryPrefix, "list"] }); }, 1500); });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [paseo, cache, active]);
  const queryKey = [...queryPrefix, "list", agentId ?? "all"];
  const query = useQuery({ queryKey, queryFn: async () => {
    const cached = cache.getQueryData<InsightListState>(queryKey);
    const result = await read({ ...(agentId ? { agentId } : {}), ...(cached ? { revision: cached.revision } : {}) });
    return result.unchanged && cached ? { ...result, jobs: cached.jobs } : result;
  }, enabled: active, refetchInterval: query => {
    if (!active) return false;
    if ((query.state.data?.activeCount ?? 0) > 0) return 2000;
    const due = query.state.data?.nextScheduledAt;
    // Unchanged replies cost a few bytes; a slow fallback also catches jobs started by other clients.
    return due ? Math.max(1000, Math.min(90000, Date.parse(due) - Date.now() + 1000)) : 60_000;
  }, staleTime: 10000, retry: 1 });
  const invalidate = () => { void cache.invalidateQueries({ queryKey: queryPrefix }); };
  const startJob = useMutation({ mutationFn: (request: string | { id: string; mode?: "full" | "incremental"; runner?: InsightRunner }) => start(typeof request === "string" ? { agentId: request } : { agentId: request.id, mode: request.mode, ...(request.runner ? { runner: request.runner } : {}) }), onSuccess: invalidate });
  const cancelJob = useMutation({ mutationFn: (jobId: string) => cancel({ jobId }), onSuccess: invalidate });
  return { query, startJob, cancelJob };
}
function useInsightReport(summary: InsightJobSummary | undefined) {
  const read = useRpc(getInsightReport), feedback = useRpc(setFindingFeedback), cache = useQueryClient();
  const query = useQuery({ queryKey: [...queryPrefix, "report", summary?.id], queryFn: () => read({ jobId: summary!.id }), enabled: !!summary?.reportAvailable, staleTime: Infinity, refetchInterval: false, retry: 1 });
  const updateFeedback = useMutation({ mutationFn: (input: { findingId: string; status: FindingFeedback["status"] }) => feedback({ jobId: summary!.id, ...input }),
    onSuccess: job => { cache.setQueryData([...queryPrefix, "report", job.id], { job, revision: 0 }); void cache.invalidateQueries({ queryKey: [...queryPrefix, "list"] }); } });
  const job = query.data?.job ? { ...query.data.job, freshness: summary?.freshness ?? query.data.job.freshness, findingFeedback: summary?.findingFeedback ?? query.data.job.findingFeedback, nextAutoAt: summary?.nextAutoAt } : null;
  return { query, job, updateFeedback };
}

/** 自动分析 on/off and the analysing model at a glance; opens 分析设置. */
function AnalysisSettingsRow({ theme, state }: { theme: PluginTheme; state?: Pick<InsightListState, "settings" | "runnerLabel">; }) {
  const { colors } = theme, [open, setOpen] = useState(false), on = state?.settings.autoEnabled ?? false;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={t("coreInsights.analysisSettingsAutomaticAnalysis", { value1: on ? t("coreInsights.on") : t("coreInsights.off") })} onPress={() => setOpen(true)}
      style={pressed => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40, paddingHorizontal: space.sm, marginHorizontal: -space.sm, borderRadius: radius.md, backgroundColor: pressed.pressed ? colors.surface2 : "transparent" })}>
      <Icon name={on ? "Zap" : "PauseCircle"} size={16} color={on ? hueColor(theme, "run") : colors.foregroundMuted} />
      <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{on ? t("coreInsights.automaticAnalysisOn") : t("coreInsights.automaticAnalysisOff")}</Text>
      <Text numberOfLines={1} style={{ flex: 1, textAlign: "right", color: colors.foregroundMuted, fontSize: fontSize.meta }}>{state?.runnerLabel ?? "…"}</Text>
      <Icon name="Settings2" size={15} color={colors.foregroundMuted} />
    </Pressable>
    <InsightSettingsSheet theme={theme} open={open} onClose={() => setOpen(false)} settings={state?.settings} />
  </>;
}

function JobProgress({ theme, job, cancelPending, onCancel }: { theme: PluginTheme; job: InsightJob | InsightJobSummary; cancelPending: boolean; onCancel: () => void }) {
  const { colors } = theme;
  const steps: Array<{ status: InsightJob["status"]; label: string }> = [{ status: "queued", label: t("coreInsights.queued") }, { status: "collecting", label: t("coreInsights.readingTrace") }, { status: "analyzing", label: t("coreInsights.generatingReport") }, { status: "completed", label: t("coreInsights.ready") }];
  const activeIndex = steps.findIndex(step => step.status === job.status);
  const mark = toneColor(theme, "accent", "mark");
  return <View style={{ gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <ActivityIndicator size="small" color={colors.foregroundMuted} />
      <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{stateNames[job.status]}</Text>
      <Button theme={theme} label={cancelPending ? t("coreInsights.canceling") : t("coreInsights.cancelAnalysis")} size="sm" onPress={onCancel} disabled={cancelPending} accessibilityLabel={t("coreInsights.cancelAnalysis")} />
    </View>
    <View style={{ flexDirection: "row", gap: space.xs }}>{steps.map((step, index) => <View key={step.status} style={{ flex: 1, gap: space.xs }}>
      <View style={{ height: 3, borderRadius: 2, backgroundColor: index <= activeIndex ? mark : colors.surface2 }} />
      <Text style={{ color: index === activeIndex ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.meta }}>{step.label}</Text>
    </View>)}</View>
    <Text style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{job.stage || t("coreInsights.waitingForTheAnalysisProcessToReport")}</Text>
    <MetaLine theme={theme} parts={[job.trigger === "auto" ? t("coreInsights.triggeredAutomatically") : t("coreInsights.startedManually"), relativeTime(job.createdAt), job.coverage ? t("coreInsights.readTraceEntries", { value1: job.coverage.rows }) : null, job.coverage?.truncated ? t("coreInsights.limitedWindow") : null]} />
  </View>;
}

const evidenceKinds: Record<string, string> = { get tool_call() { return t("coreInsights.toolCall"); }, get assistant_message() { return t("coreInsights.agentReply"); }, get user_message() { return t("coreInsights.userInstruction"); }, get reasoning() { return t("coreInsights.reasoningSummary"); }, get error() { return t("coreInsights.executionError"); }, get notification() { return t("coreInsights.executionNotice"); }, get todo() { return t("coreInsights.taskPlan"); }, get compaction() { return t("coreInsights.contextCompaction"); }, get plugin() { return t("coreInsights.pluginRecord"); } };
function EvidenceSnippet({ theme, reference, source, onOpen }: { theme: PluginTheme; reference: string; source?: InsightEvidence; onOpen?: () => void }) {
  const { colors } = theme;
  const [expanded, setExpanded] = useState(false);
  const label = source ? source.toolName || evidenceKinds[source.kind] || source.kind || t("coreInsights.executionTrace") : t("coreInsights.originalExcerptNotRetained");
  const date = source?.at ? new Date(source.at) : null;
  const recordedAt = date && Number.isFinite(date.getTime()) ? date.toLocaleString(currentLanguage(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : t("coreInsights.timeNotRecorded");
  const expandable = !!source && (source.text.length > 280 || source.text.split("\n").length > 4);
  return <View style={{ borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
    <Pressable disabled={!expandable} accessibilityRole={expandable ? "button" : undefined} accessibilityLabel={expandable ? t("coreInsights.evidenceExcerpt", { value1: expanded ? t("coreInsights.collapse") : t("coreInsights.expand"), value2: label }) : undefined} accessibilityState={expandable ? { expanded } : undefined} onPress={() => setExpanded(!expanded)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, paddingHorizontal: 10, paddingVertical: space.xs + 2 }}>
      <Icon name={source?.toolName ? "Terminal" : source ? "FileText" : "FileQuestion"} size={14} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "500", fontFamily: source?.toolName ? monoFont : undefined }}>{label}</Text>
      {source ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{recordedAt}</Text> : null}
      {expandable ? <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} color={colors.foregroundMuted} /> : null}
    </Pressable>
    {source ? <Text selectable numberOfLines={expanded || !expandable ? undefined : 5} style={{ paddingHorizontal: 10, paddingBottom: space.sm, color: colors.foreground, fontSize: fontSize.meta, lineHeight: 18, ...(source.toolName ? { fontFamily: monoFont } : {}) }}>{source.text || t("coreInsights.noDisplayableTextInThisTraceEntry")}</Text>
      : <Text style={{ paddingHorizontal: 10, paddingBottom: space.sm, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreInsights.theReportDidNotRetainThisExcerpt")}</Text>}
    {expandable ? <Pressable accessibilityRole="button" accessibilityLabel={t("coreInsights.fullEvidence", { value1: expanded ? t("coreInsights.collapse") : t("coreInsights.expand"), value2: label })} onPress={() => setExpanded(!expanded)} style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{expanded ? t("coreInsights.collapseExcerpt") : t("coreInsights.expandFullExcerpt")}</Text>
    </Pressable> : null}
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32, paddingLeft: 10, paddingRight: 2, borderTopWidth: hairline, borderTopColor: colors.border }}>
      <Text selectable numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11, fontFamily: monoFont }}>{reference}</Text>
      {onOpen ? <Button theme={theme} label={t("coreInsights.locate")} icon="LocateFixed" size="sm" variant="ghost" accessibilityLabel={t("coreInsights.locateOriginalEvidence")} onPress={onOpen} /> : null}
    </View>
  </View>;
}

function Finding({ theme, finding, index, evidence, feedback, onFeedback, pending, onOpenEvidence, onSend, queue }: { theme: PluginTheme; finding: InsightReport["findings"][number]; index: number; evidence: readonly InsightEvidence[];
  feedback?: FindingFeedback; onFeedback: (status: FindingFeedback["status"]) => void; pending: boolean; onOpenEvidence?: (ref: string) => void; onSend?: () => void; queue?: DeferredQueue }) {
  const { colors } = theme;
  const [open, setOpen] = useState(index === 0 || finding.severity === "high");
  const sources = useMemo(() => new Map(evidence.map(source => [source.ref, source])), [evidence]);
  // This finding sent to the Agent through the ledger: on its way (排队中, 待确认) or just out, beside its 发给这个 Agent.
  const sent = (view: DeferredView) => view.source === findingSource(finding);
  return <View style={{ borderTopWidth: hairline, borderTopColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={t("coreInsights.analysisFinding", { value1: open ? t("coreInsights.collapse") : t("coreInsights.expand"), value2: finding.title })} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
      style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: space.md, opacity: state.pressed ? 0.75 : 1 })}>
      <View style={{ paddingTop: 6 }}><StatusDot theme={theme} tone={severityTones[finding.severity]} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "500", lineHeight: 20 }}>{finding.title}</Text>
        <MetaLine theme={theme} parts={[severityNames[finding.severity], categoryNames[finding.category], feedback && feedback.status !== "open" ? feedback.status === "resolved" ? t("coreInsights.resolved") : t("coreInsights.falsePositive") : null]} />
      </View>
      <View style={{ paddingTop: 3 }}><Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} /></View>
    </Pressable>
    {open ? <View style={{ gap: space.md, paddingBottom: space.lg, paddingLeft: 18 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{finding.detail}</Text>
      {finding.evidence.length ? <View style={{ gap: space.sm }}>{finding.evidence.map((reference, sourceIndex) => <EvidenceSnippet key={`${sourceIndex}:${reference}`} theme={theme} reference={reference} source={sources.get(reference)} onOpen={onOpenEvidence ? () => onOpenEvidence(reference) : undefined} />)}</View> : null}
      <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{t("coreInsights.recommendation")}</Text>
        <Text selectable style={{ color: colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{finding.recommendation}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Segmented theme={theme} size="sm" value={feedback?.status ?? "open"} onChange={status => { if (!pending) onFeedback(status); }} accessibilityLabel={t("coreInsights.followUpStatus")} options={[{ value: "open", label: t("coreInsights.stillPresent") }, { value: "resolved", label: t("coreInsights.resolved") }, { value: "false_positive", label: t("coreInsights.falsePositive") }]} />
        {onSend && (feedback?.status ?? "open") === "open" ? <Button theme={theme} size="sm" icon="Send" label={t("coreInsights.sendToThisAgent")} tone="pink" onPress={onSend} /> : null}
        {feedback ? <MetaLine theme={theme} parts={[t("coreInsights.saved", { value1: relativeTime(feedback.updatedAt) })]} /> : null}
      </View>
    </View> : null}
    {queue?.views.some(sent) ? <View style={{ paddingLeft: 18, paddingBottom: space.md }}><DeferredList theme={theme} queue={queue} only={sent} /></View> : null}
  </View>;
}

function ListSection({ theme, title, items }: { theme: PluginTheme; title: string; items: string[] }) {
  if (!items.length) return null;
  return <View style={{ gap: space.sm }}>
    <PaneLabel theme={theme}>{title}</PaneLabel>
    {items.map((item, index) => <View key={`${index}:${item}`} style={{ flexDirection: "row", gap: space.sm }}>
      <Text style={{ width: 18, color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 22, fontVariant: ["tabular-nums"] }}>{index + 1}.</Text>
      <Text selectable style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{item}</Text>
    </View>)}
  </View>;
}

function Report({ theme, job, onFeedback, feedbackPending, onOpenEvidence, onSend, onOpenSession, queue }: { theme: PluginTheme; job: InsightJob; onFeedback: (findingId: string, status: FindingFeedback["status"]) => void; feedbackPending: boolean;
  onOpenEvidence?: (target: EvidenceTarget) => void; onSend?: (finding: InsightReport["findings"][number]) => void; onOpenSession?: (agentId: string) => void; queue?: DeferredQueue }) {
  const toast = useToast();
  if (!job.report) return null;
  const report = job.report;
  const copy = async () => {
    try { await copyText(JSON.stringify({ agentId: job.agentId, agentTitle: job.agentTitle, projectName: job.projectName, analyzedAt: job.updatedAt, model: job.model, effort: job.effort, coverage: job.coverage, source: job.source, freshness: job.freshness, reviewContext: job.reviewContext, findingFeedback: job.findingFeedback, report, evidence: job.evidence ?? [] }, null, 2)); toast.show(t("coreInsights.analysisReportCopied"), { variant: "success" }); }
    catch { toast.error(t("coreInsights.couldNotCopyTryAgainLater")); }
  };
  return <View style={{ gap: space.xl }}>
    {job.freshness?.state === "unknown" ? <Banner theme={theme} tone="warning" message={t("coreInsights.thisOlderReportHasNoExecutionVersion")} /> : null}
    {job.freshness?.state === "new_activity" ? <Banner theme={theme} tone="warning" message={job.freshness.newTurns ? t("coreInsights.newActivityTurns", { count: job.freshness.newTurns }) : t("coreInsights.newActivity")} /> : null}
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Badge theme={theme} label={healthNames[report.health]} tone={healthTones[report.health]} icon={report.health === "healthy" ? "CircleCheck" : "CircleAlert"} />
        <MetaLine theme={theme} parts={[t("coreInsights.confidence", { value1: confidenceNames[report.confidence] }), t("coreInsights.findings", { count: report.findings.length }), relativeTime(job.updatedAt)]} />
      </View>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.content, lineHeight: 24 }}>{report.summary}</Text>
      <MetaLine theme={theme} numberOfLines={2} parts={[job.coverage ? t("coreInsights.coversTraceEntries", { value1: job.coverage.rows, value2: job.coverage.truncated ? t("coreInsights.limitedWindow2") : "" }) : null, job.eligibility ? t("coreInsights.turnsToolCalls", { count: job.eligibility.turnCount, value2: job.eligibility.toolCount }) : null, job.reviewContext?.mode === "incremental" ? t("coreInsights.incrementalFollowUpNewEntries", { value1: job.reviewContext.newRows }) : null]} />
    </View>
    {report.findings.length ? <View>
      <PaneLabel theme={theme}>{t("coreInsights.observationsAndRecommendations")}</PaneLabel>
      {report.findings.map((finding, index) => <Finding key={`${job.id}:${finding.id}`} theme={theme} finding={finding} index={index} evidence={job.evidence ?? []} feedback={job.findingFeedback?.[finding.id]} pending={feedbackPending} onFeedback={status => onFeedback(finding.id, status)} onOpenEvidence={onOpenEvidence ? ref => onOpenEvidence({ agentId: job.agentId, ref }) : undefined} onSend={onSend ? () => onSend(finding) : undefined} queue={queue} />)}
    </View> : null}
    <ListSection theme={theme} title={t("coreInsights.practicesToKeep")} items={report.strengths} />
    <ListSection theme={theme} title={t("coreInsights.nextSteps")} items={report.nextActions} />
    <ListSection theme={theme} title={t("coreInsights.analysisLimits")} items={report.limitations} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      <View style={{ marginLeft: -space.sm }}><Button theme={theme} icon="Copy" label={t("coreInsights.copyAnalysisReport")} size="sm" variant="ghost" onPress={() => { void copy(); }} /></View>
      <MetaLine theme={theme} numberOfLines={2} parts={[runnerLabelOf(job), job.usage ? t("coreInsights.inputOutput", { value1: formatTokens(job.usage.inputTokens), value2: formatTokens(job.usage.outputTokens) }) : null, job.source ? t("coreInsights.evidenceVersionThrough", { value1: job.source.epoch.slice(0, 8), value2: job.source.endSeq }) : null]} />
      {job.runner?.sessionAgentId && onOpenSession ? <Button theme={theme} icon="MessageSquareText" label={t("coreInsights.openAnalysisSession")} size="sm" variant="ghost" onPress={() => onOpenSession(job.runner!.sessionAgentId!)} /> : null}
    </View>
  </View>;
}

export function InsightsPanel({ agent, theme, navigation, initialJobId, onOpenEvidence, showAutoSetting = true }: { agent: AgentRecord; theme: PluginTheme; compact: boolean; navigation?: PluginSurfaceProps["navigation"]; initialJobId?: string; onOpenEvidence?: (target: EvidenceTarget) => void; showAutoSetting?: boolean }) {
  const { query, startJob, cancelJob } = useInsights(agent.id);
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(initialJobId ?? null);
  useEffect(() => { setSelectedId(initialJobId ?? null); }, [agent.id, initialJobId]);
  const jobs = useMemo(() => [...(query.data?.jobs ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [query.data]);
  const explicit = jobs.find(item => item.id === selectedId);
  const selectedReport = explicit?.reportAvailable ? explicit : jobs.find(item => item.status === "completed" && item.reportAvailable);
  const detail = useInsightReport(selectedReport);
  let job = detail.job;
  if (job?.source && agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > Date.parse(job.source.capturedAt) && job.freshness?.state !== "new_activity") job = { ...job, freshness: { state: "new_activity", newTurns: null, latestTurnAt: agent.lastUserMessageAt } };
  const attempt = explicit && !explicit.reportAvailable ? explicit : jobs[0];
  const active = jobs.find(item => busyStatuses.includes(item.status));
  const mutationError = startJob.error ?? cancelJob.error;
  const unavailable = query.data?.available === false;
  const start = (mode: "full" | "incremental" = "incremental", runner?: InsightRunner) => startJob.mutate({ id: agent.id, mode, ...(runner ? { runner } : {}) }, { onSuccess: () => setSelectedId(null) });
  const busy = startJob.isPending || !!active;
  const [menuOpen, setMenuOpen] = useState(false), [pickOpen, setPickOpen] = useState(false);
  const [sendFinding, setSendFinding] = useState<InsightReport["findings"][number] | null>(null);
  // Findings sent to this Agent through the ledger: queued for the end of its turn, waiting for the user, or just out.
  const deferred = useDeferredQueue(agent.id);
  const menu: MenuAction[] = [
    { key: "runner", label: t("coreInsights.analyzeWithAnotherModel"), icon: "Shuffle", hint: t("coreInsights.appliesOnlyThisTimeDoesNotChange"), disabled: busy, onPress: () => setPickOpen(true) },
    ...(selectedReport ? [{ key: "full", label: t("coreInsights.fullRecap"), icon: "ScanLine", hint: t("coreInsights.rereadTheFullTraceAndEstablishA"), disabled: busy, onPress: () => start("full") }] : []),
    { key: "refresh", label: t("coreInsights.refreshAnalysis"), icon: "RefreshCw", disabled: query.isFetching, onPress: () => { void query.refetch(); } },
  ];
  return <View testID="insights-panel" style={{ gap: space.lg }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      <Button theme={theme} variant="primary" icon="Sparkles" label={startJob.isPending ? t("coreInsights.starting") : active ? t("coreInsights.analysisInProgress") : job ? t("coreInsights.analyzeAgain") : t("coreInsights.analyzeCurrentAgent")} onPress={() => start()} disabled={busy || unavailable || !query.data} />
      {selectedReport ? <Button theme={theme} label={t("coreInsights.incrementalFollowUp")} icon="GitCompare" onPress={() => start("incremental")} disabled={busy} /> : null}
      <IconButton theme={theme} icon="Ellipsis" label={t("coreInsights.moreAnalysisActions")} onPress={() => setMenuOpen(true)} />
    </View>
    {query.data?.runnerLabel ? <MetaLine theme={theme} parts={[t("coreInsights.analyzedBy", { value1: query.data.runnerLabel }), t("coreInsights.chooseAnotherModelForThisAnalysisUnder")]} /> : null}
    <ActionMenu theme={theme} title={t("coreInsights.moreAnalysisActions")} open={menuOpen} onClose={() => setMenuOpen(false)} actions={menu} />
    <InsightSettingsSheet theme={theme} open={pickOpen} onClose={() => setPickOpen(false)} settings={query.data?.settings} pick={{ title: t("coreInsights.analyzeWithAnotherModel"), onPick: runner => start(selectedReport ? "incremental" : "full", runner) }} />
    <SendToAgentSheet theme={theme} open={!!sendFinding} onClose={() => setSendFinding(null)} agentId={agent.id} agentTitle={agent.title} finding={sendFinding} />
    {unavailable ? <Banner theme={theme} tone="warning" message={t("coreInsights.theCurrentAnalysisModelIsUnavailableChoose", { value1: query.data?.runnerLabel ?? t("coreInsights.analysisModel") })} /> : null}
    {query.error ? <Banner theme={theme} tone="danger" message={t("coreInsights.couldNotLoadAnalysisStatus", { value1: query.error.message })} action={{ label: t("coreInsights.retry"), onPress: () => void query.refetch() }} /> : null}
    {query.data?.persistenceError ? <Banner theme={theme} tone="warning" message={query.data.persistenceError} /> : null}
    {mutationError ? <Banner theme={theme} tone="danger" message={mutationError.message} /> : null}
    {detail.query.error ? <Banner theme={theme} tone="danger" message={t("coreInsights.couldNotLoadReport", { value1: detail.query.error.message })} /> : null}
    {detail.updateFeedback.error ? <Banner theme={theme} tone="danger" message={t("coreInsights.couldNotSaveFeedback", { value1: detail.updateFeedback.error.message })} /> : null}
    {active ? <JobProgress theme={theme} job={active} cancelPending={cancelJob.isPending} onCancel={() => cancelJob.mutate(active.id)} /> : null}
    {jobs.length > 1 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{jobs.slice(0, 8).map(item => <Chip key={item.id} theme={theme} tone={jobTone(item)} label={t("coreInsights.reportHistory", { state: stateNames[item.status], time: new Date(item.createdAt).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit", hour12: false }) })} selected={(job?.id ?? attempt?.id) === item.id} onPress={() => setSelectedId(item.id)} />)}</View> : null}
    {attempt && !busyStatuses.includes(attempt.status) && attempt.status !== "completed" ? <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: hairline, borderColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><StateDot theme={theme} tone={jobTone(attempt)} /><Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{stateNames[attempt.status]}</Text>
        {attempt.status === "failed" || attempt.status === "canceled" ? <Button theme={theme} label={t("coreInsights.retryAnalysis")} icon="RefreshCw" size="sm" onPress={() => start()} disabled={busy || unavailable} /> : null}</View>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{attempt.error || (attempt.status === "skipped" ? attempt.stage || attempt.eligibility?.reason : attempt.stage) || attempt.eligibility?.reason}</Text>
      {attempt.eligibility ? <MetaLine theme={theme} parts={[t("coreInsights.detectedConversationTurnsToolCalls", { value1: attempt.eligibility.turnCount, value2: attempt.eligibility.toolCount })]} /> : null}
    </View> : null}
    {attempt?.nextAutoAt && Date.parse(attempt.nextAutoAt) > Date.now() ? <MetaLine theme={theme} parts={[t("coreInsights.automaticAnalysisCooldownUntil", { value1: new Date(attempt.nextAutoAt).toLocaleString(currentLanguage(), { hour12: false }) }), t("coreInsights.manualRecapIsStillAvailable")]} /> : null}
    {selectedReport && detail.query.isPending ? <Skeleton theme={theme} rows={3} /> : null}
    {/* Findings sent from another report (or under a title since changed): beside the report, as their own findings' are beside them. */}
    <DeferredList theme={theme} queue={deferred} only={view => isFindingMessage(view) && !job?.report?.findings.some(finding => findingSource(finding) === view.source)} />
    {job?.report ? <Report key={job.id} queue={deferred} theme={theme} job={job} onFeedback={(findingId, status) => detail.updateFeedback.mutate({ findingId, status })} feedbackPending={detail.updateFeedback.isPending} onOpenEvidence={onOpenEvidence}
      onSend={agent.archivedAt ? undefined : setSendFinding} onOpenSession={navigation ? agentId => { try { navigation.openAgent({ agentId }); } catch (error) { toast.error(error instanceof Error ? error.message : t("coreInsights.couldNotOpenSession")); } } : undefined} /> : null}
    {!jobs.length && !query.isPending ? <EmptyState theme={theme} icon="Sparkles" title={t("coreInsights.noAnalysisReportsYet")} message={t("coreInsights.analysisSendsExcerptsFromThisSessionS")} /> : null}
    {query.isPending ? <Skeleton theme={theme} rows={2} /> : null}
    {navigation && job?.report ? <View style={{ alignItems: "flex-start", marginLeft: -space.sm }}><Button theme={theme} label={t("coreInsights.returnToTheSessionToViewOriginal")} icon="ArrowUpRight" variant="ghost" size="sm" onPress={() => { try { navigation.openAgent({ agentId: agent.id }); } catch (error) { toast.error(error instanceof Error ? error.message : t("coreInsights.couldNotOpenSession")); } }} /></View> : null}
    {showAutoSetting ? <View style={{ borderTopWidth: hairline, borderTopColor: theme.colors.border, paddingTop: space.sm }}><AnalysisSettingsRow theme={theme} state={query.data} /></View> : null}
  </View>;
}

export function InsightsHub({ agents, theme, compact, onSelectAgent, onOpenEvidence, onPush }: { agents: AgentRecord[]; theme: PluginTheme; compact: boolean; onSelectAgent: (agentId: string) => void; onOpenEvidence?: (target: EvidenceTarget) => void; onPush?: (pushed: boolean) => void }) {
  const { colors } = theme;
  const { query, cancelJob } = useInsights();
  const [search, setSearch] = useState("");
  const [chooser, setChooser] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>(undefined);
  const jobs = useMemo(() => { const visibleIds = new Set(agents.filter(agent => !agent.archivedAt).map(agent => agent.id)); return [...(query.data?.jobs ?? [])].filter(job => visibleIds.has(job.agentId)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); }, [query.data, agents]);
  const completed = jobs.filter(job => job.status === "completed").length, working = jobs.filter(job => busyStatuses.includes(job.status)).length, attention = jobs.filter(job => job.health === "blocked" || job.health === "watch").length;
  const matches = agents.filter(agent => agent.labels["observatory.role"] !== "insight").filter(agent => !search.trim() || `${agent.title} ${agent.projectName} ${agent.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).slice(0, 20);
  const selectedRecord = agents.find(agent => agent.id === selectedId);
  const allJobs = query.data?.jobs ?? [];
  const historicalJob = allJobs.find(job => job.id === selectedJobId) ?? allJobs.find(job => job.agentId === selectedId);
  // Saved reports remain readable when their Agent has left the current directory.
  const selected = selectedRecord ?? (selectedId && historicalJob ? normalizeAgent({ id: selectedId, title: historicalJob.agentTitle, projectName: historicalJob.projectName }) : undefined);
  const error = query.error ?? cancelJob.error;
  const close = () => { setSelectedId(null); setSelectedJobId(undefined); };
  const [view, setView] = useState<"overview" | "reports">("overview"), [settingsOpen, setSettingsOpen] = useState(false);
  const openReport = ({ jobId, agentId }: { jobId: string; agentId: string }) => { setSelectedId(agentId); setSelectedJobId(jobId); setView("reports"); };
  const switcher = <Segmented theme={theme} size="sm" value={view} onChange={setView} accessibilityLabel={t("coreInsights.intelligentAnalysisView")} options={[{ value: "overview", label: t("coreInsights.overview") }, { value: "reports", label: t("coreInsights.reports") }]} />;
  // On phones an open report takes the whole surface, like a session detail.
  const pushed = compact && view === "reports" && !!selected;
  useEffect(() => { onPush?.(pushed); }, [pushed, onPush]);
  useEffect(() => () => onPush?.(false), [onPush]);
  const settingsSheet = <InsightSettingsSheet theme={theme} open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={query.data?.settings} />;
  if (view === "overview") return <View style={{ flex: 1, minHeight: 0 }}>
    <InsightsOverview theme={theme} compact={compact} agents={agents} header={switcher} onOpenReport={openReport} onOpenSettings={() => setSettingsOpen(true)}
      onNewAnalysis={() => { setView("reports"); setChooser(true); }} onSelectAgent={onSelectAgent} />
    {settingsSheet}
  </View>;
  const list = <FlatList data={jobs.slice(0, 40)} keyExtractor={job => job.id} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: space.xs, paddingBottom: space.xl }}
    ListHeaderComponent={<View style={{ gap: space.md, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
      {switcher}
      <AnalysisSettingsRow theme={theme} state={query.data} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Button theme={theme} label={t("coreInsights.newAnalysis")} icon="Plus" variant="primary" onPress={() => setChooser(true)} />
        {jobs.length ? <MetaLine theme={theme} parts={[t("coreInsights.reports2", { count: completed }), working ? t("coreInsights.inProgress", { value1: working }) : null, attention ? t("coreInsights.worthWatching2", { value1: attention }) : null]} /> : null}
      </View>
      {error ? <Banner theme={theme} tone="danger" message={error.message} action={{ label: t("coreInsights.retry"), onPress: () => void query.refetch() }} /> : null}
      {query.data?.persistenceError ? <Banner theme={theme} tone="warning" message={query.data.persistenceError} /> : null}
      {query.data?.available === false ? <Banner theme={theme} tone="warning" message={t("coreInsights.theCurrentAnalysisModelIsUnavailableExisting", { value1: query.data.runnerLabel ?? t("coreInsights.analysisModel") })} /> : null}
    </View>}
    ListEmptyComponent={query.isPending ? <Skeleton theme={theme} rows={3} /> : <EmptyState theme={theme} icon="Sparkles" title={t("coreInsights.noAnalysisReportsYet")} message={t("coreInsights.chooseASessionWithEnoughTraceHistory")} />}
    renderItem={({ item: job }) => <Row theme={theme} title={job.agentTitle} selected={selectedJobId === job.id} accessibilityLabel={t("coreInsights.viewAnalysis", { value1: job.agentTitle })} onPress={() => { setSelectedId(job.agentId); setSelectedJobId(job.id); }}
      leading={busyStatuses.includes(job.status) ? <Spinner size={16} color={hueColor(theme, "run")} /> : <View style={{ width: 16, alignItems: "center" }}><StateDot theme={theme} tone={jobTone(job)} /></View>}
      trailing={busyStatuses.includes(job.status) ? <PhasePill theme={theme} hue="run" label={t("coreInsights.analyzing")} /> : job.status === "failed" ? <PhasePill theme={theme} hue="fail" label={t("coreInsights.failed")} /> : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(job.createdAt)}</Text>}
      subtitle={<MetaLine theme={theme} parts={[job.projectName || t("coreInsights.noLinkedProject"), job.trigger === "auto" ? t("coreInsights.automatic") : t("coreInsights.manual"), job.status === "completed" && job.health ? healthNames[job.health] : stateNames[job.status]]} />}>
      {job.summary || job.error ? <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{job.summary || job.error}</Text> : null}
    </Row>} />;
  const panel = selected ? <View style={{ flex: 1, minHeight: 0 }}>
    {compact ? <Toolbar theme={theme}><IconButton theme={theme} icon="ChevronLeft" label={t("coreInsights.backToAnalysisList")} onPress={close} /><Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{t("coreInsights.analysisReport")}</Text></Toolbar> : null}
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: compact ? space.lg : space.xl, paddingTop: space.lg, paddingBottom: space.xxl, gap: space.lg }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
          <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: fontSize.heading, fontWeight: "600", lineHeight: 26 }}>{selected.title}</Text>
          {!compact ? <IconButton theme={theme} icon="X" label={t("coreInsights.closeAnalysis")} size="sm" onPress={close} /> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <MetaLine theme={theme} parts={[selected.projectName, selectedRecord ? null : t("coreInsights.sessionIsNotInTheCurrentList")]} />
          {selectedRecord ? <Button theme={theme} label={t("coreInsights.viewSession")} icon="ArrowUpRight" size="sm" variant="ghost" onPress={() => onSelectAgent(selected.id)} /> : null}
        </View>
      </View>
      <InsightsPanel key={selected.id} agent={selected} theme={theme} compact={compact} initialJobId={selectedJobId} onOpenEvidence={onOpenEvidence} showAutoSetting={false} />
    </ScrollView>
  </View> : <View style={{ flex: 1, justifyContent: "center" }}><EmptyState theme={theme} icon="Sparkles" title={t("coreInsights.selectAnAnalysis")} message={t("coreInsights.reportsEvidenceAndFollowUpStatusAppear")} /></View>;
  return <>
    <SplitView theme={theme} compact={compact} showDetail={!!selected} list={list} detail={panel} />
    <Sheet title={t("coreInsights.chooseASessionToAnalyze")} open={chooser} onClose={() => setChooser(false)}>
      <SearchField theme={theme} value={search} onChangeText={setSearch} placeholder={t("coreInsights.searchTasksOrProjects")} accessibilityLabel={t("coreInsights.searchAgentsToAnalyze")} grow={false} />
      <View style={{ marginHorizontal: -space.md }}>
        {matches.map(agent => <Row key={agent.id} theme={theme} title={agent.title} titleLines={1} accessibilityLabel={t("coreInsights.selectAnalysis", { value1: agent.title })} onPress={() => { setSelectedId(agent.id); setSelectedJobId(undefined); setChooser(false); }}
          subtitle={<MetaLine theme={theme} parts={[agent.projectName, agent.provider]} />} trailing={<Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />} />)}
      </View>
      {!matches.length ? <MetaLine theme={theme} parts={[t("coreInsights.noMatchingSessions")]} /> : null}
      <MetaLine theme={theme} numberOfLines={2} parts={[t("coreInsights.showingUpTo20"), t("coreInsights.manualAnalysisRequiresAtLeast2Conversation")]} />
    </Sheet>
  </>;
}
