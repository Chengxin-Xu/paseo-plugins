import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type DimensionValue, type TextInput as NativeTextInput, type StyleProp, type ViewStyle } from "react-native";
import { INBOX_PROJECT_ID, type BoardItem, type BoardProject, type NoteFields, type NoteKind, type TaskStatus } from "../shared/board";
import { Button, IconButton, ProjectMark, control, fontSize, hairline, hue, radius, relativeTime, space, toneColor, type Hue, type Tone } from "./kit";

export const KINDS: NoteKind[] = ["task", "prompt", "idea"];
export const KIND_LABELS: Record<NoteKind, string> = { task: "任务", prompt: "提示词", idea: "想法" };
export const KIND_ICONS: Record<NoteKind, string> = { task: "SquareCheck", prompt: "MessageSquareText", idea: "Lightbulb" };
/** Fixed category colors: the same in tabs, the editor, list marks and empty states. */
export const KIND_TONES: Record<NoteKind, Hue> = { task: "blue", prompt: "violet", idea: "amber" };
export const STATUSES: TaskStatus[] = ["todo", "doing", "done"];
export const STATUS_LABELS: Record<TaskStatus, string> = { todo: "待办", doing: "进行中", done: "已完成" };
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = { todo: "doing", doing: "done", done: "todo" };
/** Grey → blue → green, like running and done everywhere else in Paseo's plugins. */
export const STATUS_TONES: Record<TaskStatus, Tone> = { todo: "neutral", doing: "info", done: "success" };
/** 重点 is red and 置顶 amber: attention colors, which the kit keeps out of project marks. */
export const MARK_HUES = { high: "red", pinned: "amber" } as const satisfies Record<string, Hue>;
export const ALL_PROJECT_ID = "__all_projects__";

/** The server lists boards whose Paseo project was removed under this path. */
const RETIRED_PATH = "项目已移除，手记仍保留";
export function statusColor(theme: PluginTheme, status: TaskStatus) { return toneColor(theme, STATUS_TONES[status], "mark"); }
/** Colored text for a status label; 待办 keeps the regular text color. */
export function statusText(theme: PluginTheme, status: TaskStatus) { return status === "todo" ? theme.colors.foreground : toneColor(theme, STATUS_TONES[status]); }
/** One-line preview of a body: whitespace and list markers collapse, so two lines show two lines of content. */
export function excerpt(body: string) { return body.replace(/(^|\n)\s*(?:[-*•]|\d+[.)、])\s+/g, "$1").replace(/\s+/g, " ").trim(); }
export const itemKey = (item: Pick<BoardItem, "projectId" | "id">) => `${item.projectId}:${item.id}`;

type Interaction = { pressed: boolean; hovered?: boolean };
/** Compiled, not inline: react-native-web only polyfills box-none / none for StyleSheet styles. */
export const touch = StyleSheet.create({ through: { pointerEvents: "box-none" }, ignore: { pointerEvents: "none" } });
const hover = (state: unknown) => state as Interaction;

/** Row and card callbacks receive the item; the object must be referentially stable so memoized rows skip re-rendering. */
export interface NoteActions {
  open(item: BoardItem): void; start(item: BoardItem): void; edit(item: BoardItem): void; copy(item: BoardItem): void;
  remove(item: BoardItem): void; restore(item: BoardItem): void; status(item: BoardItem, status: TaskStatus): void;
  update(item: BoardItem, fields: Partial<NoteFields>): void;
}

