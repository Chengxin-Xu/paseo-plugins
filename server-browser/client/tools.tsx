import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, Modal } from '@getpaseo/plugin/client/react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { BrowserOrphan, BrowserFrameQuality, BrowserProfile, BrowserReading, BrowserService, BrowserSession, BrowserWorkspace } from '../shared/browser';
import { controlLooks, projectName } from './agent-tabs-model';
import { Badge, Banner, Button, IconButton, MetaLine, ProjectMark, Row, SearchField, Segmented, Sheet, StatusDot, TextField, aria, compactNumber, fontSize, formatDuration, hairline, hue, radius, relativeTime, space, toneColor, type Tone } from './kit';
import { Breathe, Ping } from './motion';
import { StateGlyph } from './looks';
import { BrowserActivityList } from './overview';
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
const agentAtWork: Look = { label: 'Agent 正在操作', tone: 'info', icon: 'LoaderCircle', motion: 'spin' };
const wrap = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm } as const;

/** `manual`: controls usable right now; `agentMode`: the Agent holds control (explains why they are not). `services`: this workspace's own, opened in a new tab. */
export function PageTabsSheet({ theme, open, onClose, tabs, manual, agentMode, maxTabs, agentTabId, onSelect, onCloseTab, onPin, onNewTab, services }: {
  theme: Theme; open: boolean; onClose: () => void; tabs: BrowserSession['tabs']; manual: boolean; agentMode: boolean; maxTabs: number; agentTabId?: string | null;
  onSelect: (tabId: string) => void; onCloseTab: (tabId: string) => void; onPin: (tabId: string, pinned: boolean) => void; onNewTab: () => void;
  services?: { items: BrowserService[]; loading: boolean; error: string | null; onOpen: (service: BrowserService) => void };
}) {
  const { colors } = theme;
  return <ListSheet title={`标签页 ${tabs.length}`} open={open} onClose={onClose}>
    {tabs.map((tab) => <View key={tab.id} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, backgroundColor: tab.active ? colors.surface2 : 'transparent' }}>
      <Pressable testID={`server-browser-tab-${tab.id}`} accessibilityRole="tab" accessibilityLabel={`标签页 ${tab.title || '新标签页'}`} accessibilityState={{ selected: tab.active, disabled: !manual }} aria-selected={tab.active} aria-disabled={!manual}
      disabled={!manual} onPress={() => onSelect(tab.id)}
      style={(state) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingLeft: space.md, paddingRight: space.xs, borderRadius: radius.md, backgroundColor: (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent' })}>
      <View style={{ width: 16, alignItems: 'center' }}>{agentTabId === tab.id ? <StateGlyph theme={theme} look={agentAtWork} size={14} /> : <Icon name={tab.pinned ? 'Pin' : 'Globe'} size={14} color={tab.pinned ? hue(theme, 'teal') : tab.active ? toneColor(theme, 'info', 'mark') : colors.foregroundMuted} />}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: tab.active ? '500' : '400' }}>{tab.title || '新标签页'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
          {agentTabId === tab.id ? <Text style={{ color: toneColor(theme, 'info'), fontSize: fontSize.meta, fontWeight: '500' }}>Agent 正在操作</Text> : null}
          {tab.pinned ? <Text style={{ color: hue(theme, 'teal', 'text'), fontSize: fontSize.meta, fontWeight: '500' }}>已固定</Text> : null}
          <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[pageHost(tab.url)]} /></View>
        </View>
      </View>
      </Pressable>
      <IconButton theme={theme} icon={tab.pinned ? 'PinOff' : 'Pin'} label={tab.pinned ? '取消固定标签页' : '固定标签页'} size="sm" disabled={!manual} testID={`server-browser-pin-tab-${tab.id}`} onPress={() => onPin(tab.id, !tab.pinned)} />
      <IconButton theme={theme} icon="X" label={tab.pinned ? '已固定，先取消固定再关闭' : '关闭标签页'} size="sm" disabled={!manual || tab.pinned} testID={`server-browser-close-tab-${tab.id}`} onPress={() => onCloseTab(tab.id)} />
    </View>)}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xs }}>
      <Button theme={theme} label="新建标签页" icon="Plus" size="sm" disabled={!manual || tabs.length >= maxTabs} testID="server-browser-new-tab" onPress={onNewTab} />
      {agentMode ? <View style={{ flex: 1 }}><MetaLine theme={theme} parts={['切换到手动后可切换或关闭']} numberOfLines={2} /></View> : null}
    </View>
    {services && (services.items.length || services.loading || services.error) ? <View style={{ gap: space.xxs, paddingTop: space.sm, marginTop: space.xs, borderTopWidth: hairline, borderTopColor: colors.border }}>
      <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}><Label theme={theme} icon="Server" tone="green">本工作区服务</Label></View>
      <ServiceList theme={theme} items={services.items} loading={services.loading} error={services.error} disabled={!manual || tabs.length >= maxTabs} onOpen={services.onOpen} />
    </View> : null}
  </ListSheet>;
}

