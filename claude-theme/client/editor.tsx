import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import type { PluginTheme, PluginThemeColors } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { maxChroma, oklch } from "../shared/color.ts";
import {
  accentLightness,
  contrastReport,
  CUSTOM_THEME_ID,
  DEFAULT_CUSTOM,
  matchingPreset,
  MAX_SURFACE_CHROMA,
  normalizeParam,
  paletteInUse,
  PARAM_RANGES,
  SURFACE_SWATCH_LIGHTNESS,
  stepParam,
  customColors,
  type Appearance,
  type CustomParams,
  type NumericParam,
} from "../shared/custom.ts";
import { resolveHostSurfaces, type ContrastCheck } from "../shared/palette.ts";
import { t, type MessageId } from "../shared/text.ts";
import { Ping, Pop, useChangeCount } from "./motion";
import { liveThemeFor, type LiveState, type LiveTheme, type SaveIo } from "./live-theme.ts";
import { useScrollKeeper } from "./scroll-keeper.ts";
import type { Slot } from "./slot.ts";

/**
 * The custom theme's settings screen: a live preview of the palette, one slider (with − and + steppers) per parameter,
 * the eight colours and the contrast matrix the fixed themes are tested against. While a slider is dragged the screen
 * previews on its own; letting go saves to the host and applies the theme to the app (Paseo's web app rebuilds its
 * views when the selected theme changes, which would end the drag), and every device of the host follows.
 */
export interface CustomThemeScreenProps extends PluginSurfaceProps {
  /** The resident custom theme slot (`index.client.tsx`). */
  slot?: Slot;
  /** The setting's read, write and reset calls (`ui-chunk.client.tsx`). */
  io?: SaveIo;
}

// react-native-web turns `pointerEvents` into CSS only inside StyleSheet.create.
const styles = StyleSheet.create({
  passThrough: { pointerEvents: "none" },
  tabular: { fontVariant: ["tabular-nums"] },
});

const noopSubscribe = () => () => undefined;
const idleState = (): LiveState => ({ params: DEFAULT_CUSTOM, saved: null, loading: true, saving: false, error: null });

function useLiveState(live: LiveTheme | undefined): LiveState {
  return useSyncExternalStore(live ? live.subscribe : noopSubscribe, live ? live.state : idleState, live ? live.state : idleState);
}

export function CustomThemeScreen({ slot, io, theme, layout }: CustomThemeScreenProps) {
  const live = slot && io ? liveThemeFor(slot, io) : undefined;
  const state = useLiveState(live);
  // The slider being dragged, until it is let go.
  const [draft, setDraft] = useState<CustomParams | null>(null);
  const params = draft ?? state.params;
  const keeper = useScrollKeeper();
  const compact = layout.compact;
  const colors = useMemo(() => customColors(params), [params]);
  const contribution = useMemo(() => ({ id: CUSTOM_THEME_ID, name: t("boot.customThemeName"), appearance: params.appearance, colors }), [colors, params.appearance]);
  const report = useMemo(() => contrastReport(contribution), [contribution]);
  const inUse = paletteInUse(theme.colors, colors) && matchingPreset(colors) === null;

  if (!live) return null;
  const preview = (next: CustomParams) => setDraft(next);
  const commit = (next: CustomParams) => {
    keeper.remember();
    setDraft(null);
    void live.save(next);
  };
  const host = theme.colors;
  return (
    <View ref={keeper.ref} style={{ gap: 20 }}>
      <Text style={{ color: host.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{t("custom.intro")}</Text>
      <PreviewCard colors={colors} appearance={params.appearance} inUse={inUse} theme={theme} compact={compact} />
      <SettingsSection title={t("custom.colorsTitle")}>
        <SettingsCard>
          <AppearanceRow value={params.appearance} theme={theme} onChange={(appearance) => commit({ ...live.state().params, appearance })} />
          <ParamRow name="surfaceHue" params={params} theme={theme} onPreview={preview} onCommit={commit} live={live} />
          <ParamRow name="surfaceTint" params={params} theme={theme} onPreview={preview} onCommit={commit} live={live} />
          <ParamRow name="accentHue" params={params} theme={theme} onPreview={preview} onCommit={commit} live={live} />
          <ParamRow name="accentVividness" params={params} theme={theme} onPreview={preview} onCommit={commit} live={live} />
          <ActionsRow state={state} theme={theme} onShuffle={() => commit(shuffle(live.state().params))} onReset={() => commit({ ...DEFAULT_CUSTOM })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("custom.paletteTitle")}>
        <SettingsCard>
          <Swatches colors={colors} theme={theme} compact={compact} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("checks.title")}>
        <SettingsCard>
          <ContrastSummary failed={report.failed.length} total={report.checks.length} theme={theme} />
          <ContrastMatrix checks={report.checks} theme={theme} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

// --- Preview -------------------------------------------------------------------------------------------------------

function PreviewCard({ colors, appearance, inUse, theme, compact }: { colors: PluginThemeColors; appearance: Appearance; inUse: boolean; theme: PluginTheme; compact: boolean }) {
  const host = theme.colors;
  const status = inUse ? host.statusSuccess : host.statusWarning;
  return (
    <View style={{ gap: 10 }}>
      <MiniApp colors={colors} appearance={appearance} compact={compact} />
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }} accessibilityLiveRegion="polite">
        <View style={{ width: 10, height: 10, marginTop: 5, flexShrink: 0 }}>
          <Ping size={10} color={status} active={inUse} />
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: status }} />
        </View>
        <Text style={{ flexShrink: 1, color: host.foreground, fontSize: 14, lineHeight: 20 }}>
          {inUse ? t("custom.inUse") : t("custom.notInUse", { name: t("boot.customThemeName") })}
        </Text>
      </View>
    </View>
  );
}

