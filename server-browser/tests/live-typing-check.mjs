/**
 * Real-client typing regression (opus-F16 / codex-F2): in the real Paseo web UI, click into a page field on the picture,
 * type a word at several speeds and press Enter — every key must reach the page and the form must submit; an Enter that
 * loads a new document must be followed by its picture; an input method's composition must show on the badge and arrive
 * in one piece, and one started on a page that then changes (another document or tab) must never arrive anywhere
 * (codex-sb-F1). Mutates only BROWSER_TEST_WORKSPACE's browser (it opens local pages and one extra tab).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { baseUrl, browserLaunchOptions, daemonUrl, dataRoot, invokeBrowserRpc, testChromium, testWorkspace } from './live-config.mjs';

const WORKSPACE = testWorkspace();
const output = path.resolve(process.env.BROWSER_TEST_OUTPUT || 'artifacts/typing-check');
const chromium = testChromium();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), workspace: WORKSPACE, checks: [], screenshots: [], errors: [] };
const record = (name, details) => { report.checks.push({ name, passed: true, ...(details ? { details } : {}) }); console.log('PASS', name); };
async function until(predicate, message, timeout = 15_000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await predicate(); if (value) return value; } catch (error) { last = error; } await pause(100); }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

// A page with one big field at the top-left, so a press near the picture's corner always lands in it.
const site = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>打字回归</title><body style="margin:0"><form onsubmit="event.preventDefault();window.submitted=document.getElementById(\'q\').value"><input id="q" autocomplete="off" style="position:absolute;left:0;top:0;width:100%;height:180px;font-size:40px;border:0;background:#fde68a"></form></body>');
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const formUrl = `http://127.0.0.1:${site.address().port}/typing`;
const daemon = new DaemonClient({ url: daemonUrl, clientId: 'server-browser-typing-check', clientType: 'cli' });
const rpc = (method, input) => invokeBrowserRpc(daemon, method, input);
let browser;
const sockets = [];

/** Reads the shared page itself (its active tab) over its DevTools endpoint: the ground truth of what the keys did. */
async function oracle() {
  const state = await rpc('browser.state', { workspaceId: WORKSPACE });
  const metadata = JSON.parse(await readFile(path.join(dataRoot, WORKSPACE, 'session.json'), 'utf8'));
  const target = (await fetch(`${metadata.cdpEndpoint}/json/list`).then(response => response.json())).find(item => item.id === state.activeTabId && item.type === 'page');
  assert(target, 'the active tab is visible over CDP');
  const socket = new WebSocket(target.webSocketDebuggerUrl);sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); } };
  return async expression => {
    const id = ++sequence; const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const answer = await result; if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails)); return answer.result?.value;
  };
}

