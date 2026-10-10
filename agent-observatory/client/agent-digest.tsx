import { useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { CheckKind, Digest, DigestLane, DigestSegment, DigestTurn, HighlightKind } from "../shared/digest";
import { buildTimeAxis, lanesIn, segmentsBetween, shareEntries, splitPath, turnSpan } from "../shared/digest-view";
import { bigNumber, percent } from "../shared/stats-view";
import { cacheHitRate, outputSpeed, tokenTotal } from "../shared/tokens";
import { Banner, Button, EmptyState, IconButton, Segmented, Skeleton, fontSize, formatDuration, gradient, hairline, hue, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { Card, CompositionBar, StackedColumns } from "./charts";
import { IconDisk, trackFor } from "./stats-common";
import { perSecond } from "./live-rate";
import { InfoButton, shortDuration, useClock } from "./ui";
import { Ping } from "./motion";

export const laneLooks: Record<DigestLane, { label: string; icon: string; hue: Hue }> = {
  model: { label: "思考", icon: "Brain", hue: "violet" }, read: { label: "读文件", icon: "FileText", hue: "blue" },
  search: { label: "搜索", icon: "Search", hue: "indigo" }, edit: { label: "改文件", icon: "FilePen", hue: "green" },
  shell: { label: "命令", icon: "SquareTerminal", hue: "orange" }, web: { label: "联网", icon: "Globe", hue: "cyan" },
  agent: { label: "子 Agent", icon: "Bot", hue: "fuchsia" }, plan: { label: "计划", icon: "ListChecks", hue: "teal" },
  wait: { label: "等审批", icon: "Hand", hue: "amber" }, other: { label: "其他", icon: "Puzzle", hue: "gray" },
};
const outcomeLooks: Record<DigestTurn["outcome"], { label: string; hue: Hue; icon: string }> = {
  completed: { label: "完成", hue: "green", icon: "Check" }, failed: { label: "失败", hue: "red", icon: "X" },
  canceled: { label: "已中断", hue: "gray", icon: "CircleSlash" }, running: { label: "进行中", hue: "blue", icon: "LoaderCircle" },
  unknown: { label: "已结束", hue: "gray", icon: "Circle" },
};
const highlightIcons: Record<HighlightKind, string> = {
  turn_failed: "CircleX", interrupted: "CircleSlash", check_failed: "FlaskConical", check_fixed: "BadgeCheck", check_passed: "CircleCheckBig",
  fail_streak: "Repeat", error: "TriangleAlert", slow_tool: "Hourglass", long_think: "Brain", approval_wait: "Hand", big_edit: "FileDiff",
  many_files: "Files", git: "GitCommitHorizontal", subagent: "Bot", compaction: "Shrink", token_heavy: "Flame",
};
const severityHues: Record<"bad" | "warn" | "good" | "info", Hue> = { bad: "red", warn: "amber", good: "green", info: "blue" };
const checkNames: Record<CheckKind, string> = { test: "测试", typecheck: "类型检查", lint: "代码检查", build: "构建", install: "依赖安装" };
const clock = (at: number, seconds = false) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
const duration = (ms: number) => ms < 1000 ? "不到 1 秒" : formatDuration(ms);
/** 45秒 / 12分 / 2时 / 2.5时 — for the narrow break marks. */
const tinyDuration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}秒` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}分` : `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0).replace(/\.0$/, "")}时`;
const share = (fraction: number) => fraction > 0 && fraction < 0.01 ? "<1%" : percent(fraction);
/** "子 Agent" + "上" reads "子 Agent 上"; Chinese labels join directly. */
const spaced = (label: string) => /[A-Za-z0-9]$/.test(label) ? `${label} ` : label;
/** Prompts and replies are excerpts of Markdown; drop the markers that read as noise on one line. */
const plain = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/(^|\s)(?:#{1,6}|-{3,}|>)(?=\s)/g, "$1").replace(/\s{2,}/g, " ").trim();
function highlightValue(kind: HighlightKind, value: number | null): string | null {
  if (value === null) return null;
  if (["slow_tool", "long_think", "approval_wait", "subagent"].includes(kind)) return duration(value);
  if (kind === "big_edit") return `${bigNumber(value)} 行`;
  // Check, streak and token titles already carry their number ("测试失败 2 次后通过", "用掉 42% 的 Token").
  return null;
}
type OpenRef = (seq: number) => void;

/** Key numbers of the whole session. */
function Totals({ theme, digest, now, columns }: { theme: PluginTheme; digest: Digest; now: number; columns: number }) {
  const t = digest.totals, span = digest.start !== null ? (digest.end ?? now) - digest.start : 0, tokens = digest.tokens;
  const items: Array<{ label: string; value: string; sub?: string; icon: string; colors: readonly [Hue, Hue] }> = [
    { label: "执行用时", value: shortDuration(digest.activeMs) || "0 秒", sub: span > digest.activeMs + 60_000 ? `跨度 ${shortDuration(span)}` : undefined, icon: "Timer", colors: ["violet", "fuchsia"] },
    { label: "轮次", value: String(t.turns), sub: t.messages ? `${t.messages} 条消息` : undefined, icon: "MessagesSquare", colors: ["blue", "cyan"] },
    { label: "工具调用", value: bigNumber(t.tools), sub: t.failures ? `失败 ${t.failures} 次` : "没有失败", icon: "Wrench", colors: t.failures ? ["orange", "red"] : ["teal", "green"] },
    { label: "改动", value: `${t.files} 个文件`, sub: t.added || t.removed ? `+${bigNumber(t.added)} −${bigNumber(t.removed)}` : undefined, icon: "FileDiff", colors: ["green", "lime"] },
    { label: "检查", value: t.checksPassed + t.checksFailed ? `${t.checksPassed} / ${t.checksPassed + t.checksFailed}` : "—", sub: t.checksPassed + t.checksFailed ? t.checksFailed ? `失败 ${t.checksFailed} 次` : "全部通过" : "没有跑测试或构建", icon: "FlaskConical", colors: t.checksFailed ? ["amber", "orange"] : ["green", "teal"] },
    ...(tokens ? [{ label: "Token", value: bigNumber(tokenTotal(tokens.totals)), sub: `输出 ${bigNumber(tokens.totals.output)} · 命中 ${percent(cacheHitRate(tokens.totals))}`, icon: "Coins", colors: ["amber", "pink"] as const },
      { label: "输出速率", value: outputSpeed(tokens.totals) === null ? "—" : `${perSecond(outputSpeed(tokens.totals)!)} tok/s`, sub: `${bigNumber(tokens.totals.calls)} 次模型调用`, icon: "Gauge", colors: ["cyan", "blue"] as const }] : []),
    ...(t.waitMs ? [{ label: "等你审批", value: shortDuration(t.waitMs), sub: `${t.approvals} 次`, icon: "Hand", colors: ["amber", "orange"] as const }] : []),
  ];
  return <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: space.md }}>
    {items.map(item => <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, width: `${100 / columns}%`, paddingRight: space.sm }}>
      <IconDisk theme={theme} icon={item.icon} colors={item.colors} size={30} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{item.label}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{item.value}</Text>
        {item.sub ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{item.sub}</Text> : null}
      </View>
    </View>)}
  </View>;
}