/**
 * The workspace's own services (paseo.json, type service) on the daemon host: a running one opens in a new tab of the
 * shared browser, which is the only way a phone can see a dev server that listens on the server's localhost.
 */
export function ServiceList({ theme, items, loading, error, disabled, onOpen }: { theme: Theme; items: BrowserService[]; loading: boolean; error: string | null; disabled: boolean; onOpen: (service: BrowserService) => void }) {
  const { colors } = theme;
  if (error) return <View style={{ paddingHorizontal: space.sm }}><Banner theme={theme} tone="danger" message={error} /></View>;
  if (!items.length) return <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}><MetaLine theme={theme} numberOfLines={3} parts={[loading ? '正在读取服务…' : '这个工作区没有服务。在 paseo.json 里把脚本设为 service 并启动后，会出现在这里。']} /></View>;
  return <>{items.map((service) => {
    const open = service.running && !!service.url && !disabled;
    const tone: Tone = !service.running ? 'gray' : service.health === 'unhealthy' ? 'warning' : 'success';
    const state = !service.running ? '未运行' : service.health === 'unhealthy' ? '无响应' : service.health === 'healthy' ? '运行中' : '已启动';
    return <Pressable key={service.name} testID={`server-browser-service-${service.name}`} accessibilityRole="button" accessibilityLabel={`打开服务 ${service.name}，${state}`} disabled={!open} {...aria({ disabled: !open })} onPress={() => onOpen(service)}
      style={(press) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.md, opacity: service.running ? 1 : 0.55, backgroundColor: open && ((press as Interaction).hovered || press.pressed) ? colors.surface1 : 'transparent' })}>
      <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
        {service.running ? <Ping size={8} color={toneColor(theme, tone, 'mark')} active={service.health !== 'unhealthy'} /> : null}
        <StatusDot theme={theme} tone={tone} size={8} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: '500', flexShrink: 1 }}>{service.name}</Text>
        <MetaLine theme={theme} parts={[service.port ? `端口 ${service.port}` : null, state]} />
      </View>
      {open ? <Icon name="ArrowUpRight" size={15} color={toneColor(theme, 'success', 'mark')} /> : null}
    </Pressable>;
  })}</>;
}

export function ServicesSheet({ theme, open, onClose, items, loading, error, manual, agentMode, onOpen, onRefresh }: {
  theme: Theme; open: boolean; onClose: () => void; items: BrowserService[]; loading: boolean; error: string | null; manual: boolean; agentMode: boolean; onOpen: (service: BrowserService) => void; onRefresh: () => void;
}) {
  return <ListSheet title="本工作区服务" open={open} onClose={onClose}>
    <ServiceList theme={theme} items={items} loading={loading} error={error} disabled={!manual} onOpen={onOpen} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xs }}>
      <Button theme={theme} label="刷新" icon="RefreshCw" size="sm" busy={loading} testID="server-browser-services-refresh" onPress={onRefresh} />
      <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} numberOfLines={2} parts={[agentMode ? '切换到手动后可打开' : '在新标签页打开，地址是服务器本机的端口']} /></View>
    </View>
  </ListSheet>;
}

