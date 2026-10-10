import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { INBOX_PROJECT_ID, type BoardItem } from "../shared/board";
import { launchOptionsRpc, launchRpc, launchStatusRpc, type LaunchInput, type LaunchOptions, type LaunchReceipt } from "../shared/launch";
import { Banner, Button, Divider, MetaLine, ProjectMark, SearchField, Segmented, Skeleton, Spacer, fontSize, hairline, radius, space, toneColor, type Tone } from "./kit";
import { FieldLabel, FormField, PickerButton } from "./ui";
import { useForeground } from "./visibility";

type Form = { projectId: string; title: string; prompt: string; isolation: "local" | "worktree"; baseBranch: string; profileId: string | null; provider: string; model: string; modeId: string; thinkingOptionId: string };
type LaunchSession = { launchId: string; form: Form; input: LaunchInput | null; receipt: LaunchReceipt | null; error: string | null; initialized: boolean; autoOpened: boolean; options: LaunchOptions | null; optionsProjectId: string | null; catalogProjectId: string | null; sourceRevision: number };
const sessions = new Map<string, LaunchSession>();
let launchSequence = 0;
const stageRank: Record<LaunchReceipt["stage"] | "rejected", number> = { prepared: 0, creating_workspace: 1, workspace_ready: 2, creating_agent: 3, agent_ready: 4, sending: 5, rejected: 6, uncertain: 6, started: 7 };
const stageLabels: Record<LaunchReceipt["stage"] | "rejected", string> = { prepared: "启动请求已确认", creating_workspace: "正在创建工作区", workspace_ready: "工作区已就绪", creating_agent: "正在创建代理", agent_ready: "代理已就绪", sending: "正在发送任务", started: "任务已开始", uncertain: "启动结果需要核对", rejected: "选项检查未通过" };
/** Blue while it runs, green once started, amber when the outcome needs checking, red when rejected. */
const stageTones: Record<"running" | "started" | "uncertain" | "rejected", Tone> = { running: "info", started: "success", uncertain: "warning", rejected: "danger" };
const stageIcons = { started: "CircleCheck", uncertain: "TriangleAlert", rejected: "CircleX" } as const;
/** Worktree and project directory keep their colors wherever the choice shows. */
const isolationTones = { worktree: "teal", local: "indigo" } as const;
function newLaunchId() { return `launch-${Date.now().toString(36)}-${(++launchSequence).toString(36)}-${Math.random().toString(36).slice(2, 11)}`; }
function message(error: unknown) { return error instanceof Error ? error.message : "请求未完成，请查询启动状态。"; }

