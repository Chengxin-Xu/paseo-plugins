import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type FlatList as NativeFlatList } from "react-native";
import { FlatList, Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { object, prettyValue, projectTimelineRows, string, timelineSummary, type TimelineRow } from "../shared/timeline";
import { Banner, Button, EmptyState, IconButton, MetaLine, Segmented, Skeleton, Spacer, SyncStatus, fontSize, hairline, radius, relativeTime, space, toneColor } from "./kit";
import { monoFont } from "./ui";
import { Spinner, hueColor } from "./status";
import { useTimeline } from "./use-timeline";
import { readingMemory } from "./reading-cache";

export function CodeBlock({ theme, label, value }: { theme: PluginTheme; label: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const { colors } = theme;
  const fullText = prettyValue(value);
  if (!fullText) return null;
  const long = fullText.length > 1600 || fullText.split("\n").length > 18;
  const shown = expanded || !long ? fullText : fullText.slice(0, 1600).split("\n").slice(0, 18).join("\n");
  return <View style={{ borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 32, paddingLeft: 10, paddingRight: 2, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{label}</Text>
      <IconButton theme={theme} size="sm" icon={copied ? "Check" : copyError ? "CircleAlert" : "Copy"} tone={copied ? "success" : copyError ? "danger" : undefined} label={`复制${label}`}
        onPress={() => { void copyText(fullText).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true)); }} />
    </View>
    <Text selectable style={{ paddingHorizontal: 10, paddingVertical: space.sm, color: colors.foreground, fontFamily: monoFont, fontSize: fontSize.meta, lineHeight: 18 }}>{shown}</Text>
    {copyError ? <Text style={{ paddingHorizontal: 10, paddingBottom: space.sm, color: colors.foregroundMuted, fontSize: fontSize.meta }}>复制失败，可长按文本选择</Text> : null}
    {long ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "收起内容" : "展开完整内容"} onPress={() => setExpanded(!expanded)}
      style={state => ({ minHeight: 34, paddingHorizontal: 10, justifyContent: "center", borderTopWidth: hairline, borderTopColor: colors.border, backgroundColor: (state as { hovered?: boolean }).hovered ? colors.surface2 : "transparent" })}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{expanded ? "收起" : `展开全部 · ${fullText.length.toLocaleString()} 字符`}</Text>
    </Pressable> : null}
  </View>;
}
function toolDetails(item: TimelineRow["item"]): Array<{ label: string; value: unknown }> {
  const detail = object(item.detail);
  const fields: Array<{ label: string; value: unknown }> = [];
  const append = (label: string, value: unknown) => { if (value !== undefined && value !== null && value !== "") fields.push({ label, value }); };
  append("命令", detail.command); append("工作目录", detail.cwd); append("文件", detail.filePath);
  append("搜索内容", detail.query); append("链接", detail.url); append("差异", detail.unifiedDiff);
  append("修改前", detail.oldString); append("修改后", detail.newString);
  append("输入参数", detail.input ?? item.input ?? item.arguments);
  append("执行输出", detail.output ?? detail.result ?? detail.content ?? detail.text);
  append("子任务日志", detail.log); append("子任务动作", detail.actions);
  append("子会话", detail.childSessionId); append("退出码", detail.exitCode);
  if (item.error) append("错误", item.error);
  if (!fields.length) append("工具数据", detail);
  return fields;
}
const toolLabel: Record<string, string> = { running: "执行中", completed: "成功", failed: "失败", canceled: "取消", loading: "处理中" };
export const TimelineEntry = memo(function TimelineEntry({ row, theme, memory, focused = false }: { row: TimelineRow; theme: PluginTheme; memory?: ReturnType<typeof readingMemory>; focused?: boolean }) {
  const [expanded, setExpandedLocal] = useState(memory?.expanded.has(row.key) ?? false);
  const setExpanded = (value: boolean) => { setExpandedLocal(value); if (memory) { if (value) memory.expanded.add(row.key); else memory.expanded.delete(row.key); } };
  const { colors } = theme;
  const item = row.item;
  const detail = object(item.detail);
  const tool = item.type === "tool_call";
  const failed = item.type === "error" || item.status === "failed" || item.level === "error";
  const reasoning = item.type === "reasoning";
  const human = item.type === "user_message";
  const icon = failed ? "CircleAlert" : tool && detail.type === "sub_agent" ? "GitBranch" : tool ? "Terminal" : reasoning ? "Brain" : human ? "User" : item.type === "todo" ? "ListChecks" : "Sparkles";
  const iconColor = failed ? colors.statusDanger : tool ? toneColor(theme, "accent", "mark") : human || reasoning ? colors.foregroundMuted : colors.foreground;
  const title = tool ? string(item.name) || "工具调用" : reasoning ? "推理摘要" : human ? "用户指令" : item.type === "assistant_message" ? "Agent 回复"
    : item.type === "todo" ? "任务计划" : item.type === "error" ? "执行错误" : item.type === "compaction" ? "上下文压缩" : item.type === "notification" ? "执行通知" : item.type === "plugin" ? `插件记录 · ${string(item.kind)}` : item.type;
  const clock = row.timestamp ? new Date(row.timestamp).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const text = timelineSummary(item);
  const expandable = tool || reasoning || text.length > 650 || item.type === "plugin";
  const state = string(item.status);
  // A tool that is still working spins in the running blue; results take their status colour.
  const working = state === "running" || state === "loading";
  const stateColor = working ? hueColor(theme, "run", "text") : state === "failed" ? hueColor(theme, "fail", "text") : state === "completed" ? hueColor(theme, "ok", "text") : colors.foregroundMuted;
  return <View style={{ flexDirection: "row", gap: space.md, paddingHorizontal: space.sm, marginHorizontal: -space.sm, borderRadius: radius.md, backgroundColor: focused ? colors.surface2 : "transparent" }}>
    <View style={{ width: 20, alignItems: "center", paddingTop: 4 }}>
      {working ? <Spinner size={14} color={stateColor} /> : <Icon name={icon} size={14} color={iconColor} />}
      <View style={{ width: hairline, flex: 1, minHeight: 8, marginTop: 6, backgroundColor: colors.border }} />
    </View>
    <View style={{ flex: 1, minWidth: 0, paddingBottom: space.lg, gap: space.xs }}>
      <Pressable disabled={!expandable} accessibilityRole={expandable ? "button" : undefined} accessibilityState={expandable ? { expanded } : undefined} accessibilityLabel={expandable ? `${expanded ? "收起" : "展开"}${title}` : title}
        onPress={() => setExpanded(!expanded)} hitSlop={{ top: 6, bottom: 6 }} style={state => ({ minHeight: 22, flexDirection: "row", gap: space.sm, alignItems: "center", opacity: state.pressed ? 0.7 : 1 })}>
        <Text numberOfLines={1} style={{ flex: 1, color: failed ? colors.statusDanger : colors.foreground, fontSize: fontSize.small, fontWeight: "500", fontFamily: tool ? monoFont : undefined }}>{title}</Text>
        {state ? <Text style={{ color: stateColor, fontSize: fontSize.meta }}>{toolLabel[state] ?? state}</Text> : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{clock}</Text>
        {expandable ? <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} color={colors.foregroundMuted} /> : null}
      </Pressable>
      {item.type === "todo" ? <View style={{ gap: space.xs + 2 }}>{(Array.isArray(item.items) ? item.items : []).map((task, index) => {
        const todo = object(task); const done = todo.completed === true || todo.status === "completed";
        return <View key={string(todo.id) || index} style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
          <View style={{ paddingTop: 3 }}><Icon name={done ? "CircleCheck" : todo.status === "in_progress" ? "CircleDot" : "Circle"} size={14} color={done ? colors.statusSuccess : colors.foregroundMuted} /></View>
          <Text style={{ flex: 1, color: done ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.small, lineHeight: 20, textDecorationLine: done ? "line-through" : "none" }}>{string(todo.text) || string(todo.activeForm)}</Text>
        </View>;
      })}</View> : <Text selectable numberOfLines={expandable && !expanded ? tool || reasoning ? 2 : 5 : undefined}
        style={{ color: failed ? colors.statusDanger : reasoning || human ? colors.foregroundMuted : colors.foreground, fontSize: tool ? fontSize.meta : fontSize.small, lineHeight: tool ? 18 : 20, ...(tool ? { fontFamily: monoFont } : {}) }}>{text}</Text>}
      {expanded && tool ? <View style={{ gap: space.sm, paddingTop: space.xs }}>{toolDetails(item).map(({ label, value }) => <CodeBlock key={label} theme={theme} label={label} value={value} />)}</View> : null}
      {expanded && item.type === "plugin" ? <CodeBlock theme={theme} label="插件数据" value={item.data} /> : null}
    </View>
  </View>;
});
const filters = [{ value: "all" as const, label: "全部" }, { value: "tools" as const, label: "工具" }, { value: "messages" as const, label: "对话" }, { value: "errors" as const, label: "异常" }];
type TimelineFilter = typeof filters[number]["value"];
export function TimelineContent({ timeline, theme, header, inset = space.lg, cacheKey = "default", focusRef }: { timeline: ReturnType<typeof useTimeline>; theme: PluginTheme; header?: ReactNode; inset?: number; cacheKey?: string; focusRef?: string | null }) {
  const paseo = usePaseo();
  const memory = useMemo(() => readingMemory(paseo, `timeline:${cacheKey}`), [paseo, cacheKey]);
  const [filter, setFilterLocal] = useState(memory.filter as TimelineFilter);
  const setFilter = (value: TimelineFilter) => { memory.filter = value; setFilterLocal(value); };
  const list = useRef<NativeFlatList<TimelineRow>>(null);
  const restoredScroll = useRef(false), focusedToken = useRef<string | null>(null), lastEpoch = useRef<string | null>(null), retryCount = useRef(0), mounted = useRef(true), retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (retryTimer.current) clearTimeout(retryTimer.current); }; }, []);
  useEffect(() => { if (timeline.page?.epoch && lastEpoch.current && lastEpoch.current !== timeline.page.epoch) { memory.scroll = 0; memory.expanded.clear(); } if (timeline.page?.epoch) lastEpoch.current = timeline.page.epoch; restoredScroll.current = false; }, [timeline.page?.epoch, cacheKey]);
  const presentedRows = useMemo(() => projectTimelineRows(timeline.page?.rows ?? []), [timeline.page?.rows]);
  const rows = presentedRows.filter(row => filter === "all" || filter === "tools" && row.item.type === "tool_call" || filter === "messages" && ["assistant_message", "user_message"].includes(row.item.type) || filter === "errors" && (row.item.type === "error" || row.item.status === "failed" || row.item.level === "error"));
  const [focusMissing, setFocusMissing] = useState(false), [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusAttempts = useRef(0);
  useEffect(() => { focusAttempts.current = 0; focusedToken.current = null; retryCount.current = 0; setFocusMissing(false); setFocusedKey(null); if (focusRef) setFilter("all"); }, [focusRef]);
  // A ref names a row by its first seq; merged tool rows can span other rows' seqs, so an exact start wins over containment.
  useEffect(() => { if (!focusRef || timeline.loading || focusedToken.current === focusRef) return; const parts = focusRef.split(":"); const range = parts.at(-1)?.split("-"); const seq = Number(range?.[0]); const epoch = parts.at(-2); const exact = rows.findIndex(row => row.epoch === epoch && row.seqStart === seq); const index = exact >= 0 ? exact : rows.findIndex(row => row.epoch === epoch && row.seqStart <= seq && row.seqEnd >= seq); if (index >= 0) { focusedToken.current = focusRef; setFocusMissing(false); setFocusedKey(rows[index]!.key); memory.expanded.add(rows[index]!.key); setTimeout(() => list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.1 }), 100); } else if (timeline.page?.hasOlder && focusAttempts.current < 12 && !timeline.loadingOlder) { focusAttempts.current++; timeline.loadOlder(); } else if (!timeline.loadingOlder) setFocusMissing(true); }, [focusRef, timeline.page, timeline.loading, timeline.loadingOlder]);
  const sync = timeline.error ? "error" : timeline.refreshing ? "syncing" : "live";
  return <FlatList ref={list} data={rows} keyExtractor={row => row.key} style={{ flex: 1, minHeight: 0 }} initialNumToRender={12} maxToRenderPerBatch={12} windowSize={5} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl }}
    onScroll={event => { memory.scroll = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100}
    onLayout={() => { if (!restoredScroll.current && !focusRef && memory.scroll > 0) { restoredScroll.current = true; list.current?.scrollToOffset({ offset: memory.scroll, animated: false }); } }}
    onScrollToIndexFailed={({ index, averageItemLength }) => { if (retryCount.current++ >= 3) return; list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false }); if (retryTimer.current) clearTimeout(retryTimer.current); retryTimer.current = setTimeout(() => { if (mounted.current) list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.1 }); }, 200); }}
    ListHeaderComponent={<View style={{ gap: space.md, paddingBottom: space.lg }}>{header}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: header ? 0 : space.md }}>
        <Segmented theme={theme} value={filter} onChange={setFilter} size="sm" options={filters} accessibilityLabel="时间线筛选" />
        <Spacer />
        <SyncStatus theme={theme} state={sync} label={timeline.live ? "实时" : timeline.lastSyncedAt ? relativeTime(timeline.lastSyncedAt) : "定期同步"} />
        <IconButton theme={theme} icon="RefreshCw" label="刷新执行时间线" size="sm" onPress={timeline.refresh} disabled={timeline.refreshing} />
      </View>
      {timeline.error ? <Banner theme={theme} tone="danger" message={`${timeline.error}，已读取的记录仍保留`} action={{ label: "重试", onPress: timeline.refresh }} /> : null}
      {timeline.page?.gap ? <Banner theme={theme} tone="warning" message="部分历史已不在宿主保留范围内，时间线可能不完整" /> : null}
      {focusMissing ? <Banner theme={theme} tone="warning" message="引用超出了当前保留的历史范围" /> : null}
      {timeline.page?.hasOlder ? <View style={{ alignItems: "flex-start" }}><Button theme={theme} icon="History" size="sm" label={timeline.loadingOlder ? "正在读取…" : "读取更早的记录"} accessibilityLabel="读取更早的记录" busy={timeline.loadingOlder} onPress={timeline.loadOlder} /></View> : null}
    </View>}
    ListEmptyComponent={timeline.loading ? <Skeleton theme={theme} rows={4} /> : <EmptyState theme={theme} icon="ListTree" title={filter === "errors" ? "当前窗口没有异常" : "暂无匹配的记录"} message="换个筛选，或读取更早的记录" />}
    renderItem={({ item }) => <TimelineEntry key={`${item.key}:${memory.expanded.has(item.key)}`} row={item} theme={theme} memory={memory} focused={item.key === focusedKey} />}
    ListFooterComponent={rows.length ? <View style={{ alignItems: "center", paddingTop: space.sm }}><MetaLine theme={theme} parts={[`${rows.length} 条`, timeline.page?.truncated ? "长会话只加载了最近的窗口" : "按执行顺序"]} /></View> : null} />;
}
