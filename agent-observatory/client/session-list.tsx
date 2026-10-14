import { memo, useMemo, type ReactNode, type Ref } from "react";
import { Pressable, Text, View, type FlatList as NativeFlatList, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { contextPressure, type AgentRecord, type AgentTodo, type AgentTreeNode } from "../shared/model";
import type { DashboardGroup, DashboardRow } from "../shared/dashboard-model";
import { reasonLine, type AttentionPhase, type ReasonLine } from "../shared/attention";
import type { HeartbeatSummary } from "../shared/schedules";
import { HueDot, MetaLine, aria, fontSize, hairline, hueFor, radius, relativeTime, space } from "./kit";
import { providerLine, readLabel, shortDuration, stateName } from "./ui";
import { Flash, Pop, useChangeCount } from "./motion";
import { LiveTimer, PhasePill, PhaseTag, Spinner, StatusGlyph, activePhases, hueColor, loudPhases, phaseOf, phases, tint, tintAlpha, type Hue, type Phase } from "./status";
import { ScheduleBadge } from "./schedule-looks";
import { HeartbeatBadge } from "./heartbeat-card";
import { openExternalUrl } from "./open-url";

export const groupTitles: Record<DashboardGroup, string> = { attention: "需要处理", running: "执行中", recent: "最近" };
export type SessionItem =
  | { kind: "section"; key: string; group: DashboardGroup; title: string; count: number }
  /**
   * `childAttention`: descendants that need you, with the most urgent one's phase (`childPhase`), so a collapsed thread pulled
   * into 需要处理 says why; `childUnread`: the unread ones not among them (shared/attention.ts `threadAttention`).
   */
  | { kind: "row"; key: string; row: DashboardRow; childUnread: number; childAttention: number; childPhase: AttentionPhase | null; childRunning: number; snoozed: boolean };

/** Running turns show elapsed time; everything else the latest activity. */
export function agentTimeLabel(agent: AgentRecord, now: number): string {
  return agent.activeTurnStartedAt ? shortDuration(Math.max(0, now - Date.parse(agent.activeTurnStartedAt))) : relativeTime(agent.lastActivityAt || agent.updatedAt || agent.createdAt, now);
}
function countDescendants(row: DashboardRow, match: (agent: AgentRecord) => boolean): number {
  let count = 0;
  const stack: AgentTreeNode[] = [...row.node.children];
  while (stack.length) { const child = stack.pop()!; if (match(child.agent)) count++; stack.push(...child.children); }
  return count;
}
export const countRunningDescendants = (row: DashboardRow) => countDescendants(row, agent => agent.status === "running" || agent.status === "initializing");

/** What sits at the end of the title line: a ticking timer for live work, otherwise the state's own coloured tag. */
function trailingFor(agent: AgentRecord, phase: Phase, signal: string | undefined, theme: PluginTheme, timeLabel: string): { node: ReactNode; pill: boolean } {
  const pill = (hue: Hue, label: string, icon?: string, solid = false) => ({ node: <PhasePill theme={theme} hue={hue} label={label} icon={icon} solid={solid} />, pill: true });
  if (phase === "approval") return { node: <PhaseTag theme={theme} phase={phase} count={agent.pendingPermissionCount} />, pill: true };
  if (signal?.startsWith("失败")) return pill("red", signal, undefined, true);
  if (signal && phase === "running") return pill("amber", signal, "Clock3");
  if (phase === "running" && agent.activeTurnStartedAt) return { node: <LiveTimer since={agent.activeTurnStartedAt} color={hueColor(theme, "blue", "text")} />, pill: false };
  // Its own turn is over and subagents still work: 「后台」 with their run time when known.
  if (phase === "running" && agent.background) return { node: agent.background.since ? <LiveTimer since={agent.background.since} prefix="后台 " color={hueColor(theme, "blue", "text")} />
    : <Text style={{ color: hueColor(theme, "blue", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>后台执行中</Text>, pill: false };
  if (phase === "running" || phase === "starting") return { node: <Text style={{ color: hueColor(theme, phases[phase].hue, "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{phases[phase].label}</Text>, pill: false };
  if (phase === "closed" || phase === "canceled") return { node: <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{timeLabel}</Text>, pill: false };
  if (signal) return pill("amber", signal, "Clock3");
  return { node: <PhaseTag theme={theme} phase={phase} />, pill: true };
}

/** The one-line reason under a row that needs you (opus-B3); a plain 未读 / 待回复 without the host's note says nothing new. */
function rowReason(agent: AgentRecord, phase: Phase, now: number): ReasonLine | null {
  if (!activePhases.has(phase) || phase === "running" || phase === "starting") return null;
  if ((phase === "unread" || phase === "idle") && !agent.note) return null;
  return reasonLine(agent, now);
}

/** Memoized: a clock tick re-renders only rows whose time label or signal changed; running timers tick on their own. */
export const SessionRow = memo(function SessionRow({ item, theme, compact, selected, expanded, timeLabel, signal, rate, heartbeats, day, marked = false, onToggle, onSelect }: {
  item: Extract<SessionItem, { kind: "row" }>; theme: PluginTheme; compact: boolean; selected: boolean; expanded: boolean; timeLabel: string; signal?: string;
  /** Output tokens per second of a running agent (from the local provider logs), when it is writing. */
  rate?: number;
  /** Heartbeats that wake this Agent (opus-B8). */
  heartbeats?: readonly HeartbeatSummary[];
  /** The device's day (a limit's row: the clock): reasons say 明天 / 今天 relative to it. */
  day: number;
  /** Picked for 归档已读完成 and waiting for the confirmation (opus-B18). */
  marked?: boolean;
  onToggle: (agentId: string) => void; onSelect: (agentId: string) => void;
}) {
  const { colors } = theme;
  const { row, childUnread, childAttention, childPhase, childRunning, snoozed } = item;
  const agent = row.node.agent, children = row.node.children.length;
  const phase = phaseOf(agent, snoozed), active = activePhases.has(phase), color = hueColor(theme, phases[phase].hue), muted = phases[phase].hue === "muted";
  const reason = useMemo(() => rowReason(agent, phase, day), [agent, phase, day]);
  // A closed session's context matters only once it is loaded again, also when its row shows the turn the host cut off.
  const pressure = agent.archivedAt || agent.status === "closed" ? null : contextPressure(agent.usage);
  const link = agent.changeRequest ?? null;
  // Room the 「!128」 chip takes at the row's bottom right, so the meta or reason line never runs under it.
  const reserve = link ? 36 + 7 * link.label.length : 0;
  // Loud states tint the whole row a little; every coloured state keeps an edge in its colour.
  const marking = hueColor(theme, "red");
  const wash = marked ? tint(marking, tintAlpha(theme)) : !selected && loudPhases.has(phase) ? tint(color, tintAlpha(theme) * 0.45) : undefined;
  // A state change seen live flashes the row in the new state's color and pops its mark.
  const changes = useChangeCount(phase);
  const trailing = trailingFor(agent, phase, signal, theme, timeLabel);
  const depth = Math.min(row.depth, compact ? 3 : 6);
  const checkout = agent.branch ?? (agent.checkoutKind === "worktree" ? agent.worktreeName : null);
  // Time outranks provider/model: when the line truncates, the model goes first.
  const time = trailing.pill ? timeLabel : null;
  const meta = depth === 0 ? [agent.projectName, checkout, time, providerLine(agent)] : [time, providerLine(agent)];
  const settled = phase === "closed" || phase === "canceled" || phase === "snoozed";
  return <View style={depth ? { marginLeft: 16 + (depth - 1) * 22, paddingLeft: 6, borderLeftWidth: hairline, borderLeftColor: colors.border } : undefined}>
    {/* The row and its chip share a box of their own, so the chip sits on the row's last line, never on the 子 Agent toggle. */}
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${agent.title}，${stateName(agent)}${marked ? "，待归档" : ""}`} accessibilityState={{ selected }} {...aria({ selected })} onPress={() => onSelect(agent.id)}
        style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, paddingLeft: space.md, paddingRight: space.md, borderRadius: radius.md, opacity: row.context ? 0.62 : 1,
          backgroundColor: selected && !marked ? colors.surface2 : state.pressed || (state as { hovered?: boolean }).hovered ? colors.surface1 : wash ?? "transparent" })}>
        <Flash count={changes} color={tint(color, tintAlpha(theme) + 0.1)} radius={radius.md} />
        {marked ? <View style={{ position: "absolute", left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: marking }} />
          : !muted ? <View style={{ position: "absolute", left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: color, opacity: active ? 1 : 0.7 }} /> : null}
        <View accessibilityLabel={readLabel(agent)} style={{ minHeight: 20, justifyContent: "center" }}>
          <Pop count={changes} size={16}><StatusGlyph theme={theme} phase={phase} /></Pop>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
            <Text numberOfLines={2} style={{ flex: 1, color: settled ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.body, lineHeight: 20, fontWeight: active ? "600" : "500" }}>{agent.title || "未命名 Agent"}</Text>
            <View style={{ minHeight: 20, justifyContent: "center", alignItems: "flex-end" }}>{trailing.node}</View>
          </View>
          {/* Chips first; when they leave too little room the project and time wrap to their own line instead of vanishing. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 5, rowGap: 3, paddingRight: link && !reason ? reserve : 0 }}>
            {agent.background && phase === "running" ? <BackgroundChip theme={theme} agent={agent} /> : null}
            {agent.todo && phase === "running" ? <TodoChip theme={theme} todo={agent.todo} /> : null}
            {rate && phase === "running" ? <View accessibilityLabel={`每秒输出 ${rate.toFixed(1)} 个 token`} style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 5, height: 18, borderRadius: radius.full, backgroundColor: tint(hueColor(theme, "orange"), tintAlpha(theme)) }}>
              <Icon name="Zap" size={10} color={hueColor(theme, "orange")} />
              <Text style={{ color: hueColor(theme, "orange", "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{rate >= 100 ? Math.round(rate) : rate.toFixed(1).replace(/\.0$/, "")} tok/s</Text>
            </View> : null}
            {pressure ? <ContextChip theme={theme} percent={pressure.percent} critical={pressure.level === "critical"} /> : null}
            {heartbeats?.length ? <HeartbeatBadge theme={theme} heartbeats={heartbeats} /> : null}
            {agent.labels["paseo.schedule-id"] ? <ScheduleBadge theme={theme} /> : null}
            <View style={{ flex: 1, minWidth: 120, flexDirection: "row", alignItems: "center", gap: 5 }}>
              {depth === 0 ? <HueDot theme={theme} hue={hueFor(agent.projectName)} size={7} /> : null}
              <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[...meta, row.node.cycleBroken ? "父子关系成环，已断开" : null]} /></View>
            </View>
          </View>
          {reason ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0, paddingRight: reserve }}>
            <Icon name={reason.icon} size={12} color={hueColor(theme, reason.hue)} />
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: hueColor(theme, reason.hue, "text"), fontSize: fontSize.meta, lineHeight: 17, fontWeight: "600" }}>{reason.text}</Text>
          </View> : null}
        </View>
      </Pressable>
      {/* A sibling of the row, not inside it: web must not nest buttons. */}
      {link ? <ChangeRequestChip theme={theme} link={link} /> : null}
    </View>
    {children > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "收起" : "展开"} ${agent.title} 的子 agent`} accessibilityState={{ expanded }} {...aria({ expanded })} onPress={() => onToggle(agent.id)} hitSlop={{ top: 6, bottom: 8, left: 6, right: 6 }}
      style={state => ({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", alignSelf: "flex-start", gap: space.xs, marginLeft: 32, marginRight: space.sm, marginTop: -6, marginBottom: space.xs, minHeight: 24, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent" })}>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{children} 个子 Agent</Text>
      {childAttention > 0 && childPhase ? <ChildAttention theme={theme} count={childAttention} phase={childPhase} /> : null}
      {childRunning > 0 ? <><Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>·</Text><Spinner size={10} color={hueColor(theme, "run")} /><Text style={{ color: hueColor(theme, "run", "text"), fontSize: fontSize.meta }}>{childRunning} 执行中</Text></> : null}
      {childUnread > 0 ? <Text style={{ color: hueColor(theme, "pink", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>· {childUnread} 未读</Text> : null}
    </Pressable> : null}
  </View>;
});

/** 「· 2 个需要处理」 on a thread's 子 Agent line, in the most urgent one's colour and with its mark (P3-3). */
function ChildAttention({ theme, count, phase }: { theme: PluginTheme; count: number; phase: AttentionPhase }) {
  const look = phases[phase];
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>·</Text>
    <Icon name={look.icon} size={11} color={hueColor(theme, look.hue)} />
    <Text style={{ color: hueColor(theme, look.hue, "text"), fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count} 个需要处理</Text>
  </View>;
}

/** 「3/7 · 正在跑测试」: the running turn's todo list, how far it got and the step it is on (opus-B12). */
function TodoChip({ theme, todo }: { theme: PluginTheme; todo: AgentTodo }) {
  const color = hueColor(theme, "cyan"), text = hueColor(theme, "cyan", "text"), share = todo.total ? todo.done / todo.total : 0;
  return <View accessibilityLabel={`待办进度 ${todo.done}/${todo.total}${todo.current ? `，正在：${todo.current}` : ""}`}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, maxWidth: 240, paddingHorizontal: 6, height: 18, borderRadius: radius.full, backgroundColor: tint(color, tintAlpha(theme)) }}>
    <View style={{ width: 18, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: tint(color, 0.3) }}><View style={{ width: `${Math.round(share * 100)}%`, height: 4, backgroundColor: color }} /></View>
    <Text style={{ color: text, fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{todo.done}/{todo.total}</Text>
    {todo.current ? <Text numberOfLines={1} style={{ flexShrink: 1, color: text, fontSize: 11, fontWeight: "600" }}>· {todo.current}</Text> : null}
  </View>;
}

/** 「上下文 87%」 amber from 85 %, red from 95 % (opus-B13): the Agent is about to compact or run out of room. */
function ContextChip({ theme, percent, critical }: { theme: PluginTheme; percent: number; critical: boolean }) {
  const hue: Hue = critical ? "red" : "amber", color = hueColor(theme, hue);
  return <View accessibilityLabel={`上下文已用 ${percent}%${critical ? "，即将用满" : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 18, paddingHorizontal: 6, borderRadius: radius.full, backgroundColor: critical ? color : tint(color, tintAlpha(theme)) }}>
    <Icon name="Gauge" size={10} color={critical ? "#ffffff" : color} />
    <Text style={{ color: critical ? "#ffffff" : hueColor(theme, hue, "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>上下文 {percent}%</Text>
  </View>;
}

/** 「!42」 / 「#17」: the merge or pull request a reply linked to (opus-B16); opens in the browser. */
function ChangeRequestChip({ theme, link }: { theme: PluginTheme; link: NonNullable<AgentRecord["changeRequest"]> }) {
  const toast = useToast(), hue: Hue = link.kind === "mr" ? "indigo" : "blue", color = hueColor(theme, hue);
  const open = () => { void openExternalUrl(link.url).catch(() => toast.error("链接打不开，可在结果里复制")); };
  return <Pressable accessibilityRole="link" accessibilityLabel={`打开${link.kind === "mr" ? "合并请求" : "拉取请求"} ${link.label}`} onPress={open} hitSlop={6}
    style={state => ({ position: "absolute", right: space.md, bottom: 10, flexDirection: "row", alignItems: "center", gap: 3, height: 20, paddingHorizontal: 7, borderRadius: radius.full,
      backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? tint(color, tintAlpha(theme) + 0.12) : tint(color, tintAlpha(theme)), borderWidth: hairline, borderColor: tint(color, 0.45) })}>
    <Icon name={link.kind === "mr" ? "GitMerge" : "GitPullRequest"} size={11} color={color} />
    <Text style={{ color: hueColor(theme, hue, "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{link.label}</Text>
  </Pressable>;
}

/** 「后台 · 实现折叠」: what the subagents still running after the Agent's own turn work on. */
function BackgroundChip({ theme, agent }: { theme: PluginTheme; agent: AgentRecord }) {
  const background = agent.background!, color = hueColor(theme, "blue");
  const label = background.running > 1 ? `后台 ${background.running} 个子任务` : `后台 · ${background.labels[0] ?? "子任务"}`;
  return <View accessibilityLabel={`后台子任务 ${background.running} 个在执行${background.labels.length ? `：${background.labels.join("、")}` : ""}`}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, maxWidth: 220, paddingHorizontal: 6, height: 18, borderRadius: radius.full, backgroundColor: tint(color, tintAlpha(theme)) }}>
    <Spinner size={10} color={color} />
    <Text numberOfLines={1} style={{ flexShrink: 1, color: hueColor(theme, "blue", "text"), fontSize: 11, fontWeight: "700" }}>{label}</Text>
  </View>;
}

/** Group header with the group's own mark: a waiting hand, a spinner for work in progress, a clock for the rest. */
function GroupHeader({ theme, group, title, count }: { theme: PluginTheme; group: DashboardGroup; title: string; count: number }) {
  const { colors } = theme;
  const color = group === "attention" ? hueColor(theme, "warn") : group === "running" ? hueColor(theme, "run") : colors.foregroundMuted;
  return <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 32, paddingHorizontal: space.md, paddingTop: space.sm }}>
    {group === "running" ? <Spinner size={12} color={color} active={count > 0} /> : <Icon name={group === "attention" ? "BellRing" : "History"} size={12} color={color} />}
    <Text style={{ color: group === "recent" ? colors.foregroundMuted : group === "attention" ? hueColor(theme, "warn", "text") : hueColor(theme, "run", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>{title}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{count}</Text>
  </View>;
}

export function SessionList({ items, theme, compact, selectedId, expanded, forceExpanded = false, now, signals, rates, heartbeats, marked, empty, listRef, onScrollEnd, onToggle, onSelect }: {
  items: readonly SessionItem[]; theme: PluginTheme; compact: boolean; selectedId: string | null; expanded: ReadonlySet<string>; forceExpanded?: boolean; now: number; signals: ReadonlyMap<string, string>;
  rates?: ReadonlyMap<string, number>;
  heartbeats?: ReadonlyMap<string, HeartbeatSummary[]>;
  /** Rows waiting for the 归档 confirmation. */
  marked?: ReadonlySet<string>;
  empty: ReactNode; listRef?: Ref<NativeFlatList<SessionItem>>; onScrollEnd?: (offset: number) => void;
  onToggle: (agentId: string) => void; onSelect: (agentId: string) => void;
}) {
  // Rows re-render only when a shown rate changes (rounded to 0.1 tok/s).
  const ratesKey = useMemo(() => [...(rates ?? [])].map(([id, rate]) => `${id}:${rate.toFixed(1)}`).join(","), [rates]);
  const scrollEnd = onScrollEnd ? (event: NativeSyntheticEvent<NativeScrollEvent>) => onScrollEnd(event.nativeEvent.contentOffset.y) : undefined;
  return <FlatList ref={listRef} data={items as SessionItem[]} keyExtractor={item => item.key} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: space.xs, paddingBottom: space.xl }}
    onScrollEndDrag={scrollEnd} onMomentumScrollEnd={scrollEnd}
    initialNumToRender={18} maxToRenderPerBatch={20} windowSize={7} keyboardShouldPersistTaps="handled" extraData={`${now}:${selectedId}:${expanded.size}:${forceExpanded}:${signals.size}:${ratesKey}:${heartbeats?.size ?? 0}:${marked?.size ?? 0}`}
    ListEmptyComponent={<View>{empty}</View>}
    renderItem={({ item }) => {
      if (item.kind === "section") return <GroupHeader theme={theme} group={item.group} title={item.title} count={item.count} />;
      const id = item.row.node.agent.id, beats = heartbeats?.get(id);
      return <SessionRow item={item} theme={theme} compact={compact} selected={id === selectedId} expanded={forceExpanded || expanded.has(id)} timeLabel={agentTimeLabel(item.row.node.agent, now)}
        signal={signals.get(id)} rate={rates?.get(id)} heartbeats={beats} day={item.row.node.agent.stop ? now : dayOf(now)} marked={marked?.has(id) ?? false} onToggle={onToggle} onSelect={onSelect} />;
    }} />;
}
/** Midnight of the device's day: rows without a live clock re-render once a day for 明天 / 今天. */
const dayOf = (now: number) => { const date = new Date(now); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
