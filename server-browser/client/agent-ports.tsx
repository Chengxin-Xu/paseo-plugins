import { t } from '../shared/text';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { BrowserAgentPort } from '../shared/browser';
import { Badge, MetaLine, aria, fontSize, hairline, hue, radius, space, toneColor, withAlpha } from './kit';
import { Enter, Flash, Ping } from './motion';
import { LiveDot } from './looks';
import { agentName, openLabel, portKey, portLook, processName, scopeLabel, scopeTone, workspaceName, type PortsData } from './agent-ports-model';

type Theme = PluginSurfaceProps['theme'];
type Interaction = { pressed: boolean; hovered?: boolean };
const SCOPE_ICONS = { local: 'Server', all: 'Globe', address: 'Network' } as const;

/** disabled: the rows cannot open right now (Agent mode, no picture yet, the tab limit); they still show what listens. */
export type AgentPortsView = { data: PortsData | undefined; error: string | null; disabled: boolean; onOpen: (port: BrowserAgentPort) => void };

/** The port as a vivid pill (":5173"): blue and radiating while the Agent works, green while it waits, amber once it stopped. */
function PortPill({ theme, port, fresh }: { theme: Theme; port: BrowserAgentPort; fresh: boolean }) {
  const look = portLook(port), mark = toneColor(theme, look.tone, 'mark');
  return <View style={{ minWidth: 68, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 10, borderRadius: radius.full, overflow: 'hidden',
    backgroundColor: toneColor(theme, look.tone, 'soft'), borderWidth: hairline, borderColor: toneColor(theme, look.tone, 'line') }}>
    <Flash count={fresh ? 1 : 0} color={withAlpha(mark, 0.65)} radius={radius.full} />
    <View style={{ width: 7, height: 7, alignItems: 'center', justifyContent: 'center' }}>
      <Ping size={7} color={mark} active={look.working} />
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: mark }} />
    </View>
    <Text style={{ color: toneColor(theme, look.tone), fontSize: fontSize.small, fontWeight: '700', fontVariant: ['tabular-nums'] }}>:{port.port}</Text>
  </View>;
}

/**
 * One port: who opened it, the program, where it listens and how the Agent is doing. `isNew` is decided once, when the
 * row mounts: a port that appeared while the sheet was open flashes once and keeps a 「新」 tag (also without motion).
 */
function PortRow({ theme, port, isNew, disabled, showWorkspace, onOpen }: { theme: Theme; port: BrowserAgentPort; isNew: boolean; disabled: boolean; showWorkspace: boolean; onOpen: (port: BrowserAgentPort) => void }) {
  const { colors } = theme, look = portLook(port), open = port.openable && !disabled;
  const [fresh] = useState(isNew);
  const where = showWorkspace ? workspaceName(port) : null;
  return <Enter active={fresh}>
    <Pressable testID={`server-browser-port-${port.port}`} accessibilityRole="button" accessibilityLabel={openLabel(port)} accessibilityState={{ disabled: !open }} disabled={!open} {...aria({ disabled: !open })} onPress={() => onOpen(port)}
      style={(press) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: space.md, paddingVertical: space.xs + 2, borderRadius: radius.md,
        backgroundColor: open && ((press as Interaction).hovered || press.pressed) ? colors.surface1 : look.stopped ? withAlpha(hue(theme, 'amber'), 0.06) : 'transparent' })}>
      <PortPill theme={theme} port={port} fresh={fresh} />
      <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: '500' }}>{agentName(port)}</Text>
          {fresh ? <Badge theme={theme} label={t('agentPorts.new')} tone="fuchsia" solid /> : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: 3 }}>
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: '500' }}>{processName(port)}</Text>
          <Badge theme={theme} label={scopeLabel(port)} tone={scopeTone(port)} icon={SCOPE_ICONS[port.scope]} />
          <Text numberOfLines={1} style={{ color: look.tone === 'success' ? colors.foregroundMuted : toneColor(theme, look.tone), fontSize: fontSize.meta, fontWeight: look.stopped ? '600' : '500' }}>{look.label}</Text>
        </View>
        {where || !port.openable ? <MetaLine theme={theme} numberOfLines={2} parts={[where, port.openable ? null : t('agentPorts.notOpenable')]} /> : null}
      </View>
      {open ? <Icon name="ArrowUpRight" size={15} color={toneColor(theme, look.tone, 'mark')} /> : null}
    </Pressable>
  </Enter>;
}

