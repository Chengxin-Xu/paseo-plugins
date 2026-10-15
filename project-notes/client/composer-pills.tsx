import { t } from "../shared/text";
import { onTextChange } from "../shared/i18n";
import { useI18n } from "./i18n-client";
import type { PaseoAgentListResult, PaseoAgentUpdate } from "./paseo-types";
import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, type ComponentType } from "react";
import { onComposerNotice } from "./composer-notice";

/** Keep the kit's violet mark and light/dark contrast rule without importing its lazy UI text into the resident. */
function promptIconColor(surface: string): string {
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(surface);
  const hex = short ? short.slice(1).map(part => part + part).join("") : /^#([a-f\d]{6})(?:[a-f\d]{2})?$/i.exec(surface)?.[1];
  if (!hex) return "#8B5CF6";
  const [r, g, b] = [0, 2, 4].map(offset => { const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05 ? "#A78BFA" : "#8B5CF6";
}

/** One metadata observation, no timeline reads or per-agent polling; the library is read only when a picker opens. */
export function contributePromptPills(client: PluginClientContext, PromptPopover: ComponentType<PluginButtonContentProps>) {
  if (typeof client.addComposerPill !== "function") return () => {};
  function PromptIcon({ theme, size }: PluginButtonIconProps) {
    useI18n();
    const toast = useToast();
    useEffect(() => onComposerNotice(client.paseo, message => toast.show(message, { variant: "success" })), [toast]);
    return <Icon name="MessageSquareText" color={promptIconColor(theme.colors.surface0)} size={size} />;
  }
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  const lifetime = new AbortController();
  let observation: PaseoAgentListResult["subscription"];
  let unsubscribe: (() => void) | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 2_000;
  let snapshotVersion = 0, pendingChanges: PaseoAgentUpdate[] | null = null;
  function remove(id: string) { pills.get(id)?.registration.remove(); pills.delete(id); }
  function put(agent: { id: string; workspaceId?: string; archivedAt?: string | null }) {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration: client.addComposerPill({ id: "note-prompts", workspaceId: agent.workspaceId, agentId: agent.id, button: { title: t("boot.pillTitle"), label: t("boot.pillLabel"), icon: PromptIcon, behavior: { kind: "popover", Content: PromptPopover } } }) });
  }
  async function snapshot(list: PaseoAgentListResult) {
    if (lifetime.signal.aborted) return;
    delay = 2_000;
    const version = ++snapshotVersion, entries = [...list.entries];
    pendingChanges = [];
    try {
      const cursors = new Set<string>();
      while (list.pageInfo?.hasMore && list.pageInfo.nextCursor && !cursors.has(list.pageInfo.nextCursor)) {
        const cursor = list.pageInfo.nextCursor; cursors.add(cursor);
        list = await client.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor }, signal: lifetime.signal });
        if (lifetime.signal.aborted || snapshotVersion !== version) return;
        entries.push(...list.entries);
      }
      const changes = pendingChanges; pendingChanges = null;
      const ids = new Set(entries.map(entry => entry.agent.id));
      for (const id of pills.keys()) if (!ids.has(id)) remove(id);
      for (const { agent } of entries) put(agent);
      for (const change of changes) update(change);
    } catch { if (snapshotVersion === version) { pendingChanges = null; failed(); } }
  }
  function update(change: PaseoAgentUpdate) {
    if (lifetime.signal.aborted) return;
    pendingChanges?.push(change);
    if (change.kind === "remove") remove(change.agentId); else put(change.agent);
  }
  function failed() {
    unsubscribe?.(); unsubscribe = undefined;
    void observation?.release().catch(() => {}); observation = undefined;
    if (lifetime.signal.aborted || retry) return;
    retry = setTimeout(() => { retry = undefined; void open(); }, delay);
    delay = Math.min(delay * 2, 60_000);
  }
  async function open() {
    try {
      const result = await client.paseo.agents.list({ filter: { includeArchived: false }, subscribe: {}, signal: lifetime.signal });
      if (lifetime.signal.aborted) { await result.subscription?.release(); return; }
      observation = result.subscription;
      snapshot(result);
      if (observation) unsubscribe = observation.subscribe({ snapshot, update: message => { if (message.type === "agent_update") update(message.payload); }, error: failed });
      else unsubscribe = client.paseo.agents.subscribe(update);
    } catch { failed(); }
  }
  const stopText = onTextChange(() => {
    for (const pill of pills.values()) pill.registration.update({ title: t("boot.pillTitle"), label: t("boot.pillLabel") });
  });
  void open();
  return () => {
    stopText(); lifetime.abort(); if (retry) clearTimeout(retry); unsubscribe?.();
    void observation?.release().catch(() => {});
    for (const id of pills.keys()) remove(id);
  };
}
