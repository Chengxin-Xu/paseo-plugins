import { useState } from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { alertSettings, defaultAlertSettings, getSidebarLabelStatus, type AlertSettings } from "../shared/alerts";
import { t } from "../shared/text";
import { useI18n } from "./i18n-client";
import { Button, space } from "./kit";
import { playChime } from "./chime";
import { deviceMuteKept, deviceMuted, setDeviceMuted } from "./chime-device";
import { useForeground } from "./use-foreground";

type Play = (source: { base64: string; mimeType: string }) => Promise<void>;
let player: Play | null = null;
/** The host's `playAudio` for 试听, handed over when the UI chunk is set up (it is a method of the plugin's client context). */
export function setChimePlayer(play: Play | null): void { player = play; }

const OFF = "off";
const CLOCKS = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
const TRIES = [["question", "alertsSettings.tryQuestion"], ["approval", "alertsSettings.tryApproval"], ["quota", "alertsSettings.tryQuota"], ["error", "alertsSettings.tryError"], ["done", "alertsSettings.tryDone"]] as const;

/**
 * 提醒 in the plugin's settings and the board's 观测设置: the chime (which kinds, subagents, quiet hours, this device muted, a
 * sample of each sound) and the sidebar labels (and pins), with what the server reports about them. Host settings controls, as
 * Paseo's own pages; the switches save to the `alerts` host setting at once.
 */
export function AlertSettingsSections({ theme }: { theme: PluginTheme }) {
  useI18n();
  const settings = useSettings(alertSettings), foreground = useForeground();
  const values: AlertSettings = settings.status === "ready" ? settings.values : defaultAlertSettings;
  const ready = settings.status === "ready" && !settings.saving;
  const save = (patch: Partial<AlertSettings>) => { if (settings.status === "ready") void settings.save({ ...settings.values, ...patch }, settings.revision); };
  const [muted, setMuted] = useState(deviceMuted), kept = deviceMuteKept();
  const readStatus = useRpc(getSidebarLabelStatus);
  const status = useQuery({ queryKey: ["agent-observatory", "alerts", "labels"], queryFn: () => readStatus({}), enabled: foreground && (values.sidebarLabels || settings.status === "ready"),
    refetchInterval: foreground && values.sidebarLabels ? 10_000 : false, retry: false, staleTime: 5_000 });
  const label = status.data;
  const labelState = !values.sidebarLabels ? (label?.labels || label?.pins ? t("alertsSettings.labelsCleaning") : t("alertsSettings.labelsOff"))
    : !label || label.state === "starting" ? t("alertsSettings.labelsStarting")
    : label.state === "unsupported" ? t("alertsSettings.labelsUnsupported")
    : label.state === "error" ? t("alertsSettings.labelsError", { error: label.error ?? "" })
    : t("alertsSettings.labelsOn", { labels: label.labels, pins: label.pins });
  const kind = (key: keyof AlertSettings, title: Parameters<typeof t>[0]) => <SettingsSwitch label={t(title)} value={values[key] === true} disabled={!ready} onValueChange={next => save({ [key]: next })} />;
  const clockOptions = [{ value: OFF, label: t("alertsSettings.quietNone") }, ...CLOCKS.map(clock => ({ value: clock, label: clock }))];
  return <>
    <SettingsSection title={t("alertsSettings.chimeTitle")}>
      <SettingsCard>
        <SettingsSwitch label={t("alertsSettings.chime")} hint={t("alertsSettings.chimeHint")} value={values.chime} disabled={!ready} error={settings.saveError ?? (settings.status === "error" || settings.status === "invalid" ? settings.error : null)}
          onValueChange={next => save({ chime: next })} />
        {values.chime ? <>
          {kind("chimeQuestion", "alertsSettings.chimeQuestion")}
          {kind("chimeApproval", "alertsSettings.chimeApproval")}
          {kind("chimeQuota", "alertsSettings.chimeQuota")}
          {kind("chimeError", "alertsSettings.chimeError")}
          {kind("chimeDone", "alertsSettings.chimeDone")}
          <SettingsSwitch label={t("alertsSettings.chimeSubagents")} hint={t("alertsSettings.chimeSubagentsHint")} value={values.chimeSubagents} disabled={!ready} onValueChange={next => save({ chimeSubagents: next })} />
          <SettingsSelect label={t("alertsSettings.quietFrom")} hint={t("alertsSettings.quietHint")} value={values.quietFrom || OFF} options={clockOptions} disabled={!ready}
            onValueChange={next => save(next === OFF ? { quietFrom: "", quietTo: "" } : { quietFrom: next, quietTo: values.quietTo || "08:00" })} />
          {values.quietFrom ? <SettingsSelect label={t("alertsSettings.quietTo")} value={values.quietTo || OFF} options={clockOptions} disabled={!ready}
            onValueChange={next => save(next === OFF ? { quietFrom: "", quietTo: "" } : { quietTo: next })} /> : null}
        </> : null}
        <SettingsSwitch label={t("alertsSettings.deviceMuted")} hint={kept ? t("alertsSettings.deviceMutedKept") : t("alertsSettings.deviceMutedSession")} value={muted}
          onValueChange={next => { setDeviceMuted(next); setMuted(next); }} />
        <SettingsRow label={t("alertsSettings.try")} hint={t("alertsSettings.tryHint")}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, maxWidth: "100%" }}>
            {TRIES.map(([sound, title]) => <Button key={sound} theme={theme} size="sm" tone="sky" icon="Volume2" label={t(title)} disabled={!player} testID={`chime-try-${sound}`}
              onPress={() => { if (player) playChime(player, sound); }} />)}
          </View>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title={t("alertsSettings.labelsTitle")}>
      <SettingsCard>
        <SettingsSwitch label={t("alertsSettings.labels")} hint={t("alertsSettings.labelsHint")} value={values.sidebarLabels} disabled={!ready} onValueChange={next => save({ sidebarLabels: next })} />
        <SettingsSwitch label={t("alertsSettings.pin")} hint={t("alertsSettings.pinHint")} value={values.sidebarPin} disabled={!ready || !values.sidebarLabels} onValueChange={next => save({ sidebarPin: next })} />
        <SettingsRow label={t("alertsSettings.labelsStatus")} hint={labelState} />
      </SettingsCard>
    </SettingsSection>
  </>;
}
