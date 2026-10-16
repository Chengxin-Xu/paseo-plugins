import type { AgentDirectory, AgentLite } from "./agent-directory";

type Index = { at: number; items: Map<string, AgentLite[]>; children: Map<string, AgentLite[]> };
const indexes = new WeakMap<Pick<AgentDirectory, "list" | "version">, Index>();
const NONE: AgentLite[] = [];

/** The directory grouped by note label and by parent agent, built once per directory change and shared by every card. */
function indexOf(directory: Pick<AgentDirectory, "list" | "version">): Index {
  const known = indexes.get(directory);
  if (known?.at === directory.version()) return known;
  const items = new Map<string, AgentLite[]>(), children = new Map<string, AgentLite[]>();
  const add = (map: Map<string, AgentLite[]>, name: string, agent: AgentLite) => { const group = map.get(name); if (group) group.push(agent); else map.set(name, [agent]); };
  for (const agent of directory.list()) {
    if (agent.itemId) add(items, agent.itemId, agent);
    if (agent.parentId) add(children, agent.parentId, agent);
  }
  for (const group of items.values()) group.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const index = { at: directory.version(), items, children };
  indexes.set(directory, index);
  return index;
}
/** Agents started from a note (its label), newest first. */
export const agentsOfItem = (directory: Pick<AgentDirectory, "list" | "version">, itemId: string) => indexOf(directory).items.get(itemId) ?? NONE;
/** An agent's sub-agents (Paseo's parent label). */
export const subAgents = (directory: Pick<AgentDirectory, "list" | "version">, agentId: string) => indexOf(directory).children.get(agentId) ?? NONE;
