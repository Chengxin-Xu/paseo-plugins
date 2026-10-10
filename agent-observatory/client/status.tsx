import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { isUnreadCompletion, type AgentRecord } from "../shared/model";
import type { TelemetryEvent } from "../shared/telemetry";
import { control, fontSize, hairline, hue as paletteHue, isDarkTheme, radius, relativeTime, space, withAlpha, type Hue as PaletteHue } from "./kit";
import { Ping, Pop, Spin, useChangeCount } from "./motion";
import { readLabel } from "./ui";
import { useForeground } from "./use-foreground";

/**
 * How a session's state looks everywhere: every state has its own colour, glyph and short label, so 执行中 / 待审批 /
 * 未读 / 待回复 / 已完成 never look alike. Live work spins, things that need you are loud, closed sessions are quiet.
 */
export type Phase = "approval" | "error" | "running" | "starting" | "unread" | "snoozed" | "done" | "idle" | "quiet" | "closed" | "canceled";
/** A palette hue, one of the semantic aliases (run blue, warn amber, fail red, ok green), or muted grey. */
export type Hue = PaletteHue | "run" | "warn" | "fail" | "ok" | "muted";
export const phases: Record<Phase, { label: string; hue: Hue; icon: string; hint: string }> = {
  running: { label: "执行中", hue: "blue", icon: "LoaderCircle", hint: "Agent 正在工作，右侧按秒计时。这一轮已结束、子任务还在后台跑时也算，标「后台」" },
  starting: { label: "启动中", hue: "sky", icon: "LoaderCircle", hint: "会话正在启动" },
  approval: { label: "待审批", hue: "amber", icon: "Hand", hint: "有权限请求或问题等你处理" },
  error: { label: "异常", hue: "red", icon: "X", hint: "这一轮失败了，可在详情里看原因" },
  unread: { label: "未读", hue: "pink", icon: "Mail", hint: "Agent 已完成这一轮，结果你还没看" },
  idle: { label: "待回复", hue: "violet", icon: "MessageCircleMore", hint: "Agent 的最后一条回复在问你：要不要继续、选哪个、需要你提供什么" },
  done: { label: "已完成", hue: "green", icon: "Check", hint: "这一轮已完成，结果你已经看过" },
  snoozed: { label: "稍后", hue: "indigo", icon: "AlarmClock", hint: "未读结果已延后提醒" },
  quiet: { label: "空闲", hue: "muted", icon: "CirclePause", hint: "Agent 已停下，这一轮没有记录到结果" },
  closed: { label: "已关闭", hue: "muted", icon: "CircleStop", hint: "会话已关闭" },
  canceled: { label: "已取消", hue: "muted", icon: "CircleSlash", hint: "这一轮被取消" },
};
export const phaseOrder: readonly Phase[] = ["running", "starting", "approval", "error", "unread", "idle", "done", "snoozed", "quiet", "closed", "canceled"];
/** Phases that want attention or are working right now; they get weight and a tinted row. */
export const activePhases: ReadonlySet<Phase> = new Set(["approval", "error", "running", "starting", "unread", "idle"]);

export function phaseOf(agent: AgentRecord, snoozed = false): Phase {
  if (agent.pendingPermissionCount > 0 || agent.status === "waiting") return "approval";
  if (agent.status === "error") return "error";
  if (agent.status === "running") return "running";
  if (agent.status === "initializing") return "starting";
  if (agent.status === "completed") return isUnreadCompletion(agent) ? snoozed ? "snoozed" : "unread" : "done";
  return agent.status === "canceled" ? "canceled" : agent.status === "closed" ? "closed" : agent.status === "idle" ? "idle" : "quiet";
}

const aliases: Record<"run" | "warn" | "fail" | "ok", PaletteHue> = { run: "blue", warn: "amber", fail: "red", ok: "green" };
/** Kit palette colour: `mark` for glyphs, bars and edges; `text` for coloured labels, counts and timers (≥ 4.5:1). */
export function hueColor(theme: PluginTheme, hue: Hue, use: "mark" | "text" = "mark"): string {
  if (hue === "muted") return theme.colors.foregroundMuted;
  return paletteHue(theme, hue in aliases ? aliases[hue as keyof typeof aliases] : hue as PaletteHue, use === "mark" ? "solid" : "text");
}
/** `#rrggbb` + alpha. Other color formats cannot be tinted and fall back to transparent. */
export function tint(color: string, alpha: number): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? withAlpha(color, alpha) : "transparent";
}
export const tintAlpha = (theme: PluginTheme) => isDarkTheme(theme) ? 0.2 : 0.12;

