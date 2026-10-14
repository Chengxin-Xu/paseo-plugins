import type { BrowserActivity, BrowserOverviewItem, BrowserOverviewResult, BrowserSession } from '../shared/browser';
import type { Tone } from './kit';

export type OverviewData = { items: BrowserOverviewItem[]; checkedAt: number; revision?: string };
/** Browser activity has no push channel; unchanged polls cost a few bytes thanks to the revision. */
export const OVERVIEW_POLL_MS = 5000;
export const OVERVIEW_STALE_MS = 12_000;

/** Only a foreground app polls: iOS "inactive" (notification centre, calls, app switcher) counts as hidden like "background". */
export function isForeground(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

export function overviewRequest(previous: OverviewData | undefined): { revision?: string } {
  return previous?.revision ? { revision: previous.revision } : {};
}

/** Keep the rendered items, and their identity so memoized tab groups do not rebuild, while the summary is unchanged. */
export function mergeOverview(previous: OverviewData | undefined, result: BrowserOverviewResult): OverviewData {
  if (result.unchanged && previous) return { ...previous, checkedAt: result.checkedAt };
  return { items: result.items ?? [], checkedAt: result.checkedAt, ...(result.items && result.revision ? { revision: result.revision } : {}) };
}

/** Milliseconds until data fetched at `updatedAt` counts as stale; one timer replaces a per-second clock. */
export function staleDelay(updatedAt: number, now: number, staleMs = OVERVIEW_STALE_MS): number {
  return Math.max(0, updatedAt + staleMs - now);
}

type LinkedAgent = BrowserOverviewItem['agent'];

/** Summaries intentionally omit URL credentials, query parameters and fragments. */
export function pageLocation(value: string): string {
  if (!value) return '尚无页面地址';
  if (value === 'about:blank' || value === '本地页面') return '本地页面';
  if (value === '本地体验页') return '本地体验页';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '本地页面';
    const location = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    return location.length > 160 ? `${location.slice(0, 157)}…` : location;
  } catch { return '页面地址暂不可用'; }
}
/** Compact page identity for meta lines: host and path without scheme, query or fragment. */
export function pageHost(value: string | null | undefined): string {
  if (!value || value === 'about:blank') return '本地体验页';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '本地页面';
    const path = url.pathname === '/' ? '' : url.pathname;
    const location = `${url.host}${path}`;
    return location.length > 80 ? `${location.slice(0, 79)}…` : location;
  } catch { return '页面地址暂不可用'; }
}

export function recentActivity(session: BrowserSession | null | undefined): BrowserActivity[] {
  return [...(session?.activity ?? [])].sort((left, right) => right.startedAt - left.startedAt).slice(0, 12);
}
export function currentAgentActivity(session: BrowserSession | null | undefined): BrowserActivity | undefined {
  return [...(session?.activity ?? [])].filter((activity) => activity.source === 'agent' && activity.status === 'running').sort((left, right) => right.startedAt - left.startedAt)[0];
}
export function linkedAgent(item: BrowserOverviewItem | undefined, session: BrowserSession | null | undefined = item?.session): LinkedAgent {
  return item?.agent && item.agent.id === session?.agentId ? item.agent : null;
}
export function agentStatus(agent: LinkedAgent): string {
  if (!agent) return '尚未关联 Agent';
  if (agent.needsPermission) return '等待审批';
  if (agent.status === 'running') return '运行中';
  if (agent.status === 'initializing') return '正在启动';
  if (agent.status === 'error') return '出错';
  // Not loaded (after a daemon restart, say): opening or messaging it loads it again.
  if (agent.status === 'closed') return '未载入，打开时自动载入';
  if (agent.status === 'idle') return '空闲';
  return '状态待同步';
}
export function actionTitle(action: string): string {
  const fixedLabels = ['打开网页', '返回上一页', '前往下一页', '刷新网页', '打开体验页', '停止浏览器', '重启浏览器', '新建标签', '切换标签', '关闭标签', '固定标签', '点击页面', '滚动页面', '输入文字', '按下按键', '切换操作模式', '调整画面尺寸', '填写表单', '选择选项', '移动鼠标', '拖动页面', '查看页面', '查找页面元素', '等待页面', '截取页面', '查看控制台', '查看网络请求', '执行页面操作', '执行浏览器操作', '上传文件', '处理网页对话框', '阅读网页', '查看页面诊断', '查看标签列表', '浏览器操作'];
  if (fixedLabels.includes(action)) return action;
  const labels: Record<string, string> = {
    navigate: '打开网页', back: '后退', forward: '前进', reload: '刷新网页', demo: '打开演示页', stop: '关闭浏览器',
    newTab: '新建标签页', click: '点击网页', scroll: '滚动网页', text: '输入文字', key: '键盘操作', mode: '切换控制模式',
    viewport: '调整画面尺寸', tab: '切换标签页', closeTab: '关闭标签页', pin: '固定标签页', restart: '重启浏览器',
    cleanup: '清理文件', settings: '修改设置', read: '读取网页', diagnostics: '检查页面', fitWidth: '适应页面宽度',
    browser_navigate: '打开网页', browser_navigate_back: '后退', browser_snapshot: '查看页面结构', browser_take_screenshot: '获取截图',
    browser_click: '点击网页', browser_type: '输入文字', browser_fill_form: '填写表单', browser_press_key: '键盘操作', browser_tabs: '管理标签页',
    browser_evaluate: '检查或操作网页', browser_run_code: '执行网页操作', browser_wait_for: '等待页面', browser_select_option: '选择选项',
    browser_hover: '指向网页元素', browser_drag: '拖动网页元素', browser_resize: '调整画面尺寸', browser_close: '关闭页面',
  };
  return labels[action] || labels[action.replace(/^.*\./, '')] || '浏览器操作';
}

