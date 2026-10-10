import { usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import React, { useEffect, useMemo, useState } from "react";

// 0.4.0: the agent types come from the host SDK's `usePaseo()` rather than an `@getpaseo/client` import. Paseo compiles
// plugins on the daemon and every type import must resolve there, so importing `@getpaseo/client` would make it (and its
// WebSocket/relay dependencies) a runtime install for two type aliases.
type PaseoAgentHandle = ReturnType<ReturnType<typeof usePaseo>["agents"]["ref"]>;
type PaseoAgent = NonNullable<ReturnType<PaseoAgentHandle["current"]>>;
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import {
  childTimelineEntryKey,
  recentChildTimelineEntries,
} from "../shared/child-agent";
import {
  formatReasoningText,
  resolveToolCallPresentation,
  type ActivityPalette,
} from "../shared/presentation";
import { statusLabel, zh } from "../shared/vivid-model";

const NOTIFICATION_LEVELS: Partial<Record<string, string>> = { info: "通知", warning: "警告", warn: "警告", error: "错误", success: "成功" };

const CHILD_TIMELINE_PAGE_SIZE = 100;
const MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES = 3;

type TimelineEntry = Awaited<
  ReturnType<PaseoAgentHandle["timeline"]["refetch"]>
>["entries"][number];

interface ChildTimelineState {
  agent: PaseoAgent | null;
  entries: readonly TimelineEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: ChildTimelineState = {
  agent: null,
  entries: [],
  loading: true,
  error: null,
};

export function ChildAgentTimeline({
  agentId,
  palette,
  styles,
}: {
  agentId: string;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const state = useChildTimeline(agentId);
  const entries = useMemo(
    () => recentChildTimelineEntries(state.entries).slice(-MAX_VISIBLE_CHILD_ACTIVITY_ENTRIES),
    [state.entries],
  );
  const statusColor = state.agent
    ? childStatusColor(state.agent.status, palette)
    : palette.categoryColors.agent;

  return (
    <View style={styles.childTimelineSection}>
      <View style={styles.childTimelineHeader}>
        <Text style={styles.detailLabel}>子 Agent 实时动态</Text>
        {state.agent?.status ? (
          <Text style={[styles.paseoListItemMeta, { color: statusColor }]}>
            {statusLabel(state.agent.status)}
          </Text>
        ) : null}
      </View>
      {state.error ? (
        <Text style={styles.empty}>读取子 Agent 动态失败：{state.error}</Text>
      ) : state.loading && entries.length === 0 ? (
        <Text style={styles.empty}>正在读取子 Agent 动态…</Text>
      ) : entries.length === 0 ? (
        <Text style={styles.empty}>子 Agent 还没有动态。</Text>
      ) : (
        <View style={styles.childTimelineList}>
          {entries.map((entry) => (
            <ChildTimelineRow
              key={childTimelineEntryKey(entry)}
              item={entry.item}
              palette={palette}
              styles={styles}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function useChildTimeline(agentId: string): ChildTimelineState {
  const paseo = usePaseo();
  const [state, setState] = useState<ChildTimelineState>(EMPTY_STATE);

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let disposed = false;
    let refreshing = false;
    let refreshQueued = false;

    setState(EMPTY_STATE);

    const refresh = async (): Promise<void> => {
      if (disposed) return;
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const response = await handle.timeline.refetch({
          direction: "tail",
          limit: CHILD_TIMELINE_PAGE_SIZE,
          projection: "projected",
        });
        if (disposed) return;
        setState({
          agent: response.agent ?? handle.current(),
          entries: response.entries,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (disposed) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        refreshing = false;
        if (!disposed && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    };

    const unsubscribeTimeline = handle.timeline.subscribe((event) => {
      if (event.event.type === "timeline" || event.event.type === "replacement") {
        void refresh();
      }
    });
    const unsubscribeAgent = handle.subscribe((update) => {
      if (disposed) return;
      setState((current) => ({
        ...current,
        agent: update.kind === "upsert" ? update.agent : null,
      }));
    });

    void refresh();

    return () => {
      disposed = true;
      unsubscribeTimeline();
      unsubscribeAgent();
    };
  }, [agentId, paseo]);

  return state;
}

function ChildTimelineRow({
  item,
  palette,
  styles,
}: {
  item: AgentTimelineItem;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const row = childTimelineRow(item, palette);
  return (
    <View style={styles.childTimelineItem}>
      <Icon name={row.icon} color={row.color} size={11} />
      <Text numberOfLines={1} style={styles.childTimelineItemTitle}>
        {row.title}
      </Text>
      {row.summary ? (
        <Text numberOfLines={1} style={styles.childTimelineItemSummary}>
          {row.summary}
        </Text>
      ) : null}
      {row.status ? (
        <Text style={[styles.childTimelineItemMeta, { color: row.statusColor }]}>
          {statusLabel(row.status)}
        </Text>
      ) : null}
    </View>
  );
}

interface ChildTimelineRowModel {
  icon: string;
  title: string;
  summary?: string;
  color: string;
  status?: string;
  statusColor?: string;
}

function childTimelineRow(
  item: AgentTimelineItem,
  palette: ActivityPalette,
): ChildTimelineRowModel {
  switch (item.type) {
    case "reasoning":
      return {
        icon: "Brain",
        title: "思考",
        summary: compactText(formatReasoningText(item.text)),
        color: palette.categoryColors.reasoning,
      };
    case "tool_call": {
      const presentation = resolveToolCallPresentation(item);
      return {
        icon: presentation.icon,
        title: zh(presentation.label),
        summary: presentation.summary,
        color: palette.categoryColors[presentation.category],
        status: item.status,
        statusColor: toolStatusColor(item.status, palette),
      };
    }
    case "assistant_message":
      return {
        icon: "MessageSquare",
        title: "Agent",
        summary: compactText(item.text),
        color: palette.categoryColors.communication,
      };
    case "user_message":
      return {
        icon: "MessageSquare",
        title: "提示词",
        summary: compactText(item.text),
        color: palette.categoryColors.communication,
      };
    case "todo":
      return {
        icon: "ListChecks",
        title: "任务",
        summary: `已完成 ${item.items.filter((task) => task.completed).length}/${item.items.length} 项`,
        color: palette.categoryColors.plan,
      };
    case "error":
      return {
        icon: "CircleX",
        title: "错误",
        summary: compactText(item.message),
        color: palette.statusColors.failed,
      };
    case "notification":
      return {
        icon: "Bell",
        title: NOTIFICATION_LEVELS[item.level] ?? item.level,
        summary: compactText(item.message),
        color: item.level === "error" ? palette.statusColors.failed : palette.categoryColors.communication,
      };
    case "compaction":
      return {
        icon: "Archive",
        title: "上下文已压缩",
        color: palette.categoryColors.plan,
        status: item.status,
        statusColor: palette.categoryColors.plan,
      };
    case "plugin":
      return {
        icon: "Puzzle",
        title: item.kind,
        color: palette.categoryColors.unknown,
      };
  }
}

function compactText(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function toolStatusColor(
  status: Extract<AgentTimelineItem, { type: "tool_call" }>["status"],
  palette: ActivityPalette,
): string {
  switch (status) {
    case "running":
      return palette.statusColors.running;
    case "completed":
      return palette.statusColors.completed;
    case "failed":
      return palette.statusColors.failed;
    case "canceled":
      return palette.statusColors.canceled;
  }
}

function childStatusColor(
  status: PaseoAgent["status"],
  palette: ActivityPalette,
): string {
  switch (status) {
    case "running":
    case "initializing":
      return palette.statusColors.running;
    case "idle":
      return palette.statusColors.completed;
    case "error":
      return palette.statusColors.failed;
    case "closed":
      return palette.statusColors.canceled;
  }
}
