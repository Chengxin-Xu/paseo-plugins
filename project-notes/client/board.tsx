import { useRpc, useWorkspace, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { BOARD_FILE_LIMIT_BYTES, INBOX_PROJECT_ID, OVERVIEW_LIMIT_BYTES, readDashboardRpc, writeBoardRpc, type BoardItem, type BoardProject, type BoardSnapshot, type NoteKind, type TaskStatus, type UnavailableBoard, type WriteBoardInput } from "../shared/board";
import { NoteDetail } from "./detail";
import { EditorForm, editorFor, newFields, type Editor } from "./editor";
import { ActionMenu, Banner, Button, EmptyState, IconButton, SearchField, Segmented, Skeleton, Spacer, SplitView, SyncStatus, Toolbar, fontSize, hairline, radius, relativeTime, space, toneColor, type MenuAction } from "./kit";
import { LaunchDialog } from "./launch";
import { ProjectList } from "./projects";
import { mergeDashboard, patchDashboard, pollInterval, type DashboardData } from "./sync";
import { ALL_PROJECT_ID, GroupHeader, KINDS, KIND_ICONS, KIND_LABELS, KIND_TONES, NoteCard, NoteRow, PickerButton, PrimaryIconButton, STATUSES, STATUS_LABELS, STATUS_TONES, ScopeMark, StatusGlyph, itemKey, statusColor, statusText, type NoteActions } from "./ui";
import { useForeground } from "./visibility";
import { searchText } from "./search";

type HostProps = PluginSurfaceProps;
type Sheet = { mode: "detail"; key: string } | { mode: "editor"; editor: Editor; returnTo: string | null };
type Section = { key: string; title: string; items: BoardItem[]; collapsible: boolean; status?: TaskStatus; projectId?: string };
const NO_PROJECTS: BoardProject[] = [];
const NO_BOARDS: BoardSnapshot[] = [];
const NO_UNAVAILABLE: UnavailableBoard[] = [];
const ALL_PROJECTS: BoardProject = { id: ALL_PROJECT_ID, name: "全部项目", path: "" };
/** Below this width (or when the host says so) one pane at a time: lists with collapsible sections, sheets for detail. */
const COMPACT_BELOW = 760;
/** Phones read what is running first; the wide board keeps the 待办 → 已完成 flow. */
const COMPACT_ORDER: TaskStatus[] = ["doing", "todo", "done"];
const STATUS_RANK: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2 };
let localRequestSequence = 0;
function requestId() { return `notes-${Date.now().toString(36)}-${(++localRequestSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
function errorText(error: unknown) { return error instanceof Error ? error.message : "操作没有完成，请重试。"; }
function compareItems(a: BoardItem, b: BoardItem) { return Number(b.pinned) - Number(a.pinned) || Number(b.priority === "high") - Number(a.priority === "high") || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id); }
function byDeletion(a: BoardItem, b: BoardItem) { return (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "") || compareItems(a, b); }
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
/** Why boards were left out of the overview (they exceed the size limits); the other projects still show. */
function unavailableReason(boards: readonly UnavailableBoard[]) {
  if (boards.every(board => board.reason === "file")) return `手记文件超过 ${megabytes(BOARD_FILE_LIMIT_BYTES)}`;
  if (boards.every(board => board.reason === "total")) return `全部项目的手记合计超过 ${megabytes(OVERVIEW_LIMIT_BYTES)}`;
  return "手记数据超过上限";
}
const UNAVAILABLE_ADVICE = "其余项目照常显示；请先备份，再精简这些手记。";
function unavailableText(boards: readonly UnavailableBoard[], projectName: (projectId: string) => string) {
  const named = boards.flatMap(board => board.projectId ? [`「${projectName(board.projectId)}」`] : []), unnamed = boards.length - named.length;
  const who = [...named.slice(0, 3), ...(unnamed ? [`${unnamed} 个已移除的项目`] : [])].join("、") + (named.length > 3 ? ` 等 ${boards.length} 个项目` : "");
  return `${who}的手记暂时无法显示：${unavailableReason(boards)}。${UNAVAILABLE_ADVICE}`;
}

export function NotesSurface(props: PluginSurfaceProps) { return <NotesApp key={props.host.id} {...props} />; }

export function NotesWorkspacePanel(props: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(props.workspaceId, value => ({ projectId: value.projectId, name: value.projectDisplayName }));
  return <NotesApp key={props.host.id} {...props} defaultProjectId={workspace?.projectId} />;
}

function NotesApp(props: HostProps & { defaultProjectId?: string }) {
  const { theme, host, layout } = props;
  const loadDashboard = useRpc(readDashboardRpc);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["project-notes", "dashboard", host.id], [host.id]);
  const [width, setWidth] = useState(0);
  // A retained-but-inactive tab or collapsed sidebar lays this view out at zero size.
  const [collapsed, setCollapsed] = useState(false);
  const visible = useForeground() && !collapsed;
  const dashboard = useQuery({
    queryKey, retry: false, staleTime: 5_000, refetchOnWindowFocus: false, refetchIntervalInBackground: false,
    queryFn: async (): Promise<DashboardData> => {
      // The query cache is shared by every open view of this host: its revision describes exactly what they show.
      const before = queryClient.getQueryData<DashboardData>(queryKey);
      const known = before?.revision;
      const update = await loadDashboard({ ...(known ? { revision: known } : {}), ...(before?.pendingProjectIds?.length ? { refreshProjectIds: before.pendingProjectIds } : {}) });
      const current = queryClient.getQueryData<DashboardData>(queryKey);
      if (update.unchanged && !current) return mergeDashboard(undefined, await loadDashboard({}), Date.now());
      return mergeDashboard(current, update, Date.now(), before?.writeEpoch ?? 0);
    },
    refetchInterval: query => pollInterval(visible, query.state.data, Date.now()),
  });
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void dashboard.refetch({ cancelRefetch: false });
    wasVisible.current = visible;
  }, [visible, dashboard.refetch]);
  const patchBoard = useCallback((snapshot: BoardSnapshot) => {
    queryClient.setQueryData<DashboardData>(queryKey, current => patchDashboard(current, snapshot, Date.now()));
  }, [queryClient, queryKey]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width: next, height } = event.nativeEvent.layout;
    setCollapsed(next <= 0 || height <= 0);
    if (next > 0) setWidth(next);
  }, []);
  const compact = layout.compact || (width > 0 && width < COMPACT_BELOW);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }} onLayout={onLayout}>
    <Board {...props} dashboard={dashboard} queryKey={queryKey} patchBoard={patchBoard} compact={compact} width={width} />
  </View>;
}

function Board({ theme, host, layout, navigation, dashboard: board, queryKey, patchBoard, compact, width, defaultProjectId }: HostProps & {
  dashboard: UseQueryResult<DashboardData, Error>; queryKey: readonly unknown[]; patchBoard: (board: BoardSnapshot) => void; compact: boolean; width: number; defaultProjectId?: string;
}) {
  const { colors } = theme;
  const write = useRpc(writeBoardRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const lastRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const [scopeId, setScopeId] = useState(ALL_PROJECT_ID);
  const [kind, setKind] = useState<NoteKind>("task");
  const [search, setSearch] = useState("");
  const [trash, setTrash] = useState(false);
  const [groupByProject, setGroupByProject] = useState(false);
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(() => new Set(["status:done"]));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuHint, setMenuHint] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [erase, setErase] = useState<{ item: BoardItem } | { boards: BoardSnapshot[]; count: number } | null>(null);
  const [erasing, setErasing] = useState(false);
  const [launchItem, setLaunchItem] = useState<BoardItem | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  // Only an explicit refresh shows 同步中; background polls must not re-render the board.
  const [refreshing, setRefreshing] = useState(false);
  const mutation = useMutation({ mutationFn: (input: WriteBoardInput) => write(input), onSuccess: result => { patchBoard(result.board); } });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const perform = async (projectId: string, operation: WriteBoardInput["operation"], key: string | null = null) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setOperationError(null); setPendingKey(key);
    const fingerprint = JSON.stringify({ projectId, operation });
    if (lastRequest.current?.fingerprint !== fingerprint) lastRequest.current = { fingerprint, id: requestId() };
    try {
      const result = await mutation.mutateAsync({ projectId, requestId: lastRequest.current.id, operation });
      lastRequest.current = null;
      return result;
    } catch (error) {
      if (mounted.current) setOperationError(errorText(error));
      return null;
    } finally { inFlight.current = false; if (mounted.current) setPendingKey(null); }
  };
  const eraseConfirmed = async () => {
    if (!erase || erasing || inFlight.current) return;
    setErasing(true);
    try {
      if ("item" in erase) {
        const item = erase.item;
        if (!await perform(item.projectId, { type: "purge", id: item.id, expectedRevision: item.revision }, itemKey(item))) return;
        setSheet(current => current?.mode === "detail" && current.key === itemKey(item) ? null : current);
      } else {
        // The id is an argument, not the loop's `snapshot`: the app's Hermes gives a loop variable one slot for every
        // iteration, and React may run this update after the next iteration has started.
        const erased = (projectId: string) => setErase(current => current && "boards" in current ? { ...current, boards: current.boards.filter(board => board.projectId !== projectId) } : current);
        for (const snapshot of erase.boards) {
          if (!await perform(snapshot.projectId, { type: "emptyTrash", expectedRevision: snapshot.revision })) return;
          // Completed projects leave the confirmation, so retry after a later failure does not erase twice.
          erased(snapshot.projectId);
        }
      }
      setErase(null); toast.show("已彻底删除", { variant: "success" });
    } finally { setErasing(false); }
  };
  const copy = async (value: string) => {
    try { await copyText(value); toast.show("已复制", { variant: "success" }); }
    catch (error) { setOperationError(`复制失败：${errorText(error)}`); }
  };
  const restoreVersion = (item: BoardItem, revision: number) => void perform(item.projectId, { type: "restoreVersion", id: item.id, expectedRevision: item.revision, revision }, itemKey(item)).then(result => {
    if (result && mounted.current) toast.show(`已恢复第 ${revision} 版`, { variant: "success" });
  });
  const repairHistory = async (item: BoardItem, expectedRevision: number) => {
    const result = await perform(item.projectId, { type: "repairHistory", id: item.id, expectedRevision }, itemKey(item));
    if (result && mounted.current) toast.show("已放弃缺失快照，当前正文和其余快照已保留", { variant: "success" });
    return result !== null;
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await board.refetch(); } finally { if (mounted.current) setRefreshing(false); }
  };

  const projects = board.data?.projects ?? NO_PROJECTS;
  const boards = board.data?.boards ?? NO_BOARDS;
  const unavailable = board.data?.unavailable ?? NO_UNAVAILABLE;
  const unavailableIds = useMemo(() => new Set(unavailable.flatMap(entry => entry.projectId ? [entry.projectId] : [])), [unavailable]);
  // One stable object per project (memoized rows compare it by reference); boards without a listed project get a stand-in.
  const projectOf = useMemo(() => {
    const known = new Map(projects.map(project => [project.id, project])), standIns = new Map<string, BoardProject>();
    return (projectId: string): BoardProject => {
      const project = known.get(projectId) ?? standIns.get(projectId);
      if (project) return project;
      const standIn = { id: projectId, name: projectId === INBOX_PROJECT_ID ? "随手记" : "未命名项目", path: "" };
      standIns.set(projectId, standIn);
      return standIn;
    };
  }, [projects]);
  const projectName = useCallback((projectId: string) => projectOf(projectId).name, [projectOf]);
  const scopeOptions = useMemo(() => [ALL_PROJECTS, ...projects], [projects]);
  const scope = scopeOptions.find(project => project.id === scopeId) ?? ALL_PROJECTS;
  // A project that disappeared from the list (removed elsewhere) falls back to the overview.
  useEffect(() => { if (board.data && scopeId !== ALL_PROJECT_ID && !projects.some(project => project.id === scopeId)) setScopeId(ALL_PROJECT_ID); }, [board.data, projects, scopeId]);
  const allItems = useMemo(() => boards.flatMap(snapshot => snapshot.items), [boards]);
  const { activeItems, trashedItems, counts, perProject } = useMemo(() => {
    const active: BoardItem[] = [], trashed: BoardItem[] = [], tally: Record<NoteKind, number> = { task: 0, prompt: 0, idea: 0 }, perProject = new Map<string, number>();
    let total = 0;
    for (const item of allItems) {
      if (item.deletedAt === null) { perProject.set(item.projectId, (perProject.get(item.projectId) ?? 0) + 1); total++; }
      if (scopeId !== ALL_PROJECT_ID && item.projectId !== scopeId) continue;
      if (item.deletedAt === null) { active.push(item); tally[item.kind]++; } else trashed.push(item);
    }
    perProject.set(ALL_PROJECT_ID, total);
    return { activeItems: active, trashedItems: trashed, counts: tally, perProject };
  }, [allItems, scopeId]);
  const [settledSearch, setSettledSearch] = useState("");
  useEffect(() => { const timer = setTimeout(() => setSettledSearch(search), 160); return () => clearTimeout(timer); }, [search]);
  const needle = settledSearch.trim().toLowerCase();
  const sorted = useMemo(() => (trash ? [...trashedItems] : activeItems.filter(item => item.kind === kind)).sort(trash ? byDeletion : compareItems), [activeItems, trashedItems, trash, kind]);
  const indexed = useMemo(() => sorted.map(item => ({ item, text: searchText(item) })), [sorted]);
  const items = useMemo(() => indexed.filter(entry => !needle || entry.text.includes(needle)).map(entry => entry.item), [indexed, needle]);
  const boardView = kind === "task" && !trash && !groupByProject && !compact;
  const split = !compact && !boardView;
  const showProject = scopeId === ALL_PROJECT_ID;
  const byStatus = useMemo(() => {
    const columns: Record<TaskStatus, BoardItem[]> = { todo: [], doing: [], done: [] };
    for (const item of items) columns[item.status].push(item);
    return columns;
  }, [items]);
  const sections = useMemo<Section[]>(() => {
    if (trash) return [{ key: "trash", title: "", items, collapsible: false }];
    if (groupByProject) {
      const groups = new Map<string, BoardItem[]>();
      for (const item of items) { const group = groups.get(item.projectId); if (group) group.push(item); else groups.set(item.projectId, [item]); }
      const order = new Map(projects.map((project, index) => [project.id, index]));
      return [...groups].sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b)).map(([projectId, group]) => ({
        key: `project:${projectId}`, title: projectName(projectId), projectId, collapsible: true,
        items: kind === "task" ? [...group].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || compareItems(a, b)) : group,
      }));
    }
    if (kind === "task") return COMPACT_ORDER.map(status => ({ key: `status:${status}`, title: STATUS_LABELS[status], status, items: byStatus[status], collapsible: true }));
    return [{ key: "all", title: "", items, collapsible: false }];
  }, [trash, groupByProject, kind, items, byStatus, projects, projectName]);
  const selectedItem = split ? items.find(item => itemKey(item) === selectedKey) ?? sections.find(section => section.items.length)?.items[0] ?? null : null;
  const sheetItem = sheet?.mode === "detail" ? allItems.find(item => itemKey(item) === sheet.key) ?? null : null;
  const editor = sheet?.mode === "editor" ? sheet.editor : null;
  const latestEditorItem = editor?.original ? allItems.find(item => item.id === editor.original?.id && item.projectId === editor.projectId) ?? null : null;
  const editorChangedElsewhere = Boolean(editor?.original && latestEditorItem && latestEditorItem.revision !== editor.original.revision);

  const openSection = (key: string) => setClosedSections(current => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next; });
  const toggleSection = (key: string) => setClosedSections(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const openCreate = (status: TaskStatus = "todo") => {
    setOperationError(null);
    const suggested = scopeId !== ALL_PROJECT_ID ? scopeId : defaultProjectId ?? INBOX_PROJECT_ID;
    setSheet({ mode: "editor", returnTo: null, editor: { original: null, projectId: projects.some(project => project.id === suggested) ? suggested : INBOX_PROJECT_ID, fields: newFields(kind, status) } });
  };
  const closeSheet = () => { if (sheet?.mode === "editor" && inFlight.current) return; setSheet(null); setOperationError(null); };
  const cancelEditor = () => { setSheet(current => current?.mode === "editor" && current.returnTo ? { mode: "detail", key: current.returnTo } : null); setOperationError(null); };
  const updateDraft = (fields: Partial<Editor["fields"]>) => setSheet(current => current?.mode === "editor" ? { ...current, editor: { ...current.editor, fields: { ...current.editor.fields, ...fields } } } : current);
  const save = async () => {
    if (sheet?.mode !== "editor") return;
    const { editor: draft, returnTo } = sheet;
    if (!draft.fields.title.trim()) return;
    if (!projects.some(project => project.id === draft.projectId)) { setOperationError("请选择一个有效的所属项目。"); return; }
    const fields = { ...draft.fields, title: draft.fields.title.trim() };
    const result = await perform(draft.projectId, draft.original ? { type: "update", id: draft.original.id, expectedRevision: draft.original.revision, fields } : { type: "create", fields });
    if (!result || !mounted.current) return;
    if (scopeId !== ALL_PROJECT_ID && draft.projectId !== scopeId) setScopeId(ALL_PROJECT_ID);
    setKind(fields.kind); setTrash(false);
    if (fields.kind === "task") openSection(`status:${fields.status}`);
    if (!draft.original) { setSearch(""); setSelectedKey(`${draft.projectId}:${result.itemId}`); }
    setSheet(returnTo ? { mode: "detail", key: returnTo } : null);
    toast.show(draft.original ? "已保存" : `已保存到「${projectName(draft.projectId)}」`, { variant: "success" });
  };
  const openMenu = () => {
    const syncedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt;
    setMenuHint([`保存在 ${host.label}`, syncedAt ? `上次同步 ${relativeTime(syncedAt)}` : ""].filter(Boolean).join(" · "));
    setMenuOpen(true);
  };

  // Stable row callbacks that always run the latest handlers, so memoized rows skip unrelated re-renders.
  const latest = useRef<NoteActions>(null as unknown as NoteActions);
  latest.current = {
    open: item => { setOperationError(null); if (split) setSelectedKey(itemKey(item)); else setSheet({ mode: "detail", key: itemKey(item) }); },
    start: item => { setSheet(null); setLaunchItem(item); setLaunchOpen(true); },
    edit: item => { setOperationError(null); setSheet({ mode: "editor", editor: editorFor(item), returnTo: sheet?.mode === "detail" ? itemKey(item) : null }); },
    copy: item => void copy(item.body || item.title),
    remove: item => void perform(item.projectId, { type: "delete", id: item.id, expectedRevision: item.revision }, itemKey(item)).then(result => {
      if (!result || !mounted.current) return;
      setSheet(current => current?.mode === "detail" && current.key === itemKey(item) ? null : current);
      toast.show("已移到回收站", { variant: "success" });
    }),
    restore: item => void perform(item.projectId, { type: "restore", id: item.id, expectedRevision: item.revision }, itemKey(item)).then(result => {
      if (!result || !mounted.current) return;
      setSheet(current => current?.mode === "detail" && current.key === itemKey(item) ? null : current);
      toast.show(`已恢复到「${KIND_LABELS[item.kind]}」`, { variant: "success" });
    }),
    status: (item, next) => void perform(item.projectId, { type: "update", id: item.id, expectedRevision: item.revision, fields: { status: next } }, itemKey(item)).then(result => {
      // On the board the card visibly changes column; in a list it may leave a collapsed section.
      if (result && mounted.current && !boardView && sheet === null) toast.show(`已移到${STATUS_LABELS[next]}`, { variant: "success" });
    }),
    update: (item, fields) => void perform(item.projectId, { type: "update", id: item.id, expectedRevision: item.revision, fields }, itemKey(item)),
  };
  const actions = useMemo<NoteActions>(() => ({
    open: item => latest.current.open(item), start: item => latest.current.start(item), edit: item => latest.current.edit(item), copy: item => latest.current.copy(item),
    remove: item => latest.current.remove(item), restore: item => latest.current.restore(item), status: (item, next) => latest.current.status(item, next), update: (item, fields) => latest.current.update(item, fields),
  }), []);

  // ── Toolbar ────────────────────────────────────────────────────────────────────────────────────────────
  // Quiet unless something is happening: a spinner while refreshing on request, a dot while the last sync failed.
  const syncState = board.isError ? (board.data ? "stale" : "error") : refreshing ? "syncing" : null;
  const createLabel = `新建${KIND_LABELS[kind]}`;
  const scopeButton = <PickerButton theme={theme} leading={<ScopeMark theme={theme} project={scope} />} label={scope.name} accessibilityLabel={`筛选项目：${scope.name}`} onPress={() => setScopeOpen(true)} maxWidth={compact ? "45%" : 220} />;
  const searchField = <SearchField theme={theme} value={search} onChangeText={setSearch} placeholder={trash ? "搜索回收站" : `搜索${KIND_LABELS[kind]}`} />;
  // With icons the type switch measures ~221 px plus ~7 px per count digit. Beside it phones need ~127 px (新建, ···,
  // a sync dot, gaps) and desktops ~544 px (全部项目 untruncated, search at its basis, a sync dot, 新建, ···, gaps).
  // Narrower layouts drop the icons and keep the labels and colored counts.
  const kindIcons = width >= (compact ? 348 : 765) + 7 * KINDS.reduce((digits, value) => digits + String(counts[value]).length, 0);
  const kindTabs = <Segmented theme={theme} value={kind} size={compact ? "sm" : "md"} accessibilityLabel="类型" onChange={value => { setKind(value); setOperationError(null); }}
    options={KINDS.map(value => ({ value, label: KIND_LABELS[value], tone: KIND_TONES[value], ...(board.data ? { count: counts[value] } : {}), ...(kindIcons ? { icon: KIND_ICONS[value] } : {}) }))} />;
  const trashTitle = <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flexShrink: 1, minWidth: 0 }}>
    <IconButton theme={theme} icon="ChevronLeft" label="返回手记" onPress={() => { setTrash(false); setSearch(""); }} />
    <Icon name="Trash2" size={14} color={toneColor(theme, "danger", "mark")} />
    <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>回收站</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{trashedItems.length}</Text>
  </View>;
  const sync = syncState ? <SyncStatus theme={theme} state={syncState} label={syncState === "syncing" && !compact ? "同步中" : undefined} /> : null;
  const create = trash ? null : compact ? <PrimaryIconButton theme={theme} icon="Plus" label={createLabel} disabled={!board.data} onPress={() => openCreate()} />
    : <Button theme={theme} label={createLabel} icon="Plus" variant="primary" disabled={!board.data} onPress={() => openCreate()} />;
  const more = <IconButton theme={theme} icon="Ellipsis" label="更多操作" onPress={openMenu} />;
  const toolbar = compact ? <>
    <Toolbar theme={theme} border={false}>{trash ? trashTitle : kindTabs}<Spacer />{sync}{create}{more}</Toolbar>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.sm, borderBottomWidth: hairline, borderBottomColor: colors.border }}>{scopeButton}{searchField}</View>
  </> : <Toolbar theme={theme}>
    {trash ? trashTitle : null}{scopeButton}{trash ? null : kindTabs}
    <Spacer />
    <View style={{ flexBasis: 200, flexShrink: 1, minWidth: 140 }}>{searchField}</View>
    {sync}{create}{more}
  </Toolbar>;
  const menuActions: MenuAction[] = trash ? [
    { key: "empty-trash", label: "清空回收站", icon: "Trash2", tone: "danger", disabled: erasing || !trashedItems.length,
      hint: `${trashedItems.length} 条，将彻底删除`, onPress: () => {
        setOperationError(null); setErase({ boards: boards.filter(board => (scopeId === ALL_PROJECT_ID || board.projectId === scopeId) && board.items.some(item => item.deletedAt !== null)), count: trashedItems.length });
      } },
    { key: "back", label: "返回手记", icon: "ArrowLeft", onPress: () => { setTrash(false); setSearch(""); } },
    { key: "refresh", label: "刷新", icon: "RefreshCw", hint: menuHint, onPress: () => void refresh() },
  ] : [
    { key: "trash", label: "回收站", icon: "Trash2", tone: "red", hint: trashedItems.length ? `${trashedItems.length} 条，可恢复` : "空", onPress: () => { setTrash(true); setSearch(""); } },
    groupByProject ? { key: "group", label: kind === "task" ? "按状态查看" : "取消按项目分组", icon: kind === "task" ? "Columns3" : "List", onPress: () => setGroupByProject(false) }
      : { key: "group", label: "按项目分组", icon: "Folders", onPress: () => setGroupByProject(true) },
    { key: "refresh", label: "刷新", icon: "RefreshCw", hint: menuHint, onPress: () => void refresh() },
  ];

  // ── Content ────────────────────────────────────────────────────────────────────────────────────────────
  const scopeUnavailable = unavailable.filter(entry => entry.projectId === scopeId);
  const empty = () => {
    // Notes that exist but are too large to show must not read as an empty project.
    if (scopeUnavailable.length) return <EmptyState theme={theme} icon="TriangleAlert" tone="warning" title={`「${scope.name}」的手记暂时无法显示`} message={`${unavailableReason(scopeUnavailable)}。${UNAVAILABLE_ADVICE}`} />;
    if (needle) return <EmptyState theme={theme} icon="Search" tone={trash ? "neutral" : KIND_TONES[kind]} title={`没有匹配「${search.trim()}」的${trash ? "手记" : KIND_LABELS[kind]}`} action={{ label: "清除搜索", onPress: () => setSearch("") }} />;
    if (trash) return <EmptyState theme={theme} icon="Trash2" tone="neutral" title="回收站是空的" />;
    return <EmptyState theme={theme} icon={KIND_ICONS[kind]} tone={KIND_TONES[kind]} title={`${scopeId === ALL_PROJECT_ID ? "" : `「${scope.name}」`}还没有${KIND_LABELS[kind]}`} action={{ label: createLabel, icon: "Plus", onPress: () => openCreate() }} />;
  };
  const row = (item: BoardItem) => <NoteRow key={itemKey(item)} theme={theme} item={item} project={showProject && !groupByProject ? projectOf(item.projectId) : null} selected={selectedItem !== null && itemKey(item) === itemKey(selectedItem)} busy={pendingKey === itemKey(item)} actions={actions} />;
  type ListEntry = { key: string; item: BoardItem } | { key: string; section: Section; open: boolean } | { key: string; empty: true };
  const listEntries = useMemo<ListEntry[]>(() => sections.flatMap(section => {
    const open = !section.collapsible || Boolean(needle) || !closedSections.has(section.key);
    const entries: ListEntry[] = section.title ? [{ key: `head:${section.key}`, section, open }] : [];
    if (open) entries.push(...section.items.map(item => ({ key: itemKey(item), item })));
    if (open && section.collapsible && !section.items.length) entries.push({ key: `empty:${section.key}`, empty: true });
    return entries;
  }), [sections, needle, closedSections]);
  const list = <FlatList data={listEntries} keyExtractor={entry => entry.key} initialNumToRender={12} maxToRenderPerBatch={12} windowSize={5}
    style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xs, paddingBottom: space.xxl }}
    renderItem={({ item: entry }) => {
      if ("item" in entry) return row(entry.item);
      if ("empty" in entry) return <Text style={{ paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm, color: colors.foregroundMuted, fontSize: fontSize.small }}>暂无</Text>;
      const { section, open } = entry;
      return <GroupHeader theme={theme} title={section.title} count={section.items.length} open={open} onToggle={section.collapsible && !needle ? () => toggleSection(section.key) : undefined}
        leading={section.status ? <StatusGlyph theme={theme} status={section.status} size={14} /> : section.projectId ? <ScopeMark theme={theme} project={projectOf(section.projectId)} size={16} /> : undefined}
        color={section.status ? statusText(theme, section.status) : section.projectId ? colors.foreground : undefined} />;
    }} />;
  // Column heads carry the status color: glyph, name and count, over a rule in the same color.
  const column = (status: TaskStatus) => <View key={status} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40, paddingLeft: space.xs }}>
      <StatusGlyph theme={theme} status={status} size={14} />
      <Text style={{ color: statusText(theme, status), fontSize: fontSize.small, fontWeight: "600" }}>{STATUS_LABELS[status]}</Text>
      <Text style={{ color: status === "todo" ? colors.foregroundMuted : statusText(theme, status), fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{byStatus[status].length}</Text>
      <Spacer />
      <IconButton theme={theme} icon="Plus" size="sm" label={`新建${STATUS_LABELS[status]}任务`} disabled={!board.data} onPress={() => openCreate(status)} />
    </View>
    <View style={{ height: 2, marginBottom: space.sm, borderRadius: 1, backgroundColor: status === "todo" ? colors.border : statusColor(theme, status) }} />
    <FlatList data={byStatus[status]} keyExtractor={itemKey} initialNumToRender={10} maxToRenderPerBatch={10} windowSize={5}
      style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.xl }} ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      renderItem={({ item }) => <NoteCard theme={theme} item={item} project={showProject ? projectOf(item.projectId) : null} busy={pendingKey === itemKey(item)} actions={actions} />}
      ListEmptyComponent={<View style={{ minHeight: 64, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderStyle: "dashed", borderColor: toneColor(theme, STATUS_TONES[status], "line") }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>暂无</Text>
      </View>} />
  </View>;
  let content: ReactNode;
  if (board.isPending) content = boardView ? <View style={{ flex: 1, flexDirection: "row", gap: space.md, paddingHorizontal: space.md, paddingTop: 50 }}>{STATUSES.map(status => <View key={status} style={{ flex: 1 }}><Skeleton theme={theme} rows={3} /></View>)}</View> : <Skeleton theme={theme} rows={6} />;
  else if (!board.data) content = <EmptyState theme={theme} icon="CloudOff" tone="danger" title="暂时无法读取手记" message={errorText(board.error)} action={{ label: "重试", icon: "RefreshCw", onPress: () => void refresh() }} />;
  else if (!items.length) content = <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingBottom: space.xxl }}>{empty()}</ScrollView>;
  else if (boardView) content = <View style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: space.md, paddingHorizontal: space.md }}>{STATUSES.map(column)}</View>;
  else if (split) content = <SplitView theme={theme} compact={false} showDetail listWidth={Math.round(Math.min(420, Math.max(320, width * 0.36)))} list={list}
    detail={selectedItem ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.xl, maxWidth: 760 }}>
      <NoteDetail key={itemKey(selectedItem)} theme={theme} hostId={host.id} onPurge={() => { setOperationError(null); setErase({ item: selectedItem }); }} item={selectedItem} project={projectOf(selectedItem.projectId)} actions={actions} busy={pendingKey === itemKey(selectedItem)} compact={false} onRestoreVersion={revision => restoreVersion(selectedItem, revision)} onRepairHistory={revision => repairHistory(selectedItem, revision)} />
    </ScrollView> : null} />;
  else content = list;

  const sheetTitle = sheet?.mode === "editor" ? `${sheet.editor.original ? "编辑" : "新建"}${KIND_LABELS[sheet.editor.fields.kind]}` : sheetItem ? `${sheetItem.deletedAt ? "回收站 · " : ""}${KIND_LABELS[sheetItem.kind]}详情` : "";
  return <View style={{ flex: 1, minHeight: 0 }}>
    {toolbar}
    {operationError && !sheet ? <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}><Banner theme={theme} tone="danger" message={operationError} onDismiss={() => setOperationError(null)} /></View> : null}
    {board.isError && board.data ? <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}><Banner theme={theme} tone="warning" message="同步中断，当前显示上次读取的内容。" action={{ label: "重试", onPress: () => void refresh() }} /></View> : null}
    {unavailable.length > 0 && scopeUnavailable.length === 0 ? <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}><Banner theme={theme} tone="warning" message={unavailableText(unavailable, projectName)} /></View> : null}
    <View style={{ flex: 1, minHeight: 0 }}>{content}</View>

    <Modal title={sheetTitle} open={sheet !== null && (sheet.mode === "editor" || sheetItem !== null)} onOpenChange={open => { if (!open) closeSheet(); }}>
      {/* The editor bounds its own scrolling so 保存 stays pinned; the detail is content-sized. */}
      <Modal.Content scrollable={!editor} contentContainerStyle={editor ? { padding: 0, gap: 0 } : { padding: space.xl, gap: space.lg }}>
        {sheet?.mode === "detail" && sheetItem ? <>
          {operationError ? <Banner theme={theme} tone="danger" message={operationError} onDismiss={() => setOperationError(null)} /> : null}
          <NoteDetail key={itemKey(sheetItem)} theme={theme} hostId={host.id} onPurge={() => { setOperationError(null); setErase({ item: sheetItem }); }} item={sheetItem} project={projectOf(sheetItem.projectId)} actions={actions} busy={pendingKey === itemKey(sheetItem)} compact={compact} onRestoreVersion={revision => restoreVersion(sheetItem, revision)} onRepairHistory={revision => repairHistory(sheetItem, revision)} />
        </> : null}
        {editor ? <EditorForm theme={theme} editor={editor} projects={projects} projectName={projectName} busy={mutation.isPending} compact={compact} error={operationError} changedElsewhere={editorChangedElsewhere}
          onChange={updateDraft} onProject={projectId => setSheet(current => current?.mode === "editor" && !current.editor.original ? { ...current, editor: { ...current.editor, projectId } } : current)}
          onCancel={cancelEditor} onSave={() => void save()} onCopyDraft={() => void copy(`${editor.fields.title}\n\n${editor.fields.body}`.trim())}
          onLoadLatest={() => { if (latestEditorItem) setSheet(current => current?.mode === "editor" ? { ...current, editor: editorFor(latestEditorItem) } : current); }} /> : null}
      </Modal.Content>
    </Modal>
    <Modal title="选择项目" open={scopeOpen} onOpenChange={setScopeOpen}>
      <Modal.Content contentContainerStyle={{ paddingHorizontal: space.md, paddingVertical: space.md, gap: 0 }}>
        <ProjectList theme={theme} projects={scopeOptions} selectedId={scopeId} counts={perProject} unavailable={unavailableIds} loading={board.isPending} onSelect={project => { setScopeId(project.id); setScopeOpen(false); }} />
      </Modal.Content>
    </Modal>
    <Modal title={erase && "item" in erase ? "彻底删除手记" : "清空回收站"} open={erase !== null} onOpenChange={open => { if (!open && !erasing) { setErase(null); setOperationError(null); } }}>
      <Modal.Content contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
        <Banner theme={theme} tone="danger" message={erase && "item" in erase ? `将彻底删除「${erase.item.title}」及其全部修改快照，无法恢复。` : `将彻底删除当前范围回收站内全部 ${erase && "count" in erase ? erase.count : 0} 条手记（含搜索未显示的）及其全部修改快照，无法恢复。`} />
        {operationError ? <Banner theme={theme} tone="danger" message={operationError} /> : null}
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Button theme={theme} label="取消" disabled={erasing} grow onPress={() => { setErase(null); setOperationError(null); }} />
          <Button theme={theme} label="确认彻底删除" icon="Trash2" tone="danger" variant="secondary" busy={erasing} grow onPress={() => void eraseConfirmed()} />
        </View>
      </Modal.Content>
    </Modal>
    <ActionMenu theme={theme} title="更多操作" open={menuOpen} onClose={() => setMenuOpen(false)} actions={menuActions} />
    {launchItem ? <LaunchDialog key={`${host.id}:${itemKey(launchItem)}`} theme={theme} host={host} layout={{ ...layout, compact }} navigation={navigation}
      item={allItems.find(item => itemKey(item) === itemKey(launchItem)) ?? launchItem} open={launchOpen} onOpenChange={setLaunchOpen} /> : null}
  </View>;
}