/** How a state looks everywhere: its colour (tone), its icon and whether it moves (Agent work spins, approvals radiate). */
export type Look = { label: string; tone: Tone; icon: string; motion?: 'spin' | 'ping' };
/** One short state for cards and rows, most urgent first; a quiet browser has none. */
export function browserBadge(item: Pick<BrowserOverviewItem, 'session' | 'agent'>): Look | null {
  const { session } = item, agent = linkedAgent(item as BrowserOverviewItem);
  if (session.status === 'error') return { label: '异常', tone: 'danger', icon: 'CircleAlert' };
  if (session.status === 'recovering') return { label: '恢复中', tone: 'warning', icon: 'RefreshCw', motion: 'spin' };
  if (session.status === 'starting') return { label: '启动中', tone: 'info', icon: 'LoaderCircle', motion: 'spin' };
  if (session.status === 'idle') return { label: '未启动', tone: 'gray', icon: 'MonitorOff' };
  if (agent?.needsPermission) return { label: '待审批', tone: 'warning', icon: 'Hand', motion: 'ping' };
  if (session.health?.state === 'login_required') return { label: '需登录', tone: 'orange', icon: 'LogIn' };
  if (session.agentBusy || currentAgentActivity(session)) return { label: 'Agent 操作中', tone: 'info', icon: 'LoaderCircle', motion: 'spin' };
  if (recentActivity(session).some((activity) => activity.source === 'manual' && activity.status === 'running')) return { label: '人工操作中', tone: 'amber', icon: 'MousePointer2' };
  return null;
}

export type OverviewFilter = 'all' | 'agent' | 'takeover';
export function matchesOverviewFilter(item: BrowserOverviewItem, filter: OverviewFilter): boolean {
  if (filter === 'agent') return !!(item.session.agentBusy || currentAgentActivity(item.session));
  if (filter === 'takeover') return item.session.health?.state === 'login_required' || !!linkedAgent(item)?.needsPermission;
  return true;
}
export function matchesOverviewSearch(item: BrowserOverviewItem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [item.workspace.projectTitle, item.workspace.title, linkedAgent(item)?.title, item.session.title, pageLocation(item.session.url)].filter(Boolean).join(' ').toLowerCase().includes(needle);
}
export function overviewCounts(items: readonly BrowserOverviewItem[]): Record<OverviewFilter, number> {
  return { all: items.length, agent: items.filter((item) => matchesOverviewFilter(item, 'agent')).length, takeover: items.filter((item) => matchesOverviewFilter(item, 'takeover')).length };
}

/** Markdown extraction reads better without heading and emphasis markers in a plain text view. */
export function readable(markdown: string): string {
  return markdown.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
}