/** A small Paseo window in the custom palette, painted with the host's real surface mapping (`resolveHostSurfaces`). */
function MiniApp({ colors, appearance, compact }: { colors: PluginThemeColors; appearance: Appearance; compact: boolean }) {
  const surfaces = resolveHostSurfaces({ id: CUSTOM_THEME_ID, name: "", appearance, colors });
  const small = { fontSize: 11, lineHeight: 15 } as const;
  const row = (label: MessageId, time: MessageId, selected: boolean) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6, backgroundColor: selected ? surfaces.surfaceSidebarSelected : "transparent" }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: selected ? surfaces.accent : surfaces.foregroundExtraMuted }} />
      <Text numberOfLines={1} style={[small, { flexShrink: 1, flexGrow: 1, color: selected ? surfaces.foreground : surfaces.foregroundMuted }]}>{t(label)}</Text>
      {compact ? null : <Text style={[small, { color: surfaces.foregroundExtraMuted }]}>{t(time)}</Text>}
    </View>
  );
  return (
    <View accessible accessibilityLabel={t("preview.label")} style={{ flexDirection: "row", height: compact ? 196 : 210, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: colors.border, backgroundColor: surfaces.surface0 }}>
      <View style={{ width: compact ? 112 : 168, backgroundColor: surfaces.surfaceSidebar, paddingVertical: 10, paddingHorizontal: 6, gap: 4, borderRightWidth: 1, borderRightColor: colors.border }}>
        <Text style={[small, { color: surfaces.foregroundExtraMuted, paddingHorizontal: 6, marginBottom: 2 }]}>{t("preview.agents")}</Text>
        {row("preview.rowOne", "preview.timeOne", false)}
        {row("preview.rowTwo", "preview.timeTwo", true)}
        {row("preview.rowThree", "preview.timeThree", false)}
      </View>
      <View style={{ flexGrow: 1, flexShrink: 1, backgroundColor: surfaces.surfaceWorkspace, padding: 10, gap: 8 }}>
        <View style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: surfaces.userBubble, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text numberOfLines={1} style={[small, { color: surfaces.foreground }]}>{t("preview.userMessage")}</Text>
        </View>
        <View style={{ gap: 4 }}>
          <Text numberOfLines={1} style={{ color: surfaces.foreground, fontSize: 13, fontWeight: "600" }}>{t("preview.cardTitle")}</Text>
          <Text numberOfLines={2} style={[small, { color: surfaces.foregroundMuted }]}>{t("preview.cardBody")}</Text>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
            <View style={{ backgroundColor: surfaces.accent, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}>
              <Text style={[small, { color: surfaces.accentForeground, fontWeight: "600" }]}>{t("preview.approve")}</Text>
            </View>
            <View style={{ backgroundColor: surfaces.input, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: colors.border }}>
              <Text style={[small, { color: surfaces.foreground }]}>{t("preview.details")}</Text>
            </View>
          </View>
        </View>
        <View style={{ marginTop: "auto", backgroundColor: surfaces.input, borderRadius: 8, borderWidth: 1, borderColor: surfaces.ring, paddingHorizontal: 10, paddingVertical: 7 }}>
          <Text numberOfLines={1} style={[small, { color: surfaces.surface4 }]}>{t("preview.placeholder")}</Text>
        </View>
      </View>
    </View>
  );
}

