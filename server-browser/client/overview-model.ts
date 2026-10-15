import { t, type MessageId } from '../shared/text';
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
  if (!value) return t("browserOverview.noPageUrlYet");
  // i18n-ignore: legacy persisted page-location markers.
  if (value === 'about:blank' || value === '本地页面') return t("browserOverview.localPage");
  // i18n-ignore: legacy persisted demo-page marker.
  if (value === '本地体验页') return t("browserOverview.localDemoPage");
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return t("browserOverview.localPage");
    const location = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    return location.length > 160 ? `${location.slice(0, 157)}…` : location;
  } catch { return t("browserOverview.pageUrlUnavailable"); }
}
/** Compact page identity for meta lines: host and path without scheme, query or fragment. */
export function pageHost(value: string | null | undefined): string {
  if (!value || value === 'about:blank') return t("browserOverview.localDemoPage");
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return t("browserOverview.localPage");
    const path = url.pathname === '/' ? '' : url.pathname;
    const location = `${url.host}${path}`;
    return location.length > 80 ? `${location.slice(0, 79)}…` : location;
  } catch { return t("browserOverview.pageUrlUnavailable"); }
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
  if (!agent) return t("browserOverview.noLinkedAgentYet");
  if (agent.needsPermission) return t("browserOverview.waitingForApproval");
  if (agent.status === 'running') return t("browserOverview.running");
  if (agent.status === 'initializing') return t("browserOverview.starting");
  if (agent.status === 'error') return t("browserOverview.error");
  // Not loaded (after a daemon restart, say): opening or messaging it loads it again.
  if (agent.status === 'closed') return t("browserOverview.unloadedWillLoadWhenOpened");
  if (agent.status === 'idle') return t("browserOverview.idle");
  return t("browserOverview.statusPendingSync");
}
function legacyActionLabel(action: string): string {
  const labels: Record<string, string> = {
    '打开网页': t("browserOverview.openPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '返回上一页': t("browserOverview.goBack"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '前往下一页': t("browserOverview.goForward"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '刷新网页': t("browserOverview.reloadPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '打开体验页': t("browserOverview.openDemoPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '停止浏览器': t("browserOverview.stopBrowser"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '重启浏览器': t("browserOverview.restartBrowser"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '新建标签': t("browserOverview.newTab"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '切换标签': t("browserOverview.switchTab"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '关闭标签': t("browserOverview.closeTab"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '固定标签': t("browserOverview.pinTab"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '点击页面': t("browserOverview.clickPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '滚动页面': t("browserOverview.scrollPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '输入文字': t("browserOverview.enterText"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '按下按键': t("browserOverview.pressKey"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '切换操作模式': t("browserOverview.changeInteractionMode"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '调整画面尺寸': t("browserOverview.resizeView"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '填写表单': t("browserOverview.fillForm"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '选择选项': t("browserOverview.selectOption"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '移动鼠标': t("browserOverview.movePointer"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '拖动页面': t("browserOverview.dragPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '查看页面': t("browserOverview.viewPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '查找页面元素': t("browserOverview.findPageElements"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '等待页面': t("browserOverview.waitForPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '截取页面': t("browserOverview.capturePage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '查看控制台': t("browserOverview.viewConsole"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '查看网络请求': t("browserOverview.viewNetworkRequests"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '执行页面操作': t("browserOverview.runPageAction"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '执行浏览器操作': t("browserOverview.runBrowserAction"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '上传文件': t("browserOverview.uploadFile"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '处理网页对话框': t("browserOverview.handlePageDialog"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '阅读网页': t("browserOverview.readPage"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '查看页面诊断': t("browserOverview.viewPageDiagnostics"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '查看标签列表': t("browserOverview.viewTabs"), // i18n-ignore: legacy stored action identity; only the value is translated.
    '浏览器操作': t("browserOverview.browserAction"), // i18n-ignore: legacy stored action identity; only the value is translated.
  };
  return labels[action] || action;
}
export function actionTitle(action: string): string {
  if (/^activity\.[A-Za-z][A-Za-z0-9_]*$/.test(action)) return t(action as MessageId);
  // i18n-ignore: legacy activity labels persisted by older versions, mapped to catalog messages below.
  const fixedLabels = ['打开网页', '返回上一页', '前往下一页', '刷新网页', '打开体验页', '停止浏览器', '重启浏览器', '新建标签', '切换标签', '关闭标签', '固定标签', '点击页面', '滚动页面', '输入文字', '按下按键', '切换操作模式', '调整画面尺寸', '填写表单', '选择选项', '移动鼠标', '拖动页面', '查看页面', '查找页面元素', '等待页面', '截取页面', '查看控制台', '查看网络请求', '执行页面操作', '执行浏览器操作', '上传文件', '处理网页对话框', '阅读网页', '查看页面诊断', '查看标签列表', '浏览器操作'];
  if (fixedLabels.includes(action)) return legacyActionLabel(action);
  const labels: Record<string, string> = {
    navigate: t("browserOverview.openPage"), back: t("browserOverview.back"), forward: t("browserOverview.forward"), reload: t("browserOverview.reloadPage"), demo: t("browserOverview.openDemoPage2"), stop: t("browserOverview.closeBrowser"),
    newTab: t("browserOverview.newTab2"), click: t("browserOverview.clickPage2"), scroll: t("browserOverview.scrollPage2"), text: t("browserOverview.enterText"), key: t("browserOverview.keyboardAction"), mode: t("browserOverview.changeControlMode"),
    viewport: t("browserOverview.resizeView"), tab: t("browserOverview.switchTab2"), closeTab: t("browserOverview.closeTab2"), pin: t("browserOverview.pinTab2"), restart: t("browserOverview.restartBrowser"),
    cleanup: t("browserOverview.cleanUpFiles"), settings: t("browserOverview.changeSettings"), read: t("browserOverview.readPage2"), diagnostics: t("browserOverview.checkPage"), fitWidth: t("browserOverview.fitPageWidth"),
    browser_navigate: t("browserOverview.openPage"), browser_navigate_back: t("browserOverview.back"), browser_snapshot: t("browserOverview.viewPageStructure"), browser_take_screenshot: t("browserOverview.takeScreenshot"),
    browser_click: t("browserOverview.clickPage2"), browser_type: t("browserOverview.enterText"), browser_fill_form: t("browserOverview.fillForm"), browser_press_key: t("browserOverview.keyboardAction"), browser_tabs: t("browserOverview.manageTabs"),
    browser_evaluate: t("browserOverview.inspectOrInteractWithPage"), browser_run_code: t("browserOverview.runPageAction2"), browser_wait_for: t("browserOverview.waitForPage"), browser_select_option: t("browserOverview.selectOption"),
    browser_hover: t("browserOverview.hoverOverPageElement"), browser_drag: t("browserOverview.dragPageElement"), browser_resize: t("browserOverview.resizeView"), browser_close: t("browserOverview.closePage"),
  };
  return labels[action] || labels[action.replace(/^.*\./, '')] || t("browserOverview.browserAction");
}

/** How a state looks everywhere: its colour (tone), its icon and whether it moves (Agent work spins, approvals radiate). */
export type Look = { label: string; tone: Tone; icon: string; motion?: 'spin' | 'ping' };
/** One short state for cards and rows, most urgent first; a quiet browser has none. */
export function browserBadge(item: Pick<BrowserOverviewItem, 'session' | 'agent'>): Look | null {
  const { session } = item, agent = linkedAgent(item as BrowserOverviewItem);
  if (session.status === 'error') return { label: t("browserOverview.error2"), tone: 'danger', icon: 'CircleAlert' };
  if (session.status === 'recovering') return { label: t("browserOverview.recovering"), tone: 'warning', icon: 'RefreshCw', motion: 'spin' };
  if (session.status === 'starting') return { label: t("browserOverview.starting2"), tone: 'info', icon: 'LoaderCircle', motion: 'spin' };
  if (session.status === 'idle') return { label: t("browserOverview.notStarted"), tone: 'gray', icon: 'MonitorOff' };
  if (agent?.needsPermission) return { label: t("browserOverview.needsApproval"), tone: 'warning', icon: 'Hand', motion: 'ping' };
  if (session.health?.state === 'login_required') return { label: t("browserOverview.loginRequired"), tone: 'orange', icon: 'LogIn' };
  if (session.agentBusy || currentAgentActivity(session)) return { label: t("browserOverview.agentIsWorking"), tone: 'info', icon: 'LoaderCircle', motion: 'spin' };
  if (recentActivity(session).some((activity) => activity.source === 'manual' && activity.status === 'running')) return { label: t("browserOverview.manualControl"), tone: 'amber', icon: 'MousePointer2' };
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
