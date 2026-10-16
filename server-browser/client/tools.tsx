import { t } from '../shared/text';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, Modal } from '@getpaseo/plugin/client/react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { BrowserOrphan, BrowserFrameQuality, BrowserProfile, BrowserReading, BrowserService, BrowserSession, BrowserWorkspace } from '../shared/browser';
import { controlLooks, projectColorIdentity } from './agent-tabs-model';
import { Badge, Banner, Button, IconButton, MetaLine, ProjectMark, Row, SearchField, Segmented, Sheet, StatusDot, TextField, aria, compactNumber, fontSize, formatDuration, hairline, hue, radius, relativeTime, space, toneColor, type Tone } from './kit';
import { Breathe, Ping } from './motion';
import { StateGlyph } from './looks';
import { BrowserActivityList } from './overview';
import { AgentPortSection, type AgentPortsView } from './agent-ports';
import { pageHost, readable, type Look } from './overview-model';

type Theme = PluginSurfaceProps['theme'];
type Interaction = { pressed: boolean; hovered?: boolean };
type PageCheck = { name: string; status: 'ok' | 'warning' | 'error'; detail: string };
export type FrameMetrics = { latency: number; interval: number | null; kilobytes: number | null; scale: number | null; degraded: boolean };

/** Sheet for row lists: rows keep the kit's own 12 px inset instead of the form sheet's 16 px padding. */
function ListSheet({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  return <Modal title={title} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.xxs }}>{children}</Modal.Content>
  </Modal>;
}
/** A sheet section label in its category colour, like the kit's SectionHeader. */
function Label({ theme, icon, tone, children }: { theme: Theme; icon: string; tone: Tone; children: string }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
    <Icon name={icon} size={13} color={toneColor(theme, tone, 'mark')} />
    <Text style={{ color: toneColor(theme, tone), fontSize: fontSize.meta, fontWeight: '600' }}>{children}</Text>
  </View>;
}
function Group({ theme, label, icon, tone, children }: { theme: Theme; label: string; icon: string; tone: Tone; children: ReactNode }) {
  return <View style={{ gap: space.sm }}><Label theme={theme} icon={icon} tone={tone}>{label}</Label>{children}</View>;
}
const agentAtWork: Look = { get label() { return t("browserTools.agentIsWorking"); }, tone: 'info', icon: 'LoaderCircle', motion: 'spin' };
const wrap = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm } as const;

/**
 * `manual`: controls usable right now; `agentMode`: the Agent holds control (explains why they are not). `services`: this
 * workspace's own, opened in a new tab; `ports`: ports its Agents opened, likewise.
 */
export function PageTabsSheet({ theme, open, onClose, tabs, manual, agentMode, maxTabs, agentTabId, onSelect, onCloseTab, onPin, onNewTab, services, ports }: {
  theme: Theme; open: boolean; onClose: () => void; tabs: BrowserSession['tabs']; manual: boolean; agentMode: boolean; maxTabs: number; agentTabId?: string | null;
  onSelect: (tabId: string) => void; onCloseTab: (tabId: string) => void; onPin: (tabId: string, pinned: boolean) => void; onNewTab: () => void;
  services?: { items: BrowserService[]; loading: boolean; error: string | null; onOpen: (service: BrowserService) => void };
  ports?: AgentPortsView;
}) {
  const { colors } = theme;
  return <ListSheet title={t("browserTools.tabs", { value1: tabs.length })} open={open} onClose={onClose}>
    {tabs.map((tab) => <View key={tab.id} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, backgroundColor: tab.active ? colors.surface2 : 'transparent' }}>
      <Pressable testID={`server-browser-tab-${tab.id}`} accessibilityRole="tab" accessibilityLabel={t("browserTools.tabLabel", { title: tab.title || t("browserTools.newTab") })} accessibilityState={{ selected: tab.active, disabled: !manual }} aria-selected={tab.active} aria-disabled={!manual}
      disabled={!manual} onPress={() => onSelect(tab.id)}
      style={(state) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingLeft: space.md, paddingRight: space.xs, borderRadius: radius.md, backgroundColor: (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent' })}>
      <View style={{ width: 16, alignItems: 'center' }}>{agentTabId === tab.id ? <StateGlyph theme={theme} look={agentAtWork} size={14} /> : <Icon name={tab.pinned ? 'Pin' : 'Globe'} size={14} color={tab.pinned ? hue(theme, 'teal') : tab.active ? toneColor(theme, 'info', 'mark') : colors.foregroundMuted} />}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: tab.active ? '500' : '400' }}>{tab.title || t("browserTools.newTab")}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
          {agentTabId === tab.id ? <Text style={{ color: toneColor(theme, 'info'), fontSize: fontSize.meta, fontWeight: '500' }}>{t("browserTools.agentIsWorking")}</Text> : null}
          {tab.pinned ? <Text style={{ color: hue(theme, 'teal', 'text'), fontSize: fontSize.meta, fontWeight: '500' }}>{t("browserTools.pinned")}</Text> : null}
          <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[pageHost(tab.url)]} /></View>
        </View>
      </View>
      </Pressable>
      <IconButton theme={theme} icon={tab.pinned ? 'PinOff' : 'Pin'} label={tab.pinned ? t("browserTools.unpinTab") : t("browserTools.pinTab")} size="sm" disabled={!manual} testID={`server-browser-pin-tab-${tab.id}`} onPress={() => onPin(tab.id, !tab.pinned)} />
      <IconButton theme={theme} icon="X" label={tab.pinned ? t("browserTools.pinnedUnpinBeforeClosing") : t("browserTools.closeTab")} size="sm" disabled={!manual || tab.pinned} testID={`server-browser-close-tab-${tab.id}`} onPress={() => onCloseTab(tab.id)} />
    </View>)}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xs }}>
      <Button theme={theme} label={t("browserTools.newTab2")} icon="Plus" size="sm" disabled={!manual || tabs.length >= maxTabs} testID="server-browser-new-tab" onPress={onNewTab} />
      {agentMode ? <View style={{ flex: 1 }}><MetaLine theme={theme} parts={[t("browserTools.switchToManualControlToSwitchOr")]} numberOfLines={2} /></View> : null}
    </View>
    {services && (services.items.length || services.loading || services.error) ? <View style={{ gap: space.xxs, paddingTop: space.sm, marginTop: space.xs, borderTopWidth: hairline, borderTopColor: colors.border }}>
      <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}><Label theme={theme} icon="Server" tone="green">{t("browserTools.workspaceServices")}</Label></View>
      <ServiceList theme={theme} items={services.items} loading={services.loading} error={services.error} disabled={!manual || tabs.length >= maxTabs} onOpen={services.onOpen} />
    </View> : null}
    {ports ? <AgentPortSection theme={theme} view={ports} divider quietWhenEmpty /> : null}
  </ListSheet>;
}

