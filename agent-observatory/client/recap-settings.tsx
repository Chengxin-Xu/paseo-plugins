import { t } from "../shared/text";
import { currentLanguage } from "../shared/i18n";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { GROK_DEFAULT_MODEL, grokRunnerLabel, type InsightRunner } from "../shared/insights";
import { RECAP_DEFAULTS, RECAP_GROK_EFFORT, recapSettings, type RecapSettings } from "../shared/recap";
import { Banner, Badge, Button, MetaLine, Skeleton, fontSize, gradient, hue, radius, relativeTime, space, withAlpha } from "./kit";
import { PaneLabel, Switch } from "./ui";
import { Choice, GrokOptions, OtherModel, sameRunner } from "./runner-choice";
import { useInsightRunners } from "./use-insight-overview";
import { recapStatusQueryKey, useRecapStatus } from "./use-recaps";

type GrokRunner = Extract<InsightRunner, { kind: "grok" }>;
const grokOf = (runner: InsightRunner): GrokRunner => runner.kind === "grok" ? runner : { kind: "grok" };
/** A recap's Grok runner as it runs: the default model at low effort unless set. */
const recapGrokLabel = (runner: InsightRunner) => { const grok = grokOf(runner); return grokRunnerLabel({ model: grok.model ?? GROK_DEFAULT_MODEL, effort: grok.effort ?? RECAP_GROK_EFFORT }); };

/**
 * 每轮小结 and 建议回复 in the settings (观测设置 and 分析设置 show the same section): both off on a new install, what turning
 * them on sends where, who writes recaps (the Grok CLI at low effort by default, a profile or another model) and whether it
 * can right now. Saved as the host setting `recap`, so every device and the server see one value.
 */
