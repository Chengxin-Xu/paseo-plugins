import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TokenLive, TokenLiveAgent } from "../shared/tokens";
import { vendorOf } from "../shared/stats";
import { bigNumber } from "../shared/stats-view";
import { Segmented, fontSize, gradient, hairline, hue, isDarkTheme, radius, relativeTime, space, withAlpha } from "./kit";
import { Card } from "./charts";
import { Ping } from "./motion";
import { vendorHue } from "./stats-common";

/** Tokens per second: one decimal below 100. */
export const perSecond = (value: number) => value >= 100 ? Math.round(value).toLocaleString("en-US") : value.toFixed(1).replace(/\.0$/, "");
const clock = (at: number, seconds = false) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
/** Round an axis maximum up to 1 / 2 / 5 × 10ⁿ. */
function niceCeiling(value: number): number {
  if (value <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(value)), step = [1, 2, 5, 10].find(candidate => candidate * power >= value)!;
  return step * power;
}

/**
 * Rolling output speed: one column per 10 s bucket (tokens ÷ 10 = tok/s), older columns fade, the current partial
 * bucket glows. Minute-wide hit areas show that minute's speed.
 */
export const LiveRateChart = memo(function LiveRateChart({ theme, live, height = 132 }: { theme: PluginTheme; live: TokenLive; height?: number }) {
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const values = live.output, n = values.length, start = Date.parse(live.start), bucket = live.bucketMs;
  const axis = 42, plot = Math.max(0, width - axis), column = n ? plot / n : 0, gap = column >= 3 ? 1 : 0;
  const top = niceCeiling(Math.max(...values, 1) / (bucket / 1000));
  const y = (perSec: number) => Math.min(1, perSec / top) * height;
  const color = hue(theme, "orange"), accent = hue(theme, "pink"), grid = isDarkTheme(theme) ? withAlpha("#ffffff", 0.07) : withAlpha("#000000", 0.06);
  const minutes = Math.ceil(n / 6), minuteRate = (minute: number) => values.slice(minute * 6, minute * 6 + 6).reduce((sum, value) => sum + value, 0) / 60;
  const window = Math.round(n * bucket / 60_000);
  return <View style={{ gap: 6 }}>
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: height + 2 }}>
      {[0, 0.5, 1].map(step => <View key={step} style={{ position: "absolute", left: axis, right: 0, bottom: step * height, height: hairline, backgroundColor: grid }} />)}
      {[0.5, 1].map(step => <Text key={step} style={{ position: "absolute", left: 0, width: axis - 6, textAlign: "right", bottom: step * height - 7, color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>{perSecond(top * step)}</Text>)}
      <Text style={{ position: "absolute", left: 0, width: axis - 6, textAlign: "right", bottom: -1, color: theme.colors.foregroundMuted, fontSize: 10 }}>tok/s</Text>
      {width > 0 ? values.map((value, index) => {
        const perSec = value / (bucket / 1000), last = index === n - 1, h = value > 0 ? Math.max(2, y(perSec)) : 0;
        if (!h) return null;
        return <View key={start + index * bucket} style={[{ position: "absolute", left: axis + index * column, bottom: 0, width: Math.max(1, column - gap), height: h, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
          last ? [gradient(theme, [accent, color], { angle: 180 }), { opacity: 1 }] : { backgroundColor: color, opacity: 0.3 + 0.7 * (index / n) }]} />;
      }) : null}
      {width > 0 && n ? (() => { const perSec = values[n - 1]! / (bucket / 1000); return <View style={{ position: "absolute", left: axis + (n - 1) * column + column / 2 - 5, bottom: Math.max(2, y(perSec)) - 5, width: 10, height: 10, alignItems: "center", justifyContent: "center" }}>
        <Ping size={10} color={accent} active={perSec > 0} /><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: accent }} />
      </View>; })() : null}
      {width > 0 ? Array.from({ length: minutes }, (_, minute) => <Pressable key={minute} accessibilityRole="button" accessibilityLabel={`${clock(start + minute * 60_000)}，每秒 ${perSecond(minuteRate(minute))} 个 token`}
        onPress={() => setPicked(picked === minute ? null : minute)} style={{ position: "absolute", left: axis + minute * 6 * column, width: 6 * column, top: 0, bottom: 0, backgroundColor: picked === minute ? withAlpha(color, 0.12) : "transparent" }} />) : null}
    </View>
    <View style={{ flexDirection: "row", marginLeft: axis }}>
      {[window, Math.round(window * 2 / 3), Math.round(window / 3)].map(ago => <Text key={ago} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>−{ago} 分</Text>)}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>现在</Text>
    </View>
    {picked !== null ? <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small }}>
      {clock(start + picked * 60_000)} 这一分钟 · <Text style={{ color: hue(theme, "orange", "text"), fontWeight: "800" }}>{perSecond(minuteRate(picked))} tok/s</Text>
      {" · "}{live.calls.slice(picked * 6, picked * 6 + 6).reduce((sum, value) => sum + value, 0)} 次调用</Text> : null}
  </View>;
});

