import { t } from '../shared/text';
import type { BrowserAgentPort, BrowserPortsReply } from '../shared/browser';
import type { Tone } from './kit';

/** What a viewer renders for the ports group; kept across `unchanged` replies. */
export type PortsData = {
  supported: boolean; items: BrowserAgentPort[]; others: BrowserAgentPort[];
  partial: boolean; uncertain: boolean; failed: boolean; scannedAt: number; revision: string | null;
};
/** Visible in the services and tabs sheets only, in front, every few seconds; the server shares one scan between viewers. */
export const PORTS_POLL_MS = 4_000;

export function portsRequest(workspaceId: string, previous: PortsData | undefined): { workspaceId: string; revision?: string } {
  return previous?.revision ? { workspaceId, revision: previous.revision } : { workspaceId };
}
/** The reply as rendered data: an `unchanged` reply keeps what the viewer already has. */
export function mergePorts(previous: PortsData | undefined, reply: BrowserPortsReply): PortsData {
  if (reply.unchanged && previous && reply.revision === previous.revision) return { ...previous, scannedAt: reply.scannedAt };
  return {
    supported: reply.supported, items: reply.items ?? [], others: reply.others ?? [],
    partial: !!reply.partial, uncertain: !!reply.uncertain, failed: !!reply.failed, scannedAt: reply.scannedAt, revision: reply.revision ?? null,
  };
}

/** A row's identity: the same port of another Agent is a new row (and flashes as one). */
export const portKey = (port: Pick<BrowserAgentPort, 'port' | 'agentId'>) => `${port.port}:${port.agentId}`;

export type PortLook = { tone: Tone; label: string; working: boolean; stopped: boolean };
const STATE_LABELS = {
  initializing: 'agentPorts.running', running: 'agentPorts.running', idle: 'agentPorts.idle',
  error: 'agentPorts.error', closed: 'agentPorts.closed', archived: 'agentPorts.archived',
} as const;
/** Blue while the Agent works, green while it waits, amber once it stopped (or failed) and its process still holds the port. */
export function portLook(port: Pick<BrowserAgentPort, 'agentStatus'>): PortLook {
  const working = port.agentStatus === 'running' || port.agentStatus === 'initializing';
  const stopped = port.agentStatus === 'error' || port.agentStatus === 'closed' || port.agentStatus === 'archived';
  return { tone: working ? 'info' : stopped ? 'warning' : 'success', label: t(STATE_LABELS[port.agentStatus]), working, stopped };
}
export function scopeLabel(port: Pick<BrowserAgentPort, 'scope' | 'address'>): string {
  return port.scope === 'all' ? t('agentPorts.all') : port.scope === 'local' ? t('agentPorts.local') : t('agentPorts.address', { address: port.address ?? '' });
}
/** Every address reaches beyond this machine (orange); loopback only stays local (teal); one other address in between (sky). */
export const scopeTone = (port: Pick<BrowserAgentPort, 'scope'>): Tone => port.scope === 'all' ? 'orange' : port.scope === 'local' ? 'teal' : 'sky';
export const agentName = (port: Pick<BrowserAgentPort, 'agentTitle'>) => port.agentTitle || t('agentPorts.untitled');
export const processName = (port: Pick<BrowserAgentPort, 'process'>) => port.process || t('agentPorts.unnamedProcess');
export function workspaceName(port: Pick<BrowserAgentPort, 'projectTitle' | 'workspaceTitle'>): string | null {
  const parts = [port.projectTitle, port.workspaceTitle].filter((part): part is string => !!part);
  return parts.length === 2 && parts[0] === parts[1] ? parts[0] : parts.length ? parts.join(' / ') : null;
}
export function openLabel(port: BrowserAgentPort): string {
  return t('agentPorts.openLabel', { port: port.port, agent: agentName(port), process: processName(port), scope: scopeLabel(port), state: portLook(port).label });
}

/**
 * Rows to announce: present now, absent from what this sheet showed before. The first data a sheet shows is the baseline
 * (nothing flashes on open); ports seen later flash once.
 */
export function freshPorts(known: ReadonlySet<string> | null, ports: readonly BrowserAgentPort[]): Set<string> {
  if (!known) return new Set();
  return new Set(ports.map(portKey).filter((key) => !known.has(key)));
}
