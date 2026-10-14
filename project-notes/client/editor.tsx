import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { BoardItem, BoardProject, NoteFields, NoteKind } from "../shared/board";
import { Banner, Button, Chip, Segmented, Spacer, hairline, space } from "./kit";
import { ProjectList } from "./projects";
import { promptEnvironmentRpc, structurePrompt } from "../shared/enhance";
import { FieldLabel, FormField, KINDS, KIND_ICONS, KIND_LABELS, KIND_TONES, MARK_HUES, PickerButton, ScopeMark, StatusSegmented } from "./ui";

export type Editor = { original: BoardItem | null; projectId: string; fields: NoteFields };
export function newFields(kind: NoteKind, status: NoteFields["status"] = "todo"): NoteFields { return { kind, status, title: "", body: "", priority: "normal", pinned: false }; }
export function editorFor(item: BoardItem): Editor { return { original: item, projectId: item.projectId, fields: { kind: item.kind, title: item.title, body: item.body, status: item.status, priority: item.priority, pinned: item.pinned } }; }

const TITLE_HINTS: Record<NoteKind, string> = { task: "一句话说明要做什么", prompt: "给提示词起个名字", idea: "一句话记下这个想法" };
const BODY_HINTS: Record<NoteKind, string> = { task: "背景、验收标准或下一步", prompt: "完整的提示词，之后一键复制", idea: "想到什么先写下来" };

/**
 * New / edit form for a bounded sheet body (Modal.Content scrollable={false}): the fields scroll on their own and
 * 保存 stays pinned — above the keyboard on phones, in the footer on desktop. The project is fixed after creation.
 */