export function RecapSettingsSection({ theme, open = true }: { theme: PluginTheme; open?: boolean }) {
  const { colors } = theme, toast = useToast(), cache = useQueryClient();
  const settings = useSettings(recapSettings);
  const ready = settings.status === "ready", values: RecapSettings = ready ? settings.values : RECAP_DEFAULTS;
  const [choosing, setChoosing] = useState(false);
  const status = useRecapStatus(open && ready && values.enabled), runners = useInsightRunners(open && choosing);
  const save = async (patch: Partial<RecapSettings>, done?: string) => {
    if (settings.status !== "ready") return;
    const saved = await settings.save({ ...settings.values, ...patch }, settings.revision);
    if (!saved) { toast.error(t("recap.saveFailed", { error: settings.saveError ?? "" })); return; }
    if (done) toast.show(done, { variant: "success" });
    // Every host's recap list and the status read again: the server picks the setting up at once.
    void cache.invalidateQueries({ predicate: query => query.queryKey[0] === "agent-observatory" && query.queryKey[2] === "recaps" });
    void cache.invalidateQueries({ queryKey: recapStatusQueryKey });
  };
  const choose = (runner: InsightRunner, label: string) => { void save({ runner }, t("recap.runnerSaved", { runner: label })); };
  const on = values.enabled, fuchsia = hue(theme, "fuchsia"), info = status.data;
  const runnerLabel = info?.runner ?? (values.runner.kind === "grok" || values.runner.kind === "auto" ? recapGrokLabel(values.runner) : values.runner.kind === "profile" ? values.runner.profileId : values.runner.provider);
  const problem = !on || !info ? null : info.problem === "grok" ? t("recap.problemGrok") : info.problem === "runner" ? t("recap.problemRunner", { reason: info.reason ?? "" })
    : info.problem === "backoff" ? t("recap.problemBackoff", { time: info.until ? new Date(info.until).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit", hour12: false }) : "" }) : null;
  const data = runners.data, current = values.runner, helpers = current.kind === "profile" || current.kind === "provider";
  return <View testID="recap-settings" style={{ gap: space.sm }}>
    <PaneLabel theme={theme}>{t("recap.title")}</PaneLabel>
    {settings.status === "loading" ? <Skeleton theme={theme} rows={2} /> : null}
    {settings.status === "error" || settings.status === "invalid" ? <Banner theme={theme} tone="danger" message={t("recap.loadFailed", { error: settings.error })}
      action={settings.status === "invalid" ? { label: t("recap.reset"), onPress: () => void settings.reset() } : { label: t("recap.retry"), onPress: () => void settings.reload() }} /> : null}
    <View style={[{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg, overflow: "hidden" },
      on ? gradient(theme, [withAlpha(fuchsia, 0.24), withAlpha(hue(theme, "violet"), 0.06)], { angle: 120 }) : { borderWidth: 1, borderColor: colors.border }]}>
      <Text style={{ color: on ? fuchsia : colors.foregroundMuted, fontSize: 18, fontWeight: "800" }}>✦</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{t("recap.enableLabel")}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{on ? t("recap.enabledHint", { runner: runnerLabel }) : t("recap.disabledHint")}</Text>
      </View>
      <Switch theme={theme} label={t("recap.enableLabel")} value={on} disabled={!ready || settings.saving} onChange={enabled => void save({ enabled })} />
    </View>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{t("recap.privacy")}</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xs, opacity: on ? 1 : 0.55 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{t("recap.suggestionsLabel")}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("recap.suggestionsHint")}</Text>
      </View>
      <Switch theme={theme} label={t("recap.suggestionsLabel")} value={on && values.suggestions} disabled={!ready || !on || settings.saving} onChange={suggestions => void save({ suggestions })} />
    </View>
    {on ? <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{t("recap.writtenByLabel")}</Text>
        <Badge theme={theme} label={runnerLabel} tone="fuchsia" icon="Sparkles" />
        {status.isPending ? null : info?.available && !info.problem ? <Badge theme={theme} label={t("recap.ready")} tone="success" icon="CircleCheck" /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={choosing ? t("recap.collapseRunners") : t("recap.changeRunner")} aria-expanded={choosing} onPress={() => setChoosing(!choosing)} hitSlop={6}
          style={state => ({ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: space.sm, minHeight: 28, borderRadius: radius.full, opacity: state.pressed ? 0.75 : 1 })}>
          <Text style={{ color: hue(theme, "fuchsia", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{choosing ? t("recap.collapseRunners") : t("recap.changeRunner")}</Text>
          <Icon name={choosing ? "ChevronUp" : "ChevronDown"} size={13} color={hue(theme, "fuchsia")} />
        </Pressable>
      </View>
      {problem ? <Banner theme={theme} tone="warning" message={problem} /> : null}
      {info?.lastAt && info.lastOutcome === "written" ? <MetaLine theme={theme} parts={[t("recap.lastWritten", { when: relativeTime(info.lastAt) })]} /> : null}
      {choosing ? <View style={{ gap: space.sm }}>
        {runners.isPending ? <Skeleton theme={theme} rows={3} /> : null}
        {runners.error ? <Banner theme={theme} tone="danger" message={t("recap.runnersFailed", { error: runners.error.message })} action={{ label: t("recap.retry"), onPress: () => void runners.refetch() }} /> : null}
        {data ? <>
          <Choice theme={theme} option={{ ...data.builtin, runner: grokOf(current), label: recapGrokLabel(current), thinkingLabel: grokOf(current).effort ?? RECAP_GROK_EFFORT, detail: t("recap.grokDetail") }} badge={t("recap.defaultBadge")}
            selected={current.kind === "grok" || current.kind === "auto"} onPress={() => choose(grokOf(current), recapGrokLabel(current))} />
          {(current.kind === "grok" || current.kind === "auto") && data.builtin.available ? <GrokOptions theme={theme} runner={grokOf(current)} busy={settings.saving} defaultEffort={RECAP_GROK_EFFORT} onSave={runner => choose(runner, recapGrokLabel(runner))} /> : null}
          {data.profiles.map(option => <Choice key={JSON.stringify(option.runner)} theme={theme} option={option} selected={sameRunner(option.runner, current)} onPress={() => choose(option.runner, option.label)} />)}
          {data.providers.length ? <OtherModel theme={theme} providers={data.providers} current={current.kind === "provider" ? current : undefined} busy={settings.saving}
            onUse={runner => { const entry = data.providers.find(item => item.provider === runner.provider); choose(runner, t("recap.runnerModel", { provider: entry?.label ?? runner.provider, model: runner.model ?? "" })); }} /> : null}
        </> : null}
      </View> : null}
      {/* What a profile or another model leaves behind: said while choosing, and as long as one is chosen. */}
      {choosing || helpers ? <Text testID="recap-provider-note" style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{t("recap.providerNote")}</Text> : null}
    </View> : null}
  </View>;
}
