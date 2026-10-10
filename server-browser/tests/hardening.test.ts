import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { chromium } from 'playwright-core';
import { BrowserManager, type BrowserManagerOptions } from '../server/browser-manager';
import { defaultRuntimeRoot } from '../server/runtime';

// Real Chromium with temporary profiles and a synthetic loopback site. No daemon, account or existing browser is touched.
const runtimeRoot = defaultRuntimeRoot();
const pause = (ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A request the client gives up on after ms, like the bridge does at the end of its budget. */
const abortAfter = (ms:number) => { const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal; };
type Metadata = { endpoint:string; token:string; cdpEndpoint:string; browserPid:number; workspaceDirectory:string|null };
const metadata = async (manager:BrowserManager, workspaceId:string) => JSON.parse(await readFile(manager.metadataPath(workspaceId), 'utf8')) as Metadata;

async function site(t:TestContext) {
  const hits:string[] = [];
  const server:Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');hits.push(request.url ?? '/');
    if (url.pathname === '/hang') return; // never answers
    if (url.pathname === '/redirect') { response.writeHead(302, { location:'http://169.254.0.1:8/' }); response.end(); return; }
    const send = () => { response.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' }); response.end(
      // /busy blocks the page's main thread for ms milliseconds, starting delay milliseconds after it loaded.
      url.pathname === '/busy' ? `<!doctype html><title>Busy page</title><p>busy</p><script>setTimeout(()=>{const end=Date.now()+${Number(url.searchParams.get('ms') ?? 3000)};while(Date.now()<end){}},${Number(url.searchParams.get('delay') ?? 1000)})</script>`
        : `<!doctype html><title>${url.pathname.slice(1) || 'home'}</title><p>${url.pathname}</p><input id="file" type="file">`); };
    if (url.pathname === '/slow') { setTimeout(send, Number(url.searchParams.get('ms') ?? 2000)); return; }
    send();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin:`http://127.0.0.1:${(server.address() as { port:number }).port}`, hits };
}

async function managed(t:TestContext, options:BrowserManagerOptions = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'paseo-browser-hardening-'));
  const manager = new BrowserManager({ dataRoot, runtimeRoot, ...options });
  t.after(async () => { await manager.close(); await rm(dataRoot, { recursive:true, force:true }); });
  return { manager, dataRoot };
}

async function post(meta:Metadata, route:string, body:Record<string,unknown>, signal?:AbortSignal) {
  const response = await fetch(`${meta.endpoint}/${route}`, { method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${meta.token}` }, body:JSON.stringify({ owner:'hardening-test', pid:process.pid, ...body }), signal });
  return { status:response.status, body:await response.json() as Record<string, any> };
}

test('each workspace browser has its own control token, also for reading and diagnostics', { timeout:60_000 }, async t => {
  const { manager } = await managed(t);
  await manager.start('token-a'); await manager.start('token-b');
  const a = await metadata(manager, 'token-a'), b = await metadata(manager, 'token-b');
  assert.notEqual(a.token, b.token);
  for (const route of ['read', 'diagnostics', 'acquire']) assert.equal((await post(a, route, { workspaceId:'token-b' })).status, 403, `${route} with another workspace's token`);
  assert.equal((await post(a, 'read', { workspaceId:'token-a', mode:'visible' })).status, 200);
  assert.equal((await post(b, 'diagnostics', { workspaceId:'token-b' })).status, 200);
  assert.equal((await post({ ...a, token:'0'.repeat(64) }, 'read', { workspaceId:'token-a' })).status, 401);
  assert.equal((await fetch(`${a.endpoint}/read`, { headers:{ authorization:`Bearer ${a.token}` } })).status, 401, 'only POST is accepted');
  await manager.action('token-b', { kind:'stop' });
  assert.equal((await post(b, 'read', { workspaceId:'token-b' })).status, 401, 'a stopped browser\'s token stops working');
  await manager.start('token-b');
  assert.notEqual((await metadata(manager, 'token-b')).token, b.token, 'every start gets a new token');
});

test('a lease the bridge stopped waiting for is never handed out, and unrenewed leases expire', { timeout:60_000 }, async t => {
  let now = Date.now();
  const { manager } = await managed(t, { now:() => now, budgets:{ controlServerMs:10_000, titleMs:8_000 } });
  const { origin } = await site(t);
  await manager.start('lease-test');
  await manager.action('lease-test', { kind:'navigate', url:`${origin}/busy?delay=1000&ms=2500` });
  await pause(1_300);
  const meta = await metadata(manager, 'lease-test');
  // The busy page holds the title read, so the server is still preparing the lease when the bridge gives up.
  await assert.rejects(post(meta, 'acquire', { workspaceId:'lease-test', write:false }, abortAfter(300)));
  await pause(3_000);
  const after = await manager.state('lease-test');
  assert.equal(after.agentBusy, false, 'nobody holds a lease after the bridge abandoned its request');
  assert.equal(after.activity?.[0].status, 'failed');
  const lease = await post(meta, 'acquire', { workspaceId:'lease-test', write:false });
  assert.equal(lease.status, 200, JSON.stringify(lease.body));
  now += 119_000; assert.equal((await manager.state('lease-test')).agentBusy, true);
  assert.equal((await post(meta, 'validate', { workspaceId:'lease-test', leaseId:lease.body.leaseId })).status, 200, 'validation renews the lease');
  now += 119_000; assert.equal((await manager.state('lease-test')).agentBusy, true);
  now += 2_000; assert.equal((await manager.state('lease-test')).agentBusy, false, 'a lease that is not renewed expires');
  const stale = await post(meta, 'validate', { workspaceId:'lease-test', leaseId:lease.body.leaseId });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /租约已失效/);
});

