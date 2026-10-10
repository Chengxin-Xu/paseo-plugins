import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { ActionFeedback, FindingCategory, FindingSeverity, InsightOverview, OverviewDays, SuggestionAction, SuggestionEvidence, SuggestionJob, SuggestionSummary, SuggestionTheme } from "../shared/insight-overview";
import type { AgentRecord } from "../shared/model";
import { bigNumber, percent } from "../shared/stats-view";
import { Badge, Banner, Button, EmptyState, IconButton, Segmented, Skeleton, fontSize, gradient, hue, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { Card, StackedColumns } from "./charts";
import { GlassPill, IconDisk, trackFor } from "./stats-common";
import { InfoButton, monoFont } from "./ui";
import { Spinner } from "./status";
import { HandoffSheet } from "./insight-actions";
import { useInsightOverview, useInsightSuggestions, useSuggestionActions } from "./use-insight-overview";

export const categoryLooks: Record<FindingCategory, { label: string; hue: Hue; icon: string }> = {
  failure: { label: "错误与失败", hue: "red", icon: "CircleX" }, loop: { label: "重复与循环", hue: "orange", icon: "Repeat" },
  efficiency: { label: "执行效率", hue: "amber", icon: "Gauge" }, coordination: { label: "任务协作", hue: "violet", icon: "Network" },
  quality: { label: "交付质量", hue: "blue", icon: "BadgeCheck" },
};
export const severityLooks: Record<FindingSeverity, { label: string; hue: Hue }> = { high: { label: "高", hue: "red" }, medium: { label: "中", hue: "amber" }, low: { label: "低", hue: "gray" } };
const healthLooks = { healthy: { label: "健康", hue: "green" as Hue }, watch: { label: "值得关注", hue: "amber" as Hue }, blocked: { label: "存在阻塞", hue: "red" as Hue } };
const scopeLooks: Record<SuggestionAction["scope"], { label: string; icon: string }> = {
  instructions: { label: "写进说明", icon: "ScrollText" }, workflow: { label: "调整流程", icon: "Workflow" }, profile: { label: "改 Profile", icon: "SlidersHorizontal" },
  project: { label: "项目配置", icon: "FolderCog" }, code: { label: "改代码", icon: "Code" }, tooling: { label: "补工具", icon: "Wrench" },
};
const impactLooks: Record<SuggestionAction["impact"], { label: string; hue: Hue }> = { high: { label: "高收益", hue: "pink" }, medium: { label: "中收益", hue: "violet" }, low: { label: "小收益", hue: "gray" } };
const effortNames: Record<SuggestionAction["effort"], string> = { small: "小改动", medium: "中等投入", large: "大工程" };
const trendLooks: Record<SuggestionTheme["trend"], { label: string; hue: Hue; icon: string }> = {
  new: { label: "新出现", hue: "pink", icon: "Sparkle" }, recurring: { label: "反复出现", hue: "orange", icon: "Repeat" }, improving: { label: "在好转", hue: "green", icon: "TrendingDown" },
};
const feedbackLooks: Record<Exclude<ActionFeedback["status"], "open">, { label: string; hue: Hue; icon: string }> = {
  adopted: { label: "已采纳", hue: "teal", icon: "ThumbsUp" }, done: { label: "已完成", hue: "green", icon: "CircleCheckBig" }, dismissed: { label: "已忽略", hue: "gray", icon: "EyeOff" },
};
const busy = (status?: string) => status === "queued" || status === "collecting" || status === "analyzing";
const dayLabel = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export interface OpenReport { (target: { jobId: string; agentId: string }): void }

function Tile({ theme, label, value, sub, icon, colors, ring }: { theme: PluginTheme; label: string; value: string; sub?: string; icon: string; colors: readonly [Hue, Hue]; ring?: number | null }) {
  const dark = isDarkTheme(theme), main = hue(theme, colors[0]);
  return <View style={[{ flexGrow: 1, flexBasis: 150, minWidth: 140, borderRadius: 16, padding: space.md, gap: 6, borderWidth: 1, borderColor: withAlpha(main, dark ? 0.3 : 0.22), overflow: "hidden" },
    gradient(theme, [withAlpha(main, dark ? 0.24 : 0.12), withAlpha(hue(theme, colors[1]), dark ? 0.06 : 0.03)], { angle: 150 })]}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <IconDisk theme={theme} icon={icon} colors={colors} size={24} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "600" }}>{label}</Text>
    </View>
    <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 26, lineHeight: 32, fontWeight: "800", fontVariant: ["tabular-nums"], letterSpacing: -0.5 }}>{value}</Text>
    {sub ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{sub}</Text> : null}
    {ring !== undefined && ring !== null ? <View style={{ height: 6, borderRadius: 3, backgroundColor: trackFor(theme), overflow: "hidden" }}><View style={{ width: `${Math.round(ring * 100)}%`, height: 6, borderRadius: 3, backgroundColor: main }} /></View> : null}
  </View>;
}

