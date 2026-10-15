import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { INBOX_PROJECT_ID, type BoardItem } from "../shared/board";
import { launchOptionsRpc, launchRpc, launchStatusRpc, type LaunchInput, type LaunchOptions, type LaunchReceipt } from "../shared/launch";
import { Banner, Button, Divider, aria, MetaLine, ProjectMark, SearchField, Segmented, Skeleton, Spacer, fontSize, hairline, radius, space, toneColor, type Tone } from "./kit";
import { FieldLabel, FormField, PickerButton } from "./ui";
import { useForeground } from "./visibility";

type Form = { projectId: string; title: string; prompt: string; isolation: "local" | "worktree"; baseBranch: string; profileId: string | null; provider: string; model: string; modeId: string; thinkingOptionId: string };
type LaunchSession = { launchId: string; form: Form; input: LaunchInput | null; receipt: LaunchReceipt | null; error: string | null; initialized: boolean; autoOpened: boolean; options: LaunchOptions | null; optionsProjectId: string | null; catalogProjectId: string | null; sourceRevision: number; sourceTitle: string; sourceBody: string; emptyStatusCount: number };
const sessions = new Map<string, LaunchSession>();
let launchSequence = 0;
const stageRank: Record<LaunchReceipt["stage"] | "rejected", number> = { prepared: 0, creating_workspace: 1, workspace_ready: 2, creating_agent: 3, agent_ready: 4, sending: 5, rejected: 6, uncertain: 6, started: 7 };
const stageLabels = (): Record<LaunchReceipt["stage"] | "rejected", string> => ({ prepared: t("launchUi.prepared"), creating_workspace: t("launchUi.creatingWorkspace"), workspace_ready: t("launchUi.workspaceReady"), creating_agent: t("launchUi.creatingAgent"), agent_ready: t("launchUi.agentReady"), sending: t("launchUi.sending"), started: t("launchUi.started"), uncertain: t("launchUi.uncertain"), rejected: t("launchUi.rejected") });
/** Blue while it runs, green once started, amber when the outcome needs checking, red when rejected. */
const stageTones: Record<"running" | "started" | "uncertain" | "rejected", Tone> = { running: "info", started: "success", uncertain: "warning", rejected: "danger" };
const stageIcons = { started: "CircleCheck", uncertain: "TriangleAlert", rejected: "CircleX" } as const;
/** Worktree and project directory keep their colors wherever the choice shows. */
const isolationTones = { worktree: "teal", local: "indigo" } as const;
function newLaunchId() { return `launch-${Date.now().toString(36)}-${(++launchSequence).toString(36)}-${Math.random().toString(36).slice(2, 11)}`; }
function message(error: unknown) { return error instanceof Error ? error.message : t("launchUi.requestFailed"); }
/** Provider ids and errors come from Paseo; known status words are plugin display text. */
function providerStatus(status: string): string {
  switch (status) {
    case "ready": return t("launchUi.providerReady");
    case "loading": return t("launchUi.providerLoading");
    case "error": return t("launchUi.providerError");
    case "unavailable": return t("launchUi.providerUnavailable");
    case "disabled": return t("launchUi.providerDisabled");
    default: return status;
  }
}
const canResetOptions = (receipt: LaunchReceipt | null) => Boolean(receipt?.stage === "rejected" && !receipt.workspaceId && !receipt.agentId);