try {
  await mkdir(output, { recursive: true });
  await daemon.connect();
  await rpc('browser.start', { workspaceId: WORKSPACE });
  await rpc('browser.action', { workspaceId: WORKSPACE, action: { kind: 'mode', mode: 'manual' } });
  await rpc('browser.action', { workspaceId: WORKSPACE, action: { kind: 'navigate', url: formUrl } });
  const evaluate = await oracle();
  record('shared browser shows the local form', { url: await evaluate('location.href') });

  browser = await chromium.launch(browserLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(baseUrl);
  const entry = page.getByRole('button', { name: '服务器浏览器', exact: true });
  await until(async () => await entry.isVisible() || await page.getByRole('button', { name: '打开菜单', exact: true }).isVisible(), 'the Paseo web UI loaded', 60_000);
  if (!await entry.isVisible()) await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await entry.click();
  await page.getByTestId('server-browser-shell').waitFor();
  const tab = page.getByTestId(`server-browser-agent-tab-${WORKSPACE}`);
  await until(async () => await tab.isVisible() || await page.getByTestId('server-browser-workspace-add').isVisible(), 'the browser screen loaded');
  if (await tab.isVisible()) await tab.click();
  else { await page.getByTestId('server-browser-workspace-add').click(); await page.getByTestId(`server-browser-workspace-${WORKSPACE}`).click(); }
  await until(async () => (await page.getByTestId('server-browser-address').inputValue()) === formUrl, 'the panel shows the form');
  await page.getByTestId('server-browser-image').waitFor();
  await pause(800);

  const image = await page.getByTestId('server-browser-image').boundingBox();
  await page.mouse.click(image.x + 40, image.y + 30);
  await until(async () => (await evaluate('document.activeElement && document.activeElement.id')) === 'q', 'the click focused the page field');
  await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'server-browser-ime', 'keyboard focus is on the picture');
  record('a click on the picture focuses the page field and keeps keyboard focus on the picture');

  for (const [label, text, delay] of [['burst', 'abcdef', 0], ['60ms', 'ghijkl', 60], ['200ms', 'mnopq', 200]]) {
    await evaluate("(document.getElementById('q').value='',window.submitted=undefined,true)");
    await pause(400);
    await page.keyboard.type(text, { delay });
    await page.keyboard.press('Enter');
    const submitted = await until(async () => await evaluate('window.submitted'), `the form submitted after typing ${label}`);
    assert.equal(submitted, text, `${label}: every key arrived before Enter`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'server-browser-ime', `${label}: focus survived the new pictures`);
    assert.equal(await page.getByRole('alert').count(), 0, `${label}: no error banner`);
    record(`typing ${text.length} keys (${label}) and Enter reaches the page and submits the form`, { submitted });
  }

  // An Enter that loads a new document: the picture follows at once instead of waiting out a screenshot time-out.
  await evaluate("(document.getElementById('q').value='',document.querySelector('form').onsubmit=null,document.querySelector('form').action='/typing',true)");
  await pause(400);
  await page.keyboard.type('next');
  await page.keyboard.press('Enter');
  const loaded = Date.now();
  await until(async () => (await evaluate('location.search')) === '?q=next' || (await evaluate('location.href')).endsWith('/typing?'), 'the form loaded a new document');
  // Before the fix the screenshot in flight at the commit never returned: 10 s of 「正在获取画面…」, then an error.
  await until(async () => (await page.getByTestId('server-browser-image').count()) > 0 && (await page.getByTestId('server-browser-address').inputValue()).includes('/typing?') && !(await page.getByTestId('server-browser-stage').innerText()).includes('正在获取画面'), 'a picture of the new document', 3000);
  record('an Enter that loads a new document is followed by its picture', { ms: Date.now() - loaded });
  await until(async () => (await evaluate("document.readyState")) === 'complete' && await evaluate("!!document.getElementById('q')"), 'the form is back');
  await until(async () => { await page.mouse.click(image.x + 40, image.y + 30); await pause(400); return (await evaluate('document.activeElement && document.activeElement.id')) === 'q'; }, 'the click focused the page field again');
  await evaluate("(document.getElementById('q').value='',window.submitted=undefined,true)");
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
  await until(async () => (await page.getByTestId('server-browser-composing').textContent())?.includes('nihao'), 'the badge shows the composition');
  await page.screenshot({ path: path.join(output, 'typing-ime-composing.png') }); report.screenshots.push('typing-ime-composing.png');
  await pause(300);
  assert.equal(await evaluate("document.getElementById('q').value"), '', 'nothing is sent while the input method composes');
  await cdp.send('Input.insertText', { text: '你好' });
  await page.keyboard.press('Enter');
  assert.equal(await until(async () => await evaluate('window.submitted'), 'the composed text was submitted'), '你好');
  record('an input method composition arrives in one piece');

  // codex-sb-F1: a composition started on one page is dropped when that page changes under it, never sent to the new one.
  let current = evaluate;
  for (const [label, change] of [
    ['another document', async () => { await current(`location.href=${JSON.stringify(`${formUrl}?moved`)}`); }],
    ['another tab', async () => { await rpc('browser.action', { workspaceId: WORKSPACE, action: { kind: 'newTab', url: `${formUrl}?tab` } }); }],
  ]) {
    await until(async () => (await current("document.readyState")) === 'complete' && await current("!!document.getElementById('q')"), `${label}: the form is ready`);
    // A note left from the case before must not count for this one (closed before the picture takes keyboard focus).
    for (const close of await page.getByRole('alert').getByRole('button', { name: '关闭提示' }).all()) await close.click();
    await until(async () => (await page.getByRole('alert').count()) === 0, `${label}: no earlier note`);
    await pause(600);
    await until(async () => { await page.mouse.click(image.x + 40, image.y + 30); await pause(400); return (await current('document.activeElement && document.activeElement.id')) === 'q'; }, `${label}: the field is focused`);
    await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'server-browser-ime', `${label}: keyboard focus on the picture`);
    await current("(document.getElementById('q').value='',window.submitted=undefined,true)");
    await cdp.send('Input.imeSetComposition', { text: 'mima', selectionStart: 4, selectionEnd: 4 });
    await until(async () => (await page.getByTestId('server-browser-composing').textContent())?.includes('mima'), `${label}: composing`);
    await change();
    await page.getByRole('alert').filter({ hasText: '输入法里还没确认的文字没有发送' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByTestId('server-browser-composing').count(), 0, `${label}: the badge is gone`);
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'server-browser-ime', `${label}: the slot is released`);
    // Whatever the input method commits now goes nowhere, not into the new page (even once it is on screen) nor the old one.
    await page.getByTestId('server-browser-image').waitFor();
    await pause(800);
    await cdp.send('Input.insertText', { text: '秘密' });
    await pause(1200);
    const now = await oracle();
    assert.equal(await now("document.getElementById('q') ? document.getElementById('q').value : ''"), '', `${label}: the new page got nothing`);
    assert.equal(await current("document.getElementById('q') ? document.getElementById('q').value : ''"), '', `${label}: the old page got nothing`);
    // A press on the new picture takes the slot back: a new composition there goes to the page now on screen.
    await until(async () => { await page.mouse.click(image.x + 40, image.y + 30); await pause(400); return (await now('document.activeElement && document.activeElement.id')) === 'q'; }, `${label}: the new field is focused`);
    await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'server-browser-ime', `${label}: the slot is back`);
    await cdp.send('Input.imeSetComposition', { text: 'xin', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '新' });
    assert.equal(await until(async () => await now("document.getElementById('q').value"), `${label}: the new composition arrived`), '新');
    if (label === 'another document') { await page.screenshot({ path: path.join(output, 'typing-ime-dropped.png') }); report.screenshots.push('typing-ime-dropped.png'); }
    record(`a composition started before ${label} replaced the page is dropped and reported, never sent`);
    current = now;
  }
  await page.screenshot({ path: path.join(output, 'typing-done.png') }); report.screenshots.push('typing-done.png');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack; console.error(error); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close();
  await browser?.close().catch(() => {});
  await daemon.close().catch(() => {});
  site.closeAllConnections(); site.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
}