/** A secondary-button look with a trailing chevron: opens a picker (project scope, select fields). `leading` replaces `icon` (project marks). */
export function PickerButton({ theme, icon, leading, label, onPress, disabled = false, accessibilityLabel, trailingIcon = "ChevronDown", block = false, maxWidth, placeholder = false, expanded }: {
  theme: PluginTheme; icon?: string; leading?: ReactNode; label: string; onPress: () => void; disabled?: boolean; accessibilityLabel?: string; trailingIcon?: string; block?: boolean; maxWidth?: DimensionValue; placeholder?: boolean; expanded?: boolean;
}) {
  const { colors } = theme;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled, ...(expanded === undefined ? {} : { expanded }) }} disabled={disabled} onPress={onPress} hitSlop={{ top: 8, bottom: 8 }}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: block ? 36 : control.md, paddingHorizontal: space.md - 2, borderRadius: radius.md, backgroundColor: colors.surface2, flexShrink: 1, minWidth: 0, ...(maxWidth !== undefined ? { maxWidth } : {}), ...(block ? { alignSelf: "stretch", borderWidth: 1, borderColor: colors.border } : {}), opacity: disabled ? 0.6 : hover(state).pressed ? 0.8 : 1 })}>
    {leading ?? (icon ? <Icon name={icon} size={16} color={colors.foregroundMuted} /> : null)}
    <Text numberOfLines={1} style={{ flexShrink: 1, ...(block ? { flex: 1 } : {}), color: placeholder ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.body }}>{label}</Text>
    <Icon name={trailingIcon} size={14} color={colors.foregroundMuted} />
  </Pressable>;
}

/** The compact form of the primary "新建" button: same accent fill, icon only. */
export function PrimaryIconButton({ theme, icon, label, onPress, disabled = false }: { theme: PluginTheme; icon: string; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
    style={state => ({ width: control.md, height: control.md, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: theme.colors.accent, opacity: disabled ? 0.45 : hover(state).pressed ? 0.8 : 1 })}>
    <Icon name={icon} size={16} color={theme.colors.accentForeground} />
  </Pressable>;
}

/**
 * 待办 a grey ring, 进行中 a blue ring filled halfway, 已完成 a filled green disc with a check. Drawn rather than
 * Lucide outlines so the states differ in shape as well as color, and look the same on cards, headers and controls.
 */
export function StatusGlyph({ theme, status, size = 16 }: { theme: PluginTheme; status: TaskStatus; size?: number }) {
  const color = statusColor(theme, status), ring = size - 2, stroke = size >= 14 ? 1.5 : 1.25, fill = ring - 2 * stroke - 3;
  const disc: ViewStyle = { width: ring, height: ring, borderRadius: ring / 2, alignItems: "center", justifyContent: "center" };
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    {status === "done" ? <View style={[disc, { backgroundColor: color }]}><Icon name="Check" size={Math.round(ring * 0.72)} color={theme.colors.surface0} /></View>
      : <View style={[disc, { borderWidth: stroke, borderColor: color }]}>
        {status === "doing" ? <View style={{ width: fill / 2, height: fill, marginLeft: fill / 2, borderTopRightRadius: fill / 2, borderBottomRightRadius: fill / 2, backgroundColor: color }} /> : null}
      </View>}
  </View>;
}

export function KindIcon({ theme, kind, size = 16 }: { theme: PluginTheme; kind: NoteKind; size?: number }) {
  return <Icon name={KIND_ICONS[kind]} size={size} color={toneColor(theme, KIND_TONES[kind], "mark")} />;
}

type ScopeProject = Pick<BoardProject, "id" | "name" | "path">;
/**
 * Who a note belongs to: the kit `ProjectMark` (the project's color in every plugin), a fixed inbox tile for 随手记,
 * a grey tile for removed projects and a stack for 全部项目.
 */
export function ScopeMark({ theme, project, size = 18 }: { theme: PluginTheme; project: ScopeProject; size?: number }) {
  if (project.id === ALL_PROJECT_ID) return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}><Icon name="Layers" size={Math.min(16, size)} color={theme.colors.foregroundMuted} /></View>;
  const inbox = project.id === INBOX_PROJECT_ID;
  if (!inbox && project.path !== RETIRED_PATH) return <ProjectMark theme={theme} name={project.name} size={size} />;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, inbox ? "cyan" : "gray") }}>
    <Icon name={inbox ? "Inbox" : "FolderX"} size={Math.round(size * 0.68)} color="#ffffff" />
  </View>;
}