export type TakeoverAction = { kind: 'back' | 'forward' | 'reload' } | { kind: 'navigate'; url: string };
const takeoverVerbs: Record<TakeoverAction['kind'], string> = { back: '后退', forward: '前进', reload: '刷新', navigate: '打开网址' };
/**
 * From Agent mode, one navigation in two steps the viewer can see: Agent violet → your amber. The address field never takes
 * focus while the sheet slides in; `editable` asks for the address here (phones have no address bar in Agent mode).
 */
/** stale: the page shown when the sheet opened has changed (another document or tab); the confirmation no longer applies. */
export function TakeoverSheet({ theme, open, onClose, request, editable = false, stale = false, busy, onConfirm }: {
  theme: Theme; open: boolean; onClose: () => void; request: TakeoverAction; editable?: boolean; stale?: boolean; busy: boolean; onConfirm: (then: TakeoverAction) => void;
}) {
  const { colors } = theme, agentHue = controlLooks.agent.hue, manualHue = controlLooks.manual.hue, verb = takeoverVerbs[request.kind];
  const [url, setUrl] = useState(request.kind === 'navigate' ? request.url : '');
  useEffect(() => { setUrl(request.kind === 'navigate' ? request.url : ''); }, [request]);
  const mark = (name: string, tint: typeof agentHue | typeof manualHue) => <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: hue(theme, tint, 'soft'), borderWidth: hairline, borderColor: hue(theme, tint, 'line') }}><Icon name={name} size={18} color={hue(theme, tint)} /></View>;
  return <Sheet title={`切到手动并${verb}？`} open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {mark(controlLooks.agent.icon, agentHue)}
      <Breathe><Icon name="ArrowRight" size={16} color={colors.foregroundMuted} /></Breathe>
      {mark(controlLooks.manual.icon, manualHue)}
      <Text style={{ flex: 1, flexShrink: 1, minWidth: 0, color: colors.foreground, fontSize: fontSize.body, lineHeight: 21 }}>Agent 正在控制浏览器。确认后先切到手动，等 Agent 做完当前这一步再{verb}。</Text>
    </View>
    {request.kind === 'navigate' && editable ? <TextField theme={theme} label="网址" value={url} onChangeText={setUrl} placeholder="输入网址" /> : request.kind === 'navigate' ? <MetaLine theme={theme} numberOfLines={2} parts={[request.url]} /> : null}
    {stale ? <Banner theme={theme} tone="danger" icon="TriangleAlert" message={`打开这个确认之后，网页已经换了页面。这次确认已失效，不会切到手动，也不会${verb}；请关闭后看清当前页面再操作。`} />
      : <MetaLine theme={theme} numberOfLines={3} parts={['如果这期间 Agent 换了页面，就只切到手动、不执行这一步，免得误操作']} />}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
      <Button theme={theme} label={stale ? '关闭' : '取消'} variant="ghost" onPress={onClose} />
      <Button theme={theme} label={`切到手动并${verb}`} icon={controlLooks.manual.icon} tone={manualHue} busy={busy} disabled={stale || (request.kind === 'navigate' && !url.trim())} testID="server-browser-takeover-confirm"
        onPress={() => onConfirm(request.kind === 'navigate' ? { kind: 'navigate', url: url.trim() } : request)} />
    </View>
  </Sheet>;
}

