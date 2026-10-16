import { t } from "../shared/text";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { launchesRpc, type LaunchAgent, type LaunchRecord } from "../shared/launch";
import type { AgentDirectory } from "./agent-directory";
import { agentsOfItem, subAgents } from "./directory-index";
import { Button, fontSize, hairline, radius, relativeTime, space, toneColor } from "./kit";
import { LIVE_PHASES, PHASE_TONES, byRecent, launchEntries, launchPending, lastActivity, primaryLaunch, type LaunchEntry, type LaunchPhase } from "./launch-status";
import { Breathe, Ping } from "./motion";
import { useForeground } from "./use-foreground";

/** What cards and the detail need to show a note's launches: the live directory, the records, and how to open an agent. */
export interface LaunchLinks {
  directory: AgentDirectory;
  records(itemId: string): readonly LaunchRecord[] | undefined;
  /** Opens the agent in the app; absent where the client cannot navigate. */
  open?: (agentId: string) => void;
}

const phaseLabel = (phase: LaunchPhase): string => {
  switch (phase) {
    case "needs": return t("launchStatus.needs");
    case "failed": return t("launchStatus.failed");
    case "running": return t("launchStatus.running");
    case "starting": return t("launchStatus.starting");
    case "launching": return t("launchStatus.launching");
    case "check": return t("launchStatus.check");
    case "unread": return t("launchStatus.unread");
    case "idle": return t("launchStatus.idle");
    case "rejected": return t("launchStatus.rejected");
    case "ended": return t("launchStatus.ended");
  }
};

// One minute ticker for every relative time on screen, running only while something shows one.
let minute = 0;
const tickers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribeMinute(listener: () => void) {
  tickers.add(listener);
  timer ??= setInterval(() => { minute++; for (const tick of [...tickers]) tick(); }, 60_000);
  return () => { tickers.delete(listener); if (!tickers.size && timer) { clearInterval(timer); timer = undefined; } };
}
const idle = () => () => undefined;
/** Re-renders once a minute while `active` and the app is in front, so "3 minutes ago" stays true. */
function useMinute(active: boolean) {
  const foreground = useForeground();
  useSyncExternalStore(active && foreground ? subscribeMinute : idle, () => minute, () => minute);
}

/** What of the directory one note's launches depend on: a card re-renders only when this changes. */
function itemSignature(directory: AgentDirectory, itemId: string, agentIds: readonly string[]): string {
  const agents = agentsOfItem(directory, itemId);
  const part = (id: string) => { const agent = directory.get(id); return agent ? [agent.id, agent.status, agent.pending.join(), agent.attention, lastActivity(agent), agent.title, subAgents(directory, agent.id).map(child => child.status).join()].join("~") : `-${id}`; };
  return `${directory.ready()}|${agents.map(agent => part(agent.id)).join(";")}|${agentIds.map(part).join(";")}`;
}

/**
 * A note's launches from the shared directory, recomputed only when they change and only while the app is in front
 * (a card scrolled away is unmounted, so it stops too).
 */
export function useItemLaunches(directory: AgentDirectory, itemId: string, records: readonly LaunchRecord[] | undefined, agents?: readonly LaunchAgent[]): LaunchEntry[] {
  const foreground = useForeground();
  const named = useMemo(() => [...(records ?? []).flatMap(record => record.agentId ? [record.agentId] : []), ...(agents ?? []).map(agent => agent.agentId)], [records, agents]);
  const subscribe = useCallback((listener: () => void) => foreground ? directory.subscribe(listener) : () => undefined, [directory, foreground]);
  const snapshot = () => itemSignature(directory, itemId, named);
  const signature = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => launchEntries(directory, itemId, records, agents), [signature, directory, itemId, records, agents]);
}

type RecordList = { revision: string; records: LaunchRecord[] };
const NO_RECORDS: LaunchRecord[] = [];

/**
 * Launch records for every card on the board, read when the board shows and then only when something says they
 * changed: a launch started here, an agent launched elsewhere appearing in the directory, or (every 4 s) a launch
 * still being created. The server answers `unchanged` for a revision it still has, so a re-read costs a few bytes.
 */
