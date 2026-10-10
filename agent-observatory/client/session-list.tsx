import { memo, useMemo, type ReactNode, type Ref } from "react";
import { Pressable, Text, View, type FlatList as NativeFlatList, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { isUnreadCompletion, type AgentRecord, type AgentTreeNode } from "../shared/model";
import type { DashboardGroup, DashboardRow } from "../shared/dashboard-model";
import { HueDot, MetaLine, fontSize, hairline, hueFor, radius, relativeTime, space } from "./kit";
import { providerLine, readLabel, shortDuration, statusNames } from "./ui";
import { Flash, Pop, useChangeCount } from "./motion";
import { LiveTimer, PhasePill, PhaseTag, Spinner, StatusGlyph, activePhases, hueColor, phaseOf, phases, tint, tintAlpha, type Hue, type Phase } from "./status";
import { ScheduleBadge } from "./schedule-looks";

export const groupTitles: Record<DashboardGroup, string> = { attention: "需要处理", running: "执行中", recent: "最近" };
export type SessionItem =
  | { kind: "section"; key: string; group: DashboardGroup; title: string; count: number }
  | { kind: "row"; key: string; row: DashboardRow; childUnread: number; childRunning: number; snoozed: boolean };

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
export const countUnreadDescendants = (row: DashboardRow) => countDescendants(row, isUnreadCompletion);
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

/** Memoized: a clock tick re-renders only rows whose time label or signal changed; running timers tick on their own. */
export const SessionRow = memo(function SessionRow({ item, theme, compact, selected, expanded, timeLabel, signal, rate, onToggle, onSelect }: {
  item: Extract<SessionItem, { kind: "row" }>; theme: PluginTheme; compact: boolean; selected: boolean; expanded: boolean; timeLabel: string; signal?: string;
  /** Output tokens per second of a running agent (from the local provider logs), when it is writing. */
  rate?: number;
  onToggle: (agentId: string) => void; onSelect: (agentId: string) => void;
}) {
  const { colors } = theme;
  const { row, childUnread, childRunning, snoozed } = item;
  const agent = row.node.agent, children = row.node.children.length;
  const phase = phaseOf(agent, snoozed), active = activePhases.has(phase), color = hueColor(theme, phases[phase].hue), muted = phases[phase].hue === "muted";
  // Loud states tint the whole row a little; every coloured state keeps an edge in its colour.
  const wash = !selected && (phase === "approval" || phase === "error" || phase === "unread") ? tint(color, tintAlpha(theme) * 0.45) : undefined;
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
    <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${agent.title}，${statusNames[agent.status]}`} accessibilityState={{ selected }} onPress={() => onSelect(agent.id)}
      style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, paddingLeft: space.md, paddingRight: space.md, borderRadius: radius.md, opacity: row.context ? 0.62 : 1,
        backgroundColor: selected ? colors.surface2 : state.pressed || (state as { hovered?: boolean }).hovered ? colors.surface1 : wash ?? "transparent" })}>
      <Flash count={changes} color={tint(color, tintAlpha(theme) + 0.1)} radius={radius.md} />
      {!muted ? <View style={{ position: "absolute", left: 0, top: 11, bottom: 11, width: 3, borderRadius: 2, backgroundColor: color, opacity: active ? 1 : 0.7 }} /> : null}
      <View accessibilityLabel={readLabel(agent)} style={{ minHeight: 20, justifyContent: "center" }}>
        <Pop count={changes} size={16}><StatusGlyph theme={theme} phase={phase} /></Pop>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
          <Text numberOfLines={2} style={{ flex: 1, color: settled ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.body, lineHeight: 20, fontWeight: active ? "600" : "500" }}>{agent.title || "未命名 Agent"}</Text>
          <View style={{ minHeight: 20, justifyContent: "center", alignItems: "flex-end" }}>{trailing.node}</View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          {agent.background && phase === "running" ? <BackgroundChip theme={theme} agent={agent} /> : null}
          {rate && phase === "running" ? <View accessibilityLabel={`每秒输出 ${rate.toFixed(1)} 个 token`} style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 5, height: 18, borderRadius: radius.full, backgroundColor: tint(hueColor(theme, "orange"), tintAlpha(theme)) }}>
            <Icon name="Zap" size={10} color={hueColor(theme, "orange")} />
            <Text style={{ color: hueColor(theme, "orange", "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{rate >= 100 ? Math.round(rate) : rate.toFixed(1).replace(/\.0$/, "")} tok/s</Text>
          </View> : null}
          {agent.labels["paseo.schedule-id"] ? <ScheduleBadge theme={theme} /> : null}
          {depth === 0 ? <HueDot theme={theme} hue={hueFor(agent.projectName)} size={7} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[...meta, row.node.cycleBroken ? "父子关系成环，已断开" : null]} /></View>
        </View>
      </View>
    </Pressable>
    {children > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "收起" : "展开"} ${agent.title} 的子 agent`} accessibilityState={{ expanded }} onPress={() => onToggle(agent.id)} hitSlop={{ top: 6, bottom: 8, left: 6, right: 6 }}
      style={state => ({ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: space.xs, marginLeft: 32, marginTop: -6, marginBottom: space.xs, minHeight: 24, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface1 : "transparent" })}>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{children} 个子 Agent</Text>
      {childRunning > 0 ? <><Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>·</Text><Spinner size={10} color={hueColor(theme, "run")} /><Text style={{ color: hueColor(theme, "run", "text"), fontSize: fontSize.meta }}>{childRunning} 执行中</Text></> : null}
      {childUnread > 0 ? <Text style={{ color: hueColor(theme, "pink", "text"), fontSize: fontSize.meta, fontWeight: "600" }}>· {childUnread} 未读</Text> : null}
    </Pressable> : null}
  </View>;
});

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