const qualities: readonly { value: BrowserFrameQuality; label: string; icon: string; tone: Tone }[] = [{ value: 'smooth', label: '流畅', icon: 'Zap', tone: 'cyan' }, { value: 'balanced', label: '均衡', icon: 'Scale', tone: 'cyan' }, { value: 'sharp', label: '清晰', icon: 'Sparkles', tone: 'cyan' }];
export function qualityLabel(value: BrowserFrameQuality): string { return qualities.find((item) => item.value === value)?.label ?? value; }
export function ViewSheet({ theme, open, onClose, quality, onQuality, manual, agentMode, onMatch, onFitWidth, onPreset, paused, onTogglePause, onRefresh, metrics, viewport, scale, devicePreset, viewerCount }: {
  theme: Theme; open: boolean; onClose: () => void; quality: BrowserFrameQuality; onQuality: (value: BrowserFrameQuality) => void; manual: boolean; agentMode: boolean;
  onMatch: () => void; onFitWidth: () => void; onPreset: (preset: 'desktop' | 'iphone' | 'pixel' | 'ipad') => void; paused: boolean; onTogglePause: () => void; onRefresh: () => void;
  devicePreset?: string; viewerCount?: number; metrics: FrameMetrics | null; viewport: { width: number; height: number } | null; scale: number;
}) {
  return <Sheet title="画面" open={open} onClose={onClose}>
    <Group theme={theme} label="画质" icon="Gauge" tone="cyan"><Segmented theme={theme} value={quality} options={qualities} onChange={onQuality} accessibilityLabel="画质" /></Group>
    <Group theme={theme} label="网页尺寸" icon="Scan" tone="teal">
      <View style={wrap}>
        <Button theme={theme} label="匹配窗口" icon="Scan" size="sm" disabled={!manual} testID="server-browser-viewport-match" onPress={onMatch} />
        <Button theme={theme} label="完整宽度" icon="Columns2" size="sm" disabled={!manual} testID="server-browser-fit-width" onPress={onFitWidth} />
      </View>
      {agentMode ? <MetaLine theme={theme} parts={['切换到手动后可调整']} /> : null}
    </Group>
    <Group theme={theme} label="设备仿真" icon="MonitorSmartphone" tone="violet">
      <View style={wrap}>
        <Button theme={theme} label="iPhone 15 Pro" icon="Smartphone" size="sm" disabled={!manual} testID="server-browser-viewport-phone" onPress={() => onPreset('iphone')} />
        <Button theme={theme} label="桌面 Chrome" icon="Monitor" size="sm" disabled={!manual} testID="server-browser-viewport-desktop" onPress={() => onPreset('desktop')} />
        <Button theme={theme} label="Pixel 7" icon="Smartphone" size="sm" disabled={!manual} testID="server-browser-device-pixel" onPress={() => onPreset('pixel')} />
        <Button theme={theme} label="iPad Pro 11" icon="Tablet" size="sm" disabled={!manual} testID="server-browser-device-ipad" onPress={() => onPreset('ipad')} />
      </View>
      <MetaLine theme={theme} numberOfLines={3} parts={[viewport ? `${viewport.width} × ${viewport.height}` : null, devicePreset === 'iphone' ? 'iPhone · DPR 3 · 触摸' : devicePreset === 'pixel' ? 'Pixel · DPR 2.625 · 触摸' : devicePreset === 'ipad' ? 'iPad · DPR 2 · 触摸' : devicePreset === 'desktop' ? '桌面 · DPR 1 · 鼠标' : '自定义尺寸', '预设同步尺寸、像素比、触摸和浏览器身份；保留登录状态']} />
      <Badge theme={theme} tone="info" icon="Users" label={`${viewerCount ?? 0} 个客户端正在观看`} />
    </Group>
    <Group theme={theme} label="传输" icon="ArrowDownUp" tone="blue">
      <View testID="server-browser-frame-metrics" style={{ gap: space.xs }}>
        <MetaLine theme={theme} numberOfLines={2} parts={[viewport ? `网页 ${viewport.width} × ${viewport.height}` : null, scale > 0 ? `显示 ${Math.round(scale * 100)}%` : null, metrics ? `请求 ${metrics.latency} ms` : '正在测量', metrics?.interval ? `间隔 ${(metrics.interval / 1000).toFixed(1)} 秒` : null, metrics ? (metrics.kilobytes !== null ? `约 ${compactNumber(metrics.kilobytes)} KB` : '画面未变化') : null]} />
        {metrics?.degraded ? <Badge theme={theme} tone="warning" icon="Gauge" label="网络较慢，已临时降低画质" /> : null}
      </View>
      <View style={wrap}>
        <Button theme={theme} label={paused ? '继续画面' : '暂停画面'} icon={paused ? 'Play' : 'Pause'} size="sm" tone={paused ? 'success' : undefined} testID="server-browser-pause" onPress={onTogglePause} />
        <Button theme={theme} label="更新画面" icon="RefreshCw" size="sm" testID="server-browser-refresh-frame" onPress={onRefresh} />
      </View>
    </Group>
  </Sheet>;
}