test('a tab the Agent opens keeps its lease until the page has loaded, even if the bridge stopped waiting', { timeout:60_000 }, async t => {
  const { manager } = await managed(t);
  const { origin } = await site(t);
  await manager.start('tabs-test'); await manager.action('tabs-test', { kind:'mode', mode:'agent' });
  const meta = await metadata(manager, 'tabs-test');
  const lease = await post(meta, 'acquire', { workspaceId:'tabs-test', write:true, createTab:true, toolName:'browser_tabs', tabAction:'new' });
  assert.equal(lease.status, 200);
  await assert.rejects(post(meta, 'tabs', { workspaceId:'tabs-test', leaseId:lease.body.leaseId, action:'new', url:`${origin}/slow?ms=2500` }, abortAfter(300)));
  const started = Date.now();
  const released = post(meta, 'release', { workspaceId:'tabs-test', leaseId:lease.body.leaseId, failed:true });
  await pause(500);
  assert.equal((await manager.state('tabs-test')).agentBusy, true, 'the user cannot take over while the Agent\'s page still loads');
  assert.equal((await released).status, 200);
  assert(Date.now() - started >= 1_500, 'release waited for the navigation');
  const state = await manager.state('tabs-test');
  assert.equal(state.agentBusy, false);
  assert(state.tabs.some(tab => tab.url === `${origin}/slow?ms=2500`));
});

test('releasing a lease switches tabs only for an Agent-mode write lease', { timeout:60_000 }, async t => {
  const { manager } = await managed(t);
  await manager.start('release-test'); await manager.action('release-test', { kind:'newTab' });
  const [first, second] = (await manager.state('release-test')).tabs;
  const meta = await metadata(manager, 'release-test');
  const read = await post(meta, 'acquire', { workspaceId:'release-test', write:false });
  const refused = await post(meta, 'release', { workspaceId:'release-test', leaseId:read.body.leaseId, tabId:first.id });
  assert.equal(refused.status, 409); assert.match(refused.body.error, /只有 Agent 模式下的写操作/);
  const state = await manager.state('release-test');
  assert.equal(state.agentBusy, false, 'the lease is released anyway');
  assert.equal(state.tabs.find(tab => tab.active)?.id, second.id);
  await manager.action('release-test', { kind:'mode', mode:'agent' });
  const write = await post(meta, 'acquire', { workspaceId:'release-test', write:true });
  assert.equal((await post(meta, 'release', { workspaceId:'release-test', leaseId:write.body.leaseId, tabId:first.id })).status, 200);
  assert.equal((await manager.state('release-test')).tabs.find(tab => tab.active)?.id, first.id);
});

