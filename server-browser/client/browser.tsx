import { openExternalUrl, useRpc, type PluginSurfaceProps, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { Icon, useToast } from '@getpaseo/plugin/client/react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, KeyboardAvoidingView, PanResponder, PixelRatio, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import {
  actionRpc, agentRpc, diagnosticsRpc, frameRpc, optionsRpc, readPageRpc, startRpc, stateRpc,
  type BrowserAction, type BrowserFrameQuality as FrameQuality, type BrowserFrameResult, type BrowserOverviewItem, type BrowserProfile, type BrowserReading, type BrowserSession, type BrowserWorkspace,
} from '../shared/browser';
import { bindFrameKeyboard, bindFrameWheel, focusFrame } from './web';
import { AddressField, BusyPill, InputDock, ModeSwitch, StageMessage, TabCountButton, useSheetPresence } from './chrome';
import { computeViewportLayout, mapViewportPoint } from './viewport-geometry';
import { BrowserOverview, recallFrame, rememberFrame, useAppForeground, useBrowserOverview } from './overview';
import { agentStatus, currentAgentActivity, linkedAgent, pageHost } from './overview-model';
import { BrowserAgentTabs } from './agent-tabs';
import { buildAgentTabGroups, controlLooks, projectName, tabGlyph } from './agent-tabs-model';
import { effectiveQuality, frameDelay, frameLimits, frameTargetMs, initialPacing, recordFrame, type FramePacing } from './frame-pacing';
import { deviceOpenableUrl } from './local-open';
import { ActionMenu, Banner, BottomBar, Button, IconButton, MetaLine, ProjectMark, fontSize, hairline, hue, radius, space, useCompactLayout, withAlpha, type MenuAction, type Tone } from './kit';
import { StateGlyph } from './looks';
import { ActivitySheet, AgentSheet, DiagnosticsSheet, PageTabsSheet, ReadingSheet, ResourcesSheet, StopSheet, ViewSheet, WorkspacePickerSheet, qualityLabel, type FrameMetrics } from './tools';

type Theme = PluginSurfaceProps['theme'];
type Frame = NonNullable<BrowserFrameResult['frame']>;
type PageCheck = { name: string; status: 'ok' | 'warning' | 'error'; detail: string };
type SheetName = 'menu' | 'tabs' | 'view' | 'reading' | 'diagnostics' | 'activity' | 'resources' | 'agent' | 'stop';
type ScreenProps = PluginSurfaceProps & {
  workspaceId: string;
  workspaceTitle: string;
  workspace: BrowserWorkspace;
  overviewItem?: BrowserOverviewItem;
  overviewItems: BrowserOverviewItem[];
  onSelectWorkspace: (id: string) => void;
  onOpenOverview: () => void;
  onPickWorkspace: () => void;
  profiles: BrowserProfile[];
  /** Phone-style chrome: one top row, navigation in a bottom bar while in manual control. */
  compactChrome: boolean;
};
const noItems: BrowserOverviewItem[] = [];

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '连接暂时不可用');
  const raw = message.replace(/^Request failed:\s*/i, '').replace(/\s+requestType=\S+\s+code=\S+[\s\S]*$/, '').trim();
  if (/agent.*busy|正在.*操作|takeover/i.test(raw)) return '当前操作正在结束，请稍后再接管。';
  if (/timeout|timed out/i.test(raw)) return '服务器响应较慢，请稍后重试。';
  if (/disconnect|offline|closed.*connection|not connected/i.test(raw)) return '与服务器的连接已断开，重新连接后可继续。';
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}
/** The pill of a request in flight takes the colour of what it waits for: handing to the Agent violet, taking over amber, page work blue. */
const busyTone = (label: string): Tone => /Agent/.test(label) ? controlLooks.agent.hue : /手动/.test(label) ? controlLooks.manual.hue : 'info';

/** Placeholder chrome while the first workspace list loads: the browser's shape, no fake content. */
function BrowserSkeleton({ theme, compact, children }: { theme: Theme; compact: boolean; children?: ReactNode }) {
  const { colors } = theme;
  const block = (width: number | `${number}%`, height = 20, key?: string) => <View key={key} style={{ width, height, borderRadius: radius.sm, backgroundColor: colors.surface2 }} />;
  return <View accessibilityRole="progressbar" accessibilityLabel="加载中" style={{ flex: 1, minHeight: 0 }}>
    {!compact && <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 40, paddingHorizontal: space.md, borderBottomWidth: hairline, borderBottomColor: colors.border }}>{block(20)}{block(140)}{block(110)}</View>}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, height: compact ? 48 : 40, paddingHorizontal: space.md, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
      {compact ? <>{block(28, 28)}{block('55%', 16)}</> : <>{['a', 'b', 'c'].map((key) => block(20, 20, key))}{block('60%', 28)}</>}
    </View>
    {children ? <View style={{ padding: space.md }}>{children}</View> : null}
    <View style={{ flex: 1, backgroundColor: colors.surface1 }} />
  </View>;
}

