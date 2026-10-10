import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { memo, useEffect, useRef } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { tabGlyph, type AgentTabGroup } from './agent-tabs-model';
import { HueDot, ProjectMark, control, fontSize, hairline, hueFor, radius, space } from './kit';
import { StateGlyph } from './looks';

type Theme = PluginSurfaceProps['theme'];
type Interaction = { pressed: boolean; hovered?: boolean };

/** The desktop tab strip: one tab per browser with its project's colour dot (`hueFor`, as in every plugin) and a live state mark. Project hues stay on small marks so they never read as a state. */
export const BrowserAgentTabs = memo(function BrowserAgentTabs({ theme, groups, selectedWorkspaceId, onSelect }: {
  theme: Theme; groups: AgentTabGroup[]; selectedWorkspaceId: string; onSelect: (workspaceId: string) => void;
}) {
  const { colors } = theme;
  const scrollRef = useRef<ScrollView>(null);
  const groupPositions = useRef(new Map<string, number>());
  const tabPositions = useRef(new Map<string, { groupKey: string; x: number; width: number }>());
  const currentViewport = useRef({ width: 0, offset: 0 });
  const ensureSelectedVisible = () => {
    const selected = tabPositions.current.get(selectedWorkspaceId);
    if (!selected) return;
    const left = (groupPositions.current.get(selected.groupKey) || 0) + selected.x;
    const { offset, width } = currentViewport.current;
    if (!width) return;
    if (left < offset + 4) scrollRef.current?.scrollTo({ x: Math.max(0, left - 8), animated: false });
    else if (left + selected.width > offset + width - 4) scrollRef.current?.scrollTo({ x: Math.max(0, left + selected.width - width + 8), animated: false });
  };
  useEffect(() => { ensureSelectedVisible(); }, [selectedWorkspaceId]);
  const labelled = groups.length > 1;
  return <ScrollView ref={scrollRef} testID="server-browser-agent-tabs" horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1, minWidth: 0 }} contentContainerStyle={{ alignItems: 'center', gap: space.sm }}
    onLayout={(event) => { currentViewport.current.width = event.nativeEvent.layout.width; ensureSelectedVisible(); }}
    onScroll={(event) => { currentViewport.current.offset = event.nativeEvent.contentOffset.x; }} scrollEventThrottle={32}>
    {groups.map((group, index) => {
      const projectHue = hueFor(group.identity);
      return <View key={group.projectKey} testID={`server-browser-project-group-${group.projectKey}`} onLayout={(event) => { groupPositions.current.set(group.projectKey, event.nativeEvent.layout.x); ensureSelectedVisible(); }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xxs }}>
        {labelled && index > 0 ? <View style={{ width: hairline, height: 16, marginRight: space.xs, backgroundColor: colors.border }} /> : null}
        {labelled && <View accessibilityLabel={`项目 ${group.projectTitle}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 1, paddingLeft: space.xxs, paddingRight: space.xs }}>
          <ProjectMark theme={theme} name={group.identity} size={16} />
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, maxWidth: 104 }}>{group.projectTitle}</Text>
        </View>}
        {group.tabs.map((tab) => {
          const selected = tab.workspaceId === selectedWorkspaceId;
          const glyph = tabGlyph(tab.state, tab.mode);
          const detail = tab.kind !== 'agent' || group.tabs.some((other) => other !== tab && other.title === tab.title) ? tab.subtitle : '';
          return <Pressable key={tab.workspaceId} testID={`server-browser-agent-tab-${tab.workspaceId}`} accessibilityRole="tab" accessibilityLabel={tab.accessibilityLabel} accessibilityHint="仅切换查看此浏览器，不改变网页" accessibilityState={{ selected }} aria-selected={selected}
            onPress={() => onSelect(tab.workspaceId)}
            onLayout={(event) => { tabPositions.current.set(tab.workspaceId, { groupKey: group.projectKey, x: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width }); ensureSelectedVisible(); }}
            style={(state) => ({ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, height: control.sm, maxWidth: 220, paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: selected ? colors.surface2 : (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent', opacity: tab.state === 'offline' && !selected ? 0.75 : 1 })}>
            <HueDot theme={theme} hue={projectHue} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: selected ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? '500' : '400' }}>
              {tab.title}{detail ? <Text style={{ color: colors.foregroundMuted, fontWeight: '400' }}>{`  ${detail}`}</Text> : null}
            </Text>
            {glyph && <StateGlyph theme={theme} look={glyph} size={14} />}
          </Pressable>;
        })}
      </View>;
    })}
  </ScrollView>;
});