/** Task status glyph that advances 待办 → 进行中 → 已完成 (→ 待办) on tap. */
export function StatusToggle({ theme, item, onPress, disabled = false }: { theme: PluginTheme; item: BoardItem; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}：移到${STATUS_LABELS[NEXT_STATUS[item.status]]}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={10}
    style={state => ({ width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: radius.full, backgroundColor: hover(state).hovered && !disabled ? theme.colors.surface2 : "transparent", opacity: disabled ? 0.5 : hover(state).pressed ? 0.6 : 1 })}>
    <StatusGlyph theme={theme} status={item.status} />
  </Pressable>;
}

const metaText = (theme: PluginTheme) => ({ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 });
/** "📌 🚩重点 · ▣ 项目 · 2 小时前": pin and flag in their colors, the project's mark before its name. */
export function NoteMeta({ theme, item, project }: { theme: PluginTheme; item: BoardItem; project?: ScopeProject | null }) {
  const trashed = item.deletedAt !== null, high = item.priority === "high" && !trashed, text = metaText(theme);
  const dot = <Text style={text}>·</Text>;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 1, minWidth: 0 }}>
    {item.pinned && !trashed ? <Icon name="Pin" size={12} color={hue(theme, MARK_HUES.pinned)} /> : null}
    {high ? <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Icon name="Flag" size={12} color={hue(theme, MARK_HUES.high)} />
      <Text style={[text, { color: hue(theme, MARK_HUES.high, "text"), fontWeight: "500" }]}>重点</Text>
    </View> : null}
    {high ? dot : null}
    {project ? <>
      <ScopeMark theme={theme} project={project} size={14} />
      <Text numberOfLines={1} style={[text, { flexShrink: 1 }]}>{project.name}</Text>
      {dot}
    </> : null}
    <Text numberOfLines={1} style={[text, { flexShrink: 0 }]}>{trashed ? `删除于 ${relativeTime(item.deletedAt)}` : relativeTime(item.updatedAt)}</Text>
  </View>;
}

/**
 * Whole-item press target that can hold its own buttons: react-native-web renders buttons as <button>, which must not
 * nest, so the pressable fills the frame behind the content and the content passes touches through except its controls.
 */
function PressableFrame({ theme, label, onPress, selected = false, selectedColor, base = "transparent", hovered, style, children }: {
  theme: PluginTheme; label: string; onPress: () => void; selected?: boolean; selectedColor?: string; base?: string; hovered: string; style?: StyleProp<ViewStyle>; children: ReactNode;
}) {
  return <View style={[{ borderRadius: radius.md, overflow: "hidden" }, style]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress}
      style={state => ({ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: selected ? selectedColor ?? theme.colors.surface2 : hover(state).hovered || hover(state).pressed ? hovered : base })} />
    <View style={[touch.through, { flexDirection: "row", alignItems: "flex-start", gap: 10 }]}>{children}</View>
  </View>;
}

function NoteText({ theme, item, project, previewLines }: { theme: PluginTheme; item: BoardItem; project: ScopeProject | null; previewLines: number }) {
  const { colors } = theme, done = item.kind === "task" && item.status === "done" && item.deletedAt === null;
  const preview = done ? "" : excerpt(item.body);
  return <View aria-hidden style={[touch.ignore, { flex: 1, minWidth: 0, gap: 3 }]}>
    <Text numberOfLines={2} style={{ color: done ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.body, lineHeight: 20, fontWeight: "500" }}>{item.title}</Text>
    {preview ? <Text numberOfLines={previewLines} style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{preview}</Text> : null}
    <View style={{ paddingTop: 1 }}><NoteMeta theme={theme} item={item} project={project} /></View>
  </View>;
}

