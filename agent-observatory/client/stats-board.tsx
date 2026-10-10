import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { StatsDay, StatsMetrics, StatsSnapshot } from "../shared/stats";
import { achievements, averageTurnMs, bigNumber, dayPart, hasContent, level, observedParallelism, peakOf, percent, shortHours, successRate, weekdayForecast, weekdayNames, type Achievement } from "../shared/stats-view";
import { Segmented, Sheet, fontSize, gradient, hue, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { CalendarHeatmap, Card, DeltaChip, Donut, HeatLegend, Punchcard, Ring, Sparkline, TrendChart } from "./charts";
import { GlassPill, IconDisk, StatsGate, StatsHeader, rowHues, trackFor, type StatsViewProps } from "./stats-common";
import { Spinner } from "./status";

export type SessionScopeTarget = "running" | "approval" | "unread" | "idle";
const dayLabel = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const longDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 ${weekdayNames[(new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7]}`;
const greeting = (hour: number) => hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

export interface Tile { key: string; label: string; icon: string; colors: readonly [Hue, Hue]; value: string; sub?: string; current: number; previous: number; invert?: boolean; spark: number[]; ring?: number | null }
function tiles(stats: StatsSnapshot): Tile[] {
  const { totals: t, previous: p, daily } = stats;
  const spark = (pick: (day: StatsDay) => number) => daily.slice(-14).map(pick);
  const rate = successRate(t), previousRate = successRate(p), avg = averageTurnMs(t), par = observedParallelism(daily, t.peakParallel), content = hasContent(t);
  return [
    { key: "sessions", label: "会话", icon: "MessagesSquare", colors: ["blue", "cyan"], value: bigNumber(t.sessions), sub: t.childSessions ? `其中子 Agent ${bigNumber(t.childSessions)}` : undefined, current: t.sessions, previous: p.sessions, spark: spark(day => day.sessions) },
    { key: "turns", label: "对话轮次", icon: "Repeat", colors: ["violet", "fuchsia"], value: bigNumber(t.turns), sub: t.sessions ? `每会话 ${(t.turns / t.sessions).toFixed(1)} 轮` : undefined, current: t.turns, previous: p.turns, spark: spark(day => day.turns) },
    { key: "success", label: "成功率", icon: "CircleCheckBig", colors: ["green", "lime"], value: percent(rate, rate !== null && rate < 0.995 ? 1 : 0), sub: `失败 ${t.failed} · 取消 ${t.canceled}`, current: rate ?? 0, previous: previousRate ?? 0, spark: spark(day => successRate(day) ?? 0), ring: rate },
    { key: "run", label: "工作时长", icon: "Timer", colors: ["pink", "orange"], value: shortHours(t.runMs), sub: avg ? `平均每轮 ${shortHours(avg)}` : undefined, current: t.runMs, previous: p.runMs, spark: spark(day => day.runMs) },
    { key: "busy", label: "并行时长", icon: "Layers", colors: ["orange", "amber"], value: t.busyMs ? shortHours(t.busyMs) : "—", sub: par ? `平均 ${par.toFixed(1)} 个 Agent 同时在跑` : t.busyMs ? undefined : "从插件开始记录后累计", current: t.busyMs, previous: p.busyMs, spark: spark(day => day.busyMs) },
    { key: "tools", label: "工具调用", icon: "Wrench", colors: ["cyan", "teal"], value: content ? bigNumber(t.toolCalls) : "—", sub: t.toolCalls ? `失败率 ${percent(t.toolFailures / t.toolCalls, 1)}` : "下一轮对话后开始统计", current: t.toolCalls, previous: p.toolCalls, spark: spark(day => day.toolCalls) },
    { key: "code", label: "代码行", icon: "FileCode2", colors: ["green", "teal"], value: content ? `+${bigNumber(t.linesAdded)}` : "—", sub: content ? `−${bigNumber(t.linesRemoved)} · ${bigNumber(t.filesChanged)} 个文件` : "下一轮对话后开始统计", current: t.linesAdded, previous: p.linesAdded, spark: spark(day => day.linesAdded) },
    // Wait time is the part that costs you; the approval count is only known since the plugin started counting.
    { key: "approvals", label: "审批等待", icon: "Hand", colors: ["amber", "orange"], value: t.waitMs ? shortHours(t.waitMs) : "0", sub: t.approvals ? `${bigNumber(t.approvals)} 次审批` : t.waitMs ? "Agent 等你审批的总时长" : "没有让 Agent 等你", current: t.waitMs, previous: p.waitMs, invert: true, spark: spark(day => day.waitMs) },
  ];
}

export function KpiTile({ theme, tile, width }: { theme: PluginTheme; tile: Tile; width: `${number}%` }) {
  const { colors } = theme, dark = isDarkTheme(theme), main = hue(theme, tile.colors[0]);
  return <View style={{ width, padding: space.xs }}>
    <View style={[{ borderRadius: 16, padding: space.md, gap: space.sm, borderWidth: 1, borderColor: withAlpha(main, dark ? 0.3 : 0.22), overflow: "hidden" },
      gradient(theme, [withAlpha(main, dark ? 0.24 : 0.12), withAlpha(hue(theme, tile.colors[1]), dark ? 0.06 : 0.03)], { angle: 150 })]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <IconDisk theme={theme} icon={tile.icon} colors={tile.colors} size={26} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "600" }}>{tile.label}</Text>
        <DeltaChip theme={theme} current={tile.current} previous={tile.previous} invert={tile.invert} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ flex: 1, color: colors.foreground, fontSize: 26, lineHeight: 32, fontWeight: "800", fontVariant: ["tabular-nums"], letterSpacing: -0.5 }}>{tile.value}</Text>
        {tile.ring !== undefined ? <Ring size={34} stroke={4} progress={tile.ring ?? 0} color={main} track={trackFor(theme)} /> : null}
      </View>
      {tile.sub ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{tile.sub}</Text> : null}
      <Sparkline values={tile.spark} color={main} muted={colors.foregroundMuted} height={24} />
    </View>
  </View>;
}

/** Today's token total from the Token view, shown as a shortcut to it. */
export interface TokenShortcut { today: number; onOpen: () => void }
function Hero({ theme, stats, badges, narrow, onOpenScope, tokens }: { theme: PluginTheme; stats: StatsSnapshot; badges: Achievement[]; narrow: boolean; onOpenScope?: (scope: SessionScopeTarget) => void; tokens?: TokenShortcut }) {
  const today = stats.daily.at(-1), { live, streak } = stats, lv = level(badges);
  const hour = new Date().getHours();
  return <View style={[{ borderRadius: 20, padding: space.lg, gap: space.md, overflow: "hidden" }, gradient(theme, ["#FF4FB8", "#8B5CF6", "#3B82F6"], { angle: 125 })]}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.small, fontWeight: "600" }}>{greeting(hour)}，今天已派出 {today?.sessions ?? 0} 个 Agent</Text>
        <Text style={{ color: "#ffffff", fontSize: narrow ? 23 : 28, lineHeight: narrow ? 29 : 34, fontWeight: "900", letterSpacing: -0.6 }}>{bigNumber(today?.turns ?? 0)} 轮对话{today?.runMs ? ` · ${shortHours(today.runMs)}` : ""}</Text>
        <Text style={{ color: withAlpha("#ffffff", 0.8), fontSize: fontSize.meta }}>近 {stats.daily.length} 天 {bigNumber(stats.totals.sessions)} 个会话 · {bigNumber(stats.totals.turns)} 轮</Text>
      </View>
      <View style={{ alignItems: "center", gap: 2, minWidth: 64 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}><Icon name="Flame" size={22} color="#FFE08A" /><Text style={{ color: "#ffffff", fontSize: 26, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{streak.current}</Text></View>
        <Text style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta, fontWeight: "600" }}>连续天数</Text>
        <View style={{ marginTop: 4, paddingHorizontal: 8, height: 20, borderRadius: 10, justifyContent: "center", backgroundColor: withAlpha("#000000", 0.2) }}><Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "800" }}>Lv.{lv.level} · {lv.unlocked}/{lv.total}</Text></View>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <GlassPill label="执行中" value={live.running} mark={<Spinner size={12} color="#ffffff" active={live.running > 0} />} onPress={onOpenScope ? () => onOpenScope("running") : undefined} />
      <GlassPill label="待审批" value={live.approvals} icon="Hand" onPress={onOpenScope ? () => onOpenScope("approval") : undefined} />
      <GlassPill label="未读" value={live.unread} icon="Mail" onPress={onOpenScope ? () => onOpenScope("unread") : undefined} />
      <GlassPill label="待回复" value={live.idle} icon="MessageCircleMore" onPress={onOpenScope ? () => onOpenScope("idle") : undefined} />
      {tokens ? <GlassPill label="今日 Token" value={bigNumber(tokens.today)} icon="Coins" onPress={tokens.onOpen} /> : null}
    </View>
  </View>;
}

function BadgeView({ theme, badge, wide = false }: { theme: PluginTheme; badge: Achievement; wide?: boolean }) {
  const { colors } = theme;
  if (badge.unlocked) return <View style={[{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingLeft: 6, paddingRight: 11, borderRadius: radius.full }, gradient(theme, badge.colors, { angle: 120 }), wide ? { alignSelf: "stretch" } : null]}>
    <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha("#ffffff", 0.25) }}><Icon name={badge.icon} size={13} color="#ffffff" /></View>
    <Text numberOfLines={1} style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "700" }}>{badge.title}</Text>
    {wide ? <Text numberOfLines={1} style={{ flex: 1, color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta, textAlign: "right" }}>{badge.description}</Text> : null}
  </View>;
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingLeft: 6, paddingRight: 11, borderRadius: radius.full, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border }, wide ? { alignSelf: "stretch" } : null]}>
    <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 }}><Icon name={badge.icon} size={13} color={colors.foregroundMuted} /></View>
    <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "600" }}>{badge.title}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{bigNumber(badge.current)}/{bigNumber(badge.target)}</Text>
    {wide ? <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, textAlign: "right" }}>{badge.description}</Text> : null}
  </View>;
}
function GrowthCard({ theme, badges }: { theme: PluginTheme; badges: Achievement[] }) {
  const [open, setOpen] = useState(false), lv = level(badges);
  const shown = [...badges.filter(badge => badge.unlocked), ...badges.filter(badge => !badge.unlocked).sort((a, b) => b.current / b.target - a.current / a.target)].slice(0, 7);
  return <Card theme={theme} title="成长档案" icon="Trophy" color="amber" trailing={<Pressable accessibilityRole="button" accessibilityLabel="查看全部徽章" onPress={() => setOpen(true)} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
    <Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.small, fontWeight: "700" }}>全部徽章</Text><Icon name="ChevronRight" size={14} color={hue(theme, "amber")} /></Pressable>}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View style={[{ paddingHorizontal: 12, height: 30, borderRadius: 15, justifyContent: "center" }, gradient(theme, ["amber", "pink"], { angle: 120 })]}><Text style={{ color: "#ffffff", fontSize: fontSize.title, fontWeight: "900" }}>Lv.{lv.level}</Text></View>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: trackFor(theme), overflow: "hidden" }}><View style={[{ height: 8, width: `${Math.max(4, lv.progress * 100)}%`, borderRadius: 4 }, gradient(theme, ["amber", "pink"], { angle: 90 })]} /></View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>已点亮 {lv.unlocked} / {lv.total} 枚 · 每 3 枚升一级</Text>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{shown.map(badge => <BadgeView key={badge.id} theme={theme} badge={badge} />)}</View>
    <Sheet title="全部徽章" open={open} onClose={() => setOpen(false)}>
      <View style={{ gap: space.sm }}>{badges.map(badge => <BadgeView key={badge.id} theme={theme} badge={badge} wide />)}</View>
    </Sheet>
  </Card>;
}

type TrendMetric = "sessions" | "turns" | "runMs" | "toolCalls" | "linesAdded";
const trendMetrics: Record<TrendMetric, { label: string; hue: Hue; format: (value: number) => string; pick: (metrics: StatsMetrics) => number }> = {
  sessions: { label: "会话", hue: "blue", format: value => bigNumber(value), pick: metrics => metrics.sessions },
  turns: { label: "轮次", hue: "violet", format: value => bigNumber(value), pick: metrics => metrics.turns },
  runMs: { label: "时长", hue: "pink", format: shortHours, pick: metrics => metrics.runMs },
  toolCalls: { label: "工具", hue: "cyan", format: value => bigNumber(value), pick: metrics => metrics.toolCalls },
  linesAdded: { label: "代码", hue: "green", format: value => bigNumber(value), pick: metrics => metrics.linesAdded },
};
function TrendCard({ theme, stats }: { theme: PluginTheme; stats: StatsSnapshot }) {
  const [metric, setMetric] = useState<TrendMetric>("turns");
  const spec = trendMetrics[metric];
  const points = stats.daily.map(day => ({ label: dayLabel(day.day), value: spec.pick(day), detail: longDay(day.day) }));
  const forecast = metric === "linesAdded" || metric === "toolCalls" ? [] : weekdayForecast(stats.daily, day => spec.pick(day)).map(entry => ({ label: dayLabel(entry.day), value: entry.value, detail: `${longDay(entry.day)}（预测）` }));
  const values = points.map(point => point.value), total = values.reduce((sum, value) => sum + value, 0), active = values.filter(value => value > 0).length, peak = peakOf(values);
  const next7 = forecast.reduce((sum, point) => sum + point.value, 0);
  return <Card theme={theme} title="趋势" icon="ChartColumnIncreasing" color="violet" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="趋势指标" options={(Object.keys(trendMetrics) as TrendMetric[]).map(value => ({ value, label: trendMetrics[value].label }))} />}>
    <TrendChart theme={theme} points={points} forecast={forecast} color={spec.hue} format={spec.format} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
      <Figure theme={theme} label="日均" value={spec.format(active ? total / Math.max(1, points.length) : 0)} />
      <Figure theme={theme} label="峰值" value={peak ? `${spec.format(peak.value)} · ${dayLabel(stats.daily[peak.index]!.day)}` : "—"} />
      {forecast.length ? <Figure theme={theme} label="预测未来 7 天" value={spec.format(next7)} color={spec.hue} /> : null}
    </View>
  </Card>;
}
function Figure({ theme, label, value, color }: { theme: PluginTheme; label: string; value: string; color?: Hue }) {
  return <View style={{ gap: 1 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{label}</Text>
    <Text style={{ color: color ? hue(theme, color, "text") : theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
  </View>;
}

function CalendarCard({ theme, stats }: { theme: PluginTheme; stats: StatsSnapshot }) {
  const [metric, setMetric] = useState<"sessions" | "turns">("sessions");
  const [selected, setSelected] = useState<string | null>(null);
  const values = metric === "sessions" ? stats.calendar.sessions : stats.calendar.turns;
  const total = values.reduce((sum, value) => sum + value, 0), activeDays = stats.calendar.sessions.filter((value, index) => value > 0 || (stats.calendar.turns[index] ?? 0) > 0).length;
  const index = selected ? Math.round((Date.parse(`${selected}T00:00:00Z`) - Date.parse(`${stats.calendar.start}T00:00:00Z`)) / 86_400_000) : -1;
  return <Card theme={theme} title="年度活跃" icon="CalendarDays" color="green" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="日历指标" options={[{ value: "sessions", label: "会话" }, { value: "turns", label: "轮次" }]} />}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.md }}>
      <Text style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "800" }}>{activeDays} <Text style={{ fontSize: fontSize.small, fontWeight: "500", color: theme.colors.foregroundMuted }}>天活跃</Text></Text>
      <Text style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "800" }}>{bigNumber(total)} <Text style={{ fontSize: fontSize.small, fontWeight: "500", color: theme.colors.foregroundMuted }}>{metric === "sessions" ? "个会话" : "轮"}</Text></Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}><Icon name="Flame" size={14} color={hue(theme, "orange")} /><Text style={{ color: hue(theme, "orange", "text"), fontSize: fontSize.small, fontWeight: "700" }}>连续 {stats.streak.current} 天 · 最长 {stats.streak.longest} 天</Text></View>
    </View>
    <CalendarHeatmap theme={theme} start={stats.calendar.start} values={values} secondary={metric === "sessions" ? stats.calendar.turns : stats.calendar.sessions} color="green" selected={selected} onSelect={setSelected}
      describe={(day, value, extra) => `${longDay(day)}，${metric === "sessions" ? `${value} 个会话，${extra ?? 0} 轮` : `${value} 轮，${extra ?? 0} 个会话`}`} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta }} numberOfLines={1}>
        {index >= 0 && selected ? `${longDay(selected)} · ${stats.calendar.sessions[index] ?? 0} 个会话 · ${stats.calendar.turns[index] ?? 0} 轮` : "点格子看当天"}
      </Text>
      <HeatLegend theme={theme} color="green" />
    </View>
  </Card>;
}

function HighlightsCard({ theme, stats, onOpenAgent }: { theme: PluginTheme; stats: StatsSnapshot; onOpenAgent?: (agentId: string) => void }) {
  const { records } = stats;
  const peakCell = peakOf(stats.punchcard.turns.some(value => value > 0) ? stats.punchcard.turns : stats.punchcard.sessions);
  const rows: Array<{ key: string; icon: string; colors: readonly [Hue, Hue]; label: string; value: string; detail?: string; agentId?: string }> = [];
  if (records.longestTurn) rows.push({ key: "turn", icon: "Timer", colors: ["red", "orange"], label: "最长的一轮", value: shortHours(records.longestTurn.ms), detail: records.longestTurn.title, agentId: records.longestTurn.agentId });
  if (records.busiestDay) rows.push({ key: "day", icon: "CalendarCheck", colors: ["blue", "violet"], label: "最忙的一天", value: `${Number(records.busiestDay.day.slice(5, 7))}月${Number(records.busiestDay.day.slice(8, 10))}日`, detail: `${records.busiestDay.sessions} 个会话 · ${bigNumber(records.busiestDay.turns)} 轮` });
  if (records.peakParallel) rows.push({ key: "parallel", icon: "Network", colors: ["fuchsia", "violet"], label: "峰值并发", value: `${records.peakParallel.count} 个 Agent`, detail: relativeTime(records.peakParallel.at) });
  if (records.busiestSession) rows.push({ key: "session", icon: "MessagesSquare", colors: ["cyan", "blue"], label: "最能聊的会话", value: `${records.busiestSession.turns} 轮`, detail: records.busiestSession.title, agentId: records.busiestSession.agentId });
  if (peakCell) rows.push({ key: "hour", icon: peakCell.index % 24 < 6 ? "Moon" : "Sun", colors: peakCell.index % 24 < 6 ? ["indigo", "violet"] : ["amber", "orange"], label: "高峰时段", value: `${weekdayNames[Math.floor(peakCell.index / 24)]} ${String(peakCell.index % 24).padStart(2, "0")}:00`, detail: dayPart(peakCell.index % 24) });
  return <Card theme={theme} title="高光时刻" icon="Sparkles" color="fuchsia">
    {rows.length ? rows.map(row => {
      const body = <>
        <IconDisk theme={theme} icon={row.icon} colors={row.colors} size={30} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{row.label}</Text>
          {row.detail ? <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.small }}>{row.detail}</Text> : null}
        </View>
        <Text style={{ color: hue(theme, row.colors[0], "text"), fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{row.value}</Text>
      </>;
      return row.agentId && onOpenAgent ? <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={`${row.label} ${row.value} ${row.detail ?? ""}`} onPress={() => onOpenAgent(row.agentId!)} style={state => ({ flexDirection: "row", alignItems: "center", gap: space.md, opacity: state.pressed ? 0.7 : 1 })}>{body}</Pressable>
        : <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>{body}</View>;
    }) : <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>多跑几轮，这里会出现你的纪录</Text>}
  </Card>;
}

function RhythmCard({ theme, stats }: { theme: PluginTheme; stats: StatsSnapshot }) {
  const [metric, setMetric] = useState<"turns" | "sessions">("turns");
  const values = stats.punchcard[metric], peak = peakOf(values);
  const byDay = Array.from({ length: 7 }, (_, day) => values.slice(day * 24, day * 24 + 24).reduce((sum, value) => sum + value, 0)), topDay = peakOf(byDay);
  return <Card theme={theme} title="活跃时段" icon="Clock4" color="indigo" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="时段指标" options={[{ value: "turns", label: "轮次" }, { value: "sessions", label: "会话" }]} />}>
    <Punchcard theme={theme} values={values} color="indigo" describe={(weekday, hour, value) => `${weekdayNames[weekday]} ${hour} 点，${value}`} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, alignItems: "center" }}>
      <Figure theme={theme} label="高峰" value={peak ? `${weekdayNames[Math.floor(peak.index / 24)]} ${String(peak.index % 24).padStart(2, "0")}:00 · ${dayPart(peak.index % 24)}` : "—"} color="indigo" />
      <Figure theme={theme} label="最活跃" value={topDay ? weekdayNames[topDay.index]! : "—"} />
      <View style={{ marginLeft: "auto" }}><HeatLegend theme={theme} color="indigo" /></View>
    </View>
  </Card>;
}

function ModelMixCard({ theme, stats, onOpenBreakdown }: { theme: PluginTheme; stats: StatsSnapshot; onOpenBreakdown?: () => void }) {
  const rows = stats.models.filter(row => row.turns > 0 || row.sessions > 0);
  const colors = rowHues(rows, "model"), total = rows.reduce((sum, row) => sum + (row.turns || row.sessions), 0);
  const top = rows.slice(0, 6);
  return <Card theme={theme} title="模型阵容" icon="Cpu" color="cyan" trailing={onOpenBreakdown ? <Pressable accessibilityRole="button" accessibilityLabel="查看模型明细" onPress={onOpenBreakdown} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
    <Text style={{ color: hue(theme, "cyan", "text"), fontSize: fontSize.small, fontWeight: "700" }}>明细</Text><Icon name="ChevronRight" size={14} color={hue(theme, "cyan")} /></Pressable> : undefined}>
    {rows.length ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
      <Donut size={112} stroke={16} gap={3} track={trackFor(theme)} segments={rows.map(row => ({ value: row.turns || row.sessions, color: hue(theme, colors.get(row.key) ?? "gray") }))}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "900" }}>{rows.filter(row => row.key !== "__other__").length}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>个模型</Text>
      </Donut>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        {top.map(row => <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: hue(theme, colors.get(row.key) ?? "gray") }} />
          <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small }}>{row.label}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent(total ? (row.turns || row.sessions) / total : 0)}</Text>
        </View>)}
      </View>
    </View> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>还没有模型数据</Text>}
  </Card>;
}

/** 看板: a personal dashboard over the whole host. */
export function StatsBoard({ theme, compact, stats, loading, error, range, onRange, onRefresh, onOpenScope, onOpenAgent, onOpenBreakdown, tokens }: StatsViewProps & {
  onOpenScope?: (scope: SessionScopeTarget) => void; onOpenAgent?: (agentId: string) => void; onOpenBreakdown?: () => void; tokens?: TokenShortcut;
}) {
  const [width, setWidth] = useState(0);
  const inset = compact ? space.md : space.xl, wide = width >= 900;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.lg, width: "100%", maxWidth: 1180, alignSelf: "center" }}>
      <StatsHeader theme={theme} compact={compact} stats={stats} range={range} onRange={onRange} />
      <StatsGate theme={theme} stats={stats} loading={loading} error={error} onRefresh={onRefresh}>{snapshot => <BoardBody theme={theme} stats={snapshot} wide={wide} width={width} onOpenScope={onOpenScope} onOpenAgent={onOpenAgent} onOpenBreakdown={onOpenBreakdown} tokens={tokens} />}</StatsGate>
    </View>
  </ScrollView>;
}
function BoardBody({ theme, stats, wide, width, onOpenScope, onOpenAgent, onOpenBreakdown, tokens }: { theme: PluginTheme; stats: StatsSnapshot; wide: boolean; width: number; onOpenScope?: (scope: SessionScopeTarget) => void; onOpenAgent?: (agentId: string) => void; onOpenBreakdown?: () => void; tokens?: TokenShortcut }) {
  const badges = useMemo(() => achievements(stats), [stats]);
  const columns = width >= 900 ? 4 : width >= 560 ? 3 : 2;
  const pair = (left: ReactNode, right: ReactNode, ratio = 1.6) => wide ? <View style={{ flexDirection: "row", gap: space.lg, alignItems: "stretch" }}><View style={{ flex: ratio, minWidth: 0 }}>{left}</View><View style={{ flex: 1, minWidth: 0 }}>{right}</View></View> : <>{left}{right}</>;
  return <>
    <Hero theme={theme} stats={stats} badges={badges} narrow={width > 0 && width < 420} onOpenScope={onOpenScope} tokens={tokens} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", margin: -space.xs }}>{tiles(stats).map(tile => <KpiTile key={tile.key} theme={theme} tile={tile} width={`${100 / columns}%`} />)}</View>
    {pair(<CalendarCard theme={theme} stats={stats} />, <GrowthCard theme={theme} badges={badges} />)}
    {pair(<TrendCard theme={theme} stats={stats} />, <HighlightsCard theme={theme} stats={stats} onOpenAgent={onOpenAgent} />)}
    {pair(<RhythmCard theme={theme} stats={stats} />, <ModelMixCard theme={theme} stats={stats} onOpenBreakdown={onOpenBreakdown} />, 1.3)}
  </>;
}