/** 时间都去哪了: where the active time went, largest share first. */
function TimeShare({ theme, digest }: { theme: PluginTheme; digest: Digest }) {
  const entries = shareEntries(digest.timeShare);
  if (!entries.length) return null;
  const model = entries.find(entry => entry.lane === "model"), top = entries[0]!;
  return <Card theme={theme} title="时间都去哪了" icon="PieChart" color="violet">
    <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>
      <Text style={{ color: hue(theme, laneLooks[top.lane].hue, "text"), fontWeight: "800" }}>{share(top.fraction)}</Text>
      {top.lane === "model" ? " 的时间模型在思考和写回复" : ` 的时间花在${spaced(laneLooks[top.lane].label)}上`}{model && top.lane !== "model" ? `，思考占 ${share(model.fraction)}` : ""}。
    </Text>
    <CompositionBar height={16} track={trackFor(theme)} segments={entries.map(entry => ({ key: entry.lane, value: entry.ms, color: hue(theme, laneLooks[entry.lane].hue) }))} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.lg, rowGap: 6 }}>
      {entries.map(entry => <View key={entry.lane} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Icon name={laneLooks[entry.lane].icon} size={13} color={hue(theme, laneLooks[entry.lane].hue)} />
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{laneLooks[entry.lane].label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{shortDuration(entry.ms) || "<1 秒"} · {share(entry.fraction)}</Text>
      </View>)}
    </View>
  </Card>;
}

