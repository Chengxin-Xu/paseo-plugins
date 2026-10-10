import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { InsightReport } from "../shared/insights";
import type { SuggestionAction } from "../shared/insight-overview";
import type { AgentRecord } from "../shared/model";
import { Badge, Banner, Button, MetaLine, Sheet, Skeleton, TextField, fontSize, hue, radius, space, withAlpha } from "./kit";
import { PaneLabel } from "./ui";
import { insightsQueryPrefix } from "./use-insight-overview";

type Finding = InsightReport["findings"][number];
const severityNames: Record<Finding["severity"], string> = { high: "高优先级", medium: "中优先级", low: "低优先级" };

/** The follow-up an analysed Agent receives for one finding; the user edits it before sending. */
export function findingMessage(finding: Finding): string {
  return [`观测台分析在你的执行记录里发现一个问题，请先评估再处理：`, "", `【${finding.title}】（${severityNames[finding.severity]}）`, finding.detail, "",
    `建议：${finding.recommendation}`, "", "如果你判断这不是问题，请说明理由；如果需要改动，完成后说明验证方式。"].join("\n");
}
/** A task prompt for a suggestion without one. */
export function actionPrompt(action: SuggestionAction): string {
  return action.task ?? [action.title, "", action.why, ...(action.steps.length ? ["", "步骤：", ...action.steps.map((step, index) => `${index + 1}. ${step}`)] : []),
    ...(action.instruction ? ["", "需要写进说明的规则：", action.instruction] : [])].join("\n");
}

/** 发给这个 Agent: send a finding as a follow-up message to the analysed Agent (explicit, editable). */
export function SendToAgentSheet({ theme, open, onClose, agentId, agentTitle, finding, onSent }: { theme: PluginTheme; open: boolean; onClose: () => void; agentId: string; agentTitle: string;
  finding: Finding | null; onSent?: () => void }) {
  const paseo = usePaseo(), toast = useToast();
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open && finding) { setText(findingMessage(finding)); setError(null); } }, [open, finding?.id]);
  const send = async () => {
    setBusy(true); setError(null);
    try { await paseo.agents.ref(agentId).send(text.trim()); toast.show(`已发给「${agentTitle}」`, { variant: "success" }); onSent?.(); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "发送失败"); }
    finally { setBusy(false); }
  };
  return <Sheet title="发给这个 Agent" open={open} onClose={onClose}>
    <MetaLine theme={theme} numberOfLines={2} parts={[`「${agentTitle}」会在原会话里收到这条消息并继续执行`]} />
    <TextField theme={theme} label="消息" value={text} onChangeText={setText} multiline minHeight={200} />
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
      <Button theme={theme} label="取消" onPress={onClose} />
      <Button theme={theme} variant="primary" icon="Send" label="发送" busy={busy} disabled={busy || !text.trim()} onPress={() => void send()} />
    </View>
  </Sheet>;
}

interface ProfileEntry { id: string; name: string; provider: string; model?: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown>; notes?: string }
/** One workspace per project for hand-offs: the main checkout when an Agent ran there, else the newest Agent's. */
export function projectWorkspaces(agents: readonly AgentRecord[]) {
  const byProject = new Map<string, AgentRecord>();
  const rank = (agent: AgentRecord) => agent.checkoutKind === "main" ? 2 : agent.checkoutKind === "directory" ? 1 : 0;
  for (const agent of agents) {
    if (!agent.workspaceId || agent.labels["observatory.role"] === "insight") continue;
    const current = byProject.get(agent.projectName);
    if (!current || rank(agent) > rank(current) || rank(agent) === rank(current) && (agent.lastActivityAt ?? "") > (current.lastActivityAt ?? "")) byProject.set(agent.projectName, agent);
  }
  return [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName, "zh-CN"));
}

/**
 * 交给 Agent: start a new Agent in a project's workspace with a suggestion's task, using one of the host's profiles
 * exactly as configured (its mode included). Nothing runs until the user presses 开始.
 */