/** Deterministic line when no suggestion set exists yet. */
function fallbackHeadline(overview: InsightOverview): string {
  const { totals: t, health: h } = overview;
  if (!t.reports) return `近 ${overview.days} 天还没有分析报告`;
  const parts = [`${t.reports} 份报告覆盖 ${t.agents} 个 Agent`];
  if (h.blocked) parts.push(`${h.blocked} 份存在阻塞`);
  parts.push(t.openFindings ? `${t.openFindings} 个问题待处理` : "没有待处理的问题");
  return parts.join("，");
}

function Hero({ theme, overview, suggestion, running, narrow, onSuggest, onCancel, pending, onSettings }: { theme: PluginTheme; overview: InsightOverview; suggestion: SuggestionSummary | null; running: SuggestionSummary | null;
  narrow: boolean; onSuggest: () => void; onCancel: () => void; pending: boolean; onSettings: () => void }) {
  const t = overview.totals, fresh = overview.reportsSinceSuggestions;
  const headline = suggestion?.headline ?? fallbackHeadline(overview);
  const cta = !suggestion ? "生成建议" : fresh ? `更新建议 · ${fresh} 份新报告` : "重新生成建议";
  return <View style={[{ borderRadius: 20, padding: space.lg, gap: space.md, overflow: "hidden" }, gradient(theme, ["#14B8A6", "#06B6D4", "#8B5CF6"], { angle: 125 })]}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Icon name="Sparkles" size={15} color="#ffffff" />
      <Text style={{ flex: 1, color: withAlpha("#ffffff", 0.9), fontSize: fontSize.small, fontWeight: "700" }}>智能分析总览 · 近 {overview.days} 天</Text>
      {suggestion ? <Text style={{ color: withAlpha("#ffffff", 0.8), fontSize: 11 }}>建议写于 {relativeTime(suggestion.updatedAt)}</Text> : null}
    </View>
    <Text style={{ color: "#ffffff", fontSize: narrow ? fontSize.heading : 22, lineHeight: narrow ? 26 : 30, fontWeight: "800" }}>{headline}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <GlassPill label={overview.autoEnabled ? "自动分析 开" : "自动分析 关"} icon={overview.autoEnabled ? "Zap" : "PauseCircle"} onPress={onSettings} />
      <GlassPill label={overview.runnerLabel} icon="Bot" onPress={onSettings} />
      <GlassPill label="报告" value={t.reports} icon="FileText" />
      {t.tokens ? <GlassPill label="分析用量" value={bigNumber(t.tokens)} icon="Coins" /> : null}
    </View>
    {running ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha("#000000", 0.18) }}>
      <Spinner size={16} color="#ffffff" />
      <Text numberOfLines={2} style={{ flex: 1, color: "#ffffff", fontSize: fontSize.small, fontWeight: "600" }}>{running.stage || "正在生成建议"}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="取消生成建议" onPress={onCancel} style={state => ({ paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.full, backgroundColor: withAlpha("#ffffff", state.pressed ? 0.3 : 0.2) })}>
        <Text style={{ color: "#ffffff", fontSize: fontSize.meta, fontWeight: "700" }}>取消</Text>
      </Pressable>
    </View> : <Pressable accessibilityRole="button" accessibilityLabel={cta} disabled={pending || t.reports < 2} onPress={onSuggest}
      style={state => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.sm, height: 38, paddingHorizontal: space.lg, borderRadius: radius.full,
        backgroundColor: "#ffffff", opacity: t.reports < 2 ? 0.55 : state.pressed || pending ? 0.8 : 1 })}>
      <Icon name="Lightbulb" size={16} color="#0E7490" />
      <Text style={{ color: "#0E7490", fontSize: fontSize.body, fontWeight: "800" }}>{pending ? "正在发起…" : cta}</Text>
    </Pressable>}
    {!running && t.reports < 2 ? <Text style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta }}>至少需要 2 份报告才能写建议</Text> : null}
  </View>;
}

