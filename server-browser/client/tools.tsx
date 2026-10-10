import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, Modal } from '@getpaseo/plugin/client/react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import type { BrowserFrameQuality, BrowserProfile, BrowserReading, BrowserSession, BrowserWorkspace } from '../shared/browser';
import { controlLooks, projectName } from './agent-tabs-model';
import { Badge, Banner, Button, IconButton, MetaLine, ProjectMark, Row, SearchField, Segmented, Sheet, compactNumber, fontSize, formatDuration, hairline, hue, radius, relativeTime, space, toneColor, type Tone } from './kit';
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

/** `manual`: controls usable right now; `agentMode`: the Agent holds control (explains why they are not). */
export function PageTabsSheet({ theme, open, onClose, tabs, manual, agentMode, maxTabs, agentTabId, onSelect, onCloseTab, onPin, onNewTab }: {
  theme: Theme; open: boolean; onClose: () => void; tabs: BrowserSession['tabs']; manual: boolean; agentMode: boolean; maxTabs: number; agentTabId?: string | null;
  onSelect: (tabId: string) => void; onCloseTab: (tabId: string) => void; onPin: (tabId: string, pinned: boolean) => void; onNewTab: () => void;
}) {
  const { colors } = theme;
  return <ListSheet title={`标签页 ${tabs.length}`} open={open} onClose={onClose}>
    {tabs.map((tab) => <Pressable key={tab.id} testID={`server-browser-tab-${tab.id}`} accessibilityRole="tab" accessibilityLabel={`标签页 ${tab.title || '新标签页'}`} accessibilityState={{ selected: tab.active, disabled: !manual }} aria-selected={tab.active}
      disabled={!manual} onPress={() => onSelect(tab.id)}
      style={(state) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingLeft: space.md, paddingRight: space.xs, borderRadius: radius.md, backgroundColor: tab.active ? colors.surface2 : (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent' })}>
      <View style={{ width: 16, alignItems: 'center' }}>{agentTabId === tab.id ? <StateGlyph theme={theme} look={agentAtWork} size={14} /> : <Icon name={tab.pinned ? 'Pin' : 'Globe'} size={14} color={tab.pinned ? hue(theme, 'teal') : tab.active ? toneColor(theme, 'info', 'mark') : colors.foregroundMuted} />}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: tab.active ? '500' : '400' }}>{tab.title || '新标签页'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
          {agentTabId === tab.id ? <Text style={{ color: toneColor(theme, 'info'), fontSize: fontSize.meta, fontWeight: '500' }}>Agent 正在操作</Text> : null}
          {tab.pinned ? <Text style={{ color: hue(theme, 'teal', 'text'), fontSize: fontSize.meta, fontWeight: '500' }}>已固定</Text> : null}
          <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[pageHost(tab.url)]} /></View>
        </View>
      </View>
      <IconButton theme={theme} icon={tab.pinned ? 'PinOff' : 'Pin'} label={tab.pinned ? '取消固定标签页' : '固定标签页'} size="sm" disabled={!manual} testID={`server-browser-pin-tab-${tab.id}`} onPress={() => onPin(tab.id, !tab.pinned)} />
      <IconButton theme={theme} icon="X" label={tab.pinned ? '已固定，先取消固定再关闭' : '关闭标签页'} size="sm" disabled={!manual || tab.pinned} testID={`server-browser-close-tab-${tab.id}`} onPress={() => onCloseTab(tab.id)} />
    </Pressable>)}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xs }}>
      <Button theme={theme} label="新建标签页" icon="Plus" size="sm" disabled={!manual || tabs.length >= maxTabs} testID="server-browser-new-tab" onPress={onNewTab} />
      {agentMode ? <View style={{ flex: 1 }}><MetaLine theme={theme} parts={['切换到手动后可切换或关闭']} numberOfLines={2} /></View> : null}
    </View>
  </ListSheet>;
}

const qualities: readonly { value: BrowserFrameQuality; label: string; icon: string; tone: Tone }[] = [{ value: 'smooth', label: '流畅', icon: 'Zap', tone: 'cyan' }, { value: 'balanced', label: '均衡', icon: 'Scale', tone: 'cyan' }, { value: 'sharp', label: '清晰', icon: 'Sparkles', tone: 'cyan' }];
export function qualityLabel(value: BrowserFrameQuality): string { return qualities.find((item) => item.value === value)?.label ?? value; }
export function ViewSheet({ theme, open, onClose, quality, onQuality, manual, agentMode, onMatch, onFitWidth, onPreset, paused, onTogglePause, onRefresh, metrics, viewport, scale }: {
  theme: Theme; open: boolean; onClose: () => void; quality: BrowserFrameQuality; onQuality: (value: BrowserFrameQuality) => void; manual: boolean; agentMode: boolean;
  onMatch: () => void; onFitWidth: () => void; onPreset: (size: { width: number; height: number }) => void; paused: boolean; onTogglePause: () => void; onRefresh: () => void;
  metrics: FrameMetrics | null; viewport: { width: number; height: number } | null; scale: number;
}) {
  return <Sheet title="画面" open={open} onClose={onClose}>
    <Group theme={theme} label="画质" icon="Gauge" tone="cyan"><Segmented theme={theme} value={quality} options={qualities} onChange={onQuality} accessibilityLabel="画质" /></Group>
    <Group theme={theme} label="网页尺寸" icon="Scan" tone="teal">
      <View style={wrap}>
        <Button theme={theme} label="匹配窗口" icon="Scan" size="sm" disabled={!manual} testID="server-browser-viewport-match" onPress={onMatch} />
        <Button theme={theme} label="完整宽度" icon="Columns2" size="sm" disabled={!manual} testID="server-browser-fit-width" onPress={onFitWidth} />
        <Button theme={theme} label="手机 390 × 760" icon="Smartphone" size="sm" disabled={!manual} testID="server-browser-viewport-phone" onPress={() => onPreset({ width: 390, height: 760 })} />
        <Button theme={theme} label="电脑 1440 × 900" icon="Monitor" size="sm" disabled={!manual} testID="server-browser-viewport-desktop" onPress={() => onPreset({ width: 1440, height: 900 })} />
      </View>
      {agentMode ? <MetaLine theme={theme} parts={['切换到手动后可调整']} /> : null}
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