function sessionFor(hostId: string, item: BoardItem): LaunchSession {
  const key = `${hostId}:${item.projectId}:${item.id}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const session: LaunchSession = {
    launchId: newLaunchId(),
    form: { projectId: item.projectId === INBOX_PROJECT_ID ? "" : item.projectId, title: item.title, prompt: `${item.title}\n\n${item.body}`.trim(), isolation: "local", baseBranch: "", profileId: null, provider: "", model: "", modeId: "", thinkingOptionId: "" },
    input: null, receipt: null, error: null, initialized: false, autoOpened: false, options: null, optionsProjectId: null, catalogProjectId: null, sourceRevision: item.revision,
  };
  sessions.set(key, session);
  return session;
}

function mergeReceipt(previous: LaunchReceipt | null, incoming: LaunchReceipt | null) {
  if (!incoming) return previous;
  if (previous && stageRank[previous.stage] > stageRank[incoming.stage]) return previous;
  return incoming;
}

function providerDefaults(provider: LaunchOptions["providers"][number] | undefined) {
  const model = provider?.models.find(value => value.isDefault) ?? provider?.models[0];
  return { provider: provider?.id ?? "", model: model?.id ?? "", modeId: provider?.defaultModeId ?? "", thinkingOptionId: model?.defaultThinkingOptionId ?? "" };
}

type Theme = PluginSurfaceProps["theme"];
type Hover = { pressed: boolean; hovered?: boolean };

/** Labelled picker that expands inline (no nested modal): searchable past seven options. */
function Select({ theme, label, value, options, onChange, disabled, hint }: {
  theme: Theme; label: string; value: string;
  options: { id: string; label: string; detail?: string; leading?: ReactNode }[]; onChange: (id: string) => void; disabled?: boolean; hint?: string;
}) {
  const { colors } = theme;
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const selected = options.find(option => option.id === value);
  const rows = options.filter(option => `${option.label} ${option.id} ${option.detail ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  return <View style={{ gap: space.xs + 2 }}>
    <FieldLabel theme={theme}>{label}</FieldLabel>
    <PickerButton theme={theme} block leading={selected?.leading} label={selected?.label ?? (value || "请选择")} placeholder={!selected} expanded={expanded} disabled={disabled} accessibilityLabel={label} trailingIcon={expanded ? "ChevronUp" : "ChevronsUpDown"} onPress={() => setExpanded(!expanded)} />
    {hint ? <Hint theme={theme}>{hint}</Hint> : null}
    {expanded && !disabled ? <View style={{ borderWidth: hairline, borderColor: colors.border, borderRadius: radius.md, padding: space.xs, gap: space.xs }}>
      {options.length > 7 ? <SearchField theme={theme} value={search} onChangeText={setSearch} placeholder="搜索选项" accessibilityLabel={`搜索${label}`} /> : null}
      <View>{rows.slice(0, 60).map(option => <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ selected: option.id === value }} onPress={() => { onChange(option.id); setExpanded(false); setSearch(""); }}
        style={state => ({ minHeight: 40, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm, flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: option.id === value ? colors.surface2 : (state as Hover).hovered || (state as Hover).pressed ? colors.surface1 : "transparent" })}>
        {option.leading}
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body }}>{option.label}</Text>
          {option.detail ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{option.detail}</Text> : null}
        </View>
        {option.id === value ? <Icon name="Check" size={14} color={toneColor(theme, "accent")} /> : null}
      </Pressable>)}
      {rows.length === 0 ? <Hint theme={theme} padded>没有可选项</Hint> : null}
      {rows.length > 60 ? <Hint theme={theme} padded>只显示前 60 项，输入关键词缩小范围。</Hint> : null}</View>
    </View> : null}
  </View>;
}

function Hint({ theme, children, padded = false }: { theme: Theme; children: string; padded?: boolean }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17, ...(padded ? { padding: 10 } : {}) }}>{children}</Text>;
}

const stageHints: Partial<Record<LaunchReceipt["stage"], string>> = { uncertain: "可能已经创建了工作区或会话，请先打开核对；这里不会再次发送。", rejected: "服务器确认没有创建工作区或会话，可以修改选项后重试。", started: "任务已发送给新会话。" };