function EvidenceList({ theme, refs, evidence, onOpenReport }: { theme: PluginTheme; refs: readonly string[]; evidence: Record<string, SuggestionEvidence>; onOpenReport: OpenReport }) {
  const known = refs.map(ref => evidence[ref]).filter((item): item is SuggestionEvidence => !!item);
  if (!known.length) return null;
  return <View style={{ gap: 4 }}>
    {known.slice(0, 6).map((item, index) => <Pressable key={`${index}:${item.jobId}:${item.findingId}`} accessibilityRole="button" accessibilityLabel={`查看依据：${item.agentTitle}，${item.title}`}
      onPress={() => onOpenReport({ jobId: item.jobId, agentId: item.agentId })}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 5, paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: state.pressed ? theme.colors.surface2 : "transparent" })}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: hue(theme, item.severity ? severityLooks[item.severity].hue : "cyan") }} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.meta }}>
        <Text style={{ fontWeight: "700" }}>{item.findingId ? item.title : `整份报告：${item.title}`}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{` · ${item.projectName ? `${item.projectName} · ` : ""}${item.agentTitle}`}</Text>
      </Text>
      <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
    </Pressable>)}
    {known.length > 6 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: space.sm }}>还有 {known.length - 6} 条依据</Text> : null}
  </View>;
}