function BrowserShell(props: PluginSurfaceProps & { fixedWorkspaceId?: string; onOpenOverview?: () => void }) {
  const getOptions = useRpc(optionsRpc);
  const options = useQuery({ queryKey: ['server-browser', props.host.id, 'options'], queryFn: () => getOptions({}), staleTime: 15_000, retry: 1 });
  // A host keeps recent tabs mounted with display:none; their zero-size layout pauses polling.
  const [visible, setVisible] = useState(true);
  const [shortWindow, setShortWindow] = useState(false);
  const layout = useCompactLayout(props.layout.compact);
  const overview = useBrowserOverview(props.host.id, visible);
  const [selectedId, setSelectedId] = useState(props.fixedWorkspaceId || '');
  const [view, setView] = useState<'browser' | 'overview'>('browser');
  const [picking, setPicking] = useState(false);
  const workspaces = useMemo(() => {
    const items = new Map((options.data?.workspaces ?? []).map((workspace) => [workspace.id, workspace]));
    for (const item of overview.data?.items ?? []) items.set(item.workspace.id, item.workspace);
    return [...items.values()];
  }, [options.data?.workspaces, overview.data?.items]);
  useEffect(() => {
    if (!overview.data || !workspaces.length || workspaces.some((workspace) => workspace.id === selectedId)) return;
    const live = overview.data.items.find((item) => item.session.status === 'running') || overview.data.items[0];
    setSelectedId(live?.workspace.id || workspaces[0].id);
  }, [props.fixedWorkspaceId, overview.data, workspaces, selectedId]);
  const workspaceId = selectedId || props.fixedWorkspaceId || '';
  const workspace = workspaces.find((item) => item.id === workspaceId) || { id: workspaceId, title: '工作区', cwd: '' };
  const items = overview.data?.items ?? noItems;
  const overviewItem = items.find((item) => item.workspace.id === workspaceId);
  const select = useCallback((id: string) => { setSelectedId(id); setView('browser'); setPicking(false); }, []);
  const openOverview = useCallback(() => setView('overview'), []);
  const pickWorkspace = useCallback(() => setPicking(true), []);
  const refetchOverview = overview.refetch, refetchOptions = options.refetch;
  const refresh = useCallback(() => { void refetchOptions(); void refetchOverview({ cancelRefetch: false }); }, [refetchOptions, refetchOverview]);
  const started = useMemo(() => new Set(items.filter((item) => item.session.status !== 'idle').map((item) => item.workspace.id)), [items]);
  const failure = overview.error || options.error;
  const loading = !overview.data && !failure;
  const pickerPresent = useSheetPresence(picking ? 'picker' : null);
  const { theme } = props, compact = layout.compact;
  let content: ReactNode;
  if (view === 'overview' && (workspaceId || items.length)) content = <BrowserOverview theme={theme} compact={compact} hostId={props.host.id} items={items} loading={loading} error={failure ? errorMessage(failure) : null}
    selectedId={workspaceId} onSelect={select} onBack={workspaceId ? () => setView('browser') : undefined} onAddWorkspace={pickWorkspace}
    stale={overview.stale} active={overview.active} pending={overview.isFetching} checkedAt={overview.data?.checkedAt} onRefresh={refresh} />;
  else if (workspaceId) content = <BrowserScreen key={`${props.host.id}:${workspaceId}`} {...props} workspaceId={workspaceId} workspaceTitle={workspace.title} workspace={workspace}
    overviewItem={overviewItem} overviewItems={items} onSelectWorkspace={select} onOpenOverview={openOverview} onPickWorkspace={pickWorkspace}
    profiles={options.data?.profiles ?? []} compactChrome={compact || shortWindow} />;
  else if (failure) content = <BrowserSkeleton theme={theme} compact={compact}><Banner theme={theme} tone="danger" message={errorMessage(failure)} action={{ label: '重试', onPress: refresh }} /></BrowserSkeleton>;
  else if (!loading && !workspaces.length) content = <StageMessage theme={theme} icon="FolderOpen" tone="info" title="还没有工作区" message="在 Paseo 中打开项目后，就能为它启动服务器浏览器。" />;
  else content = <BrowserSkeleton theme={theme} compact={compact} />;
  return <View testID="server-browser-shell" onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setVisible(width > 0 && height > 0); setShortWindow(height > 0 && height < 500); layout.onLayout(event); }} style={{ flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: theme.colors.surface0 }}>
    {content}
    {pickerPresent('picker') ? <WorkspacePickerSheet theme={theme} open={picking} onClose={() => setPicking(false)} workspaces={workspaces} running={started} selectedId={workspaceId} onSelect={select} /> : null}
  </View>;
}

export function ServerBrowserSurface(props: PluginSurfaceProps) { return <BrowserShell key={props.host.id} {...props} />; }
export function ServerBrowserWorkspacePanel(props: PluginWorkspacePanelProps & { onOpenOverview?: () => void }) { return <BrowserShell key={`${props.host.id}:${props.workspaceId}`} {...props} fixedWorkspaceId={props.workspaceId} />; }

