import type { LaunchAgent, LaunchRecord } from "../shared/launch";
import type { AgentDirectory, AgentLite } from "./agent-directory";
import { agentsOfItem, subAgents } from "./directory-index";
import type { Tone } from "./kit";

/**
 * Where a note's launch stands, from Paseo's agent directory (live agents) and the plugin's launch records: no timeline
 * is read, so no unloaded agent is woken. One phase per launch:
 * - needs: waits for an approval or an answer (amber); failed: the agent reported an error (red);
 * - running / starting: a turn is going (blue, animated); unread: finished, not looked at yet (green); idle: done, seen;
 * - ended: archived or deleted (the record or the label still knows it);
 * - launching: 开始处理 still creating it (blue); check: interrupted, needs checking (amber); rejected: refused (red).
 */
export type LaunchPhase = "needs" | "failed" | "running" | "starting" | "launching" | "check" | "unread" | "idle" | "rejected" | "ended";

export const PHASE_TONES: Record<LaunchPhase, Tone> = {
  needs: "warning", failed: "danger", running: "info", starting: "info", launching: "info", check: "warning", unread: "success", idle: "neutral", rejected: "danger", ended: "neutral",
};
/** Which launch a card shows first: what needs the user, then what fails or runs, then what finished. */
const RANK: Record<LaunchPhase, number> = { needs: 0, failed: 1, running: 2, starting: 3, launching: 4, check: 5, unread: 6, idle: 7, rejected: 8, ended: 9 };
/** Phases with motion: work going on (blue ping) and work waiting for the user (amber breathing). */
export const LIVE_PHASES: ReadonlySet<LaunchPhase> = new Set(["running", "starting", "launching"]);

/** The directory's state for one agent, in the order Paseo's own sidebar ranks them. */
export function agentPhase(agent: Pick<AgentLite, "status" | "pending" | "attention">): LaunchPhase {
  if (agent.pending.length > 0 || agent.attention === "permission") return "needs";
  if (agent.status === "error" || agent.attention === "error") return "failed";
  if (agent.status === "running") return "running";
  if (agent.status === "initializing") return "starting";
  if (agent.attention) return "unread";
  return "idle";
}

const STARTING_STAGES = new Set(["prepared", "creating_workspace", "workspace_ready", "creating_agent", "agent_ready", "sending"]);
/** A record whose launch is still going: the board reads records again while one is. */
export const launchPending = (record: Pick<LaunchRecord, "stage">) => STARTING_STAGES.has(record.stage);

/** The latest sign of life the directory has for an agent. */
export function lastActivity(agent: Pick<AgentLite, "updatedAt" | "lastUserMessageAt" | "attentionAt">): string | null {
  return [agent.updatedAt, agent.lastUserMessageAt, agent.attentionAt].filter((value): value is string => !!value).sort().at(-1) ?? null;
}

export interface LaunchEntry {
  /** The agent, else the launch: one entry per launch. */
  key: string;
  phase: LaunchPhase;
  agentId: string | null;
  workspaceId: string | null;
  launchId: string | null;
  title: string | null;
  provider: string | null;
  /** Last activity (live agents), else when it started. */
  at: string | null;
  /** Its sub-agents in the directory, and how many of them run. */
  children: number;
  childrenRunning: number;
  error: string | null;
}

type Directory = Pick<AgentDirectory, "ready" | "get" | "list" | "version">;

function liveEntry(directory: Directory, agent: AgentLite): LaunchEntry {
  const children = subAgents(directory, agent.id);
  return { key: agent.id, phase: agentPhase(agent), agentId: agent.id, workspaceId: agent.workspaceId, launchId: agent.launchId, title: agent.title, provider: agent.provider,
    at: lastActivity(agent), children: children.length, childrenRunning: children.filter(child => child.status === "running" || child.status === "initializing").length, error: null };
}

/**
 * Every launch of a note: its live agents (by label), then records and listed agents the live directory lacks. An
 * agent the record names but the directory no longer lists is ended: archived or deleted. Until the first listing has
 * arrived nothing is called ended. `agents`: the directory's own list for this note, archived ones included (detail).
 */
export function launchEntries(directory: Directory, itemId: string, records: readonly LaunchRecord[] = [], agents: readonly LaunchAgent[] = []): LaunchEntry[] {
  const entries = new Map<string, LaunchEntry>(), launches = new Map<string, string>();
  for (const agent of agentsOfItem(directory, itemId)) {
    entries.set(agent.id, liveEntry(directory, agent));
    if (agent.launchId) launches.set(agent.launchId, agent.id);
  }
  const ready = directory.ready();
  for (const record of records) {
    if ((record.agentId && entries.has(record.agentId)) || launches.has(record.launchId)) continue;
    const live = record.agentId ? directory.get(record.agentId) : undefined;
    if (live) { entries.set(live.id, liveEntry(directory, live)); launches.set(record.launchId, live.id); continue; }
    let phase: LaunchPhase;
    if (record.stage === "rejected") phase = "rejected";
    // The server reports a launch it no longer runs as uncertain, never as still going.
    else if (launchPending(record)) phase = "launching";
    else if (record.stage === "uncertain" && !record.agentId) phase = "check";
    else if (!ready) continue;
    else phase = "ended";
    const key = record.agentId ?? `launch:${record.launchId}`;
    entries.set(key, { key, phase, agentId: record.agentId, workspaceId: record.workspaceId, launchId: record.launchId, title: null, provider: null, at: record.at, children: 0, childrenRunning: 0, error: phase === "ended" ? null : record.error });
    launches.set(record.launchId, key);
  }
  for (const agent of agents) {
    const known = entries.get(agent.agentId) ?? (agent.launchId ? entries.get(launches.get(agent.launchId) ?? "") : undefined);
    if (known) { known.title ??= agent.title; known.provider ??= agent.provider; continue; }
    if (!ready || directory.get(agent.agentId)) continue;
    entries.set(agent.agentId, { key: agent.agentId, phase: "ended", agentId: agent.agentId, workspaceId: agent.workspaceId, launchId: agent.launchId, title: agent.title, provider: agent.provider,
      at: agent.archivedAt ?? agent.updatedAt, children: 0, childrenRunning: 0, error: null });
  }
  return [...entries.values()];
}

/** The launch a card shows: the most urgent, then the most recent. */
export function primaryLaunch(entries: readonly LaunchEntry[]): LaunchEntry | null {
  let best: LaunchEntry | null = null;
  for (const entry of entries) {
    if (!best || RANK[entry.phase] < RANK[best.phase] || (RANK[entry.phase] === RANK[best.phase] && (entry.at ?? "") > (best.at ?? ""))) best = entry;
  }
  return best;
}

/** Newest first, for the detail's list of launches. */
export const byRecent = (a: LaunchEntry, b: LaunchEntry) => (b.at ?? "").localeCompare(a.at ?? "") || a.key.localeCompare(b.key);