export function EditorForm({ theme, editor, projects, projectName, busy, compact, error, changedElsewhere, onChange, onProject, onCancel, onSave, onCopyDraft, onLoadLatest }: {
  theme: PluginTheme; editor: Editor; projects: readonly BoardProject[]; projectName: (projectId: string) => string; busy: boolean; compact: boolean; error: string | null; changedElsewhere: boolean;
  onChange: (fields: Partial<NoteFields>) => void; onProject: (projectId: string) => void; onCancel: () => void; onSave: () => void; onCopyDraft: () => void; onLoadLatest: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const probe = useRpc(promptEnvironmentRpc);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceNotice, setEnhanceNotice] = useState<string | null>(null);
  const latest = useRef(editor); latest.current = editor;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function enhance() {
    if (enhancing || busy) return;
    const draft = latest.current;
    setEnhancing(true); setEnhanceNotice(null);
    try {
      const environment = await probe({ projectId: draft.projectId });
      if (!mounted.current) return;
      const current = latest.current;
      if (current.projectId !== draft.projectId || current.fields.title !== draft.fields.title || current.fields.body !== draft.fields.body || current.fields.kind !== draft.fields.kind) {
        setEnhanceNotice("草稿已变化，请再次生成模板；已有输入已保留。"); return;
      }
      onChange({ body: structurePrompt(draft.fields.title, draft.fields.body, environment) });
      setEnhanceNotice(environment.notices.join(" ") || "模板已填入，保存前请核对范围、约束和验收标准。");
    } catch (error) { if (mounted.current) setEnhanceNotice(error instanceof Error ? error.message : "生成模板失败，草稿已保留。"); }
    finally { if (mounted.current) setEnhancing(false); }
  }
  const { fields } = editor, creating = editor.original === null, name = projectName(editor.projectId), { colors } = theme;
  const canSave = !busy && !enhancing && !changedElsewhere && fields.title.trim().length > 0 && projects.some(project => project.id === editor.projectId);
  const kinds = <Segmented theme={theme} value={fields.kind} accessibilityLabel="类型" options={KINDS.map(kind => ({ value: kind, label: KIND_LABELS[kind], icon: KIND_ICONS[kind], tone: KIND_TONES[kind] }))} onChange={kind => { if (!busy) onChange({ kind }); }} />;
  const save = <Button theme={theme} label="保存" variant="primary" busy={busy} disabled={!canSave} onPress={onSave} />;
  const copyDraft = <Button theme={theme} label="复制草稿" icon="Copy" variant="ghost" size="sm" onPress={onCopyDraft} />;
  const cancel = <Button theme={theme} label="取消" disabled={busy} onPress={onCancel} />;
  const banners = changedElsewhere || error ? <View style={{ gap: space.sm }}>
    {changedElsewhere ? <Banner theme={theme} tone="warning" message="这条手记已在别处更新，保存已停用。" action={{ label: "载入最新", onPress: onLoadLatest }} /> : null}
    {error ? <Banner theme={theme} tone="danger" message={`${error} 草稿已保留。`} /> : null}
  </View> : null;
  const bar = { gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.md, borderColor: colors.surface2 };
  return <View style={{ flex: 1, minHeight: 0 }}>
    {compact ? <View style={[bar, { borderBottomWidth: hairline }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>{kinds}<Spacer />{save}</View>
      {banners}
    </View> : null}
    <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, gap: space.lg, padding: space.xl }}>
      {compact ? null : kinds}
      <View style={{ gap: space.xs + 2 }}>
        <FieldLabel theme={theme}>保存到</FieldLabel>
        <PickerButton theme={theme} block leading={<ScopeMark theme={theme} project={projects.find(project => project.id === editor.projectId) ?? { id: editor.projectId, name, path: "" }} />} label={name} disabled={!creating || busy}
          trailingIcon={creating ? (picking ? "ChevronUp" : "ChevronDown") : "LockKeyhole"} accessibilityLabel={creating ? `保存到：${name}` : `所属项目：${name}，不可更改`} expanded={creating ? picking : undefined} onPress={() => setPicking(!picking)} />
        {picking && creating ? <View style={{ marginHorizontal: -space.md }}>
          <ProjectList theme={theme} projects={projects} selectedId={editor.projectId} searchLabel="搜索所属项目" onSelect={project => { onProject(project.id); setPicking(false); }} />
        </View> : null}
      </View>
      <FormField theme={theme} label="标题" value={fields.title} onChangeText={title => onChange({ title })} maxLength={160} editable={!busy} autoFocus={creating} placeholder={TITLE_HINTS[fields.kind]} onSubmitEditing={canSave ? onSave : undefined} />
      <FormField theme={theme} label="正文" value={fields.body} onChangeText={body => onChange({ body })} maxLength={32000} editable={!busy} multiline grow={!compact} minHeight={compact ? 140 : 160} maxHeight={compact ? 320 : undefined} placeholder={BODY_HINTS[fields.kind]} />
      {fields.kind === "prompt" ? <View style={{ gap: space.sm }}>
        <Button theme={theme} label="生成四段模板" icon="WandSparkles" size="sm" busy={enhancing} disabled={busy || changedElsewhere} onPress={() => { void enhance(); }} />
        {enhanceNotice ? <Banner theme={theme} tone="info" message={enhanceNotice} /> : null}
      </View> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.xl, rowGap: space.lg }}>
        {fields.kind === "task" ? <View style={{ gap: space.xs + 2 }}>
          <FieldLabel theme={theme}>状态</FieldLabel>
          <StatusSegmented theme={theme} value={fields.status} onChange={status => { if (!busy) onChange({ status }); }} />
        </View> : null}
        <View style={{ gap: space.xs + 2 }}>
          <FieldLabel theme={theme}>标记</FieldLabel>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
            <Chip theme={theme} icon="Flag" label="重点" selected={fields.priority === "high"} tone={fields.priority === "high" ? MARK_HUES.high : undefined} onPress={() => { if (!busy) onChange({ priority: fields.priority === "high" ? "normal" : "high" }); }} />
            <Chip theme={theme} icon="Pin" label="置顶" selected={fields.pinned} tone={fields.pinned ? MARK_HUES.pinned : undefined} onPress={() => { if (!busy) onChange({ pinned: !fields.pinned }); }} />
          </View>
        </View>
      </View>
      {compact ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>{copyDraft}<Spacer />{cancel}</View> : null}
    </ScrollView>
    {compact ? null : <View style={[bar, { borderTopWidth: hairline }]}>
      {banners}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>{copyDraft}<Spacer />{cancel}{save}</View>
    </View>}
  </View>;
}