test('page calls have their own time limits and stopping never waits behind a stuck action', { timeout:90_000 }, async t => {
  const { manager } = await managed(t, { budgets:{ measureMs:1_000, pageReadMs:1_000, titleMs:300, viewportProbeMs:300, diagnosticsScriptMs:300 } });
  const { origin } = await site(t);
  await manager.start('timeout-test');
  await manager.action('timeout-test', { kind:'navigate', url:`${origin}/busy?delay=1000&ms=6000` });
  await pause(1_300);
  let started = Date.now();
  await assert.rejects(manager.action('timeout-test', { kind:'fitWidth' }), /长时间没有响应/);
  assert(Date.now() - started < 4_000, 'fit width gives up');
  started = Date.now();
  await assert.rejects(manager.read('timeout-test', { mode:'visible', maxChars:500 }), /读取已停止/);
  assert(Date.now() - started < 4_000, 'reading gives up');
  started = Date.now();
  const state = await manager.state('timeout-test');
  assert(Date.now() - started < 2_000, 'state answers with the last known title');
  assert.equal(state.status, 'running');
  await pause(3_000);
  // A navigation to a server that never answers holds the action queue for the navigation timeout.
  const stuck = manager.action('timeout-test', { kind:'navigate', url:`${origin}/hang` }).then(() => null, (error:unknown) => error);
  await pause(500);
  started = Date.now();
  const stopped = await manager.action('timeout-test', { kind:'stop' });
  assert(Date.now() - started < 8_000, `stop took ${Date.now() - started} ms`);
  assert.equal(stopped.status, 'idle');
  assert(await stuck instanceof Error, 'the stuck navigation ends with the browser');
  assert.equal((await manager.state('timeout-test')).error, null, 'the cut-short navigation is not reported as a browser error');
});

test('Chromium refuses link-local and metadata addresses for tools, the panel and page scripts', { timeout:60_000 }, async t => {
  const { manager } = await managed(t);
  const { origin } = await site(t);
  await manager.start('network-test');
  await assert.rejects(manager.action('network-test', { kind:'navigate', url:'http://169.254.169.254/latest/meta-data/' }), /链路本地或云服务器元数据/);
  await manager.action('network-test', { kind:'navigate', url:`${origin}/start` });
  const browser = await chromium.connectOverCDP((await metadata(manager, 'network-test')).cdpEndpoint);
  try {
    const context = browser.contexts()[0];
    // A link-local address with no service: nothing could answer there even if blocking failed.
    for (const url of ['http://169.254.0.1:8/', 'http://[::ffff:169.254.0.1]:8/']) {
      const page = await context.newPage();
      try { await assert.rejects(page.goto(url), /ERR_NAME_NOT_RESOLVED/, url); } finally { await page.close(); }
    }
    const page = await context.newPage();
    await page.goto(`${origin}/start`);
    const failed = page.waitForEvent('requestfailed');
    await page.evaluate(`setTimeout(()=>{location.href='http://169.254.0.1:8/'},10)`);
    assert.match((await failed).failure()?.errorText ?? '', /ERR_NAME_NOT_RESOLVED/, 'a page script cannot navigate there either');
    await page.close();
    const redirected = await context.newPage();
    try { await assert.rejects(redirected.goto(`${origin}/redirect`), /ERR_NAME_NOT_RESOLVED/, 'nor can a redirect'); } finally { await redirected.close(); }
  } finally { await browser.close(); }
});

test('saved tabs drop fragments and one-time credentials but reopen with their other query parameters', { timeout:60_000 }, async t => {
  const { manager } = await managed(t);
  const { origin, hits } = await site(t);
  await manager.start('restore-test');
  await manager.action('restore-test', { kind:'navigate', url:`${origin}/callback?q=keep&code=one-time&state=xyz#access_token=secret` });
  await manager.action('restore-test', { kind:'stop' });
  const saved = JSON.parse(await readFile(path.join(manager.dataRoot, 'restore-test', 'state.json'), 'utf8'));
  assert.deepEqual(saved.tabs.map((tab:{url:string}) => tab.url), [`${origin}/callback?q=keep`]);
  hits.length = 0;
  const restored = await manager.start('restore-test');
  assert.equal(restored.url, `${origin}/callback?q=keep`);
  assert.deepEqual(hits, ['/callback?q=keep'], 'the one-time code is never replayed');
});

test('the browser\'s directories must be real directories of the daemon user and are kept at 0700', { timeout:60_000 }, async t => {
  const { manager, dataRoot } = await managed(t);
  await mkdir(path.join(dataRoot, 'loose', 'profile'), { recursive:true });
  await chmod(path.join(dataRoot, 'loose', 'profile'), 0o755);
  await manager.start('loose');
  for (const directory of [dataRoot, path.join(dataRoot, 'loose'), path.join(dataRoot, 'loose', 'profile'), path.join(dataRoot, 'loose', 'artifacts')])
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'paseo-browser-elsewhere-'));
  t.after(() => rm(elsewhere, { recursive:true, force:true }));
  await symlink(elsewhere, path.join(dataRoot, 'linked'));
  await assert.rejects(manager.start('linked'), /工作区浏览器目录（.*linked）不是真实目录/);
  const runtimeLink = path.join(elsewhere, 'runtime-link');
  await symlink(await realpath(runtimeRoot), runtimeLink);
  const linkedRuntime = new BrowserManager({ dataRoot:path.join(elsewhere, 'data'), runtimeRoot:runtimeLink });
  try { await assert.rejects(linkedRuntime.start('runtime-link'), /运行时目录（.*runtime-link）不是真实目录/); }
  finally { await linkedRuntime.close(); }
});

