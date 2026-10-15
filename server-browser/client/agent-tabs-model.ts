import { t } from '../shared/text';
import type { BrowserOverviewItem, BrowserWorkspace } from '../shared/browser';
import type { Hue } from './kit';
import type { Look } from './overview-model';

export type BrowserAgentTab = {
  workspaceId: string;
  workspaceTitle: string;
  projectKey: string;
  projectTitle: string;
  /** Project display name, the key of the project's colour in every plugin (`hueFor`). */
  identity: string;
  agentId: string | null;
  title: string;
  subtitle: string;
  kind: 'agent' | 'manual' | 'unavailable';
  state: 'browser_busy' | 'permission' | 'login' | 'agent_running' | 'idle' | 'offline' | 'error';
  /** Who controls a running browser; null while it is not running. */
  mode: 'agent' | 'manual' | null;
  statusLabel: string;
  accessibilityLabel: string;
};
export type AgentTabGroup = { projectKey: string; projectTitle: string; identity: string; tabs: BrowserAgentTab[] };

/**
 * Who is in control, the same everywhere: the Agent violet, the viewer (手动) amber — while you hold the page the Agent
 * waits for you, and amber is never a project colour (`hueFor`), so a manual browser cannot be mistaken for a project.
 */
export const controlLooks = {
  agent: { get label() { return t("agentTabs.agent"); }, icon: 'Bot', hue: 'violet' },
  manual: { get label() { return t("agentTabs.manual"); }, icon: 'MousePointer2', hue: 'amber' },
} as const satisfies Record<'agent' | 'manual', { label: string; icon: string; hue: Hue }>;

/** States worth a glance get a mark (errors red, approvals amber, login orange, Agent work blue); a quiet browser under manual control shows the amber pointer. */
export function tabGlyph(state: BrowserAgentTab['state'], mode: BrowserAgentTab['mode'] = null): Look | null {
  if (state === 'error') return { get label() { return t("agentTabs.error"); }, icon: 'CircleAlert', tone: 'danger' };
  if (state === 'permission') return { get label() { return t("agentTabs.needsApproval"); }, icon: 'Hand', tone: 'warning', motion: 'ping' };
  if (state === 'login') return { get label() { return t("agentTabs.loginRequired"); }, icon: 'LogIn', tone: 'orange' };
  if (state === 'browser_busy') return { get label() { return t("agentTabs.agentIsWorking"); }, icon: 'LoaderCircle', tone: 'info', motion: 'spin' };
  if (mode === 'manual' && state !== 'offline') return { get label() { return t("agentTabs.manual"); }, icon: controlLooks.manual.icon, tone: controlLooks.manual.hue };
  return null;
}