export function useLaunchLinks({ directory, hostId, enabled, open }: { directory: AgentDirectory | undefined; hostId: string; enabled: boolean; open?: (agentId: string) => void }): LaunchLinks | undefined {
  const load = useRpc(launchesRpc), queryClient = useQueryClient(), foreground = useForeground();
  const queryKey = useMemo(() => ["project-notes", "launches", hostId], [hostId]);
  const active = !!directory && enabled && foreground;
  const query = useQuery({
    queryKey, enabled: active, retry: false, staleTime: 10_000, refetchOnWindowFocus: false,
    queryFn: async (): Promise<RecordList> => {
      const before = queryClient.getQueryData<RecordList>(queryKey);
      const update = await load(before ? { revision: before.revision } : {});
      if (!update.unchanged) return { revision: update.revision, records: update.records };
      if (before) return before;
      const full = await load({});
      return full.unchanged ? { revision: full.revision, records: [] } : { revision: full.revision, records: full.records };
    },
    refetchInterval: current => active && current.state.data?.records.some(launchPending) ? 4_000 : false,
  });
  const records = query.data?.records ?? NO_RECORDS;
  const byItem = useMemo(() => {
    const map = new Map<string, LaunchRecord[]>();
    for (const record of records) {
      if (!record.itemId) continue;
      const group = map.get(record.itemId);
      if (group) group.push(record); else map.set(record.itemId, [record]);
    }
    return map;
  }, [records]);
  // An agent launched from another app shows in the directory before this board has its record: read once for it.
  const known = useRef(new Set<string>()), asked = useRef(new Set<string>());
  known.current = new Set(records.map(record => record.launchId));
  useEffect(() => {
    if (!directory || !active) return;
    const check = () => {
      if (!directory.ready()) return;
      const unknown = directory.list().filter(agent => agent.itemId && agent.launchId && !known.current.has(agent.launchId) && !asked.current.has(agent.launchId));
      if (!unknown.length) return;
      for (const agent of unknown) asked.current.add(agent.launchId!);
      void queryClient.invalidateQueries({ queryKey });
    };
    check();
    return directory.subscribe(check);
  }, [directory, active, queryClient, queryKey]);
  return useMemo(() => directory ? { directory, records: (itemId: string) => byItem.get(itemId), open } : undefined, [directory, byItem, open]);
}

/** The status mark: blue rings for work going on, a breathing amber dot while it waits for the user, a hollow ring once ended. */
export function PhaseDot({ theme, phase, size = 8 }: { theme: PluginTheme; phase: LaunchPhase; size?: number }) {
  const tone = PHASE_TONES[phase], color = tone === "neutral" ? theme.colors.foregroundMuted : toneColor(theme, tone, "mark");
  const dot = <View style={phase === "ended" ? { width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: color } : { width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, flexShrink: 0 }}>
    {LIVE_PHASES.has(phase) ? <Ping size={size} color={color} /> : null}
    {phase === "needs" || phase === "check" ? <Breathe>{dot}</Breathe> : dot}
  </View>;
}

function summary(entries: readonly LaunchEntry[], primary: LaunchEntry): string[] {
  const others = entries.length - 1, children = entries.reduce((sum, entry) => sum + entry.children, 0);
  return [others > 0 ? t("launchStatus.more", { count: others }) : "", children ? t("launchStatus.children", { count: children }) : "", primary.at ? relativeTime(primary.at) : ""].filter(Boolean);
}

/**
 * The task card's line for what its launches are doing: a colored dot and the most urgent state (blue running, amber
 * needs you, green done unread, red failed, grey idle or ended), how many more, sub-agents, last activity. Pressing it
 * opens that agent. Nothing shows for a note that never launched.
 */