function ActionCard({ theme, compact, job, action, index, onOpenReport, onFeedback, onHandoff, pending }: { theme: PluginTheme; compact: boolean; job: SuggestionJob; action: SuggestionAction; index: number; onOpenReport: OpenReport;
  onFeedback: (status: ActionFeedback["status"]) => void; onHandoff: () => void; pending: boolean }) {
  const { colors } = theme, dark = isDarkTheme(theme), toast = useToast();
  const status = job.feedback?.[action.id]?.status ?? "open", closed = status === "done" || status === "dismissed";
  const [open, setOpen] = useState(index === 0 && !closed);
  const impact = impactLooks[action.impact], scope = scopeLooks[action.scope], main = hue(theme, impact.hue);
  const copy = async (text: string, what: string) => { try { await copyText(text); toast.show(`${what}已复制`, { variant: "success" }); } catch { toast.error("复制失败"); } };
  return <View style={[{ borderRadius: 16, borderWidth: 1, borderColor: withAlpha(main, closed ? 0.12 : dark ? 0.35 : 0.25), overflow: "hidden", opacity: closed ? 0.62 : 1 },
    closed ? null : gradient(theme, [withAlpha(main, dark ? 0.16 : 0.08), withAlpha(main, 0)], { angle: 160 })]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "收起" : "展开"}建议 ${action.title}`} aria-expanded={open} onPress={() => setOpen(!open)}
      style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.md, opacity: state.pressed ? 0.8 : 1 })}>
      <View style={[{ width: 28, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center" }, gradient(theme, [impact.hue, impact.hue === "pink" ? "orange" : impact.hue === "violet" ? "blue" : "gray"], { angle: 135 })]}>
        <Text style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "900" }}>{index + 1}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "800", lineHeight: 21, textDecorationLine: status === "dismissed" ? "line-through" : "none" }}>{action.title}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <Badge theme={theme} label={impact.label} tone={impact.hue} solid={action.impact === "high"} />
          <Badge theme={theme} label={effortNames[action.effort]} tone="cyan" />
          <Badge theme={theme} label={scope.label} tone="violet" icon={scope.icon} />
          {status !== "open" ? <Badge theme={theme} label={feedbackLooks[status].label} tone={feedbackLooks[status].hue} icon={feedbackLooks[status].icon} /> : null}
        </View>
        {!open ? <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{action.why}</Text> : null}
      </View>
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
    </Pressable>
    {open ? <View style={{ gap: space.md, paddingHorizontal: space.md, paddingBottom: space.md, paddingLeft: space.md + 28 + space.md }}>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{action.why}</Text>
      {action.steps.length ? <View style={{ gap: 4 }}>{action.steps.map((step, stepIndex) => <View key={stepIndex} style={{ flexDirection: "row", gap: space.sm }}>
        <Text style={{ width: 16, color: hue(theme, impact.hue, "text"), fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{stepIndex + 1}</Text>
        <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{step}</Text>
      </View>)}</View> : null}
      {action.instruction ? <View style={{ gap: space.xs, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: withAlpha(hue(theme, "violet"), 0.3), backgroundColor: withAlpha(hue(theme, "violet"), dark ? 0.1 : 0.05) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Icon name="ScrollText" size={13} color={hue(theme, "violet")} />
          <Text style={{ flex: 1, color: hue(theme, "violet", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>可以写进 AGENTS.md / CLAUDE.md</Text>
        </View>
        <ClampText theme={theme} text={action.instruction} lines={compact ? 8 : 6} compact={compact} style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 18, fontFamily: monoFont }} />
      </View> : null}
      {action.projects.length ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>涉及项目：{action.projects.join("、")}</Text> : null}
      <EvidenceList theme={theme} refs={action.evidence} evidence={job.evidence ?? {}} onOpenReport={onOpenReport} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {action.instruction ? <Button theme={theme} size="sm" icon="Copy" label="复制指令" tone="violet" onPress={() => void copy(action.instruction!, "指令")} /> : null}
        {action.task || action.scope === "code" || action.scope === "tooling" || action.scope === "project" ? <Button theme={theme} size="sm" icon="Rocket" label="交给 Agent" tone="pink" onPress={onHandoff} /> : null}
        {action.task ? <Button theme={theme} size="sm" variant="ghost" icon="ClipboardCopy" label="复制任务" onPress={() => void copy(action.task!, "任务")} /> : null}
      </View>
      <Segmented theme={theme} size="sm" value={status} accessibilityLabel={`建议 ${index + 1} 的处理状态`} onChange={next => { if (!pending) onFeedback(next); }}
        options={[{ value: "open", label: "待处理" }, { value: "adopted", label: "采纳" }, { value: "done", label: "已完成" }, { value: "dismissed", label: "忽略" }]} />
    </View> : null}
  </View>;
}

/** Model prose folds to a few lines (fewer characters fit a phone line); the toggle only shows when the text is likely to overflow. */
function ClampText({ theme, text, lines, compact, style }: { theme: PluginTheme; text: string; lines: number; compact: boolean; style: TextStyle }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * (compact ? 22 : 80);
  return <View style={{ gap: 2 }}>
    <Text selectable numberOfLines={long && !open ? lines : undefined} style={style}>{text}</Text>
    {long ? <Pressable accessibilityRole="button" aria-expanded={open} onPress={() => setOpen(!open)} hitSlop={6} style={state => ({ alignSelf: "flex-start", paddingVertical: 2, opacity: state.pressed ? 0.7 : 1 })}>
      <Text style={{ color: hue(theme, "cyan", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>{open ? "收起" : "展开全文"}</Text>
    </Pressable> : null}
  </View>;
}

function Themes({ theme, job, compact, onOpenReport }: { theme: PluginTheme; job: SuggestionJob; compact: boolean; onOpenReport: OpenReport }) {
  const themes = job.report?.themes ?? [];
  if (!themes.length) return null;
  return <Card theme={theme} title="反复出现的问题" icon="Radar" color="orange">
    <View style={{ gap: space.sm }}>
      {themes.map(item => { const category = categoryLooks[item.category], trend = trendLooks[item.trend];
        return <View key={item.id} style={{ gap: 6, padding: space.md, borderRadius: radius.lg, borderLeftWidth: 3, borderLeftColor: hue(theme, category.hue), backgroundColor: withAlpha(hue(theme, category.hue), isDarkTheme(theme) ? 0.08 : 0.05) }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Icon name={category.icon} size={14} color={hue(theme, category.hue)} />
            <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{item.title}</Text>
            <Badge theme={theme} label={trend.label} tone={trend.hue} icon={trend.icon} />
            <Badge theme={theme} label={`${severityLooks[item.severity].label}优先级`} tone={severityLooks[item.severity].hue} />
          </View>
          {item.detail ? <ClampText theme={theme} text={item.detail} lines={compact ? 4 : 3} compact={compact} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }} /> : null}
          <EvidenceList theme={theme} refs={item.evidence} evidence={job.evidence ?? {}} onOpenReport={onOpenReport} />
        </View>; })}
    </View>
  </Card>;
}

function Notes({ theme, title, icon, color, items }: { theme: PluginTheme; title: string; icon: string; color: Hue; items: readonly string[] }) {
  if (!items.length) return null;
  return <Card theme={theme} title={title} icon={icon} color={color} style={{ flexGrow: 1, flexBasis: 300 }}>
    <View style={{ gap: space.sm }}>{items.map((item, index) => <View key={index} style={{ flexDirection: "row", gap: space.sm }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 7, backgroundColor: hue(theme, color) }} />
      <Text selectable style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{item}</Text>
    </View>)}</View>
  </Card>;
}

/** Day of a past suggestion run, with the time when the same day has more than one. */
function historyLabel(item: SuggestionSummary, history: readonly SuggestionSummary[]): string {
  const day = (value: string) => new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  const shared = history.some(other => other.id !== item.id && other.status === "completed" && day(other.createdAt) === day(item.createdAt));
  return shared ? `${day(item.createdAt)} ${new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : day(item.createdAt);
}

function Suggestions({ theme, compact, overview, job, history, onSelect, loading, onOpenReport, agents, onSelectAgent }: { theme: PluginTheme; compact: boolean; overview: InsightOverview; job: SuggestionJob | null | undefined;
  history: readonly SuggestionSummary[]; onSelect: (jobId: string) => void; loading: boolean; onOpenReport: OpenReport; agents: readonly AgentRecord[]; onSelectAgent: (agentId: string) => void }) {
  const { feedback } = useSuggestionActions();
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [handoff, setHandoff] = useState<SuggestionAction | null>(null);
  if (loading && !job) return <Skeleton theme={theme} rows={4} />;
  if (!job?.report) return <Card theme={theme} title="建议" icon="Lightbulb" color="amber">
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>
      {overview.totals.reports >= 2 ? "让分析模型读一遍最近的报告，找出跨 Agent 反复出现的问题，给出可以直接动手的改进：该写进说明的规则、该调整的流程、值得交给 Agent 去修的地方。" : "积累到 2 份以上的分析报告后，就能生成跨 Agent 的改进建议。"}
    </Text>
  </Card>;
  const report = job.report, status = (id: string) => job.feedback?.[id]?.status ?? "open";
  const openCount = report.actions.filter(action => status(action.id) === "open" || status(action.id) === "adopted").length;
  const shown = filter === "open" ? report.actions.filter(action => status(action.id) === "open" || status(action.id) === "adopted") : report.actions;
  return <>
    <Card theme={theme} title="建议" icon="Lightbulb" color="amber" trailing={<Segmented theme={theme} size="sm" value={filter} onChange={setFilter} accessibilityLabel="建议筛选"
      options={[{ value: "open", label: `待处理 ${openCount}` }, { value: "all", label: `全部 ${report.actions.length}` }]} />}>
      <ClampText theme={theme} text={report.summary} lines={compact ? 5 : 4} compact={compact} style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }} />
      {shown.length ? <View style={{ gap: space.sm }}>{shown.map(action => <ActionCard key={action.id} theme={theme} compact={compact} job={job} action={action} index={report.actions.indexOf(action)} onOpenReport={onOpenReport}
        pending={feedback.isPending} onHandoff={() => setHandoff(action)} onFeedback={next => feedback.mutate({ jobId: job.id, actionId: action.id, status: next })} />)}</View>
        : <EmptyState theme={theme} icon="PartyPopper" tone="green" title="建议都处理完了" message="切到「全部」查看已完成和忽略的建议" />}
      {feedback.error ? <Banner theme={theme} tone="danger" message={`状态保存失败：${feedback.error.message}`} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{job.runner.label} · 读了 {job.window.reports} 份报告 · {relativeTime(job.updatedAt)}</Text>
        {history.filter(item => item.status === "completed").length > 1 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {history.filter(item => item.status === "completed").slice(0, 5).map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`查看 ${new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })} 的建议`} aria-pressed={item.id === job.id}
            onPress={() => onSelect(item.id)} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, borderWidth: 1, borderColor: item.id === job.id ? hue(theme, "amber") : theme.colors.border }}>
            <Text style={{ color: item.id === job.id ? hue(theme, "amber", "text") : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>{historyLabel(item, history)}</Text>
          </Pressable>)}
        </View> : null}
      </View>
    </Card>
    <Themes theme={theme} job={job} compact={compact} onOpenReport={onOpenReport} />
    {report.wins.length || report.watch.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      <Notes theme={theme} title="做得好的" icon="Trophy" color="green" items={report.wins} />
      <Notes theme={theme} title="需要盯住" icon="Eye" color="pink" items={report.watch} />
    </View> : null}
    <HandoffSheet theme={theme} open={!!handoff} action={handoff} agents={agents} onClose={() => setHandoff(null)}
      onCreated={agentId => { if (handoff && status(handoff.id) === "open") feedback.mutate({ jobId: job.id, actionId: handoff.id, status: "adopted" }); onSelectAgent(agentId); }} />
  </>;
}