export function ReadingSheet({ theme, open, onClose, mode, onMode, query, onQuery, onRun, canRun, busy, reading, error }: {
  theme: Theme; open: boolean; onClose: () => void; mode: 'article' | 'visible'; onMode: (mode: 'article' | 'visible') => void; query: string; onQuery: (value: string) => void;
  onRun: () => void; canRun: boolean; busy: boolean; reading: BrowserReading | null; error: string | null;
}) {
  const { colors } = theme;
  return <Sheet title="阅读页面" open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
      <Segmented theme={theme} value={mode} onChange={onMode} accessibilityLabel="读取范围" options={[{ value: 'article', label: '正文', icon: 'FileText', tone: 'indigo' }, { value: 'visible', label: '可见内容', icon: 'Eye', tone: 'indigo' }]} />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <SearchField theme={theme} value={query} onChangeText={onQuery} onSubmit={onRun} placeholder="关键词（可留空）" accessibilityLabel="搜索页面关键词" />
      <Button theme={theme} label={query.trim() ? '搜索' : '读取'} variant="primary" busy={busy} disabled={!canRun} testID="server-browser-reading-run" onPress={onRun} />
    </View>
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    {reading ? <View style={{ gap: space.sm, paddingTop: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text numberOfLines={2} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.title, fontWeight: '500' }}>{reading.title || '当前页面'}</Text>
        {reading.truncated ? <View testID="server-browser-reading-truncated"><Badge theme={theme} tone="info" icon="Scissors" label="已截取前 16,000 字符" /></View> : null}
      </View>
      <Text testID="server-browser-reading-result" selectable style={{ color: colors.foreground, fontSize: fontSize.content, lineHeight: 24 }}>{readable(reading.content) || '没有匹配内容'}</Text>
    </View> : null}
  </Sheet>;
}

