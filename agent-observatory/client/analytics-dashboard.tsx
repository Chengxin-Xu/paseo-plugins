import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { buildHourlyHeatmap, coveredDuration, sumActivityMetrics, type ActivityMetrics, type AnalyticsSnapshot, type HourlyHeatmapCell, type UsageSample } from "../shared/analytics";
import { formatTokens, type AgentRecord } from "../shared/model";
import { Banner, Chip, Divider, EmptyState, MetaLine, ProjectMark, Row, Segmented, Sheet, Skeleton, Spacer, fontSize, formatDuration, hairline, hue, hueFor, radius, relativeTime, space } from "./kit";
import { ChoiceList, InfoButton, StatRow } from "./ui";
import { useAnalytics } from "./use-analytics";
import { isForeground } from "./use-foreground";
import { Grow } from "./motion";

interface AnalyticsDashboardProps {
  theme: PluginTheme; hostId?: string; compact: boolean; agents: AgentRecord[]; analytics?: AnalyticsSnapshot; loading?: boolean; error?: string;
  onSelectAgent: (agentId: string) => void; onSelectProject: (projectId: string) => void;
}
type HeatMetric = "eventCount" | "outputTokens" | "failed";
const metricNames: Record<HeatMetric, string> = { eventCount: "执行事件", outputTokens: "输出快照", failed: "失败次数" };
const readableDate = (iso: string) => iso.slice(5, 10).replace("-", "/");
const percent = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const hour = (value: number) => String(value).padStart(2, "0");
/** Data marks only: one hue at an opacity step, over the surface. */
function alpha(color: string, opacity: number): string {
  const hex = /^#([0-9a-f]{3})$/i.test(color) ? `#${color.slice(1).split("").map(c => c + c).join("")}` : color;
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, "0")}` : color;
}

function Section({ theme, title, trailing, children }: { theme: PluginTheme; title: string; trailing?: ReactNode; children: ReactNode }) {
  return <View style={{ gap: space.md }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{title}</Text>
      {trailing}
    </View>
    {children}
  </View>;
}
function Detail({ theme, title, lines }: { theme: PluginTheme; title: string; lines: readonly (string | null | false | undefined)[] }) {
  return <View accessibilityLiveRegion="polite" style={{ gap: 2, minHeight: 38 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{title}</Text>
    <MetaLine theme={theme} numberOfLines={2} parts={lines} />
  </View>;
}
function Swatch({ theme, color, label, outline = false }: { theme: PluginTheme; color: string; label: string; outline?: boolean }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 1 }}>
    <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: outline ? "transparent" : color, borderWidth: outline ? hairline : 0, borderColor: theme.colors.foregroundMuted }} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{label}</Text>
  </View>;
}

function Heatmap({ theme, analytics, compact, now, days = 7 }: { theme: PluginTheme; analytics: AnalyticsSnapshot; compact: boolean; now: number; days?: number }) {
  const { colors } = theme;
  const [metric, setMetric] = useState<HeatMetric>("eventCount");
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const cells = useMemo(() => buildHourlyHeatmap(analytics.hours, { now, startedAt: analytics.startedAt, metric, days, coverageIntervals: analytics.coverageIntervals ?? [] }), [analytics, metric, now, days]);
  const maximum = Math.max(1, ...cells.map(cell => cell.value ?? 0));
  const peak = cells.reduce<HourlyHeatmapCell | null>((best, cell) => (cell.value ?? 0) > (best?.value ?? 0) ? cell : best, null);
  const active = cells.find(cell => cell.bucketStart === selected) ?? null;
  // Activity is green, output violet, failures red — each metric keeps its own colour ramp.
  const mark = hue(theme, metric === "failed" ? "red" : metric === "outputTokens" ? "violet" : "green");
  const fill = (cell: HourlyHeatmapCell) => cell.value === null ? "transparent" : cell.value === 0 ? colors.surface2 : alpha(mark, 0.22 + Math.sqrt(cell.value / maximum) * 0.78);
  const gap = 3, labelWidth = 40;
  // Phones read the week like a calendar: days across, hours down, so nothing scrolls sideways.
  const columns = compact ? days : 24, rows = compact ? 24 : days;
  const cellWidth = Math.max(8, (width - labelWidth - (columns - 1) * gap) / columns);
  const cellHeight = compact ? 14 : Math.min(18, Math.max(12, cellWidth * 0.6));
  const cellAt = (row: number, column: number) => compact ? cells[column * 24 + row] : cells[row * 24 + column];
  const rowLabel = (row: number) => compact ? (row % 3 === 0 ? hour(row) : "") : readableDate(cells[row * 24]?.day ?? "");
  const columnLabel = (column: number) => compact ? readableDate(cells[column * 24]?.day ?? "") : column % 3 === 0 ? hour(column) : "";
  const shown = active ?? peak;
  return <Section theme={theme} title="活跃时段" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="热力图指标" options={(Object.keys(metricNames) as HeatMetric[]).map(value => ({ value, label: metricNames[value] }))} />}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap }}>
      <View style={{ flexDirection: "row", gap, paddingLeft: labelWidth }}>
        {Array.from({ length: columns }, (_, column) => <Text key={column} numberOfLines={1} style={{ width: cellWidth, color: colors.foregroundMuted, fontSize: 11, textAlign: compact ? "center" : "left", fontVariant: ["tabular-nums"] }}>{columnLabel(column)}</Text>)}
      </View>
      {width > 0 ? Array.from({ length: rows }, (_, row) => <View key={row} style={{ flexDirection: "row", alignItems: "center", gap }}>
        <Text numberOfLines={1} style={{ width: labelWidth - gap, color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{rowLabel(row)}</Text>
        {Array.from({ length: columns }, (_, column) => {
          const cell = cellAt(row, column);
          if (!cell) return <View key={column} style={{ width: cellWidth, height: cellHeight }} />;
          const isSelected = selected === cell.bucketStart;
          return <Pressable key={cell.bucketStart} accessibilityRole="button" accessibilityLabel={`${cell.day} ${cell.hour} 时 UTC，${metricNames[metric]} ${cell.value === null ? "无观测数据" : cell.value}`} accessibilityState={{ selected: isSelected }} onPress={() => setSelected(cell.bucketStart)}
            style={state => ({ width: cellWidth, height: cellHeight, borderRadius: 3, backgroundColor: fill(cell), borderWidth: isSelected ? 1.5 : cell.value === null ? hairline : 0, borderColor: isSelected ? colors.foreground : colors.border, opacity: state.pressed ? 0.7 : cell.coverage === "partial" ? 0.6 : 1 })} />;
        })}
      </View>) : <View style={{ height: rows * (cellHeight + gap) }} />}
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>少</Text>
        {[0.22, 0.45, 0.7, 1].map(step => <View key={step} style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: alpha(mark, step) }} />)}
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>多</Text>
      </View>
      <Swatch theme={theme} color={colors.border} label="未采集" outline />
    </View>
    {shown ? <Detail theme={theme} title={`${active ? "" : "高峰 · "}${shown.day} · ${hour(shown.hour)}:00–${hour((shown.hour + 1) % 24)}:00 UTC`}
      lines={shown.value === null ? [shown.isFuture ? "这个时间段尚未到来。" : !shown.observed ? "这个时间段没有在线采集覆盖，不能视为没有执行。" : "该时段未收到 provider 用量快照。"]
        : [`事件 ${shown.metrics?.eventCount ?? 0}`, `完成 ${shown.metrics?.completed ?? 0} / 失败 ${shown.metrics?.failed ?? 0}`, `输出峰值 ${formatTokens(shown.metrics?.outputTokens)}`, shown.coveredMs === null ? null : `在线 ${formatDuration(shown.coveredMs)}${shown.coverage === "partial" ? "（部分）" : ""}`]} /> : null}
    {metric === "outputTokens" ? <MetaLine theme={theme} numberOfLines={2} parts={["颜色表示提供方报告的输出 tokens 快照峰值，非该小时累计消耗。"]} /> : null}
  </Section>;
}

function DailyChart({ theme, analytics, now, dayCount = 28 }: { theme: PluginTheme; analytics: AnalyticsSnapshot; now: number; dayCount?: number }) {
  const { colors } = theme;
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const days = useMemo(() => {
    const dayMs = 86_400_000, end = Math.floor(now / dayMs) * dayMs;
    const buckets = new Map(analytics.days.map(bucket => [bucket.bucketStart.slice(0, 10), bucket]));
    return Array.from({ length: dayCount }, (_, index) => {
      const at = end - (dayCount - 1 - index) * dayMs, day = new Date(at).toISOString().slice(0, 10);
      const coveredMs = coveredDuration(analytics.coverageIntervals ?? [], at, Math.min(at + dayMs, now));
      return { day, observed: coveredMs > 0, coveredMs, bucket: buckets.get(day) };
    });
  }, [analytics, now, dayCount]);
  const total = (bucket?: { completed: number; failed: number; canceled: number }) => (bucket?.completed ?? 0) + (bucket?.failed ?? 0) + (bucket?.canceled ?? 0);
  const peak = Math.max(1, ...days.map(({ bucket }) => total(bucket)));
  const plot = 128, headroom = 20, columnWidth = width ? width / dayCount : 0, barWidth = Math.max(4, Math.min(16, columnWidth * 0.5));
  const success = hue(theme, "green"), danger = hue(theme, "red"), neutral = hue(theme, "gray");
  const active = days.find(day => day.day === selected) ?? days.at(-1)!;
  const labelEvery = dayCount <= 7 ? 1 : columnWidth >= 30 ? 2 : 7;
  return <Section theme={theme} title="每日结果" trailing={<View style={{ flexDirection: "row", gap: space.md }}><Swatch theme={theme} color={success} label="完成" /><Swatch theme={theme} color={danger} label="失败" /><Swatch theme={theme} color={neutral} label="取消" /></View>}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: plot, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: headroom - 8, flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{peak}</Text>
          <View style={{ flex: 1, height: hairline, backgroundColor: colors.border }} />
        </View>
        {columnWidth ? days.map(({ day, observed, bucket }, dayIndex) => {
          const segments = [[bucket?.canceled ?? 0, neutral], [bucket?.failed ?? 0, danger], [bucket?.completed ?? 0, success]] as const;
          const visible = segments.filter(([value]) => value > 0);
          return <Pressable key={day} accessibilityRole="button" accessibilityLabel={`${day} UTC，${observed ? `完成 ${bucket?.completed ?? 0}，失败 ${bucket?.failed ?? 0}，取消 ${bucket?.canceled ?? 0}` : "未观测"}`} accessibilityState={{ selected: active.day === day }} onPress={() => setSelected(day)}
            style={state => ({ width: columnWidth, height: plot, alignItems: "center", justifyContent: "flex-end", borderRadius: radius.sm, backgroundColor: active.day === day ? colors.surface1 : state.pressed ? colors.surface1 : "transparent" })}>
            {visible.length ? <Grow delay={dayIndex * 14} style={{ alignItems: "center" }}>{visible.map(([value, color], index) => <View key={index} style={{ width: barWidth, height: Math.max(2, value / peak * (plot - headroom)), marginTop: index ? 2 : 0, backgroundColor: color, borderTopLeftRadius: index === 0 ? 4 : 0, borderTopRightRadius: index === 0 ? 4 : 0 }} />)}</Grow>
              : <View style={{ width: barWidth, height: 2, backgroundColor: observed ? colors.surface2 : "transparent" }} />}
          </Pressable>;
        }) : null}
      </View>
      <View style={{ flexDirection: "row", paddingTop: space.xs }}>
        {columnWidth ? days.map(({ day }, index) => <View key={day} style={{ width: columnWidth, alignItems: "center", overflow: "visible" }}>
          {(dayCount - 1 - index) % labelEvery === 0 ? <Text numberOfLines={1} style={{ width: 44, textAlign: "center", color: active.day === day ? colors.foreground : colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{readableDate(day)}</Text> : null}
        </View>) : null}
      </View>
    </View>
    <Detail theme={theme} title={`${active.day} UTC`} lines={active.observed ? [`完成 ${active.bucket?.completed ?? 0}`, `失败 ${active.bucket?.failed ?? 0}`, `取消 ${active.bucket?.canceled ?? 0}`, `执行 ${formatDuration(active.bucket?.runMs ?? 0)}`, `在线 ${formatDuration(active.coveredMs)}`] : ["尚未开始观测，不能推断为零次执行。"]} />
  </Section>;
}

interface ProjectGroup { key: string; id: string | null; name: string; agentIds: Set<string>; worktrees: Set<string>; metrics: ActivityMetrics; samples: UsageSample[] }
function ProjectRanking({ theme, analytics, agents, onSelectProject }: { theme: PluginTheme; analytics: AnalyticsSnapshot; agents: AgentRecord[]; onSelectProject: (id: string) => void }) {
  const { colors } = theme;
  const [metric, setMetric] = useState<"activity" | "tokens">("activity");
  const groups = useMemo(() => {
    const known = new Map(agents.map(agent => [agent.id, agent]));
    const latest = new Map<string, UsageSample>();
    for (const sample of analytics.usage) { const previous = latest.get(sample.agentId); if (!previous || Date.parse(sample.at) > Date.parse(previous.at)) latest.set(sample.agentId, sample); }
    const result = new Map<string, ProjectGroup>();
    for (const agent of analytics.agents) {
      const record = known.get(agent.agentId);
      const id = record?.projectId ?? agent.projectId, name = record?.projectName ?? agent.projectName ?? "未关联项目";
      const key = id ?? agent.projectRootPath ?? `unknown:${name}`;
      const group = result.get(key) ?? { key, id, name, agentIds: new Set<string>(), worktrees: new Set<string>(), metrics: sumActivityMetrics([]), samples: [] };
      group.agentIds.add(agent.agentId);
      if (record?.checkoutKind === "worktree" && record.worktreePath) group.worktrees.add(record.worktreePath);
      group.metrics = sumActivityMetrics([group.metrics, agent]);
      const sample = latest.get(agent.agentId); if (sample) group.samples.push(sample);
      result.set(key, group);
    }
    return [...result.values()].map(group => {
      const inputs = group.samples.filter(sample => valid(sample.inputTokens)), outputs = group.samples.filter(sample => valid(sample.outputTokens));
      const pairs = group.samples.filter(sample => valid(sample.inputTokens) && valid(sample.cachedTokens) && sample.inputTokens > 0 && sample.cachedTokens <= sample.inputTokens);
      const pairedInput = pairs.reduce((sum, sample) => sum + sample.inputTokens!, 0);
      return { ...group, input: inputs.length ? inputs.reduce((sum, sample) => sum + sample.inputTokens!, 0) : null, output: outputs.length ? outputs.reduce((sum, sample) => sum + sample.outputTokens!, 0) : null,
        cacheRatio: pairedInput ? pairs.reduce((sum, sample) => sum + sample.cachedTokens!, 0) / pairedInput : null };
    }).sort((a, b) => (metric === "tokens" ? (b.output ?? -1) - (a.output ?? -1) : b.metrics.eventCount - a.metrics.eventCount) || a.name.localeCompare(b.name));
  }, [analytics, agents, metric]);
  const peak = Math.max(1, ...groups.map(group => metric === "tokens" ? group.output ?? 0 : group.metrics.eventCount));
  return <Section theme={theme} title="项目" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="项目排序" options={[{ value: "activity", label: "按事件" }, { value: "tokens", label: "按输出" }]} />}>
    {groups.length ? <View style={{ marginHorizontal: -space.md }}>{groups.slice(0, 12).map((group, rank) => {
      const value = metric === "tokens" ? group.output : group.metrics.eventCount;
      return <Pressable key={group.key} accessibilityRole="button" accessibilityLabel={`查看项目 ${group.name}`} accessibilityState={{ disabled: !group.id }} disabled={!group.id} onPress={() => group.id && onSelectProject(group.id)}
        style={state => ({ gap: space.xs + 2, paddingVertical: 10, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent" })}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ProjectMark theme={theme} name={group.name} size={18} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{group.name}</Text>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontVariant: ["tabular-nums"] }}>{metric === "tokens" ? formatTokens(value) : value?.toLocaleString() ?? "—"}</Text>
        </View>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}><Grow axis="x" delay={rank * 40} style={{ height: 4, width: `${Math.max(0, (value ?? 0) / peak * 100)}%`, borderRadius: 2, backgroundColor: hue(theme, hueFor(group.name)) }} /></View>
        <MetaLine theme={theme} parts={[`${group.agentIds.size} 个 Agent`, group.worktrees.size ? `${group.worktrees.size} 个 worktree` : null, `完成 ${group.metrics.completed}`, group.metrics.failed ? `失败 ${group.metrics.failed}` : null, `输入 ${formatTokens(group.input)}`, `输出 ${formatTokens(group.output)}`, group.cacheRatio !== null ? `缓存 ${percent(group.cacheRatio)}` : null]} />
      </Pressable>;
    })}</View> : <MetaLine theme={theme} parts={["项目运行后，执行结果与用量会逐步形成画像"]} />}
    {groups.length > 12 ? <MetaLine theme={theme} parts={["只显示前 12 个项目"]} /> : null}
  </Section>;
}

function UsageSnapshots({ theme, analytics, agents, onSelectAgent }: { theme: PluginTheme; analytics: AnalyticsSnapshot; agents: AgentRecord[]; onSelectAgent: (id: string) => void }) {
  const known = new Map(agents.map(agent => [agent.id, agent]));
  const latest = new Map<string, UsageSample>();
  for (const sample of analytics.usage) if (!latest.has(sample.agentId)) latest.set(sample.agentId, sample);
  return <Section theme={theme} title="最近用量快照">
    {latest.size ? <View style={{ marginHorizontal: -space.md }}>{[...latest.values()].slice(0, 6).map(sample => {
      const record = known.get(sample.agentId);
      const ratio = valid(sample.inputTokens) && valid(sample.cachedTokens) && sample.inputTokens > 0 && sample.cachedTokens <= sample.inputTokens ? sample.cachedTokens / sample.inputTokens : null;
      return <Row key={sample.id} theme={theme} title={record?.title ?? sample.agentId} titleLines={1} accessibilityLabel={`查看用量 Agent ${record?.title ?? sample.agentId}`} onPress={() => onSelectAgent(sample.agentId)}
        trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(sample.at)}</Text>}
        subtitle={<MetaLine theme={theme} parts={[record?.projectName ?? "项目待关联", sample.provider, `输入 ${formatTokens(sample.inputTokens)}`, `输出 ${formatTokens(sample.outputTokens)}`, ratio !== null ? `缓存 ${percent(ratio)}` : null]} />} />;
    })}</View> : <MetaLine theme={theme} parts={["还没有 provider 用量报告"]} />}
  </Section>;
}

export function AnalyticsDashboard({ theme, hostId = "local", compact, agents, analytics: hostAnalytics, loading: hostLoading, error: hostError, onSelectAgent, onSelectProject }: AnalyticsDashboardProps) {
  const [now, setNow] = useState(Date.now());
  const [width, setWidth] = useState(0);
  const [projectId, setProjectId] = useState("all");
  const [projectSheet, setProjectSheet] = useState(false);
  const [period, setPeriod] = useState<"7" | "28">("28");
  const projectQuery = useAnalytics(hostId, projectId !== "all", projectId === "all" ? undefined : projectId);
  const analytics = projectId === "all" ? hostAnalytics : projectQuery.data;
  const loading = projectId === "all" ? hostLoading : projectQuery.isPending;
  const error = projectId === "all" ? hostError : projectQuery.error?.message;
  const projectOptions = useMemo(() => [...new Map([...agents.map(agent => [agent.projectId, agent.projectName] as const), ...(hostAnalytics?.agents ?? []).map(agent => [agent.projectId, agent.projectName ?? "未关联项目"] as const)].filter((entry): entry is readonly [string, string] => !!entry[0])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [agents, hostAnalytics]);
  useEffect(() => {
    const timer = setInterval(() => { if (isForeground(AppState.currentState)) setNow(Date.now()); }, 60_000);
    const listener = AppState.addEventListener("change", state => { if (state === "active") setNow(Date.now()); });
    return () => { clearInterval(timer); listener.remove(); };
  }, []);
  const days = Number(period);
  const totals = useMemo(() => { const from = Math.floor(now / 86_400_000) * 86_400_000 - (days - 1) * 86_400_000; return sumActivityMetrics((analytics?.days ?? []).filter(day => Date.parse(day.bucketStart) >= from && Date.parse(day.bucketStart) <= now)); }, [analytics, now, days]);
  const success = totals.completed + totals.failed > 0 ? totals.completed / (totals.completed + totals.failed) : null;
  const inset = compact ? space.lg : space.xl, twoColumns = !compact && width >= 900;
  const projectName = projectOptions.find(([id]) => id === projectId)?.[1] ?? "全部项目";
  return <><ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.xl, width: "100%", maxWidth: 1080, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Chip theme={theme} label={projectName} icon="Folder" tone={projectId !== "all" ? hueFor(projectName) : undefined} selected={projectId !== "all"} onPress={() => setProjectSheet(true)} />
        <Segmented theme={theme} size="sm" value={period} onChange={setPeriod} accessibilityLabel="时间范围" options={[{ value: "7", label: "7 天" }, { value: "28", label: "28 天" }]} />
        <Spacer />
        <InfoButton theme={theme} title="关于数据洞察" lines={["图表按 UTC 计时，只累加插件观测到的生命周期事件。", "灰框表示没有在线采集覆盖的时段，不代表没有执行；半透明表示只覆盖了部分时段。", "tokens、缓存与费用只展示提供方报告的快照或峰值，不是累计消耗或账单。", "项目画像覆盖保留历史内的全部数据，不随图表时间范围变化。"]} />
      </View>
      {error ? <Banner theme={theme} tone="danger" message={`数据暂时无法同步：${error}`} /> : null}
      {analytics?.persistenceError ? <Banner theme={theme} tone="warning" message={analytics.persistenceError} /> : null}
      {analytics?.agentsTruncated ? <Banner theme={theme} tone="warning" message="Agent 统计达到保留上限，项目排名只代表保留范围" /> : null}
      {analytics?.projectHistoryTruncated ? <Banner theme={theme} tone="warning" message="项目历史有保留上限，只代表已确认归属的数据" /> : null}
      {!analytics ? loading ? <Skeleton theme={theme} rows={5} /> : <EmptyState theme={theme} icon="ChartNoAxesCombined" title="还没有执行数据" message="插件持续观测后，活跃时段、每日结果和项目画像会出现在这里" /> : <>
        <View style={{ gap: space.xs }}>
          <StatRow theme={theme} size="lg" columns={compact ? 2 : undefined} stats={[{ label: "已完成轮次", value: totals.completed.toLocaleString(), tone: "green" }, { label: "完成率", value: percent(success), tone: "blue" }, { label: "执行耗时", value: formatDuration(totals.runMs) || "0 秒", tone: "violet" }, { label: "等待决策", value: formatDuration(totals.waitMs) || "0 秒", tone: "amber" }]} />
          <MetaLine theme={theme} parts={[`近 ${days} 天`, `失败 ${totals.failed}`, `取消 ${totals.canceled}`]} />
        </View>
        <Divider theme={theme} />
        <Heatmap theme={theme} analytics={analytics} compact={compact} now={now} days={7} />
        <Divider theme={theme} />
        <DailyChart theme={theme} analytics={analytics} now={now} dayCount={days} />
        <Divider theme={theme} />
        <View style={{ flexDirection: twoColumns ? "row" : "column", alignItems: "flex-start", gap: twoColumns ? space.xxl : space.xl }}>
          <View style={{ flex: twoColumns ? 1 : undefined, width: twoColumns ? undefined : "100%", minWidth: 0 }}><ProjectRanking theme={theme} analytics={analytics} agents={projectId === "all" ? agents : agents.filter(agent => agent.projectId === projectId)} onSelectProject={onSelectProject} /></View>
          {!twoColumns ? <View style={{ width: "100%" }}><Divider theme={theme} /></View> : null}
          <View style={{ flex: twoColumns ? 1 : undefined, width: twoColumns ? undefined : "100%", minWidth: 0 }}><UsageSnapshots theme={theme} analytics={analytics} agents={agents} onSelectAgent={onSelectAgent} /></View>
        </View>
        <MetaLine theme={theme} numberOfLines={2} parts={[`观测始于 ${new Date(analytics.startedAt).toLocaleDateString("zh-CN")}`, `最近观测 ${relativeTime(analytics.updatedAt, now)}`, "UTC"]} />
      </>}
    </View>
  </ScrollView>
  <Sheet title="项目" open={projectSheet} onClose={() => setProjectSheet(false)}>
    <ChoiceList theme={theme} value={projectId} onChange={id => { setProjectId(id); setProjectSheet(false); }} options={[{ value: "all", label: "全部项目" }, ...projectOptions.map(([id, name]) => ({ value: id, label: name, leading: <ProjectMark theme={theme} name={name} size={20} /> }))]} />
  </Sheet></>;
}
