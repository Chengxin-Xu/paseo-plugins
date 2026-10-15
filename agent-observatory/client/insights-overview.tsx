import { currentLanguage } from "../shared/i18n";
import { joinList } from "../shared/i18n";
import { t } from "../shared/text";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { suggestionWindowNote, type ActionFeedback, type FindingCategory, type FindingSeverity, type InsightOverview, type OverviewDays, type SuggestionAction, type SuggestionEvidence, type SuggestionJob,
  type SuggestionSummary, type SuggestionTheme } from "../shared/insight-overview";
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
  failure: { get label() { return t("coreInsightsOverview.errorsAndFailures"); }, hue: "red", icon: "CircleX" }, loop: { get label() { return t("coreInsightsOverview.repetitionAndLoops"); }, hue: "orange", icon: "Repeat" },
  efficiency: { get label() { return t("coreInsightsOverview.executionEfficiency"); }, hue: "amber", icon: "Gauge" }, coordination: { get label() { return t("coreInsightsOverview.taskCoordination"); }, hue: "violet", icon: "Network" },
  quality: { get label() { return t("coreInsightsOverview.deliveryQuality"); }, hue: "blue", icon: "BadgeCheck" },
};
export const severityLooks: Record<FindingSeverity, { label: string; hue: Hue }> = { high: { get label() { return t("coreInsightsOverview.high"); }, hue: "red" }, medium: { get label() { return t("coreInsightsOverview.medium"); }, hue: "amber" }, low: { get label() { return t("coreInsightsOverview.low"); }, hue: "gray" } };
const healthLooks = { healthy: { get label() { return t("coreInsightsOverview.healthy"); }, hue: "green" as Hue }, watch: { get label() { return t("coreInsightsOverview.worthWatching"); }, hue: "amber" as Hue }, blocked: { get label() { return t("coreInsightsOverview.blocked"); }, hue: "red" as Hue } };
const scopeLooks: Record<SuggestionAction["scope"], { label: string; icon: string }> = {
  instructions: { get label() { return t("coreInsightsOverview.addInstructions"); }, icon: "ScrollText" }, workflow: { get label() { return t("coreInsightsOverview.adjustWorkflow"); }, icon: "Workflow" }, profile: { get label() { return t("coreInsightsOverview.updateProfile"); }, icon: "SlidersHorizontal" },
  project: { get label() { return t("coreInsightsOverview.projectConfiguration"); }, icon: "FolderCog" }, code: { get label() { return t("coreInsightsOverview.changeCode"); }, icon: "Code" }, tooling: { get label() { return t("coreInsightsOverview.addTools"); }, icon: "Wrench" },
};
const impactLooks: Record<SuggestionAction["impact"], { label: string; hue: Hue }> = { high: { get label() { return t("coreInsightsOverview.highImpact"); }, hue: "pink" }, medium: { get label() { return t("coreInsightsOverview.mediumImpact"); }, hue: "violet" }, low: { get label() { return t("coreInsightsOverview.lowImpact"); }, hue: "gray" } };
const effortNames: Record<SuggestionAction["effort"], string> = { get small() { return t("coreInsightsOverview.smallChange"); }, get medium() { return t("coreInsightsOverview.moderateEffort"); }, get large() { return t("coreInsightsOverview.largeProject"); } };
const trendLooks: Record<SuggestionTheme["trend"], { label: string; hue: Hue; icon: string }> = {
  new: { get label() { return t("coreInsightsOverview.new"); }, hue: "pink", icon: "Sparkle" }, recurring: { get label() { return t("coreInsightsOverview.recurring"); }, hue: "orange", icon: "Repeat" }, improving: { get label() { return t("coreInsightsOverview.improving"); }, hue: "green", icon: "TrendingDown" },
};
const feedbackLooks: Record<Exclude<ActionFeedback["status"], "open">, { label: string; hue: Hue; icon: string }> = {
  adopted: { get label() { return t("coreInsightsOverview.accepted"); }, hue: "teal", icon: "ThumbsUp" }, done: { get label() { return t("coreInsightsOverview.completed"); }, hue: "green", icon: "CircleCheckBig" }, dismissed: { get label() { return t("coreInsightsOverview.ignored"); }, hue: "gray", icon: "EyeOff" },
};
const busy = (status?: string) => status === "queued" || status === "collecting" || status === "analyzing";
const dayLabel = (day: string) => t("coreInsightsOverview.dayLabel", { month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) });

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
  const { totals, health: h } = overview;
  if (!totals.reports) return t("coreInsightsOverview.noAnalysisReportsInTheLastDays", { value1: overview.days });
  const parts = [t("coreInsightsOverview.reportsCoverAgents", { count: totals.reports, value2: totals.agents })];
  if (h.blocked) parts.push(t("coreInsightsOverview.reportsShowBlockers", { value1: h.blocked }));
  parts.push(totals.openFindings ? t("coreInsightsOverview.issuesNeedAttention", { value1: totals.openFindings }) : t("coreInsightsOverview.noIssuesNeedAttention"));
  return parts.join(t("coreInsightsOverview.message"));
}

