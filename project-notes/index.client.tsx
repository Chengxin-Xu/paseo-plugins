import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NotesSurface, NotesWorkspacePanel } from "./client/board";

export default function contribute(client: PluginClientContext) {
  client.addSurface("notes", NotesSurface);
  client.addSidebarItem({
    id: "notes",
    title: "拾页 · 项目手记",
    icon: "NotebookPen",
    surface: "notes",
  });
  client.addWorkspacePanel({ id: "project-notes", title: "项目手记", icon: "NotebookPen", context: "workspace", locations: ["workspace", "explorer"], Component: NotesWorkspacePanel });
  client.addCommandCenterItem({ id: "open-notes", title: "打开拾页 · 项目手记", icon: "NotebookPen", context: "global", keywords: ["notes", "tasks", "prompts", "ideas", "拾页", "手记"], onSelect({ openSurface }) { openSurface("notes"); } });
  client.addCommandCenterItem({ id: "open-project-notes", title: "打开拾页 · 全部项目", icon: "NotebookPen", context: "workspace", keywords: ["notes", "项目", "任务"], onSelect({ openPanel }) { openPanel("project-notes"); } });
  client.addSlashCommand({ name: "notes", description: "总览所有项目手记，新建时选择所属项目", argumentHint: "", context: "workspace", onSubmit({ openPanel }) { openPanel("project-notes"); } });
  return () => {};
}