/**
 * The workspace's own services (paseo.json, type service) on the daemon host: a running one opens in a new tab of the
 * shared browser, which is the only way a phone can see a dev server that listens on the server's localhost.
 */
export function ServiceList({ theme, items, loading, error, disabled, onOpen }: { theme: Theme; items: BrowserService[]; loading: boolean; error: string | null; disabled: boolean; onOpen: (service: BrowserService) => void }) {
  const { colors } = theme;
  if (error) return <View style={{ paddingHorizontal: space.sm }}><Banner theme={theme} tone="danger" message={error} /></View>;
  if (!items.length) return <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}><MetaLine theme={theme} numberOfLines={3} parts={[loading ? t("browserTools.loadingServices") : t("browserTools.thisWorkspaceHasNoServicesSetA")]} /></View>;
  return <>{items.map((service) => {
    const open = service.running && !!service.url && !disabled;
    const tone: Tone = !service.running ? 'gray' : service.health === 'unhealthy' ? 'warning' : 'success';
    const state = !service.running ? t("browserTools.notRunning") : service.health === 'unhealthy' ? t("browserTools.unresponsive") : service.health === 'healthy' ? t("browserTools.running") : t("browserTools.started");
    return <Pressable key={service.name} testID={`server-browser-service-${service.name}`} accessibilityRole="button" accessibilityLabel={t("browserTools.openService", { value1: service.name, value2: state })} disabled={!open} {...aria({ disabled: !open })} onPress={() => onOpen(service)}
      style={(press) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.md, opacity: service.running ? 1 : 0.55, backgroundColor: open && ((press as Interaction).hovered || press.pressed) ? colors.surface1 : 'transparent' })}>
      <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
        {service.running ? <Ping size={8} color={toneColor(theme, tone, 'mark')} active={service.health !== 'unhealthy'} /> : null}
        <StatusDot theme={theme} tone={tone} size={8} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: '500', flexShrink: 1 }}>{service.name}</Text>
        <MetaLine theme={theme} parts={[service.port ? t("browserTools.port", { value1: service.port }) : null, state]} />
      </View>
      {open ? <Icon name="ArrowUpRight" size={15} color={toneColor(theme, 'success', 'mark')} /> : null}
    </Pressable>;
  })}</>;
}

/** The workspace's services and, under them, the ports its Agents opened (when the daemon host can list them). */
export function ServicesSheet({ theme, open, onClose, items, loading, error, manual, agentMode, onOpen, onRefresh, ports }: {
  theme: Theme; open: boolean; onClose: () => void; items: BrowserService[]; loading: boolean; error: string | null; manual: boolean; agentMode: boolean; onOpen: (service: BrowserService) => void; onRefresh: () => void;
  ports?: AgentPortsView;
}) {
  return <ListSheet title={t("agentPorts.menuLabel")} open={open} onClose={onClose}>
    <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}><Label theme={theme} icon="Server" tone="green">{t("browserTools.workspaceServices")}</Label></View>
    <ServiceList theme={theme} items={items} loading={loading} error={error} disabled={!manual} onOpen={onOpen} />
    {ports ? <AgentPortSection theme={theme} view={ports} divider /> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xs }}>
      <Button theme={theme} label={t("browserTools.refresh")} icon="RefreshCw" size="sm" busy={loading} testID="server-browser-services-refresh" onPress={onRefresh} />
      <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} numberOfLines={2} parts={[agentMode ? t("browserTools.switchToManualControlToOpen") : t("browserTools.opensInANewTabAtA")]} /></View>
    </View>
  </ListSheet>;
}