export function browserProjectKey(workspace: BrowserWorkspace): string {
  return workspace.projectId ? `project:${workspace.projectId}` : `workspace:${workspace.id}`;
}
function safeLabel(value: string | null | undefined, fallback: string): string {
  return (value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) || fallback;
}
/** The name a project is known by across plugins; a workspace without a project goes by its own title. */
export function projectName(workspace: BrowserWorkspace): string {
  return safeLabel(workspace.projectTitle, '') || safeLabel(workspace.title, t("agentTabs.workspace"));
}
export function projectColorIdentity(workspace: BrowserWorkspace): string {
  return safeLabel(workspace.projectTitle, '') || safeLabel(workspace.title, '') || workspace.id;
}
function makeTab(workspace: BrowserWorkspace, item?: BrowserOverviewItem): BrowserAgentTab {
  const projectKey = browserProjectKey(workspace);
  const projectTitle = safeLabel(workspace.projectTitle, t("agentTabs.project"));
  const workspaceTitle = safeLabel(workspace.title, t("agentTabs.workspace"));
  const session = item?.session;
  // A workspace's unrelated running agents never become browser agent tabs.
  const agent = item?.agent && item.agent.id === session?.agentId && session.workspaceId === workspace.id ? item.agent : null;
  const kind = agent ? 'agent' : session?.agentId ? 'unavailable' : 'manual';
  const title = agent ? safeLabel(agent.title, t("agentTabs.browserAgent")) : kind === 'unavailable' ? t("agentTabs.agentUnavailable") : t("agentTabs.manualBrowsing");
  const busy = session?.agentBusy || session?.activity?.some((activity) => activity.source === 'agent' && activity.status === 'running');
  let state: BrowserAgentTab['state'] = 'idle';
  let statusLabel = agent ? t("agentTabs.idle") : kind === 'unavailable' ? t("agentTabs.linkedAgentUnavailable") : t("agentTabs.noLinkedAgent");
  if (session?.status === 'error') { state = 'error'; statusLabel = t("agentTabs.browserError"); }
  else if (session?.status === 'recovering') { state = 'offline'; statusLabel = t("agentTabs.browserIsRecovering"); }
  else if (agent?.needsPermission) { state = 'permission'; statusLabel = t("agentTabs.waitingForApproval"); }
  else if (session?.health?.state === 'login_required' && session.status === 'running') { state = 'login'; statusLabel = t("agentTabs.pageRequiresLogin"); }
  else if (busy) { state = 'browser_busy'; statusLabel = t("agentTabs.usingTheBrowser"); }
  else if (agent?.status === 'running' || agent?.status === 'initializing') { state = 'agent_running'; statusLabel = t("agentTabs.agentIsRunningBrowserIsWaitingFor"); }
  else if (agent?.status === 'error') { state = 'error'; statusLabel = t("agentTabs.agentError"); }
  // `closed` is an unloaded Agent (after a daemon restart, say): still linked, it loads when opened.
  else if (agent?.status === 'closed' && session?.status === 'running') statusLabel = t("agentTabs.agentIsUnloadedAndWillLoadWhen");
  else if (session?.status === 'idle' || !session) { state = 'offline'; statusLabel = t("agentTabs.browserHasNotStarted"); }
  const mode = session?.status === 'running' ? session.mode : null;
  return { workspaceId: workspace.id, workspaceTitle, projectKey, projectTitle, identity: projectColorIdentity(workspace), agentId: agent?.id || session?.agentId || null, title, subtitle: workspaceTitle, kind, state, mode, statusLabel, accessibilityLabel: t("agentTabs.workspace2", { value1: projectTitle, value2: title, value3: workspaceTitle, value4: statusLabel }) };
}

/** Existing sessions only, plus the explicitly selected workspace when it has no session yet. */
export function buildAgentTabGroups(items: readonly BrowserOverviewItem[], selectedWorkspace?: BrowserWorkspace): AgentTabGroup[] {
  const workspaces = new Map<string, BrowserOverviewItem>();
  for (const item of items) {
    const previous = workspaces.get(item.workspace.id);
    if (!previous || item.observedAt >= previous.observedAt) workspaces.set(item.workspace.id, item);
  }
  const tabs = [...workspaces.values()].map((item) => makeTab(item.workspace, item));
  if (selectedWorkspace && !workspaces.has(selectedWorkspace.id)) tabs.push(makeTab(selectedWorkspace));
  const groups = new Map<string, AgentTabGroup>();
  for (const tab of tabs) {
    const group = groups.get(tab.projectKey) || { projectKey: tab.projectKey, projectTitle: tab.projectTitle, identity: tab.identity, tabs: [] };
    group.tabs.push(tab); groups.set(tab.projectKey, group);
  }
  return [...groups.values()].sort((left, right) => left.projectKey.localeCompare(right.projectKey)).map((group) => ({
    ...group,
    tabs: group.tabs.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)).map((tab) => {
      const duplicate = group.tabs.some((other) => other.workspaceId !== tab.workspaceId && other.title === tab.title && other.workspaceTitle === tab.workspaceTitle);
      if (!duplicate) return tab;
      const suffix = tab.workspaceId.slice(-6);
      return { ...tab, subtitle: t("agentTabs.formatted", { value1: tab.workspaceTitle, value2: suffix }), accessibilityLabel: t("agentTabs.id", { value1: tab.accessibilityLabel, value2: suffix }) };
    }),
  }));
}
