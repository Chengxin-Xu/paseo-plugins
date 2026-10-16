import path from 'node:path';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { t } from '../shared/text';
import type { BrowserAgentPort, BrowserPortsReply } from '../shared/browser';
import { isBlockedHost } from './navigation';
import { PortScanner, connectHost, programName, scopeOf, type OwnedSocket, type PortScan } from './proc-ports';
import type { PaseoWorkspace } from './service';

type Paseo = PluginHandlerContext['paseo'];
type AgentStatus = BrowserAgentPort['agentStatus'];
interface AgentRecord { title: string | null; status: AgentStatus; workspaceId: string | null }
/** What the panel may open for a listed port: the server builds the address, the client only names the port. */
interface PortTarget { url: string; openable: boolean }

/** One scan serves every viewer for this long (a phone and a computer polling at once cost one pass over /proc). */
export const PORT_SCAN_TTL_MS = 2_500;
/** Agent titles and states are reused this long; lifecycle events drop them sooner. */
const AGENT_TTL_MS = 5_000;
/** A failed lookup may fall back on what was known this recently. */
const AGENT_STALE_MS = 60_000;
const AGENT_TIMEOUT_MS = 2_500;
/** Rows per group: a host with more listening Agent processes gets the lowest ports and `partial`. */
export const MAX_PORT_ROWS = 40;
/** An open request reuses the last listing for this long, else it lists again first. */
const TARGET_TTL_MS = 10_000;
const STATUSES: ReadonlySet<string> = new Set<AgentStatus>(['initializing', 'running', 'idle', 'error', 'closed', 'archived']);