export type TakeoverAction = { kind: 'back' | 'forward' | 'reload' } | { kind: 'navigate'; url: string };
const takeoverMessages = {
  back: { title: "browserTakeover.backTitle", description: "browserTakeover.backDescription", stale: "browserTakeover.backStale", confirm: "browserTakeover.backConfirm" },
  forward: { title: "browserTakeover.forwardTitle", description: "browserTakeover.forwardDescription", stale: "browserTakeover.forwardStale", confirm: "browserTakeover.forwardConfirm" },
  reload: { title: "browserTakeover.reloadTitle", description: "browserTakeover.reloadDescription", stale: "browserTakeover.reloadStale", confirm: "browserTakeover.reloadConfirm" },
  navigate: { title: "browserTakeover.navigateTitle", description: "browserTakeover.navigateDescription", stale: "browserTakeover.navigateStale", confirm: "browserTakeover.navigateConfirm" },
} as const;
/**
 * From Agent mode, one navigation in two steps the viewer can see: Agent violet → your amber. The address field never takes
 * focus while the sheet slides in; `editable` asks for the address here (phones have no address bar in Agent mode).
 */
/** stale: the page shown when the sheet opened has changed (another document or tab); the confirmation no longer applies. */
export function TakeoverSheet({ theme, open, onClose, request, editable = false, stale = false, busy, onConfirm }: {
  theme: Theme; open: boolean; onClose: () => void; request: TakeoverAction; editable?: boolean; stale?: boolean; busy: boolean; onConfirm: (then: TakeoverAction) => void;
}) {
  const { colors } = theme, agentHue = controlLooks.agent.hue, manualHue = controlLooks.manual.hue, messages = takeoverMessages[request.kind];
  const [url, setUrl] = useState(request.kind === 'navigate' ? request.url : '');
  useEffect(() => { setUrl(request.kind === 'navigate' ? request.url : ''); }, [request]);
  const mark = (name: string, tint: typeof agentHue | typeof manualHue) => <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: hue(theme, tint, 'soft'), borderWidth: hairline, borderColor: hue(theme, tint, 'line') }}><Icon name={name} size={18} color={hue(theme, tint)} /></View>;
  return <Sheet title={t(messages.title)} open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {mark(controlLooks.agent.icon, agentHue)}
      <Breathe><Icon name="ArrowRight" size={16} color={colors.foregroundMuted} /></Breathe>
      {mark(controlLooks.manual.icon, manualHue)}
      <Text style={{ flex: 1, flexShrink: 1, minWidth: 0, color: colors.foreground, fontSize: fontSize.body, lineHeight: 21 }}>{t(messages.description)}</Text>
    </View>
    {request.kind === 'navigate' && editable ? <TextField theme={theme} label={t("browserTools.url")} value={url} onChangeText={setUrl} placeholder={t("browserTools.enterAUrl")} /> : request.kind === 'navigate' ? <MetaLine theme={theme} numberOfLines={2} parts={[request.url]} /> : null}
    {stale ? <Banner theme={theme} tone="danger" icon="TriangleAlert" message={t(messages.stale)} />
      : <MetaLine theme={theme} numberOfLines={3} parts={[t("browserTools.ifTheAgentChangesPagesMeanwhileOnly")]} />}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
      <Button theme={theme} label={stale ? t("browserTools.close") : t("browserTools.cancel")} variant="ghost" onPress={onClose} />
      <Button theme={theme} label={t(messages.confirm)} icon={controlLooks.manual.icon} tone={manualHue} busy={busy} disabled={stale || (request.kind === 'navigate' && !url.trim())} testID="server-browser-takeover-confirm"
        onPress={() => onConfirm(request.kind === 'navigate' ? { kind: 'navigate', url: url.trim() } : request)} />
    </View>
  </Sheet>;
}