export function LaunchDialog({ item, open, onOpenChange, theme, host, layout, navigation }: PluginSurfaceProps & { item: BoardItem; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [session] = useState(() => sessionFor(host.id, item));
  const [launchId, setLaunchId] = useState(session.launchId);
  const [form, setForm] = useState<Form>(() => session.form);
  const [receipt, setReceipt] = useState<LaunchReceipt | null>(() => session.receipt);
  const [submitted, setSubmitted] = useState(Boolean(session.input));
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(session.error);
  const [notice, setNotice] = useState<string | null>(null);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const optionsRpc = useRpc(launchOptionsRpc);
  const launch = useRpc(launchRpc);
  const getStatus = useRpc(launchStatusRpc);
  const queryClient = useQueryClient();
  const foreground = useForeground();
  const toast = useToast();
  const statusKey = useMemo(() => ["project-notes", "launch-status", host.id, launchId], [host.id, launchId]);
  const optionsProjectId = form.projectId;
  const options = useQuery({ queryKey: ["project-notes", "launch-options", host.id, optionsProjectId], queryFn: () => optionsRpc(optionsProjectId ? { projectId: optionsProjectId } : {}), enabled: open && !submitted, retry: false, refetchOnWindowFocus: false, staleTime: 0 });
  const status = useQuery({ queryKey: statusKey, queryFn: async () => {
    const value = await getStatus({ launchId });
    // A previous receipt query may settle after an explicit new intent began.
    if (session.launchId !== launchId) return value;
    session.receipt = mergeReceipt(session.receipt, value);
    return session.receipt;
  }, enabled: submitted, retry: false, refetchInterval: query => {
    const stage = query.state.data?.stage ?? session.receipt?.stage;
    return !foreground || stage === "started" || stage === "uncertain" || stage === "rejected" ? false : 2000;
  }, refetchIntervalInBackground: false });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!options.data || session.input) return;
    session.options = options.data; session.optionsProjectId = optionsProjectId;
    if (session.initialized && session.catalogProjectId === optionsProjectId) return;
    const project = options.data.projects.find(value => value.id === optionsProjectId && value.id !== INBOX_PROJECT_ID && value.path.trim());
    const provider = project ? options.data.providers.find(value => value.status === "ready" && value.models.length > 0) ?? options.data.providers.find(value => value.models.length > 0) : undefined;
    const initial = { ...session.form, ...providerDefaults(provider), profileId: null, projectId: project?.id ?? "", isolation: project?.kind === "git" ? "worktree" as const : "local" as const };
    session.form = initial; session.initialized = true; session.catalogProjectId = optionsProjectId; setForm(initial);
  }, [options.data, optionsProjectId, session]);
  useEffect(() => {
    if (open && !session.input && session.sourceRevision !== item.revision) {
      session.sourceRevision = item.revision;
      session.form = { ...session.form, title: item.title, prompt: `${item.title}\n\n${item.body}`.trim() };
      setForm(session.form);
    }
  }, [open, item.revision, item.title, item.body, session]);
  useEffect(() => { if (status.data && status.data.launchId === session.launchId) { session.receipt = mergeReceipt(session.receipt, status.data); session.error = session.receipt?.error ?? null; setReceipt(session.receipt); setError(session.error); } }, [status.data, session]);
  const openResult = (current: LaunchReceipt, auto = false) => {
    try {
      // The launch ran on this dialog's host; say so explicitly (0.9 serverId) in case the selection moved.
      if (current.agentId && navigation?.openAgent) navigation.openAgent({ agentId: current.agentId, serverId: host.id });
      else if (current.workspaceId && navigation?.openWorkspace) navigation.openWorkspace({ workspaceId: current.workspaceId, serverId: host.id });
      else { setNotice("当前客户端不支持直接跳转，可复制下面的标识后在 Paseo 中打开。"); return; }
      onOpenChange(false);
    } catch (failure) { setError(`打开结果失败：${message(failure)}`); }
  };
  useEffect(() => {
    if (!open || !mounted.current || receipt?.stage !== "started" || session.autoOpened) return;
    session.autoOpened = true;
    openResult(receipt, true);
  }, [receipt, open, navigation, session]);
  const update = (patch: Partial<Form>, clearProfile = false) => {
    if (session.input || submitting.current) return;
    setError(null);
    setForm(previous => { const next = { ...previous, ...patch, ...(clearProfile ? { profileId: null } : {}) }; session.form = next; return next; });
  };
  const available = options.data ?? (session.optionsProjectId === optionsProjectId ? session.options : null);
  const projects = available?.projects.filter(project => project.id !== INBOX_PROJECT_ID && project.path.trim()) ?? [];
  const selectedProject = projects.find(project => project.id === form.projectId);
  const selectedProvider = available?.providers.find(provider => provider.id === form.provider);
  const selectedModel = selectedProvider?.models.find(model => model.id === form.model);
  const modeAvailable = !form.modeId || selectedProvider?.modes.some(mode => mode.id === form.modeId);
  const thinkingAvailable = !form.thinkingOptionId || selectedModel?.thinkingOptions.some(option => option.id === form.thinkingOptionId);
  const canLaunch = Boolean(session.catalogProjectId === optionsProjectId && !options.isFetching && selectedProject && selectedProvider && selectedModel && modeAvailable && thinkingAvailable && form.title.trim() && form.prompt.trim() && !["error", "unavailable", "disabled"].includes(selectedProvider.status));
  const selectProfile = (id: string) => {
    if (!id) { update({ profileId: null }); return; }
    const profile = options.data?.profiles.find(value => value.id === id);
    if (!profile) return;
    const provider = options.data?.providers.find(value => value.id === profile.provider);
    const defaults = providerDefaults(provider);
    update({ provider: profile.provider, model: profile.model ?? defaults.model, modeId: profile.modeId ?? "", thinkingOptionId: profile.thinkingOptionId ?? "", profileId: profile.id });
  };
  const submit = async () => {
    if (submitting.current || session.input || !canLaunch) return;
    const input: LaunchInput = { launchId, sourceProjectId: item.projectId, itemId: item.id, projectId: form.projectId, title: form.title.trim(), prompt: form.prompt.trim(), isolation: form.isolation, ...(form.isolation === "worktree" && form.baseBranch.trim() ? { baseBranch: form.baseBranch.trim() } : {}), profileId: form.profileId, provider: form.provider, model: form.model, modeId: form.modeId || null, thinkingOptionId: form.thinkingOptionId || null };
    // Seal this intent before dispatch; reopening never generates a duplicate request.
    session.input = input; submitting.current = true; setSubmitted(true); setLaunching(true); setError(null);
    try {
      const result = await launch(input);
      session.receipt = mergeReceipt(session.receipt, result); session.error = result.error;
      queryClient.setQueryData(statusKey, session.receipt);
      if (mounted.current) { setReceipt(session.receipt); setError(result.error); }
    } catch (failure) {
      session.error = message(failure);
      if (mounted.current) setError(session.error);
    } finally { submitting.current = false; if (mounted.current) { setLaunching(false); void status.refetch(); } }
  };
  const copy = async (value: string) => { try { await copyText(value); toast.show("已复制", { variant: "success" }); } catch (failure) { setError(`复制失败：${message(failure)}`); } };
  const phase = receipt?.stage;
  const terminal = phase === "started" || phase === "uncertain" || phase === "rejected";
  // A receipt's error shows inside the tinted status panel; the banner is for local failures (copy, open, network).
  const receiptError = receipt?.error ?? null, localError = error && error !== receiptError ? error : null;
  const stageTone = stageTones[phase === "started" || phase === "uncertain" || phase === "rejected" ? phase : "running"];
  // Stages fill the bar step by step; any outcome fills it in the outcome's color.
  const progress = terminal ? 1 : phase ? (stageRank[phase] + 1) / (stageRank.started + 1) : 0.06;
  const resetIntent = () => {
    const current = session.receipt;
    if (launching || submitting.current || !current || (current.stage !== "started" && current.stage !== "rejected")) return;
    if (current.stage === "rejected" && (current.workspaceId || current.agentId)) return;
    session.launchId = newLaunchId(); session.input = null; session.receipt = null; session.error = null; session.autoOpened = false;
    setLaunchId(session.launchId); setReceipt(null); setSubmitted(false); setLaunching(false); setError(null); setNotice("选项可以修改。确认后再点击「创建工作区并开始」。");
  };

  const worktree = form.isolation === "worktree";
  const openable = Boolean((receipt?.agentId && navigation?.openAgent) || (receipt?.workspaceId && navigation?.openWorkspace));
  const identifiers = [receipt?.workspaceId ? `Workspace ${receipt.workspaceId}` : "", receipt?.agentId ? `Agent ${receipt.agentId}` : "", `Launch ${session.launchId}`].filter(Boolean);
  // Defaults are usually right, so the agent choices fold into one line unless something needs attention.
  const agentNeedsAttention = Boolean(available) && (!selectedProvider || !selectedModel || !modeAvailable || !thinkingAvailable || ["error", "unavailable", "disabled"].includes(selectedProvider.status));
  const agentOpen = agentExpanded || (agentNeedsAttention && !submitted);
  const agentSummary = [form.profileId ? available?.profiles.find(profile => profile.id === form.profileId)?.name : null, selectedProvider?.label, selectedModel?.label,
    selectedProvider?.modes.find(mode => mode.id === form.modeId)?.label, selectedModel?.thinkingOptions.find(option => option.id === form.thinkingOptionId)?.label].filter(Boolean).join(" · ");
  // Two selects side by side when the dialog is wide enough; each wraps to its own line on phones.
  const pair = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md };
  const half = { flexGrow: 1, flexBasis: 200, minWidth: 0 };
  return <Modal title="开始处理" open={open} onOpenChange={onOpenChange}>
    <Modal.Content contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
      <Hint theme={theme}>{`确认后在 ${host.label} 新建工作区并发送任务，原手记不变。`}</Hint>
      {options.isPending && !submitted ? <Skeleton theme={theme} rows={3} /> : null}
      {options.isError && !submitted ? <Banner theme={theme} tone="danger" message={message(options.error)} action={{ label: "重新读取", onPress: () => void options.refetch() }} /> : null}
      {submitted ? <View style={{ gap: space.xs }}>
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{form.title}</Text>
        <MetaLine theme={theme} numberOfLines={2} parts={[selectedProject?.name ?? form.projectId, worktree ? "独立 Worktree" : "项目目录", agentSummary]} />
      </View> : null}
      {options.data && !submitted ? <>
        <Select theme={theme} label="目标项目" value={form.projectId} options={projects.map(project => ({ id: project.id, label: project.name, detail: project.path, leading: <ProjectMark theme={theme} name={project.name} /> }))} onChange={projectId => { const project = projects.find(value => value.id === projectId); update({ projectId, isolation: project?.kind === "git" ? "worktree" : "local", baseBranch: "" }); }} hint={!form.projectId ? "随手记没有代码目录，请选择要开始工作的项目。" : undefined} />
        <FormField theme={theme} label="工作区标题" value={form.title} onChangeText={title => update({ title })} maxLength={160} />
        <FormField theme={theme} label="初始任务" value={form.prompt} onChangeText={prompt => update({ prompt })} maxLength={32500} multiline minHeight={layout.compact ? 140 : 180} maxHeight={300} />
        <View style={{ gap: space.xs + 2 }}>
          <FieldLabel theme={theme}>工作区</FieldLabel>
          {selectedProject && selectedProject.kind !== "git" ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 28 }}>
            <Icon name="Folder" size={14} color={toneColor(theme, isolationTones.local, "mark")} />
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body }}>项目目录<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{"  "}非 Git 项目，不能用 Worktree</Text></Text>
          </View>
            : <Segmented theme={theme} value={form.isolation} accessibilityLabel="工作区" onChange={isolation => update({ isolation })}
              options={[{ value: "worktree", label: "独立 Worktree", icon: "GitBranch", tone: isolationTones.worktree }, { value: "local", label: "项目目录", icon: "Folder", tone: isolationTones.local }]} />}
          <Hint theme={theme}>{worktree ? "新建分支目录，可与其他任务并行。" : "直接使用项目现有文件，可能与其他任务共享修改。"}</Hint>
        </View>
        {worktree ? <FormField theme={theme} label="基础分支（可选）" value={form.baseBranch} onChangeText={baseBranch => update({ baseBranch })} maxLength={200} placeholder="留空使用项目当前 HEAD" /> : null}
        <Divider theme={theme} />
        <Pressable accessibilityRole="button" accessibilityLabel="Agent 设置" accessibilityState={{ expanded: agentOpen }} onPress={() => setAgentExpanded(!agentOpen)} hitSlop={{ top: 6, bottom: 6 }}
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <FieldLabel theme={theme}>Agent</FieldLabel>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body }}>{agentSummary || "请选择"}</Text>
          </View>
          <Icon name={agentOpen ? "ChevronUp" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
        {agentOpen ? <>
          <Select theme={theme} label="Profile" value={form.profileId ?? ""} options={[{ id: "", label: "自定义" }, ...(available?.profiles ?? []).map(profile => ({ id: profile.id, label: profile.name, detail: `${profile.provider}${profile.model ? ` · ${profile.model}` : ""}` }))]} onChange={selectProfile} hint={form.profileId ? "沿用此配置；改动下面的参数会切回自定义。" : undefined} />
          <View style={pair}>
            <View style={half}><Select theme={theme} label="Provider" value={form.provider} options={(available?.providers ?? []).map(provider => ({ id: provider.id, label: provider.label, detail: provider.error ?? provider.status }))} onChange={id => update(providerDefaults(available?.providers.find(provider => provider.id === id)), true)} /></View>
            <View style={half}><Select theme={theme} label="模型" value={form.model} options={(selectedProvider?.models ?? []).map(model => ({ id: model.id, label: model.label }))} onChange={id => { const model = selectedProvider?.models.find(value => value.id === id); update({ model: id, thinkingOptionId: model?.defaultThinkingOptionId ?? "" }, true); }} /></View>
          </View>
          <View style={pair}>
            <View style={half}><Select theme={theme} label="权限模式" value={form.modeId} options={[{ id: "", label: form.profileId ? "配置未指定，沿用默认" : "Provider 默认" }, ...(selectedProvider?.modes ?? [])]} onChange={modeId => update({ modeId }, true)} /></View>
            {(selectedModel?.thinkingOptions.length ?? 0) > 0 || form.thinkingOptionId ? <View style={half}><Select theme={theme} label="思考档位" value={form.thinkingOptionId} options={[{ id: "", label: form.profileId ? "配置未指定，沿用默认" : "模型默认" }, ...(selectedModel?.thinkingOptions ?? [])]} onChange={thinkingOptionId => update({ thinkingOptionId }, true)} /></View> : null}
          </View>
        </> : null}
        {selectedProvider?.error && !submitted ? <Banner theme={theme} tone="danger" message={selectedProvider.error} /> : null}
      </> : null}
      {submitted ? <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.md, borderWidth: hairline, borderColor: toneColor(theme, stageTone, "line"), backgroundColor: toneColor(theme, stageTone, "soft") }}>
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            {phase === "started" || phase === "uncertain" || phase === "rejected" ? <Icon name={stageIcons[phase]} size={16} color={toneColor(theme, stageTone, "mark")} /> : <ActivityIndicator size="small" color={toneColor(theme, stageTone, "mark")} />}
            <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{receipt ? stageLabels[receipt.stage] : "等待启动结果确认"}</Text>
          </View>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: toneColor(theme, stageTone, "soft") }}>
            <View style={{ width: `${Math.round(progress * 100)}%`, height: 4, borderRadius: 2, backgroundColor: toneColor(theme, stageTone, "mark") }} />
          </View>
        </View>
        {/* The server's message already says what to do next, so it replaces the stage hint. */}
        {receiptError ? <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 19 }}>{receiptError}</Text>
          : <Hint theme={theme}>{(phase && stageHints[phase]) ?? "只查询这次启动的状态，不会重新提交；关闭后从同一条手记可继续查看。"}</Hint>}
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{identifiers.join("\n")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {openable ? <Button theme={theme} label={receipt?.agentId && navigation?.openAgent ? "打开会话" : "打开工作区"} icon="ArrowUpRight" size="sm" variant={terminal ? "primary" : "secondary"} onPress={() => receipt && openResult(receipt)} /> : null}
          <Button theme={theme} label={status.isFetching ? "查询中…" : "查询状态"} icon="RefreshCw" size="sm" disabled={status.isFetching} onPress={() => void status.refetch()} />
          <Button theme={theme} label="复制标识" icon="Copy" size="sm" variant="ghost" onPress={() => void copy(identifiers.map(line => line.replace(" ", ": ")).join("\n"))} />
          {phase === "rejected" && !receipt?.workspaceId && !receipt?.agentId ? <Button theme={theme} label="修改选项重试" icon="Pencil" size="sm" disabled={launching} onPress={resetIntent} />
            : phase === "started" ? <Button theme={theme} label="再开一个新任务" icon="Plus" size="sm" disabled={launching} onPress={resetIntent} /> : null}
        </View>
        <Hint theme={theme}>重载插件会清空这里的状态，重载前请先复制标识。</Hint>
      </View> : null}
      {localError ? <Banner theme={theme} tone="danger" message={localError} /> : null}
      {status.isError ? <Banner theme={theme} tone="danger" message={`状态查询失败：${message(status.error)}。启动请求不会自动重发。`} /> : null}
      {notice ? <Hint theme={theme}>{notice}</Hint> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Button theme={theme} label="复制任务" icon="Copy" variant="ghost" size="sm" onPress={() => void copy(form.prompt)} />
        <Spacer />
        <Button theme={theme} label={submitted ? "关闭" : "取消"} onPress={() => onOpenChange(false)} />
        {!submitted ? <Button theme={theme} label="创建工作区并开始" icon="Play" variant="primary" busy={launching} disabled={!canLaunch || launching || options.isPending} onPress={() => void submit()} /> : null}
      </View>
    </Modal.Content>
  </Modal>;
}