const checkLooks: Record<PageCheck['status'], Look> = { ok: { label: '正常', tone: 'success', icon: 'CircleCheck' }, warning: { label: '注意', tone: 'warning', icon: 'TriangleAlert' }, error: { label: '异常', tone: 'danger', icon: 'CircleX' } };
const healthLooks: Record<'accessible' | 'network_error' | 'unknown', Look> = { accessible: checkLooks.ok, network_error: checkLooks.error, unknown: { label: '未知', tone: 'gray', icon: 'CircleHelp' } };
export function DiagnosticsSheet({ theme, open, onClose, health, checks, onRun, canRun, busy, manual, onTakeOver }: {
  theme: Theme; open: boolean; onClose: () => void; health: BrowserSession['health']; checks: PageCheck[] | null; onRun: () => void; canRun: boolean; busy: boolean; manual: boolean; onTakeOver: () => void;
}) {
  const { colors } = theme;
  return <Sheet title="页面诊断" open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row' }}><Button theme={theme} label="检查当前页面" icon="Stethoscope" variant="primary" busy={busy} disabled={!canRun} testID="server-browser-diagnostics-run" onPress={onRun} /></View>
    {health ? <View testID="server-browser-diagnostics-result" style={{ gap: space.sm }}>
      {health.state === 'login_required' ? <Banner theme={theme} tone="orange" icon="LogIn" message={`${health.summary}：请在网页中完成登录，再交给 Agent`} action={manual ? undefined : { label: '手动接管', onPress: onTakeOver }} />
        : <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <StateGlyph theme={theme} look={healthLooks[health.state]} size={16} />
          <Text style={{ flex: 1, color: health.state === 'network_error' ? toneColor(theme, 'danger') : colors.foreground, fontSize: fontSize.body, fontWeight: '500' }}>{health.summary}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(health.checkedAt)}</Text>
        </View>}
      {health.state === 'accessible' ? <MetaLine theme={theme} parts={['页面可访问，不代表已经登录']} /> : null}
    </View> : null}
    {checks?.length ? <View style={{ borderTopWidth: hairline, borderTopColor: colors.border, paddingTop: space.xs }}>
      <View style={{ marginHorizontal: -space.md }}>
        {checks.map((check, index) => <Row key={index} theme={theme} title={check.name} titleLines={1} leading={<StateGlyph theme={theme} look={checkLooks[check.status]} size={16} />} trailing={check.status === 'ok' ? undefined : <Badge theme={theme} tone={checkLooks[check.status].tone} label={checkLooks[check.status].label} />} subtitle={<MetaLine theme={theme} numberOfLines={3} parts={[check.detail]} />} />)}
      </View>
    </View> : null}
  </Sheet>;
}

export function ActivitySheet({ theme, open, onClose, session }: { theme: Theme; open: boolean; onClose: () => void; session: BrowserSession | null }) {
  return <ListSheet title="操作记录" open={open} onClose={onClose}><BrowserActivityList theme={theme} session={session} /></ListSheet>;
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
  return <Sheet title="资源与恢复" open={open} onClose={onClose}>
    <View testID="server-browser-runtime">
      <Fact theme={theme} label="运行时长" icon="Timer" tone="blue" value={formatDuration(uptimeSeconds * 1000) || '—'} />
      <Fact theme={theme} label="自动恢复" icon="LifeBuoy" tone={runtime?.recoveryCount ? 'amber' : 'green'} value={`${runtime?.recoveryCount || 0} 次${runtime?.lastRecoveredAt ? ` · 最近 ${relativeTime(runtime.lastRecoveredAt)}` : ''}`} />
      <Fact theme={theme} label="生成文件" icon="Files" tone="indigo" value={`${runtime?.artifactCount || 0} 个 · ${((runtime?.artifactBytes || 0) / 1048576).toFixed(1)} MB`} />
      <Fact theme={theme} label="清理规则" icon="CalendarClock" tone="gray" value={`上限 ${settings?.maxArtifactMB ?? '—'} MB · 保留 ${settings?.artifactMaxAgeHours ?? '—'} 小时`} />
      {failure ? <Fact theme={theme} label="最近失败" icon="CircleAlert" tone="danger" value={failure} /> : null}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs, borderTopWidth: hairline, borderTopColor: colors.border, paddingTop: space.md }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body }}>浏览器意外退出后自动恢复</Text>
        {agentMode ? <MetaLine theme={theme} parts={['切换到手动后可修改']} /> : null}
      </View>
      <Switch testID="server-browser-auto-recover" accessibilityLabel="自动恢复" value={!!settings?.autoRecover} disabled={!manual} onValueChange={onAutoRecover}
        trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.accentForeground} {...webSwitchColors(colors.accent, colors.accentForeground)} />
    </View>
    <View style={{ flexDirection: 'row' }}><Button theme={theme} label="清理过期文件" icon="Trash2" size="sm" disabled={!manual} testID="server-browser-cleanup" onPress={onCleanup} /></View>
  </Sheet>;
}

