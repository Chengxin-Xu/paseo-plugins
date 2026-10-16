import { t } from "../shared/text";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { BoardItem, BoardSnapshot } from "../shared/board";
import { templateVariables } from "../shared/composer";
import { QUICK_LIMIT, QUICK_PILL_LIMIT, pillLabel, quickEntries, quickRef, quickSettingsRpc, type QuickEntry } from "../shared/quick";
import type { QuickStore } from "./quick-store";
import { Badge, Banner, EmptyState, IconButton, fontSize, hairline, hue, radius, space, toneColor } from "./kit";

/** Whether a prompt needs its {{variables}} filled before it can go out (the picker's own test). */
export const isTemplate = (item: Pick<BoardItem, "title" | "body">) => templateVariables(item.body || item.title).length > 0;

/** A note's place in the list, as `quickRef` names an entry. */
const noteRef = (item: Pick<BoardItem, "projectId" | "id">) => `${item.projectId}:${item.id}`;

/** A note as a quick prompt entry, from the board's copy of it. */
export function entryFor(item: BoardItem): QuickEntry {
  return { projectId: item.projectId, itemId: item.id, label: item.title, template: isTemplate(item), hidden: item.deletedAt !== null || item.kind !== "prompt", revision: item.revision };
}

/**
 * Entries brought in line with the board: title, {{variables}}, trash or kind. Only from a copy of the note newer than
 * the entry, so an app whose board is a few seconds old never undoes what another app just saved. A note missing from
 * a board is left alone (that copy may predate it); deleting it for good removes its entry where that happens.
 */
export function quickCorrections(entries: readonly QuickEntry[], boards: readonly BoardSnapshot[]): QuickEntry[] | null {
  const items = new Map<string, BoardItem>();
  for (const board of boards) for (const item of board.items) items.set(noteRef(item), item);
  let changed = false;
  const next = entries.map(entry => {
    const item = items.get(quickRef(entry));
    if (!item || item.revision <= entry.revision) return entry;
    const fresh = entryFor(item);
    if (fresh.label === entry.label && fresh.template === entry.template && fresh.hidden === entry.hidden) return entry;
    changed = true;
    return fresh;
  });
  return changed ? next : null;
}

/** The live list (hidden entries included), re-rendering when any app changes it. */
export function useQuickList(store: QuickStore | undefined): QuickEntry[] {
  const subscribe = useCallback((listener: () => void) => store ? store.subscribe(listener) : () => undefined, [store]);
  useSyncExternalStore(subscribe, () => store?.version() ?? -1, () => store?.version() ?? -1);
  return store?.entries() ?? [];
}

/**
 * Saves a change against the revision the list was read at. When another app saved first, the change is applied to
 * that newer list instead (three tries). `change` returns null when there is nothing to do.
 */
export function useQuickSave(store: QuickStore | undefined) {
  const read = useRpc(quickSettingsRpc.read), write = useRpc(quickSettingsRpc.write);
  return useCallback(async (change: (entries: QuickEntry[]) => QuickEntry[] | null): Promise<boolean> => {
    if (!store) return false;
    let entries = store.entries(), revision = store.revision();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (revision === null || attempt > 0) {
        const current = await read({});
        revision = current.revision; entries = current.status === "ready" ? quickEntries(current.values) : [];
      }
      const next = change(entries);
      if (!next) return false;
      const result = await write({ revision, values: { prompts: next } });
      if (result.status === "saved") { store.adopt(result.values, result.revision); return true; }
      if (result.status === "invalid") throw new Error(t("quick.invalid", { error: result.error.slice(0, 300) }));
    }
    throw new Error(t("quick.conflict"));
  }, [store, read, write]);
}

/** The changes a user makes to the list: add or remove a prompt, move one, drop one. */
export const quickChanges = {
  toggle: (item: BoardItem, on: boolean) => (entries: QuickEntry[]) => {
    const ref = noteRef(item), present = entries.some(entry => quickRef(entry) === ref);
    if (on) return present ? entries.filter(entry => quickRef(entry) !== ref) : null;
    if (present) return null;
    if (entries.length >= QUICK_LIMIT) throw new Error(t("quick.full", { count: QUICK_LIMIT }));
    return [...entries, entryFor(item)];
  },
  move: (ref: string, delta: number) => (entries: QuickEntry[]) => {
    const index = entries.findIndex(entry => quickRef(entry) === ref), target = index + delta;
    if (index < 0 || target < 0 || target >= entries.length) return null;
    const next = [...entries], [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    return next;
  },
  remove: (refs: readonly string[]) => (entries: QuickEntry[]) => {
    const next = entries.filter(entry => !refs.includes(quickRef(entry)));
    return next.length === entries.length ? null : next;
  },
};

/** A pill as the composer draws it, for the strip and the manager's preview. */
function PillPreview({ theme, label, icon = "Zap", tone = "violet" }: { theme: PluginTheme; label: string; icon?: string; tone?: "violet" | "amber" }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1, minWidth: 0, maxWidth: 200, height: 24, paddingHorizontal: space.sm, borderRadius: radius.full, borderWidth: hairline,
    borderColor: toneColor(theme, tone, "line"), backgroundColor: theme.colors.surface1 }}>
    <View style={{ flexShrink: 0 }}><Icon name={icon} size={12} color={hue(theme, tone)} /></View>
    <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.meta }}>{label}</Text>
  </View>;
}

/** How the composer shows the list: up to three pills, or one menu pill for more. */
function PillRow({ theme, shown }: { theme: PluginTheme; shown: readonly QuickEntry[] }) {
  if (shown.length > QUICK_PILL_LIMIT) return <PillPreview theme={theme} label={t("quick.menuPreview", { count: shown.length })} />;
  return <>{shown.map(entry => <PillPreview key={quickRef(entry)} theme={theme} label={pillLabel(entry.label || t("quick.untitled"))} icon={entry.template ? "Braces" : "Zap"} />)}</>;
}