/** Board card: status glyph (the one inline action), title, a short excerpt and the colored meta. Tap opens the detail. */
export const NoteCard = memo(function NoteCard({ theme, item, project, busy, actions }: { theme: PluginTheme; item: BoardItem; project: ScopeProject | null; busy: boolean; actions: NoteActions }) {
  const { colors } = theme;
  return <PressableFrame theme={theme} label={item.title} onPress={() => actions.open(item)} base={colors.surface1} hovered={colors.surface2} style={{ borderWidth: 1, borderColor: colors.border }}>
    <View style={{ paddingTop: space.md - 2, paddingLeft: space.md - 2 }}><StatusToggle theme={theme} item={item} disabled={busy} onPress={() => actions.status(item, NEXT_STATUS[item.status])} /></View>
    <View style={[touch.ignore, { flex: 1, minWidth: 0, paddingVertical: space.md - 2, paddingRight: space.md }]}><NoteText theme={theme} item={item} project={project} previewLines={2} /></View>
  </PressableFrame>;
});

/**
 * List row (kit Row metrics): tasks lead with their status glyph, prompts and ideas with their colored kind icon (and
 * a copy button), the trash with the kind icon and a green 恢复. The selected row is tinted with the kind's color.
 */
export const NoteRow = memo(function NoteRow({ theme, item, project, selected = false, busy, actions }: { theme: PluginTheme; item: BoardItem; project: ScopeProject | null; selected?: boolean; busy: boolean; actions: NoteActions }) {
  const { colors } = theme, trashed = item.deletedAt !== null, task = item.kind === "task" && !trashed;
  const leading = task ? <StatusToggle theme={theme} item={item} disabled={busy} onPress={() => actions.status(item, NEXT_STATUS[item.status])} /> : <KindIcon theme={theme} kind={item.kind} />;
  const trailing = trashed ? <View style={{ marginVertical: -space.xs }}><Button theme={theme} label="恢复" icon="RotateCcw" size="sm" tone="success" disabled={busy} accessibilityLabel={`恢复：${item.title}`} onPress={() => actions.restore(item)} /></View>
    : task ? null : <View style={{ marginVertical: -space.xs, marginRight: -space.xs }}><IconButton theme={theme} icon="Copy" size="sm" label={`复制：${item.title}`} onPress={() => actions.copy(item)} /></View>;
  return <PressableFrame theme={theme} label={item.title} onPress={() => actions.open(item)} selected={selected} selectedColor={toneColor(theme, KIND_TONES[item.kind], "soft")} hovered={colors.surface1} style={{ paddingVertical: 10, paddingHorizontal: space.md }}>
    <View style={[touch.through, { minHeight: 20, justifyContent: "center" }]}>{leading}</View>
    <NoteText theme={theme} item={item} project={project} previewLines={task ? 1 : 2} />
    {trailing ? <View style={[touch.through, { minHeight: 20, justifyContent: "center" }]}>{trailing}</View> : null}
  </PressableFrame>;
});