function segmentColor(theme: PluginTheme, segment: DigestSegment): string {
  if (segment.status === "failed") return hue(theme, "red");
  if (segment.status === "canceled") return hue(theme, "gray");
  return hue(theme, laneLooks[segment.lane].hue);
}

/** 执行时间轴: one row per kind of work; turns side by side with long idle gaps folded into breaks. */
function Gantt({ theme, digest, compact, now, zoom, onZoom, onOpenRef }: { theme: PluginTheme; digest: Digest; compact: boolean; now: number; zoom: number | null; onZoom: (turn: number | null) => void; onOpenRef?: OpenRef }) {
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<DigestSegment | null>(null);
  const labelWidth = compact ? 66 : 76, track = Math.max(0, width - labelWidth - space.sm);
  const zoomed = zoom !== null ? digest.turns.find(turn => turn.index === zoom) ?? null : null;
  const spans = useMemo(() => zoomed ? [turnSpan(zoomed, now)] : digest.turns.map(turn => turnSpan(turn, now)), [digest.turns, zoomed, now]);
  const axis = useMemo(() => buildTimeAxis(spans, track, { gapMs: zoomed ? Number.POSITIVE_INFINITY : 120_000 }), [spans, track, zoomed]);
  const visible = useMemo(() => zoomed ? segmentsBetween(digest.segments.filter(segment => segment.turn === zoomed.index), spans[0]!.start, spans[0]!.end) : digest.segments, [digest.segments, zoomed, spans]);
  const lanes = lanesIn(visible), rowHeight = 20, dark = isDarkTheme(theme);
  const turnsShown = zoomed ? [zoomed] : digest.turns;
  const ticks = zoomed ? [0, 0.25, 0.5, 0.75, 1].map(step => spans[0]!.start + (spans[0]!.end - spans[0]!.start) * step) : [];
  return <Card theme={theme} title="执行时间轴" icon="ChartGantt" color="blue" trailing={zoomed ? <Button theme={theme} size="sm" icon="Maximize2" label="看全部" onPress={() => { onZoom(null); setPicked(null); }} /> : undefined}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
      {[null, ...digest.turns.map(turn => turn.index)].map(index => {
        const turn = index === null ? null : digest.turns.find(item => item.index === index)!, selected = zoom === index, look = turn ? outcomeLooks[turn.outcome] : null;
        return <Pressable key={index ?? "all"} accessibilityRole="button" accessibilityLabel={turn ? `第 ${turn.index} 轮，${look!.label}` : "全部轮次"} onPress={() => { onZoom(index); setPicked(null); }}
          style={state => [{ flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingHorizontal: 10, borderRadius: radius.full, borderWidth: 1, borderColor: selected ? "transparent" : theme.colors.border, opacity: state.pressed ? 0.75 : 1 },
            selected ? gradient(theme, turn ? [look!.hue === "gray" ? "violet" : look!.hue, "blue"] : ["violet", "blue"], { angle: 120 }) : null]}>
          {look ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: selected ? "#ffffff" : hue(theme, look.hue) }} /> : null}
          <Text style={{ color: selected ? "#ffffff" : theme.colors.foreground, fontSize: fontSize.small, fontWeight: selected ? "800" : "600" }}>{turn ? `#${turn.index}` : "全部"}</Text>
        </Pressable>;
      })}
    </ScrollView>
    {zoomed ? <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>#{zoomed.index} {zoomed.prompt || "（没有找到这一轮的提问）"}</Text> : null}
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))}>
      {width > 0 && lanes.length ? <View style={{ height: 16 + lanes.length * rowHeight }}>
        {turnsShown.map((turn, index) => { const span = turnSpan(turn, now), left = axis.x(span.start), right = axis.x(span.end);
          return <View key={turn.index} style={{ position: "absolute", left: labelWidth + space.sm + left, width: Math.max(2, right - left), top: 0, bottom: 0, borderRadius: 4, backgroundColor: index % 2 ? "transparent" : withAlpha(dark ? "#ffffff" : "#000000", 0.035) }}>
            {right - left >= 20 && !zoomed ? <Text numberOfLines={1} style={{ position: "absolute", left: 7, top: 1, color: hue(theme, outcomeLooks[turn.outcome].hue, "text"), fontSize: 10, fontWeight: "800" }}>#{turn.index}</Text> : null}
          </View>; })}
        {axis.breaks.map(gap => <View key={gap.x} style={{ position: "absolute", left: labelWidth + space.sm + gap.x, width: gap.width, top: 0, bottom: 0, alignItems: "center" }}>
          <View style={{ position: "absolute", top: 16, bottom: 0, left: gap.width / 2 - 3, width: 6, borderLeftWidth: 1, borderRightWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }} />
          {/* RN-web caps one-line text at its parent's width, so the label gets its own wider box. */}
          <View style={{ position: "absolute", top: 2, width: 40, left: gap.width / 2 - 20, alignItems: "center" }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700" }}>{tinyDuration(gap.ms)}</Text>
          </View>
        </View>)}
        {lanes.map((lane, row) => <View key={lane} style={{ position: "absolute", left: 0, right: 0, top: 16 + row * rowHeight, height: rowHeight, flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: labelWidth, flexDirection: "row", alignItems: "center", gap: compact ? 2 : 3 }}>
            <Icon name={laneLooks[lane].icon} size={compact ? 11 : 12} color={hue(theme, laneLooks[lane].hue)} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{laneLooks[lane].label}</Text>
          </View>
        </View>)}
        {visible.map((segment, index) => {
          const row = lanes.indexOf(segment.lane), left = axis.x(segment.start), size = Math.max(2, axis.x(segment.end) - left);
          const style = { position: "absolute" as const, left: labelWidth + space.sm + left, width: size, top: 16 + row * rowHeight + 5, height: 10, borderRadius: 3 };
          const color = segmentColor(theme, segment), selected = picked === segment;
          const bar = segment.status === "running" ? [style, gradient(theme, ["sky", "blue"], { angle: 90 })] : [style, { backgroundColor: color, opacity: segment.lane === "model" ? 0.6 : 1 }, selected ? { borderWidth: 1.5, borderColor: theme.colors.foreground } : null];
          return size >= 4 ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={`${laneLooks[segment.lane].label}：${segment.label}，${duration(segment.end - segment.start)}${segment.status === "failed" ? "，失败" : ""}`} onPress={() => setPicked(selected ? null : segment)} style={bar} />
            : <View key={index} style={bar} />;
        })}
        {visible.filter(segment => segment.status === "running").map((segment, index) => <View key={`ping-${index}`} style={{ position: "absolute", left: labelWidth + space.sm + axis.x(segment.end) - 5, top: 16 + lanes.indexOf(segment.lane) * rowHeight + 5, width: 10, height: 10, alignItems: "center", justifyContent: "center" }}>
          <Ping size={10} color={hue(theme, "blue")} /><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: hue(theme, "blue") }} />
        </View>)}
      </View> : width > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>这一段没有记录到工具调用</Text> : null}
      {width > 0 && ticks.length ? <View style={{ height: 14, marginLeft: labelWidth + space.sm }}>
        {ticks.map((tick, index) => <Text key={index} numberOfLines={1} style={{ position: "absolute", left: Math.min(track - 44, Math.max(0, axis.x(tick) - 22)), width: 44, textAlign: index === 0 ? "left" : index === ticks.length - 1 ? "right" : "center", color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>{clock(tick)}</Text>)}
      </View> : null}
    </View>
    {picked ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: hue(theme, laneLooks[picked.lane].hue, "soft") }}>
      <IconDisk theme={theme} icon={picked.status === "failed" ? "X" : laneLooks[picked.lane].icon} colors={[picked.status === "failed" ? "red" : laneLooks[picked.lane].hue]} size={26} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{picked.label}{picked.n > 1 ? `（合并了 ${picked.n} 次）` : ""}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[`#${picked.turn}`, `${clock(picked.start, true)}–${clock(picked.end, true)}`, duration(picked.end - picked.start), picked.status === "failed" ? "失败" : picked.status === "running" ? "进行中" : null].filter(Boolean).join(" · ")}</Text>
      </View>
      {picked.seq !== null && onOpenRef ? <Button theme={theme} size="sm" icon="ListTree" label="原始记录" onPress={() => onOpenRef(picked.seq!)} /> : null}
    </View> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{zoomed ? "点色块看这一步的详情" : "点轮次放大；超过 2 分钟的空闲折叠成虚线"}</Text>}
  </Card>;
}

