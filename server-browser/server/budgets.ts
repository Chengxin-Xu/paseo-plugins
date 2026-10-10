/**
 * Time limits shared by the control endpoint and the MCP bridge. The bridge waits a little longer than the
 * server works on each request, so it gets an answer instead of giving up while the server still holds a lease.
 */
export const BUDGETS = {
  /** Bridge: acquire, validate, release and disconnect requests. */
  controlMs: 5_000,
  /** Server: work behind one acquire, validate or release request. */
  controlServerMs: 4_000,
  /** Bridge: page reading and diagnostics requests. */
  readMs: 15_000,
  /** Server: one script run in the page to read its content. */
  pageReadMs: 10_000,
  /** Bridge: tab requests, which can open a page. */
  tabsMs: 45_000,
  /** Server: opening a page in a new tab for the Agent. */
  tabNavigationMs: 30_000,
  /** Bridge: one Playwright MCP tool call; the MCP process is restarted after this. */
  mcpCallMs: 90_000,
  /** Bridge: the tab list and selection the bridge sends Playwright MCP before each call. */
  mcpInternalMs: 30_000,
  /** Server: a lease that is not renewed within this time is revoked. Longer than one MCP call plus a release. */
  leaseTtlMs: 120_000,
  /** Server: reading a page title. */
  titleMs: 1_000,
  /** Server: reading the page's own viewport size. */
  viewportProbeMs: 1_000,
  /** Server: one page measurement for "fit width". */
  measureMs: 5_000,
  /** Server: the login and content check in page diagnostics. */
  diagnosticsScriptMs: 3_000,
};
export type Budgets = typeof BUDGETS;

/** The subset the bridge script receives. */
export const bridgeBudgets = (budgets: Budgets = BUDGETS) => ({
  controlMs: budgets.controlMs, readMs: budgets.readMs, tabsMs: budgets.tabsMs, mcpCallMs: budgets.mcpCallMs, mcpInternalMs: budgets.mcpInternalMs,
});

/** Settle with onTimeout() when the operation has not settled within ms. The operation itself keeps running. */
export function withTimeout<T>(operation: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => { try { resolve(onTimeout()); } catch (error) { reject(error); } }, ms);
    timer.unref?.();
  });
  return Promise.race([operation, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}
