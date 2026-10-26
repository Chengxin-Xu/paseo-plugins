import { createClientI18n, useI18n } from "./client/i18n-client";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { t } from "./shared/text";
import type { PluginClientContext, PluginCommandCapabilities, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { createChunkLoader, lazySurfaces } from "./client/lazy-chunk";
import { getClientChunk } from "./shared/ui-chunk";
import { QUICK_CHUNK } from "./shared/generated/quick-chunk-manifest";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { contributePromptPills } from "./client/composer-pills";
import { notesAttachmentSource } from "./shared/composer-boot";
import { showComposerNotice } from "./client/composer-notice";
import { createAgentDirectory } from "./client/agent-directory";
import { createQuickStore } from "./client/quick-store";
import type { QuickActions } from "./client/quick-send";
import { createElement, type ComponentType } from "react";

function NotesSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  useI18n();
  return <SidebarRow label={t("boot.screenTitle")} icon="NotebookPen" active={currentScreen?.screenId === "notes"} onPress={() => openScreen({ screenId: "notes" })} />;
}
function openNotes(host: PluginCommandCapabilities) {
  if (typeof host.openScreen === "function") host.openScreen({ screenId: "notes" }); else host.openSurface("notes");
}
export default function contribute(client: PluginClientContext) {
  // Only views opened later need the full catalog; the resident stub draws boot text.
  const i18n = createClientI18n(client, { pluginId: "project-notes", boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } }, load: "lazy" });
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n });
  // The one-tap send and the /notes capture: a small chunk fetched with the first use, in the stub's boot text (it
  // does not wait for the full catalog, which only the views need).
  const quickChunk = createChunkLoader(client, { rpc: getClientChunk, manifest: QUICK_CHUNK, label: () => t("boot.name"),
    text: { ready: () => Promise.resolve(), translator: () => i18n.translator(), subscribe: listener => i18n.subscribe(listener) } });
  const actions = () => quickChunk.load() as unknown as Promise<QuickActions>;
  // One live copy of the agent directory and of the quick prompt list, shared by the pills and the board (task-card
  // status, the quick prompt manager), which get them as a prop.
  const services = { directory: createAgentDirectory(client.paseo), quick: createQuickStore(client) };
  const withServices = (Lazy: ComponentType<any>) => function NotesView(props: object) { return createElement(Lazy, { ...props, services }); };
  const NotesSurface = withServices(lazy("notes")), PromptScreen = lazy("prompts"), NotesWorkspacePanel = withServices(lazy("project-notes"));
  const removers: (() => void)[] = [];
  const own = (remove: () => void) => { removers.push(remove); };
  if (typeof client.addScreen === "function") {
    own(client.addScreen({ id: "notes", title: () => t("boot.screenTitle"), Component: NotesSurface }));
    own(client.addScreen({ id: "prompts", title: () => t("boot.promptsTitle"), Component: PromptScreen }));
  } else {
    own(client.addSurface("notes", NotesSurface));
    own(client.addSurface("prompts", props => <PromptScreen {...props} params={{}} />));
  }
  if (typeof client.addSidebarHeaderItem === "function") own(client.addSidebarHeaderItem({ id: "notes", title: t("boot.screenTitle"), Component: NotesSidebar }));
  else own(client.addSidebarItem({ id: "notes", title: t("boot.screenTitle"), icon: "NotebookPen", surface: "notes" }));
  // The Explorer only on web: Paseo 0.13 phones host Explorer tabs too, but a closed Explorer stays mounted there, so the board
  // would keep polling out of sight.
  own(client.addWorkspacePanel({ id: "project-notes", title: t("boot.name"), icon: "NotebookPen", context: "workspace", locations: Platform.OS === "web" ? ["workspace", "explorer"] : ["workspace"], Component: NotesWorkspacePanel }));
  own(i18n.localized(() => client.addCommandCenterItem({ id: "open-notes", title: t("boot.openNotes"), icon: "NotebookPen", context: "global", keywords: ["notes", "tasks", "prompts", "ideas", t("boot.keywordBrand"), t("boot.keywordNotes")], onSelect: openNotes })));
  own(i18n.localized(() => client.addCommandCenterItem({ id: "open-project-notes", title: t("boot.openProjects"), icon: "NotebookPen", context: "workspace", keywords: ["notes", t("boot.keywordProjects"), t("boot.keywordTasks")], onSelect({ openPanel }) { openPanel("project-notes"); } })));
  own(i18n.localized(() => client.addSlashCommand({ name: "notes", description: t("boot.notesDescription"), argumentHint: t("boot.notesArgument"), context: "workspace", async onSubmit(context) {
    if (!context.args.trim()) { context.openPanel("project-notes"); return; }
    await (await actions()).captureNote(context.args);
    showComposerNotice(context.paseo, t("boot.noteSaved"));
  } })));
  own(i18n.localized(() => client.addSlashCommand({ name: "prompt", description: t("boot.promptDescription"), argumentHint: t("boot.promptArgument"), context: "agent", onSubmit(context) {
    if (typeof context.openScreen === "function") context.openScreen({ screenId: "prompts", params: { agentId: context.agent.id, query: context.args.trim().slice(0, 300) } });
    else context.openSurface("prompts");
  } })));
  if (typeof client.addAttachmentSource === "function") own(i18n.localized(() => client.addAttachmentSource(notesAttachmentSource())));
  if (typeof client.addSettingsScreen === "function") own(client.addSettingsScreen({ id: "language", title: t("boot.settingsTitle"), icon: "Languages", Component: lazy("language") }));
  const stopPills = contributePromptPills(client, lazy("prompt-popover"), services, actions);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const remove of [stopPills, ...removers.reverse(), () => services.directory.dispose(), () => services.quick.dispose(), () => i18n.dispose()]) {
      try { remove(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, t("boot.unloadFailed"));
  };
}