// --- Controls ------------------------------------------------------------------------------------------------------

function AppearanceRow({ value, theme, onChange }: { value: Appearance; theme: PluginTheme; onChange(value: Appearance): void }) {
  const host = theme.colors;
  const option = (appearance: Appearance, icon: string, label: MessageId) => {
    const selected = appearance === value;
    return (
      <Pressable
        accessibilityRole="radio"
        aria-checked={selected}
        accessibilityLabel={t(label)}
        onPress={() => (selected ? undefined : onChange(appearance))}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 8,
          backgroundColor: selected ? host.accent : "transparent",
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <Icon name={icon} size={15} color={selected ? host.accentForeground : host.foregroundMuted} />
        <Text style={{ color: selected ? host.accentForeground : host.foreground, fontSize: 14, fontWeight: selected ? "600" : "normal" }}>{t(label)}</Text>
      </Pressable>
    );
  };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 16 }}>
      <Text style={{ color: host.foreground, fontSize: 15 }}>{t("custom.appearance")}</Text>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 4, padding: 3, borderRadius: 10, backgroundColor: host.surface2 }}>
        {option("dark", "Moon", "custom.dark")}
        {option("light", "Sun", "custom.light")}
      </View>
    </View>
  );
}

const LABELS: { readonly [Name in NumericParam]: MessageId } = {
  surfaceHue: "custom.surfaceHue",
  surfaceTint: "custom.surfaceTint",
  accentHue: "custom.accentHue",
  accentVividness: "custom.accentVividness",
};
const HINTS: { readonly [Name in NumericParam]: MessageId } = {
  surfaceHue: "custom.surfaceHueHint",
  surfaceTint: "custom.surfaceTintHint",
  accentHue: "custom.accentHueHint",
  accentVividness: "custom.accentVividnessHint",
};

/** The colour a track segment shows for `value` of `name`, the other parameters as they are. */
function sampleColor(name: NumericParam, value: number, params: CustomParams): string {
  if (name === "surfaceHue") return oklch(0.62, 0.11, value);
  if (name === "surfaceTint") return oklch(SURFACE_SWATCH_LIGHTNESS[params.appearance], (value / 100) * MAX_SURFACE_CHROMA, params.surfaceHue);
  const hue = name === "accentHue" ? value : params.accentHue;
  const vividness = name === "accentVividness" ? value : params.accentVividness;
  const lightness = accentLightness(params.appearance, hue) ?? 0.542;
  return oklch(lightness, (vividness / 100) * maxChroma(lightness, hue), hue);
}

const SEGMENTS: { readonly [Name in NumericParam]: number } = { surfaceHue: 24, surfaceTint: 11, accentHue: 24, accentVividness: 11 };

/** Track colours depend only on the parameters the track does not move, so dragging never recomputes its own track. */
function trackKey(name: NumericParam, params: CustomParams): string {
  if (name === "surfaceHue") return "hue";
  if (name === "surfaceTint") return `${params.appearance}:${params.surfaceHue}`;
  if (name === "accentHue") return `${params.appearance}:${params.accentVividness}`;
  return `${params.appearance}:${params.accentHue}`;
}