/** Ring with a turning arc. */
export function Spinner({ size, color, slow = false, active = true }: { size: number; color: string; slow?: boolean; active?: boolean }) {
  const ring = size - 2, stroke = size >= 14 ? 2 : 1.5;
  const circle: ViewStyle = { position: "absolute", width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke };
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    <View style={[circle, { borderColor: tint(color, 0.28) }]} />
    <Spin size={ring} slow={slow} active={active}><View style={[circle, { borderColor: "transparent", borderTopColor: color, borderRightColor: color }]} /></Spin>
  </View>;
}

/** The status mark of a phase at 12–20 px: a spinner for live work, a filled coloured disk otherwise, an outline when closed. */
export function StatusGlyph({ theme, phase, size = 16, animate = true }: { theme: PluginTheme; phase: Phase; size?: number; animate?: boolean }) {
  const meta = phases[phase], color = hueColor(theme, meta.hue);
  const box: ViewStyle = { width: size, height: size, alignItems: "center", justifyContent: "center" };
  if (phase === "running" || phase === "starting") return <View style={box}><Spinner size={size} color={color} slow={phase === "starting"} active={animate} /></View>;
  if (meta.hue === "muted") return <View style={box}><Icon name={meta.icon} size={size} color={theme.colors.foregroundMuted} /></View>;
  return <View style={box}>
    {phase === "approval" || phase === "unread" ? <Ping size={size} color={color} active={animate} /> : null}
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: color }}>
      <Icon name={meta.icon} size={Math.round(size * 0.62)} color="#ffffff" />
    </View>
  </View>;
}

/** Short status label, e.g. 「待审批 2」「异常」「未读」: solid for the loud states, tinted for the rest. */
export function PhasePill({ theme, hue, label, icon, solid = false }: { theme: PluginTheme; hue: Hue; label: string; icon?: string; solid?: boolean }) {
  const color = hueColor(theme, hue), text = solid ? "#ffffff" : hueColor(theme, hue, "text");
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 20, paddingHorizontal: 7, borderRadius: radius.full, backgroundColor: hue === "muted" ? theme.colors.surface2 : solid ? color : tint(color, tintAlpha(theme)) }}>
    {icon ? <Icon name={icon} size={11} color={solid ? "#ffffff" : color} /> : null}
    <Text numberOfLines={1} style={{ color: text, fontSize: fontSize.meta, fontWeight: "700" }}>{label}</Text>
  </View>;
}
/** The pill that names a session's phase in lists: loud states solid, settled states tinted, closed ones grey. */
export function PhaseTag({ theme, phase, count }: { theme: PluginTheme; phase: Phase; count?: number }) {
  const meta = phases[phase];
  return <PhasePill theme={theme} hue={meta.hue} label={count && count > 1 ? `${meta.label} ${count}` : meta.label} solid={phase === "approval" || phase === "error" || phase === "unread" || phase === "idle"} />;
}