/** Kit `SectionHeader` metrics with a drawn leading mark (status glyph, project mark); `color` tints the title and count. */
export function GroupHeader({ theme, title, count, leading, color, open, onToggle }: {
  theme: PluginTheme; title: string; count?: number; leading?: ReactNode; color?: string; open?: boolean; onToggle?: () => void;
}) {
  const { colors } = theme;
  const label = <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flex: 1, minWidth: 0 }}>
    {onToggle ? <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} /> : null}
    {leading}
    <Text numberOfLines={1} style={{ flexShrink: 1, color: color ?? colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: color ? "600" : "500" }}>{title}</Text>
    {count !== undefined ? <Text style={{ color: color ?? colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"], opacity: 0.8 }}>{count}</Text> : null}
  </View>;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32, paddingHorizontal: space.md, paddingTop: space.sm }}>
    {onToggle ? <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "收起" : "展开"} ${title}`} accessibilityState={{ expanded: open }} onPress={onToggle} style={{ flex: 1 }}>{label}</Pressable> : label}
  </View>;
}

/** The kit `Segmented` for a task's status, with the drawn glyphs; the selected status gets its color as ground and border. */
export function StatusSegmented({ theme, value, onChange }: { theme: PluginTheme; value: TaskStatus; onChange: (status: TaskStatus) => void }) {
  const { colors } = theme;
  return <View accessibilityRole="tablist" accessibilityLabel="状态" style={{ flexDirection: "row", alignSelf: "flex-start", padding: space.xxs, gap: space.xxs, borderRadius: radius.md, backgroundColor: colors.surface2 }}>
    {STATUSES.map(status => {
      const selected = status === value, tinted = selected && status !== "todo";
      // aria-selected too: react-native-web 0.21 drops accessibilityState from the DOM.
      return <Pressable key={status} accessibilityRole="tab" accessibilityLabel={STATUS_LABELS[status]} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onChange(status)} hitSlop={{ top: 6, bottom: 6 }}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: control.md - 2 * space.xxs, paddingHorizontal: 10, borderRadius: radius.sm, borderWidth: selected ? hairline : 0,
          borderColor: tinted ? toneColor(theme, STATUS_TONES[status], "line") : colors.border, backgroundColor: tinted ? toneColor(theme, STATUS_TONES[status], "soft") : selected ? colors.surface0 : hover(state).hovered ? colors.surface1 : "transparent" })}>
        <StatusGlyph theme={theme} status={status} size={14} />
        {/* The label stays text-colored: blue/green on their own tint would miss 4.5:1; ground and glyph carry the color. */}
        <Text numberOfLines={1} style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? "500" : "400" }}>{STATUS_LABELS[status]}</Text>
      </Pressable>;
    })}
  </View>;
}

/** Like the kit TextField, plus length limits, a bounded or filling (grow) multiline height and submit-on-enter. */
export function FormField({ theme, label, value, onChangeText, placeholder, multiline = false, grow = false, minHeight, maxHeight, maxLength, autoFocus = false, editable = true, onSubmitEditing, accessibilityLabel }: {
  theme: PluginTheme; label: string; value: string; onChangeText: (value: string) => void; placeholder?: string; multiline?: boolean; grow?: boolean; minHeight?: number; maxHeight?: number;
  maxLength?: number; autoFocus?: boolean; editable?: boolean; onSubmitEditing?: () => void; accessibilityLabel?: string;
}) {
  const { colors } = theme;
  const input = useRef<NativeTextInput>(null);
  // Focus once the sheet has settled: focusing mid-animation makes web scroll the half-laid-out form.
  useEffect(() => { if (!autoFocus) return; const timer = setTimeout(() => input.current?.focus(), 350); return () => clearTimeout(timer); }, [autoFocus]);
  return <View style={{ gap: space.xs + 2, ...(grow ? { flexGrow: 1 } : {}) }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{label}</Text>
    <TextInput ref={input} accessibilityLabel={accessibilityLabel ?? label} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} multiline={multiline} editable={editable}
      maxLength={maxLength} onSubmitEditing={onSubmitEditing} returnKeyType={multiline ? "default" : "done"} blurOnSubmit={!multiline} textAlignVertical={multiline ? "top" : "center"}
      style={{ color: colors.foreground, backgroundColor: colors.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, minHeight: minHeight ?? (multiline ? 120 : 36), ...(maxHeight ? { maxHeight } : {}), ...(grow ? { flexGrow: 1 } : {}), paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: fontSize.body, lineHeight: 20, opacity: editable ? 1 : 0.6 }} />
  </View>;
}

/** Small uppercase-free label above a group of controls. */
export function FieldLabel({ theme, children }: { theme: PluginTheme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{children}</Text>;
}