const qualities: readonly { value: BrowserFrameQuality; label: string; icon: string; tone: Tone }[] = [{ value: 'smooth', get label() { return t("browserTools.smooth"); }, icon: 'Zap', tone: 'cyan' }, { value: 'balanced', get label() { return t("browserTools.balanced"); }, icon: 'Scale', tone: 'cyan' }, { value: 'sharp', get label() { return t("browserTools.sharp"); }, icon: 'Sparkles', tone: 'cyan' }];
export function qualityLabel(value: BrowserFrameQuality): string { return qualities.find((item) => item.value === value)?.label ?? value; }
export function ViewSheet({ theme, open, onClose, quality, onQuality, manual, agentMode, onMatch, onFitWidth, onPreset, paused, onTogglePause, onRefresh, metrics, viewport, scale, devicePreset, viewerCount }: {
  theme: Theme; open: boolean; onClose: () => void; quality: BrowserFrameQuality; onQuality: (value: BrowserFrameQuality) => void; manual: boolean; agentMode: boolean;
  onMatch: () => void; onFitWidth: () => void; onPreset: (preset: 'desktop' | 'iphone' | 'pixel' | 'ipad') => void; paused: boolean; onTogglePause: () => void; onRefresh: () => void;
  devicePreset?: string; viewerCount?: number; metrics: FrameMetrics | null; viewport: { width: number; height: number } | null; scale: number;
}) {
  return <Sheet title={t("browserTools.view")} open={open} onClose={onClose}>
    <Group theme={theme} label={t("browserTools.quality")} icon="Gauge" tone="cyan"><Segmented theme={theme} value={quality} options={qualities} onChange={onQuality} accessibilityLabel={t("browserTools.quality")} /></Group>
    <Group theme={theme} label={t("browserTools.pageSize")} icon="Scan" tone="teal">
      <View style={wrap}>
        <Button theme={theme} label={t("browserTools.matchWindow")} icon="Scan" size="sm" disabled={!manual} testID="server-browser-viewport-match" onPress={onMatch} />
        <Button theme={theme} label={t("browserTools.fullWidth")} icon="Columns2" size="sm" disabled={!manual} testID="server-browser-fit-width" onPress={onFitWidth} />
      </View>
      {agentMode ? <MetaLine theme={theme} parts={[t("browserTools.switchToManualControlToAdjust")]} /> : null}
    </Group>
    <Group theme={theme} label={t("browserTools.deviceEmulation")} icon="MonitorSmartphone" tone="violet">
      <View style={wrap}>
        <Button theme={theme} label={t("browserTools.iphone15Pro")} icon="Smartphone" size="sm" disabled={!manual} testID="server-browser-viewport-phone" onPress={() => onPreset('iphone')} />
        <Button theme={theme} label={t("browserTools.desktopChrome")} icon="Monitor" size="sm" disabled={!manual} testID="server-browser-viewport-desktop" onPress={() => onPreset('desktop')} />
        <Button theme={theme} label={t("browserTools.pixel7")} icon="Smartphone" size="sm" disabled={!manual} testID="server-browser-device-pixel" onPress={() => onPreset('pixel')} />
        <Button theme={theme} label={t("browserTools.ipadPro11")} icon="Tablet" size="sm" disabled={!manual} testID="server-browser-device-ipad" onPress={() => onPreset('ipad')} />
      </View>
      <MetaLine theme={theme} numberOfLines={3} parts={[viewport ? t("browserTools.formatted", { value1: viewport.width, value2: viewport.height }) : null, devicePreset === 'iphone' ? t("browserTools.iphoneDpr3Touch") : devicePreset === 'pixel' ? t("browserTools.pixelDpr2625Touch") : devicePreset === 'ipad' ? t("browserTools.ipadDpr2Touch") : devicePreset === 'desktop' ? t("browserTools.desktopDpr1Mouse") : t("browserTools.customSize"), t("browserTools.presetsSetSizePixelRatioTouchAnd")]} />
      <Badge theme={theme} tone="info" icon="Users" label={t("browserTools.clientsWatching", { count: viewerCount ?? 0 })} />
    </Group>
    <Group theme={theme} label={t("browserTools.transfer")} icon="ArrowDownUp" tone="blue">
      <View testID="server-browser-frame-metrics" style={{ gap: space.xs }}>
        <MetaLine theme={theme} numberOfLines={2} parts={[viewport ? t("browserTools.page", { value1: viewport.width, value2: viewport.height }) : null, scale > 0 ? t("browserTools.display", { value1: Math.round(scale * 100) }) : null, metrics ? t("browserTools.requestMs", { value1: metrics.latency }) : t("browserTools.measuring"), metrics?.interval ? t("browserTools.intervalSeconds", { value1: (metrics.interval / 1000).toFixed(1) }) : null, metrics ? (metrics.kilobytes !== null ? t("browserTools.aboutKb", { value1: compactNumber(metrics.kilobytes) }) : t("browserTools.viewUnchanged")) : null]} />
        {metrics?.degraded ? <Badge theme={theme} tone="warning" icon="Gauge" label={t("browserTools.slowNetworkQualityTemporarilyReduced")} /> : null}
      </View>
      <View style={wrap}>
        <Button theme={theme} label={paused ? t("browserTools.resumeView") : t("browserTools.pauseView")} icon={paused ? 'Play' : 'Pause'} size="sm" tone={paused ? 'success' : undefined} testID="server-browser-pause" onPress={onTogglePause} />
        <Button theme={theme} label={t("browserTools.refreshView")} icon="RefreshCw" size="sm" testID="server-browser-refresh-frame" onPress={onRefresh} />
      </View>
    </Group>
  </Sheet>;
}

