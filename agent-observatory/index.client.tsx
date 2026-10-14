import type { ComponentType } from "react";
import type { PluginClientContext, PluginCommandCenterItemContribution, PluginWorkspaceCommandContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { lazySurfaces } from "./client/lazy-chunk";
import { getClientChunk } from "./shared/ui-chunk";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { ArchivesSidebarItem, ObservatorySidebarItem, ScheduleSidebarItem } from "./client/sidebar";
import { createAttentionStores } from "./client/use-attention";

// The manifest requires Paseo 0.11.1, whose screen and sidebar APIs are always present.
export default function contribute(client: PluginClientContext) {
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: "观测台" });
  // One set of 需要处理 stores per registration (a reconnect evaluates a fresh stub): the badge, the schedule count and every
  // UI chunk surface get this one, so 知道了 in the chunk's detail re-reads the badge's own store.
  const attentionStores = createAttentionStores();
  const surface = (id: string): ComponentType<any> => { const Surface = lazy(id); return (props: any) => <Surface {...props} attentionStores={attentionStores} />; };
  const AttentionPopover = lazy("attention-popover");
  const Sidebar = (props: PluginSidebarItemProps) => <ObservatorySidebarItem {...props} stores={attentionStores} AttentionPopover={AttentionPopover} />;
  const Schedules = (props: PluginSidebarItemProps) => <ScheduleSidebarItem {...props} stores={attentionStores} />;
  const screenList: Array<[string, string, ComponentType<PluginSidebarItemProps>]> = [
    ["observatory", "Agent 观测台", Sidebar], ["archives", "已归档会话", ArchivesSidebarItem], ["schedule-runs", "定时运行", Schedules],
  ];
  const cleanups: Array<() => void> = [];
  screenList.forEach(([id, title, Item]) => {
    cleanups.push(client.addScreen({ id, title, Component: surface(id) }));
    cleanups.push(client.addSidebarHeaderItem({ id, title, Component: Item }));
  });
  const panels = [["workspace-observatory", "Agent 观测台", "Activity", "workspace", "inspect-workspace", "观测当前工作区"], ["agent-inspector", "执行详情", "ScanLine", "agent", "inspect-agent", "观测当前 agent"]] as const;
  panels.forEach(([id, title, icon, context]) => {
    cleanups.push(client.addWorkspacePanel({ id, title, icon, context, Component: surface(id) }));
  });
  [["open-observatory", "打开 Agent 观测台", "Orbit", "observatory"], ["open-attention", "查看需要处理的会话", "BellRing", "observatory"], ["open-schedule-runs", "打开定时运行", "CalendarClock", "schedule-runs"], ["open-archives", "打开已归档会话", "Archive", "archives"]].forEach(([id, title, icon, screenId]) => {
    const attention = id === "open-attention";
    cleanups.push(client.addCommandCenterItem({ id, title, icon, context: "global", keywords: attention ? ["需要处理", "审批", "未读"] : undefined, onSelect(context) { context.openScreen(attention ? { screenId, params: { focus: "attention", t: Date.now().toString(36) } } : { screenId }); } }));
  });
  cleanups.push(
    ...panels.map(([id, _title, icon, context, commandId, title]) => client.addCommandCenterItem({ id: commandId, title, icon, context, onSelect(context: PluginWorkspaceCommandContext) { context.openPanel(id); } } as PluginCommandCenterItemContribution)),
    client.addSlashCommand({ name: "observe", argumentHint: "", description: "查看当前 agent 的执行详情与子任务", context: "agent", onSubmit({ openPanel }) { openPanel("agent-inspector"); } }));
  return () => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* the host is tearing down already */ } } };
}
