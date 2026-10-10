import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '../server/browser-manager';
import { browserProxy, browserSandboxMode, chromiumArguments, chromiumEnvironment, defaultRuntimeRoot, inheritedEnvironment, MCP_ENVIRONMENT } from '../server/runtime';

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

test('Chromium keeps its debugging port on loopback; the proxy is an opt-in and the sandbox follows its mode', () => {
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
  for (const value of ['http://user:secret@proxy.invalid:3128', 'user:secret@proxy.invalid:3128', 'socks5://token@proxy.invalid:1080'])
    assert.throws(() => browserProxy({ PASEO_SERVER_BROWSER_PROXY: value }), /不能包含账号密码/, value);
  const rules = base.find(argument => argument.startsWith('--host-resolver-rules='));
  assert(rules?.includes('MAP 169.254.* ~NOTFOUND') && rules.includes('MAP metadata.google.internal ~NOTFOUND'), 'metadata addresses fail to resolve inside Chromium');
  assert.equal(browserSandboxMode({}), 'auto');
  assert.equal(browserSandboxMode({ PASEO_SERVER_BROWSER_SANDBOX: '1' }), 'on');
  assert.equal(browserSandboxMode({ PASEO_SERVER_BROWSER_SANDBOX: '0' }), 'off');
  assert.equal(browserSandboxMode({ PASEO_SERVER_BROWSER_SANDBOX: 'true' }), 'auto');
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

test('Chromium and Playwright MCP inherit an allowlisted environment; the runtime lib/ joins LD_LIBRARY_PATH only when present', () => {
  const daemon = { PATH: '/usr/bin', HOME: '/home/user', LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/run/user/1000',
    HTTPS_PROXY: 'http://proxy.example.com:3128', no_proxy: 'localhost', CHROME_DEVEL_SANDBOX: '/opt/chrome/chrome-sandbox', FONTCONFIG_FILE: '/etc/fonts/custom.conf',
    ANTHROPIC_API_KEY: 'secret', GITHUB_TOKEN: 'secret', NODE_OPTIONS: '--require /tmp/hook.js', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus', SSL_KEYLOG_FILE: '/tmp/keys', PASEO_HOME: '/home/user/.paseo' };
  const chromium = chromiumEnvironment(daemon);
  assert.deepEqual(Object.keys(chromium).sort(), ['CHROME_DEVEL_SANDBOX', 'FONTCONFIG_FILE', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR', 'no_proxy']);
  assert.equal(chromium.LD_LIBRARY_PATH, undefined, 'no runtime lib/ and none inherited: no LD_LIBRARY_PATH at all');
  const withLib = chromiumEnvironment({ ...daemon, LD_LIBRARY_PATH: '/opt/lib' }, { libDirectory: '/runtime/lib', fontsConf: '/runtime/fonts.conf' });
  assert.equal(withLib.LD_LIBRARY_PATH, '/runtime/lib:/opt/lib');
  assert.equal(withLib.FONTCONFIG_FILE, '/runtime/fonts.conf');
  assert.equal(chromiumEnvironment({ ...daemon, LD_LIBRARY_PATH: '/opt/lib' }).LD_LIBRARY_PATH, '/opt/lib');
  const mcp = inheritedEnvironment(daemon, MCP_ENVIRONMENT.names, MCP_ENVIRONMENT.prefixes);
  assert.deepEqual(Object.keys(mcp).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR']);
});
