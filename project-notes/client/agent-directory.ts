import type { PaseoAgentListResult, PaseoAgentUpdate, PaseoApi } from "./paseo-types";

/**
 * What the plugin keeps of each agent in Paseo's agent directory: enough for the composer pills and the status on task
 * cards, nothing else (no timelines, no messages).
 */
export interface AgentLite {
  id: string;
  workspaceId: string | null;
  provider: string;
  /** initializing | idle | running | error | closed (closed: not loaded; it loads when used). */
  status: string;
  /** Ids of the permission requests (approvals, questions) it waits on. */
  pending: string[];
  /** Why it wants the user (finished: done and unread, error, permission); null when nothing waits. */
  attention: string | null;
  /** The running turn as a send consent names it (`id@startedAt`); null without one. */
  turn: string | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastUserMessageAt: string | null;
  attentionAt: string | null;
  /** Labels the plugin and Paseo put on agents: the note it was started from, its launch, its parent agent. */
  itemId: string | null;
  launchId: string | null;
  parentId: string | null;
}

/** Paseo's agent directory as one live, shared copy: listed once, then followed through its subscription. */
export interface AgentDirectory {
  /** The first full listing has arrived: an agent missing from it is archived or deleted. */
  ready(): boolean;
  get(id: string): AgentLite | undefined;
  list(): AgentLite[];
  /** `changed`: the agents that changed, or null after a new full listing. */
  subscribe(listener: (changed: ReadonlySet<string> | null) => void): () => void;
  /** Grows with every change (for `useSyncExternalStore`). */
  version(): number;
  dispose(): void;
}

type RawAgent = { id: string; workspaceId?: string | null; provider?: string; status?: string; pendingPermissions?: readonly unknown[] | null; requiresAttention?: boolean; attentionReason?: string | null;
  activeTurn?: { turnId?: string; startedAt?: string | null } | null; title?: string | null; createdAt?: string; updatedAt?: string; lastUserMessageAt?: string | null; attentionTimestamp?: string | null;
  archivedAt?: string | null; labels?: Record<string, string> | null };

const label = (raw: RawAgent, name: string) => { const value = raw.labels?.[name]; return typeof value === "string" && value.trim() ? value.trim() : null; };

/** The part of an agent snapshot the plugin keeps; null for an archived agent (the directory drops it). */
export function liteAgent(raw: RawAgent): AgentLite | null {
  if (!raw?.id || raw.archivedAt) return null;
  const turn = raw.activeTurn?.turnId ? (raw.activeTurn.startedAt ? `${raw.activeTurn.turnId}@${raw.activeTurn.startedAt}` : raw.activeTurn.turnId) : null;
  return {
    id: raw.id, workspaceId: raw.workspaceId ?? null, provider: raw.provider ?? "", status: raw.status ?? "idle",
    pending: (raw.pendingPermissions ?? []).map(entry => (entry as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string").sort(),
    attention: raw.requiresAttention ? raw.attentionReason ?? "finished" : null, turn, title: raw.title ?? null,
    createdAt: raw.createdAt ?? null, updatedAt: raw.updatedAt ?? null, lastUserMessageAt: raw.lastUserMessageAt ?? null, attentionAt: raw.attentionTimestamp ?? null,
    itemId: label(raw, "project-notes.item-id"), launchId: label(raw, "project-notes.launch-id"), parentId: label(raw, "paseo.parent-agent-id"),
  };
}

const sameAgent = (a: AgentLite, b: AgentLite) => (Object.keys(a) as (keyof AgentLite)[]).every(field => field === "pending" ? a.pending.join() === b.pending.join() : a[field] === b[field]);

/**
 * One observation of the directory for the whole plugin (no timelines, no per-agent reads): every page of the first
 * listing, then updates, again after a reconnect; on failure it starts over, waiting 2 s and up to a minute. Updates
 * that change nothing the plugin keeps (usage, streaming) notify nobody.
 */
export function createAgentDirectory(paseo: PaseoApi): AgentDirectory {
  const agents = new Map<string, AgentLite>(), listeners = new Set<(changed: ReadonlySet<string> | null) => void>();
  const lifetime = new AbortController();
  let observation: PaseoAgentListResult["subscription"], unsubscribe: (() => void) | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 2_000, generation = 0, arriving: PaseoAgentUpdate[] | null = null, listed = false, changes = 0;
  const notify = (changed: ReadonlySet<string> | null) => {
    changes++;
    for (const listener of [...listeners]) { try { listener(changed); } catch { /* One view's failure must not stop the others. */ } }
  };
  const apply = (change: PaseoAgentUpdate, changed: Set<string>) => {
    if (change.kind === "remove") { if (agents.delete(change.agentId)) changed.add(change.agentId); return; }
    const next = liteAgent(change.agent as RawAgent);
    if (!next) { if (agents.delete(change.agent.id)) changed.add(change.agent.id); return; }
    const previous = agents.get(next.id);
    if (previous && sameAgent(previous, next)) return;
    agents.set(next.id, next); changed.add(next.id);
  };
  async function snapshot(list: PaseoAgentListResult) {
    if (lifetime.signal.aborted) return;
    delay = 2_000;
    const version = ++generation, entries = [...list.entries];
    arriving = [];
    try {
      const cursors = new Set<string>();
      while (list.pageInfo?.hasMore && list.pageInfo.nextCursor && !cursors.has(list.pageInfo.nextCursor)) {
        const cursor = list.pageInfo.nextCursor; cursors.add(cursor);
        list = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor }, signal: lifetime.signal });
        if (lifetime.signal.aborted || generation !== version) return;
        entries.push(...list.entries);
      }
      // Updates that came while later pages loaded are newer than those pages.
      const later = arriving; arriving = null;
      agents.clear();
      for (const { agent } of entries) { const lite = liteAgent(agent as RawAgent); if (lite) agents.set(lite.id, lite); }
      for (const change of later) apply(change, new Set());
      listed = true;
      notify(null);
    } catch { if (generation === version) { arriving = null; failed(); } }
  }
  function update(change: PaseoAgentUpdate) {
    if (lifetime.signal.aborted) return;
    arriving?.push(change);
    const changed = new Set<string>();
    apply(change, changed);
    if (changed.size) notify(changed);
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
      const result = await paseo.agents.list({ filter: { includeArchived: false }, subscribe: {}, signal: lifetime.signal });
      if (lifetime.signal.aborted) { await result.subscription?.release(); return; }
      observation = result.subscription;
      void snapshot(result);
      if (observation) unsubscribe = observation.subscribe({ snapshot, update: message => { if (message.type === "agent_update") update(message.payload); }, error: failed });
      else unsubscribe = paseo.agents.subscribe(update);
    } catch { failed(); }
  }
  void open();
  return {
    ready: () => listed,
    get: id => agents.get(id),
    list: () => [...agents.values()],
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => changes,
    dispose() {
      lifetime.abort(); if (retry) clearTimeout(retry); unsubscribe?.();
      void observation?.release().catch(() => {});
      listeners.clear(); agents.clear();
    },
  };
}