function Hero({ theme, overview, suggestion, running, narrow, onSuggest, onCancel, pending, onSettings }: { theme: PluginTheme; overview: InsightOverview; suggestion: SuggestionSummary | null; running: SuggestionSummary | null;
  narrow: boolean; onSuggest: () => void; onCancel: () => void; pending: boolean; onSettings: () => void }) {
  const totals = overview.totals, fresh = overview.reportsSinceSuggestions;
  const headline = suggestion?.headline ?? fallbackHeadline(overview);
  const cta = !suggestion ? t("coreInsightsOverview.generateSuggestions") : fresh ? t("coreInsightsOverview.updateSuggestionsNewReports", { value1: fresh }) : t("coreInsightsOverview.regenerateSuggestions");
  return <View style={[{ borderRadius: 20, padding: space.lg, gap: space.md, overflow: "hidden" }, gradient(theme, ["#14B8A6", "#06B6D4", "#8B5CF6"], { angle: 125 })]}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Icon name="Sparkles" size={15} color="#ffffff" />
      <Text style={{ flex: 1, color: withAlpha("#ffffff", 0.9), fontSize: fontSize.small, fontWeight: "700" }}>{t("coreInsightsOverview.analysisOverviewLastDays", { value1: overview.days })}</Text>
      {suggestion ? <Text style={{ color: withAlpha("#ffffff", 0.8), fontSize: 11 }}>{t("coreInsightsOverview.suggestionsWritten", { value1: relativeTime(suggestion.updatedAt) })}</Text> : null}
    </View>
    <Text style={{ color: "#ffffff", fontSize: narrow ? fontSize.heading : 22, lineHeight: narrow ? 26 : 30, fontWeight: "800" }}>{headline}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <GlassPill label={overview.autoEnabled ? t("coreInsightsOverview.automaticAnalysisOn") : t("coreInsightsOverview.automaticAnalysisOff")} icon={overview.autoEnabled ? "Zap" : "PauseCircle"} onPress={onSettings} />
      <GlassPill label={overview.runnerLabel} icon="Bot" onPress={onSettings} />
      <GlassPill label={t("coreInsightsOverview.reports")} value={totals.reports} icon="FileText" />
      {totals.tokens ? <GlassPill label={t("coreInsightsOverview.analysisUsage")} value={bigNumber(totals.tokens)} icon="Coins" /> : null}
    </View>
    {running ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha("#000000", 0.18) }}>
      <Spinner size={16} color="#ffffff" />
      <Text numberOfLines={2} style={{ flex: 1, color: "#ffffff", fontSize: fontSize.small, fontWeight: "600" }}>{running.stage || t("coreInsightsOverview.generatingSuggestions")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("coreInsightsOverview.cancelSuggestionGeneration")} onPress={onCancel} style={state => ({ paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.full, backgroundColor: withAlpha("#ffffff", state.pressed ? 0.3 : 0.2) })}>
        <Text style={{ color: "#ffffff", fontSize: fontSize.meta, fontWeight: "700" }}>{t("coreInsightsOverview.cancel")}</Text>
      </Pressable>
    </View> : <Pressable accessibilityRole="button" accessibilityLabel={cta} disabled={pending || totals.reports < 2} onPress={onSuggest}
      style={state => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.sm, height: 38, paddingHorizontal: space.lg, borderRadius: radius.full,
        backgroundColor: "#ffffff", opacity: totals.reports < 2 ? 0.55 : state.pressed || pending ? 0.8 : 1 })}>
      <Icon name="Lightbulb" size={16} color="#0E7490" />
      <Text style={{ color: "#0E7490", fontSize: fontSize.body, fontWeight: "800" }}>{pending ? t("coreInsightsOverview.starting") : cta}</Text>
    </Pressable>}
    {!running && totals.reports < 2 ? <Text style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta }}>{t("coreInsightsOverview.atLeast2ReportsAreNeededTo")}</Text> : null}
  </View>;
}

