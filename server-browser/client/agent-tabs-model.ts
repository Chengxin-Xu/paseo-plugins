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
  agent: { label: 'Agent', icon: 'Bot', hue: 'violet' },
  manual: { label: '手动', icon: 'MousePointer2', hue: 'amber' },
} as const satisfies Record<'agent' | 'manual', { label: string; icon: string; hue: Hue }>;

/** States worth a glance get a mark (errors red, approvals amber, login orange, Agent work blue); a quiet browser under manual control shows the amber pointer. */
export function tabGlyph(state: BrowserAgentTab['state'], mode: BrowserAgentTab['mode'] = null): Look | null {
  if (state === 'error') return { label: '异常', icon: 'CircleAlert', tone: 'danger' };
  if (state === 'permission') return { label: '待审批', icon: 'Hand', tone: 'warning', motion: 'ping' };
  if (state === 'login') return { label: '需登录', icon: 'LogIn', tone: 'orange' };
  if (state === 'browser_busy') return { label: 'Agent 操作中', icon: 'LoaderCircle', tone: 'info', motion: 'spin' };
  if (mode === 'manual' && state !== 'offline') return { label: '手动', icon: controlLooks.manual.icon, tone: controlLooks.manual.hue };
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
  return safeLabel(workspace.projectTitle, '') || safeLabel(workspace.title, '工作区');
}
function makeTab(workspace: BrowserWorkspace, item?: BrowserOverviewItem): BrowserAgentTab {
  const projectKey = browserProjectKey(workspace);
  const projectTitle = safeLabel(workspace.projectTitle, '项目');
  const workspaceTitle = safeLabel(workspace.title, '工作区');
  const session = item?.session;
  // A workspace's unrelated running agents never become browser agent tabs.
  const agent = item?.agent && item.agent.id === session?.agentId && session.workspaceId === workspace.id ? item.agent : null;
  const kind = agent ? 'agent' : session?.agentId ? 'unavailable' : 'manual';
  const title = agent ? safeLabel(agent.title, '浏览器 Agent') : kind === 'unavailable' ? 'Agent 暂不可用' : '手动浏览';
  const busy = session?.agentBusy || session?.activity?.some((activity) => activity.source === 'agent' && activity.status === 'running');
  let state: BrowserAgentTab['state'] = 'idle';
  let statusLabel = agent ? '空闲' : kind === 'unavailable' ? '关联 Agent 暂不可用' : '未关联 Agent';
  if (session?.status === 'error') { state = 'error'; statusLabel = '浏览器异常'; }
  else if (session?.status === 'recovering') { state = 'offline'; statusLabel = '浏览器恢复中'; }
  else if (agent?.needsPermission) { state = 'permission'; statusLabel = '等待审批'; }
  else if (session?.health?.state === 'login_required' && session.status === 'running') { state = 'login'; statusLabel = '页面需要登录'; }
  else if (busy) { state = 'browser_busy'; statusLabel = '正在操作浏览器'; }
  else if (agent?.status === 'running' || agent?.status === 'initializing') { state = 'agent_running'; statusLabel = 'Agent 运行中，浏览器等待任务'; }
  else if (agent?.status === 'error') { state = 'error'; statusLabel = 'Agent 出错'; }
  else if (agent?.status === 'closed') { state = 'offline'; statusLabel = 'Agent 已结束'; }
  else if (session?.status === 'idle' || !session) { state = 'offline'; statusLabel = '浏览器未启动'; }
  const mode = session?.status === 'running' ? session.mode : null;
  return { workspaceId: workspace.id, workspaceTitle, projectKey, projectTitle, identity: projectName(workspace), agentId: agent?.id || session?.agentId || null, title, subtitle: workspaceTitle, kind, state, mode, statusLabel, accessibilityLabel: `${projectTitle}，${title}，工作区 ${workspaceTitle}，${statusLabel}` };
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
      return { ...tab, subtitle: `${tab.workspaceTitle} · ${suffix}`, accessibilityLabel: `${tab.accessibilityLabel}，标识 ${suffix}` };
    }),
  }));
}