function ParamRow({ name, params, theme, onPreview, onCommit, live }: {
  name: NumericParam;
  params: CustomParams;
  theme: PluginTheme;
  onPreview(next: CustomParams): void;
  onCommit(next: CustomParams): void;
  live: LiveTheme;
}) {
  const host = theme.colors;
  const range = PARAM_RANGES[name];
  const value = params[name];
  const label = t(LABELS[name]);
  const trackId = trackKey(name, params);
  const track = useMemo(() => {
    const count = SEGMENTS[name];
    return Array.from({ length: count }, (_, index) => sampleColor(name, range.min + ((range.max - range.min) * index) / (count - 1), params));
    // The key names exactly what the colours depend on.
  }, [name, trackId]);
  const valueText = name === "surfaceHue" || name === "accentHue" ? t("custom.degrees", { value }) : t("custom.percent", { value });
  const with_ = (next: number): CustomParams => ({ ...live.state().params, [name]: normalizeParam(name, next) ?? value });
  const step = (direction: 1 | -1) => onCommit(stepParam(live.state().params, name, direction));
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <Text style={{ color: host.foreground, fontSize: 15 }}>{label}</Text>
          <Text style={{ color: host.foregroundMuted, fontSize: 13 }}>{t(HINTS[name])}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: sampleColor(name, value, params), borderWidth: 1, borderColor: host.border }} />
          <Text style={[styles.tabular, { color: host.foreground, fontSize: 15, fontWeight: "600", minWidth: 44, textAlign: "right" }]}>{valueText}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <StepButton icon="Minus" label={t("custom.decrease", { label })} theme={theme} disabled={!range.wrap && value <= range.min} onPress={() => step(-1)} />
        <Slider
          value={value}
          min={range.min}
          max={range.max}
          track={track}
          thumb={sampleColor(name, value, params)}
          label={label}
          valueText={valueText}
          theme={theme}
          onPreview={(next) => onPreview(with_(next))}
          onCommit={(next) => onCommit(with_(next))}
          onStep={step}
        />
        <StepButton icon="Plus" label={t("custom.increase", { label })} theme={theme} disabled={!range.wrap && value >= range.max} onPress={() => step(1)} />
      </View>
    </View>
  );
}

function StepButton({ icon, label, theme, disabled, onPress }: { icon: string; label: string; theme: PluginTheme; disabled: boolean; onPress(): void }) {
  const host = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? host.border : host.surface2,
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
      })}
    >
      <Icon name={icon} size={16} color={host.foreground} />
    </Pressable>
  );
}

/**
 * A horizontal slider over a strip of sample colours. Touch or click anywhere on the strip and drag; the children
 * ignore the pointer, so positions are measured on the strip itself. Screen readers get an adjustable control.
 */
function Slider({ value, min, max, track, thumb, label, valueText, theme, onPreview, onCommit, onStep }: {
  value: number;
  min: number;
  max: number;
  track: readonly string[];
  thumb: string;
  label: string;
  valueText: string;
  theme: PluginTheme;
  onPreview(value: number): void;
  onCommit(value: number): void;
  onStep(direction: 1 | -1): void;
}) {
  const host = theme.colors;
  const width = useRef(1);
  const start = useRef(0);
  const last = useRef(value);
  const handlers = useRef({ onPreview, onCommit });
  handlers.current = { onPreview, onCommit };
  const [dragging, setDragging] = useState(false);
  const at = (fraction: number) => Math.round(min + Math.min(1, Math.max(0, fraction)) * (max - min));
  // A horizontal drag moves the value; a tap jumps to where it landed. A vertical swipe that starts on the strip is the
  // page scrolling: it changes nothing and hands the gesture to the scroller.
  const sliding = useRef(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: (event) => {
          start.current = event.nativeEvent.locationX / width.current;
          last.current = at(start.current);
          sliding.current = false;
        },
        onPanResponderMove: (_event, gesture) => {
          if (!sliding.current) {
            if (Math.abs(gesture.dx) < 4 || Math.abs(gesture.dx) < Math.abs(gesture.dy)) return;
            sliding.current = true;
            setDragging(true);
          }
          const next = at(start.current + gesture.dx / width.current);
          if (next === last.current) return;
          last.current = next;
          handlers.current.onPreview(next);
        },
        onPanResponderRelease: () => {
          sliding.current = false;
          setDragging(false);
          handlers.current.onCommit(last.current);
        },
        onPanResponderTerminate: () => {
          const slid = sliding.current;
          sliding.current = false;
          setDragging(false);
          if (slid) handlers.current.onCommit(last.current);
        },
        onPanResponderTerminationRequest: () => !sliding.current,
        onShouldBlockNativeResponder: () => true,
      }),
    [min, max],
  );
  const fraction = max > min ? (value - min) / (max - min) : 0;
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: valueText }}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => onStep(event.nativeEvent.actionName === "increment" ? 1 : -1)}
      onLayout={(event: LayoutChangeEvent) => {
        width.current = Math.max(1, event.nativeEvent.layout.width);
      }}
      style={{ flexGrow: 1, flexShrink: 1, height: 36, justifyContent: "center" }}
    >
      <View style={[styles.passThrough, { height: 14, borderRadius: 7, overflow: "hidden", flexDirection: "row", borderWidth: 1, borderColor: host.border }]}>
        {track.map((colour, index) => (
          <View key={index} style={[styles.passThrough, { flexGrow: 1, flexBasis: 0, backgroundColor: colour }]} />
        ))}
      </View>
      <View
        style={[
          styles.passThrough,
          {
            position: "absolute",
            left: `${fraction * 100}%`,
            marginLeft: dragging ? -13 : -11,
            width: dragging ? 26 : 22,
            height: dragging ? 26 : 22,
            borderRadius: 13,
            borderWidth: 3,
            borderColor: host.foreground,
            backgroundColor: thumb,
          },
        ]}
      />
    </View>
  );
}

