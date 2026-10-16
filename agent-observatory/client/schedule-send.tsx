import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { currentLanguage } from "../shared/i18n";
import { clockLabel } from "../shared/attention";
import { isOnItsWay, isScheduled, type DeferredView } from "../shared/deferred-rpc";
import { observatoryDeferred } from "../shared/steer";
import { t } from "../shared/text";
import { Button, TextField, aria, fontSize, hairline, hue, radius, space } from "./kit";
import { DeferredRow, scheduledPollInterval } from "./deferred";
import { useForeground } from "./use-foreground";

/**
 * 定时发送 (2.17, after Defer's idea): a message or quick reply queued in the plugin's send ledger for a time (`notBefore`). Until
 * then nothing goes out; from then on it goes as 「等这一轮结束再发」 does. Times are picked on this device's clock and stored
 * as UTC, so the device that shows them later may be in another zone.
 */
const MINUTE = 60_000, WEEK = 7 * 24 * 60 * MINUTE;
export const SCHEDULE_PRESETS = [30, 60, 180] as const;
const presetLabel = (minutes: number) => minutes === 30 ? t("alertsSchedule.in30Minutes") : minutes === 60 ? t("alertsSchedule.in1Hour") : t("alertsSchedule.in3Hours");
/** A clock time ("9:05", "09:05", "21:30") on the day `day` days from `now`, on this device's clock; null when not a time. */
export function scheduleAt(day: number, clock: string, now: Date): number | null {
  const match = /^\s*(\d{1,2})[:：.](\d{2})\s*$/.exec(clock);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hours, minutes, 0, 0).getTime();
}
/**
 * The day a clock time next comes on this device: today while it is still more than a minute ahead, else tomorrow. The picker
 * uses it until a day is chosen with the arrows, so 「14:30」 typed in the morning is today's, not tomorrow's.
 */
export function nextDayFor(clock: string, now: Date): number {
  const today = scheduleAt(0, clock, now);
  return today !== null && today > now.getTime() + MINUTE ? 0 : 1;
}
/** Why a time cannot be picked: past, or more than a week ahead (the ledger's limit); null when it can. */
export function scheduleProblem(at: number | null, now: number): string | null {
  if (at === null) return t("alertsSchedule.badClock");
  if (at <= now + MINUTE) return t("alertsSchedule.past");
  if (at > now + WEEK) return t("alertsSchedule.tooFar");
  return null;
}
/** 「明天 09:00」 on this device's clock. */
export const scheduleWhen = (at: number, now = Date.now()) => clockLabel(at, now);
const dayName = (day: number, now: Date) => {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
  const named = day === 0 ? t("alertsSchedule.today") : day === 1 ? t("alertsSchedule.tomorrow") : null;
  const formatted = date.toLocaleDateString(currentLanguage(), { month: "short", day: "numeric", weekday: "short" });
  return named ? t("alertsSchedule.namedDay", { name: named, date: formatted }) : formatted;
};

/**
 * 定时发: 30 分钟后 / 1 小时后 / 3 小时后, or a day and a clock time (the next 09:00 to start with). `onPick` gets the UTC time.
 */