function HealthChart({ theme, overview }: { theme: PluginTheme; overview: InsightOverview }) {
  const h = overview.health, total = h.healthy + h.watch + h.blocked;
  const colors = [hue(theme, "green"), hue(theme, "amber"), hue(theme, "red")];
  return <Card theme={theme} title="报告健康度" icon="HeartPulse" color="green" style={{ flexGrow: 1, flexBasis: 320 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      {(["healthy", "watch", "blocked"] as const).map((key, index) => <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors[index] }} />
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{healthLooks[key].label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, fontVariant: ["tabular-nums"] }}>{h[key]}{total ? ` · ${percent(h[key] / total)}` : ""}</Text>
      </View>)}
    </View>
    <StackedColumns theme={theme} height={120} colors={colors} names={["健康", "值得关注", "存在阻塞"]} format={value => `${value} 份`} labelEvery={overview.days > 7 ? 5 : 1}
      columns={overview.daily.map(day => ({ label: dayLabel(day.day), parts: [day.healthy, day.watch, day.blocked], detail: `${dayLabel(day.day)}：健康 ${day.healthy}，关注 ${day.watch}，阻塞 ${day.blocked}` }))} />
  </Card>;
}

function Categories({ theme, overview }: { theme: PluginTheme; overview: InsightOverview }) {
  const max = Math.max(1, ...overview.categories.map(row => row.high + row.medium + row.low));
  return <Card theme={theme} title="问题类型" icon="Shapes" color="violet" style={{ flexGrow: 1, flexBasis: 320 }}>
    <View style={{ gap: space.md }}>
      {overview.categories.map(row => { const look = categoryLooks[row.category], all = row.high + row.medium + row.low;
        return <View key={row.category} style={{ gap: 5 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name={look.icon} size={14} color={hue(theme, look.hue)} />
            <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{look.label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{all} 个 · 待处理 {row.open}{row.resolved ? ` · 已解决 ${row.resolved}` : ""}</Text>
          </View>
          <View style={{ flexDirection: "row", height: 8, borderRadius: 4, backgroundColor: trackFor(theme), overflow: "hidden" }}>
            {(["high", "medium", "low"] as const).map(level => row[level] ? <View key={level} style={{ width: `${row[level] / max * 100}%`, backgroundColor: hue(theme, level === "low" ? look.hue : severityLooks[level].hue), opacity: level === "low" ? 0.45 : 1 }} /> : null)}
          </View>
        </View>; })}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>条形按严重程度着色：红 高 · 琥珀 中 · 浅色 低</Text>
    </View>
  </Card>;
}

function AttentionList({ theme, overview, onOpenReport }: { theme: PluginTheme; overview: InsightOverview; onOpenReport: OpenReport }) {
  if (!overview.agents.length && !overview.findings.length) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
    {overview.findings.length ? <Card theme={theme} title="待处理的问题" icon="ListTodo" color="pink" style={{ flexGrow: 1, flexBasis: 320 }}>
      <View>{overview.findings.map(item => <Pressable key={`${item.jobId}:${item.findingId}`} accessibilityRole="button" accessibilityLabel={`查看问题 ${item.title}，${item.agentTitle}`}
        onPress={() => onOpenReport({ jobId: item.jobId, agentId: item.agentId })}
        style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme), opacity: state.pressed ? 0.7 : 1 })}>
        <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: hue(theme, severityLooks[item.severity].hue) }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600", lineHeight: 19 }}>{item.title}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{categoryLooks[item.category].label} · {item.agentTitle} · {item.projectName}</Text>
        </View>
      </Pressable>)}</View>
    </Card> : null}
    {overview.agents.length ? <Card theme={theme} title="需要关注的 Agent" icon="Bot" color="blue" style={{ flexGrow: 1, flexBasis: 320 }}>
      <View>{overview.agents.map(item => <Pressable key={item.agentId} accessibilityRole="button" accessibilityLabel={`查看 ${item.title} 的报告`} onPress={() => onOpenReport({ jobId: item.lastJobId, agentId: item.agentId })}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme), opacity: state.pressed ? 0.7 : 1 })}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hue(theme, item.health ? healthLooks[item.health].hue : "gray") }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{item.title}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{item.projectName} · {item.reports} 份报告 · {relativeTime(item.lastAt)}</Text>
        </View>
        {item.openFindings ? <Badge theme={theme} label={`${item.openFindings} 待处理`} tone={item.highOpen ? "red" : "amber"} /> : <Badge theme={theme} label="已处理" tone="green" />}
      </Pressable>)}</View>
    </Card> : null}
  </View>;
}