export function HandoffSheet({ theme, open, onClose, action, agents, onCreated }: { theme: PluginTheme; open: boolean; onClose: () => void; action: SuggestionAction | null;
  agents: readonly AgentRecord[]; onCreated: (agentId: string) => void }) {
  const paseo = usePaseo(), toast = useToast(), { colors } = theme;
  const profiles = useQuery({ queryKey: [...insightsQueryPrefix, "profiles"], enabled: open, staleTime: 60_000, retry: 1,
    queryFn: async () => ((await paseo.config.get()).config.agentProfiles ?? []) as ProfileEntry[] });
  const workspaces = useMemo(() => projectWorkspaces(agents), [agents]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null), [profileId, setProfileId] = useState<string | null>(null);
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !action) return;
    setText(actionPrompt(action)); setError(null);
    const target = workspaces.find(item => action.projects.includes(item.projectName)) ?? workspaces[0];
    setWorkspaceId(target?.workspaceId ?? null);
  }, [open, action?.id]);
  useEffect(() => {
    const list = profiles.data ?? [];
    if (!profileId && list.length) setProfileId((list.find(item => /实现|implement/i.test(`${item.name} ${item.id}`)) ?? list[0]!).id);
  }, [profiles.data]);
  const profile = profiles.data?.find(item => item.id === profileId);
  const workspace = workspaces.find(item => item.workspaceId === workspaceId);
  const start = async () => {
    if (!profile || !workspace?.workspaceId || !action) return;
    setBusy(true); setError(null);
    try {
      const handle = await paseo.workspaces.ref(workspace.workspaceId).agents.create({
        config: { provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider, ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}), ...(profile.featureValues ? { featureValues: profile.featureValues } : {}) },
        prompt: text.trim(), title: action.title.slice(0, 60), labels: { "observatory.from-suggestion": action.id.slice(0, 80) } });
      toast.show(`已交给新 Agent：${action.title}`, { variant: "success" }); onCreated(handle.id); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); }
    finally { setBusy(false); }
  };
  const pill = (selected: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: selected ? 1.5 : 1,
    borderColor: selected ? hue(theme, "violet") : colors.border, backgroundColor: selected ? withAlpha(hue(theme, "violet"), 0.1) : "transparent" });
  return <Sheet title="交给 Agent" open={open} onClose={onClose}>
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>在哪个项目</PaneLabel>
      {workspaces.length ? workspaces.slice(0, 12).map(item => <Pressable key={item.workspaceId} accessibilityRole="radio" accessibilityLabel={`项目 ${item.projectName}`} aria-checked={item.workspaceId === workspaceId}
        onPress={() => setWorkspaceId(item.workspaceId)} style={state => [pill(item.workspaceId === workspaceId), { opacity: state.pressed ? 0.8 : 1 }]}>
        <Icon name="FolderGit2" size={14} color={hue(theme, "violet")} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{item.projectName}</Text>
        <Text numberOfLines={1} style={{ maxWidth: 160, color: colors.foregroundMuted, fontSize: 11 }}>{item.branch ?? item.workspaceName ?? ""}</Text>
      </Pressable>) : <Banner theme={theme} tone="warning" message="还没有可用的工作区：先在某个项目里运行过 Agent" />}
    </View>
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>用哪个 Profile</PaneLabel>
      {profiles.isPending ? <Skeleton theme={theme} rows={2} /> : null}
      {profiles.error ? <Banner theme={theme} tone="danger" message={`Profile 读取失败：${profiles.error.message}`} /> : null}
      {profiles.data && !profiles.data.length ? <Banner theme={theme} tone="warning" message="主机上还没有 Profile；在 Paseo 设置里添加后再交给 Agent" /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {(profiles.data ?? []).map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={`Profile ${item.name}`} aria-checked={item.id === profileId} onPress={() => setProfileId(item.id)}
          style={state => [pill(item.id === profileId), { opacity: state.pressed ? 0.8 : 1 }]}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: item.id === profileId ? "700" : "500" }}>{item.name}</Text>
        </Pressable>)}
      </View>
      {profile ? <MetaLine theme={theme} parts={[profile.provider, profile.model, profile.thinkingOptionId, profile.modeId ? `模式 ${profile.modeId}` : null]} /> : null}
    </View>
    <TextField theme={theme} label="任务" value={text} onChangeText={setText} multiline minHeight={180} />
    {action?.projects.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>{action.projects.map(name => <Badge key={name} theme={theme} label={name} tone="violet" />)}</View> : null}
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
      <Button theme={theme} label="取消" onPress={onClose} />
      <Button theme={theme} variant="primary" icon="Rocket" label="开始" busy={busy} disabled={busy || !profile || !workspace || !text.trim()} onPress={() => void start()} />
    </View>
  </Sheet>;
}
