import { t } from "../shared/text";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { grokRunnerLabel, type InsightJob, type InsightRunner, type InsightSettings } from "../shared/insights";
import { Badge, Banner, MetaLine, Sheet, Skeleton, fontSize, gradient, hue, radius, space, withAlpha } from "./kit";
import { PaneLabel, Switch } from "./ui";
import { useConfigureInsights, useInsightRunners } from "./use-insight-overview";
import { RecapSettingsSection } from "./recap-settings";
import { Choice, GrokOptions, OtherModel, sameRunner } from "./runner-choice";

/** Reports before 2.7 carry no runner info: they were always the Grok CLI. */
export function runnerLabelOf(job: Pick<InsightJob, "runner" | "model" | "effort">): string {
  return job.runner?.label ?? (job.model === "grok-4.6" ? "Grok 4.6 · xhigh" : t("coreInsightSettings.grokLegacyRunner", { effort: job.effort ?? "xhigh" }));
}

/**
 * 分析设置: automatic analysis on/off and who writes reports and suggestions. `pick` mode reuses the list to choose a
 * runner for one analysis (换个模型分析) without changing the setting.
 */
export function InsightSettingsSheet({ theme, open, onClose, settings, pick }: { theme: PluginTheme; open: boolean; onClose: () => void; settings?: InsightSettings;
  pick?: { title: string; onPick: (runner: InsightRunner) => void } }) {
  const { colors } = theme, toast = useToast();
  const runners = useInsightRunners(open), configure = useConfigureInsights();
  const [other, setOther] = useState(false);
  const current = settings?.runner ?? { kind: "auto" as const };
  useEffect(() => { if (open) setOther(current.kind === "provider"); }, [open]);
  const choose = (runner: InsightRunner, label: string) => {
    if (pick) { pick.onPick(runner); onClose(); return; }
    configure.mutate({ runner }, { onSuccess: () => toast.show(t("coreInsightSettings.futureAnalysesAndSuggestionsWillBeWritten", { value1: label }), { variant: "success" }), onError: error => toast.error(error.message) });
  };
  const data = runners.data;
  return <Sheet title={pick?.title ?? t("coreInsightSettings.analysisSettings")} open={open} onClose={onClose}>
    {!pick ? <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>{t("coreInsightSettings.automaticAnalysis")}</PaneLabel>
      <View style={[{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg, overflow: "hidden" },
        settings?.autoEnabled ? gradient(theme, [withAlpha(hue(theme, "teal"), 0.22), withAlpha(hue(theme, "cyan"), 0.06)], { angle: 120 }) : { borderWidth: 1, borderColor: colors.border }]}>
        <Icon name={settings?.autoEnabled ? "Sparkles" : "PauseCircle"} size={18} color={settings?.autoEnabled ? hue(theme, "teal") : colors.foregroundMuted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{t("coreInsightSettings.analyzeAutomaticallyWhenTasksEnd")}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{settings?.autoEnabled ? t("coreInsightSettings.on") : t("coreInsightSettings.offAnalyzeManuallyInASessionWhen")}</Text>
        </View>
        <Switch theme={theme} label={t("coreInsightSettings.analyzeAutomaticallyWhenTasksEnd")} value={settings?.autoEnabled ?? false} disabled={!settings || configure.isPending}
          onChange={enabled => configure.mutate({ autoEnabled: enabled }, { onError: error => toast.error(error.message) })} />
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>
        {t("coreInsightSettings.triggersWhenATaskWithAtLeast", { value1: settings?.minTurns ?? 3, value2: settings?.minTools ?? 3, value3: settings?.cooldownHours ?? 6 })}
      </Text>
    </View> : null}
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>{pick ? t("coreInsightSettings.whoAnalyzesThisTime") : t("coreInsightSettings.whoAnalyzes")}</PaneLabel>
      {runners.isPending ? <Skeleton theme={theme} rows={3} /> : null}
      {runners.error ? <Banner theme={theme} tone="danger" message={t("coreInsightSettings.couldNotLoadAvailableModels", { value1: runners.error.message })} action={{ label: t("coreInsightSettings.retry"), onPress: () => void runners.refetch() }} /> : null}
      {data ? <>
        <Choice theme={theme} option={data.auto} badge={t("coreInsightSettings.default2")} selected={!pick && current.kind === "auto"} onPress={() => choose(data.auto.runner, data.auto.label)} />
        <Choice theme={theme} option={data.builtin} selected={!pick && current.kind === "grok"} onPress={() => choose(data.builtin.runner, data.builtin.label)} />
        {!pick && current.kind === "grok" && data.builtin.available ? <GrokOptions theme={theme} runner={current} busy={configure.isPending} onSave={runner => choose(runner, grokRunnerLabel(runner))} /> : null}
        {data.profiles.length ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "700", marginTop: space.xs }}>{t("coreInsightSettings.yourProfiles")}</Text> : null}
        {data.profiles.map(option => <Choice key={JSON.stringify(option.runner)} theme={theme} option={option} selected={!pick && sameRunner(option.runner, current)} onPress={() => choose(option.runner, option.label)} />)}
        {data.providers.length ? <View style={{ gap: space.sm, marginTop: space.xs }}>
          <Pressable accessibilityRole="button" accessibilityLabel={other ? t("coreInsightSettings.collapseOtherModels") : t("coreInsightSettings.chooseAnotherModel")} aria-expanded={other} onPress={() => setOther(!other)}
            style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, opacity: state.pressed ? 0.75 : 1 })}>
            <Icon name={other ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
            <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{t("coreInsightSettings.otherModels")}</Text>
            {!pick && current.kind === "provider" ? <Badge theme={theme} label={t("coreInsightSettings.current")} tone="teal" /> : null}
          </Pressable>
          {other ? <OtherModel theme={theme} providers={data.providers} current={current.kind === "provider" ? current : undefined} busy={configure.isPending}
            onUse={runner => { const entry = data.providers.find(item => item.provider === runner.provider); choose(runner, t("coreInsightSettings.runnerModel", { provider: entry?.label ?? runner.provider, model: runner.model ?? t("coreInsightSettings.defaultModel") })); }} /> : null}
        </View> : null}
      </> : null}
    </View>
    <MetaLine theme={theme} numberOfLines={4} parts={[t("coreInsightSettings.analysisSendsSessionExcerptsPromptsRepliesTool")]} />
    <MetaLine theme={theme} numberOfLines={5} parts={[t("coreInsightSettings.withAProfileOrAnotherModelAnalysis")]} />
    {configure.error ? <Banner theme={theme} tone="danger" message={configure.error.message} /> : null}
    {/* 每轮小结 has its own switch and runner (the host setting `recap`). */}
    {!pick ? <RecapSettingsSection theme={theme} open={open} /> : null}
  </Sheet>;
}