export function SchedulePicker({ theme, busy = false, compact = false, onPick, onClose }: { theme: PluginTheme; busy?: boolean; compact?: boolean; onPick: (at: number) => void; onClose: () => void }) {
  const { colors } = theme, [custom, setCustom] = useState(false);
  const [now] = useState(() => new Date());
  // The day follows the clock (its next time) until one is chosen with the arrows.
  const [chosenDay, setDay] = useState<number | null>(null), [clock, setClock] = useState("09:00");
  const day = chosenDay ?? nextDayFor(clock, new Date());
  const at = scheduleAt(day, clock, new Date()), problem = scheduleProblem(at, Date.now());
  const sky = hue(theme, "sky");
  return <View testID="schedule-picker" style={{ gap: space.sm, padding: space.sm + 2, borderRadius: radius.md, borderWidth: hairline, borderColor: hue(theme, "sky", "line"), backgroundColor: hue(theme, "sky", "soft") }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
      <Icon name="AlarmClock" size={14} color={sky} />
      <Text style={{ flex: 1, color: hue(theme, "sky", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{t("alertsSchedule.title")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("alertsSchedule.close")} onPress={onClose} hitSlop={8}><Icon name="X" size={14} color={colors.foregroundMuted} /></Pressable>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {SCHEDULE_PRESETS.map(minutes => <Button key={minutes} theme={theme} size="sm" tone="sky" icon="Clock3" label={presetLabel(minutes)} grow={compact} disabled={busy} testID={`schedule-in-${minutes}`}
        onPress={() => onPick(Date.now() + minutes * MINUTE)} />)}
      <Button theme={theme} size="sm" variant={custom ? "secondary" : "ghost"} tone="sky" icon="CalendarClock" label={t("alertsSchedule.pickTime")} grow={compact} disabled={busy} onPress={() => setCustom(!custom)} />
    </View>
    {/* What a schedule cannot promise (A6, A7): a conversation moved on asks first; after a restart a device has to connect. */}
    <Text testID="schedule-hint" style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("alertsSchedule.pickerHint")}</Text>
    {custom ? <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("alertsSchedule.earlierDay")} disabled={day <= 0} onPress={() => setDay(Math.max(0, day - 1))} hitSlop={6} style={{ opacity: day <= 0 ? 0.35 : 1, padding: 4 }}>
          <Icon name="ChevronLeft" size={16} color={sky} />
        </Pressable>
        <Text style={{ flex: 1, textAlign: "center", color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{dayName(day, now)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("alertsSchedule.laterDay")} disabled={day >= 6} onPress={() => setDay(Math.min(6, day + 1))} hitSlop={6} style={{ opacity: day >= 6 ? 0.35 : 1, padding: 4 }}>
          <Icon name="ChevronRight" size={16} color={sky} />
        </Pressable>
      </View>
      <TextField theme={theme} label={t("alertsSchedule.clockLabel")} value={clock} onChangeText={setClock} placeholder="09:00" hint={problem ?? t("alertsSchedule.willSend", { when: scheduleWhen(at!) })} />
      <Button theme={theme} variant="primary" icon="AlarmClockCheck" label={problem ? t("alertsSchedule.pickTime") : t("alertsSchedule.sendAt", { when: scheduleWhen(at!) })} disabled={busy || !!problem} busy={busy} testID="schedule-confirm"
        onPress={() => { if (at !== null && !scheduleProblem(at, Date.now())) onPick(at); }} />
    </View> : null}
  </View>;
}

const allQueryKey = ["agent-observatory", "deferred", "*"] as const;
/** Every scheduled message on this host (the popover's list), read while it shows and the app is in front. */
export function useScheduledSends(enabled: boolean) {
  const list = useRpc(observatoryDeferred.list), cancelRpc = useRpc(observatoryDeferred.cancel), resumeRpc = useRpc(observatoryDeferred.resume);
  const queryClient = useQueryClient(), foreground = useForeground(), toast = useToast();
  const query = useQuery({ queryKey: allQueryKey, queryFn: () => list({}), enabled: enabled && foreground, retry: false, staleTime: 5_000, refetchOnWindowFocus: false,
    refetchInterval: current => scheduledPollInterval(current.state.data, foreground) });
  const [acting, setActing] = useState<string | null>(null);
  const act = async (messageId: string, call: () => Promise<unknown>) => {
    if (acting) return;
    setActing(messageId);
    try { await call(); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setActing(null); void queryClient.invalidateQueries({ queryKey: ["agent-observatory", "deferred"] }); }
  };
  const views = (query.data ?? []).filter(view => view.notBefore !== undefined && isOnItsWay(view));
  return { views, acting,
    cancel: (messageId: string) => act(messageId, () => cancelRpc({ messageId })),
    sendNow: (messageId: string) => act(messageId, () => resumeRpc({ messageId, now: true })),
    resume: (messageId: string) => act(messageId, () => resumeRpc({ messageId })) };
}

/** Agents' titles for a list of their messages: the client's copy when it has one, else one read each (it never loads an Agent). */
function useAgentTitles(ids: readonly string[], known: (id: string) => string | null) {
  const paseo = usePaseo(), wanted = useMemo(() => [...new Set(ids)].filter(id => !known(id)).slice(0, 20).sort(), [ids.join(","), known]);
  const query = useQuery({ queryKey: ["agent-observatory", "agent-titles", ...wanted], enabled: wanted.length > 0, staleTime: 5 * MINUTE, retry: false,
    queryFn: async () => Object.fromEntries(await Promise.all(wanted.map(async id => {
      const ref = paseo.agents.ref(id), cached = ref.current()?.title;
      return [id, cached ?? (await ref.refresh().catch(() => null))?.agent?.title ?? null] as const;
    }))) });
  return (id: string) => known(id) ?? query.data?.[id] ?? null;
}

/**
 * 定时消息: every scheduled message on its way, here (the popover) or for one Agent (`only`). Each row has 立即发送 and 取消;
 * one that went out leaves the list. Nothing renders when there is none.
 */
export function ScheduledSends({ theme, compact = false, titleOf = () => null, collapsible = false }: { theme: PluginTheme; compact?: boolean; titleOf?: (agentId: string) => string | null; collapsible?: boolean }) {
  const scheduled = useScheduledSends(true), { colors } = theme, [open, setOpen] = useState(!collapsible);
  const title = useAgentTitles(scheduled.views.map(view => view.agentId), titleOf);
  if (!scheduled.views.length) return null;
  const next = nextScheduled(scheduled.views) ?? Number.NaN;
  return <View testID="scheduled-sends" style={{ gap: space.xs + 2, paddingTop: space.xs }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} {...aria({ expanded: open })} disabled={!collapsible} onPress={() => setOpen(!open)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 26 }}>
      <Icon name="AlarmClock" size={13} color={hue(theme, "sky")} />
      <Text style={{ flex: 1, color: hue(theme, "sky", "text"), fontSize: fontSize.small, fontWeight: "700" }}>
        {t("alertsSchedule.listTitle", { count: scheduled.views.length })}{Number.isFinite(next) ? t("alertsSchedule.listNext", { when: scheduleWhen(next) }) : ""}
      </Text>
      {collapsible ? <Icon name={open ? "ChevronUp" : "ChevronDown"} size={13} color={colors.foregroundMuted} /> : null}
    </Pressable>
    {open ? scheduled.views.map(view => <DeferredRow key={view.messageId} theme={theme} view={view} busy={scheduled.acting === view.messageId} compact={compact} agentTitle={title(view.agentId) ?? undefined}
      onCancel={() => void scheduled.cancel(view.messageId)} onResume={() => void scheduled.resume(view.messageId)} onSendNow={() => void scheduled.sendNow(view.messageId)} />) : null}
  </View>;
}

/** The next time still ahead among these messages (one sent with 立即发送, or already due, waits only for the agent); null if none. */
export function nextScheduled(views: readonly DeferredView[], now = Date.now()): number | null {
  const ahead = views.filter(view => isScheduled(view, now)).map(view => view.notBefore!);
  return ahead.length ? Math.min(...ahead) : null;
}
/** The scheduled part of one Agent's ledger list, for its detail: on its way and scheduled (or held after its time). */
export const isScheduledView = (view: DeferredView) => view.notBefore !== undefined && isOnItsWay(view);
export { isScheduled };