export function ReadingSheet({ theme, open, onClose, mode, onMode, query, onQuery, onRun, canRun, busy, reading, error }: {
  theme: Theme; open: boolean; onClose: () => void; mode: 'article' | 'visible'; onMode: (mode: 'article' | 'visible') => void; query: string; onQuery: (value: string) => void;
  onRun: () => void; canRun: boolean; busy: boolean; reading: BrowserReading | null; error: string | null;
}) {
  const { colors } = theme;
  return <Sheet title={t("browserTools.readPage")} open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
      <Segmented theme={theme} value={mode} onChange={onMode} accessibilityLabel={t("browserTools.readingScope")} options={[{ value: 'article', get label() { return t("browserTools.article"); }, icon: 'FileText', tone: 'indigo' }, { value: 'visible', get label() { return t("browserTools.visibleContent"); }, icon: 'Eye', tone: 'indigo' }]} />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <SearchField theme={theme} value={query} onChangeText={onQuery} onSubmit={onRun} placeholder={t("browserTools.keywordsOptional")} accessibilityLabel={t("browserTools.searchPageKeywords")} />
      <Button theme={theme} label={query.trim() ? t("browserTools.search") : t("browserTools.read")} variant="primary" busy={busy} disabled={!canRun} testID="server-browser-reading-run" onPress={onRun} />
    </View>
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    {reading ? <View style={{ gap: space.sm, paddingTop: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text numberOfLines={2} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.title, fontWeight: '500' }}>{reading.title || t("browserTools.currentPage")}</Text>
        {reading.truncated ? <View testID="server-browser-reading-truncated"><Badge theme={theme} tone="info" icon="Scissors" label={t("browserTools.first16000CharactersShown")} /></View> : null}
      </View>
      <Text testID="server-browser-reading-result" selectable style={{ color: colors.foreground, fontSize: fontSize.content, lineHeight: 24 }}>{readable(reading.content) || t("browserTools.noMatchingContent")}</Text>
    </View> : null}
  </Sheet>;
}

const checkLooks: Record<PageCheck['status'], Look> = { ok: { get label() { return t("browserTools.ok"); }, tone: 'success', icon: 'CircleCheck' }, warning: { get label() { return t("browserTools.warning"); }, tone: 'warning', icon: 'TriangleAlert' }, error: { get label() { return t("browserTools.error"); }, tone: 'danger', icon: 'CircleX' } };
const healthLooks: Record<'accessible' | 'network_error' | 'unknown', Look> = { accessible: checkLooks.ok, network_error: checkLooks.error, unknown: { get label() { return t("browserTools.unknown"); }, tone: 'gray', icon: 'CircleHelp' } };
export function DiagnosticsSheet({ theme, open, onClose, health, checks, onRun, canRun, busy, manual, onTakeOver }: {
  theme: Theme; open: boolean; onClose: () => void; health: BrowserSession['health']; checks: PageCheck[] | null; onRun: () => void; canRun: boolean; busy: boolean; manual: boolean; onTakeOver: () => void;
}) {
  const { colors } = theme;
  return <Sheet title={t("browserTools.pageDiagnostics")} open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row' }}><Button theme={theme} label={t("browserTools.checkCurrentPage")} icon="Stethoscope" variant="primary" busy={busy} disabled={!canRun} testID="server-browser-diagnostics-run" onPress={onRun} /></View>
    {health ? <View testID="server-browser-diagnostics-result" style={{ gap: space.sm }}>
      {health.state === 'login_required' ? <Banner theme={theme} tone="orange" icon="LogIn" message={t("browserTools.logInOnThePageThenHand", { value1: health.summary })} action={manual ? undefined : { get label() { return t("browserTools.takeManualControl"); }, onPress: onTakeOver }} />
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <StateGlyph theme={theme} look={healthLooks[health.state]} size={16} />
          <Text style={{ flex: 1, color: health.state === 'network_error' ? toneColor(theme, 'danger') : colors.foreground, fontSize: fontSize.body, fontWeight: '500' }}>{health.summary}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(health.checkedAt)}</Text>
        </View>}
      {health.state === 'accessible' ? <MetaLine theme={theme} parts={[t("browserTools.thePageIsAccessibleButMayNot")]} /> : null}
    </View> : null}
    {checks?.length ? <View style={{ borderTopWidth: hairline, borderTopColor: colors.border, paddingTop: space.xs }}>
      <View style={{ marginHorizontal: -space.md }}>
        {checks.map((check, index) => <Row key={index} theme={theme} title={check.name} titleLines={1} leading={<StateGlyph theme={theme} look={checkLooks[check.status]} size={16} />} trailing={check.status === 'ok' ? undefined : <Badge theme={theme} tone={checkLooks[check.status].tone} label={checkLooks[check.status].label} />} subtitle={<MetaLine theme={theme} numberOfLines={3} parts={[check.detail]} />} />)}
      </View>
    </View> : null}
  </Sheet>;
}

export function ActivitySheet({ theme, open, onClose, session }: { theme: Theme; open: boolean; onClose: () => void; session: BrowserSession | null }) {
  return <ListSheet title={t("browserTools.activity")} open={open} onClose={onClose}><BrowserActivityList theme={theme} session={session} /></ListSheet>;
}

