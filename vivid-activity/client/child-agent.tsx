import { useAgent, useRpc } from "@getpaseo/plugin/client";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { Button, StatusDot, type Tone } from "./kit";
import { Breathe } from "./motion";
import { useCardVisibility } from "./visibility";
import { useForeground } from "./use-foreground";
import {
  CHILD_QUIET_READ_MS,
  childFeedHold,
  childStatus,
  childFeedStart,
  childFeedStep,
  type CardVisibility,
  type ChildFeedEvent,
  type ChildFeedHold,
  type ChildFeedState,
} from "../shared/child-agent";
import type { ActivityPalette } from "../shared/presentation";
import { statusLabel } from "../shared/vivid-model";
import { childSummaryRpc, type ChildSummaryOutput, type ChildSummaryRow } from "../shared/child-summary";
import { createChildRefresh } from "./child-refresh";

type Theme = PluginTimelineItemProps["theme"];

interface ChildTimelineState {
  /** The child as the card's own handle last heard of it (a status check, a live update, a read); null: gone. */
  agent: ChildSummaryOutput["agent"];
  /** The handle has heard about the child at all; until then the app's agent list speaks for it. */
  heard: boolean;
  entries: readonly ChildSummaryRow[];
  loading: boolean;
  error: string | null;
  /** 0.6.0: the daemon could not say whether the child is loaded (its status check failed), so nothing was read. */
  unconfirmed: boolean;
}

const EMPTY_STATE: ChildTimelineState = {
  agent: null,
  heard: false,
  entries: [],
  loading: false,
  error: null,
  unconfirmed: false,
};

/** 0.5.0: what the card says while it does not read on its own (shared/child-agent.ts childFeedHold). */
const ASLEEP_NOTES: Partial<Record<NonNullable<ChildFeedHold>, string>> = {
  closed: "子 Agent 已关闭（没有加载），不自动读取它的动态：读取会让 Paseo 重新加载它。",
  unknown: "Agent 列表里没有这个子 Agent（可能已归档或删除），不自动读取它的动态。",
};
/** 0.6.0: the status check failed (connection, timeout), so the card could not tell whether reading would load the child. */
const UNCONFIRMED_NOTE = "暂时确认不了子 Agent 是否还加载着，先不自动读取它的动态；有新动静时会再确认。";