export function AgentSheet({ theme, open, onClose, profiles, profileId, onProfile, onConnect, canConnect, busy }: {
  theme: Theme; open: boolean; onClose: () => void; profiles: BrowserProfile[]; profileId: string; onProfile: (id: string) => void; onConnect: () => void; canConnect: boolean; busy: boolean;
}) {
  const { colors } = theme, agentHue = controlLooks.agent.hue;
  return <Sheet title="连接浏览器 Agent" open={open} onClose={onClose}>
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
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}><Button theme={theme} label="连接" icon="Bot" variant="primary" busy={busy} disabled={!canConnect} testID="server-browser-agent-open" onPress={onConnect} /></View>
  </Sheet>;
}

export function StopSheet({ theme, open, onClose, onConfirm }: { theme: Theme; open: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Sheet title="关闭浏览器" open={open} onClose={onClose}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: toneColor(theme, 'danger', 'soft') }}><Icon name="Power" size={18} color={toneColor(theme, 'danger', 'mark')} /></View>
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 21, paddingTop: space.xs }}>关闭后 Agent 不能再使用这个浏览器，登录状态会保留。</Text>
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
      <Button theme={theme} label="取消" variant="ghost" onPress={onClose} />
      <Button theme={theme} label="关闭浏览器" variant="danger" testID="server-browser-stop-confirm" onPress={onConfirm} />
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
  return <ListSheet title="打开工作区浏览器" open={open} onClose={() => { setFilter(''); onClose(); }}>
    <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs }}><SearchField theme={theme} value={filter} onChangeText={setFilter} placeholder="搜索项目或工作区" accessibilityLabel="搜索工作区" /></View>
    {choices.map((workspace) => <Row key={workspace.id} theme={theme} testID={`server-browser-workspace-${workspace.id}`} title={workspace.title} titleLines={1} selected={workspace.id === selectedId}
      accessibilityLabel={`${workspace.projectTitle || '未命名项目'} / ${workspace.title}`}
      leading={<ProjectMark theme={theme} name={projectName(workspace)} size={20} />}
      trailing={workspace.id === selectedId ? <Badge theme={theme} tone="info" icon="Eye" label="正在查看" /> : running.has(workspace.id) ? <Badge theme={theme} tone="success" icon="Play" label="已启动" /> : undefined}
      subtitle={workspace.projectTitle || '未命名项目'} onPress={() => { setFilter(''); onSelect(workspace.id); }} />)}
    {!choices.length ? <View style={{ padding: space.lg }}><MetaLine theme={theme} parts={['没有匹配的工作区']} /></View> : null}
  </ListSheet>;
}


