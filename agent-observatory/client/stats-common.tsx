import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { STATS_RANGES, vendorNames, type StatsBreakdownRow, type StatsRange, type StatsSnapshot } from "../shared/stats";
import { Banner, EmptyState, Segmented, Skeleton, Spacer, fontSize, gradient, hue, hueFor, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { InfoButton } from "./ui";

export const rangeOptions = STATS_RANGES.map(value => ({ value, label: value === "7d" ? "7 天" : value === "30d" ? "30 天" : "90 天" }));
export interface StatsViewProps {
  theme: PluginTheme; compact: boolean; stats?: StatsSnapshot; loading: boolean; error?: string;
  range: StatsRange; onRange: (range: StatsRange) => void; onRefresh: () => void;
}

/** Vendor brand-ish colours; a vendor's second and third models take neighbouring hues. */
const vendorHues: Record<string, readonly Hue[]> = {
  anthropic: ["orange", "amber", "red"], openai: ["green", "teal", "lime"], google: ["blue", "sky", "cyan"], xai: ["violet", "fuchsia", "indigo"],
  moonshot: ["indigo", "violet", "blue"], deepseek: ["sky", "blue", "cyan"], bytedance: ["cyan", "teal", "sky"], alibaba: ["amber", "orange", "lime"],
  zhipu: ["teal", "green", "cyan"], other: ["pink", "fuchsia", "gray"],
};
export const vendorHue = (vendor: string | null | undefined): Hue => (vendorHues[vendor ?? "other"] ?? vendorHues.other!)[0]!;
/** Colour per breakdown row: vendor families for models / harnesses / vendors, the shared project hue for projects. */
export function rowHues(rows: readonly StatsBreakdownRow[], kind: "model" | "provider" | "vendor" | "project"): Map<string, Hue> {
  const used = new Map<string, number>(), result = new Map<string, Hue>();
  for (const row of rows) {
    if (row.key === "__other__" || row.key === "unknown") { result.set(row.key, "gray"); continue; }
    if (kind === "project") { result.set(row.key, hueFor(row.label)); continue; }
    const family = vendorHues[row.vendor ?? "other"] ?? vendorHues.other!, index = used.get(row.vendor ?? "other") ?? 0;
    used.set(row.vendor ?? "other", index + 1);
    result.set(row.key, family[index % family.length]!);
  }
  return result;
}
export const vendorLabel = (vendor: string | null | undefined) => vendorNames[vendor ?? "other"] ?? vendor ?? "其他";

/** A small filled disk with a white icon — the dashboards' marker for a metric or record. */
export function IconDisk({ theme, icon, colors, size = 28 }: { theme: PluginTheme; icon: string; colors: readonly [Hue, Hue] | readonly [Hue]; size?: number }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2.6, alignItems: "center", justifyContent: "center" }, gradient(theme, colors.length > 1 ? colors : [colors[0], colors[0]], { angle: 135 })]}>
    <Icon name={icon} size={Math.round(size * 0.55)} color="#ffffff" />
  </View>;
}

/** Range picker + freshness line + ⓘ, shared by 看板 / 明细 / 横评 / Token (`generatedAt` and `info` override the statistics defaults). */
export function StatsHeader({ theme, compact, stats, range, onRange, extra, generatedAt, info, infoTitle = "关于统计" }: {
  theme: PluginTheme; compact: boolean; stats?: StatsSnapshot; range: StatsRange; onRange: (range: StatsRange) => void; extra?: ReactNode;
  generatedAt?: string; info?: readonly string[]; infoTitle?: string;
}) {
  const updated = generatedAt ?? stats?.generatedAt;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
    <Segmented theme={theme} size="sm" value={range} onChange={onRange} accessibilityLabel="统计范围" options={rangeOptions} />
    {extra}
    <Spacer />
    {updated && !compact ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>更新于 {relativeTime(updated)}</Text> : null}
    <InfoButton theme={theme} title={infoTitle} lines={info ?? [
      "会话数来自 Paseo 的全部会话（含已归档），按创建时间计入你所在时区的日期。",
      stats?.observedSince ? `轮次、时长、并发从 ${new Date(stats.observedSince).toLocaleDateString("zh-CN")} 起由插件观测。` : "轮次、时长、并发由插件开始观测后累计。",
      stats?.contentSince ? `消息、工具调用和代码行数从 ${new Date(stats.contentSince).toLocaleDateString("zh-CN")} 起统计，只看每轮新增的时间线内容。` : "消息、工具调用和代码行数会在下一轮对话结束后开始统计。",
      "代码行数按编辑工具的 diff 估算（新增 / 删除行），不是 git 提交统计。",
      "成功率 = 完成 ÷（完成 + 失败）；被你中断或取消的轮次不计入。",
      "环比对比的是紧挨着的上一个同样长的周期。",
    ]} />
  </View>;
}

/** Loading / error / empty wrapper for statistics pages. */
export function StatsGate({ theme, stats, loading, error, onRefresh, children }: { theme: PluginTheme; stats?: StatsSnapshot; loading: boolean; error?: string; onRefresh: () => void; children: (stats: StatsSnapshot) => ReactNode }) {
  if (!stats) return loading ? <Skeleton theme={theme} rows={6} />
    : <EmptyState theme={theme} icon={error ? "WifiOff" : "ChartNoAxesCombined"} tone={error ? "danger" : "violet"} title={error ? "统计暂时读不到" : "还没有统计数据"} message={error ?? "派出 Agent 后，这里会长出你的使用画像"} action={{ label: "重试", onPress: onRefresh, icon: "RefreshCw" }} />;
  return <>{error ? <Banner theme={theme} tone="warning" message={`统计同步失败，显示的是上次结果：${error}`} action={{ label: "重试", onPress: onRefresh }} /> : null}{children(stats)}</>;
}

/** Frosted pill used on gradient heroes. */
export function GlassPill({ label, value, icon, onPress, mark }: { label: string; value?: string | number; icon?: string; onPress?: () => void; mark?: ReactNode }) {
  const body = <>
    {mark ?? (icon ? <Icon name={icon} size={13} color="#ffffff" /> : null)}
    <Text style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "600" }}>{label}</Text>
    {value !== undefined ? <Text style={{ color: "#ffffff", fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{value}</Text> : null}
  </>;
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, minHeight: 30, paddingHorizontal: 11, borderRadius: radius.full, backgroundColor: withAlpha("#ffffff", 0.18), borderWidth: 1, borderColor: withAlpha("#ffffff", 0.28) };
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={value === undefined ? label : `${label} ${value}`} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} style={state => [style, { opacity: state.pressed ? 0.75 : 1 }]}>{body}</Pressable> : <View style={style}>{body}</View>;
}

export const surfaceFor = (theme: PluginTheme) => isDarkTheme(theme) ? theme.colors.surface1 : theme.colors.surface0;
export const trackFor = (theme: PluginTheme) => isDarkTheme(theme) ? withAlpha("#ffffff", 0.08) : withAlpha("#000000", 0.06);
export const hueText = (theme: PluginTheme, name: Hue) => hue(theme, name, "text");