/** 重点: what went wrong, what got fixed, milestones, slow spots. */
function Highlights({ theme, digest, onOpenRef }: { theme: PluginTheme; digest: Digest; onOpenRef?: OpenRef }) {
  const [expanded, setExpanded] = useState(false);
  if (!digest.highlights.length) return null;
  const shown = expanded ? digest.highlights : digest.highlights.slice(0, 8);
  return <Card theme={theme} title="重点" icon="Sparkles" color="pink" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{digest.highlights.length} 条</Text>}>
    <View style={{ gap: 2 }}>
      {shown.map((item, index) => {
        const color = severityHues[item.severity], value = highlightValue(item.kind, item.value);
        const body = <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 7 }}>
          <IconDisk theme={theme} icon={highlightIcons[item.kind]} colors={[color, color === "red" ? "pink" : color === "amber" ? "orange" : color === "green" ? "teal" : "violet"]} size={28} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text numberOfLines={1} style={{ flexShrink: 1, color: hue(theme, color, "text"), fontSize: fontSize.small, fontWeight: "800" }}>{item.title}</Text>
              {value ? <Text style={{ color: theme.colors.foreground, fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text> : null}
            </View>
            {item.detail ? <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.small }}>{plain(item.detail)}</Text> : null}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>第 {item.turn} 轮 · {clock(item.at)}</Text>
          </View>
          {item.seq !== null && onOpenRef ? <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} /> : null}
        </View>;
        return item.seq !== null && onOpenRef ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={`${item.title}，${item.detail}，查看原始记录`} onPress={() => onOpenRef(item.seq!)} style={state => ({ opacity: state.pressed ? 0.7 : 1 })}>{body}</Pressable> : <View key={index}>{body}</View>;
      })}
    </View>
    {digest.highlights.length > 8 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "pink", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? "收起" : `展开全部（还有 ${digest.highlights.length - 8} 条）`}</Text>
    </Pressable> : null}
  </Card>;
}