function Note({ theme, tone, text }: { theme: Theme; tone: 'warning' | 'danger'; text: string }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md, paddingVertical: space.xs }}>
    <Icon name={tone === 'danger' ? 'CircleAlert' : 'TriangleAlert'} size={13} color={toneColor(theme, tone, 'mark')} />
    <Text style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{text}</Text>
  </View>;
}

/**
 * 「Agent 开的端口」 under the workspace services: this workspace's ports, then other workspaces' behind a toggle. Hidden
 * until the first reply and on hosts that cannot list ports; `quietWhenEmpty` (the tabs sheet) also hides it while no
 * Agent listens anywhere. Rows that appear while the sheet is open flash once.
 */
export function AgentPortSection({ theme, view, divider = false, quietWhenEmpty = false }: { theme: Theme; view: AgentPortsView; divider?: boolean; quietWhenEmpty?: boolean }) {
  const { colors } = theme, data = view.data;
  const [showOthers, setShowOthers] = useState(false);
  // Everything this sheet has shown: the first reply is the baseline, so nothing flashes when the sheet opens.
  const known = useRef<Set<string> | null>(null);
  const all = data ? data.items.concat(data.others) : [];
  useEffect(() => {
    if (!data) return;
    const next = known.current ?? new Set<string>();
    for (const port of all) next.add(portKey(port));
    known.current = next;
  });
  if (!data?.supported || (quietWhenEmpty && !all.length && !data.failed && !view.error)) return null;
  const isNew = (port: BrowserAgentPort) => known.current !== null && !known.current.has(portKey(port));
  const row = (port: BrowserAgentPort, showWorkspace: boolean) => <PortRow key={portKey(port)} theme={theme} port={port} isNew={isNew(port)} disabled={view.disabled} showWorkspace={showWorkspace} onOpen={view.onOpen} />;
  const stoppedElsewhere = data.others.some((port) => portLook(port).stopped);
  return <View testID="server-browser-agent-ports" style={{ gap: space.xxs, ...(divider ? { paddingTop: space.sm, marginTop: space.xs, borderTopWidth: hairline, borderTopColor: colors.border } : {}) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md, paddingVertical: space.xs }}>
      <Icon name="PlugZap" size={13} color={hue(theme, 'violet')} />
      <Text style={{ color: hue(theme, 'violet', 'text'), fontSize: fontSize.meta, fontWeight: '600' }}>{t('agentPorts.title')}</Text>
      {data.items.length ? <Text style={{ color: hue(theme, 'violet', 'text'), fontSize: fontSize.meta, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{data.items.length}</Text> : null}
      <LiveDot color={toneColor(theme, 'success', 'mark')} size={6} live={!data.failed} />
    </View>
    {data.items.length ? data.items.map((port) => row(port, false))
      : <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}><MetaLine theme={theme} numberOfLines={3} parts={[t('agentPorts.empty')]} /></View>}
    {data.others.length ? <Pressable testID="server-browser-ports-others" accessibilityRole="button" accessibilityLabel={showOthers ? t('agentPorts.hideOthers') : t('agentPorts.showOthers', { count: data.others.length })}
      accessibilityState={{ expanded: showOthers }} {...aria({ expanded: showOthers })} onPress={() => setShowOthers((value) => !value)}
      style={(press) => ({ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: (press as Interaction).hovered || press.pressed ? colors.surface1 : 'transparent' })}>
      <Icon name={showOthers ? 'ChevronDown' : 'ChevronRight'} size={14} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, fontWeight: '500' }}>{t('agentPorts.others')}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ['tabular-nums'] }}>{data.others.length}</Text>
      {stoppedElsewhere ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(theme, 'warning', 'mark') }} /> : null}
    </Pressable> : null}
    {showOthers ? data.others.map((port) => row(port, true)) : null}
    {data.failed ? <Note theme={theme} tone="danger" text={t('agentPorts.failed')} /> : null}
    {data.partial ? <Note theme={theme} tone="warning" text={t('agentPorts.partial')} /> : null}
    {data.uncertain ? <Note theme={theme} tone="warning" text={t('agentPorts.uncertain')} /> : null}
    {view.error ? <Note theme={theme} tone="danger" text={view.error} /> : null}
  </View>;
}