export function DialogSheet({ theme, open, onClose, dialog, manual, busy, onTakeOver, onRespond }: {
  theme: Theme; open: boolean; onClose: () => void; dialog: NonNullable<BrowserSession['dialog']>; manual: boolean; busy: boolean;
  onTakeOver: () => void; onRespond: (accept: boolean, promptText?: string) => void;
}) {
  const [value, setValue] = useState(dialog.defaultValue);
  useEffect(() => setValue(dialog.defaultValue), [dialog.id, dialog.defaultValue]);
  return <Sheet title="网页对话框" open={open} onClose={onClose}>
    <Banner theme={theme} tone="warning" icon="MessageSquareWarning" message={dialog.type === 'prompt' ? '网页正在等待输入' : dialog.type === 'confirm' || dialog.type === 'beforeunload' ? '网页正在等待确认' : '网页提示'} />
    <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{dialog.message || '网页没有提供提示内容'}</Text>
    {dialog.type === 'prompt' ? <TextInput testID="server-browser-dialog-input" accessibilityLabel="网页对话框输入" value={value} onChangeText={setValue} editable={manual && !busy} maxLength={10000} placeholder="输入回复" placeholderTextColor={theme.colors.foregroundMuted} style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: radius.md, padding: space.md, minHeight: 44 }} /> : null}
    {!manual ? <Banner theme={theme} tone="info" message="Agent 正在控制浏览器，可由 Agent 回应，或先手动接管。" action={{ label: '手动接管', onPress: onTakeOver }} /> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
      {dialog.type !== 'alert' ? <Button theme={theme} label="取消" disabled={!manual || busy} testID="server-browser-dialog-cancel" onPress={() => onRespond(false)} /> : null}
      <Button theme={theme} label="确认" variant="primary" disabled={!manual || busy} testID="server-browser-dialog-confirm" onPress={() => onRespond(true, dialog.type === 'prompt' ? value : undefined)} />
    </View>
    <MetaLine theme={theme} numberOfLines={2} parts={['关闭面板不会回答网页；对话框会保留至明确回应或浏览器关闭。']} />
  </Sheet>;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
    <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: '500', flexShrink: 1 }}>{item.label || '已移除的工作区'}</Text>
    <MetaLine theme={theme} numberOfLines={2} parts={[item.label ? null : item.workspaceId, item.profileBytes ? formatBytes(item.profileBytes) : null, item.lastUsedAt ? `最近使用 ${relativeTime(item.lastUsedAt)}` : null]} />
  </View>;
  return <Sheet title="孤儿浏览器" open={open} onClose={onClose}>
    <MetaLine theme={theme} numberOfLines={3} parts={['工作区归档或移除后留下的浏览器。停止会结束进程；删除资料会清除它保存的登录状态、Cookie 和缓存。']} />
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    {!items.length && !loading && !error ? <Badge theme={theme} tone="success" icon="CircleCheck" label="没有孤儿浏览器，也没有留下的资料" /> : null}
    {running.length ? <Group theme={theme} label={`仍在运行 ${running.length}`} icon="Monitor" tone="amber">
      {running.map((item) => <View key={item.workspaceId} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs }}>
        <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}><Ping size={8} color={toneColor(theme, 'warning', 'mark')} /><StatusDot theme={theme} tone="warning" /></View>
        {name(item)}
        <Badge theme={theme} tone="warning" icon="Cpu" label={item.pid ? `进程 ${item.pid}` : '待回收'} />
        <Button theme={theme} label="停止" icon="Power" variant="danger" size="sm" busy={stopping === item.workspaceId} disabled={!!stopping || !!deleting} testID={`server-browser-stop-orphan-${item.workspaceId}`} onPress={() => onStop(item.workspaceId)} />
      </View>)}
    </Group> : null}
    {saved.length ? <Group theme={theme} label={`留下的浏览器资料 ${saved.length} · ${formatBytes(total)}`} icon="HardDrive" tone="red">
      {saved.map((item) => <View key={item.workspaceId} style={{ gap: space.sm, paddingVertical: space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Icon name="KeyRound" size={14} color={toneColor(theme, 'danger', 'mark')} />
          {name(item)}
          {confirming === item.workspaceId ? null : <Button theme={theme} label="删除资料" icon="Trash2" tone="danger" size="sm" disabled={!!deleting || !!stopping} testID={`server-browser-delete-orphan-${item.workspaceId}`} onPress={() => setConfirming(item.workspaceId)} />}
        </View>
        {confirming === item.workspaceId ? <View style={{ gap: space.sm }}>
          <Banner theme={theme} tone="danger" icon="TriangleAlert" message="删除后，这个工作区浏览器保存的登录状态、Cookie、历史、缓存和 Agent 截图都会清除，不能恢复。" />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
            <Button theme={theme} label="取消" variant="ghost" size="sm" onPress={() => setConfirming(null)} />
            <Button theme={theme} label="确认删除" icon="Trash2" variant="danger" size="sm" busy={deleting === item.workspaceId} disabled={!!deleting} testID={`server-browser-delete-orphan-confirm-${item.workspaceId}`} onPress={() => onDelete(item.workspaceId)} />
          </View>
        </View> : null}
      </View>)}
    </Group> : null}
    <View style={{ flexDirection: 'row' }}><Button theme={theme} label="刷新列表" icon="RefreshCw" busy={loading} onPress={onRefresh} /></View>
  </Sheet>;
}
