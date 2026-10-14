import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { readHistoryRpc, type BoardItem, type BoardProject } from "../shared/board";
import { Banner, Button, Chip, Divider, IconButton, Spacer, fontSize, space, toneColor } from "./kit";
import { MARK_HUES, NoteMeta, StatusSegmented, type NoteActions } from "./ui";

/**
 * Full text and every action of one note: the detail sheet on the board and phones, the right pane of list views.
 * Frequent actions come first (开始处理 / 复制 / 编辑, status); pin, priority and delete sit on a quieter second row.
 */
export function NoteDetail({ theme, item, project, actions, busy, compact, hostId, onPurge, onRestoreVersion, onRepairHistory }: { theme: PluginTheme; item: BoardItem; project: Pick<BoardProject, "id" | "name" | "path">; actions: NoteActions; busy: boolean; compact: boolean; hostId: string; onPurge?: () => void; onRestoreVersion?: (revision: number) => void; onRepairHistory?: (revision: number) => Promise<boolean> }) {
  const { colors } = theme, trashed = item.deletedAt !== null, grow = compact, high = item.priority === "high";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [repairRevision, setRepairRevision] = useState<number | null>(null);
  useEffect(() => { setRepairRevision(null); }, [item.id, item.revision]);
  const loadHistory = useRpc(readHistoryRpc);
  const history = useQuery({ queryKey: ["project-notes", "history", hostId, item.projectId, item.id, item.revision],
    queryFn: () => loadHistory({ projectId: item.projectId, itemId: item.id }), enabled: historyOpen,
    retry: false, staleTime: 30_000, refetchOnWindowFocus: false });
  const versions = history.data?.versions ?? [];
  const preview = versions.find(version => version.revision === previewRevision);
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
      {trashed && onPurge ? <Button theme={theme} label="彻底删除" icon="Trash2" tone="danger" disabled={busy} onPress={onPurge} /> : null}
    </View>
    <Divider theme={theme} />
    {item.body ? <Text selectable style={{ color: colors.foreground, fontSize: fontSize.content, lineHeight: 24 }}>{item.body}</Text>
      : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>没有正文</Text>}
    {item.historyCount ? <View style={{ gap: space.sm }}>
      <Button theme={theme} label={historyOpen ? "收起修改快照" : `修改快照 · 最近 ${item.historyCount} 版`} icon="History" onPress={() => setHistoryOpen(value => !value)} />
      {historyOpen ? <>
        {history.isPending ? <Text style={{ color: colors.foregroundMuted }}>正在读取修改快照…</Text> : null}
        {history.isError ? <Banner theme={theme} tone="danger" message={history.error.message} action={{ label: "重试", onPress: () => void history.refetch() }} /> : null}
        {history.data?.missing ? <View style={{ gap: space.sm }}>
          <Banner theme={theme} tone="warning" message={`有 ${history.data.missingCount} 个修改快照缺失。请先尝试从备份恢复；也可以确认放弃缺失的快照，保留当前正文和仍存在的快照。`} />
          {onRepairHistory ? repairRevision === null ? <Button theme={theme} label="放弃缺失的快照并继续" icon="History" tone="warning" disabled={busy} onPress={() => setRepairRevision(history.data!.itemRevision)} />
            : <View style={{ gap: space.sm }}>
              <Banner theme={theme} tone="warning" message="确认后将移除缺失快照的引用，当前正文和仍存在的快照保持不变。已找回的快照会保留。" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Button theme={theme} label="取消放弃" disabled={busy} onPress={() => setRepairRevision(null)} />
                <Button theme={theme} label="确认放弃缺失快照" tone="warning" busy={busy} onPress={() => { void onRepairHistory(repairRevision).then(done => { if (done) setRepairRevision(null); }); }} />
              </View>
            </View> : null}
        </View> : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>恢复会保存为新版本，当前内容也会留下快照。</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{[...versions].reverse().map(version => <Chip key={version.revision} theme={theme} tone="violet" selected={previewRevision === version.revision}
          label={`第 ${version.revision} 版`} onPress={() => setPreviewRevision(version.revision)} />)}</View>
        {preview ? <View style={{ padding: space.md, gap: space.sm, borderWidth: 1, borderColor: toneColor(theme, "violet", "line"), borderRadius: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{preview.title}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{new Date(preview.updatedAt).toLocaleString()}</Text>
          <Text selectable style={{ color: colors.foreground, fontSize: fontSize.content }}>{preview.body || "没有正文"}</Text>
          {!trashed && onRestoreVersion ? <Button theme={theme} label={`恢复第 ${preview.revision} 版`} icon="RotateCcw" tone="success" busy={busy} disabled={history.data?.missing} onPress={() => onRestoreVersion(preview.revision)} /> : null}
        </View> : null}
      </> : null}
    </View> : null}
  </View>;
}