export function SessionList({ items, theme, compact, selectedId, expanded, forceExpanded = false, now, signals, rates, empty, listRef, onScrollEnd, onToggle, onSelect }: {
  items: readonly SessionItem[]; theme: PluginTheme; compact: boolean; selectedId: string | null; expanded: ReadonlySet<string>; forceExpanded?: boolean; now: number; signals: ReadonlyMap<string, string>;
  rates?: ReadonlyMap<string, number>;
  empty: ReactNode; listRef?: Ref<NativeFlatList<SessionItem>>; onScrollEnd?: (offset: number) => void;
  onToggle: (agentId: string) => void; onSelect: (agentId: string) => void;
}) {
  // Rows re-render only when a shown rate changes (rounded to 0.1 tok/s).
  const ratesKey = useMemo(() => [...(rates ?? [])].map(([id, rate]) => `${id}:${rate.toFixed(1)}`).join(","), [rates]);
  const scrollEnd = onScrollEnd ? (event: NativeSyntheticEvent<NativeScrollEvent>) => onScrollEnd(event.nativeEvent.contentOffset.y) : undefined;
  return <FlatList ref={listRef} data={items as SessionItem[]} keyExtractor={item => item.key} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: space.xs, paddingBottom: space.xl }}
    onScrollEndDrag={scrollEnd} onMomentumScrollEnd={scrollEnd}
    initialNumToRender={18} maxToRenderPerBatch={20} windowSize={7} keyboardShouldPersistTaps="handled" extraData={`${now}:${selectedId}:${expanded.size}:${forceExpanded}:${signals.size}:${ratesKey}`}
    ListEmptyComponent={<View>{empty}</View>}
    renderItem={({ item }) => item.kind === "section" ? <GroupHeader theme={theme} group={item.group} title={item.title} count={item.count} />
      : <SessionRow item={item} theme={theme} compact={compact} selected={item.row.node.agent.id === selectedId} expanded={forceExpanded || expanded.has(item.row.node.agent.id)} timeLabel={agentTimeLabel(item.row.node.agent, now)}
        signal={signals.get(item.row.node.agent.id)} rate={rates?.get(item.row.node.agent.id)} onToggle={onToggle} onSelect={onSelect} />} />;
}