function EvidenceList({ theme, refs, evidence, onOpenReport }: { theme: PluginTheme; refs: readonly string[]; evidence: Record<string, SuggestionEvidence>; onOpenReport: OpenReport }) {
  const known = refs.map(ref => evidence[ref]).filter((item): item is SuggestionEvidence => !!item);
  if (!known.length) return null;
  return <View style={{ gap: 4 }}>
    {known.slice(0, 6).map((item, index) => <Pressable key={`${index}:${item.jobId}:${item.findingId}`} accessibilityRole="button" accessibilityLabel={t("coreInsightsOverview.viewEvidence", { value1: item.agentTitle, value2: item.title })}
      onPress={() => onOpenReport({ jobId: item.jobId, agentId: item.agentId })}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 5, paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: state.pressed ? theme.colors.surface2 : "transparent" })}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: hue(theme, item.severity ? severityLooks[item.severity].hue : "cyan") }} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.meta }}>
        <Text style={{ fontWeight: "700" }}>{item.findingId ? item.title : t("coreInsightsOverview.fullReport", { value1: item.title })}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{` · ${item.projectName ? `${item.projectName} · ` : ""}${item.agentTitle}`}</Text>
      </Text>
      <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
    </Pressable>)}
    {known.length > 6 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: space.sm }}>{t("coreInsightsOverview.moreEvidenceItems", { count: known.length - 6 })}</Text> : null}
  </View>;
}

