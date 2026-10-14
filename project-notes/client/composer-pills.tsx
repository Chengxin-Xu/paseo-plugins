import type { PaseoAgentListResult, PaseoAgentUpdate } from "./paseo-types";
import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, type ComponentType } from "react";
import { hue } from "./kit";
import { onComposerNotice } from "./composer-notice";

/** One metadata observation, no timeline reads or per-agent polling; the library is read only when a picker opens. */
export function contributePromptPills(client: PluginClientContext, PromptPopover: ComponentType<PluginButtonContentProps>) {
  if (typeof client.addComposerPill !== "function") return () => {};
  function PromptIcon({ theme, size }: PluginButtonIconProps) {
    const toast = useToast();
    useEffect(() => onComposerNotice(client.paseo, message => toast.show(message, { variant: "success" })), [toast]);
    return <Icon name="MessageSquareText" color={hue(theme, "violet")} size={size} />;
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
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration: client.addComposerPill({ id: "note-prompts", workspaceId: agent.workspaceId, agentId: agent.id, button: { title: "提示词", label: "提示词", icon: PromptIcon, behavior: { kind: "popover", Content: PromptPopover } } }) });
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
  void open();
  return () => {
    lifetime.abort(); if (retry) clearTimeout(retry); unsubscribe?.();
    void observation?.release().catch(() => {});
    for (const id of pills.keys()) remove(id);
  };
}
