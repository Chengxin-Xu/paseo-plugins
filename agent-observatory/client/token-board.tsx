import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { vendorOf, type StatsBreakdownRow, type StatsRange } from "../shared/stats";
import { bigNumber, percent, weekdayNames } from "../shared/stats-view";
import { cacheHitRate, isArchivedLogRoot, outputSpeed, TOKEN_SOURCES, TOKEN_UNMATCHED, tokenInput, tokenSourceNames, tokenTotal, tokenTruncationNotice, type TokenCounts, type TokenLive, type TokenRow, type TokenSnapshot, type TokenSource } from "../shared/tokens";
import { Banner, EmptyState, ProjectMark, Segmented, Skeleton, aria, fontSize, gradient, hairline, hue, hueFor, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { Card, CompositionBar, Donut, InlineBar, StackedColumns, TrendChart } from "./charts";
import { GlassPill, IconDisk, StatsHeader, rowHues, trackFor, vendorHue, vendorLabel } from "./stats-common";
import { KpiTile, type Tile } from "./stats-board";
import { LiveRateCard, perSecond } from "./live-rate";
import { Ping } from "./motion";
import { QuotaCard, quotaInfo, type QuotaCardProps } from "./quota-card";

/** The four kinds of tokens, bottom to top in stacked charts: cache reads dominate, output matters most. */
export const tokenKinds = [
  { key: "cacheRead", label: "缓存读取", hue: "green" }, { key: "cacheWrite", label: "缓存写入", hue: "sky" },
  { key: "input", label: "新输入", hue: "violet" }, { key: "output", label: "输出", hue: "pink" },
] as const satisfies ReadonlyArray<{ key: keyof TokenCounts; label: string; hue: Hue }>;
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const longDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 ${weekdayNames[(new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7]}`;
const days: Record<StatsRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
export const tokenInfo = [
  "Token 来自本机 Claude Code、Codex、Grok CLI 和 Pi 的会话日志，包括基于它们的自定义 Provider（按 Provider 配置、启动脚本或 Pi 设置里的 CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME / PI_CODING_AGENT_DIR 找到日志目录），口径与 ccusage 等工具一致；其他 Provider 的日志暂不支持，读不到的来源不显示。",
  "统计本机所有这些会话（不只是 Paseo 启动的），按会话 ID 关联到 Paseo 会话；续接或分叉的会话按消息去重，不会重复计算。Codex 已归档的会话（archived_sessions）也会读到；Codex 派出的子 Agent 线程和 Claude Code 的子 Agent 一样，算在派出它的会话里。在系统临时目录里跑的会话（脚本的一次性运行）在「项目用量」里合成一项「临时目录」。",
  "Grok CLI 每轮结束时记一次这一轮的用量（usage.json），所以 Grok 按轮计入、没有单次调用的响应用时，不参与输出速率和实时流速，只计入总量；它的输入里含缓存读写，已拆开。观测台自己的 Grok 智能分析（临时目录 paseo-insight-*）不计入。Pi 按它自己的口径累计：每条回复、带用量的工具结果，以及压缩和分支摘要。",
  "「Provider 用量」按会话 ID 找到对应的 Paseo 会话，再按它的 Provider 汇总，所以几个自定义 Provider 共用同一个日志目录时也能分开；日志目录只属于一个自定义 Provider 时，那里没有对应 Paseo 会话的日志也算它的；其余找不到对应 Paseo 会话的日志（在终端直接运行的会话、已删除的会话）单列为「未关联会话」。",
  "按天和按小时都按这台设备的时区（含夏令时切换）计算，和统计页一致：日志按 UTC 小时记账，读取时每个小时按它当时的偏移换算。",
  "新输入 + 缓存写入 + 缓存读取 = 模型读入的全部上下文，再加输出就是总量。缓存命中率 = 缓存读取 ÷ 读入。",
  "输出速率（TPS）= 输出 token ÷ 响应用时，响应用时包含等待第一个 token 的时间。实时流速把每次调用的输出平摊到它的响应时间里。",
  "只保存计数、模型、工作目录和会话 ID，不保存提示词或输出内容。不估算费用：同一个模型经不同 Provider、代理或订阅的单价各不相同。",
  ...quotaInfo,
];
/** Each log source's colour in the source rows: the vendor family it mostly runs (Claude orange, Codex teal, Grok violet), Pi pink. */
const sourceHues: Record<TokenSource, Hue> = { claude: "orange", codex: "teal", grok: "violet", pi: "pink" };
const isTokenSource = (key: string): key is TokenSource => (TOKEN_SOURCES as readonly string[]).includes(key);

function Hero({ theme, snapshot, live, narrow }: { theme: PluginTheme; snapshot: TokenSnapshot; live?: TokenLive; narrow: boolean }) {
  const today = snapshot.daily.at(-1), todayTotal = live?.today.total ?? (today ? tokenTotal(today) : 0), todayOutput = live?.today.output ?? today?.output ?? 0;
  const rate = live?.now.outputPerSec ?? 0, writing = live?.agents.filter(agent => agent.outputPerSec > 0).length ?? 0, hit = today ? cacheHitRate(today) : null;
  const total = tokenTotal(snapshot.totals), n = days[snapshot.range];
  return <View style={[{ borderRadius: 20, padding: space.lg, gap: space.md, overflow: "hidden" }, gradient(theme, ["#F59E0B", "#EC4899", "#8B5CF6"], { angle: 125 })]}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text style={{ color: withAlpha("#ffffff", 0.88), fontSize: fontSize.small, fontWeight: "700" }}>今天已消耗</Text>
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: "#ffffff", fontSize: narrow ? 30 : 38, lineHeight: narrow ? 36 : 44, fontWeight: "900", letterSpacing: -1, fontVariant: ["tabular-nums"] }}>
          {bigNumber(todayTotal)}<Text style={{ fontSize: fontSize.title, fontWeight: "800" }}> tokens</Text></Text>
        <Text numberOfLines={2} style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta }}>输出 {bigNumber(todayOutput)} · 调用 {bigNumber(live?.today.calls ?? today?.calls ?? 0)} 次{hit !== null ? ` · 缓存命中 ${percent(hit)}` : ""}</Text>
      </View>
      <View accessibilityLabel={`实时每秒 ${perSecond(rate)} 个 token`} style={{ alignItems: "flex-end", gap: 2, minWidth: 92 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }}><Ping size={10} color="#ffffff" active={rate > 0} /><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: rate > 0 ? "#ffffff" : withAlpha("#ffffff", 0.5) }} /></View>
          <Icon name="Zap" size={18} color="#FFF3B0" />
          <Text style={{ color: "#ffffff", fontSize: 26, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{perSecond(rate)}</Text>
        </View>
        <Text style={{ color: withAlpha("#ffffff", 0.88), fontSize: fontSize.meta, fontWeight: "700" }}>tok/s · 实时</Text>
        <Text style={{ color: withAlpha("#ffffff", 0.8), fontSize: 11 }}>{writing ? `${writing} 个会话在输出` : "当前没有输出"}</Text>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <GlassPill label={`近 ${n} 天`} value={bigNumber(total)} icon="Coins" />
      <GlassPill label="日均" value={bigNumber(total / n)} icon="CalendarDays" />
      {snapshot.speed.p50 !== null ? <GlassPill label="中位速率" value={`${perSecond(snapshot.speed.p50)} tok/s`} icon="Gauge" /> : null}
      {snapshot.paseoShare !== null ? <GlassPill label="Paseo 会话" value={percent(snapshot.paseoShare)} icon="Orbit" /> : null}
    </View>
  </View>;
}

function tiles(snapshot: TokenSnapshot): Tile[] {
  const { totals: t, previous: p, daily } = snapshot, n = days[snapshot.range];
  const spark = (pick: (day: TokenSnapshot["daily"][number]) => number) => daily.slice(-14).map(pick);
  const hit = cacheHitRate(t), speed = outputSpeed(t), read = tokenInput(t);
  return [
    { key: "total", label: "总 Token", icon: "Coins", colors: ["amber", "orange"], value: bigNumber(tokenTotal(t)), sub: `日均 ${bigNumber(tokenTotal(t) / n)}`, current: tokenTotal(t), previous: tokenTotal(p), spark: spark(tokenTotal) },
    { key: "output", label: "输出", icon: "PenLine", colors: ["pink", "fuchsia"], value: bigNumber(t.output), sub: t.reasoning ? `其中推理 ${bigNumber(t.reasoning)}` : t.calls ? `每次调用 ${bigNumber(t.output / t.calls)}` : undefined, current: t.output, previous: p.output, spark: spark(day => day.output) },
    { key: "cacheRead", label: "缓存读取", icon: "DatabaseZap", colors: ["green", "teal"], value: bigNumber(t.cacheRead), sub: read ? `占读入 ${percent(t.cacheRead / read, 1)}` : undefined, current: t.cacheRead, previous: p.cacheRead, spark: spark(day => day.cacheRead) },
    { key: "cacheWrite", label: "缓存写入", icon: "DatabaseBackup", colors: ["sky", "blue"], value: bigNumber(t.cacheWrite), sub: "新写进提示缓存", current: t.cacheWrite, previous: p.cacheWrite, spark: spark(day => day.cacheWrite) },
    { key: "input", label: "新输入", icon: "ArrowDownToLine", colors: ["violet", "indigo"], value: bigNumber(t.input), sub: "不走缓存的输入", current: t.input, previous: p.input, spark: spark(day => day.input) },
    { key: "hit", label: "缓存命中率", icon: "Target", colors: ["lime", "green"], value: percent(hit, 1), sub: `读入 ${bigNumber(read)}`, current: hit ?? 0, previous: cacheHitRate(p) ?? 0, spark: spark(day => cacheHitRate(day) ?? 0), ring: hit },
    { key: "speed", label: "输出速率", icon: "Gauge", colors: ["cyan", "blue"], value: speed === null ? "—" : `${perSecond(speed)}`, sub: snapshot.speed.p50 !== null && snapshot.speed.p90 !== null ? `中位 ${perSecond(snapshot.speed.p50)} · P90 ${perSecond(snapshot.speed.p90)} tok/s` : "tok/s", current: speed ?? 0, previous: outputSpeed(p) ?? 0, spark: spark(day => outputSpeed(day) ?? 0) },
    { key: "calls", label: "模型调用", icon: "Repeat2", colors: ["orange", "red"], value: bigNumber(t.calls), sub: t.calls ? `每次读入 ${bigNumber(read / t.calls)}` : undefined, current: t.calls, previous: p.calls, spark: spark(day => day.calls) },
  ];
}

function TrendCard({ theme, snapshot }: { theme: PluginTheme; snapshot: TokenSnapshot }) {
  const [metric, setMetric] = useState<"total" | "fresh" | "output" | "speed">("total");
  // Cache reads are ~96 % of all tokens; 非缓存 leaves them out so input, cache writes and output are visible.
  const kinds = metric === "fresh" ? tokenKinds.filter(kind => kind.key !== "cacheRead") : tokenKinds, colors = kinds.map(kind => hue(theme, kind.hue));
  return <Card theme={theme} title="Token 趋势" icon="ChartColumnStacked" color="amber" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="趋势指标" options={[{ value: "total", label: "总量" }, { value: "fresh", label: "非缓存" }, { value: "output", label: "输出" }, { value: "speed", label: "速率" }]} />}>
    {metric === "total" || metric === "fresh" ? <StackedColumns key={metric} theme={theme} colors={colors} names={kinds.map(kind => kind.label)} format={bigNumber}
      columns={snapshot.daily.map(day => ({ label: shortDay(day.day), detail: longDay(day.day), parts: kinds.map(kind => day[kind.key]) }))} />
      : <TrendChart theme={theme} color={metric === "output" ? "pink" : "cyan"} format={metric === "output" ? bigNumber : value => `${perSecond(value)}`}
        points={snapshot.daily.map(day => ({ label: shortDay(day.day), value: metric === "output" ? day.output : outputSpeed(day) ?? 0, detail: longDay(day.day) }))} average={metric === "output"} />}
  </Card>;
}

function CompositionCard({ theme, counts }: { theme: PluginTheme; counts: TokenCounts }) {
  const total = tokenTotal(counts), hit = cacheHitRate(counts);
  return <Card theme={theme} title="Token 构成" icon="PieChart" color="green">
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}>
      <Donut size={132} stroke={16} gap={3} track={trackFor(theme)} segments={tokenKinds.map(kind => ({ value: counts[kind.key], color: hue(theme, kind.hue) }))}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{percent(hit)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>缓存命中</Text>
      </Donut>
      <View style={{ flex: 1, minWidth: 180, gap: 6 }}>
        {[...tokenKinds].reverse().map(kind => <View key={kind.key} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: hue(theme, kind.hue) }} />
          <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{kind.label}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(counts[kind.key])}</Text>
          <Text style={{ width: 48, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent(total ? counts[kind.key] / total : 0, total && counts[kind.key] / total < 0.1 ? 1 : 0)}</Text>
        </View>)}
        {hit !== null ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>每读入 100 个 token，有 {Math.round(hit * 100)} 个直接来自提示缓存。</Text> : null}
      </View>
    </View>
  </Card>;
}

function RowStats({ theme, row }: { theme: PluginTheme; row: TokenCounts }) {
  const speed = outputSpeed(row), hit = cacheHitRate(row);
  return <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
    输出 {bigNumber(row.output)} · 命中 {percent(hit)}{speed !== null ? ` · ${perSecond(speed)} tok/s` : ""} · {bigNumber(row.calls)} 次调用
  </Text>;
}
type RowKind = "models" | "projects" | "sources" | "providers";
function rowSubtitle(kind: RowKind, row: TokenRow): string {
  const when = row.lastAt ? ` · ${relativeTime(row.lastAt)}` : "";
  if (row.key === TOKEN_UNMATCHED) return `${row.sessions} 个会话 · 终端直接运行或已删除${when}`;
  return `${kind === "models" || kind === "providers" ? `${vendorLabel(row.vendor ?? (kind === "models" ? vendorOf(row.key, null) : null))} · ` : ""}${row.sessions} 个会话${when}`;
}
function TokenRows({ theme, rows, kind, total, limit = 8, hues, ranked = true, empty = "这个范围内还没有数据" }: {
  theme: PluginTheme; rows: readonly TokenRow[]; kind: RowKind; total: number; limit?: number; hues?: ReadonlyMap<string, Hue>; ranked?: boolean; empty?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(1, ...rows.map(tokenTotal)), shown = expanded ? rows : rows.slice(0, limit);
  if (!rows.length) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{empty}</Text>;
  return <View>
    {shown.map((row, index) => {
      const color: Hue = row.key === "__other__" || row.key === TOKEN_UNMATCHED ? "gray" : hues?.get(row.key) ?? (kind === "models" ? vendorHue(row.vendor ?? vendorOf(row.key, null)) : kind === "sources" ? (isTokenSource(row.key) ? sourceHues[row.key] : hueFor(row.label)) : hueFor(row.label));
      const value = tokenTotal(row);
      return <View key={row.key} style={{ gap: 5, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text numberOfLines={1} style={{ width: 22, textAlign: "center", fontVariant: ["tabular-nums"], color: ranked && index < 3 ? hue(theme, color, "text") : theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800" }}>{ranked ? index + 1 : "—"}</Text>
          {kind === "projects" && row.key !== "__other__" ? <ProjectMark theme={theme} name={row.label} size={20} /> : <View style={{ width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, color, "soft") }}><View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: hue(theme, color) }} /></View>}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: row.key === TOKEN_UNMATCHED ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{row.label}</Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{rowSubtitle(kind, row)}</Text>
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(value)}</Text>
          <Text style={{ width: 46, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent(total ? value / total : 0, total && value / total < 0.1 ? 1 : 0)}</Text>
        </View>
        <View style={{ marginLeft: 18 + 20 + 2 * space.sm, gap: 4 }}>
          <View style={{ width: `${Math.max(4, value / max * 100)}%` }}><CompositionBar height={7} track={trackFor(theme)} segments={tokenKinds.map(item => ({ key: item.key, value: row[item.key], color: hue(theme, item.hue) }))} /></View>
          <RowStats theme={theme} row={row} />
        </View>
      </View>;
    })}
    {rows.length > limit ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }} {...aria({ expanded })} onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? "收起" : `展开全部（还有 ${rows.length - limit} 个）`}</Text>
    </Pressable> : null}
  </View>;
}

/**
 * Provider 用量 (2.13): sessions matched to Paseo agents, by the agent's provider, so custom providers sharing one log
 * directory are told apart; the sessions nothing matches stand apart as 未关联会话.
 */
function ProviderCard({ theme, snapshot, total }: { theme: PluginTheme; snapshot: TokenSnapshot; total: number }) {
  const rows = snapshot.providers;
  const ranked = useMemo(() => rows?.filter(row => row.key !== TOKEN_UNMATCHED) ?? [], [rows]), unmatched = rows?.find(row => row.key === TOKEN_UNMATCHED);
  // rowHues reads only key, vendor and label: a provider's colour follows its models' vendor, neighbours take adjacent hues.
  const hues = useMemo(() => rowHues(ranked as unknown as readonly StatsBreakdownRow[], "provider"), [ranked]);
  const named = ranked.filter(row => row.key !== "__other__").length;
  return <Card theme={theme} title="Provider 用量" icon="Network" color="violet" trailing={rows ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{named} 个 Provider</Text> : undefined}>
    {!rows ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>正在读取 Paseo 会话目录，读到后按 Provider 拆分</Text> : <>
      <TokenRows theme={theme} rows={ranked} kind="providers" total={total} limit={6} hues={hues} empty="这个范围内没有能关联到 Paseo 会话的用量" />
      {unmatched ? <TokenRows theme={theme} rows={[unmatched]} kind="providers" total={total} ranked={false} /> : null}
    </>}
  </Card>;
}

function SessionsCard({ theme, snapshot, onOpenAgent }: { theme: PluginTheme; snapshot: TokenSnapshot; onOpenAgent?: (agentId: string) => void }) {
  const total = tokenTotal(snapshot.totals), max = Math.max(1, ...snapshot.sessions.map(tokenTotal));
  return <Card theme={theme} title="最耗 Token 的会话" icon="Flame" color="red" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>前 {snapshot.sessions.length}</Text>}>
    {snapshot.sessions.length ? <View>{snapshot.sessions.map((session, index) => {
      const value = tokenTotal(session), color = hue(theme, vendorHue(vendorOf(session.model, null)));
      const title = session.title ?? (session.agentId ? "未命名 Agent" : `未关联 Paseo 的会话 · ${session.sessionId.slice(0, 8)}`);
      const body = <View style={{ gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text numberOfLines={1} style={{ width: 22, textAlign: "center", fontVariant: ["tabular-nums"], color: index < 3 ? hue(theme, "red", "text") : theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800" }}>{index + 1}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: session.title ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.body, fontWeight: "600" }}>{title}</Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[session.project, session.model ?? tokenSourceNames[session.source], session.subagentCalls ? `子 Agent ${bigNumber(session.subagentCalls)} 次调用` : null, relativeTime(session.lastAt)].filter(Boolean).join(" · ")}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(value)}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{percent(total ? value / total : 0, 1)}</Text>
          </View>
        </View>
        <View style={{ marginLeft: 18 + space.sm }}><InlineBar value={value} max={max} color={color} track={trackFor(theme)} height={5} /></View>
      </View>;
      return session.agentId && onOpenAgent ? <Pressable key={session.sessionId} accessibilityRole="button" accessibilityLabel={`打开 ${title}，${bigNumber(value)} tokens`} onPress={() => onOpenAgent(session.agentId!)} style={state => ({ opacity: state.pressed ? 0.7 : 1 })}>{body}</Pressable> : <View key={session.sessionId}>{body}</View>;
    })}</View> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>这个范围内还没有会话用量</Text>}
  </Card>;
}

function RhythmCard({ theme, snapshot }: { theme: PluginTheme; snapshot: TokenSnapshot }) {
  const peak = snapshot.hours.reduce((best, value, hour) => value > (snapshot.hours[best] ?? 0) ? hour : best, 0);
  const records = snapshot.records;
  const item = (icon: string, colors: readonly [Hue, Hue], label: string, value: string, sub: string) => <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 160, flexGrow: 1, flexBasis: 0 }}>
    <IconDisk theme={theme} icon={icon} colors={colors} size={30} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{sub}</Text>
    </View>
  </View>;
  return <Card theme={theme} title="时段与纪录" icon="Clock" color="violet">
    <StackedColumns theme={theme} height={90} colors={[hue(theme, "violet")]} names={["Token"]} format={bigNumber} highlight={snapshot.hours[peak] ? peak : undefined} labelEvery={6}
      columns={snapshot.hours.map((value, hour) => ({ label: String(hour).padStart(2, "0"), detail: `${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`, parts: [value] }))} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      {item("CalendarCheck", ["amber", "orange"], "最忙的一天", records.peakDay ? bigNumber(records.peakDay.total) : "—", records.peakDay ? longDay(records.peakDay.day) : "还没有记录")}
      {item("Rocket", ["cyan", "blue"], "最快的一次", records.fastest ? `${perSecond(records.fastest.tps)} tok/s` : "—", records.fastest ? `${records.fastest.model ?? "未知模型"} · ${relativeTime(records.fastest.at)}` : "还没有记录")}
      {item("ScrollText", ["pink", "fuchsia"], "最长的一次输出", records.biggest ? bigNumber(records.biggest.output) : "—", records.biggest ? `${records.biggest.model ?? "未知模型"} · ${relativeTime(records.biggest.at)}` : "还没有记录")}
    </View>
  </Card>;
}

function Coverage({ theme, snapshot }: { theme: PluginTheme; snapshot: TokenSnapshot }) {
  const { backfill, roots, earliestAt } = snapshot.coverage, cut = tokenTruncationNotice(snapshot.coverage.truncated);
  // A source this host does not have (no directory, nothing found) is left out quietly; Grok keeps one usage file per session.
  const parts = [...roots.filter(root => root.files || root.error).map(root => `${tokenSourceNames[root.source]}${isArchivedLogRoot(root.path) ? " 已归档" : ""} ${root.files} ${root.source === "grok" ? "个会话" : "个日志"}${root.error ? `（${root.error}）` : ""}`), earliestAt ? `最早 ${new Date(earliestAt).toLocaleDateString("zh-CN")}` : null, snapshot.paseoShare !== null ? `Paseo 会话占 ${percent(snapshot.paseoShare)}` : null].filter(Boolean);
  return <View style={{ gap: space.sm }}>
    {!backfill.done ? <View accessibilityLabel={`正在导入历史日志 ${percent(backfill.bytes ? backfill.bytesDone / backfill.bytes : 0)}`} style={{ gap: 6, padding: space.md, borderRadius: radius.lg, backgroundColor: hue(theme, "amber", "soft"), borderWidth: 1, borderColor: hue(theme, "amber", "line") }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="History" size={16} color={hue(theme, "amber")} />
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>正在导入历史日志 {percent(backfill.bytes ? backfill.bytesDone / backfill.bytes : 0)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{backfill.filesDone}/{backfill.files} 个文件</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: trackFor(theme), overflow: "hidden" }}>
        <View style={[{ height: 6, width: `${Math.max(3, backfill.bytes ? backfill.bytesDone / backfill.bytes * 100 : 0)}%`, borderRadius: 3 }, gradient(theme, ["amber", "pink"], { angle: 90 })]} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>导入期间数字会持续变大，完成后就是完整历史。</Text>
    </View> : null}
    {roots.some(root => root.error) ? <Banner theme={theme} tone="warning" message={roots.filter(root => root.error).map(root => `${tokenSourceNames[root.source]}：${root.error}`).join("；")} /> : null}
    {cut ? <Banner theme={theme} tone="warning" message={cut} /> : null}
    {parts.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, textAlign: "center" }}>{parts.join(" · ")}</Text> : null}
  </View>;
}

export interface TokenBoardProps {
  theme: PluginTheme; compact: boolean; range: StatsRange; onRange: (range: StatsRange) => void; onRefresh: () => void;
  tokens?: TokenSnapshot; loading: boolean; error?: string;
  live?: TokenLive; liveError?: string; liveWindow: 30 | 60; onLiveWindow: (minutes: 30 | 60) => void;
  onOpenAgent?: (agentId: string) => void;
  /** 额度 (2.13): the host's provider usage windows with history and forecasts (client/use-quota), shown at the top. */
  quota?: Omit<QuotaCardProps, "theme" | "compact">;
}
/** Token 页: personal token statistics from the local provider logs, with the live speed chart. */
export function TokenBoard({ theme, compact, range, onRange, onRefresh, tokens, loading, error, live, liveError, liveWindow, onLiveWindow, onOpenAgent, quota }: TokenBoardProps) {
  const [width, setWidth] = useState(0);
  const inset = compact ? space.md : space.xl, wide = width >= 900, columns = width >= 900 ? 4 : width >= 560 ? 3 : 2;
  const pair = (left: ReactNode, right: ReactNode, ratio = 1.4) => wide ? <View style={{ flexDirection: "row", gap: space.lg, alignItems: "stretch" }}><View style={{ flex: ratio, minWidth: 0 }}>{left}</View><View style={{ flex: 1, minWidth: 0 }}>{right}</View></View> : <>{left}{right}</>;
  let body: ReactNode;
  if (!tokens) body = loading ? <Skeleton theme={theme} rows={6} /> : <EmptyState theme={theme} icon={error ? "WifiOff" : "Coins"} tone={error ? "danger" : "warning"} title={error ? "Token 统计暂时读不到" : "还没有 Token 数据"} message={error ?? "本机 Claude Code、Codex、Grok CLI 和 Pi 的会话日志会在这里汇总"} action={{ label: "重试", onPress: onRefresh, icon: "RefreshCw" }} />;
  else {
    const total = tokenTotal(tokens.totals);
    body = <>
      {error ? <Banner theme={theme} tone="warning" message={`Token 统计同步失败，显示的是上次结果：${error}`} action={{ label: "重试", onPress: onRefresh }} /> : null}
      <Hero theme={theme} snapshot={tokens} live={live} narrow={width > 0 && width < 420} />
      <LiveRateCard theme={theme} live={live} error={liveError} windowMinutes={liveWindow} onWindow={onLiveWindow} onOpenAgent={onOpenAgent} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", margin: -space.xs }}>{tiles(tokens).map(tile => <KpiTile key={tile.key} theme={theme} tile={tile} width={`${100 / columns}%`} />)}</View>
      {pair(<TrendCard theme={theme} snapshot={tokens} />, <CompositionCard theme={theme} counts={tokens.totals} />)}
      {/* Providers sit above projects: together they balance the taller model list on wide screens. */}
      {pair(<Card theme={theme} title="模型用量" icon="Cpu" color="cyan" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{tokens.models.filter(row => row.key !== "__other__").length} 个模型</Text>}>
        <TokenRows theme={theme} rows={tokens.models} kind="models" total={total} />
        {tokens.sources.length > 1 ? <View style={{ borderTopWidth: hairline, borderTopColor: theme.colors.border, paddingTop: space.sm }}><TokenRows theme={theme} rows={tokens.sources} kind="sources" total={total} /></View> : null}
      </Card>, <View style={{ gap: space.lg }}>
        <ProviderCard theme={theme} snapshot={tokens} total={total} />
        <Card theme={theme} title="项目用量" icon="FolderGit2" color="blue"><TokenRows theme={theme} rows={tokens.projects} kind="projects" total={total} limit={6} /></Card>
      </View>, 1.2)}
      {pair(<SessionsCard theme={theme} snapshot={tokens} onOpenAgent={onOpenAgent} />, <RhythmCard theme={theme} snapshot={tokens} />, 1.2)}
      <Coverage theme={theme} snapshot={tokens} />
    </>;
  }
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.lg, width: "100%", maxWidth: 1180, alignSelf: "center" }}>
      <StatsHeader theme={theme} compact={compact} range={range} onRange={onRange} generatedAt={tokens?.generatedAt} info={tokenInfo} infoTitle="关于 Token 统计" />
      {quota ? <QuotaCard theme={theme} compact={compact || (width > 0 && width < 560)} {...quota} /> : null}
      {body}
    </View>
  </ScrollView>;
}