/** A barcode of the turn: one block per step, width by duration. */
function PhaseStrip({ theme, segments }: { theme: PluginTheme; segments: readonly DigestSegment[] }) {
  return <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", gap: 1, backgroundColor: trackFor(theme) }}>
    {segments.map((segment, index) => <View key={index} style={{ flexGrow: Math.max(1, segment.end - segment.start), flexBasis: 0, minWidth: 2, backgroundColor: segmentColor(theme, segment), opacity: segment.lane === "model" ? 0.55 : 1 }} />)}
  </View>;
}

/** 按轮回顾: newest turn first. */
function Turns({ theme, digest, now, onZoom, onOpenRef }: { theme: PluginTheme; digest: Digest; now: number; onZoom: (turn: number) => void; onOpenRef?: OpenRef }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = [...digest.turns].reverse(), shown = expanded ? ordered : ordered.slice(0, 4);
  if (!ordered.length) return null;
  return <Card theme={theme} title="按轮回顾" icon="Rows3" color="cyan" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{digest.turns.length} 轮</Text>}>
    <View style={{ gap: space.md }}>
      {shown.map(turn => {
        const look = outcomeLooks[turn.outcome], span = turnSpan(turn, now), segments = digest.segments.filter(segment => segment.turn === turn.index);
        const first = segments.find(segment => segment.seq !== null);
        const stats = [turn.tools ? `工具 ${turn.tools} 次${turn.failures ? `（失败 ${turn.failures}）` : ""}` : null, turn.files ? `改 ${turn.files} 个文件 +${bigNumber(turn.added)} −${bigNumber(turn.removed)}` : null,
          turn.checksPassed + turn.checksFailed ? `检查 ${turn.checksPassed}/${turn.checksPassed + turn.checksFailed} 通过` : null, turn.time.wait ? `等审批 ${shortDuration(turn.time.wait)}` : null].filter(Boolean);
        return <View key={turn.index} style={{ gap: 6, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: hue(theme, look.hue, turn.outcome === "failed" || turn.outcome === "running" ? "line" : "soft"), backgroundColor: turn.outcome === "failed" ? hue(theme, "red", "soft") : "transparent" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <View style={[{ flexDirection: "row", alignItems: "center", gap: 3, height: 22, paddingHorizontal: 8, borderRadius: radius.full }, gradient(theme, [look.hue === "gray" ? "gray" : look.hue, look.hue === "gray" ? "gray" : look.hue === "green" ? "teal" : look.hue === "red" ? "pink" : "sky"], { angle: 120 })]}>
              <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "900" }}>#{turn.index}</Text>
              <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "700" }}>{look.label}</Text>
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{clock(turn.start)} · {shortDuration(span.end - span.start) || "<1 秒"}</Text>
            <View style={{ flex: 1 }} />
            {turn.tokens ? <Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{bigNumber(tokenTotal(turn.tokens))} tokens</Text> : null}
          </View>
          <Text numberOfLines={3} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "700", lineHeight: 21 }}>{plain(turn.prompt) || "（没有找到这一轮的提问）"}</Text>
          {segments.length ? <Pressable accessibilityRole="button" accessibilityLabel={`在时间轴上放大第 ${turn.index} 轮`} onPress={() => onZoom(turn.index)}><PhaseStrip theme={theme} segments={segments} /></Pressable> : null}
          {stats.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{stats.join(" · ")}</Text> : null}
          {turn.reply ? <Text numberOfLines={3} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>↳ {plain(turn.reply)}</Text> : null}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button theme={theme} size="sm" icon="ChartGantt" label="放大看" onPress={() => onZoom(turn.index)} />
            {first && onOpenRef ? <Button theme={theme} size="sm" variant="ghost" icon="ListTree" label="原始记录" onPress={() => onOpenRef(first.seq!)} /> : null}
          </View>
        </View>;
      })}
    </View>
    {ordered.length > 4 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "cyan", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? "收起" : `显示更早的 ${ordered.length - 4} 轮`}</Text>
    </Pressable> : null}
  </Card>;
}

