import { t } from '../shared/text';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, ScrollView, TextInput } from '@getpaseo/plugin/client/react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View, type TextStyle } from 'react-native';
import { controlLooks } from './agent-tabs-model';
import { Button, IconButton, control, fontSize, hairline, hue, radius, space, toneColor, type Tone } from './kit';

type Theme = PluginSurfaceProps['theme'];
type Interaction = { pressed: boolean; hovered?: boolean };
export type ControlMode = 'agent' | 'manual';
/** The browser's own focus ring would sit inside these filled fields; `outlineStyle` is web-only and untyped in React Native. */
export const noFocusRing = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as TextStyle;

/**
 * Which sheet is mounted: the open one, plus the one just closed while the host animates it out. Host sheets keep
 * their whole content rendered while hidden, so never-opened sheets are not mounted at all (cheap frame updates).
 */
export function useSheetPresence<Name extends string>(open: Name | null, exitMs = 600): (name: Name) => boolean {
  const [closing, setClosing] = useState<Name | null>(null);
  const previous = useRef<Name | null>(open);
  useEffect(() => {
    const last = previous.current;
    previous.current = open;
    if (!last || last === open) return;
    setClosing(last);
    const timer = setTimeout(() => setClosing((current) => current === last ? null : current), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return (name) => name === open || name === closing;
}

/** Address bar: lock/globe glyph, select-all on focus, Enter or the arrow navigates. Read-only while the Agent is in control. */
export function AddressField({ theme, value, onChangeText, onSubmit, editable, busy, compact, onFocusChange }: {
  theme: Theme; value: string; onChangeText: (value: string) => void; onSubmit: () => void; editable: boolean; busy: boolean; compact: boolean; onFocusChange: (focused: boolean) => void;
}) {
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  const shown = value === 'about:blank' ? '' : value;
  const secure = /^https:\/\//i.test(value);
  return <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, height: compact ? control.md : 30, paddingLeft: 10, paddingRight: focused && editable && shown ? space.xxs : 10, borderRadius: radius.md, backgroundColor: colors.surface2 }}>
    {busy ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : <Icon name={secure ? 'Lock' : 'Globe'} size={14} color={colors.foregroundMuted} />}
    <TextInput testID="server-browser-address" accessibilityLabel={t("browserChrome.pageUrl")} value={shown} onChangeText={onChangeText} editable={editable} selectTextOnFocus
      onFocus={() => { setFocused(true); onFocusChange(true); }} onBlur={() => { setFocused(false); onFocusChange(false); }} onSubmitEditing={onSubmit}
      placeholder={editable ? t("browserChrome.enterAUrl") : t("browserChrome.pageUrl")} placeholderTextColor={colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go"
      style={{ flex: 1, minWidth: 0, color: editable ? colors.foreground : colors.foregroundMuted, fontSize: compact ? fontSize.body : fontSize.small, paddingVertical: 0, ...noFocusRing }} />
    {focused && editable && shown ? <IconButton theme={theme} icon="ArrowRight" label={t("browserChrome.goToUrl")} size="sm" testID="server-browser-go" onPress={onSubmit} /> : null}
  </View>;
}

/** Page-tab switcher in the style of mobile browsers: a rounded square with the open-tab count. */
export function TabCountButton({ theme, count, onPress, size = 'sm' }: { theme: Theme; count: number; onPress: () => void; size?: 'sm' | 'md' }) {
  const { colors } = theme, edge = size === 'sm' ? control.sm : control.md;
  return <Pressable testID="server-browser-tabs" accessibilityRole="button" accessibilityLabel={t("browserChrome.tabs", { count: count })} onPress={onPress} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
    style={state => ({ width: edge, height: edge, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent' })}>
    <View style={{ minWidth: 17, height: 17, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1.5, borderColor: colors.foregroundMuted }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{count > 99 ? t("browserChrome.label99") : count}</Text>
    </View>
  </Pressable>;
}

/**
 * Who is in control, drawn like the kit's small Segmented in the control colours: Agent violet, 手动 amber, the
 * current one on a tinted segment. Kept local because React Native Web ignores `accessibilityState`, so the selected
 * mode needs `aria-selected`, and the two options keep stable test IDs. Phones show the icon of the current mode only.
 * Re-selecting the current mode sends nothing; the switch is inert while an action runs.
 */
export function ModeSwitch({ theme, mode, onChange, disabled, compact }: { theme: Theme; mode: ControlMode; onChange: (mode: ControlMode) => void; disabled: boolean; compact: boolean }) {
  const { colors } = theme;
  const options = [{ value: 'agent', testID: 'server-browser-agent-mode', ...controlLooks.agent }, { value: 'manual', testID: 'server-browser-manual', ...controlLooks.manual }] as const;
  return <View testID="server-browser-mode" accessibilityRole="tablist" accessibilityLabel={t("browserChrome.controlMode")} aria-disabled={disabled} pointerEvents={disabled ? 'none' : 'auto'}
    style={{ flexDirection: 'row', padding: space.xxs, gap: space.xxs, borderRadius: radius.md, backgroundColor: colors.surface2, opacity: disabled ? 0.5 : 1 }}>
    {options.map((option) => {
      const selected = option.value === mode;
      return <Pressable key={option.value} testID={option.testID} accessibilityRole="tab" accessibilityLabel={option.label} accessibilityState={{ selected, disabled }} aria-selected={selected} disabled={disabled}
        onPress={() => { if (!selected) onChange(option.value); }} hitSlop={{ top: 6, bottom: 6 }}
        style={(state) => ({ flexDirection: 'row', alignItems: 'center', gap: space.xs + 1, minHeight: 24, paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: selected ? hue(theme, option.hue, 'soft') : (state as Interaction).hovered ? colors.surface1 : 'transparent', borderWidth: selected ? hairline : 0, borderColor: hue(theme, option.hue, 'line') })}>
        {compact && !selected ? null : <Icon name={option.icon} size={14} color={hue(theme, option.hue)} />}
        <Text numberOfLines={1} style={{ color: selected ? hue(theme, option.hue, 'text') : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? '500' : '400' }}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** Centered stage state (not started, recovering, lost connection): the kit EmptyState look on a tile tinted with the state's tone, but its one action may be primary. */
export function StageMessage({ theme, icon, title, message, action, busy = false, tone = 'neutral' }: {
  theme: Theme; icon: string; title: string; message?: string; busy?: boolean; tone?: Tone;
  action?: { label: string; onPress: () => void; primary?: boolean; busy?: boolean; disabled?: boolean; testID?: string; icon?: string; tone?: Tone };
}) {
  const { colors } = theme, color = tone === 'neutral' ? colors.foregroundMuted : toneColor(theme, tone, 'mark');
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl }}>
    <View style={{ width: 44, height: 44, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: toneColor(theme, tone, 'soft'), marginBottom: space.xs }}>
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={22} color={color} />}
    </View>
    <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: '500', textAlign: 'center' }}>{title}</Text>
    {message ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19, textAlign: 'center', maxWidth: 320 }}>{message}</Text> : null}
    {action ? <View style={{ marginTop: space.sm }}><Button theme={theme} label={action.label} icon={action.icon} variant={action.primary ? 'primary' : 'secondary'} tone={action.tone} disabled={action.disabled} busy={action.busy} testID={action.testID} onPress={action.onPress} /></View> : null}
  </View>;
}

/** A pill at the foot of the page (a request in flight, a paused picture) in the tone of what it waits for; banners own the top edge. It never shifts the layout. */
export function BusyPill({ theme, label, icon, onPress, tone = 'neutral' }: { theme: Theme; label: string; icon?: string; onPress?: () => void; tone?: Tone }) {
  const { colors } = theme, color = tone === 'neutral' ? colors.foregroundMuted : toneColor(theme, tone, 'mark');
  const body = <>
    {icon ? <Icon name={icon} size={14} color={color} /> : <ActivityIndicator size="small" color={color} />}
    <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.meta }}>{label}</Text>
  </>;
  const pill = { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md, height: 28, borderRadius: radius.full, backgroundColor: colors.surface1, borderWidth: hairline, borderColor: tone === 'neutral' ? colors.border : toneColor(theme, tone, 'line') } as const;
  return <View pointerEvents="box-none" style={{ position: 'absolute', bottom: space.md, left: 0, right: 0, alignItems: 'center', zIndex: 5 }}>
    {onPress ? <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={{ top: 8, bottom: 8 }} style={(state) => [pill, { opacity: state.pressed ? 0.8 : 1 }]}>{body}</Pressable>
      : <View accessibilityRole={icon ? undefined : 'progressbar'} accessibilityLabel={label} style={pill}>{body}</View>}
  </View>;
}

const keys = [{ key: 'Enter', get label() { return t("browserChrome.enter"); } }, { key: 'Tab', get label() { return t("browserChrome.tab"); } }, { key: 'Backspace', get label() { return t("browserChrome.backspace"); } }, { key: 'Control+A', get label() { return t("browserChrome.selectAll"); } }, { key: 'Escape', get label() { return t("browserChrome.esc"); } }] as const;
export type DockKey = typeof keys[number]['key'];
/** Typing tray for phones, IME and special keys; the page stays visible above it. */
export function InputDock({ theme, text, onChangeText, onSend, onKey, onScroll, onClose, enabled }: {
  theme: Theme; text: string; onChangeText: (value: string) => void; onSend: () => void; onKey: (key: DockKey) => void; onScroll: (direction: -1 | 1) => void; onClose: () => void; enabled: boolean;
}) {
  const { colors } = theme;
  const key = (id: string, label: string, onPress: () => void, icon?: string): ReactNode => <Pressable key={id} testID={id} accessibilityRole="button" accessibilityLabel={label} disabled={!enabled} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }}
    style={state => ({ flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: control.sm, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: (state as Interaction).hovered || state.pressed ? colors.surface1 : 'transparent', opacity: enabled ? 1 : 0.45 })}>
    {icon ? <Icon name={icon} size={13} color={colors.foregroundMuted} /> : null}
    <Text style={{ color: colors.foreground, fontSize: fontSize.small }}>{label}</Text>
  </Pressable>;
  return <View testID="server-browser-input-dock" style={{ gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderTopWidth: hairline, borderTopColor: colors.border, backgroundColor: colors.surface0 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <TextInput autoFocus testID="server-browser-input" accessibilityLabel={t("browserChrome.textToEnterOnThePage")} value={text} onChangeText={onChangeText} editable={enabled} onSubmitEditing={onSend}
        placeholder={t("browserChrome.textToEnterOnThePage2")} placeholderTextColor={colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} returnKeyType="send"
        style={{ flex: 1, minWidth: 0, height: control.md, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.surface2, color: colors.foreground, fontSize: fontSize.body, ...noFocusRing }} />
      <Button theme={theme} label={t("browserChrome.enterText")} variant="primary" size="sm" disabled={!enabled || !text} testID="server-browser-send" onPress={onSend} />
      <IconButton theme={theme} icon="X" label={t("browserChrome.collapseInput")} size="sm" testID="server-browser-input-close" onPress={onClose} />
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: 'row', gap: space.xs + 2 }}>
      {keys.map(item => key(`server-browser-key-${item.key}`, item.label, () => onKey(item.key)))}
      {key('server-browser-scroll-up', t("browserChrome.scrollUp"), () => onScroll(-1), 'ArrowUp')}
      {key('server-browser-scroll-down', t("browserChrome.scrollDown"), () => onScroll(1), 'ArrowDown')}
    </ScrollView>
  </View>;
}