export function ChildAgentTimeline({
  agentId,
  theme,
  palette,
  styles,
}: {
  agentId: string;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const rootRef = useRef<View>(null);
  const visibility = useCardVisibility(rootRef);
  const foreground = useForeground();
  const feed = useChildFeed(agentId, foreground, visibility);
  const entries = feed.view.entries;
  const status = feed.status;
  const statusColor = status ? childStatusColor(status, palette) : palette.categoryColors.agent;
  const note = feed.hold ? ASLEEP_NOTES[feed.hold] : feed.view.unconfirmed ? UNCONFIRMED_NOTE : undefined;

  return (
    <View ref={rootRef} style={styles.childTimelineSection}>
      <View style={styles.childTimelineHeader}>
        <Text style={styles.detailLabel}>子 Agent 实时动态</Text>
        {status ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {status === "running" || status === "initializing" ? (
              <Breathe><StatusDot theme={theme} tone={childStatusTone(status)} size={7} /></Breathe>
            ) : (
              <StatusDot theme={theme} tone={childStatusTone(status)} size={7} />
            )}
            <Text style={[styles.paseoListItemMeta, { color: statusColor }]}>
              {statusLabel(status)}
            </Text>
          </View>
        ) : null}
      </View>
      {note ? (
        <View style={{ gap: 6, alignItems: "flex-start" }}>
          <Text style={styles.mutedText}>{note}</Text>
          <Button
            theme={theme}
            size="sm"
            tone="fuchsia"
            icon="Eye"
            label={entries.length > 0 ? "再读一次" : "查看动态"}
            accessibilityLabel={entries.length > 0 ? "再读一次子 Agent 动态" : "查看子 Agent 动态"}
            busy={feed.view.loading}
            onPress={feed.readNow}
          />
        </View>
      ) : null}
      {feed.view.error ? (
        <Text style={styles.empty}>读取子 Agent 动态失败：{feed.view.error}</Text>
      ) : feed.view.loading && entries.length === 0 ? (
        <Text style={styles.empty}>正在读取子 Agent 动态…</Text>
      ) : entries.length === 0 ? (
        note ? null : <Text style={styles.empty}>{feed.hold ? "正在读取子 Agent 动态…" : "子 Agent 还没有动态。"}</Text>
      ) : (
        <View style={styles.childTimelineList}>
          {entries.map((entry) => (
            <ChildTimelineRow
              key={entry.k}
              row={entry}
              palette={palette}
              styles={styles}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Reads compact summaries, driven by the host's Agent updates; never subscribes to a child timeline. */
export function useChildFeed(agentId: string, foreground: boolean, visibility: CardVisibility) {
  const rpc = useRpc(childSummaryRpc);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  // The app already maintains these Agent records; observing them adds no list/timeline subscription.
  const listed = useAgent(agentId, (agent) => agent.status);
  const stamp = useAgent(agentId, (agent) => `${agent.status}|${agent.updatedAt}|${agent.lastActivityAt}`);
  const [view, setView] = useState<ChildTimelineState>(EMPTY_STATE);
  const status = childStatus({ heard: view.heard, agent: view.agent, listed });
  const hold = childFeedHold({ foreground, visibility, status });
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const runningRef = useRef(false);
  const dispatchRef = useRef<((event: ChildFeedEvent) => void) | null>(null);
  const previousSignal = useRef({ agentId, listed, stamp });

  useEffect(() => {
    let disposed = false;
    const start = childFeedStart(holdRef.current);
    let state: ChildFeedState = start.state;
    setView(EMPTY_STATE);
    const refresh = createChildRefresh({
      allowed: () => holdRef.current === null,
      async read(manual, statusOnly) {
        if (disposed) return;
        if (agentId.startsWith("provider:")) {
          setView({ ...EMPTY_STATE, heard: true });
          return;
        }
        const version = state.version;
        setView((current) => ({ ...current, loading: !statusOnly, error: null }));
        try {
          const response = await rpcRef.current({ agentId, manual, statusOnly });
          if (disposed) return;
          // A newer host update already queued a catch-up. An older closed/missing answer must not close its gate
          // before it runs. Successful previews can still be shown during a continuous stream of newer updates.
          if (version !== state.version && (response.status !== "ok" || response.agent?.status === "closed")) {
            setView((current) => ({ ...current, loading: false }));
            return;
          }
          // 0.6.0 (grok-F9, pi-F2): the daemon could not confirm the child is loaded, so the server read nothing. Not a
          // read: the next host update or hold change asks again.
          if (response.status === "unconfirmed") {
            setView((current) => ({ ...current, loading: false, unconfirmed: true }));
            return;
          }
          if (!statusOnly) state = childFeedStep(state, { type: "read", version }).state;
          setView((current) => ({
            agent: response.agent, heard: true,
            entries: statusOnly || response.status !== "ok" ? current.entries : response.rows,
            loading: false, error: null, unconfirmed: false,
          }));
        } catch (error) {
          if (!disposed) setView((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
        }
      },
    });
    const dispatch = (event: ChildFeedEvent): void => {
      if (disposed) return;
      const step = childFeedStep(state, event);
      state = step.state;
      if (step.check) refresh.request({ statusOnly: true, immediate: event.type === "changed" && event.immediate });
      if (!step.read) return;
      const manual = event.type === "manual";
      const immediate = manual || (event.type === "changed" && event.immediate) || event.type === "hold";
      refresh.request({ manual, immediate, quiet: event.type === "quiet" });
    };
    dispatchRef.current = dispatch;
    if (start.read) refresh.request({ immediate: true });
    return () => { disposed = true; dispatchRef.current = null; refresh.dispose(); };
  }, [agentId]);

  useEffect(() => {
    dispatchRef.current?.({ type: "hold", hold, running: runningRef.current });
  }, [hold]);
  useEffect(() => {
    runningRef.current = status === "running" || status === "initializing";
  }, [status]);
  // 0.6.0-local.5: host updates are the signal, but a running child need not send any (an ACP child reporting no usage
  // sends none until its turn ends), and the card would stand still. While it runs and the card may read, ten quiet
  // seconds read once more; each host update starts the quiet spell again, so a child that reports reads as before.
  // codex-vivid-merge-F1: the quiet spell is not a host update, so it leaves an answer on its way current (a 「closed」
  // that takes 11 s still closes the card), and it adds nothing while a read is on its way or queued.
  useEffect(() => {
    if (hold !== null || !(status === "running" || status === "initializing")) return;
    const timer = setInterval(() => dispatchRef.current?.({ type: "quiet" }), CHILD_QUIET_READ_MS);
    return () => clearInterval(timer);
  }, [hold, status, stamp]);
  useEffect(() => {
    const previous = previousSignal.current;
    previousSignal.current = { agentId, listed, stamp };
    if (previous.agentId !== agentId || (previous.listed === listed && previous.stamp === stamp)) return;
    dispatchRef.current?.({ type: "changed", immediate: previous.listed !== listed });
  }, [agentId, listed, stamp]);

  const readNow = useCallback(() => dispatchRef.current?.({ type: "manual" }), []);
  return { view, status, hold, readNow };
}

function ChildTimelineRow({ row, palette, styles }: { row: ChildSummaryRow; palette: ActivityPalette; styles: ActivityStyles }) {
  const color = row.c === "failed" ? palette.statusColors.failed : palette.categoryColors[row.c];
  const statusColor = row.s === "running" || row.s === "completed" || row.s === "failed" || row.s === "canceled"
    ? palette.statusColors[row.s] : color;
  return (
    <View style={styles.childTimelineItem}>
      <Icon name={row.i} color={color} size={11} />
      <Text numberOfLines={1} style={styles.childTimelineItemTitle}>{row.t}</Text>
      {row.x ? <Text numberOfLines={1} style={styles.childTimelineItemSummary}>{row.x}</Text> : null}
      {row.s ? <Text style={[styles.childTimelineItemMeta, { color: statusColor }]}>{statusLabel(row.s)}</Text> : null}
    </View>
  );
}

function childStatusColor(status: string, palette: ActivityPalette): string {
  switch (status) {
    case "running":
    case "initializing":
      return palette.statusColors.running;
    case "idle":
      return palette.statusColors.completed;
    case "error":
      return palette.statusColors.failed;
    default:
      return palette.statusColors.canceled;
  }
}

/** Running blue, idle green, error red, closed grey: the plugin's state colours. */
function childStatusTone(status: string): Tone {
  switch (status) {
    case "running":
    case "initializing":
      return "info";
    case "idle":
      return "success";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}