function Fact({ theme, label, value, icon, tone }: { theme: Theme; label: string; value: string; icon: string; tone: Tone }) {
  const { colors } = theme;
  return <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: 6 }}>
    <View style={{ height: 19, justifyContent: 'center' }}><Icon name={icon} size={14} color={toneColor(theme, tone, 'mark')} /></View>
    <Text style={{ width: 64, color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{label}</Text>
    <Text selectable style={{ flex: 1, color: tone === 'danger' ? toneColor(theme, 'danger') : colors.foreground, fontSize: fontSize.small, lineHeight: 19 }}>{value}</Text>
  </View>;
}
/** React Native Web paints the "on" state with its own teal unless given these web-only props; native ignores them. */
const webSwitchColors = (track: string, thumb: string) => ({ activeTrackColor: track, activeThumbColor: thumb }) as object;
export function ResourcesSheet({ theme, open, onClose, session, uptimeSeconds, manual, agentMode, onAutoRecover, onCleanup, failure }: {
  theme: Theme; open: boolean; onClose: () => void; session: BrowserSession | null; uptimeSeconds: number; manual: boolean; agentMode: boolean; onAutoRecover: (value: boolean) => void; onCleanup: () => void; failure: string | null;
}) {
  const { colors } = theme, runtime = session?.runtime, settings = session?.settings;
  return <Sheet title={t("browserTools.resourcesAndRecovery")} open={open} onClose={onClose}>
    <View testID="server-browser-runtime">
      <Fact theme={theme} label={t("browserTools.uptime")} icon="Timer" tone="blue" value={formatDuration(uptimeSeconds * 1000) || t("browserTools.formatted2")} />
      <Fact theme={theme} label={t("browserTools.automaticRecovery")} icon="LifeBuoy" tone={runtime?.recoveryCount ? 'amber' : 'green'} value={runtime?.lastRecoveredAt ? t("browserTools.recoveryCountWithLast", { count: runtime.recoveryCount || 0, time: relativeTime(runtime.lastRecoveredAt) }) : t("browserTools.recoveryCount", { count: runtime?.recoveryCount || 0 })} />
      <Fact theme={theme} label={t("browserTools.generatedFiles")} icon="Files" tone="indigo" value={t("browserTools.filesMb", { count: runtime?.artifactCount || 0, value2: ((runtime?.artifactBytes || 0) / 1048576).toFixed(1) })} />
      <Fact theme={theme} label={t("browserTools.cleanupPolicy")} icon="CalendarClock" tone="gray" value={t("browserTools.limitMbKeepHours", { value1: settings?.maxArtifactMB ?? t("browserTools.formatted2"), value2: settings?.artifactMaxAgeHours ?? t("browserTools.formatted2") })} />
      {failure ? <Fact theme={theme} label={t("browserTools.lastFailure")} icon="CircleAlert" tone="danger" value={failure} /> : null}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs, borderTopWidth: hairline, borderTopColor: colors.border, paddingTop: space.md }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body }}>{t("browserTools.recoverAutomaticallyIfTheBrowserExitsUnexpectedly")}</Text>
        {agentMode ? <MetaLine theme={theme} parts={[t("browserTools.switchToManualControlToChange")]} /> : null}
      </View>
      <Switch testID="server-browser-auto-recover" accessibilityLabel={t("browserTools.automaticRecovery")} value={!!settings?.autoRecover} disabled={!manual} onValueChange={onAutoRecover}
        trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.accentForeground} {...webSwitchColors(colors.accent, colors.accentForeground)} />
    </View>
    <View style={{ flexDirection: 'row' }}><Button theme={theme} label={t("browserTools.cleanUpExpiredFiles")} icon="Trash2" size="sm" disabled={!manual} testID="server-browser-cleanup" onPress={onCleanup} /></View>
  </Sheet>;
}

export function AgentSheet({ theme, open, onClose, profiles, profileId, onProfile, onConnect, canConnect, busy }: {
  theme: Theme; open: boolean; onClose: () => void; profiles: BrowserProfile[]; profileId: string; onProfile: (id: string) => void; onConnect: () => void; canConnect: boolean; busy: boolean;
}) {
  const { colors } = theme, agentHue = controlLooks.agent.hue;
  return <Sheet title={t("browserTools.connectBrowserAgent")} open={open} onClose={onClose}>
    {profiles.length ? <View style={{ gap: space.xxs, marginHorizontal: -space.sm }}>
      {profiles.map((profile) => {
        const selected = profile.id === profileId;
        return <Pressable key={profile.id} testID={`server-browser-profile-${profile.id}`} accessibilityRole="radio" accessibilityLabel={profile.name} accessibilityState={{ selected, checked: selected }} aria-checked={selected} onPress={() => onProfile(profile.id)}
          style={(state) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: hairline, borderColor: selected ? hue(theme, agentHue, 'line') : 'transparent', backgroundColor: selected ? hue(theme, agentHue, 'soft') : (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent' })}>
          <Icon name={selected ? 'CircleCheck' : 'Circle'} size={16} color={selected ? hue(theme, agentHue) : colors.foregroundMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: selected ? '500' : '400' }}>{profile.name}</Text>
            <MetaLine theme={theme} parts={[profile.provider, profile.model]} />
          </View>
        </Pressable>;
      })}
    </View> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}><Button theme={theme} label={t("browserTools.connect")} icon="Bot" variant="primary" busy={busy} disabled={!canConnect} testID="server-browser-agent-open" onPress={onConnect} /></View>
  </Sheet>;
}

export function StopSheet({ theme, open, onClose, onConfirm }: { theme: Theme; open: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Sheet title={t("browserTools.closeBrowser")} open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: toneColor(theme, 'danger', 'soft') }}><Icon name="Power" size={18} color={toneColor(theme, 'danger', 'mark')} /></View>
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 21, paddingTop: space.xs }}>{t("browserTools.afterClosingTheAgentCannotUseThis")}</Text>
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
      <Button theme={theme} label={t("browserTools.cancel")} variant="ghost" onPress={onClose} />
      <Button theme={theme} label={t("browserTools.closeBrowser")} variant="danger" testID="server-browser-stop-confirm" onPress={onConfirm} />
    </View>
  </Sheet>;
}