/** 智能分析 → 总览: what the recent reports add up to, and what to change. */
export function InsightsOverview({ theme, compact, agents, header, onOpenReport, onOpenSettings, onNewAnalysis, onSelectAgent }: { theme: PluginTheme; compact: boolean; agents: readonly AgentRecord[];
  header?: ReactNode; onOpenReport: OpenReport; onOpenSettings: () => void; onNewAnalysis: () => void; onSelectAgent: (agentId: string) => void }) {
  const [days, setDays] = useState<OverviewDays>(7);
  const [pickedSuggestion, setPickedSuggestion] = useState<string | undefined>(undefined);
  const overview = useInsightOverview(days, true);
  const data = overview.data?.data;
  const suggestions = useInsightSuggestions(pickedSuggestion, !!data?.suggestions);
  const { suggest, cancel } = useSuggestionActions();
  const running = data?.suggestionJob && busy(data.suggestionJob.status) ? data.suggestionJob : null;
  const failed = data?.suggestionJob && ["failed", "skipped"].includes(data.suggestionJob.status) && data.suggestionJob.id !== data.suggestions?.id ? data.suggestionJob : null;
  const t = data?.totals;
  const resolvedShare = t && t.openFindings + t.resolvedFindings ? t.resolvedFindings / (t.openFindings + t.resolvedFindings) : null;
  const info = useMemo(() => [
    "总览汇总所选时间内完成的分析报告：健康度、问题类型、待处理的问题和需要关注的 Agent，都按你在报告里标记的状态（仍存在 / 已解决 / 误判）统计。",
    "「生成建议」让当前分析模型读一遍这些报告，找出跨 Agent 反复出现的问题，给出可以直接动手的改进；每条建议都注明依据，点开可以跳到对应报告。",
    "开启自动分析后，每积累 3 份新报告（与上次自动建议间隔至少 20 小时）会自动更新建议。",
    "「交给 Agent」会在所选项目的工作区用所选 Profile 新建一个 Agent 执行任务，开始前可以修改任务内容。",
  ], []);
  if (!data) return overview.isPending ? <View style={{ padding: space.lg }}><Skeleton theme={theme} rows={6} /></View>
    : <EmptyState theme={theme} icon={overview.error ? "WifiOff" : "Sparkles"} tone={overview.error ? "danger" : "teal"} title={overview.error ? "总览暂时读不到" : "还没有分析数据"} message={overview.error?.message} action={{ label: "重试", onPress: () => void overview.refetch(), icon: "RefreshCw" }} />;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: compact ? space.md : space.lg, paddingBottom: space.xxl, gap: space.lg }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      {header}
      <Segmented theme={theme} size="sm" value={String(days) as "7" | "30"} onChange={value => { setDays(Number(value) as OverviewDays); setPickedSuggestion(undefined); }} accessibilityLabel="总览范围" options={[{ value: "7", label: "7 天" }, { value: "30", label: "30 天" }]} />
      <View style={{ flex: 1 }} />
      {!compact ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>更新于 {relativeTime(data.generatedAt)}</Text> : null}
      <InfoButton theme={theme} title="关于总览" lines={info} />
      <IconButton theme={theme} icon="Settings2" label="分析设置" onPress={onOpenSettings} />
    </View>
    {!data.autoEnabled ? <Banner theme={theme} tone="info" message="自动分析已关闭：新报告只在你手动分析时产生，建议也不会自动更新" action={{ label: "设置", onPress: onOpenSettings }} /> : null}
    <Hero theme={theme} overview={data} suggestion={data.suggestions} running={running} narrow={compact} pending={suggest.isPending} onSettings={onOpenSettings}
      onSuggest={() => suggest.mutate({ days }, { onSuccess: () => setPickedSuggestion(undefined) })} onCancel={() => { if (running) cancel.mutate(running.id); }} />
    {suggest.error ? <Banner theme={theme} tone="danger" message={suggest.error.message} /> : null}
    {failed ? <Banner theme={theme} tone={failed.status === "failed" ? "danger" : "warning"} message={`上次生成建议${failed.status === "failed" ? "失败" : "跳过"}：${failed.error ?? failed.stage}`} /> : null}
    {t && t.reports ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <Tile theme={theme} label="分析报告" value={String(t.reports)} sub={`${t.agents} 个 Agent · ${t.projects} 个项目`} icon="FileText" colors={["teal", "cyan"]} />
      <Tile theme={theme} label="待处理问题" value={String(t.openFindings)} sub={t.highOpen ? `其中高优先级 ${t.highOpen}` : "没有高优先级问题"} icon="CircleAlert" colors={t.highOpen ? ["red", "pink"] : ["amber", "orange"]} />
      <Tile theme={theme} label="已解决" value={String(t.resolvedFindings)} sub={resolvedShare !== null ? `解决率 ${percent(resolvedShare)}${t.dismissedFindings ? ` · 误判 ${t.dismissedFindings}` : ""}` : "在报告里标记已解决"} icon="CircleCheckBig" colors={["green", "lime"]} ring={resolvedShare} />
      <Tile theme={theme} label="存在阻塞" value={String(data.health.blocked)} sub={`值得关注 ${data.health.watch} · 健康 ${data.health.healthy}`} icon="Siren" colors={data.health.blocked ? ["red", "orange"] : ["violet", "fuchsia"]} />
    </View> : <EmptyState theme={theme} icon="Sparkles" tone="teal" title={`近 ${days} 天还没有分析报告`} message={data.autoEnabled ? "成熟的任务结束后会自动分析；也可以现在挑一个会话分析" : "打开自动分析，或挑一个会话手动分析"}
      action={data.autoEnabled ? { label: "新建分析", onPress: onNewAnalysis, icon: "Plus" } : { label: "打开自动分析", onPress: onOpenSettings, icon: "Zap" }} />}
    <Suggestions theme={theme} compact={compact} overview={data} job={suggestions.data?.job} history={suggestions.data?.history ?? []} loading={suggestions.isPending && !!data.suggestions} onSelect={setPickedSuggestion}
      onOpenReport={onOpenReport} agents={agents} onSelectAgent={onSelectAgent} />
    {t && t.reports ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      <HealthChart theme={theme} overview={data} />
      <Categories theme={theme} overview={data} />
    </View> : null}
    <AttentionList theme={theme} overview={data} onOpenReport={onOpenReport} />
    {data.projects.length > 1 ? <Card theme={theme} title="项目" icon="FolderGit2" color="cyan">
      <View>{data.projects.map(item => <View key={item.name} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{item.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{item.reports} 份报告</Text>
        {item.blocked ? <Badge theme={theme} label={`阻塞 ${item.blocked}`} tone="red" /> : null}
        <Badge theme={theme} label={`待处理 ${item.openFindings}`} tone={item.highOpen ? "red" : item.openFindings ? "amber" : "green"} />
      </View>)}</View>
    </Card> : null}
    {overview.error ? <Banner theme={theme} tone="warning" message={`总览同步失败，显示的是上次结果：${overview.error.message}`} action={{ label: "重试", onPress: () => void overview.refetch() }} /> : null}
  </ScrollView>;
}
