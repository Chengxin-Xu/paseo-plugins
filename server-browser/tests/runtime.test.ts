import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '../server/browser-manager';
import { browserProxy, browserSandbox, chromiumArguments, defaultRuntimeRoot } from '../server/runtime';

test('runtime and data directories default under the home directory and follow their environment variables', () => {
  assert.match(defaultRuntimeRoot({}), /[/\\]\.local[/\\]share[/\\]paseo-server-browser$/);
  assert.equal(defaultRuntimeRoot({ PASEO_SERVER_BROWSER_RUNTIME: '/srv/browser-runtime' }), '/srv/browser-runtime');
  assert.match(defaultRuntimeRoot({ PASEO_SERVER_BROWSER_RUNTIME: '' }), /paseo-server-browser$/);
  const previous = process.env.PASEO_SERVER_BROWSER_DATA;
  try {
    process.env.PASEO_SERVER_BROWSER_DATA = '';
    assert.equal(new BrowserManager({ runtimeRoot: '/srv/browser-runtime' }).dataRoot, path.join('/srv/browser-runtime', 'visual'));
    process.env.PASEO_SERVER_BROWSER_DATA = '/srv/browser-data';
    assert.equal(new BrowserManager({ runtimeRoot: '/srv/browser-runtime' }).bridgePath, path.join('/srv/browser-data', 'mcp-bridge.mjs'));
  } finally { if (previous === undefined) delete process.env.PASEO_SERVER_BROWSER_DATA; else process.env.PASEO_SERVER_BROWSER_DATA = previous; }
});

test('Chromium keeps its debugging port on loopback; proxy and sandbox are explicit opt-ins', () => {
  const base = chromiumArguments({ profileDir: '/data/ws/profile', width: 1120, height: 720 });
  assert(base.includes('--no-sandbox'));
  assert(base.includes('--remote-debugging-address=127.0.0.1'));
  assert(base.includes('--remote-debugging-port=0'));
  assert(base.includes('--user-data-dir=/data/ws/profile'));
  assert(base.includes('--window-size=1120,720'));
  assert(!base.some(argument => argument.startsWith('--proxy-server')));
  assert.equal(base.at(-1), 'about:blank');
  const hardened = chromiumArguments({ profileDir: '/p', width: 390, height: 760, proxy: 'http://proxy.example.com:3128', sandbox: true });
  assert(!hardened.includes('--no-sandbox'));
  assert(hardened.includes('--proxy-server=http://proxy.example.com:3128'));

  assert.equal(browserProxy({}), undefined);
  assert.equal(browserProxy({ PASEO_SERVER_BROWSER_PROXY: '  ' }), undefined);
  assert.equal(browserProxy({ PASEO_SERVER_BROWSER_PROXY: ' socks5://127.0.0.1:1080 ' }), 'socks5://127.0.0.1:1080');
  assert.throws(() => browserProxy({ PASEO_SERVER_BROWSER_PROXY: 'proxy.example.com:3128 --disable-web-security' }), /PASEO_SERVER_BROWSER_PROXY/);
  assert.equal(browserSandbox({}), false);
  assert.equal(browserSandbox({ PASEO_SERVER_BROWSER_SANDBOX: '1' }), true);
  assert.equal(browserSandbox({ PASEO_SERVER_BROWSER_SANDBOX: 'true' }), false);
});

test('a host without the prepared runtime gets setup guidance instead of a module or file error', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'paseo-browser-missing-runtime-'));
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'paseo-browser-empty-runtime-'));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtimeRoot, 'no-browser-cache');
  const manager = new BrowserManager({ dataRoot, runtimeRoot });
  try {
    await assert.rejects(manager.start('missing-runtime'), /运行时未准备[\s\S]*setup-runtime\.mjs/);
    const state = await manager.state('missing-runtime');
    assert.equal(state.status, 'error');
    assert.match(state.error ?? '', /setup-runtime\.mjs/);
    const diagnostics = await manager.diagnostics('missing-runtime');
    assert.equal(diagnostics.checks.find(check => check.name === 'Agent 工具')?.status, 'warning');
    assert.equal(diagnostics.checks.find(check => check.name === '网络与代理')?.status, 'ok');
    const configured = new BrowserManager({ dataRoot, runtimeRoot, executablePath: path.join(runtimeRoot, 'missing-chrome') });
    try { await assert.rejects(configured.start('missing-executable'), /PASEO_SERVER_BROWSER_EXECUTABLE/); }
    finally { await configured.close(); }
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await manager.close();
    await rm(dataRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
