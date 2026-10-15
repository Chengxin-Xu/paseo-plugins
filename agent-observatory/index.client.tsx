import type { ComponentType } from "react";
import type { PluginClientContext, PluginCommandCenterItemContribution, PluginWorkspaceCommandContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { lazySurfaces } from "./client/lazy-chunk";
import { createClientI18n } from "./client/i18n-client";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { t, type MessageId } from "./shared/text";
import { getClientChunk } from "./shared/ui-chunk";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { ArchivesSidebarItem, ObservatorySidebarItem, ScheduleSidebarItem } from "./client/sidebar";
import { createAttentionStores } from "./client/use-attention";

// The manifest requires Paseo 0.11.1, whose screen and sidebar APIs are always present.
export default function contribute(client: PluginClientContext) {
  const i18n = createClientI18n(client, { pluginId: "agent-observatory", boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } } });
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n });
  // One set of attention stores per registration, shared by resident badges and lazy views.
  const attentionStores = createAttentionStores();
  const surface = (id: string): ComponentType<any> => { const Surface = lazy(id); return (props: any) => <Surface {...props} attentionStores={attentionStores} />; };
  const AttentionPopover = lazy("attention-popover");
  const Sidebar = (props: PluginSidebarItemProps) => <ObservatorySidebarItem {...props} stores={attentionStores} AttentionPopover={AttentionPopover} />;
  const Schedules = (props: PluginSidebarItemProps) => <ScheduleSidebarItem {...props} stores={attentionStores} />;
  const screenList: Array<[string, MessageId, ComponentType<PluginSidebarItemProps>]> = [
    ["observatory", "boot.screenTitle", Sidebar], ["archives", "boot.archivesTitle", ArchivesSidebarItem], ["schedule-runs", "boot.schedulesTitle", Schedules],
  ];
  const panels = [["workspace-observatory", "boot.screenTitle", "Activity", "workspace", "inspect-workspace", "boot.inspectWorkspace"], ["agent-inspector", "boot.inspectorTitle", "ScanLine", "agent", "inspect-agent", "boot.inspectAgent"]] as const;
  const cleanups: Array<() => void> = [];
  // Paseo memoizes open surface titles; refresh their descriptors when the catalog changes too.
  cleanups.push(i18n.localized(() => {
    const registrations: Array<() => void> = [];
    screenList.forEach(([id, titleId, Item]) => {
      const title = () => t(titleId);
      registrations.push(client.addScreen({ id, title, Component: surface(id) }));
      registrations.push(client.addSidebarHeaderItem({ id, title: title(), Component: Item }));
    });
    panels.forEach(([id, titleId, icon, context]) => {
      const title = t(titleId);
      registrations.push(client.addWorkspacePanel({ id, title, icon, context, Component: surface(id) }));
    });
    return registrations;
  }));
  // Registered once: re-registering the screen the user is on while choosing a language would take the page away.
  cleanups.push(client.addSettingsScreen({ id: "language", title: t("boot.settingsTitle"), icon: "Languages", Component: surface("language") }));
  cleanups.push(i18n.localized(() => {
    const commands: Array<() => void> = [];
    const screens = [["open-observatory", "boot.open", "Orbit", "observatory"], ["open-attention", "boot.openAttention", "BellRing", "observatory"], ["open-schedule-runs", "boot.openSchedules", "CalendarClock", "schedule-runs"], ["open-archives", "boot.openArchives", "Archive", "archives"]] as const;
    screens.forEach(([id, titleId, icon, screenId]) => {
      const attention = id === "open-attention";
      commands.push(client.addCommandCenterItem({ id, title: t(titleId), icon, context: "global", keywords: attention ? [t("boot.attentionKeyword"), t("boot.approvalKeyword"), t("boot.unreadKeyword")] : undefined, onSelect(context) { context.openScreen(attention ? { screenId, params: { focus: "attention", t: Date.now().toString(36) } } : { screenId }); } }));
    });
    commands.push(
      ...panels.map(([id, _title, icon, context, commandId, titleId]) => client.addCommandCenterItem({ id: commandId, title: t(titleId), icon, context, onSelect(context: PluginWorkspaceCommandContext) { context.openPanel(id); } } as PluginCommandCenterItemContribution)),
      client.addSlashCommand({ name: "observe", argumentHint: "", description: t("boot.observeDescription"), context: "agent", onSubmit({ openPanel }) { openPanel("agent-inspector"); } }));
    return commands;
  }));
  cleanups.push(() => i18n.dispose());
  return () => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* the host is tearing down already */ } } };
}
