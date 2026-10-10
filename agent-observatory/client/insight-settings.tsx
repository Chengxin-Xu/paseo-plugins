import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { GROK_DEFAULT_EFFORT, GROK_DEFAULT_MODEL, GROK_EFFORTS, grokModelSchema, grokRunnerLabel, type GrokEffort, type InsightJob, type InsightRunner, type InsightRunnerOption, type InsightSettings } from "../shared/insights";
import { Badge, Banner, Button, Chip, MetaLine, Sheet, Skeleton, TextField, fontSize, gradient, hue, isDarkTheme, radius, space, withAlpha, type Hue } from "./kit";
import { PaneLabel, Switch } from "./ui";
import { useConfigureInsights, useInsightModels, useInsightRunners } from "./use-insight-overview";

/** Reports before 2.7 carry no runner info: they were always the Grok CLI. */
export function runnerLabelOf(job: Pick<InsightJob, "runner" | "model" | "effort">): string {
  return job.runner?.label ?? (job.model === "grok-4.6" ? "Grok 4.6 · xhigh" : `Grok 4.7 · ${job.effort ?? "xhigh"}`);
}
export const sameRunner = (a: InsightRunner | undefined, b: InsightRunner | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
const accessLooks: Record<InsightRunnerOption["access"], { label: string; hue: Hue; icon: string; hint: string }> = {
  none: { label: "不用工具", hue: "green", icon: "ShieldCheck", hint: "在临时目录里运行，不创建会话" },
  read: { label: "只读", hue: "teal", icon: "Eye", hint: "以只读模式运行，可以查看代码但不能修改" },
  ask: { label: "需审批时拒绝", hue: "amber", icon: "ShieldAlert", hint: "没有只读模式：需要审批的工具请求会被自动拒绝，不需要审批的操作（例如读取文件）仍可能执行" },
};

function AccessBadge({ theme, access }: { theme: PluginTheme; access: InsightRunnerOption["access"] }) {
  const look = accessLooks[access];
  return <Badge theme={theme} label={look.label} tone={look.hue} icon={look.icon} />;
}

/** A runner as a radio card: the chosen one gets a coloured edge and tint. */
function Choice({ theme, option, selected, badge, onPress }: { theme: PluginTheme; option: InsightRunnerOption; selected: boolean; badge?: string; onPress: () => void }) {
  const { colors } = theme, dark = isDarkTheme(theme), main = hue(theme, "teal");
  const parts = [option.providerLabel, option.modelLabel, option.thinkingLabel].filter(Boolean);
  return <Pressable accessibilityRole="radio" accessibilityLabel={`${option.label}${option.available ? "" : "（不可用）"}`} accessibilityState={{ checked: selected, disabled: !option.available }} aria-checked={selected}
    disabled={!option.available} onPress={onPress}
    style={state => [{ flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: selected ? 1.5 : 1,
      borderColor: selected ? main : colors.border, backgroundColor: selected ? withAlpha(main, dark ? 0.14 : 0.08) : "transparent", opacity: option.available ? state.pressed ? 0.8 : 1 : 0.5 }]}>
    <View style={{ width: 18, height: 18, marginTop: 2, borderRadius: 9, borderWidth: 2, borderColor: selected ? main : colors.foregroundMuted, alignItems: "center", justifyContent: "center" }}>
      {selected ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: main }} /> : null}
    </View>
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>{option.label}</Text>
        {badge ? <Badge theme={theme} label={badge} tone="violet" solid /> : null}
        <AccessBadge theme={theme} access={option.access} />
      </View>
      {parts.length ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{parts.join(" · ")}</Text> : null}
      {option.detail ? <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{option.detail}</Text> : null}
      {option.reason ? <Text style={{ color: hue(theme, option.available ? "amber" : "red", "text"), fontSize: fontSize.meta }}>{option.reason}</Text> : null}
    </View>
  </Pressable>;
}