export function LaunchChip({ theme, links, itemId }: { theme: PluginTheme; links: LaunchLinks; itemId: string }) {
  const entries = useItemLaunches(links.directory, itemId, links.records(itemId));
  const primary = primaryLaunch(entries);
  useMinute(!!primary?.at);
  if (!primary) return null;
  const tone = PHASE_TONES[primary.phase], muted = theme.colors.foregroundMuted;
  const label = phaseLabel(primary.phase), rest = summary(entries, primary), spoken = [label, ...rest].join(t("ui.metaSeparator"));
  const openable = !!(primary.agentId && links.open && primary.phase !== "ended");
  const body = <>
    <PhaseDot theme={theme} phase={primary.phase} />
    <Text numberOfLines={1} style={{ flexShrink: 0, color: tone === "neutral" ? muted : toneColor(theme, tone), fontSize: fontSize.meta, lineHeight: 16, fontWeight: "600" }}>{label}</Text>
    {rest.length ? <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: muted, fontSize: fontSize.meta, lineHeight: 16 }}>{rest.join(t("ui.metaSeparator"))}</Text> : null}
    {openable ? <View style={{ flexShrink: 0 }}><Icon name="ArrowUpRight" size={12} color={muted} /></View> : null}
  </>;
  const frame = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs + 2, alignSelf: "flex-start" as const, maxWidth: "100%" as const, minHeight: 22, paddingHorizontal: space.sm, borderRadius: radius.full,
    borderWidth: hairline, borderColor: tone === "neutral" ? theme.colors.border : toneColor(theme, tone, "line"), backgroundColor: tone === "neutral" ? theme.colors.surface2 : toneColor(theme, tone, "soft") };
  if (!openable) return <View accessible accessibilityLabel={t("launchStatus.chipLabel", { status: spoken })} style={frame}>{body}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={t("launchStatus.openAgent", { status: spoken })} hitSlop={{ top: 6, bottom: 6 }} onPress={() => links.open!(primary.agentId!)}
    style={({ pressed }) => [frame, pressed ? { opacity: 0.75 } : null]}>{body}</Pressable>;
}

/**
 * Every launch of one note, newest first, in its detail: state, agent, sub-agents, when, and 打开. Reads the note's
 * records and its agents (archived ones too) when the detail opens; again every few seconds only while a launch is
 * still being created and the app is in front.
 */
export function LaunchHistory({ theme, links, itemId, hostId }: { theme: PluginTheme; links: LaunchLinks; itemId: string; hostId: string }) {
  const load = useRpc(launchesRpc), foreground = useForeground();
  const query = useQuery({
    queryKey: ["project-notes", "launches", hostId, "item", itemId], queryFn: () => load({ itemId }), enabled: foreground, retry: false, staleTime: 5_000, refetchOnWindowFocus: false,
    refetchInterval: current => { const data = current.state.data; return foreground && data && !data.unchanged && data.records.some(launchPending) ? 4_000 : false; },
  });
  const data = query.data && !query.data.unchanged ? query.data : undefined;
  const entries = useItemLaunches(links.directory, itemId, data?.records ?? links.records(itemId), data?.agents);
  useMinute(entries.length > 0);
  if (!entries.length) return null;
  const { colors } = theme;
  return <View testID="launch-history" style={{ gap: space.sm }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{t("launchStatus.historyTitle", { count: entries.length })}</Text>
    {[...entries].sort(byRecent).map(entry => {
      const tone = PHASE_TONES[entry.phase], openable = !!(entry.agentId && links.open && entry.phase !== "ended");
      const meta = [entry.provider, entry.children ? t("launchStatus.childrenRunning", { count: entry.children, running: entry.childrenRunning }) : "", entry.at ? relativeTime(entry.at) : ""].filter(Boolean).join(t("ui.metaSeparator"));
      return <View key={entry.key} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm + 2, borderRadius: radius.md, borderWidth: hairline,
        borderColor: tone === "neutral" ? colors.border : toneColor(theme, tone, "line"), backgroundColor: tone === "neutral" ? colors.surface1 : toneColor(theme, tone, "soft") }}>
        <PhaseDot theme={theme} phase={entry.phase} size={10} />
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "500" }}>
            <Text style={{ color: tone === "neutral" ? colors.foregroundMuted : toneColor(theme, tone), fontWeight: "600" }}>{phaseLabel(entry.phase)}</Text>
            {t("ui.metaSeparator")}{entry.title || (entry.agentId ? t("launchStatus.agentShort", { id: entry.agentId.slice(0, 8) }) : t("launchStatus.noAgent"))}
          </Text>
          {meta ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{meta}</Text> : null}
          {entry.error ? <Text selectable numberOfLines={3} style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 17 }}>{entry.error}</Text> : null}
        </View>
        {openable ? <Button theme={theme} label={t("launchStatus.open")} icon="ArrowUpRight" size="sm" accessibilityLabel={t("launchStatus.openAgent", { status: phaseLabel(entry.phase) })} onPress={() => links.open!(entry.agentId!)} /> : null}
      </View>;
    })}
  </View>;
}
