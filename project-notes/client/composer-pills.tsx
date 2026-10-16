import { t } from "../shared/text";
import { onTextChange } from "../shared/i18n";
import { useI18n } from "./i18n-client";
import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { createElement, useEffect, type ComponentType } from "react";
import { Dimensions } from "react-native";
import { onComposerNotice, showComposerNotice } from "./composer-notice";
import type { AgentDirectory, AgentLite } from "./agent-directory";
import type { QuickStore } from "./quick-store";
import { createQuickPills } from "./quick-pills";
import { composerCapabilitiesRpc } from "../shared/composer-boot";
import { quickRef, type QuickEntry } from "../shared/quick";
import type { QuickActions } from "./quick-send";

/** Pick the light or the dark shade of a mark for the composer's ground, by the same contrast rule as the kit. */
function markColor(surface: string, light: string, dark: string): string {
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(surface);
  const hex = short ? short.slice(1).map(part => part + part).join("") : /^#([a-f\d]{6})(?:[a-f\d]{2})?$/i.exec(surface)?.[1];
  if (!hex) return light;
  const [r, g, b] = [0, 2, 4].map(offset => { const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05 ? dark : light;
}
/** The kit's violet (prompts) and amber (waits for something) marks. */
const VIOLET: [string, string] = ["#8B5CF6", "#A78BFA"], AMBER: [string, string] = ["#D97706", "#FBBF24"];
const mark = (name: string, colors: [string, string]) => function PillMark({ theme, size }: PluginButtonIconProps) {
  return <Icon name={name} color={markColor(theme.colors.surface0, colors[0], colors[1])} size={size} />;
};

/**
 * Composer pills: 「提示词」 (the library) on every agent, then the quick prompts. One shared observation of the agent
 * directory, no timeline reads or per-agent polling; the library and each prompt's text are read only when used, and
 * the send itself (`actions`, the quick chunk) comes with the first press.
 */
export function contributePromptPills(client: PluginClientContext, PromptPopover: ComponentType<PluginButtonContentProps & { quick?: QuickEntry }>, services: { directory: AgentDirectory; quick: QuickStore }, actions: () => Promise<QuickActions>) {
  if (typeof client.addComposerPill !== "function") return () => {};
  const { directory, quick: store } = services;
  function PromptIcon({ theme, size }: PluginButtonIconProps) {
    useI18n();
    const toast = useToast();
    useEffect(() => onComposerNotice(client.paseo, message => toast.show(message, { variant: "success" })), [toast]);
    return <Icon name="MessageSquareText" color={markColor(theme.colors.surface0, VIOLET[0], VIOLET[1])} size={size} />;
  }
  // One stable fill form per prompt: the prompt picker opened on it.
  const forms = new Map<string, ComponentType<PluginButtonContentProps>>();
  const fill = (entry: QuickEntry) => {
    let form = forms.get(quickRef(entry));
    if (!form) {
      const ref = { ...entry };
      form = (props: PluginButtonContentProps) => createElement(PromptPopover, { ...props, quick: ref });
      forms.set(quickRef(entry), form);
    }
    return form;
  };
  const quick = createQuickPills({
    addComposerPill: contribution => client.addComposerPill(contribution),
    // A chunk that will not load sent nothing (pressing again is safe); a lost answer is the sender's to word.
    send: (request, hooks) => actions().then(loaded => loaded.quickSend(request, hooks), (error: unknown) => { throw new Error(hooks.notSent(error instanceof Error ? error.message.slice(0, 300) : String(error))); }),
    notice: message => showComposerNotice(client.paseo, message),
    openManager: () => { if (typeof client.openScreen === "function") client.openScreen({ screenId: "notes", params: { view: "quick" } }); else client.openSurface("notes"); },
    fill,
    openFill: (agentId, entry) => { if (typeof client.openScreen === "function") client.openScreen({ screenId: "prompts", params: { agentId, projectId: entry.projectId, itemId: entry.itemId } }); else client.openSurface("prompts"); },
    icons: { send: mark("Zap", VIOLET), ask: mark("Zap", AMBER), fill: mark("Braces", VIOLET) },
  });
  // Paseo's pill row is one line that neither wraps nor scrolls: separate one-tap pills would squeeze every plugin's
  // label to a letter on a phone, and on a window under 1024 px with the sidebar (a 900 px window leaves the composer
  // about 550 px). There they fold into one menu pill, following rotation and resizing. Known before the first pill
  // registers, so nothing unfolds and folds again.
  const narrow = () => { const { width } = Dimensions.get("window"); return width > 0 && width < 1024; };
  quick.setNarrow(narrow());
  const resized = Dimensions.addEventListener?.("change", () => quick.setNarrow(narrow()));
  const library = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let stopped = false, capabilities: "none" | "loading" | "loaded" = "none";
  // Whether a running agent takes a message mid-turn depends on the daemon's provider config: read it once a prompt shows.
  const loadCapabilities = () => {
    if (capabilities !== "none" || !quick.active()) return;
    capabilities = "loading";
    client.rpc(composerCapabilitiesRpc, {}).then(result => { if (stopped) return; capabilities = "loaded"; quick.setSteerable(result.steerableProviders); }, () => { capabilities = "none"; });
  };
  function remove(id: string) { library.get(id)?.registration.remove(); library.delete(id); quick.removeAgent(id); }
  function put(agent: AgentLite) {
    if (stopped) return;
    if (!agent.workspaceId) { remove(agent.id); return; }
    if (library.get(agent.id)?.workspaceId !== agent.workspaceId) {
      remove(agent.id);
      library.set(agent.id, { workspaceId: agent.workspaceId, registration: client.addComposerPill({ id: "note-prompts", workspaceId: agent.workspaceId, agentId: agent.id, button: { title: t("boot.pillTitle"), label: t("boot.pillLabel"), icon: PromptIcon, behavior: { kind: "popover", Content: PromptPopover } } }) });
    }
    // After the library pill: registration order is display order.
    quick.setAgent(agent);
  }
  const stopDirectory = directory.subscribe(changed => {
    if (changed === null) {
      const live = new Set<string>();
      for (const agent of directory.list()) { live.add(agent.id); put(agent); }
      for (const id of [...library.keys()]) if (!live.has(id)) remove(id);
      loadCapabilities();
      return;
    }
    changed.forEach(id => { const agent = directory.get(id); if (agent) put(agent); else remove(id); });
  });
  if (directory.ready()) for (const agent of directory.list()) put(agent);
  const showEntries = () => { if (store.ready()) { quick.setEntries(store.entries()); loadCapabilities(); } };
  const stopStore = store.subscribe(showEntries);
  showEntries();
  const stopText = onTextChange(() => {
    // Presentation only (no behavior): an open library popover stays open.
    for (const pill of library.values()) pill.registration.update({ title: t("boot.pillTitle"), label: t("boot.pillLabel") });
    quick.refreshText();
  });
  return () => {
    stopped = true;
    stopText(); stopStore(); stopDirectory(); resized?.remove();
    quick.removeAll();
    for (const id of [...library.keys()]) remove(id);
  };
}