/** Any workspace, including ones without a browser yet; choosing one only changes what this viewer shows. */
export function WorkspacePickerSheet({ theme, open, onClose, workspaces, running, selectedId, onSelect }: {
  theme: Theme; open: boolean; onClose: () => void; workspaces: BrowserWorkspace[]; running: ReadonlySet<string>; selectedId: string; onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const choices = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return workspaces.filter((workspace) => !needle || `${workspace.projectTitle || ''} ${workspace.title}`.toLowerCase().includes(needle))
      .sort((left, right) => Number(running.has(right.id)) - Number(running.has(left.id)) || (left.projectTitle || '').localeCompare(right.projectTitle || '') || left.title.localeCompare(right.title));
  }, [workspaces, filter, running]);
  return <ListSheet title={t("browserTools.openWorkspaceBrowser")} open={open} onClose={() => { setFilter(''); onClose(); }}>
    <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs }}><SearchField theme={theme} value={filter} onChangeText={setFilter} placeholder={t("browserTools.searchProjectsOrWorkspaces")} accessibilityLabel={t("browserTools.searchWorkspaces")} /></View>
    {choices.map((workspace) => <Row key={workspace.id} theme={theme} testID={`server-browser-workspace-${workspace.id}`} title={workspace.title} titleLines={1} selected={workspace.id === selectedId}
      accessibilityLabel={t("browserTools.formatted3", { value1: workspace.projectTitle || t("browserTools.untitledProject"), value2: workspace.title })}
      leading={<ProjectMark theme={theme} name={projectColorIdentity(workspace)} size={20} />}
      trailing={workspace.id === selectedId ? <Badge theme={theme} tone="info" icon="Eye" label={t("browserTools.viewing")} /> : running.has(workspace.id) ? <Badge theme={theme} tone="success" icon="Play" label={t("browserTools.started")} /> : undefined}
      subtitle={workspace.projectTitle || t("browserTools.untitledProject")} onPress={() => { setFilter(''); onSelect(workspace.id); }} />)}
    {!choices.length ? <View style={{ padding: space.lg }}><MetaLine theme={theme} parts={[t("browserTools.noMatchingWorkspaces")]} /></View> : null}
  </ListSheet>;
}


export function DialogSheet({ theme, open, onClose, dialog, manual, busy, onTakeOver, onRespond }: {
  theme: Theme; open: boolean; onClose: () => void; dialog: NonNullable<BrowserSession['dialog']>; manual: boolean; busy: boolean;
  onTakeOver: () => void; onRespond: (accept: boolean, promptText?: string) => void;
}) {
  const [value, setValue] = useState(dialog.defaultValue);
  useEffect(() => setValue(dialog.defaultValue), [dialog.id, dialog.defaultValue]);
  return <Sheet title={t("browserTools.pageDialog")} open={open} onClose={onClose}>
    <Banner theme={theme} tone="warning" icon="MessageSquareWarning" message={dialog.type === 'prompt' ? t("browserTools.thePageIsWaitingForInput") : dialog.type === 'confirm' || dialog.type === 'beforeunload' ? t("browserTools.thePageIsWaitingForConfirmation") : t("browserTools.pageAlert")} />
    <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{dialog.message || t("browserTools.thePageProvidedNoMessage")}</Text>
    {dialog.type === 'prompt' ? <TextInput testID="server-browser-dialog-input" accessibilityLabel={t("browserTools.pageDialogInput")} value={value} onChangeText={setValue} editable={manual && !busy} maxLength={10000} placeholder={t("browserTools.enterAResponse")} placeholderTextColor={theme.colors.foregroundMuted} style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: radius.md, padding: space.md, minHeight: 44 }} /> : null}
    {!manual ? <Banner theme={theme} tone="info" message={t("browserTools.theAgentControlsTheBrowserLetIt")} action={{ get label() { return t("browserTools.takeManualControl"); }, onPress: onTakeOver }} /> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
      {dialog.type !== 'alert' ? <Button theme={theme} label={t("browserTools.cancel")} disabled={!manual || busy} testID="server-browser-dialog-cancel" onPress={() => onRespond(false)} /> : null}
      <Button theme={theme} label={t("browserTools.confirm")} variant="primary" disabled={!manual || busy} testID="server-browser-dialog-confirm" onPress={() => onRespond(true, dialog.type === 'prompt' ? value : undefined)} />
    </View>
    <MetaLine theme={theme} numberOfLines={2} parts={[t("browserTools.closingThisPanelDoesNotAnswerThe")]} />
  </Sheet>;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return t("browserTools.gb", { value1: (bytes / 1024 ** 3).toFixed(1) });
  if (bytes >= 1024 ** 2) return t("browserTools.mb", { value1: (bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1) });
  return t("browserTools.kb", { value1: Math.max(1, Math.round(bytes / 1024)) });
}
/**
 * Leftovers of gone workspaces: browsers still running (stop them) and saved Profiles (logins, cookies, cache) that only
 * go away when deleted here. Deleting asks once more in place, naming what is lost; no sheet on top of a sheet.
 */