/**
 * Above the prompt list: what goes above every agent's composer, as the composer shows it. Pressing it opens the
 * manager. With nothing chosen it says how to choose.
 */
export function QuickStrip({ theme, entries, compact, onManage }: { theme: PluginTheme; entries: readonly QuickEntry[]; compact: boolean; onManage: () => void }) {
  const shown = entries.filter(entry => !entry.hidden), violet = toneColor(theme, "violet", "mark");
  return <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}>
    <Pressable testID="quick-strip" accessibilityRole="button" accessibilityLabel={t("quick.stripLabel", { count: shown.length })} onPress={onManage}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40, paddingHorizontal: space.md, paddingVertical: space.xs + 2, borderRadius: radius.md, borderWidth: hairline,
        borderColor: toneColor(theme, "violet", "line"), backgroundColor: toneColor(theme, "violet", "soft"), opacity: pressed ? 0.8 : 1 })}>
      <View style={{ flexShrink: 0 }}><Icon name="Zap" size={16} color={violet} /></View>
      <Text numberOfLines={1} style={{ flexShrink: 0, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{t("quick.stripTitle")}</Text>
      {shown.length ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden" }}>
        {compact ? <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("quick.stripCount", { count: shown.length })}</Text> : <PillRow theme={theme} shown={shown} />}
      </View> : <Text numberOfLines={compact ? 2 : 1} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("quick.stripEmpty")}</Text>}
      <Text style={{ flexShrink: 0, color: hue(theme, "violet", "text"), fontSize: fontSize.small, fontWeight: "500" }}>{t("quick.manage")}</Text>
      <View style={{ flexShrink: 0 }}><Icon name="ChevronRight" size={14} color={violet} /></View>
    </Pressable>
  </View>;
}

/** Why an entry shows no pill (or opens a form), as the manager names it; `items` is the board's copy, when loaded. */
function entryNotes(entry: QuickEntry, item: BoardItem | null | undefined): { label: string; tone: "violet" | "neutral" | "danger" }[] {
  const notes: { label: string; tone: "violet" | "neutral" | "danger" }[] = [];
  if (item === null) notes.push({ label: t("quick.missing"), tone: "danger" });
  else if (entry.hidden) notes.push({ label: t("quick.hidden"), tone: "neutral" });
  if (entry.template) notes.push({ label: t("quick.template"), tone: "violet" });
  return notes;
}

/**
 * The list in pill order: move up or down, take off. Notes in the trash keep their place without a pill; one deleted
 * for good (as far as this board knows) is marked so it can be taken off.
 */
export function QuickManager({ theme, open, onClose, entries, find, busy, error, onMove, onRemove }: {
  theme: PluginTheme; open: boolean; onClose: () => void; entries: readonly QuickEntry[];
  /** The board's copy of an entry's note: undefined when its board is not loaded, null when the board lacks it. */
  find: (entry: QuickEntry) => BoardItem | null | undefined;
  busy: boolean; error: string | null; onMove: (entry: QuickEntry, delta: number) => void; onRemove: (entry: QuickEntry) => void;
}) {
  const { colors } = theme, shown = entries.filter(entry => !entry.hidden);
  return <Modal title={t("quick.managerTitle")} open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>{t("quick.managerHint", { count: QUICK_PILL_LIMIT })}</Text>
      {shown.length ? <View style={{ gap: space.xs + 2 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "600" }}>{t("quick.previewTitle")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2, maxWidth: "100%" }}><PillRow theme={theme} shown={shown} /></View>
      </View> : null}
      {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
      {entries.length ? <View testID="quick-manager-list" style={{ gap: space.sm }}>{entries.map((entry, index) => {
        const notes = entryNotes(entry, find(entry)), title = entry.label || t("quick.untitled");
        return <View key={quickRef(entry)} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs + 2, paddingLeft: space.md, paddingRight: space.xs, borderRadius: radius.md, borderWidth: hairline,
          borderColor: entry.hidden ? colors.border : toneColor(theme, "violet", "line"), backgroundColor: entry.hidden ? colors.surface1 : toneColor(theme, "violet", "soft"), opacity: entry.hidden ? 0.75 : 1 }}>
          <Text style={{ width: 18, color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{index + 1}</Text>
          <View style={{ flexShrink: 0 }}><Icon name={entry.template ? "Braces" : "Zap"} size={14} color={entry.hidden ? colors.foregroundMuted : hue(theme, "violet")} /></View>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 3 }}>
            <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "500" }}>{title}</Text>
            {notes.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>{notes.map(note => <Badge key={note.label} theme={theme} label={note.label} tone={note.tone} />)}</View> : null}
          </View>
          <IconButton theme={theme} icon="ArrowUp" size="sm" label={t("quick.moveUp", { title })} disabled={busy || index === 0} onPress={() => onMove(entry, -1)} />
          <IconButton theme={theme} icon="ArrowDown" size="sm" label={t("quick.moveDown", { title })} disabled={busy || index === entries.length - 1} onPress={() => onMove(entry, 1)} />
          <IconButton theme={theme} icon="X" size="sm" tone="danger" label={t("quick.removeEntry", { title })} disabled={busy} onPress={() => onRemove(entry)} />
        </View>;
      })}</View> : <EmptyState theme={theme} icon="Zap" tone="violet" title={t("quick.emptyTitle")} message={t("quick.emptyMessage")} />}
    </Modal.Content>
  </Modal>;
}