const random = (min: number, max: number, step: number) => min + step * Math.floor(Math.random() * (Math.floor((max - min) / step) + 1));

/** A fresh vivid combination in the same appearance: tinted surfaces and an accent across the wheel from them. */
export function shuffle(params: CustomParams): CustomParams {
  const surfaceHue = random(0, 355, 5);
  return {
    appearance: params.appearance,
    surfaceHue,
    surfaceTint: random(35, 85, 5),
    accentHue: (surfaceHue + random(120, 240, 5)) % 360,
    accentVividness: random(70, 100, 5),
  };
}

function ActionsRow({ state, theme, onShuffle, onReset }: { state: LiveState; theme: PluginTheme; onShuffle(): void; onReset(): void }) {
  const host = theme.colors;
  const button = (icon: string, label: MessageId, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(label)}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: host.border, backgroundColor: pressed ? host.surface2 : "transparent" })}
    >
      <Icon name={icon} size={15} color={host.foreground} />
      <Text style={{ color: host.foreground, fontSize: 14 }}>{t(label)}</Text>
    </Pressable>
  );
  const status = state.error
    ? { colour: host.statusDanger, text: t(state.error.kind === "save" ? "custom.saveFailed" : "custom.readFailed", { error: state.error.message }) }
    : state.saving
      ? { colour: host.foregroundMuted, text: t("custom.saving") }
      : state.loading
        ? { colour: host.foregroundMuted, text: t("custom.loading") }
        : { colour: host.foregroundMuted, text: t("custom.saved") };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 16 }}>
      <Text accessibilityLiveRegion="polite" accessibilityRole={state.error ? "alert" : "text"} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, color: status.colour, fontSize: 13, lineHeight: 18 }}>
        {status.text}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {button("Shuffle", "custom.shuffle", onShuffle)}
        {button("RotateCcw", "custom.reset", onReset)}
      </View>
    </View>
  );
}

// --- Palette -------------------------------------------------------------------------------------------------------

const SWATCHES: readonly { token: keyof PluginThemeColors; label: MessageId }[] = [
  { token: "background", label: "swatch.background" },
  { token: "raised", label: "swatch.raised" },
  { token: "control", label: "swatch.control" },
  { token: "border", label: "swatch.border" },
  { token: "foreground", label: "swatch.foreground" },
  { token: "mutedForeground", label: "swatch.mutedForeground" },
  { token: "ring", label: "swatch.ring" },
  { token: "accent", label: "swatch.accent" },
];

function Swatches({ colors, theme, compact }: { colors: PluginThemeColors; theme: PluginTheme; compact: boolean }) {
  const host = theme.colors;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, padding: 16 }}>
      {SWATCHES.map(({ token, label }) => (
        <View key={token} style={{ width: "21%", flexGrow: 1, gap: 6 }}>
          <View style={{ height: compact ? 40 : 48, borderRadius: 8, backgroundColor: colors[token], borderWidth: 1, borderColor: host.border }} />
          <Text numberOfLines={1} style={{ color: host.foreground, fontSize: 12 }}>{t(label)}</Text>
          <Text selectable style={[styles.tabular, { color: host.foregroundMuted, fontSize: 12 }]}>{colors[token]}</Text>
        </View>
      ))}
    </View>
  );
}