/** FNV-1a: a short revision of what a viewer renders. */
function revisionOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(36);
}
const clean = (value: string | null | undefined, max: number) => {
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

/**
 * The workspace a directory belongs to, only on an exact match of the resolved paths and only when exactly one
 * workspace has it (several workspaces on one directory leave the port unattributed).
 */
export function workspaceForDirectory(directory: string | null, workspaces: readonly PaseoWorkspace[]): PaseoWorkspace | null {
  if (!directory || !path.isAbsolute(directory)) return null;
  const wanted = path.resolve(directory);
  const matches = workspaces.filter((workspace) => {
    const own = workspace.workspaceDirectory ?? workspace.projectRootPath;
    return !!own && path.isAbsolute(own) && path.resolve(own) === wanted;
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Where one Agent's sockets on a port listen, as one row. scope: every address wins, then a specific non-loopback address
 * (the port reaches beyond this machine), else loopback only. The shared browser connects in an address family the Agent
 * listens on: 127.0.0.1 only when it has an IPv4 socket on 0.0.0.0 or 127.0.0.1; [::1] when it listens on IPv6 `::` or
 * `::1` only (an IPv6-only socket is never reached through 127.0.0.1, where another process may serve the same port);
 * else another loopback address, else the one address a socket is bound to.
 */
export function listenTarget(sockets: readonly Pick<OwnedSocket, 'address'>[]): { scope: BrowserAgentPort['scope']; address: string; host: string } {
  const addresses = sockets.map((socket) => socket.address);
  const other = addresses.find((address) => scopeOf(address) === 'address');
  const scope = addresses.some((address) => scopeOf(address) === 'all') ? 'all' : other ? 'address' : 'local';
  const via = addresses.find((address) => address === '0.0.0.0' || address === '127.0.0.1')
    ?? addresses.find((address) => address === '::' || address === '::1')
    ?? addresses.find((address) => scopeOf(address) === 'local')
    ?? other!;
  return { scope, address: scope === 'address' ? other! : via, host: connectHost(via) };
}

export interface AgentPortOptions {
  scanner?: Pick<PortScanner, 'scan'>;
  now?: () => number;
  ttlMs?: number;
}
export type PortsResult = BrowserPortsReply & { revision: string };

/**
 * Ports Agents opened, for the services sheet. Scans happen only when a viewer asks (the sheet is open and the app in
 * front) and are shared for PORT_SCAN_TTL_MS. A port is listed only when its process carries the id of an Agent this
 * daemon knows (archived ones included): processes of other daemons' Agents and the user's own servers stay out.
 * Agent records come from fetch_agent, which never loads an unloaded Agent.
 */
export class AgentPortService {
  private readonly scanner: Pick<PortScanner, 'scan'>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private last?: PortScan;
  private pending?: Promise<PortScan>;
  private readonly agents = new Map<string, { at: number; value: AgentRecord | null }>();
  private readonly lookups = new Map<string, Promise<AgentRecord | null>>();
  private targets: { at: number; ports: Map<number, PortTarget> } = { at: 0, ports: new Map() };

  constructor(private readonly workspaces: (paseo: Paseo) => Promise<PaseoWorkspace[]>, options: AgentPortOptions = {}) {
    this.scanner = options.scanner ?? new PortScanner();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PORT_SCAN_TTL_MS;
  }

  /** Forget one Agent's record (or all): its title or state changed. */
  invalidateAgent(agentId?: string): void {
    if (agentId) this.agents.delete(agentId); else this.agents.clear();
  }

  async list(paseo: Paseo, workspaceId: string): Promise<PortsResult> {
    let scan: PortScan;
    try { scan = await this.scan(); } catch {
      // A failed scan never fails the panel: the group says so and the next poll tries again.
      const body = { supported: true, items: [], others: [], partial: false, uncertain: false, failed: true };
      return { ...body, scannedAt: this.now(), revision: revisionOf(body) };
    }
    if (!scan.supported) return { supported: false, items: [], others: [], scannedAt: scan.scannedAt, revision: 'unsupported' };
    const ids = [...new Set(scan.sockets.map((socket) => socket.owner.agentId))];
    const agents = new Map(await Promise.all(ids.map(async (id) => [id, await this.agent(paseo, id)] as const)));
    for (const id of [...this.agents.keys()]) if (!agents.has(id)) this.agents.delete(id);
    const directory = await this.workspaces(paseo).catch(() => [] as PaseoWorkspace[]);
    const byId = new Map(directory.map((workspace) => [workspace.id, workspace]));
    const byPort = new Map<number, OwnedSocket[]>();
    for (const socket of scan.sockets) byPort.set(socket.port, [...(byPort.get(socket.port) ?? []), socket]);
    const rows: BrowserAgentPort[] = [], targets = new Map<number, PortTarget>();
    let uncertain = false;
    for (const [port, sockets] of byPort) {
      // Rows only for Agents this daemon knows; an Agent that could not be looked up waits for the next scan.
      const known = sockets.filter((socket) => agents.get(socket.owner.agentId));
      if (!known.length) { if (sockets.some((socket) => agents.get(socket.owner.agentId) === undefined)) uncertain = true; continue; }
      const owner = (known.find((socket) => socket.family === 'tcp') ?? known[0]).owner, agent = agents.get(owner.agentId)!;
      const target = listenTarget(known.filter((socket) => socket.owner.agentId === owner.agentId));
      const workspace = agent.workspaceId ? byId.get(agent.workspaceId) ?? null : workspaceForDirectory(owner.agentCwd, directory);
      const openable = !isBlockedHost(target.host);
      targets.set(port, { url: `http://${target.host}:${port}/`, openable });
      rows.push({
        port, scope: target.scope, ...(target.scope === 'address' ? { address: target.address.slice(0, 64) } : {}), process: programName(owner.name),
        agentId: owner.agentId, agentTitle: agent.title, agentStatus: agent.status,
        workspaceId: agent.workspaceId ?? workspace?.id ?? null,
        workspaceTitle: clean(workspace ? workspace.title ?? workspace.name ?? null : null, 200),
        projectTitle: clean(workspace?.projectDisplayName, 200), openable,
      });
    }
    this.targets = { at: this.now(), ports: targets };
    rows.sort((a, b) => a.port - b.port);
    const mine = rows.filter((row) => row.workspaceId === workspaceId), others = rows.filter((row) => row.workspaceId !== workspaceId);
    const body = {
      supported: true, items: mine.slice(0, MAX_PORT_ROWS), others: others.slice(0, MAX_PORT_ROWS),
      partial: scan.partial || mine.length > MAX_PORT_ROWS || others.length > MAX_PORT_ROWS, uncertain, failed: false,
    };
    return { ...body, scannedAt: scan.scannedAt, revision: revisionOf(body) };
  }

  /**
   * The address to open for a listed port. Only ports of the latest listing open (the client names a port, never an
   * address); a listing older than TARGET_TTL_MS is refreshed first.
   */
  async target(paseo: Paseo, workspaceId: string, port: number): Promise<string> {
    if (!this.targets.ports.has(port) || this.now() - this.targets.at > TARGET_TTL_MS) await this.list(paseo, workspaceId);
    const target = this.targets.ports.get(port);
    if (!target) throw new Error(t('serverError.portNotListed', { port }));
    if (!target.openable) throw new Error(t('serverError.portNotOpenable', { port }));
    return target.url;
  }

  private scan(): Promise<PortScan> {
    if (this.last && this.now() - this.last.scannedAt < this.ttlMs) return Promise.resolve(this.last);
    if (!this.pending) {
      const pending = this.scanner.scan().then((scan) => { this.last = scan; return scan; });
      this.pending = pending;
      void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    }
    return this.pending;
  }

  /** An Agent's record; null: not an Agent of this daemon; undefined: the lookup failed and nothing recent is known. */
  private async agent(paseo: Paseo, agentId: string): Promise<AgentRecord | null | undefined> {
    const cached = this.agents.get(agentId);
    if (cached && this.now() - cached.at < AGENT_TTL_MS) return cached.value;
    let lookup = this.lookups.get(agentId);
    if (!lookup) {
      lookup = this.lookup(paseo, agentId);
      this.lookups.set(agentId, lookup);
      const settled = lookup;
      void settled.finally(() => { if (this.lookups.get(agentId) === settled) this.lookups.delete(agentId); }).catch(() => {});
    }
    try {
      const value = await lookup;
      this.agents.set(agentId, { at: this.now(), value });
      return value;
    } catch {
      return cached && this.now() - cached.at < AGENT_STALE_MS ? cached.value : undefined;
    }
  }

  private async lookup(paseo: Paseo, agentId: string): Promise<AgentRecord | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('agent lookup timed out')), AGENT_TIMEOUT_MS); });
    try {
      const result = await Promise.race([paseo.agents.ref(agentId).refresh(), timeout]);
      const agent = result?.agent;
      // fetch_agent also resolves id prefixes and titles: only this exact id is this Agent.
      if (!agent || agent.id !== agentId) return null;
      const status: AgentStatus = agent.archivedAt ? 'archived' : STATUSES.has(agent.status) ? agent.status as AgentStatus : 'idle';
      return { title: clean(agent.title, 120), status, workspaceId: agent.workspaceId ?? null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