function Files({ theme, digest }: { theme: PluginTheme; digest: Digest }) {
  const [expanded, setExpanded] = useState(false);
  if (!digest.files.length) return null;
  const shown = expanded ? digest.files : digest.files.slice(0, 8), max = Math.max(1, ...digest.files.map(file => file.reads + file.edits));
  return <Card theme={theme} title="动过的文件" icon="FolderGit2" color="green" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{digest.files.length} 个</Text>}>
    <View>
      {shown.map(file => { const { dir, name } = splitPath(file.path);
        return <View key={file.path} style={{ gap: 4, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name={file.edits ? "FilePen" : "FileText"} size={14} color={hue(theme, file.edits ? "green" : "blue")} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.small }}><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{name}</Text>{dir ? <Text style={{ color: theme.colors.foregroundMuted }}>  {dir.replace(/\/$/, "")}</Text> : null}</Text>
            {file.added || file.removed ? <Text style={{ fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}><Text style={{ color: hue(theme, "green", "text") }}>+{bigNumber(file.added)}</Text> <Text style={{ color: hue(theme, "red", "text") }}>−{bigNumber(file.removed)}</Text></Text> : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginLeft: 14 + space.sm }}>
            <View style={{ flexDirection: "row", width: `${Math.max(6, (file.reads + file.edits) / max * 60)}%`, height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}>
              {file.reads ? <View style={{ flexGrow: file.reads, backgroundColor: hue(theme, "blue") }} /> : null}
              {file.edits ? <View style={{ flexGrow: file.edits, backgroundColor: hue(theme, "green") }} /> : null}
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[file.reads ? `读 ${file.reads}` : null, file.edits ? `改 ${file.edits}` : null, `第 ${file.turns.join("、")} 轮`].filter(Boolean).join(" · ")}</Text>
          </View>
        </View>; })}
    </View>
    {digest.files.length > 8 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 4, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "green", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? "收起" : `展开全部（还有 ${digest.files.length - 8} 个）`}</Text>
    </Pressable> : null}
  </Card>;
}