// --- Contrast ------------------------------------------------------------------------------------------------------

function ContrastSummary({ failed, total, theme }: { failed: number; total: number; theme: PluginTheme }) {
  const host = theme.colors;
  const ok = failed === 0;
  const colour = ok ? host.statusSuccess : host.statusDanger;
  const changes = useChangeCount(String(failed), 0);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
      <Pop count={changes} size={36}>
        <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colour }}>
          <Icon name={ok ? "Check" : "X"} size={20} color={host.surface0} />
        </View>
      </Pop>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: colour, fontSize: 16, fontWeight: "700" }}>
          {ok ? t("checks.allPass", { total }) : t("checks.someFail", { count: failed, total })}
        </Text>
        <Text style={{ color: host.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{t("checks.explain")}</Text>
      </View>
    </View>
  );
}

const SURFACE_LABELS: { readonly [surface: string]: MessageId } = {
  workspace: "checks.workspace",
  sidebar: "checks.sidebar",
  "sidebar-selected": "checks.sidebarSelected",
  popover: "checks.popover",
  input: "checks.input",
  "user-bubble": "checks.userBubble",
  badge: "checks.badge",
  terminal: "checks.terminal",
  button: "checks.button",
};
const TOKEN_LABELS: { readonly [token: string]: MessageId } = {
  foreground: "checks.foreground",
  muted: "checks.muted",
  ring: "checks.ring",
  accent: "checks.accent",
  button: "checks.buttonText",
};

/** `foreground-on-sidebar-selected` → token `foreground`, surface `sidebar-selected`; the button check stands alone. */
function splitCheck(check: ContrastCheck): { token: string; surface: string } {
  if (check.id === "accent-button") return { token: "button", surface: "button" };
  const at = check.id.indexOf("-on-");
  return at < 0 ? { token: check.id, surface: check.id } : { token: check.id.slice(0, at), surface: check.id.slice(at + 4) };
}

function ContrastMatrix({ checks, theme }: { checks: readonly ContrastCheck[]; theme: PluginTheme }) {
  const host = theme.colors;
  const groups: { surface: string; checks: ContrastCheck[] }[] = [];
  for (const check of checks) {
    const { surface } = splitCheck(check);
    const group = groups.find((entry) => entry.surface === surface);
    if (group) group.checks.push(check);
    else groups.push({ surface, checks: [check] });
  }
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
      {groups.map((group) => (
        <View key={group.surface} style={{ gap: 6 }}>
          <Text style={{ color: host.foregroundMuted, fontSize: 12 }}>{t(SURFACE_LABELS[group.surface] ?? "checks.workspace")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {group.checks.map((check) => (
              <CheckChip key={check.id} check={check} theme={theme} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function CheckChip({ check, theme }: { check: ContrastCheck; theme: PluginTheme }) {
  const host = theme.colors;
  const { token } = splitCheck(check);
  const tokenLabel = t(TOKEN_LABELS[token] ?? "checks.foreground");
  const colour = check.pass ? host.statusSuccess : host.statusDanger;
  const ratio = check.ratio.toFixed(1);
  const floor = String(check.minRatio);
  return (
    <View
      accessible
      accessibilityLabel={t(check.pass ? "checks.chipPass" : "checks.chipFail", { token: tokenLabel, ratio, floor })}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8, borderRadius: 8, borderWidth: 1.5, borderColor: colour, overflow: "hidden" }}
    >
      <View style={{ paddingHorizontal: 7, paddingVertical: 4, backgroundColor: check.surface }}>
        <Text style={{ color: check.foreground, fontSize: 13, fontWeight: "700" }}>Aa</Text>
      </View>
      <Text numberOfLines={1} style={{ color: host.foreground, fontSize: 12 }}>{tokenLabel}</Text>
      <Text style={[styles.tabular, { color: colour, fontSize: 12, fontWeight: "700" }]}>{t("checks.ratio", { ratio })}</Text>
      <Icon name={check.pass ? "Check" : "X"} size={13} color={colour} />
      {check.pass ? null : <Text style={[styles.tabular, { color: colour, fontSize: 11 }]}>{t("checks.needs", { floor })}</Text>}
    </View>
  );
}
