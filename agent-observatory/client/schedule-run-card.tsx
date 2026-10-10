import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Banner, Button, MetaLine, Skeleton, Spacer, fontSize, hairline, radius, space } from "./kit";
import { PhasePill, hueColor, tint, tintAlpha } from "./status";
import { PaneLabel } from "./ui";
import { OutputText } from "./result-view";
import { runDurationLabel, runLooks, runMoment } from "./schedule-looks";
import { useScheduleRun } from "./use-schedules";
import { cadenceText, describeRunError, deviceTimeZone } from "../shared/schedules";

/**
 * Agent 详情 → 结果, for an Agent a schedule created: which schedule, how this run went, and a way to all its runs.
 * Labels alone identify the run; the card fills in from the 定时运行 index (one small read, cached for the session).
 */
export function ScheduleRunCard({ theme, runId, scheduleId, running, onOpenAll }: { theme: PluginTheme; runId: string; scheduleId: string; running: boolean; onOpenAll?: () => void }) {
  const { colors } = theme;
  const detail = useScheduleRun(runId, running);
  const row = detail.data?.row ?? null, schedule = detail.data?.schedule ?? null;
  const look = row ? runLooks[row.status] : null, violet = hueColor(theme, "violet");
  const error = describeRunError(row?.error)?.summary;
  return <View testID="schedule-run-card" style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: hairline, borderColor: tint(violet, 0.45), backgroundColor: tint(violet, tintAlpha(theme) * 0.6) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Icon name="CalendarClock" size={15} color={violet} />
      <Text style={{ color: hueColor(theme, "violet", "text"), fontSize: fontSize.meta, fontWeight: "700" }}>定时任务</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{row?.scheduleName || schedule?.name || `定时任务 ${scheduleId}`}</Text>
      <Spacer />
      {look && row ? <PhasePill theme={theme} hue={look.hue} icon={row.status === "running" ? undefined : look.icon} label={look.label} solid={row.status === "failed"} /> : null}
    </View>
    {/* Non-breaking spaces keep 「耗时 14 分」 on one line; the meta wraps only between parts. */}
    {detail.isPending ? <Skeleton theme={theme} rows={1} /> : <MetaLine theme={theme} numberOfLines={2} parts={[schedule ? cadenceText(schedule, deviceTimeZone()) : null, row ? `这次 ${runMoment(row.startedAt)}` : null,
      row ? runDurationLabel(row) && `耗时 ${runDurationLabel(row)}` : null, schedule?.status === "deleted" ? "任务已删除" : schedule?.status === "paused" ? "已暂停" : null, detail.isError ? "暂时读不到运行记录" : null]
      .map(part => typeof part === "string" ? part.replace(/ /g, "\u00a0") : part)} />}
    {error ? <Text numberOfLines={2} style={{ color: hueColor(theme, "fail", "text"), fontSize: fontSize.small, lineHeight: 19 }}>{error}</Text> : null}
    {onOpenAll ? <View style={{ alignItems: "flex-start" }}><Button theme={theme} size="sm" tone="violet" icon="CalendarRange" label="查看全部运行" onPress={onOpenAll} /></View> : null}
  </View>;
}

/**
 * An archived schedule Agent's result: the reply the schedule recorded, without loading the session. Reading the full
 * result (first input, artifacts, tests) loads the archived session in the host, so it waits for a tap.
 * Also the fallback when a schedule Agent's session cannot be read (`notice` says why, the button retries).
 */
export function RecordedRunResult({ theme, runId, header, lead, inset, onLoadFull, notice = null, loadLabel = "读取完整结果", loadHint = "会临时载入这个已归档会话，补上最初输入、产物和验证证据", loading = false }: {
  theme: PluginTheme; runId: string; header?: ReactNode; lead?: ReactNode; inset: number; onLoadFull: () => void; notice?: string | null; loadLabel?: string; loadHint?: string | null; loading?: boolean }) {
  const { colors } = theme;
  const detail = useScheduleRun(runId, false);
  const output = detail.data?.output ?? null;
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: space.xxl }}>
    <View style={{ paddingHorizontal: inset }}>{header}</View>
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg, gap: space.xl }}>
      {notice ? <Banner theme={theme} tone="warning" message={notice} /> : null}
      {lead}
      <View style={{ gap: space.sm }}>
        <PaneLabel theme={theme} icon="MessageSquareText" tone="success" trailing={<MetaLine theme={theme} parts={["定时任务记录"]} />}>最终回复</PaneLabel>
        {detail.isPending ? <Skeleton theme={theme} rows={3} /> : output ? <OutputText theme={theme} text={output} />
          : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>{detail.data?.note ?? "暂时读不到这次运行的记录。"}</Text>}
        {detail.data?.outputTruncated ? <MetaLine theme={theme} parts={["回复超过 6 万字，只显示开头"]} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: space.xs }}>
          <Button theme={theme} icon={loadHint ? "FileSearch" : "RefreshCw"} label={loadLabel} busy={loading} onPress={onLoadFull} />
          {loadHint ? <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{loadHint}</Text> : null}
        </View>
      </View>
    </View>
  </ScrollView>;
}