test('agent.json counts only as a small regular file with a well-formed Agent id', async t => {
  const { manager, dataRoot } = await managed(t);
  const write = async (id:string, content:string) => { await mkdir(path.join(dataRoot, id), { recursive:true }); await writeFile(path.join(dataRoot, id, 'agent.json'), content); };
  await write('valid', JSON.stringify({ agentId:'agent-1b2c' }));
  await write('malformed', JSON.stringify({ agentId:'../../etc' }));
  await write('large', JSON.stringify({ agentId:'agent-1', padding:'x'.repeat(10_000) }));
  await mkdir(path.join(dataRoot, 'linked')); await symlink(path.join(dataRoot, 'valid', 'agent.json'), path.join(dataRoot, 'linked', 'agent.json'));
  assert.equal(await manager.getAgentId('valid'), 'agent-1b2c');
  for (const id of ['malformed', 'large', 'linked']) assert.equal(await manager.getAgentId(id), null, id);
});

test('Chromium starts with its sandbox where the host allows it, falls back once with a warning, and follows PASEO_SERVER_BROWSER_SANDBOX', { timeout:120_000 }, async t => {
  const previous = process.env.PASEO_SERVER_BROWSER_SANDBOX;
  t.after(() => { if (previous === undefined) delete process.env.PASEO_SERVER_BROWSER_SANDBOX; else process.env.PASEO_SERVER_BROWSER_SANDBOX = previous; });
  delete process.env.PASEO_SERVER_BROWSER_SANDBOX;
  const commandLine = async (manager:BrowserManager, id:string) => (await readFile(`/proc/${(await metadata(manager, id)).browserPid}/cmdline`, 'utf8')).split(/[\0 ]/);
  const sandboxCheck = async (manager:BrowserManager, id:string) => (await manager.diagnostics(id)).checks.find(check => check.name === 'Chromium 沙箱')!;
  const { manager } = await managed(t);
  await manager.start('auto');
  const executable = await readlink(`/proc/${(await metadata(manager, 'auto')).browserPid}/exe`);
  const automatic = await sandboxCheck(manager, 'auto');
  if ((await commandLine(manager, 'auto')).includes('--no-sandbox')) assert.equal(automatic.status, 'warning', 'a host without the sandbox is reported');
  else { assert.equal(automatic.status, 'ok'); assert.match(automatic.detail, /已开启/); }

  // A Chromium that cannot start with its sandbox, as on a host without user namespaces.
  const scripts = await mkdtemp(path.join(tmpdir(), 'paseo-browser-sandbox-'));
  t.after(() => rm(scripts, { recursive:true, force:true }));
  const calls = path.join(scripts, 'calls.log'), wrapper = path.join(scripts, 'chromium');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nfor arg in "$@"; do [ "$arg" = --no-sandbox ] && exec '${executable}' "$@"; done\necho '[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!' >&2\nexit 1\n`);
  await chmod(wrapper, 0o700);
  const { manager:fallback } = await managed(t, { executablePath:wrapper });
  const started = Date.now();
  await fallback.start('fallback');
  assert(Date.now() - started < 15_000);
  assert((await commandLine(fallback, 'fallback')).includes('--no-sandbox'));
  const warning = await sandboxCheck(fallback, 'fallback');
  assert.equal(warning.status, 'warning'); assert.match(warning.detail, /无法开启（没有可用的沙箱/);
  await fallback.action('fallback', { kind:'restart' });
  const attempts = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.deepEqual(attempts.map(line => line.split(' ').includes('--no-sandbox')), [false, true, true], 'the sandbox is tried once per plugin process');

  process.env.PASEO_SERVER_BROWSER_SANDBOX = '1';
  const { manager:forced } = await managed(t, { executablePath:wrapper });
  await assert.rejects(forced.start('forced'), /Chromium 启动失败/);
  process.env.PASEO_SERVER_BROWSER_SANDBOX = '0';
  const { manager:off } = await managed(t);
  await off.start('off');
  assert((await commandLine(off, 'off')).includes('--no-sandbox'));
  const disabled = await sandboxCheck(off, 'off');
  assert.equal(disabled.status, 'warning'); assert.match(disabled.detail, /PASEO_SERVER_BROWSER_SANDBOX=0/);
});
