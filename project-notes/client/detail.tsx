import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { BoardItem, BoardProject } from "../shared/board";
import { Button, Chip, Divider, IconButton, Spacer, fontSize, space } from "./kit";
import { MARK_HUES, NoteMeta, StatusSegmented, type NoteActions } from "./ui";

/**
 * Full text and every action of one note: the detail sheet on the board and phones, the right pane of list views.
 * Frequent actions come first (开始处理 / 复制 / 编辑, status); pin, priority and delete sit on a quieter second row.
 */
export function NoteDetail({ theme, item, project, actions, busy, compact }: { theme: PluginTheme; item: BoardItem; project: Pick<BoardProject, "id" | "name" | "path">; actions: NoteActions; busy: boolean; compact: boolean }) {
  const { colors } = theme, trashed = item.deletedAt !== null, grow = compact, high = item.priority === "high";
  const start = <Button key="start" theme={theme} label="开始处理" icon="Play" variant={item.kind === "prompt" ? "secondary" : "primary"} tone={item.kind === "prompt" ? "info" : undefined} grow={grow} onPress={() => actions.start(item)} />;
  const copy = <Button key="copy" theme={theme} label="复制" icon="Copy" variant={item.kind === "prompt" && !trashed ? "primary" : "secondary"} grow={grow} onPress={() => actions.copy(item)} />;
  const edit = <Button key="edit" theme={theme} label="编辑" icon="Pencil" grow={grow} disabled={busy} onPress={() => actions.edit(item)} />;
  const primaryRow = trashed ? [<Button key="restore" theme={theme} label="恢复" icon="RotateCcw" variant="primary" grow={grow} busy={busy} onPress={() => actions.restore(item)} />, copy]
    : item.kind === "prompt" ? [copy, edit, start] : [start, edit, copy];
  return <View style={{ gap: space.lg }}>
    <View style={{ gap: space.xs + 2 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.heading, lineHeight: 26, fontWeight: "600" }}>{item.title}</Text>
      <NoteMeta theme={theme} item={item} project={project} />
    </View>
    {item.kind === "task" && !trashed ? <StatusSegmented theme={theme} value={item.status} onChange={status => { if (status !== item.status && !busy) actions.status(item, status); }} /> : null}
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{primaryRow}</View>
      {!trashed ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {/* Colored only while on, so off reads as off. */}
        <Chip theme={theme} icon="Pin" label={item.pinned ? "已置顶" : "置顶"} selected={item.pinned} tone={item.pinned ? MARK_HUES.pinned : undefined} onPress={() => { if (!busy) actions.update(item, { pinned: !item.pinned }); }} />
        <Chip theme={theme} icon="Flag" label={high ? "重点" : "标为重点"} selected={high} tone={high ? MARK_HUES.high : undefined} onPress={() => { if (!busy) actions.update(item, { priority: high ? "normal" : "high" }); }} />
        <Spacer />
        {/* A red glyph, not a red button: deleting only moves the note to 回收站, and 重点 already uses red here. */}
        <IconButton theme={theme} icon="Trash2" label="删除" tone="danger" disabled={busy} onPress={() => actions.remove(item)} />
      </View> : null}
    </View>
    <Divider theme={theme} />
    {item.body ? <Text selectable style={{ color: colors.foreground, fontSize: fontSize.content, lineHeight: 24 }}>{item.body}</Text>
      : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>没有正文</Text>}
  </View>;
}
