import type { PluginClientContext, PluginCommandCapabilities, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { lazySurfaces } from "./client/lazy-chunk";
import { getClientChunk } from "./shared/ui-chunk";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { contributePromptPills } from "./client/composer-pills";
import { notesAttachmentSource, quickNoteFields } from "./shared/composer";
import { INBOX_PROJECT_ID, writeBoardRpc } from "./shared/board";
import { showComposerNotice } from "./client/composer-notice";

function NotesSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="NotebookPen" active={currentScreen?.screenId === "notes"} onPress={() => openScreen({ screenId: "notes" })} />;
}
function openNotes(host: PluginCommandCapabilities) {
  if (typeof host.openScreen === "function") host.openScreen({ screenId: "notes" }); else host.openSurface("notes");
}
let quickSequence = 0;

export default function contribute(client: PluginClientContext) {
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: "项目手记" });
  const NotesSurface = lazy("notes"), PromptScreen = lazy("prompts"), NotesWorkspacePanel = lazy("project-notes");
  const removers: (() => void)[] = [];
  const own = (remove: () => void) => { removers.push(remove); };
  if (typeof client.addScreen === "function") {
    own(client.addScreen({ id: "notes", title: "拾页 · 项目手记", Component: NotesSurface }));
    own(client.addScreen({ id: "prompts", title: "拾页 · 提示词库", Component: PromptScreen }));
  } else {
    own(client.addSurface("notes", NotesSurface));
    own(client.addSurface("prompts", props => <PromptScreen {...props} params={{}} />));
  }
  if (typeof client.addSidebarHeaderItem === "function") own(client.addSidebarHeaderItem({ id: "notes", title: "拾页 · 项目手记", Component: NotesSidebar }));
  else own(client.addSidebarItem({ id: "notes", title: "拾页 · 项目手记", icon: "NotebookPen", surface: "notes" }));
  own(client.addWorkspacePanel({ id: "project-notes", title: "项目手记", icon: "NotebookPen", context: "workspace", locations: ["workspace", "explorer"], Component: NotesWorkspacePanel }));
  own(client.addCommandCenterItem({ id: "open-notes", title: "打开拾页 · 项目手记", icon: "NotebookPen", context: "global", keywords: ["notes", "tasks", "prompts", "ideas", "拾页", "手记"], onSelect: openNotes }));
  own(client.addCommandCenterItem({ id: "open-project-notes", title: "打开拾页 · 全部项目", icon: "NotebookPen", context: "workspace", keywords: ["notes", "项目", "任务"], onSelect({ openPanel }) { openPanel("project-notes"); } }));
  own(client.addSlashCommand({ name: "notes", description: "记随手记；请先移除附件，空参数打开手记", argumentHint: "要记下的文字", context: "workspace", async onSubmit(context) {
    if (!context.args.trim()) { context.openPanel("project-notes"); return; }
    await context.rpc(writeBoardRpc, { projectId: INBOX_PROJECT_ID, requestId: `quick-${Date.now().toString(36)}-${++quickSequence}-${Math.random().toString(36).slice(2)}`, operation: { type: "create", fields: quickNoteFields(context.args) } });
    showComposerNotice(context.paseo, "已记到随手记");
  } }));
  own(client.addSlashCommand({ name: "prompt", description: "挑选提示词并预览；请先移除附件", argumentHint: "关键词", context: "agent", onSubmit(context) {
    if (typeof context.openScreen === "function") context.openScreen({ screenId: "prompts", params: { agentId: context.agent.id, query: context.args.trim().slice(0, 300) } });
    else context.openSurface("prompts");
  } }));
  if (typeof client.addAttachmentSource === "function") own(client.addAttachmentSource(notesAttachmentSource));
  const stopPills = contributePromptPills(client, lazy("prompt-popover"));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const remove of [stopPills, ...removers.reverse()]) {
      try { remove(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "项目手记卸载未完整完成");
  };
}
