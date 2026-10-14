/** Explicit targets keep live acceptance from touching a developer's default sessions. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export function testValue(name, aliases = [], { optional = false } = {}) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  if (optional) return undefined;
  throw new Error(`Set ${name} explicitly before running this live acceptance test.`);
}

export function testWorkspace({ linked = false, aliases = [], optional = false } = {}) {
  const name = linked ? 'BROWSER_TEST_LINKED_WORKSPACE' : 'BROWSER_TEST_WORKSPACE';
  const value = testValue(name, aliases, { optional });
  if (value && !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`${name} must be an exact workspace ID from the selected daemon.`);
  return value;
}

export function assertSeparateWorkspaces(workspaceId, linkedWorkspaceId) {
  if (workspaceId && workspaceId === linkedWorkspaceId) throw new Error('BROWSER_TEST_WORKSPACE and BROWSER_TEST_LINKED_WORKSPACE must identify different existing workspaces.');
}

export const runtimeRoot = path.resolve(process.env.PASEO_SERVER_BROWSER_RUNTIME || path.join(homedir(), '.local/share/paseo-server-browser'));
/** Per-workspace browser data (profile, session.json), as the plugin resolves it. */
export const dataRoot = path.resolve(process.env.PASEO_SERVER_BROWSER_DATA || path.join(runtimeRoot, 'visual'));
export const baseUrl = process.env.BROWSER_TEST_BASE_URL || 'http://127.0.0.1:6767';
export const daemonUrl = process.env.BROWSER_TEST_DAEMON_URL || (() => {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
})();

export function testChromium() {
  const localRequire = createRequire(import.meta.url);
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  try { return runtimeRequire('playwright').chromium; }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    try { return localRequire('playwright').chromium; }
    catch (localError) {
      if (localError.code !== 'MODULE_NOT_FOUND') throw localError;
      return localRequire('playwright-core').chromium;
    }
  }
}

export function browserLaunchOptions() {
  const env = { ...process.env };
  const lib = path.join(runtimeRoot, 'lib');
  if (existsSync(lib)) env.LD_LIBRARY_PATH = [lib, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  const fontConfig = path.join(runtimeRoot, 'fonts.conf');
  if (!env.FONTCONFIG_FILE && existsSync(fontConfig)) env.FONTCONFIG_FILE = fontConfig;
  const executablePath = process.env.BROWSER_TEST_EXECUTABLE || process.env.PASEO_BROWSER_EXECUTABLE;
  return { headless: true, ...(executablePath ? { executablePath } : {}), env };
}

/** Acceptance scripts are viewers too: obtain a fresh frame before a page-changing RPC. */
export async function invokeBrowserRpc(daemon, method, input) {
  if (method === 'browser.action' && !input.target && !['mode', 'stop', 'restart', 'cleanup', 'settings', 'handleDialog'].includes(input.action.kind)) {
    const { frame } = await daemon.invokePluginRpc('server-browser', 'browser.frame', { workspaceId: input.workspaceId });
    if (!frame) throw new Error('A current browser frame is required before this acceptance action.');
    input = { ...input, target: { tabId: frame.tabId, viewRevision: frame.viewRevision } };
  }
  return daemon.invokePluginRpc('server-browser', method, input);
}
