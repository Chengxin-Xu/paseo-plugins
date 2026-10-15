import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { foldAccessibilityLabel, foldCountParts, foldTitle, formatFoldDuration } from "../shared/fold";
import type { FoldItemData } from "../shared/timeline";
import { looks, type LookKey, type RowStatus } from "../shared/vivid-model";
import { usePalette } from "./activity";
import { densityMetrics, useDensity, useFoldRow } from "./density";
import { foldRuntime } from "./fold-runtime";
import { aria, hue, isDarkTheme, withAlpha } from "./kit";
import { Flash, Pop, useChangeCount } from "./motion";
import { PinnedPrompt, usePromptPin } from "./prompt-pin";
import { StatusMark, StatusPill } from "./vivid";
import { cuiTextEscape, pmonoViewEscape } from "./web";

type Theme = PluginTimelineItemProps["theme"];

/** Text colour of a look's count under the chosen palette. */
function countColor(theme: Theme, mode: string, look: LookKey): string {
  if (mode === "soft") return theme.colors.foregroundMuted;
  if (mode === "theme") return theme.colors.accent;
  const name = looks[look].hue;
  return name === "gray" ? theme.colors.foregroundMuted : hue(theme, name, "text");
}

function barColor(theme: Theme, mode: string, look: LookKey): string {
  if (mode === "soft") return withAlpha(theme.colors.foregroundMuted.startsWith("#") ? theme.colors.foregroundMuted : "#888888", 0.5);
  if (mode === "theme") return theme.colors.accent;
  const name = looks[look].hue;
  return name === "gray" ? theme.colors.foregroundMuted : hue(theme, name);
}

/** A stack of rows: the tile says what kind of summary this is (finished, failed, or the earlier steps of a live run). */
function FoldTile({ theme, tone, size, pulse }: { theme: Theme; tone: "green" | "red" | "blue" | "muted"; size: number; pulse: number }) {
  const color = tone === "muted" ? theme.colors.foregroundMuted : hue(theme, tone);
  const tile = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: withAlpha(color.startsWith("#") ? color : "#888888", isDarkTheme(theme) ? 0.2 : 0.13),
      }}
    >
      <Icon name="Layers" size={Math.round(size * 0.62)} color={color} />
    </View>
  );
  return pulse > 0 ? <Pop count={pulse} size={size}>{tile}</Pop> : tile;
}

/** Proportional strip of the counted looks (wide layouts only; phones read the counts). */
function LookBar({ theme, mode, parts }: { theme: Theme; mode: string; parts: ReadonlyArray<readonly [LookKey, number]> }) {
  return (
    <View style={{ flexDirection: "row", width: 44, height: 6, borderRadius: 3, overflow: "hidden", gap: 1, flexShrink: 0 }}>
      {parts.map(([look, n]) => (
        <View key={look} style={{ flexGrow: n, flexShrink: 1, backgroundColor: barColor(theme, mode, look) }} />
      ))}
    </View>
  );
}

/**
 * 本地补丁：折叠摘要行。已结束的段：「12 步 · 思考 2 · 命令 5 · 读取 3 · 编辑 2 … 失败 1 · 1 分 20 秒 ✓ ›」；
 * 运行中的段：「前面 7 步 …」。点一下展开整段（Paseo 重新投影，被折叠的行回来），再点收起；选择在本次会话里记住。
 */
export function FoldRow({ agentId, item, theme, layout, timestamp }: PluginTimelineItemProps<FoldItemData>) {
  useI18n();
  const data = item.data;
  useFoldRow(agentId, undefined, undefined, timestamp);
  const palette = usePalette(theme);
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const done = data.mode === "done";
  const status: RowStatus = data.failed > 0 ? "failed" : data.canceled > 0 && data.canceled === data.steps ? "canceled" : "completed";
  const tone = !done ? "blue" : status === "failed" ? "red" : status === "canceled" ? "muted" : "green";
  // A live run that just finished folds into this row: flash once, pop the tile.
  const changes = useChangeCount(data.mode);
  const parts = foldCountParts(data.counts);
  const bar = useMemo(() => parts.map((part) => [part.look, data.counts.find(([look]) => look === part.look)?.[1] ?? 0] as const), [data.counts, parts]);
  const duration = done ? formatFoldDuration(data.durationMs) : null;
  const toggle = useCallback(() => foldRuntime.toggle(agentId, data.segment, !data.expanded), [agentId, data.expanded, data.segment]);
  // 0.6.0 (grok-B2): the question of this turn, when this summary stands for the newest stretch of activity.
  const pin = usePromptPin(agentId, { segment: data.segment });

  const text = useMemo(
    () => ({
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700", lineHeight: metrics.lineHeight, flexShrink: 0 } satisfies TextStyle,
      counts: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: metrics.lineHeight, flexShrink: 1, minWidth: 0 } satisfies TextStyle,
      meta: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: metrics.lineHeight, flexShrink: 0, fontVariant: ["tabular-nums"] } satisfies TextStyle,
    }),
    [metrics.lineHeight, theme],
  );
  const card: ViewStyle = { marginHorizontal: 0, marginTop: metrics.marginTop, marginBottom: metrics.marginBottom };
  const row: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: metrics.gap,
    minHeight: metrics.rowMinHeight,
    paddingVertical: metrics.rowPaddingVertical,
    paddingLeft: layout.compact ? 6 : 8,
    paddingRight: 6,
    minWidth: 0,
    borderRadius: 8,
    overflow: "hidden",
    // Expanded: a faint band marks the header of the rows below it.
    backgroundColor: data.expanded ? withAlpha(hue(theme, done ? (status === "failed" ? "red" : "green") : "blue"), isDarkTheme(theme) ? 0.1 : 0.07) : "transparent",
  };
  const label = foldAccessibilityLabel(data);

  return (
    <View {...pmonoViewEscape} style={card}>
      {pin ? <PinnedPrompt agentId={agentId} pin={pin} theme={theme} mode={palette.mode} metrics={metrics} /> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={label} {...aria({ expanded: data.expanded })} onPress={toggle} style={row}>
        <FoldTile theme={theme} tone={tone} size={metrics.tile} pulse={changes} />
        <Text {...cuiTextEscape} numberOfLines={1} style={text.title}>{foldTitle(data)}</Text>
        {!layout.compact && bar.length > 0 ? <LookBar theme={theme} mode={palette.mode} parts={bar} /> : null}
        <Text {...cuiTextEscape} numberOfLines={1} style={text.counts}>
          {parts.map((part, index) => (
            <Text key={part.look}>
              {index > 0 ? t("ui.metaSeparator") : ""}
              <Text style={{ color: countColor(theme, palette.mode, part.look), fontWeight: "600" }}>{part.text}</Text>
            </Text>
          ))}
        </Text>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 2 }} />
        {data.failed > 0 ? <StatusPill theme={theme} status="failed" text={t("ui.failed2", { count: data.failed })} /> : null}
        {duration ? <Text {...cuiTextEscape} numberOfLines={1} style={text.meta}>{duration}</Text> : null}
        {done ? <StatusMark theme={theme} status={status} size={14} /> : null}
        <Icon name={data.expanded ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
        {changes > 0 && done ? <Flash count={changes} color={withAlpha(hue(theme, status === "failed" ? "red" : "green"), 0.22)} radius={8} /> : null}
      </Pressable>
    </View>
  );
}
