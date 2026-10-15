import { createClientI18n, useI18n } from "./client/i18n-client";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { t } from "./shared/text";
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
  useI18n();
  return <SidebarRow label={t("boot.screenTitle")} icon="NotebookPen" active={currentScreen?.screenId === "notes"} onPress={() => openScreen({ screenId: "notes" })} />;
}
function openNotes(host: PluginCommandCapabilities) {
  if (typeof host.openScreen === "function") host.openScreen({ screenId: "notes" }); else host.openSurface("notes");
}
let quickSequence = 0;

export default function contribute(client: PluginClientContext) {
  // Only views opened later need the full catalog; the resident stub draws boot text.
  const i18n = createClientI18n(client, { pluginId: "project-notes", boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } }, load: "lazy" });
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n });
  const NotesSurface = lazy("notes"), PromptScreen = lazy("prompts"), NotesWorkspacePanel = lazy("project-notes");
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
  own(client.addWorkspacePanel({ id: "project-notes", title: t("boot.name"), icon: "NotebookPen", context: "workspace", locations: ["workspace", "explorer"], Component: NotesWorkspacePanel }));
  own(i18n.localized(() => client.addCommandCenterItem({ id: "open-notes", title: t("boot.openNotes"), icon: "NotebookPen", context: "global", keywords: ["notes", "tasks", "prompts", "ideas", t("boot.keywordBrand"), t("boot.keywordNotes")], onSelect: openNotes })));
  own(i18n.localized(() => client.addCommandCenterItem({ id: "open-project-notes", title: t("boot.openProjects"), icon: "NotebookPen", context: "workspace", keywords: ["notes", t("boot.keywordProjects"), t("boot.keywordTasks")], onSelect({ openPanel }) { openPanel("project-notes"); } })));
  own(i18n.localized(() => client.addSlashCommand({ name: "notes", description: t("boot.notesDescription"), argumentHint: t("boot.notesArgument"), context: "workspace", async onSubmit(context) {
    if (!context.args.trim()) { context.openPanel("project-notes"); return; }
    await context.rpc(writeBoardRpc, { projectId: INBOX_PROJECT_ID, requestId: `quick-${Date.now().toString(36)}-${++quickSequence}-${Math.random().toString(36).slice(2)}`, operation: { type: "create", fields: quickNoteFields(context.args) } });
    showComposerNotice(context.paseo, t("boot.noteSaved"));
  } })));
  own(i18n.localized(() => client.addSlashCommand({ name: "prompt", description: t("boot.promptDescription"), argumentHint: t("boot.promptArgument"), context: "agent", onSubmit(context) {
    if (typeof context.openScreen === "function") context.openScreen({ screenId: "prompts", params: { agentId: context.agent.id, query: context.args.trim().slice(0, 300) } });
    else context.openSurface("prompts");
  } })));
  if (typeof client.addAttachmentSource === "function") own(i18n.localized(() => client.addAttachmentSource(notesAttachmentSource())));
  if (typeof client.addSettingsScreen === "function") own(client.addSettingsScreen({ id: "language", title: t("boot.settingsTitle"), icon: "Languages", Component: lazy("language") }));
  const stopPills = contributePromptPills(client, lazy("prompt-popover"));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const remove of [stopPills, ...removers.reverse(), () => i18n.dispose()]) {
      try { remove(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, t("boot.unloadFailed"));
  };
}
