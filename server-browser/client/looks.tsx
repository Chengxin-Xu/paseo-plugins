import { t } from '../shared/text';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { controlLooks } from './agent-tabs-model';
import { control, fontSize, hairline, hue, radius, space, toneColor, withAlpha, type Tone } from './kit';
import { Ping, Spin } from './motion';
import type { Look } from './overview-model';

type Theme = PluginSurfaceProps['theme'];
type Interaction = { pressed: boolean; hovered?: boolean };
const quiet = (tone: Tone) => tone === 'neutral' || tone === 'gray';
/** React Native Web ignores `accessibilityState`; a toggle's state reaches the DOM as `aria-pressed` (not in React Native's types). */
const webPressed = (pressed: boolean) => ({ 'aria-pressed': pressed }) as object;

/** Ring with a turning arc (as in the observatory): Agent work in progress. */
export function Spinner({ size, color, slow = false, active = true }: { size: number; color: string; slow?: boolean; active?: boolean }) {
  const ring = size - 2, stroke = size >= 14 ? 2 : 1.5;
  const circle: ViewStyle = { position: 'absolute', width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke };
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <View style={[circle, { borderColor: withAlpha(color, 0.28) }]} />
    <Spin size={ring} slow={slow} active={active}><View style={[circle, { borderColor: 'transparent', borderTopColor: color, borderRightColor: color }]} /></Spin>
  </View>;
}

/** A small dot that radiates while something waits for you. */
export function LiveDot({ color, size = 7, live = true }: { color: string; size?: number; live?: boolean }) {
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Ping size={size} color={color} active={live} />
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  </View>;
}

/** The mark of a state at 12–16 px: Agent work spins, an approval is a radiating filled disk, everything else its coloured icon. */
export function StateGlyph({ theme, look, size = 14 }: { theme: Theme; look: Look; size?: number }) {
  const color = quiet(look.tone) ? theme.colors.foregroundMuted : toneColor(theme, look.tone, 'mark');
  const box: ViewStyle = { width: size, height: size, alignItems: 'center', justifyContent: 'center' };
  if (look.motion === 'spin') return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={box}><Spinner size={size} color={color} slow={look.icon === 'RefreshCw'} /></View>;
  if (look.motion === 'ping') return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={box}>
    <Ping size={size} color={color} />
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color }}><Icon name={look.icon} size={Math.round(size * 0.64)} color={theme.colors.surface0} /></View>
  </View>;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={box}><Icon name={look.icon} size={size} color={color} /></View>;
}

/**
 * A state as a small tinted pill with its moving or coloured mark, e.g. 「Agent 操作中」「待审批」.
 * `floating` sits on an opaque ground so it stays legible over page thumbnails.
 */
export function StatePill({ theme, look, floating = false }: { theme: Theme; look: Look; floating?: boolean }) {
  const { colors } = theme, muted = quiet(look.tone);
  const mark = muted ? colors.foregroundMuted : toneColor(theme, look.tone, 'mark');
  const pill = <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 20, paddingHorizontal: space.xs + 2, borderRadius: radius.sm - 2, backgroundColor: toneColor(theme, look.tone, 'soft'), borderWidth: floating ? hairline : 0, borderColor: toneColor(theme, look.tone, 'line') }}>
    {look.motion === 'spin' ? <Spinner size={11} color={mark} slow={look.icon === 'RefreshCw'} /> : <Icon name={look.icon} size={12} color={mark} />}
    <Text numberOfLines={1} style={{ color: muted ? colors.foregroundMuted : toneColor(theme, look.tone), fontSize: fontSize.meta, fontWeight: '500' }}>{look.label}</Text>
  </View>;
  return floating ? <View style={{ alignSelf: 'flex-start', borderRadius: radius.sm - 2, backgroundColor: colors.surface0 }}>{pill}</View> : <View style={{ alignSelf: 'flex-start' }}>{pill}</View>;
}

/** Filter chip whose mark shows the state it filters: spinning while Agents work, radiating while something waits for you. */
export function StateChip({ theme, label, count, tone, motion, selected, onPress, testID }: {
  theme: Theme; label: string; count?: number; tone?: Tone; motion?: 'spin' | 'ping'; selected: boolean; onPress: () => void; testID?: string;
}) {
  const { colors } = theme, lit = !!tone && (count ?? 0) > 0;
  const color = tone && (lit || selected) ? toneColor(theme, tone, 'mark') : colors.foregroundMuted;
  const mark = !tone ? null : motion === 'spin' ? <Spinner size={12} color={color} active={lit} /> : <LiveDot color={color} size={7} live={lit && motion === 'ping'} />;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={count === undefined ? label : t("browserLooks.labelWithCount", { label, count })} accessibilityState={{ selected }} {...webPressed(selected)} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }}
    style={(state) => ({ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, minHeight: control.sm, paddingHorizontal: 10, borderRadius: radius.full, borderWidth: hairline,
      borderColor: selected ? tone ? toneColor(theme, tone, 'mark') : colors.foregroundMuted : lit ? toneColor(theme, tone!, 'line') : colors.border,
      backgroundColor: selected ? tone ? toneColor(theme, tone, 'soft') : colors.surface2 : (state as Interaction).hovered ? colors.surface1 : 'transparent', opacity: state.pressed ? 0.8 : 1 })}>
    {mark ? <View style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center' }}>{mark}</View> : null}
    <Text numberOfLines={1} style={{ color: selected || lit ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? '500' : '400' }}>{label}</Text>
    {count !== undefined ? <Text style={{ color: lit ? toneColor(theme, tone!) : colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: lit ? '600' : '400', fontVariant: ['tabular-nums'] }}>{count}</Text> : null}
  </Pressable>;
}

/** Who drives a running browser: the Agent's violet bot or the viewer's amber pointer. */
export function ControlMark({ theme, mode, size = 12 }: { theme: Theme; mode: 'agent' | 'manual'; size?: number }) {
  const look = controlLooks[mode];
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Icon name={look.icon} size={size} color={hue(theme, look.hue)} /></View>;
}