function sessionFor(hostId: string, item: BoardItem): LaunchSession {
  const key = `${hostId}:${item.projectId}:${item.id}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const session: LaunchSession = {
    launchId: newLaunchId(),
    form: { projectId: item.projectId === INBOX_PROJECT_ID ? "" : item.projectId, title: item.title, prompt: `${item.title}\n\n${item.body}`.trim(), isolation: "local", baseBranch: "", profileId: null, provider: "", model: "", modeId: "", thinkingOptionId: "" },
    input: null, receipt: null, error: null, initialized: false, autoOpened: false, options: null, optionsProjectId: null, catalogProjectId: null, sourceRevision: item.revision, sourceTitle: item.title, sourceBody: item.body, emptyStatusCount: 0,
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
    <PickerButton theme={theme} block leading={selected?.leading} label={selected?.label ?? (value || t("launchUi.choose"))} placeholder={!selected} expanded={expanded} disabled={disabled} accessibilityLabel={label} trailingIcon={expanded ? "ChevronUp" : "ChevronsUpDown"} onPress={() => setExpanded(!expanded)} />
    {hint ? <Hint theme={theme}>{hint}</Hint> : null}
    {expanded && !disabled ? <View style={{ borderWidth: hairline, borderColor: colors.border, borderRadius: radius.md, padding: space.xs, gap: space.xs }}>
      {options.length > 7 ? <SearchField theme={theme} value={search} onChangeText={setSearch} placeholder={t("launchUi.searchOptions")} accessibilityLabel={t("launchUi.searchLabel", { label })} /> : null}
      <View>{rows.slice(0, 60).map(option => <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ selected: option.id === value }} {...aria({ selected: option.id === value })} onPress={() => { onChange(option.id); setExpanded(false); setSearch(""); }}
        style={state => ({ minHeight: 40, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm, flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: option.id === value ? colors.surface2 : (state as Hover).hovered || (state as Hover).pressed ? colors.surface1 : "transparent" })}>
        {option.leading}
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body }}>{option.label}</Text>
          {option.detail ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{option.detail}</Text> : null}
        </View>
        {option.id === value ? <Icon name="Check" size={14} color={toneColor(theme, "accent")} /> : null}
      </Pressable>)}
      {rows.length === 0 ? <Hint theme={theme} padded>{t("launchUi.noOptions")}</Hint> : null}
      {rows.length > 60 ? <Hint theme={theme} padded>{t("launchUi.truncatedOptions")}</Hint> : null}</View>
    </View> : null}
  </View>;
}

function Hint({ theme, children, padded = false }: { theme: Theme; children: string; padded?: boolean }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17, ...(padded ? { padding: 10 } : {}) }}>{children}</Text>;
}

const stageHints = (): Partial<Record<LaunchReceipt["stage"], string>> => ({ uncertain: t("launchUi.uncertainHint"), rejected: t("launchUi.rejectedHint"), started: t("launchUi.startedHint") });

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
  const options = useQuery({ queryKey: ["project-notes", "launch-options", host.id, currentLanguage(), optionsProjectId], queryFn: () => optionsRpc(optionsProjectId ? { projectId: optionsProjectId } : {}), enabled: open && !submitted, retry: false, refetchOnWindowFocus: false, staleTime: 0 });
  const status = useQuery({ queryKey: statusKey, queryFn: async () => {
    const value = await getStatus({ launchId });
    // A previous receipt query may settle after an explicit new intent began.
    if (session.launchId !== launchId) return value;
    session.emptyStatusCount = value ? 0 : session.emptyStatusCount + 1;
    session.receipt = mergeReceipt(session.receipt, value);
    return session.receipt;
  }, enabled: submitted, retry: false, staleTime: 1000, refetchOnWindowFocus: false, refetchInterval: query => {
    const stage = query.state.data?.stage ?? session.receipt?.stage;
    if (!foreground || stage === "started" || stage === "uncertain" || stage === "rejected") return false;
    // No durable receipt can also mean a delayed request: retain its exact input and bound polling.
    return stage ? 2000 : session.emptyStatusCount >= 4 ? false : Math.min(2000 * 2 ** session.emptyStatusCount, 15000);
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
  const sourceChanged = session.sourceTitle !== item.title || session.sourceBody !== item.body;
  const loadSource = () => {
    if (session.input || submitting.current) return;
    session.sourceRevision = item.revision; session.sourceTitle = item.title; session.sourceBody = item.body;
    session.form = { ...session.form, title: item.title, prompt: `${item.title}\n\n${item.body}`.trim() };
    setForm(session.form);
  };
  useEffect(() => { if (status.data && status.data.launchId === session.launchId) { session.receipt = mergeReceipt(session.receipt, status.data); session.error = session.receipt?.error ?? null; setReceipt(session.receipt); setError(session.error); } }, [status.data, session]);
  const openResult = (current: LaunchReceipt, auto = false) => {
    try {
      // The launch ran on this dialog's host; say so explicitly (0.9 serverId) in case the selection moved.
      if (current.agentId && navigation?.openAgent) navigation.openAgent({ agentId: current.agentId, serverId: host.id });
      else if (current.workspaceId && navigation?.openWorkspace) navigation.openWorkspace({ workspaceId: current.workspaceId, serverId: host.id });
      else { setNotice(t("launchUi.navigationUnavailable")); return; }
      onOpenChange(false);
    } catch (failure) { setError(t("launchUi.openFailed", { error: message(failure) })); }
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
    if (submitting.current || (!session.input && !canLaunch)) return;
    const input: LaunchInput = session.input ?? { launchId, sourceProjectId: item.projectId, itemId: item.id, projectId: form.projectId, title: form.title.trim(), prompt: form.prompt.trim(), isolation: form.isolation, ...(form.isolation === "worktree" && form.baseBranch.trim() ? { baseBranch: form.baseBranch.trim() } : {}), profileId: form.profileId, provider: form.provider, model: form.model, modeId: form.modeId || null, thinkingOptionId: form.thinkingOptionId || null };
    // A retry replays the sealed input, even if the first response was lost after acceptance.
    session.input = input; session.emptyStatusCount = 0; session.error = null;
    submitting.current = true; setSubmitted(true); setLaunching(true); setError(null);
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
  const copy = async (value: string) => { try { await copyText(value); toast.show(t("launchUi.copied"), { variant: "success" }); } catch (failure) { setError(t("launchUi.copyFailed", { error: message(failure) })); } };
  const phase = receipt?.stage;
  const retryable = submitted && !launching && !submitting.current && (!receipt || Boolean(error)) && phase !== "started" && phase !== "uncertain" && phase !== "rejected";
  const missingReceipt = submitted && !receipt && !launching && status.isSuccess;
  const terminal = phase === "started" || phase === "uncertain" || phase === "rejected";
  const canChangeOptions = canResetOptions(receipt);
  // A receipt's error shows inside the tinted status panel; the banner is for local failures (copy, open, network).
  const receiptError = receipt?.error ?? null, localError = error && error !== receiptError ? error : null;
  const stageTone = missingReceipt ? "warning" : stageTones[phase === "started" || phase === "uncertain" || phase === "rejected" ? phase : "running"];
  // Stages fill the bar step by step; any outcome fills it in the outcome's color.
  const progress = terminal ? 1 : phase ? (stageRank[phase] + 1) / (stageRank.started + 1) : 0.06;
  const resetIntent = () => {
    const current = session.receipt;
    if (launching || submitting.current || !current || (current.stage !== "started" && !canResetOptions(current))) return;
    session.launchId = newLaunchId(); session.input = null; session.receipt = null; session.error = null; session.autoOpened = false; session.emptyStatusCount = 0;
    setLaunchId(session.launchId); setReceipt(null); setSubmitted(false); setLaunching(false); setError(null); setNotice(t("launchUi.canEditOptions"));
  };

  const worktree = form.isolation === "worktree";
  const openable = Boolean((receipt?.agentId && navigation?.openAgent) || (receipt?.workspaceId && navigation?.openWorkspace));
  const identifiers = [receipt?.workspaceId ? t("launchUi.workspaceId", { id: receipt.workspaceId }) : "", receipt?.agentId ? t("launchUi.agentId", { id: receipt.agentId }) : "", t("launchUi.launchId", { id: session.launchId })].filter(Boolean);
  // Defaults are usually right, so the agent choices fold into one line unless something needs attention.
  const agentNeedsAttention = Boolean(available) && (!selectedProvider || !selectedModel || !modeAvailable || !thinkingAvailable || ["error", "unavailable", "disabled"].includes(selectedProvider.status));
  const agentOpen = agentExpanded || (agentNeedsAttention && !submitted);
  const agentSummary = [form.profileId ? available?.profiles.find(profile => profile.id === form.profileId)?.name : null, selectedProvider?.label, selectedModel?.label,
    selectedProvider?.modes.find(mode => mode.id === form.modeId)?.label, selectedModel?.thinkingOptions.find(option => option.id === form.thinkingOptionId)?.label].filter(Boolean).join(t("launchUi.summarySeparator"));
  // Two selects side by side when the dialog is wide enough; each wraps to its own line on phones.
  const pair = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md };
  const half = { flexGrow: 1, flexBasis: 200, minWidth: 0 };
  return <Modal title={t("launchUi.title")} open={open} onOpenChange={onOpenChange}>
    <Modal.Content contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
      <Hint theme={theme}>{t("launchUi.description", { host: host.label })}</Hint>
      {options.isPending && !submitted ? <Skeleton theme={theme} rows={3} /> : null}
      {options.isError && !submitted ? <Banner theme={theme} tone="danger" message={message(options.error)} action={{ label: t("launchUi.reload"), onPress: () => void options.refetch() }} /> : null}
      {submitted ? <View style={{ gap: space.xs }}>
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{form.title}</Text>
        <MetaLine theme={theme} numberOfLines={2} parts={[selectedProject?.name ?? form.projectId, worktree ? t("launchUi.worktree") : t("launchUi.local"), agentSummary]} />
      </View> : null}
      {sourceChanged && !submitted ? <Banner theme={theme} tone="warning" message={t("launchUi.sourceChanged")} action={{ label: t("launchUi.loadLatest"), onPress: loadSource }} /> : null}
      {options.data && !submitted ? <>
        <Select theme={theme} label={t("launchUi.targetProject")} value={form.projectId} options={projects.map(project => ({ id: project.id, label: project.name, detail: project.path, leading: <ProjectMark theme={theme} name={project.name} /> }))} onChange={projectId => { const project = projects.find(value => value.id === projectId); update({ projectId, isolation: project?.kind === "git" ? "worktree" : "local", baseBranch: "" }); }} hint={!form.projectId ? t("launchUi.inboxHint") : undefined} />
        <FormField theme={theme} label={t("launchUi.workspaceTitle")} value={form.title} onChangeText={title => update({ title })} maxLength={160} />
        <FormField theme={theme} label={t("launchUi.initialTask")} value={form.prompt} onChangeText={prompt => update({ prompt })} maxLength={32500} multiline minHeight={layout.compact ? 140 : 180} maxHeight={300} />
        <View style={{ gap: space.xs + 2 }}>
          <FieldLabel theme={theme}>{t("launchUi.workspace")}</FieldLabel>
          {selectedProject && selectedProject.kind !== "git" ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 28 }}>
            <Icon name="Folder" size={14} color={toneColor(theme, isolationTones.local, "mark")} />
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body }}>{t("launchUi.local")}<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("launchUi.nonGit")}</Text></Text>
          </View>
            : <Segmented theme={theme} value={form.isolation} accessibilityLabel={t("launchUi.workspace")} onChange={isolation => update({ isolation })}
              options={[{ value: "worktree", label: t("launchUi.worktree"), icon: "GitBranch", tone: isolationTones.worktree }, { value: "local", label: t("launchUi.local"), icon: "Folder", tone: isolationTones.local }]} />}
          <Hint theme={theme}>{worktree ? t("launchUi.worktreeHint") : t("launchUi.localHint")}</Hint>
        </View>
        {worktree ? <FormField theme={theme} label={t("launchUi.baseBranch")} value={form.baseBranch} onChangeText={baseBranch => update({ baseBranch })} maxLength={200} placeholder={t("launchUi.basePlaceholder")} /> : null}
        <Divider theme={theme} />
        <Pressable accessibilityRole="button" accessibilityLabel={t("launchUi.agentSettings")} accessibilityState={{ expanded: agentOpen }} {...aria({ expanded: agentOpen })} onPress={() => setAgentExpanded(!agentOpen)} hitSlop={{ top: 6, bottom: 6 }}
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <FieldLabel theme={theme}>{t("launchUi.agent")}</FieldLabel>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body }}>{agentSummary || t("launchUi.choose")}</Text>
          </View>
          <Icon name={agentOpen ? "ChevronUp" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
        {agentOpen ? <>
          <Select theme={theme} label={t("launchUi.profile")} value={form.profileId ?? ""} options={[{ id: "", label: t("launchUi.custom") }, ...(available?.profiles ?? []).map(profile => ({ id: profile.id, label: profile.name, detail: t("launchUi.profileSummary", { provider: profile.provider, model: profile.model ? t("launchUi.modelSuffix", { model: profile.model }) : "" }) }))]} onChange={selectProfile} hint={form.profileId ? t("launchUi.profileHint") : undefined} />
          <View style={pair}>
            <View style={half}><Select theme={theme} label={t("launchUi.provider")} value={form.provider} options={(available?.providers ?? []).map(provider => ({ id: provider.id, label: provider.label, detail: provider.error ?? providerStatus(provider.status) }))} onChange={id => update(providerDefaults(available?.providers.find(provider => provider.id === id)), true)} /></View>
            <View style={half}><Select theme={theme} label={t("launchUi.model")} value={form.model} options={(selectedProvider?.models ?? []).map(model => ({ id: model.id, label: model.label }))} onChange={id => { const model = selectedProvider?.models.find(value => value.id === id); update({ model: id, thinkingOptionId: model?.defaultThinkingOptionId ?? "" }, true); }} /></View>
          </View>
          <View style={pair}>
            <View style={half}><Select theme={theme} label={t("launchUi.permissionMode")} value={form.modeId} options={[{ id: "", label: form.profileId ? t("launchUi.profileDefault") : t("launchUi.providerDefault") }, ...(selectedProvider?.modes ?? [])]} onChange={modeId => update({ modeId }, true)} /></View>
            {(selectedModel?.thinkingOptions.length ?? 0) > 0 || form.thinkingOptionId ? <View style={half}><Select theme={theme} label={t("launchUi.thinking")} value={form.thinkingOptionId} options={[{ id: "", label: form.profileId ? t("launchUi.profileDefault") : t("launchUi.modelDefault") }, ...(selectedModel?.thinkingOptions ?? [])]} onChange={thinkingOptionId => update({ thinkingOptionId }, true)} /></View> : null}
          </View>
        </> : null}
        {selectedProvider?.error && !submitted ? <Banner theme={theme} tone="danger" message={selectedProvider.error} /> : null}
      </> : null}
      {submitted ? <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.md, borderWidth: hairline, borderColor: toneColor(theme, stageTone, "line"), backgroundColor: toneColor(theme, stageTone, "soft") }}>
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            {phase === "started" || phase === "uncertain" || phase === "rejected" ? <Icon name={stageIcons[phase]} size={16} color={toneColor(theme, stageTone, "mark")} /> : <ActivityIndicator size="small" color={toneColor(theme, stageTone, "mark")} />}
            <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{receipt ? stageLabels()[receipt.stage] : missingReceipt ? t("launchUi.missingReceipt") : t("launchUi.waitingReceipt")}</Text>
          </View>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: toneColor(theme, stageTone, "soft") }}>
            <View style={{ width: `${Math.round(progress * 100)}%`, height: 4, borderRadius: 2, backgroundColor: toneColor(theme, stageTone, "mark") }} />
          </View>
        </View>
        {/* The server's message already says what to do next, so it replaces the stage hint. */}
        {receiptError ? <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 19 }}>{receiptError}</Text>
          : <Hint theme={theme}>{missingReceipt ? t("launchUi.missingReceiptHint") : (phase && stageHints()[phase]) ?? t("launchUi.checkingStatus")}</Hint>}
        {phase === "uncertain" && !receipt?.workspaceId && !receipt?.agentId ? <Hint theme={theme}>{t("launchUi.missingIds")}</Hint> : null}
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{identifiers.join("\n")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {openable ? <Button theme={theme} label={receipt?.agentId && navigation?.openAgent ? t("launchUi.openSession") : t("launchUi.openWorkspace")} icon="ArrowUpRight" size="sm" variant={terminal ? "primary" : "secondary"} onPress={() => receipt && openResult(receipt)} /> : null}
          {retryable ? <Button theme={theme} label={t("launchUi.retryRequest")} icon="RefreshCw" size="sm" variant="primary" onPress={() => void submit()} /> : null}
          <Button theme={theme} label={status.isFetching ? t("launchUi.querying") : t("launchUi.queryStatus")} icon="RefreshCw" size="sm" disabled={status.isFetching} onPress={() => void status.refetch()} />
          <Button theme={theme} label={t("launchUi.copyIds")} icon="Copy" size="sm" variant="ghost" onPress={() => void copy(identifiers.map(line => line.replace(" ", ": ")).join("\n"))} />
          {canChangeOptions ? <Button theme={theme} label={t("launchUi.editAndRetry")} icon="Pencil" size="sm" disabled={launching} onPress={resetIntent} />
            : phase === "started" ? <Button theme={theme} label={t("launchUi.newTask")} icon="Plus" size="sm" disabled={launching} onPress={resetIntent} /> : null}
        </View>
        <Hint theme={theme}>{t("launchUi.reloadWarning")}</Hint>
      </View> : null}
      {localError ? <Banner theme={theme} tone="danger" message={localError} /> : null}
      {status.isError ? <Banner theme={theme} tone="danger" message={t("launchUi.statusFailed", { error: message(status.error) })} /> : null}
      {notice ? <Hint theme={theme}>{notice}</Hint> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Button theme={theme} label={t("launchUi.copyTask")} icon="Copy" variant="ghost" size="sm" onPress={() => void copy(form.prompt)} />
        <Spacer />
        <Button theme={theme} label={submitted ? t("launchUi.close") : t("launchUi.cancel")} onPress={() => onOpenChange(false)} />
        {!submitted ? <Button theme={theme} label={t("launchUi.createAndStart")} icon="Play" variant="primary" busy={launching} disabled={!canLaunch || launching || options.isPending} onPress={() => void submit()} /> : null}
      </View>
    </Modal.Content>
  </Modal>;
}