function Commands({ theme, digest, onOpenRef }: { theme: PluginTheme; digest: Digest; onOpenRef?: OpenRef }) {
  if (!digest.commands.length && !digest.checks.length) return null;
  const kinds = [...new Set(digest.checks.map(check => check.kind))], max = Math.max(1, ...digest.commands.map(command => command.runs));
  return <Card theme={theme} title="命令与检查" icon="SquareTerminal" color="orange">
    {kinds.length ? <View style={{ gap: 8 }}>
      {kinds.map(kind => { const runs = digest.checks.filter(check => check.kind === kind), last = runs.filter(check => check.ok !== null).at(-1), failed = runs.filter(check => check.ok === false).length;
        return <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ width: 64, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{checkNames[kind]}</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {runs.map((check, index) => { const color = check.ok === null ? "blue" : check.ok ? "green" : "red";
              const mark = <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, color) }}>
                <Icon name={check.ok === null ? "LoaderCircle" : check.ok ? "Check" : "X"} size={12} color="#ffffff" />
              </View>;
              return check.seq !== null && onOpenRef ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={`${checkNames[kind]}第 ${index + 1} 次，${check.ok === null ? "进行中" : check.ok ? "通过" : "失败"}：${check.command}`} onPress={() => onOpenRef(check.seq!)}>{mark}</Pressable> : <View key={index}>{mark}</View>; })}
          </View>
          <Text style={{ color: last?.ok ? hue(theme, "green", "text") : failed ? hue(theme, "red", "text") : theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "700" }}>{last ? last.ok ? failed ? `失败 ${failed} 次后通过` : "通过" : "未通过" : "进行中"}</Text>
        </View>; })}
    </View> : null}
    {digest.commands.length ? <View style={{ gap: 6, borderTopWidth: kinds.length ? hairline : 0, borderTopColor: theme.colors.border, paddingTop: kinds.length ? space.sm : 0 }}>
      {digest.commands.slice(0, 10).map(command => <View key={command.program} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} style={{ width: 72, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700", fontFamily: "monospace" }}>{command.program}</Text>
        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: trackFor(theme), overflow: "hidden", flexDirection: "row" }}>
          <View style={{ width: `${(command.runs - command.failures) / max * 100}%`, backgroundColor: hue(theme, "orange") }} />
          <View style={{ width: `${command.failures / max * 100}%`, backgroundColor: hue(theme, "red") }} />
        </View>
        <Text numberOfLines={1} style={{ minWidth: 96, flexShrink: 0, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{command.runs} 次{command.failures ? ` · 败 ${command.failures}` : ""} · {shortDuration(command.ms) || "<1 秒"}</Text>
      </View>)}
    </View> : null}
  </Card>;
}

function Tokens({ theme, digest }: { theme: PluginTheme; digest: Digest }) {
  const [metric, setMetric] = useState<"output" | "input" | "speed">("output");
  const tokens = digest.tokens;
  if (!tokens?.calls.length) return null;
  const colors = { output: hue(theme, "pink"), input: hue(theme, "green"), speed: hue(theme, "cyan") };
  return <Card theme={theme} title="每次模型调用" icon="Coins" color="amber" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel="调用指标" options={[{ value: "output", label: "输出" }, { value: "input", label: "读入" }, { value: "speed", label: "速率" }]} />}>
    <StackedColumns key={metric} theme={theme} height={110} colors={[colors[metric]]} names={[metric === "output" ? "输出" : metric === "input" ? "读入上下文" : "tok/s"]} format={metric === "speed" ? value => perSecond(value) : bigNumber}
      columns={tokens.calls.map(([at, output, input, speed]) => ({ label: clock(at), detail: clock(at, true), parts: [metric === "output" ? output : metric === "input" ? input : speed ?? 0] }))} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{metric === "input" ? "每次调用读入的上下文（含缓存），越往后越大说明对话越来越长。" : metric === "speed" ? "每次调用的输出速率；空白是响应太快或缺少开始时间。" : "每次调用写出的 token；高柱多半是长回复或大段代码。"}</Text>
  </Card>;
}