function BrowserScreen({ theme, host, layout, navigation, workspaceId, workspaceTitle, workspace, overviewItem, overviewItems, onSelectWorkspace, onOpenOverview, onPickWorkspace, profiles, compactChrome }: ScreenProps) {
  const readState = useRpc(stateRpc);
  const start = useRpc(startRpc);
  const capture = useRpc(frameRpc);
  const act = useRpc(actionRpc);
  const connectAgent = useRpc(agentRpc);
  const diagnose = useRpc(diagnosticsRpc);
  const readPage = useRpc(readPageRpc);
  const toast = useToast();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [stageHidden, setStageHidden] = useState(false);
  const appActive = useAppForeground() && !stageHidden;
  const [busy, setBusy] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [viewport, setViewport] = useState<'phone' | 'desktop'>(layout.compact ? 'phone' : 'desktop');
  const [profileId, setProfileId] = useState('');
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const present = useSheetPresence(sheet);
  const [inputOpen, setInputOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [quality, setQuality] = useState<FrameQuality>('sharp');
  const [frameMetrics, setFrameMetrics] = useState<FrameMetrics | null>(null);
  const [pageChecks, setPageChecks] = useState<PageCheck[] | null>(null);
  const [readingMode, setReadingMode] = useState<'article' | 'visible'>('article');
  const [readingQuery, setReadingQuery] = useState('');
  const [reading, setReading] = useState<BrowserReading | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [openingAgent, setOpeningAgent] = useState(false);
  const [frameNode, setFrameNode] = useState<unknown>(null);
  // The last frame this app saw of this browser: shown dimmed until the live frame arrives, so switching feels instant.
  const [placeholder] = useState(() => recallFrame(host.id, workspaceId));
  const alive = useRef(true);
  const sessionRef = useRef<BrowserSession | null>(null);
  const frameIdRef = useRef<string | null>(null);
  const actionBusyRef = useRef(false);
  const frameBusyRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const addressFocused = useRef(false);
  const pressLocation = useRef<{ x: number; y: number } | null>(null);
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const pacingRef = useRef<FramePacing>(initialPacing);
  // Revision of the session last delivered by a frame poll; any other session update clears it.
  const sessionRevisionRef = useRef<string | null>(null);
  // Unchanged sessions are no longer re-sent, so the uptime counter is extended locally from this moment.
  const sessionReceivedAtRef = useRef(0);
  const limitsRef = useRef(frameLimits(stageSize, PixelRatio.get()));
  limitsRef.current = frameLimits(stageSize, PixelRatio.get());
  const metricsVisibleRef = useRef(false);
  metricsVisibleRef.current = sheet === 'view';
  const suppressFrameClick = useRef(false);
  const scrollPending = useRef({ x: 0, y: 0 });
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardQueue = useRef<Array<{ action: BrowserAction; done?: (success: boolean) => void }>>([]);
  const keyboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<{ canControl: boolean; scale: number; perform: (action: BrowserAction, label?: string) => Promise<boolean> }>({ canControl: false, scale: 1, perform: async () => false });
  const appActiveRef = useRef(appActive);
  appActiveRef.current = appActive;
  const colors = theme.colors;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (scrollTimer.current) clearTimeout(scrollTimer.current); if (keyboardTimer.current) clearTimeout(keyboardTimer.current); };
  }, []);
  useEffect(() => {
    if (!profileId && profiles.length) setProfileId(profiles[0].id);
  }, [profileId, profiles]);
  useEffect(() => { if (frame) rememberFrame(host.id, workspaceId, frame); }, [frame, host.id, workspaceId]);

  const serialize = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const promise = queueRef.current.catch(() => {}).then(() => {
      if (!alive.current) throw new Error('当前页面已关闭');
      return task();
    });
    queueRef.current = promise.catch(() => {});
    return promise;
  }, []);
  const updateSession = useCallback((value: BrowserSession, revision: string | null = null) => {
    if (!alive.current) return;
    sessionRevisionRef.current = revision;
    sessionReceivedAtRef.current = Date.now();
    const previousUrl = sessionRef.current?.url;
    const previousTab = sessionRef.current?.tabs.find((tab) => tab.active)?.id;
    sessionRef.current = value;
    setSession(value);
    if (value.url !== previousUrl || value.tabs.find((tab) => tab.active)?.id !== previousTab || value.status === 'recovering') {
      setReading(null);
      setPageChecks(null);
    }
    if (!addressFocused.current && value.url !== previousUrl) setAddress(value.url);
    if (value.status !== 'running') { setFrame(null); frameIdRef.current = null; }
    if (value.error) {
      setFrameError(value.error);
      if (value.status === 'error') setError(value.error);
    }
    if (value.status === 'running') setViewport(value.width < 600 ? 'phone' : 'desktop');
  }, []);

  const stateMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => readState({ workspaceId })) });
  // A live frame stream must not retain several minutes of JPEGs in the query cache.
  const captureMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => capture({
    workspaceId, after: frameIdRef.current, quality: effectiveQuality(qualityRef.current, pacingRef.current), ...limitsRef.current,
    ...(sessionRevisionRef.current ? { sessionRevision: sessionRevisionRef.current } : {}),
  })) });
  const startMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => start({ workspaceId })) });
  const actionMutation = useMutation({ gcTime: 0, mutationFn: (action: BrowserAction) => serialize(() => act({ workspaceId, action })) });
  const agentMutation = useMutation({ gcTime: 0, mutationFn: (selectedProfile: string) => serialize(() => connectAgent({ workspaceId, ...(selectedProfile ? { profileId: selectedProfile } : {}) })) });
  const diagnosticsMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => diagnose({ workspaceId })) });
  const readingMutation = useMutation({ gcTime: 0, mutationFn: (input: { mode: 'article' | 'visible'; query?: string }) => serialize(() => readPage({ workspaceId, ...input, maxChars: 16000 })) });

  const refreshFrame = useCallback(async (force = false) => {
    if (!alive.current || !appActiveRef.current || frameBusyRef.current || (!force && actionBusyRef.current)) return;
    frameBusyRef.current = true;
    const requestedAt = Date.now();
    try {
      const result = await captureMutation.mutateAsync();
      if (!alive.current) return;
      // An omitted session is unchanged since the revision this viewer holds.
      if (result.session) updateSession(result.session, result.sessionRevision ?? null);
      const current = sessionRef.current;
      if (result.frame && current?.status === 'running') { frameIdRef.current = result.frame.id; setFrame(result.frame); }
      const previous = pacingRef.current;
      const latency = Date.now() - requestedAt;
      pacingRef.current = recordFrame(previous, { requestedAt, latency, changed: !!result.frame });
      if (metricsVisibleRef.current) setFrameMetrics({ latency, interval: previous.previousRequestAt ? requestedAt - previous.previousRequestAt : null, kilobytes: result.frame ? Math.round(result.frame.dataUrl.length / 1024) : null, scale: result.frame?.scale ?? null, degraded: pacingRef.current.degrade > 0 });
      setFrameError(current?.error ?? null);
    } catch (failure) {
      if (!alive.current) return;
      setFrameError(errorMessage(failure));
      setFrame(null);
      frameIdRef.current = null;
      pacingRef.current = recordFrame(pacingRef.current, { requestedAt, latency: Date.now() - requestedAt, changed: false, failed: true });
    } finally { frameBusyRef.current = false; }
  }, [captureMutation.mutateAsync, updateSession]);
  const refreshRef = useRef(refreshFrame);
  refreshRef.current = refreshFrame;

  useEffect(() => {
    let cancelled = false;
    void stateMutation.mutateAsync().then((value) => {
      if (cancelled || !alive.current) return;
      updateSession(value);
      if (value.status === 'running' || value.status === 'recovering') void refreshRef.current();
    }).catch((failure) => { if (!cancelled && alive.current) setError(errorMessage(failure)); });
    return () => { cancelled = true; };
  }, [workspaceId, stateMutation.mutateAsync, updateSession]);

  useEffect(() => {
    if (paused || !appActive || (session?.status !== 'running' && session?.status !== 'recovering')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      const cycleStarted = Date.now();
      await refreshRef.current();
      const targetInterval = frameDelay(pacingRef.current, qualityRef.current, sessionRef.current?.status === 'recovering');
      if (!cancelled) timer = setTimeout(next, Math.max(100, targetInterval - (Date.now() - cycleStarted)));
    };
    timer = setTimeout(next, frameTargetMs[quality]);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [paused, appActive, session?.status, quality]);

  async function perform(action: BrowserAction, label = '正在操作…') {
    if (actionBusyRef.current || !alive.current) return false;
    actionBusyRef.current = true;
    pacingRef.current = { ...pacingRef.current, unchanged: 0 };
    setBusy(label); setError(null);
    const invalidates = ['navigate', 'back', 'forward', 'reload', 'demo', 'stop', 'newTab', 'tab', 'closeTab', 'viewport', 'restart', 'fitWidth'].includes(action.kind);
    if (invalidates) { setFrame(null); frameIdRef.current = null; setReading(null); setPageChecks(null); }
    try {
      const value = await actionMutation.mutateAsync(action);
      if (!alive.current) return false;
      updateSession(value);
      if (invalidates) setAddress(value.url);
      if (value.status === 'running') await refreshFrame(true);
      return true;
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
      return false;
    } finally {
      actionBusyRef.current = false;
      if (alive.current) setBusy(null);
    }
  }

  async function startBrowser() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy('正在启动浏览器…'); setError(null); setFrameError(null);
    try {
      const requestedViewport = viewport;
      let value = await startMutation.mutateAsync();
      if (!alive.current) return;
      const size = requestedViewport === 'phone' ? { width: 390, height: 760 } : { width: 1120, height: 720 };
      if (value.mode === 'manual' && (value.width !== size.width || value.height !== size.height)) {
        value = await actionMutation.mutateAsync({ kind: 'viewport', ...size });
      }
      updateSession(value); setPaused(false); await refreshFrame(true);
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  async function openAgent() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy(session?.agentId ? '正在连接 Agent…' : '正在准备 Agent…'); setError(null);
    try {
      const result = await agentMutation.mutateAsync(profileId);
      if (!alive.current) return;
      updateSession(result.session);
      setSheet(null);
      if (result.created) toast.show('已连接浏览器 Agent', { variant: 'success' });
      navigation?.openAgent({ agentId: result.agentId, serverId: host.id });
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  async function openConnectedAgent() {
    if (openingAgent) return;
    setOpeningAgent(true); setError(null);
    try {
      const current = await stateMutation.mutateAsync();
      if (!alive.current) return;
      updateSession(current);
      if (!current.agentId) { setError('当前还没有已连接的 Agent，请先连接浏览器 Agent。'); return; }
      navigation?.openAgent({ agentId: current.agentId, serverId: host.id });
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { if (alive.current) setOpeningAgent(false); }
  }

  async function inspectPage() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy('正在检查当前页面…'); setError(null);
    try {
      const result = await diagnosticsMutation.mutateAsync();
      if (!alive.current) return;
      updateSession({ ...result.session, health: result.health }); setPageChecks(result.checks);
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  async function extractPage() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy('正在读取当前页面…'); setReadingError(null); setReading(null);
    try {
      const result = await readingMutation.mutateAsync({ mode: readingMode, ...(readingQuery.trim() ? { query: readingQuery.trim() } : {}) });
      if (alive.current) setReading(result);
    } catch (failure) { if (alive.current) setReadingError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  function selectQuality(value: FrameQuality) {
    qualityRef.current = value; setQuality(value);
    // An explicit choice is honoured again until the link proves slow.
    pacingRef.current = { ...pacingRef.current, unchanged: 0, degrade: 0, fast: 0 }; frameIdRef.current = null;
    if (!paused && appActive) void refreshFrame();
  }
  const pageUrl = deviceOpenableUrl(session?.url);
  async function openOnDevice(url: string) {
    try { await openExternalUrl(url); } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
  }

  const queueScroll = useCallback((displayX: number, displayY: number) => {
    if (!controllerRef.current.canControl) return;
    const clamp = (value: number) => Math.max(-2400, Math.min(2400, value));
    scrollPending.current.x = clamp(scrollPending.current.x + displayX * controllerRef.current.scale);
    scrollPending.current.y = clamp(scrollPending.current.y + displayY * controllerRef.current.scale);
    if (scrollTimer.current) return;
    const flush = async () => {
      scrollTimer.current = null;
      if (!alive.current || !controllerRef.current.canControl) { scrollPending.current = { x: 0, y: 0 }; return; }
      if (actionBusyRef.current) { scrollTimer.current = setTimeout(flush, 120); return; }
      const delta = scrollPending.current;
      scrollPending.current = { x: 0, y: 0 };
      if (Math.abs(delta.x) + Math.abs(delta.y) < 1) return;
      await controllerRef.current.perform({ kind: 'scroll', deltaX: Math.round(delta.x), deltaY: Math.round(delta.y) }, '正在滚动网页…');
      if ((scrollPending.current.x || scrollPending.current.y) && !scrollTimer.current) scrollTimer.current = setTimeout(flush, 80);
    };
    scrollTimer.current = setTimeout(flush, 70);
  }, []);
  const enqueueInput = useCallback((action: BrowserAction, done?: (success: boolean) => void) => {
    if (!controllerRef.current.canControl) { done?.(false); return; }
    const tail = keyboardQueue.current[keyboardQueue.current.length - 1];
    if (action.kind === 'text' && tail?.action.kind === 'text' && !done && !tail.done && tail.action.text.length + action.text.length <= 10_000) tail.action.text += action.text;
    else keyboardQueue.current.push({ action, done });
    if (keyboardTimer.current) return;
    const flush = async () => {
      keyboardTimer.current = null;
      if (!alive.current || !controllerRef.current.canControl) { for (const entry of keyboardQueue.current) entry.done?.(false); keyboardQueue.current = []; return; }
      if (actionBusyRef.current) { keyboardTimer.current = setTimeout(flush, 40); return; }
      const next = keyboardQueue.current.shift();
      if (!next) return;
      const success = await controllerRef.current.perform(next.action);
      next.done?.(success);
      if (!success) { for (const entry of keyboardQueue.current) entry.done?.(false); keyboardQueue.current = []; }
      if (keyboardQueue.current.length && !keyboardTimer.current) keyboardTimer.current = setTimeout(flush, 0);
    };
    keyboardTimer.current = setTimeout(flush, 35);
  }, []);
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => controllerRef.current.canControl && Math.abs(gesture.dx) + Math.abs(gesture.dy) > 10,
    onPanResponderGrant: () => { suppressFrameClick.current = true; pressLocation.current = null; },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_event, gesture) => { suppressFrameClick.current = true; queueScroll(-gesture.dx, -gesture.dy); },
    onPanResponderTerminate: () => { suppressFrameClick.current = true; },
  }), [queueScroll]);

  const running = session?.status === 'running';
  const recovering = session?.status === 'recovering';
  const hasBrowser = !!session && (running || recovering);
  const manual = running && session.mode === 'manual' && !session.agentBusy && !busy;
  const canType = !!manual && !!frame && !frameError;
  const canControl = !!running && session.mode === 'manual' && !session.agentBusy && !frameError && !!frame;
  const geometry = computeViewportLayout({ containerWidth: stageSize.width, containerHeight: stageSize.height, frameWidth: frame?.width || session?.width || 0, frameHeight: frame?.height || session?.height || 0 });
  controllerRef.current = { canControl, scale: geometry.scale > 0 ? 1 / geometry.scale : 1, perform };
  useEffect(() => {
    if (!canControl || !frameNode) return;
    const wheel = bindFrameWheel(frameNode, queueScroll);
    const keyboard = bindFrameKeyboard(frameNode, (action) => enqueueInput(action));
    return () => { wheel(); keyboard(); };
  }, [canControl, frameNode, queueScroll, enqueueInput]);
  const agentControlled = running && session.mode === 'agent';

  function pressFrame(event: GestureResponderEvent) {
    if (suppressFrameClick.current) { suppressFrameClick.current = false; return; }
    if (agentControlled) { toast.show('切换到「手动」后可以操作网页'); return; }
    if (!canControl || !frame || frameError || geometry.scale <= 0 || !session) return;
    // Native onPress has local coordinates. React Native Web dispatches its final
    // click as a MouseEvent, so keep the normalized responder position from press-in.
    const position = Number.isFinite(event.nativeEvent.locationX) && Number.isFinite(event.nativeEvent.locationY)
      ? { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }
      : pressLocation.current;
    pressLocation.current = null;
    if (!position) return;
    const point = mapViewportPoint(position, geometry, { frameWidth: frame.width, frameHeight: frame.height });
    if (!point) return;
    focusFrame(frameNode);
    enqueueInput({ kind: 'click', x: point.x, y: point.y });
  }
  function navigate() {
    const url = address.trim();
    if (url && url !== 'about:blank' && manual) { addressFocused.current = false; void perform({ kind: 'navigate', url }, '正在打开网页…'); }
  }
  async function sendText() {
    const value = text;
    if (!value || !canType) return;
    if (await new Promise<boolean>((resolve) => enqueueInput({ kind: 'text', text: value }, resolve))) setText((current) => current === value ? '' : current);
  }

  const linked = linkedAgent(overviewItem, session);
  const tabGroups = useMemo(() => {
    const items = session ? overviewItems.map((item) => item.workspace.id === workspaceId ? { ...item, session } : item) : overviewItems;
    return buildAgentTabGroups(items, workspace);
  }, [overviewItems, session, workspaceId, workspace]);
  const projectIdentity = projectName(workspace);
  const selectedAgentTab = tabGroups.flatMap((group) => group.tabs).find((tab) => tab.workspaceId === workspaceId);
  const matchWindow = async () => {
    if (!manual || stageSize.width <= 0 || stageSize.height <= 0) return;
    setSheet(null);
    const matched = await perform({ kind: 'viewport', width: Math.max(320, Math.min(2560, Math.floor(stageSize.width))), height: Math.max(320, Math.min(1600, Math.floor(stageSize.height))) }, '正在匹配窗口…');
    if (matched) await perform({ kind: 'fitWidth' }, '正在检查页面完整宽度…');
  };
  const setMode = (mode: 'agent' | 'manual') => { if (mode === 'agent') setInputOpen(false); void perform({ kind: 'mode', mode }, mode === 'manual' ? '正在切换到手动…' : '正在交给 Agent…'); };
  const activeTab = session?.tabs.find((tab) => tab.active);
  const agentTabId = currentAgentActivity(session)?.tabId;
  const glyph = selectedAgentTab ? tabGlyph(selectedAgentTab.state, selectedAgentTab.mode) : null;
  const viewHint = [qualityLabel(quality), paused ? '已暂停' : null, session && hasBrowser ? `${session.width}×${session.height}` : null, geometry.scale > 0 ? `显示 ${Math.round(geometry.scale * 100)}%` : null].filter(Boolean).join(' · ');
  const uptimeSeconds = (session?.runtime?.uptimeSeconds || 0) + (session?.status === 'running' ? Math.max(0, (Date.now() - sessionReceivedAtRef.current) / 1000) : 0);

  // Manual-only actions appear once the viewer has taken over; while the Agent is in control they would all be disabled.
  const takenOver = hasBrowser && session.mode === 'manual';
  const menu: MenuAction[] = [];
  if (compactChrome && takenOver) menu.push({ key: 'forward', label: '前进', icon: 'ArrowRight', disabled: !manual, onPress: () => { void perform({ kind: 'forward' }, '正在前进…'); } });
  if (compactChrome && hasBrowser && !takenOver) menu.push({ key: 'tabs', label: `标签页 ${session.tabs.length}`, icon: 'Layers', onPress: () => setSheet('tabs') });
  if (takenOver) {
    menu.push({ key: 'match', label: '匹配窗口', icon: 'Scan', tone: 'teal', disabled: !manual, onPress: () => { void matchWindow(); } });
    menu.push({ key: 'fit', label: '完整宽度', icon: 'Columns2', tone: 'teal', disabled: !manual, onPress: () => { void perform({ kind: 'fitWidth' }, '正在适应页面宽度…'); } });
  }
  if (hasBrowser) menu.push({ key: 'view', label: '画面', icon: 'SlidersHorizontal', tone: 'cyan', hint: viewHint, onPress: () => setSheet('view') });
  if (pageUrl) {
    menu.push({ key: 'device', label: '用本机浏览器打开', icon: 'ArrowUpRight', tone: 'blue', hint: '同一网址，不共享服务器浏览器的登录状态', onPress: () => { void openOnDevice(pageUrl); } });
    if (navigation?.openBrowser) menu.push({ key: 'paseo', label: '在 Paseo 本机浏览器打开', icon: 'AppWindow', tone: 'blue', onPress: () => { try { navigation.openBrowser!({ url: pageUrl, workspaceId, serverId: host.id }); } catch (failure) { setError(errorMessage(failure)); } } });
  }
  if (session?.agentId) { if (compactChrome && navigation) menu.push({ key: 'agent', label: '打开关联 Agent', icon: 'Bot', tone: controlLooks.agent.hue, hint: `${linked?.title || '关联 Agent'} · ${agentStatus(linked)}`, disabled: openingAgent, onPress: () => { void openConnectedAgent(); } }); }
  else if (hasBrowser) menu.push({ key: 'agent', label: '连接浏览器 Agent', icon: 'BotMessageSquare', tone: controlLooks.agent.hue, disabled: !running, onPress: () => setSheet('agent') });
  if (hasBrowser) {
    menu.push({ key: 'reading', label: '阅读页面', icon: 'BookOpenText', tone: 'indigo', disabled: !running, onPress: () => setSheet('reading') });
    menu.push({ key: 'diagnostics', label: '页面诊断', icon: 'Stethoscope', tone: 'green', onPress: () => setSheet('diagnostics') });
  }
  menu.push({ key: 'activity', label: '操作记录', icon: 'History', tone: 'pink', onPress: () => setSheet('activity') });
  menu.push({ key: 'resources', label: '资源与恢复', icon: 'HardDrive', tone: 'gray', onPress: () => setSheet('resources') });
  if (takenOver) {
    menu.push({ key: 'demo', label: '打开演示页', icon: 'FlaskConical', disabled: !manual, onPress: () => { void perform({ kind: 'demo' }, '正在打开演示页…'); } });
    if (activeTab) menu.push({ key: 'close-tab', label: '关闭当前标签页', icon: 'X', disabled: !manual || activeTab.pinned, hint: activeTab.pinned ? '已固定，先在标签页中取消固定' : undefined, onPress: () => { void perform({ kind: 'closeTab', tabId: activeTab.id }, '正在关闭标签页…'); } });
    menu.push({ key: 'stop', label: '关闭浏览器', icon: 'Power', tone: 'danger', disabled: !manual, onPress: () => setSheet('stop') });
  }

  const modeSwitch = hasBrowser ? <ModeSwitch theme={theme} compact={compactChrome} mode={session.mode} disabled={!running || !!busy} onChange={setMode} /> : null;
  const size = compactChrome ? 'md' : 'sm';
  const back = <IconButton theme={theme} icon="ArrowLeft" label="后退" size={size} disabled={!manual} testID="server-browser-back" onPress={() => { void perform({ kind: 'back' }, '正在后退…'); }} />;
  const reload = <IconButton theme={theme} icon="RotateCw" label="刷新网页" size={size} disabled={!manual} testID="server-browser-reload" onPress={() => { void perform({ kind: 'reload' }, '正在刷新…'); }} />;
  const addressField = <AddressField theme={theme} value={address} onChangeText={setAddress} onSubmit={navigate} editable={!!manual} busy={!!busy} compact={compactChrome} onFocusChange={(focused) => { addressFocused.current = focused; }} />;
  const tabsButton = hasBrowser ? <TabCountButton theme={theme} size={size} count={session.tabs.length} onPress={() => setSheet('tabs')} /> : null;
  const keyboardButton = hasBrowser && session.mode === 'manual' ? <IconButton theme={theme} icon="Keyboard" label="网页键盘输入" size={size} active={inputOpen} disabled={!canControl} testID="server-browser-keyboard" onPress={() => setInputOpen((open) => !open)} /> : null;
  const moreButton = <IconButton theme={theme} icon="Ellipsis" label="更多操作" size={size} testID="server-browser-menu" onPress={() => setSheet('menu')} />;

  const permission = linked?.needsPermission ? `permission:${linked.id}` : null;
  const login = session?.health?.state === 'login_required' && agentControlled ? `login:${session.url}` : null;
  const banner = error ? <Banner theme={theme} tone="danger" message={error} onDismiss={() => setError(null)} />
    : permission && dismissed !== permission ? <Banner theme={theme} tone="warning" icon="Hand" message={`${linked?.title || 'Agent'} 正在等待审批`} action={navigation ? { label: '打开 Agent', onPress: () => { void openConnectedAgent(); } } : undefined} onDismiss={() => setDismissed(permission)} />
    : login && dismissed !== login ? <Banner theme={theme} tone="orange" icon="LogIn" message="页面疑似需要登录" action={{ label: '手动接管', onPress: () => setMode('manual') }} onDismiss={() => setDismissed(login)} />
    : null;

  const shown = frame && !recovering && !frameError ? frame : null;
  const ghost = !shown && placeholder && !recovering && !frameError && (!session || running) ? placeholder : null;
  const ghostGeometry = ghost ? computeViewportLayout({ containerWidth: stageSize.width, containerHeight: stageSize.height, frameWidth: ghost.width, frameHeight: ghost.height }) : null;
  let stageState: ReactNode = null;
  if (!shown && !ghost) {
    if (recovering) stageState = <StageMessage theme={theme} busy tone="warning" icon="RefreshCw" title="正在恢复浏览器…" />;
    else if (frameError && running) stageState = <StageMessage theme={theme} tone="danger" icon="WifiOff" title="画面连接中断" message={frameError} action={{ label: '重新连接', icon: 'RefreshCw', tone: 'info', testID: 'server-browser-frame-retry', onPress: () => { void refreshFrame(); } }} />;
    else if (!session) stageState = <StageMessage theme={theme} busy tone="info" icon="Globe" title="正在连接浏览器…" />;
    else if (running) stageState = <StageMessage theme={theme} busy tone="info" icon="Globe" title="正在获取画面…" />;
    else stageState = <StageMessage theme={theme} tone={session.status === 'starting' ? 'info' : 'gray'} icon="Globe" title={session.status === 'starting' ? '浏览器正在启动' : '浏览器未启动'} message={`${workspace.projectTitle ? `${workspace.projectTitle} / ` : ''}${workspaceTitle}`}
      action={{ label: busy || '启动浏览器', icon: busy ? undefined : 'Play', primary: true, busy: !!busy, disabled: !!busy || stateMutation.isPending, testID: 'server-browser-start', onPress: () => { void startBrowser(); } }} />;
  }

  const identity = <Pressable testID="server-browser-workspace-picker" accessibilityRole="button" accessibilityLabel={`所有浏览器，当前 ${selectedAgentTab?.accessibilityLabel || workspaceTitle}`} onPress={onOpenOverview} hitSlop={{ top: 4, bottom: 4 }}
    style={(state) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 40, paddingRight: space.xs, borderRadius: radius.md, opacity: state.pressed ? 0.7 : 1 })}>
    <Icon name="ChevronLeft" size={18} color={colors.foregroundMuted} />
    <ProjectMark theme={theme} name={projectIdentity} size={22} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
        <Text testID="server-browser-identity-workspace" numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: '500' }}>{selectedAgentTab?.title || '手动浏览'}</Text>
        {glyph ? <StateGlyph theme={theme} look={glyph} size={14} /> : null}
      </View>
      <MetaLine theme={theme} parts={[workspace.projectTitle || workspaceTitle, session && hasBrowser ? pageHost(session.url) : workspaceTitle]} />
    </View>
  </Pressable>;

  return <KeyboardAvoidingView testID="server-browser-screen" behavior={layout.platform === 'ios' ? 'padding' : undefined} style={{ flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: colors.surface0 }}>
    <View testID="server-browser-toolbar" style={{ backgroundColor: colors.surface0, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
      {compactChrome ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 48, paddingLeft: space.xs + 2, paddingRight: space.sm }}>
        {identity}
        {modeSwitch}
        {moreButton}
      </View> : <>
        <View testID="server-browser-agent-toolbar" style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 40, paddingHorizontal: space.sm }}>
          <IconButton theme={theme} icon="LayoutGrid" label="所有浏览器" size="sm" testID="server-browser-workspace-picker" onPress={onOpenOverview} />
          <BrowserAgentTabs theme={theme} groups={tabGroups} selectedWorkspaceId={workspaceId} onSelect={onSelectWorkspace} />
          <IconButton theme={theme} icon="Plus" label="打开其他工作区的浏览器" size="sm" testID="server-browser-workspace-add" onPress={onPickWorkspace} />
          {!!session?.agentId && !!navigation && <Button theme={theme} label="打开 Agent" icon="Bot" size="sm" variant="ghost" tone={controlLooks.agent.hue} busy={openingAgent} accessibilityLabel={`打开关联 Agent：${linked?.title || '关联 Agent'}，${agentStatus(linked)}`} testID="server-browser-identity-open-agent" onPress={() => { void openConnectedAgent(); }} />}
        </View>
        <View testID="server-browser-nav" style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 40, paddingHorizontal: space.sm, borderTopWidth: hairline, borderTopColor: colors.border }}>
          {back}
          <IconButton theme={theme} icon="ArrowRight" label="前进" size="sm" disabled={!manual} testID="server-browser-forward" onPress={() => { void perform({ kind: 'forward' }, '正在前进…'); }} />
          {reload}
          <View style={{ width: space.xs }} />
          {addressField}
          {tabsButton}
          {keyboardButton}
          {modeSwitch}
          {moreButton}
        </View>
      </>}
    </View>

    <View testID="server-browser-stage" onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setStageHidden(width <= 0 || height <= 0); setStageSize((current) => current.width === width && current.height === height ? current : { width, height }); }}
      {...panResponder.panHandlers} style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative', backgroundColor: colors.surface1 }}>
      {/* The page edge shows who drives it: violet while the Agent is in control, amber while you are. */}
      {shown ? <View pointerEvents="none" style={{ position: 'absolute', left: geometry.offsetX - 2, top: geometry.offsetY - 2, width: geometry.imageWidth + 4, height: geometry.imageHeight + 4, borderWidth: 2, borderColor: withAlpha(hue(theme, controlLooks[session?.mode === 'manual' ? 'manual' : 'agent'].hue), 0.6) }} /> : null}
      {shown ? <Pressable ref={setFrameNode} testID="server-browser-frame" accessibilityRole="imagebutton" accessibilityLabel={agentControlled ? '网页画面，Agent 控制中' : '网页画面，点击后可输入，滑动可滚动'} focusable={canControl} disabled={!canControl && !agentControlled}
        onPressIn={(event) => { suppressFrameClick.current = false; const { locationX, locationY } = event.nativeEvent; pressLocation.current = Number.isFinite(locationX) && Number.isFinite(locationY) ? { x: locationX, y: locationY } : null; }} onPress={pressFrame}
        style={{ position: 'absolute', inset: 0, ...(agentControlled ? { cursor: 'auto' } : null) }}>
        <View pointerEvents="none" style={{ position: 'absolute', left: geometry.offsetX, top: geometry.offsetY, width: geometry.imageWidth, height: geometry.imageHeight }}>
          <Image testID="server-browser-image" accessibilityLabel="服务器网页" source={{ uri: shown.dataUrl }} resizeMode="contain" style={{ width: '100%', height: '100%' }} onError={() => { setFrameError('画面加载失败'); frameIdRef.current = null; setFrame(null); }} />
        </View>
      </Pressable> : null}
      {ghost && ghostGeometry ? <View pointerEvents="none" style={{ position: 'absolute', left: ghostGeometry.offsetX, top: ghostGeometry.offsetY, width: ghostGeometry.imageWidth, height: ghostGeometry.imageHeight, opacity: 0.45 }}>
        <Image accessibilityLabel="上次的网页画面" source={{ uri: ghost.dataUrl }} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
      </View> : null}
      {stageState}
      {banner ? <View style={{ position: 'absolute', top: space.sm, left: space.sm, right: space.sm, zIndex: 10, borderRadius: radius.md, backgroundColor: colors.surface0 }}>{banner}</View> : null}
      {busy && hasBrowser ? <BusyPill theme={theme} label={busy} tone={busyTone(busy)} /> : ghost ? <BusyPill theme={theme} label="正在获取画面…" tone="info" /> : running && session.mode === 'manual' && session.agentBusy ? <BusyPill theme={theme} label="等待 Agent 结束当前操作…" tone="info" />
        : paused && running ? <BusyPill theme={theme} icon="Pause" label="画面已暂停，点按继续" tone="warning" onPress={() => { setPaused(false); void refreshFrame(); }} /> : null}
    </View>

    {inputOpen && hasBrowser && session.mode === 'manual' ? <InputDock theme={theme} text={text} onChangeText={setText} enabled={canType} onSend={() => { void sendText(); }} onClose={() => setInputOpen(false)}
      onKey={(key) => enqueueInput({ kind: 'key', key })} onScroll={(direction) => enqueueInput({ kind: 'scroll', deltaX: 0, deltaY: direction * 520 })} /> : null}
    {compactChrome && hasBrowser && session.mode === 'manual' ? <BottomBar theme={theme}>{back}{reload}{addressField}{tabsButton}{keyboardButton}</BottomBar> : null}

    {present('menu') ? <ActionMenu theme={theme} title="更多操作" open={sheet === 'menu'} onClose={() => setSheet(null)} actions={menu} /> : null}
    {session && present('tabs') ? <PageTabsSheet theme={theme} open={sheet === 'tabs'} onClose={() => setSheet(null)} tabs={session.tabs} manual={!!manual} agentMode={session.mode !== 'manual'} maxTabs={session.settings?.maxTabs || 20} agentTabId={agentTabId}
      onSelect={(tabId) => { setSheet(null); if (!session.tabs.find((tab) => tab.id === tabId)?.active) void perform({ kind: 'tab', tabId }, '正在切换标签页…'); }}
      onCloseTab={(tabId) => { void perform({ kind: 'closeTab', tabId }, '正在关闭标签页…'); }} onPin={(tabId, pinned) => { void perform({ kind: 'pin', tabId, pinned }); }}
      onNewTab={() => { setSheet(null); void perform({ kind: 'newTab' }, '正在新建标签页…'); }} /> : null}
    {present('view') ? <ViewSheet theme={theme} open={sheet === 'view'} onClose={() => setSheet(null)} quality={quality} onQuality={selectQuality} manual={!!manual} agentMode={session?.mode !== 'manual'}
      onMatch={() => { void matchWindow(); }} onFitWidth={() => { setSheet(null); void perform({ kind: 'fitWidth' }, '正在适应页面宽度…'); }} onPreset={(preset) => { setSheet(null); void perform({ kind: 'viewport', ...preset }, '正在调整画面尺寸…'); }}
      paused={paused} onTogglePause={() => { setPaused((value) => !value); if (paused) void refreshFrame(); }} onRefresh={() => { void refreshFrame(); }}
      metrics={frameMetrics} viewport={session && hasBrowser ? { width: session.width, height: session.height } : null} scale={geometry.scale} /> : null}
    {present('reading') ? <ReadingSheet theme={theme} open={sheet === 'reading'} onClose={() => setSheet(null)} mode={readingMode} onMode={(mode) => { setReadingMode(mode); setReading(null); }} query={readingQuery} onQuery={setReadingQuery}
      onRun={() => { void extractPage(); }} canRun={running && !busy} busy={busy === '正在读取当前页面…'} reading={reading} error={readingError} /> : null}
    {present('diagnostics') ? <DiagnosticsSheet theme={theme} open={sheet === 'diagnostics'} onClose={() => setSheet(null)} health={session?.health ?? null} checks={pageChecks} onRun={() => { void inspectPage(); }} canRun={running && !busy}
      busy={busy === '正在检查当前页面…'} manual={session?.mode === 'manual'} onTakeOver={() => { setSheet(null); setMode('manual'); }} /> : null}
    {present('activity') ? <ActivitySheet theme={theme} open={sheet === 'activity'} onClose={() => setSheet(null)} session={session} /> : null}
    {present('resources') ? <ResourcesSheet theme={theme} open={sheet === 'resources'} onClose={() => setSheet(null)} session={session} uptimeSeconds={uptimeSeconds} manual={!!manual} agentMode={session?.mode !== 'manual'} failure={session?.runtime?.lastFailure ? errorMessage(session.runtime.lastFailure) : null}
      onAutoRecover={(value) => { void perform({ kind: 'settings', settings: { autoRecover: value } }).then((done) => { if (done) toast.show(value ? '已开启自动恢复' : '已关闭自动恢复'); }); }}
      onCleanup={() => { void perform({ kind: 'cleanup' }, '正在清理过期文件…').then((done) => { if (done) toast.show('已清理过期文件', { variant: 'success' }); }); }} /> : null}
    {present('agent') ? <AgentSheet theme={theme} open={sheet === 'agent'} onClose={() => setSheet(null)} profiles={profiles} profileId={profileId} onProfile={setProfileId} onConnect={() => { void openAgent(); }} canConnect={running && !busy} busy={!!busy && busy.includes('Agent')} /> : null}
    {present('stop') ? <StopSheet theme={theme} open={sheet === 'stop'} onClose={() => setSheet(null)} onConfirm={() => { setSheet(null); void perform({ kind: 'stop' }, '正在关闭浏览器…').then((done) => { if (done) toast.show('已关闭浏览器'); }); }} /> : null}
  </KeyboardAvoidingView>;
}