export function OrphansSheet({ theme, open, onClose, items, loading, error, stopping, deleting, onRefresh, onStop, onDelete }: {
  theme: Theme; open: boolean; onClose: () => void; items: BrowserOrphan[]; loading: boolean; error: string | null; stopping: string | null; deleting: string | null; onRefresh: () => void; onStop: (id: string) => void; onDelete: (id: string) => void;
}) {
  const { colors } = theme;
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => { if (!open) setConfirming(null); }, [open]);
  const running = items.filter((item) => item.kind !== 'profile'), saved = items.filter((item) => item.kind === 'profile');
  const total = saved.reduce((sum, item) => sum + (item.profileBytes ?? 0), 0);
  const name = (item: BrowserOrphan) => <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
    <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: '500', flexShrink: 1 }}>{item.label || t("browserTools.removedWorkspace")}</Text>
    <MetaLine theme={theme} numberOfLines={2} parts={[item.label ? null : item.workspaceId, item.profileBytes ? formatBytes(item.profileBytes) : null, item.lastUsedAt ? t("browserTools.lastUsed", { value1: relativeTime(item.lastUsedAt) }) : null]} />
  </View>;
  return <Sheet title={t("browserTools.orphanedBrowsers")} open={open} onClose={onClose}>
    <MetaLine theme={theme} numberOfLines={3} parts={[t("browserTools.browsersLeftBehindByArchivedOrRemoved")]} />
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    {!items.length && !loading && !error ? <Badge theme={theme} tone="success" icon="CircleCheck" label={t("browserTools.noOrphanedBrowsersOrSavedData")} /> : null}
    {running.length ? <Group theme={theme} label={t("browserTools.stillRunning", { value1: running.length })} icon="Monitor" tone="amber">
      {running.map((item) => <View key={item.workspaceId} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs }}>
        <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}><Ping size={8} color={toneColor(theme, 'warning', 'mark')} /><StatusDot theme={theme} tone="warning" /></View>
        {name(item)}
        <Badge theme={theme} tone="warning" icon="Cpu" label={item.pid ? t("browserTools.process", { value1: item.pid }) : t("browserTools.awaitingCleanup")} />
        <Button theme={theme} label={t("browserTools.stop")} icon="Power" variant="danger" size="sm" busy={stopping === item.workspaceId} disabled={!!stopping || !!deleting} testID={`server-browser-stop-orphan-${item.workspaceId}`} onPress={() => onStop(item.workspaceId)} />
      </View>)}
    </Group> : null}
    {saved.length ? <Group theme={theme} label={t("browserTools.savedBrowserData", { value1: saved.length, value2: formatBytes(total) })} icon="HardDrive" tone="red">
      {saved.map((item) => <View key={item.workspaceId} style={{ gap: space.sm, paddingVertical: space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Icon name="KeyRound" size={14} color={toneColor(theme, 'danger', 'mark')} />
          {name(item)}
          {confirming === item.workspaceId ? null : <Button theme={theme} label={t("browserTools.deleteData")} icon="Trash2" tone="danger" size="sm" disabled={!!deleting || !!stopping} testID={`server-browser-delete-orphan-${item.workspaceId}`} onPress={() => setConfirming(item.workspaceId)} />}
        </View>
        {confirming === item.workspaceId ? <View style={{ gap: space.sm }}>
          <Banner theme={theme} tone="danger" icon="TriangleAlert" message={t("browserTools.thisPermanentlyDeletesTheWorkspaceBrowserS")} />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
            <Button theme={theme} label={t("browserTools.cancel")} variant="ghost" size="sm" onPress={() => setConfirming(null)} />
            <Button theme={theme} label={t("browserTools.confirmDeletion")} icon="Trash2" variant="danger" size="sm" busy={deleting === item.workspaceId} disabled={!!deleting} testID={`server-browser-delete-orphan-confirm-${item.workspaceId}`} onPress={() => onDelete(item.workspaceId)} />
          </View>
        </View> : null}
      </View>)}
    </Group> : null}
    <View style={{ flexDirection: 'row' }}><Button theme={theme} label={t("browserTools.refreshList")} icon="RefreshCw" busy={loading} onPress={onRefresh} /></View>
  </Sheet>;
}