type GrokRunner = Extract<InsightRunner, { kind: "grok" }>;
/** The built-in Grok CLI's model and reasoning effort; unset values are the defaults, so an untouched choice stays `{ kind: "grok" }`. */
function GrokOptions({ theme, runner, busy, onSave }: { theme: PluginTheme; runner: GrokRunner; busy: boolean; onSave: (runner: GrokRunner) => void }) {
  const { colors } = theme;
  const [model, setModel] = useState(runner.model ?? "");
  const [effort, setEffort] = useState<GrokEffort>(runner.effort ?? GROK_DEFAULT_EFFORT);
  useEffect(() => { setModel(runner.model ?? ""); setEffort(runner.effort ?? GROK_DEFAULT_EFFORT); }, [runner.model, runner.effort]);
  const id = model.trim(), valid = !id || grokModelSchema.safeParse(id).success;
  const next: GrokRunner = { kind: "grok", ...(id && id !== GROK_DEFAULT_MODEL ? { model: id } : {}), ...(effort !== GROK_DEFAULT_EFFORT ? { effort } : {}) };
  const changed = next.model !== runner.model || next.effort !== runner.effort;
  return <View style={{ gap: space.md, marginLeft: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: withAlpha(hue(theme, "teal"), 0.35) }}>
    <TextField theme={theme} label="Grok 模型" value={model} onChangeText={setModel} placeholder={`${GROK_DEFAULT_MODEL}（默认）`}
      hint={valid ? "留空用默认模型。可以填 Grok CLI 支持的其他模型 ID（grok models 会列出）。" : "模型 ID 只能包含字母、数字和 . _ : / -，并以字母或数字开头"} />
    <View style={{ gap: space.xs }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>推理档</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {GROK_EFFORTS.map(option => <Chip key={option} theme={theme} label={option === GROK_DEFAULT_EFFORT ? `${option}（默认）` : option} tone="violet" selected={effort === option} onPress={() => setEffort(option)} />)}
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      <Button theme={theme} variant="primary" icon="Check" label="保存 Grok 设置" busy={busy} disabled={busy || !valid || !changed} onPress={() => onSave(next)} />
      {runner.model || runner.effort ? <Button theme={theme} variant="ghost" icon="RotateCcw" label="恢复默认" disabled={busy} onPress={() => onSave({ kind: "grok" })} /> : null}
    </View>
  </View>;
}

/** Provider → model → thinking, for models no profile covers. */
function OtherModel({ theme, providers, current, busy, onUse }: { theme: PluginTheme; providers: readonly { provider: string; label: string; available: boolean; reason: string | null; access: InsightRunnerOption["access"] }[];
  current?: Extract<InsightRunner, { kind: "provider" }>; busy: boolean; onUse: (runner: Extract<InsightRunner, { kind: "provider" }>) => void }) {
  const { colors } = theme;
  const [provider, setProvider] = useState<string | null>(current?.provider ?? null);
  const [model, setModel] = useState<string | null>(current?.model ?? null);
  const [thinking, setThinking] = useState<string | null>(current?.thinkingOptionId ?? null);
  const [all, setAll] = useState(false);
  const models = useInsightModels(provider);
  const list = models.data?.models ?? [];
  const chosen = list.find(item => item.id === model) ?? list.find(item => item.isDefault) ?? list[0];
  useEffect(() => { if (chosen && !list.some(item => item.id === model)) { setModel(chosen.id); setThinking(chosen.defaultThinkingOptionId); } }, [chosen?.id, provider]);
  const entry = providers.find(item => item.provider === provider);
  const shown = all ? list : list.slice(0, 8);
  return <View style={{ gap: space.md }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {providers.map(item => <Chip key={item.provider} theme={theme} label={item.label} tone={item.available ? "teal" : undefined} selected={provider === item.provider}
        onPress={item.available ? () => { setProvider(item.provider); setModel(null); setThinking(null); setAll(false); } : undefined} />)}
    </View>
    {entry ? <View style={{ gap: space.sm }}>
      <AccessBadge theme={theme} access={entry.access} />
      {models.isPending ? <Skeleton theme={theme} rows={2} /> : null}
      {models.error ? <Banner theme={theme} tone="danger" message={`模型列表读取失败：${models.error.message}`} /> : null}
      {shown.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: chosen?.id === item.id }} aria-checked={chosen?.id === item.id}
        onPress={() => { setModel(item.id); setThinking(item.defaultThinkingOptionId); }}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 34, paddingHorizontal: space.sm, borderRadius: radius.md, opacity: state.pressed ? 0.75 : 1,
          backgroundColor: chosen?.id === item.id ? withAlpha(hue(theme, "teal"), 0.12) : "transparent" })}>
        <Icon name={chosen?.id === item.id ? "CircleDot" : "Circle"} size={14} color={chosen?.id === item.id ? hue(theme, "teal") : colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: chosen?.id === item.id ? "700" : "500" }}>{item.label}</Text>
        {item.isDefault ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>默认</Text> : null}
      </Pressable>)}
      {list.length > 8 ? <Pressable accessibilityRole="button" onPress={() => setAll(!all)} style={{ alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: space.sm }}>
        <Text style={{ color: hue(theme, "teal", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{all ? "收起" : `显示全部 ${list.length} 个模型`}</Text>
      </Pressable> : null}
      {chosen?.thinking.length ? <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>思考强度</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {chosen.thinking.map(option => <Chip key={option.id} theme={theme} label={option.label} tone="violet" selected={(thinking ?? chosen.defaultThinkingOptionId) === option.id} onPress={() => setThinking(option.id)} />)}
        </View>
      </View> : null}
      {chosen ? <View style={{ alignItems: "flex-start" }}><Button theme={theme} variant="primary" icon="Check" busy={busy} disabled={busy} label={`使用 ${chosen.label}`}
        onPress={() => onUse({ kind: "provider", provider: entry.provider, model: chosen.id, thinkingOptionId: thinking ?? chosen.defaultThinkingOptionId })} /></View> : null}
    </View> : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>选一个 Provider，再挑模型和思考强度</Text>}
  </View>;
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
    configure.mutate({ runner }, { onSuccess: () => toast.show(`之后的分析和建议由 ${label} 来写`, { variant: "success" }), onError: error => toast.error(error.message) });
  };
  const data = runners.data;
  return <Sheet title={pick?.title ?? "分析设置"} open={open} onClose={onClose}>
    {!pick ? <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>自动分析</PaneLabel>
      <View style={[{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg, overflow: "hidden" },
        settings?.autoEnabled ? gradient(theme, [withAlpha(hue(theme, "teal"), 0.22), withAlpha(hue(theme, "cyan"), 0.06)], { angle: 120 }) : { borderWidth: 1, borderColor: colors.border }]}>
        <Icon name={settings?.autoEnabled ? "Sparkles" : "PauseCircle"} size={18} color={settings?.autoEnabled ? hue(theme, "teal") : colors.foregroundMuted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "700" }}>任务结束后自动分析</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{settings?.autoEnabled ? "已开启" : "已关闭 · 需要时在会话里手动分析"}</Text>
        </View>
        <Switch theme={theme} label="任务结束后自动分析" value={settings?.autoEnabled ?? false} disabled={!settings || configure.isPending}
          onChange={enabled => configure.mutate({ autoEnabled: enabled }, { onError: error => toast.error(error.message) })} />
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>
        {`至少 ${settings?.minTurns ?? 3} 轮对话、${settings?.minTools ?? 3} 次工具调用的任务结束后触发，同一会话 ${settings?.cooldownHours ?? 6} 小时内只分析一次。开启后，每积累 3 份新报告（间隔至少 20 小时）会自动更新总览里的建议。`}
      </Text>
    </View> : null}
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>{pick ? "这次由谁来分析" : "谁来分析"}</PaneLabel>
      {runners.isPending ? <Skeleton theme={theme} rows={3} /> : null}
      {runners.error ? <Banner theme={theme} tone="danger" message={`读取可用模型失败：${runners.error.message}`} action={{ label: "重试", onPress: () => void runners.refetch() }} /> : null}
      {data ? <>
        <Choice theme={theme} option={data.auto} badge="默认" selected={!pick && current.kind === "auto"} onPress={() => choose(data.auto.runner, data.auto.label)} />
        <Choice theme={theme} option={data.builtin} selected={!pick && current.kind === "grok"} onPress={() => choose(data.builtin.runner, data.builtin.label)} />
        {!pick && current.kind === "grok" && data.builtin.available ? <GrokOptions theme={theme} runner={current} busy={configure.isPending} onSave={runner => choose(runner, grokRunnerLabel(runner))} /> : null}
        {data.profiles.length ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "700", marginTop: space.xs }}>你的 Profile</Text> : null}
        {data.profiles.map(option => <Choice key={JSON.stringify(option.runner)} theme={theme} option={option} selected={!pick && sameRunner(option.runner, current)} onPress={() => choose(option.runner, option.label)} />)}
        {data.providers.length ? <View style={{ gap: space.sm, marginTop: space.xs }}>
          <Pressable accessibilityRole="button" accessibilityLabel={other ? "收起其他模型" : "选择其他模型"} aria-expanded={other} onPress={() => setOther(!other)}
            style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, opacity: state.pressed ? 0.75 : 1 })}>
            <Icon name={other ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
            <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>其他模型</Text>
            {!pick && current.kind === "provider" ? <Badge theme={theme} label="当前" tone="teal" /> : null}
          </Pressable>
          {other ? <OtherModel theme={theme} providers={data.providers} current={current.kind === "provider" ? current : undefined} busy={configure.isPending}
            onUse={runner => { const entry = data.providers.find(item => item.provider === runner.provider); choose(runner, `${entry?.label ?? runner.provider} · ${runner.model ?? "默认模型"}`); }} /> : null}
        </View> : null}
      </> : null}
    </View>
    <MetaLine theme={theme} numberOfLines={5} parts={["选 Profile 或其他模型时，分析会作为被分析会话的子 Agent 在它的工作区里运行：有只读模式就用只读模式，否则用逐项审批的模式并拒绝每个审批请求；写完报告就自动归档，用量计入对应账号。没有这两种模式的提供商不能用来分析。"]} />
    {configure.error ? <Banner theme={theme} tone="danger" message={configure.error.message} /> : null}
  </Sheet>;
}