function ActionCard({ theme, compact, job, action, index, onOpenReport, onFeedback, onHandoff, pending }: { theme: PluginTheme; compact: boolean; job: SuggestionJob; action: SuggestionAction; index: number; onOpenReport: OpenReport;
  onFeedback: (status: ActionFeedback["status"]) => void; onHandoff: () => void; pending: boolean }) {
  const { colors } = theme, dark = isDarkTheme(theme), toast = useToast();
  const status = job.feedback?.[action.id]?.status ?? "open", closed = status === "done" || status === "dismissed";
  const [open, setOpen] = useState(index === 0 && !closed);
  const impact = impactLooks[action.impact], scope = scopeLooks[action.scope], main = hue(theme, impact.hue);
  const copy = async (text: string, what: string) => { try { await copyText(text); toast.show(t("coreInsightsOverview.copied", { value1: what }), { variant: "success" }); } catch { toast.error(t("coreInsightsOverview.couldNotCopy")); } };
  return <View style={[{ borderRadius: 16, borderWidth: 1, borderColor: withAlpha(main, closed ? 0.12 : dark ? 0.35 : 0.25), overflow: "hidden", opacity: closed ? 0.62 : 1 },
    closed ? null : gradient(theme, [withAlpha(main, dark ? 0.16 : 0.08), withAlpha(main, 0)], { angle: 160 })]}>
    <Pressable accessibilityRole="button" accessibilityLabel={t("coreInsightsOverview.suggestion", { value1: open ? t("coreInsightsOverview.collapse") : t("coreInsightsOverview.expand"), value2: action.title })} aria-expanded={open} onPress={() => setOpen(!open)}
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
          <Text style={{ flex: 1, color: hue(theme, "violet", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>{t("coreInsightsOverview.canBeAddedToAgentsMdClaude")}</Text>
        </View>
        <ClampText theme={theme} text={action.instruction} lines={compact ? 8 : 6} compact={compact} style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 18, fontFamily: monoFont }} />
      </View> : null}
      {action.projects.length ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreInsightsOverview.projects", { value1: joinList(action.projects) })}</Text> : null}
      <EvidenceList theme={theme} refs={action.evidence} evidence={job.evidence ?? {}} onOpenReport={onOpenReport} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {action.instruction ? <Button theme={theme} size="sm" icon="Copy" label={t("coreInsightsOverview.copyInstructions")} tone="violet" onPress={() => void copy(action.instruction!, t("coreInsightsOverview.instructions"))} /> : null}
        {action.task || action.scope === "code" || action.scope === "tooling" || action.scope === "project" ? <Button theme={theme} size="sm" icon="Rocket" label={t("coreInsightsOverview.assignToAgent")} tone="pink" onPress={onHandoff} /> : null}
        {action.task ? <Button theme={theme} size="sm" variant="ghost" icon="ClipboardCopy" label={t("coreInsightsOverview.copyTask")} onPress={() => void copy(action.task!, t("coreInsightsOverview.task"))} /> : null}
      </View>
      <Segmented theme={theme} size="sm" value={status} accessibilityLabel={t("coreInsightsOverview.statusOfSuggestion", { value1: index + 1 })} onChange={next => { if (!pending) onFeedback(next); }}
        options={[{ value: "open", label: t("coreInsightsOverview.open") }, { value: "adopted", label: t("coreInsightsOverview.accept") }, { value: "done", label: t("coreInsightsOverview.completed") }, { value: "dismissed", label: t("coreInsightsOverview.ignore") }]} />
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
      <Text style={{ color: hue(theme, "cyan", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>{open ? t("coreInsightsOverview.collapse") : t("coreInsightsOverview.expandFullText")}</Text>
    </Pressable> : null}
  </View>;
}

function Themes({ theme, job, compact, onOpenReport }: { theme: PluginTheme; job: SuggestionJob; compact: boolean; onOpenReport: OpenReport }) {
  const themes = job.report?.themes ?? [];
  if (!themes.length) return null;
  return <Card theme={theme} title={t("coreInsightsOverview.recurringIssues")} icon="Radar" color="orange">
    <View style={{ gap: space.sm }}>
      {themes.map(item => { const category = categoryLooks[item.category], trend = trendLooks[item.trend];
        return <View key={item.id} style={{ gap: 6, padding: space.md, borderRadius: radius.lg, borderLeftWidth: 3, borderLeftColor: hue(theme, category.hue), backgroundColor: withAlpha(hue(theme, category.hue), isDarkTheme(theme) ? 0.08 : 0.05) }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Icon name={category.icon} size={14} color={hue(theme, category.hue)} />
            <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{item.title}</Text>
            <Badge theme={theme} label={trend.label} tone={trend.hue} icon={trend.icon} />
            <Badge theme={theme} label={t("coreInsightsOverview.priority", { value1: severityLooks[item.severity].label })} tone={severityLooks[item.severity].hue} />
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
  const day = (value: string) => new Date(value).toLocaleDateString(currentLanguage(), { month: "numeric", day: "numeric" });
  const shared = history.some(other => other.id !== item.id && other.status === "completed" && day(other.createdAt) === day(item.createdAt));
  return shared ? `${day(item.createdAt)} ${new Date(item.createdAt).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit", hour12: false })}` : day(item.createdAt);
}

function Suggestions({ theme, compact, overview, job, history, onSelect, loading, onOpenReport, agents, onSelectAgent }: { theme: PluginTheme; compact: boolean; overview: InsightOverview; job: SuggestionJob | null | undefined;
  history: readonly SuggestionSummary[]; onSelect: (jobId: string) => void; loading: boolean; onOpenReport: OpenReport; agents: readonly AgentRecord[]; onSelectAgent: (agentId: string) => void }) {
  const { feedback } = useSuggestionActions();
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [handoff, setHandoff] = useState<SuggestionAction | null>(null);
  if (loading && !job) return <Skeleton theme={theme} rows={4} />;
  if (!job?.report) return <Card theme={theme} title={t("coreInsightsOverview.suggestions")} icon="Lightbulb" color="amber">
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>
      {overview.totals.reports >= 2 ? t("coreInsightsOverview.askTheAnalysisModelToReadRecent") : t("coreInsightsOverview.withAtLeast2AnalysisReportsYou")}
    </Text>
  </Card>;
  const report = job.report, status = (id: string) => job.feedback?.[id]?.status ?? "open";
  // A set read in UTC days (written before any device reported its zone, or by an older version) says so (grok-F3).
  const zoneNote = suggestionWindowNote(job.window);
  const openCount = report.actions.filter(action => status(action.id) === "open" || status(action.id) === "adopted").length;
  const shown = filter === "open" ? report.actions.filter(action => status(action.id) === "open" || status(action.id) === "adopted") : report.actions;
  return <>
    <Card theme={theme} title={t("coreInsightsOverview.suggestions")} icon="Lightbulb" color="amber" trailing={<Segmented theme={theme} size="sm" value={filter} onChange={setFilter} accessibilityLabel={t("coreInsightsOverview.suggestionFilter")}
      options={[{ value: "open", label: t("coreInsightsOverview.open2", { value1: openCount }) }, { value: "all", label: t("coreInsightsOverview.all", { value1: report.actions.length }) }]} />}>
      <ClampText theme={theme} text={report.summary} lines={compact ? 5 : 4} compact={compact} style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }} />
      {shown.length ? <View style={{ gap: space.sm }}>{shown.map(action => <ActionCard key={action.id} theme={theme} compact={compact} job={job} action={action} index={report.actions.indexOf(action)} onOpenReport={onOpenReport}
        pending={feedback.isPending} onHandoff={() => setHandoff(action)} onFeedback={next => feedback.mutate({ jobId: job.id, actionId: action.id, status: next })} />)}</View>
        : <EmptyState theme={theme} icon="PartyPopper" tone="green" title={t("coreInsightsOverview.allSuggestionsHandled")} message={t("coreInsightsOverview.switchToAllToViewCompletedAnd")} />}
      {feedback.error ? <Banner theme={theme} tone="danger" message={t("coreInsightsOverview.couldNotSaveStatus", { value1: feedback.error.message })} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreInsightsOverview.readReports", { value1: job.runner.label, value2: job.window.reports, value3: relativeTime(job.updatedAt) })}</Text>
        {zoneNote ? <Badge theme={theme} label={zoneNote} tone="amber" icon="Globe" /> : null}
        {history.filter(item => item.status === "completed").length > 1 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {history.filter(item => item.status === "completed").slice(0, 5).map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={t("coreInsightsOverview.viewSuggestionsFrom", { value1: new Date(item.createdAt).toLocaleString(currentLanguage(), { hour12: false }) })} aria-pressed={item.id === job.id}
            onPress={() => onSelect(item.id)} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, borderWidth: 1, borderColor: item.id === job.id ? hue(theme, "amber") : theme.colors.border }}>
            <Text style={{ color: item.id === job.id ? hue(theme, "amber", "text") : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>{historyLabel(item, history)}</Text>
          </Pressable>)}
        </View> : null}
      </View>
    </Card>
    <Themes theme={theme} job={job} compact={compact} onOpenReport={onOpenReport} />
    {report.wins.length || report.watch.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      <Notes theme={theme} title={t("coreInsightsOverview.whatWentWell")} icon="Trophy" color="green" items={report.wins} />
      <Notes theme={theme} title={t("coreInsightsOverview.whatToWatch")} icon="Eye" color="pink" items={report.watch} />
    </View> : null}
    <HandoffSheet theme={theme} open={!!handoff} action={handoff} agents={agents} onClose={() => setHandoff(null)}
      onCreated={agentId => { if (handoff && status(handoff.id) === "open") feedback.mutate({ jobId: job.id, actionId: handoff.id, status: "adopted" }); onSelectAgent(agentId); }} />
  </>;
}

function HealthChart({ theme, overview }: { theme: PluginTheme; overview: InsightOverview }) {
  const h = overview.health, total = h.healthy + h.watch + h.blocked;
  const colors = [hue(theme, "green"), hue(theme, "amber"), hue(theme, "red")];
  return <Card theme={theme} title={t("coreInsightsOverview.reportHealth")} icon="HeartPulse" color="green" style={{ flexGrow: 1, flexBasis: 320 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      {(["healthy", "watch", "blocked"] as const).map((key, index) => <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors[index] }} />
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{healthLooks[key].label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, fontVariant: ["tabular-nums"] }}>{h[key]}{total ? ` · ${percent(h[key] / total)}` : ""}</Text>
      </View>)}
    </View>
    <StackedColumns theme={theme} height={120} colors={colors} names={[t("coreInsightsOverview.healthy"), t("coreInsightsOverview.worthWatching"), t("coreInsightsOverview.blocked")]} format={value => t("coreInsightsOverview.reports2", { count: value })} labelEvery={overview.days > 7 ? 5 : 1}
      columns={overview.daily.map(day => ({ label: dayLabel(day.day), parts: [day.healthy, day.watch, day.blocked], detail: t("coreInsightsOverview.healthyWatchBlocked", { value1: dayLabel(day.day), value2: day.healthy, value3: day.watch, value4: day.blocked }) }))} />
  </Card>;
}

function Categories({ theme, overview }: { theme: PluginTheme; overview: InsightOverview }) {
  const max = Math.max(1, ...overview.categories.map(row => row.high + row.medium + row.low));
  return <Card theme={theme} title={t("coreInsightsOverview.issueCategories")} icon="Shapes" color="violet" style={{ flexGrow: 1, flexBasis: 320 }}>
    <View style={{ gap: space.md }}>
      {overview.categories.map(row => { const look = categoryLooks[row.category], all = row.high + row.medium + row.low;
        return <View key={row.category} style={{ gap: 5 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name={look.icon} size={14} color={hue(theme, look.hue)} />
            <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{look.label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{t("coreInsightsOverview.issuesOpen", { value1: all, value2: row.open, value3: row.resolved ? t("coreInsightsOverview.resolved", { value1: row.resolved }) : "" })}</Text>
          </View>
          <View style={{ flexDirection: "row", height: 8, borderRadius: 4, backgroundColor: trackFor(theme), overflow: "hidden" }}>
            {(["high", "medium", "low"] as const).map(level => row[level] ? <View key={level} style={{ width: `${row[level] / max * 100}%`, backgroundColor: hue(theme, level === "low" ? look.hue : severityLooks[level].hue), opacity: level === "low" ? 0.45 : 1 }} /> : null)}
          </View>
        </View>; })}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("coreInsightsOverview.barsAreColoredBySeverityRedHigh")}</Text>
    </View>
  </Card>;
}

function AttentionList({ theme, overview, onOpenReport }: { theme: PluginTheme; overview: InsightOverview; onOpenReport: OpenReport }) {
  if (!overview.agents.length && !overview.findings.length) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
    {overview.findings.length ? <Card theme={theme} title={t("coreInsightsOverview.openIssues")} icon="ListTodo" color="pink" style={{ flexGrow: 1, flexBasis: 320 }}>
      <View>{overview.findings.map(item => <Pressable key={`${item.jobId}:${item.findingId}`} accessibilityRole="button" accessibilityLabel={t("coreInsightsOverview.viewIssue", { value1: item.title, value2: item.agentTitle })}
        onPress={() => onOpenReport({ jobId: item.jobId, agentId: item.agentId })}
        style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme), opacity: state.pressed ? 0.7 : 1 })}>
        <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: hue(theme, severityLooks[item.severity].hue) }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600", lineHeight: 19 }}>{item.title}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{categoryLooks[item.category].label} · {item.agentTitle} · {item.projectName}</Text>
        </View>
      </Pressable>)}</View>
    </Card> : null}
    {overview.agents.length ? <Card theme={theme} title={t("coreInsightsOverview.agentsNeedingAttention")} icon="Bot" color="blue" style={{ flexGrow: 1, flexBasis: 320 }}>
      <View>{overview.agents.map(item => <Pressable key={item.agentId} accessibilityRole="button" accessibilityLabel={t("coreInsightsOverview.viewReportsFor", { value1: item.title })} onPress={() => onOpenReport({ jobId: item.lastJobId, agentId: item.agentId })}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme), opacity: state.pressed ? 0.7 : 1 })}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hue(theme, item.health ? healthLooks[item.health].hue : "gray") }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{item.title}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("coreInsightsOverview.reports3", { value1: item.projectName, value2: item.reports, value3: relativeTime(item.lastAt) })}</Text>
        </View>
        {item.openFindings ? <Badge theme={theme} label={t("coreInsightsOverview.open3", { value1: item.openFindings })} tone={item.highOpen ? "red" : "amber"} /> : <Badge theme={theme} label={t("coreInsightsOverview.handled")} tone="green" />}
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
  const totals = data?.totals;
  const resolvedShare = totals && totals.openFindings + totals.resolvedFindings ? totals.resolvedFindings / (totals.openFindings + totals.resolvedFindings) : null;
  const info = useMemo(() => [
    t("coreInsightsOverview.theOverviewSummarizesCompletedAnalysisReportsIn"),
    t("coreInsightsOverview.value7DaysAnd30DaysUseLocal"),
    t("coreInsightsOverview.generateSuggestionsAsksTheCurrentAnalysisModel"),
    t("coreInsightsOverview.withAutomaticAnalysisEnabledSuggestionsUpdateAfter"),
    t("coreInsightsOverview.assignToAgentCreatesAnAgentUsing"),
  ], []);
  if (!data) return overview.isPending ? <View style={{ padding: space.lg }}><Skeleton theme={theme} rows={6} /></View>
    : <EmptyState theme={theme} icon={overview.error ? "WifiOff" : "Sparkles"} tone={overview.error ? "danger" : "teal"} title={overview.error ? t("coreInsightsOverview.overviewIsTemporarilyUnavailable") : t("coreInsightsOverview.noAnalysisDataYet")} message={overview.error?.message} action={{ label: t("coreInsightsOverview.retry"), onPress: () => void overview.refetch(), icon: "RefreshCw" }} />;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: compact ? space.md : space.lg, paddingBottom: space.xxl, gap: space.lg }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      {header}
      <Segmented theme={theme} size="sm" value={String(days) as "7" | "30"} onChange={value => { setDays(Number(value) as OverviewDays); setPickedSuggestion(undefined); }} accessibilityLabel={t("coreInsightsOverview.overviewRange")} options={[{ value: "7", label: t("coreInsightsOverview.value7Days") }, { value: "30", label: t("coreInsightsOverview.value30Days") }]} />
      <View style={{ flex: 1 }} />
      {!compact ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreInsightsOverview.updated", { value1: relativeTime(data.generatedAt) })}</Text> : null}
      <InfoButton theme={theme} title={t("coreInsightsOverview.aboutTheOverview")} lines={info} />
      <IconButton theme={theme} icon="Settings2" label={t("coreInsightsOverview.analysisSettings")} onPress={onOpenSettings} />
    </View>
    {!data.autoEnabled ? <Banner theme={theme} tone="info" message={t("coreInsightsOverview.automaticAnalysisIsOffNewReportsRequire")} action={{ label: t("coreInsightsOverview.settings"), onPress: onOpenSettings }} /> : null}
    <Hero theme={theme} overview={data} suggestion={data.suggestions} running={running} narrow={compact} pending={suggest.isPending} onSettings={onOpenSettings}
      onSuggest={() => suggest.mutate({ days }, { onSuccess: () => setPickedSuggestion(undefined) })} onCancel={() => { if (running) cancel.mutate(running.id); }} />
    {suggest.error ? <Banner theme={theme} tone="danger" message={suggest.error.message} /> : null}
    {failed ? <Banner theme={theme} tone={failed.status === "failed" ? "danger" : "warning"} message={t("coreInsightsOverview.lastSuggestionGeneration", { value1: failed.status === "failed" ? t("coreInsightsOverview.failed") : t("coreInsightsOverview.wasSkipped"), value2: failed.error ?? failed.stage })} /> : null}
    {totals && totals.reports ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <Tile theme={theme} label={t("coreInsightsOverview.analysisReports")} value={String(totals.reports)} sub={t("coreInsightsOverview.agentsProjects", { count: totals.agents, value2: totals.projects })} icon="FileText" colors={["teal", "cyan"]} />
      <Tile theme={theme} label={t("coreInsightsOverview.openIssues2")} value={String(totals.openFindings)} sub={totals.highOpen ? t("coreInsightsOverview.highPriority", { value1: totals.highOpen }) : t("coreInsightsOverview.noHighPriorityIssues")} icon="CircleAlert" colors={totals.highOpen ? ["red", "pink"] : ["amber", "orange"]} />
      <Tile theme={theme} label={t("coreInsightsOverview.resolved2")} value={String(totals.resolvedFindings)} sub={resolvedShare !== null ? t("coreInsightsOverview.resolutionRate", { value1: percent(resolvedShare), value2: totals.dismissedFindings ? t("coreInsightsOverview.falsePositives", { value1: totals.dismissedFindings }) : "" }) : t("coreInsightsOverview.markResolvedInAReport")} icon="CircleCheckBig" colors={["green", "lime"]} ring={resolvedShare} />
      <Tile theme={theme} label={t("coreInsightsOverview.blocked")} value={String(data.health.blocked)} sub={t("coreInsightsOverview.worthWatchingHealthy", { value1: data.health.watch, value2: data.health.healthy })} icon="Siren" colors={data.health.blocked ? ["red", "orange"] : ["violet", "fuchsia"]} />
    </View> : <EmptyState theme={theme} icon="Sparkles" tone="teal" title={t("coreInsightsOverview.noAnalysisReportsInTheLastDays", { value1: days })} message={data.autoEnabled ? t("coreInsightsOverview.substantialTasksAreAnalyzedAutomaticallyWhenThey") : t("coreInsightsOverview.enableAutomaticAnalysisOrChooseASession")}
      action={data.autoEnabled ? { label: t("coreInsightsOverview.newAnalysis"), onPress: onNewAnalysis, icon: "Plus" } : { label: t("coreInsightsOverview.enableAutomaticAnalysis"), onPress: onOpenSettings, icon: "Zap" }} />}
    <Suggestions theme={theme} compact={compact} overview={data} job={suggestions.data?.job} history={suggestions.data?.history ?? []} loading={suggestions.isPending && !!data.suggestions} onSelect={setPickedSuggestion}
      onOpenReport={onOpenReport} agents={agents} onSelectAgent={onSelectAgent} />
    {totals && totals.reports ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      <HealthChart theme={theme} overview={data} />
      <Categories theme={theme} overview={data} />
    </View> : null}
    <AttentionList theme={theme} overview={data} onOpenReport={onOpenReport} />
    {data.projects.length > 1 ? <Card theme={theme} title={t("coreInsightsOverview.projects2")} icon="FolderGit2" color="cyan">
      <View>{data.projects.map(item => <View key={item.name} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{item.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{t("coreInsightsOverview.reports4", { count: item.reports })}</Text>
        {item.blocked ? <Badge theme={theme} label={t("coreInsightsOverview.blocked2", { value1: item.blocked })} tone="red" /> : null}
        <Badge theme={theme} label={t("coreInsightsOverview.open2", { value1: item.openFindings })} tone={item.highOpen ? "red" : item.openFindings ? "amber" : "green"} />
      </View>)}</View>
    </Card> : null}
    {overview.error ? <Banner theme={theme} tone="warning" message={t("coreInsightsOverview.overviewSyncFailedShowingThePreviousResult", { value1: overview.error.message })} action={{ label: t("coreInsightsOverview.retry"), onPress: () => void overview.refetch() }} /> : null}
  </ScrollView>;
}