export interface AgentDigestProps {
  theme: PluginTheme; compact: boolean; digest?: Digest; loading: boolean; error?: string; onRefresh: () => void;
  /** Jump to the raw row in 时间线 (canonical seq in the digest's epoch). */
  onOpenSeq?: (epoch: string, seq: number) => void; header?: ReactNode; inset?: number;
}
/** 复盘: the agent's whole execution folded into where the time went, a timeline, key moments and per-turn summaries. */
export function AgentDigest({ theme, compact, digest, loading, error, onRefresh, onOpenSeq, header, inset = space.lg }: AgentDigestProps) {
  const now = useClock(digest?.running ? 5000 : 60_000);
  const [width, setWidth] = useState(0);
  const wide = width >= 820, columns = width >= 820 ? 4 : width >= 520 ? 3 : 2;
  const pair = (left: ReactNode, right: ReactNode) => wide ? <View style={{ flexDirection: "row", gap: space.lg, alignItems: "flex-start" }}><View style={{ flex: 1.15, minWidth: 0, gap: space.lg }}>{left}</View><View style={{ flex: 1, minWidth: 0, gap: space.lg }}>{right}</View></View> : <>{left}{right}</>;
  const [zoom, setZoom] = useState<number | null>(null);
  const scroll = useRef<{ scrollTo: (options: { y: number; animated?: boolean }) => void } | null>(null), ganttY = useRef(0);
  const openRef = digest?.epoch && onOpenSeq ? (seq: number) => onOpenSeq(digest.epoch!, seq) : undefined;
  const zoomTo = (turn: number | null) => { setZoom(turn); if (turn !== null) scroll.current?.scrollTo({ y: Math.max(0, ganttY.current - space.md), animated: true }); };
  let body: ReactNode;
  if (!digest) body = loading ? <Skeleton theme={theme} rows={6} /> : <EmptyState theme={theme} icon={error ? "WifiOff" : "ChartGantt"} tone={error ? "danger" : "info"} title={error ? "复盘暂时读不到" : "还没有复盘"} message={error ?? "执行记录读完后会在这里汇总"} action={{ label: "重试", onPress: onRefresh, icon: "RefreshCw" }} />;
  else if (!digest.turns.length) body = <EmptyState theme={theme} icon="ChartGantt" title="还没有可复盘的执行记录" message="这个会话还没有完整的对话轮次" />;
  else body = <>
    {error ? <Banner theme={theme} tone="warning" message={`复盘刷新失败，显示的是上次结果：${error}`} action={{ label: "重试", onPress: onRefresh }} /> : null}
    {digest.coverage.truncated ? <Banner theme={theme} tone="info" message={`会话很长，只汇总了最近的 ${bigNumber(digest.coverage.rows)} 条执行记录。`} /> : null}
    <Totals theme={theme} digest={digest} now={now} columns={columns} />
    <View onLayout={event => { ganttY.current = event.nativeEvent.layout.y; }}><Gantt theme={theme} digest={digest} compact={compact} now={now} zoom={zoom} onZoom={zoomTo} onOpenRef={openRef} /></View>
    {pair(<Highlights theme={theme} digest={digest} onOpenRef={openRef} />, <><TimeShare theme={theme} digest={digest} /><Commands theme={theme} digest={digest} onOpenRef={openRef} /></>)}
    <Turns theme={theme} digest={digest} now={now} onZoom={zoomTo} onOpenRef={openRef} />
    {pair(<Files theme={theme} digest={digest} />, <Tokens theme={theme} digest={digest} />)}
  </>;
  return <ScrollView ref={scroll as never} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl, gap: space.lg }}>
    {header}
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: 0 }} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: header ? 0 : space.md }}>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{digest ? `${digest.running ? "执行中 · " : ""}更新于 ${relativeTime(digest.generatedAt)}` : ""}</Text>
      <InfoButton theme={theme} title="关于复盘" lines={[
        "复盘由插件在服务端读取这个会话的完整执行记录后汇总，手机上只收到摘要。",
        "「思考」是一轮里既没有工具在跑、也没有等你审批的时间：模型在思考、写回复或准备下一步。",
        "几个工具同时跑时，这段时间按 等审批 › 命令 › 子 Agent › 联网 › 改文件 › 搜索 › 读文件 的顺序只算一次，所以各项加起来等于执行用时。",
        "检查按命令识别测试、类型检查、代码检查（lint）、构建和依赖安装；点色块或重点可以跳到原始记录。",
        "Token 来自本机 Claude Code / Codex 日志里这个会话的每次模型调用。",
      ]} />
      <IconButton theme={theme} icon="RefreshCw" label="刷新复盘" size="sm" onPress={onRefresh} />
    </View>
    {body}
  </ScrollView>;
}