function MiniBars({ theme, values, color }: { theme: PluginTheme; values: readonly number[]; color: string }) {
  const peak = Math.max(1, ...values);
  return <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1.5, height: 18, width: 12 * 4.5 }}>
    {values.map((value, index) => <View key={index} style={{ flex: 1, height: value ? Math.max(2, value / peak * 18) : 1.5, borderRadius: 1, backgroundColor: value ? color : theme.colors.border, opacity: value ? 0.45 + 0.55 * index / values.length : 1 }} />)}
  </View>;
}

function LiveAgentRow({ theme, agent, onOpenAgent }: { theme: PluginTheme; agent: TokenLiveAgent; onOpenAgent?: (agentId: string) => void }) {
  const color = hue(theme, vendorHue(vendorOf(agent.model, null))), active = agent.outputPerSec > 0;
  const title = agent.title ?? (agent.agentId ? "未命名 Agent" : "未关联 Paseo 的会话");
  const body = <>
    <View style={{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }}><Ping size={10} color={color} active={active} /><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /></View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: agent.title ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "700" }}>{title}</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[agent.model ?? agent.source, `10 分钟输出 ${bigNumber(agent.output10m)}`, relativeTime(agent.lastCallAt)].join(" · ")}</Text>
    </View>
    <MiniBars theme={theme} values={agent.recent} color={color} />
    <Text style={{ width: 74, textAlign: "right", color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{perSecond(agent.outputPerSec)}<Text style={{ fontSize: 10, fontWeight: "500", color: theme.colors.foregroundMuted }}> tok/s</Text></Text>
  </>;
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: 40, paddingVertical: 4 };
  return agent.agentId && onOpenAgent ? <Pressable accessibilityRole="button" accessibilityLabel={`${title}，每秒 ${perSecond(agent.outputPerSec)} 个 token`} onPress={() => onOpenAgent(agent.agentId!)} style={state => [style, { opacity: state.pressed ? 0.7 : 1 }]}>{body}</Pressable>
    : <View accessibilityLabel={`${title}，每秒 ${perSecond(agent.outputPerSec)} 个 token`} style={style}>{body}</View>;
}

/** 实时流速: current and peak speed, the rolling chart and the sessions producing output right now. */
export function LiveRateCard({ theme, live, error, windowMinutes, onWindow, onOpenAgent }: {
  theme: PluginTheme; live?: TokenLive; error?: string; windowMinutes: 30 | 60; onWindow: (minutes: 30 | 60) => void; onOpenAgent?: (agentId: string) => void;
}) {
  const now = live?.now;
  return <Card theme={theme} title="实时流速" icon="Zap" color="orange" trailing={<Segmented theme={theme} size="sm" value={String(windowMinutes) as "30" | "60"} onChange={value => onWindow(Number(value) as 30 | 60)} accessibilityLabel="流速时间窗" options={[{ value: "30", label: "30 分钟" }, { value: "60", label: "60 分钟" }]} />}>
    {!live ? <Text style={{ color: error ? hue(theme, "red", "text") : theme.colors.foregroundMuted, fontSize: fontSize.small }}>{error ? `实时流速暂时读不到：${error}` : "正在连接实时流速…"}</Text> : <>
      <View style={{ flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap", columnGap: space.xl, rowGap: space.sm }}>
        <View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>当前输出</Text>
          <Text accessibilityLabel={`当前每秒 ${perSecond(now!.outputPerSec)} 个 token`} style={{ color: hue(theme, "orange", "text"), fontSize: 34, lineHeight: 40, fontWeight: "900", fontVariant: ["tabular-nums"], letterSpacing: -0.8 }}>
            {perSecond(now!.outputPerSec)}<Text style={{ fontSize: fontSize.body, fontWeight: "700" }}> tok/s</Text></Text>
        </View>
        {[["峰值", live.peak ? `${perSecond(live.peak.outputPerSec)} tok/s` : "—", live.peak ? clock(Date.parse(live.peak.at)) : "窗口内无输出"],
          ["读入上下文", `${bigNumber(now!.inputPerSec * 60)}/分`, "含缓存读取"], ["调用", `${perSecond(now!.callsPerMin)} 次/分`, "最近 1 分钟"]].map(([label, value, sub]) => <View key={label}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{label}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{value}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{sub}</Text>
        </View>)}
      </View>
      <LiveRateChart theme={theme} live={live} />
      {live.agents.length ? <View style={{ borderTopWidth: hairline, borderTopColor: theme.colors.border, paddingTop: space.xs }}>
        {live.agents.map(agent => <LiveAgentRow key={agent.sessionId} theme={theme} agent={agent} onOpenAgent={onOpenAgent} />)}
      </View> : <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: hue(theme, "gray", "soft") }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>最近 10 分钟没有模型在输出</Text>
      </View>}
    </>}
  </Card>;
}