/** 3:07 / 1:02:45 */
export function clock(milliseconds: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60, pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
/** Elapsed time that ticks every second while the app is in the foreground; only this text re-renders. */
export function LiveTimer({ since, color, prefix = "", size = fontSize.meta }: { since: string; color: string; prefix?: string; size?: number }) {
  const foreground = useForeground();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!foreground) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [foreground]);
  return <Text numberOfLines={1} style={{ color, fontSize: size, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{prefix}{clock(now - Date.parse(since))}</Text>;
}

/** A small dot that radiates while something is live (sync, pending approvals). */
export function LiveDot({ color, size = 7, live = true }: { color: string; size?: number; live?: boolean }) {
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    <Ping size={size} color={color} active={live} />
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  </View>;
}

/** Quick-scope chip whose mark shows the state it filters: spinning while work runs, radiating while approvals wait. */
export function StatusChip({ theme, label, count, hue, motion, selected, onPress }: {
  theme: PluginTheme; label: string; count?: number; hue: Hue; motion?: "spin" | "ping"; selected: boolean; onPress: () => void;
}) {
  const { colors } = theme, lit = (count ?? 0) > 0, color = lit ? hueColor(theme, hue) : colors.foregroundMuted;
  const mark: ReactNode = motion === "spin" ? <Spinner size={12} color={color} active={lit} /> : <LiveDot color={color} size={7} live={lit && motion === "ping"} />;
  return <Pressable accessibilityRole="button" accessibilityLabel={count === undefined ? label : `${label} ${count}`} accessibilityState={{ selected }} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: control.sm, paddingHorizontal: 10, borderRadius: radius.full, borderWidth: hairline,
      borderColor: selected ? color : lit ? tint(color, 0.45) : colors.border, backgroundColor: selected ? tint(hueColor(theme, hue), tintAlpha(theme)) : (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent", opacity: state.pressed ? 0.8 : 1 })}>
    <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>{mark}</View>
    <Text numberOfLines={1} style={{ color: lit || selected ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? "500" : "400" }}>{label}</Text>
    {count !== undefined ? <Text style={{ color: lit ? hueColor(theme, hue, "text") : colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: lit ? "600" : "400", fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
  </Pressable>;
}

/** Detail header status: the phase mark and name on a tinted pill, plus what matters about it right now. */
export function PhaseLine({ theme, agent, snoozed = false }: { theme: PluginTheme; agent: AgentRecord; snoozed?: boolean }) {
  const phase = phaseOf(agent, snoozed), meta = phases[phase], color = hueColor(theme, meta.hue), text = hueColor(theme, meta.hue, "text"), changes = useChangeCount(phase);
  const muted = meta.hue === "muted";
  const label = meta.label;
  const background = phase === "running" && !agent.activeTurnStartedAt ? agent.background : null;
  const detail: ReactNode = phase === "running" && agent.activeTurnStartedAt ? <LiveTimer since={agent.activeTurnStartedAt} color={text} prefix="已运行 " size={fontSize.small} />
    : background ? background.since ? <LiveTimer since={background.since} color={text} prefix="后台子任务已运行 " size={fontSize.small} /> : `后台子任务 ${background.running} 个在执行`
    : phase === "approval" && agent.pendingPermissionCount > 0 ? `${agent.pendingPermissionCount} 项请求等你处理`
    : phase === "unread" ? "新结果等你查看" : phase === "snoozed" ? "未读，已延后提醒" : phase === "done" ? "结果已读"
    : phase === "idle" ? agent.lastActivityAt ? `在问你 · ${relativeTime(agent.lastActivityAt)}` : "在问你"
    : phase === "quiet" ? "没有记录到这一轮的结果" : null;
  return <View accessibilityLabel={readLabel(agent)} style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: space.xs + 2, minHeight: 26, paddingLeft: 6, paddingRight: 10, borderRadius: radius.full, backgroundColor: muted ? theme.colors.surface2 : tint(color, tintAlpha(theme)) }}>
    <Pop count={changes} size={16}><StatusGlyph theme={theme} phase={phase} /></Pop>
    <Text numberOfLines={1} style={{ color: muted ? theme.colors.foreground : text, fontSize: fontSize.small, fontWeight: "600" }}>{label}</Text>
    {detail !== null ? <Text style={{ color: muted ? theme.colors.foregroundMuted : text, fontSize: fontSize.small, opacity: 0.8 }}>·</Text> : null}
    {typeof detail === "string" ? <Text numberOfLines={1} style={{ color: muted ? theme.colors.foregroundMuted : text, fontSize: fontSize.small }}>{detail}</Text> : detail}
  </View>;
}

/** Lifecycle events share the session marks: started runs blue, finished green, failed red, approvals amber. */
export const eventLooks: Record<TelemetryEvent["type"], { icon: string; hue: Hue }> = {
  created: { icon: "Plus", hue: "cyan" }, turn_started: { icon: "Play", hue: "blue" }, turn_completed: { icon: "CircleCheck", hue: "green" }, turn_failed: { icon: "CircleX", hue: "red" },
  turn_canceled: { icon: "CircleSlash", hue: "muted" }, permission_requested: { icon: "Hand", hue: "amber" }, permission_resolved: { icon: "ShieldCheck", hue: "teal" }, archived: { icon: "Archive", hue: "muted" },
};
export function EventGlyph({ theme, type, size = 16 }: { theme: PluginTheme; type: TelemetryEvent["type"]; size?: number }) {
  const look = eventLooks[type];
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}><Icon name={look.icon} size={size} color={hueColor(theme, look.hue)} /></View>;
}

/** Every state with its mark and meaning, for the 状态图例 sheet. */
export function PhaseLegend({ theme }: { theme: PluginTheme }) {
  return <View style={{ gap: space.xs }}>
    {phaseOrder.map(phase => <View key={phase} style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 36 }}>
      <StatusGlyph theme={theme} phase={phase} size={18} />
      <View style={{ width: 64 }}><PhaseTag theme={theme} phase={phase} /></View>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{phases[phase].hint}</Text>
    </View>)}
  </View>;
}
