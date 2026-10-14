import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { BrowserManager } from '../server/browser-manager';
import { droppedMessage, nextInputSeq, settleBatch, splitText } from '../client/input-queue';
import type { BrowserInputEvent, BrowserTarget } from '../shared/browser';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const FORM = '<!doctype html><meta name="viewport" content="width=device-width"><form onsubmit="event.preventDefault();window.submitted=document.getElementById(\'q\').value"><input id="q" autocomplete="off" style="position:absolute;left:0;top:0;width:600px;height:80px;font-size:30px"></form>';

// A page with an iframe holding its own field (frame-old); the iframe can be sent to another origin.
const FRAME_HOST = '<!doctype html><input id="top" style="width:300px"><iframe id="f" src="/frame-old" style="width:600px;height:200px"></iframe>';
const FRAME_OLD = '<!doctype html><input id="q" autocomplete="off">';
// A field that takes keys while the page is still loading: each slow script writes into the page as the parser reaches it.
const PARSING = '<!doctype html><input id="q" autocomplete="off" autofocus style="width:600px;height:80px"><script src="/slow.js?1"></script><p>between</p><script src="/slow.js?2"></script><p>end</p>';
// A form whose Enter loads a new document, like most search boxes.
const SEARCH = '<!doctype html><meta name="viewport" content="width=device-width"><form action="/result"><input id="q" name="q" autocomplete="off" style="position:absolute;left:0;top:0;width:600px;height:80px;font-size:30px"></form>';

/**
 * Full Chromium (not the headless shell) isolates sites as Chrome does: a cross-site iframe runs in its own process and is a
 * target of its own. BROWSER_TEST_FULL_CHROMIUM, or the newest Playwright `chromium-*` build in the Playwright cache.
 */
function fullChromium(): string | undefined {
  if (process.env.BROWSER_TEST_FULL_CHROMIUM) return process.env.BROWSER_TEST_FULL_CHROMIUM;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), '.cache/ms-playwright');
  const builds = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
  return builds.map(name => path.join(cache, name, 'chrome-linux64', 'chrome')).find(file => existsSync(file));
}

/** A real Chromium behind a real manager, one test page, and the pictures a viewer would hold. */
async function fixture(t: TestContext, options: { executablePath?: string } = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'browser-live-input-')), manager = new BrowserManager({ dataRoot, ...options });
  const site = createServer((request, response) => {
    if (request.url?.startsWith('/slow.js')) { setTimeout(() => { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end('document.write("<p class=written>written while parsing</p>")'); }, 400); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(request.url?.startsWith('/form') ? FORM : request.url?.startsWith('/search') ? SEARCH : request.url?.startsWith('/parsing') ? PARSING : request.url === '/frame-host' ? FRAME_HOST : request.url === '/frame-old' ? FRAME_OLD : `<title>${request.url}</title><p>${request.url}</p>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const address = site.address(), base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  let browser: Browser | undefined;
  t.after(async () => { await browser?.close().catch(() => {}); await manager.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await manager.start('workspace');
  const metadata = JSON.parse(await readFile(manager.metadataPath('workspace'), 'utf8'));
  browser = await chromium.connectOverCDP(metadata.cdpEndpoint);
  const state = await manager.state('workspace');
  await manager.action('workspace', { kind: 'navigate', url: `${base}/form` }, { tabId: state.activeTabId!, viewRevision: state.viewRevision! });
  const page = browser.contexts()[0].pages().find(item => item.url().startsWith(`${base}/form`)) as Page;
  page.on('dialog', () => {});
  /** The picture a viewer shows: what its keys and clicks are bound to. */
  const picture = async (): Promise<BrowserTarget> => {
    const frame = (await manager.frame('workspace', null, 'sharp')).frame!;
    assert(frame?.inputScope, 'frames carry the page context live input is bound to');
    return { tabId: frame.tabId, viewRevision: frame.viewRevision, inputScope: frame.inputScope };
  };
  const seqs = new Map<string, number>();
  const send = (target: BrowserTarget, events: BrowserInputEvent[], viewerId = 'mac') => {
    const seq = (seqs.get(viewerId) ?? 0) + 1; seqs.set(viewerId, seq);
    return manager.input('workspace', { workspaceId: 'workspace', viewerId, seq, target, events });
  };
  const value = () => page.locator('#q').inputValue();
  return { manager, page, base, metadata, picture, send, value };
}

test('typing straight on the picture: every key of a burst and its Enter arrive without a new picture (opus-F16, codex-F2)', { timeout: 60_000 }, async t => {
  const { page, picture, send, value } = await fixture(t);
  const seen = await picture();
  const click = await send(seen, [{ kind: 'click', x: 200, y: 40 }]);
  assert.equal(click.status, 'applied');
  assert.equal(await page.evaluate('document.activeElement.id'), 'q');
  assert.notEqual(click.session.viewRevision, seen.viewRevision, 'the click spends the picture for the next click');
  assert.equal(click.continuation, seen.inputScope, 'but the page context continues');
  // One key per request, all bound to the same picture: the browser-side 0.10.0 bug refused every key after the first.
  for (const key of 'abcdef') assert.equal((await send(seen, [{ kind: 'text', text: key }])).status, 'applied');
  const enter = await send(seen, [{ kind: 'key', key: 'Enter' }]);
  assert.deepEqual([enter.status, enter.applied], ['applied', 1]);
  assert.equal(await value(), 'abcdef');
  assert.equal(await page.evaluate('window.submitted'), 'abcdef', 'the form was submitted');
  // A whole burst in one batch, with its Enter.
  await page.evaluate("document.getElementById('q').value='';window.submitted=undefined");
  const burst = await send(seen, [{ kind: 'text', text: '你好' }, { kind: 'key', key: 'Backspace' }, { kind: 'text', text: '们 query' }, { kind: 'key', key: 'Enter' }]);
  assert.deepEqual([burst.status, burst.applied], ['applied', 4]);
  assert.equal(await page.evaluate('window.submitted'), '你们 query');
});

test('an Enter that loads a new document while pictures are being taken: the next picture follows at once, never a screenshot time-out', { timeout: 120_000 }, async t => {
  const { manager, base, send } = await fixture(t);
  for (let round = 1; round <= 5; round++) {
    const start = await manager.state('workspace');
    await manager.action('workspace', { kind: 'navigate', url: `${base}/search` }, { tabId: start.activeTabId!, viewRevision: start.viewRevision!, inputScope: start.inputScope ?? undefined });
    const seen = (await manager.frame('workspace', null, 'sharp')).frame!;
    // A viewer polling back to back, as the panel does while you type, so a capture is in flight when the result page commits:
    // Chromium never answers that screenshot, and before the fix the panel waited for the 10 s limit and showed an error.
    let polling = true, slowest = 0;
    const errors: string[] = [];
    const poller = (async () => { while (polling) { const began = Date.now(); try { await manager.frame('workspace', null, 'sharp'); } catch (error) { errors.push((error as Error).message); } slowest = Math.max(slowest, Date.now() - began); } })();
    const typed = await send({ tabId: seen.tabId, viewRevision: seen.viewRevision, inputScope: seen.inputScope }, [{ kind: 'click', x: 100, y: 40 }, { kind: 'text', text: `round${round}` }, { kind: 'key', key: 'Enter' }]);
    assert.equal(typed.applied, 3);
    const began = Date.now();
    let shown = false;
    while (!shown && Date.now() - began < 5000) {
      const state = await manager.state('workspace'), frame = (await manager.frame('workspace', null, 'sharp')).frame;
      shown = state.url.endsWith(`/result?q=round${round}`) && !!frame && frame.inputScope === state.inputScope;
      if (!shown) await delay(50);
    }
    polling = false; await poller;
    assert(shown, `round ${round}: a picture of the result page arrived`);
    assert.deepEqual(errors, [], `round ${round}: no picture request failed`);
    assert(slowest < 3000, `round ${round}: the slowest picture request took ${slowest} ms`);
  }
});

test('page commands and an older client bound to the page context keep working after input spends the picture', { timeout: 60_000 }, async t => {
  const { manager, page, picture, value } = await fixture(t);
  const seen = await picture();
  await manager.action('workspace', { kind: 'click', x: 200, y: 40 }, seen);
  // codex-F2's repro through the action path: text then Enter, both bound to the picture shown when typing began.
  await manager.action('workspace', { kind: 'text', text: 'query' }, seen);
  await manager.action('workspace', { kind: 'key', key: 'Enter' }, seen);
  assert.equal(await value(), 'query');
  assert.equal(await page.evaluate('window.submitted'), 'query');
  // A click still needs the exact picture: the one these keys were typed on is spent.
  await assert.rejects(manager.action('workspace', { kind: 'click', x: 10, y: 10 }, seen), /画面已经变化/);
});

test('live input never lands on another page: tab switch, new document, Agent, dialog, other device, replay', { timeout: 90_000 }, async t => {
  const { manager, page, base, metadata, picture, send, value } = await fixture(t);
  let seen = await picture();
  await send(seen, [{ kind: 'click', x: 200, y: 40 }]);
  // A same-document navigation (history API, as search pages do while you type) keeps the stream.
  await page.evaluate("history.replaceState(null,'','?q=a')");
  assert.equal((await send(seen, [{ kind: 'text', text: 'a' }])).status, 'applied');
  assert.equal(await value(), 'a');
  // A new document ends it: queued keys are refused, nothing is typed into the new page.
  await page.goto(`${base}/form?second`);
  const afterNavigation = await send(seen, [{ kind: 'text', text: 'lost' }]);
  assert.deepEqual([afterNavigation.status, afterNavigation.applied, afterNavigation.continuation], ['stale', 0, null]);
  assert.equal(await value(), '');
  // Fresh picture of the new page: typing works there.
  seen = await picture();
  await send(seen, [{ kind: 'click', x: 200, y: 40 }, { kind: 'text', text: 'kept' }]);
  assert.equal(await value(), 'kept');
  // Another device's input ends this device's stream; that device continues with the scope it is handed.
  const phone = await send(seen, [{ kind: 'text', text: '+phone' }], 'phone');
  assert.equal(phone.status, 'applied');
  assert(phone.continuation && phone.continuation !== seen.inputScope, 'the switching device gets a new scope for its queued input');
  assert.equal((await send(seen, [{ kind: 'text', text: '+mac' }])).status, 'stale', 'the first device typed on a page state it no longer sees');
  assert.equal((await send({ ...seen, inputScope: phone.continuation! }, [{ kind: 'text', text: '+more' }], 'phone')).status, 'applied');
  assert.equal(await value(), 'kept+phone+more');
  // A replayed batch (same sequence number) never types twice.
  assert.equal((await manager.input('workspace', { workspaceId: 'workspace', viewerId: 'phone', seq: 1, target: { ...seen, inputScope: phone.continuation! }, events: [{ kind: 'text', text: '!' }] })).status, 'stale');
  assert.equal(await value(), 'kept+phone+more');
  // An Agent read waits for nothing to change: "busy", retry. An Agent turn (handing over) ends the stream.
  seen = await picture();
  const acquire = async (write: boolean) => (await fetch(`${metadata.endpoint}/acquire`, { method: 'POST', headers: { authorization: `Bearer ${metadata.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace', owner: `agent-${write}`, pid: process.pid, write }) })).json() as Promise<{ leaseId: string }>;
  const release = async (owner: string, leaseId: string) => (await fetch(`${metadata.endpoint}/release`, { method: 'POST', headers: { authorization: `Bearer ${metadata.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace', owner, pid: process.pid, leaseId }) })).json();
  const read = await acquire(false);
  assert.equal((await send(seen, [{ kind: 'text', text: 'x' }], 'phone')).status, 'busy');
  await release('agent-false', read.leaseId);
  assert.equal((await send(seen, [{ kind: 'text', text: 'x' }], 'phone')).status, 'applied');
  await manager.action('workspace', { kind: 'mode', mode: 'agent' });
  assert.equal((await send(seen, [{ kind: 'text', text: 'agent' }], 'phone')).status, 'stale');
  const write = await acquire(true);await release('agent-true', write.leaseId);
  await manager.action('workspace', { kind: 'mode', mode: 'manual' });
  assert.equal((await send(seen, [{ kind: 'text', text: 'after-agent' }], 'phone')).status, 'stale', 'keys queued before the Agent turn do not land after it');
  assert.equal(await value(), 'kept+phone+morex');
  // A key that opens a dialog: the batch answers "blocked" and stops; the rest never runs.
  seen = await picture();
  await page.evaluate("document.querySelector('form').onsubmit=e=>{e.preventDefault();window.answer=confirm('提交？')}");
  const blocked = await send(seen, [{ kind: 'key', key: 'Enter' }, { kind: 'text', text: 'never' }], 'phone');
  assert.deepEqual([blocked.status, blocked.applied, blocked.pending, blocked.session.dialog?.type], ['blocked', 0, true, 'confirm'], 'the Enter reached the page and waits for the dialog');
  await manager.action('workspace', { kind: 'handleDialog', dialogId: blocked.session.dialog!.id, accept: true });
  await delay(300);
  assert.equal(await page.evaluate('window.answer'), true);
  assert.equal(await value(), 'kept+phone+morex', 'the event after the dialog never ran');
  // A tab switch ends it too.
  seen = await picture();
  const tabState = await manager.state('workspace');
  await manager.action('workspace', { kind: 'newTab' }, { tabId: tabState.activeTabId!, viewRevision: tabState.viewRevision!, inputScope: tabState.inputScope! });
  assert.equal((await send(seen, [{ kind: 'text', text: 'wrong tab' }], 'phone')).status, 'stale');
});

test('a click needs the picture it was made on; a second click on a spent picture is refused, not moved', { timeout: 60_000 }, async t => {
  const { page, picture, send } = await fixture(t);
  await page.evaluate("window.clicks=0;document.addEventListener('click',()=>window.clicks++)");
  const seen = await picture();
  assert.equal((await send(seen, [{ kind: 'click', x: 700, y: 300 }])).status, 'applied');
  const second = await send(seen, [{ kind: 'click', x: 700, y: 300 }]);
  assert.deepEqual([second.status, second.applied], ['stale', 0]);
  assert.equal(await page.evaluate('window.clicks'), 1);
  const fresh = await picture();
  assert.equal((await send(fresh, [{ kind: 'click', x: 700, y: 300 }])).status, 'applied');
  assert.equal(await page.evaluate('window.clicks'), 2);
  // Out of the picture: refused before anything happens.
  await assert.rejects(send(await picture(), [{ kind: 'click', x: 99_999, y: 1 }]), /超出/);
});

test('from Agent mode one navigation hands over, waits for the Agent step, and refuses if the Agent changed the page (opus-B9)', { timeout: 90_000 }, async t => {
  const { manager, page, base, metadata } = await fixture(t);
  const target = async () => { const state = await manager.state('workspace'); return { tabId: state.activeTabId!, viewRevision: state.viewRevision!, inputScope: state.inputScope! }; };
  await manager.action('workspace', { kind: 'navigate', url: `${base}/first` }, await target());
  await manager.action('workspace', { kind: 'navigate', url: `${base}/second` }, await target());
  await manager.action('workspace', { kind: 'mode', mode: 'agent' });
  const control = (route: string, body: Record<string, unknown>) => fetch(`${metadata.endpoint}${route}`, { method: 'POST', headers: { authorization: `Bearer ${metadata.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace', owner: 'agent', pid: process.pid, ...body }) }).then(response => response.json()) as Promise<{ leaseId: string }>;
  // The Agent is mid-step: the takeover switches to manual at once and goes back once the step ends.
  let lease = await control('/acquire', { write: true });
  const seen = await target();
  const going = manager.action('workspace', { kind: 'takeover', then: { kind: 'back' } }, seen);
  await delay(300);
  assert.equal((await manager.state('workspace')).mode, 'manual', 'control changes hands immediately');
  assert.equal(page.url(), `${base}/second`, 'nothing happens while the Agent step runs');
  await control('/release', { leaseId: lease.leaseId });
  const after = await going;
  assert.equal(after.mode, 'manual');assert.equal(page.url(), `${base}/first`);
  // The Agent opened another page during its step: the takeover stays manual and does not go back.
  await manager.action('workspace', { kind: 'mode', mode: 'agent' });
  lease = await control('/acquire', { write: true });
  const refused = manager.action('workspace', { kind: 'takeover', then: { kind: 'back' } }, await target());
  await delay(200);await page.goto(`${base}/agent-page`);await control('/release', { leaseId: lease.leaseId });
  await assert.rejects(refused, /Agent 刚才换了页面/);
  assert.equal((await manager.state('workspace')).mode, 'manual');assert.equal(page.url(), `${base}/agent-page`);
  // Typing an address from Agent mode.
  await manager.action('workspace', { kind: 'mode', mode: 'agent' });
  await manager.action('workspace', { kind: 'takeover', then: { kind: 'navigate', url: `${base}/typed` } }, await target());
  assert.equal(page.url(), `${base}/typed`);
});

test('a workspace service opens in a new tab of the shared browser (opus-B3)', { timeout: 60_000 }, async t => {
  const { manager, base } = await fixture(t);
  const state = await manager.state('workspace');
  const opened = await manager.action('workspace', { kind: 'newTab', url: `${base}/service` }, { tabId: state.activeTabId!, viewRevision: state.viewRevision!, inputScope: state.inputScope! });
  assert.equal(opened.tabs.length, 2);assert.equal(opened.url, `${base}/service`);
  await assert.rejects(manager.action('workspace', { kind: 'newTab', url: 'file:///etc/passwd' }, { tabId: opened.activeTabId!, viewRevision: opened.viewRevision!, inputScope: opened.inputScope! }), /HTTP/);
  assert.equal((await manager.state('workspace')).tabs.length, 2, 'a refused address opens no tab');
});

/** The page context as a viewer's target: what the latest state reports. */
/** Until `check` holds (a page or frame that loads at its own pace). */
async function waitFor(check: () => Promise<boolean>, what: string, timeout = 10_000): Promise<void> {
  for (const end = Date.now() + timeout; Date.now() < end; await delay(100)) if (await check()) return;
  throw new Error(`timed out: ${what}`);
}
/** The shared browser's tab showing `pathname`, as Playwright sees it. */
const browserPage = (page: Page, base: string, pathname: string): Page => page.context().pages().find(item => item.url() === `${base}${pathname}`) ?? page;
/** The first child frame of `host` once it shows an address ending in `suffix`. */
async function childFrame(host: Page, suffix: string) {
  await waitFor(async () => host.frames().some(item => item !== host.mainFrame() && item.url().endsWith(suffix)), `a frame at ${suffix}`);
  return host.frames().find(item => item !== host.mainFrame() && item.url().endsWith(suffix))!;
}
const currentTarget = async (manager: BrowserManager): Promise<BrowserTarget> => { const state = await manager.state('workspace'); return { tabId: state.activeTabId!, viewRevision: state.viewRevision!, inputScope: state.inputScope!, ...(state.documentScope ? { documentScope: state.documentScope } : {}) }; };

test('an iframe that loads another document, of another origin, ends live input made before it (codex-sb-F2)', { timeout: 90_000 }, async t => {
  const { manager, page, base, picture, send } = await fixture(t);
  // The new origin (another host name, so another site) focuses its own field as soon as it loads.
  const other = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><input id="q" autocomplete="off"><script>document.getElementById("q").focus()</script>'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(async () => { other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve())); });
  const otherBase = `http://localhost:${(other.address() as { port: number }).port}`;
  await manager.action('workspace', { kind: 'navigate', url: `${base}/frame-host` }, await currentTarget(manager));
  let frame = page.frames().find(item => item !== page.mainFrame());
  for (let attempt = 0; !frame?.url().endsWith('/frame-old') && attempt < 50; attempt++) { await delay(100); frame = page.frames().find(item => item !== page.mainFrame()); }
  assert(frame, 'the iframe loaded');
  await frame.locator('#q').focus();
  // Typing into a frame whose document stays the same works as usual.
  const seen = await picture();
  assert.equal((await send(seen, [{ kind: 'text', text: 'kept' }])).status, 'applied');
  assert.equal(await frame.locator('#q').inputValue(), 'kept');
  const before = await picture();
  await frame.goto(`${otherBase}/iframe-new`);
  await frame.waitForFunction('document.activeElement && document.activeElement.id === "q"', undefined, { timeout: 5000 });
  const late = await send(before, [{ kind: 'text', text: 'OLD-FRAME-INPUT' }]);
  assert.deepEqual([late.status, late.applied, late.continuation], ['stale', 0, null], 'input made before the frame changed never reaches the new origin');
  assert.equal(await frame.locator('#q').inputValue(), '');
  // A picture taken after the change takes input again: the viewer now sees the new frame.
  const fresh = await picture();
  assert.notEqual(fresh.inputScope, before.inputScope);
  assert.equal((await send(fresh, [{ kind: 'text', text: 'new' }])).status, 'applied');
  assert.equal(await frame.locator('#q').inputValue(), 'new');
});

test('a takeover confirmed on one document refuses after the tab loads another, and changes nothing; an Agent step on the same page keeps it (codex-sb-F3)', { timeout: 90_000 }, async t => {
  const { manager, page, base, metadata } = await fixture(t);
  await manager.action('workspace', { kind: 'navigate', url: `${base}/confirmed-page` }, await currentTarget(manager));
  await manager.action('workspace', { kind: 'mode', mode: 'agent' });
  const confirmed = await currentTarget(manager);
  assert(confirmed.documentScope, 'the page the viewer sees has its own identity');
  // While the sheet is open the Agent loads another page in the same tab.
  await page.goto(`${base}/agent-new-page`);
  await page.evaluate("window.reloadSentinel='keep'");
  await assert.rejects(manager.action('workspace', { kind: 'takeover', then: { kind: 'reload' } }, confirmed), /确认之前页面已经变化/);
  await assert.rejects(manager.action('workspace', { kind: 'takeover', then: { kind: 'navigate', url: `${base}/replacement` } }, confirmed), /确认之前页面已经变化/);
  assert.equal(page.url(), `${base}/agent-new-page`, 'nothing was navigated');
  assert.equal(await page.evaluate('window.reloadSentinel'), 'keep', 'the new document was not reloaded');
  assert.equal((await manager.state('workspace')).mode, 'agent', 'and control stayed with the Agent');
  // A confirmation from a client that sends only the page context is held to that exact context.
  const legacy = await currentTarget(manager);
  delete legacy.documentScope;
  await page.goto(`${base}/agent-third-page`);
  await assert.rejects(manager.action('workspace', { kind: 'takeover', then: { kind: 'reload' } }, legacy), /确认之前页面已经变化/);
  // The Agent working on the same page (a write step starts and ends) does not void a confirmation for that page.
  const onPage = await currentTarget(manager);
  const control = (route: string, body: Record<string, unknown>) => fetch(`${metadata.endpoint}${route}`, { method: 'POST', headers: { authorization: `Bearer ${metadata.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace', owner: 'agent', pid: process.pid, ...body }) }).then(response => response.json()) as Promise<{ leaseId: string }>;
  const step = await control('/acquire', { write: true });await control('/release', { leaseId: step.leaseId });
  assert.notEqual((await currentTarget(manager)).inputScope, onPage.inputScope, 'the Agent step ended live input');
  await page.evaluate("window.reloadSentinel='before-reload'");
  const after = await manager.action('workspace', { kind: 'takeover', then: { kind: 'reload' } }, onPage);
  assert.equal(after.mode, 'manual');
  assert.equal(await page.evaluate('window.reloadSentinel ?? null'), null, 'the confirmed page was reloaded');
});

test('switching tabs or the viewport away and back never revives live input made before (codex-sb-F4)', { timeout: 90_000 }, async t => {
  const { manager, page, base, picture, send, value } = await fixture(t);
  await send(await picture(), [{ kind: 'click', x: 200, y: 40 }]);
  const before = await picture();
  await manager.action('workspace', { kind: 'newTab', url: `${base}/second-tab` }, await currentTarget(manager));
  await manager.action('workspace', { kind: 'tab', tabId: before.tabId }, await currentTarget(manager));
  const back = await currentTarget(manager);
  assert.equal(back.tabId, before.tabId);assert.notEqual(back.inputScope, before.inputScope, 'A → B → A is a new context');
  assert.equal((await send(before, [{ kind: 'text', text: 'OLD-QUEUED' }])).status, 'stale');
  assert.equal(await value(), '');
  const sized = await picture(), { width, height } = await manager.state('workspace');
  await manager.action('workspace', { kind: 'viewport', width: 1000, height: 700 }, await currentTarget(manager));
  await manager.action('workspace', { kind: 'viewport', width, height }, await currentTarget(manager));
  assert.equal((await manager.state('workspace')).width, width);
  assert.equal((await send(sized, [{ kind: 'text', text: 'OLD-SIZE' }])).status, 'stale', 'a size changed and changed back is a new context too');
  assert.equal(await value(), '');
  await page.bringToFront();
});

test('a dialog that is already open runs nothing and claims nothing; one opened by an Enter holds that Enter and drops the rest, reported (codex-sb-F5)', { timeout: 90_000 }, async t => {
  const { manager, page, picture, send, value } = await fixture(t);
  await send(await picture(), [{ kind: 'click', x: 200, y: 40 }]);
  let seen = await picture();
  void page.evaluate("alert('已经打开')").catch(() => {});
  for (let attempt = 0; !(await manager.state('workspace')).dialog && attempt < 50; attempt++) await delay(50);
  const early = await send(seen, [{ kind: 'text', text: 'NEVER' }]);
  assert.deepEqual([early.status, early.applied, early.pending], ['blocked', 0, false]);
  const told: boolean[] = [];
  let settled = settleBatch([], [{ event: { kind: 'text', text: 'NEVER' }, target: seen, done: delivered => told.push(delivered) }], early);
  assert.deepEqual(told, [false], 'the tray keeps this text: it never reached the page');
  assert.match(droppedMessage(settled.dropped, 'dialog')!, /网页弹出了对话框，刚才的 5 个字或按键没有发送/);
  await manager.action('workspace', { kind: 'handleDialog', dialogId: early.session.dialog!.id, accept: true });
  assert.equal(await value(), '');
  seen = await picture();
  await page.evaluate("document.querySelector('form').onsubmit=e=>{e.preventDefault();window.answer=confirm('提交？')}");
  const events: BrowserInputEvent[] = [{ kind: 'text', text: 'ok' }, { kind: 'key', key: 'Enter' }, { kind: 'text', text: 'lost' }];
  const opened = await send(seen, events);
  assert.deepEqual([opened.status, opened.applied, opened.pending], ['blocked', 1, true]);
  const outcome: boolean[] = [];
  settled = settleBatch([], events.map(event => ({ event, target: seen, done: (delivered: boolean) => outcome.push(delivered) })), opened);
  assert.deepEqual(outcome, [true, true, false]);
  assert.match(droppedMessage(settled.dropped, 'dialog')!, /刚才的 4 个字或按键没有发送/);
  await manager.action('workspace', { kind: 'handleDialog', dialogId: opened.session.dialog!.id, accept: true });
  await delay(300);
  assert.equal(await value(), 'ok');
});

test('a long paste in pieces keeps every character whole; each viewer\'s batches only move forward (codex-sb-F6)', { timeout: 60_000 }, async t => {
  const { manager, picture, send, value } = await fixture(t);
  await send(await picture(), [{ kind: 'click', x: 200, y: 40 }]);
  const text = 'a'.repeat(9999) + '😀' + '尾b', pieces = splitText(text);
  assert.deepEqual(pieces.map(piece => piece.length), [9999, 4]);
  const pasted = await send(await picture(), pieces.map(piece => ({ kind: 'text' as const, text: piece })));
  assert.deepEqual([pasted.status, pasted.applied], ['applied', 2]);
  assert.equal(await value(), text);
  // Another viewer typing in between does not reset a viewer's sequence: its older batch is still refused.
  const seen = await picture(), input = (viewerId: string, seq: number, target: BrowserTarget, text: string) => manager.input('workspace', { workspaceId: 'workspace', viewerId, seq, target, events: [{ kind: 'text', text }] });
  assert.equal((await input('ipad', 100, seen, '-A')).status, 'applied');
  const other = await input('mac', 1000, await picture(), '-B');
  assert.equal(other.status, 'applied');
  assert.equal((await input('ipad', 1, { ...seen, inputScope: other.continuation! }, '-REORDERED')).status, 'stale');
  assert.equal(await value(), text + '-A-B');
});

test('a document replaced in place ends live input made before it: document.open(), a javascript: URL, a frame rewritten by its parent (grok-sb-F1)', { timeout: 90_000 }, async t => {
  const { manager, page, base, picture, send, value } = await fixture(t);
  // Typing, then the page rewrites itself; its new field takes the focus at once.
  await send(await picture(), [{ kind: 'click', x: 200, y: 40 }]);
  const typed = await send(await picture(), [{ kind: 'text', text: 'a' }]);
  assert.equal(typed.status, 'applied');
  const before = { ...(await currentTarget(manager)), inputScope: typed.continuation! };
  await page.evaluate(`document.open(); document.write('<!doctype html><input id="q" autocomplete="off">'); document.close(); document.getElementById('q').focus()`);
  const opened = await send(before, [{ kind: 'text', text: 'WRONG-DOCUMENT' }]);
  assert.deepEqual([opened.status, opened.applied], ['stale', 0], 'input made for the document before document.open() never reaches the new one');
  assert.equal(await value(), '');
  assert.notEqual(opened.session.documentScope, before.documentScope, 'a takeover confirmed on the old document is void too');
  assert.equal((await send(await picture(), [{ kind: 'text', text: 'new' }])).status, 'applied', 'a picture of the new document takes input');
  assert.equal(await value(), 'new');
  // A javascript: URL that returns markup replaces the document the same way, without a navigation.
  const seen = await currentTarget(manager);
  await page.evaluate(`location.href = 'javascript:"<!doctype html><input id=q autocomplete=off>"'`);
  await page.waitForFunction('document.getElementById("q") && document.getElementById("q").value === ""');
  await page.locator('#q').focus();
  const replaced = await send(seen, [{ kind: 'text', text: 'WRONG-DOCUMENT' }]);
  assert.deepEqual([replaced.status, replaced.applied], ['stale', 0], 'nor the document a javascript: URL put in its place');
  assert.equal(await value(), '');
  // A frame whose parent rewrites it (document.open() on the frame's document) is a new document in that frame.
  await manager.action('workspace', { kind: 'navigate', url: `${base}/frame-host` }, await currentTarget(manager));
  const host = browserPage(page, base, '/frame-host');
  const frame = await childFrame(host, '/frame-old');
  await frame.locator('#q').focus();
  const kept = await send(await picture(), [{ kind: 'text', text: 'kept' }]);
  assert.equal(kept.status, 'applied');
  const framed = { ...(await currentTarget(manager)), inputScope: kept.continuation! };
  await host.evaluate(`const child = document.getElementById('f').contentDocument; child.open(); child.write('<!doctype html><input id="q" autocomplete="off">'); child.close(); child.getElementById('q').focus()`);
  const rewritten = await send(framed, [{ kind: 'text', text: 'WRONG-FRAME' }]);
  assert.deepEqual([rewritten.status, rewritten.applied], ['stale', 0]);
  assert.equal(await frame.locator('#q').inputValue(), '');
});

test('typing goes on through what is not a new document: writes while the page parses, Playwright reading the page, a frame\'s history API (grok-sb-F1)', { timeout: 90_000 }, async t => {
  const { manager, page, base, picture, send } = await fixture(t);
  // Keys typed while the parser is still writing the page (two slow scripts that each document.write) all arrive.
  await page.goto(`${base}/parsing`, { waitUntil: 'commit' });
  await page.waitForSelector('#q');
  await page.locator('#q').focus();
  let target = await currentTarget(manager);
  for (const key of 'abc') {
    const result = await send(target, [{ kind: 'text', text: key }]);
    assert.equal(result.status, 'applied', `${key} arrived while the page was being written`);
    target = { ...target, inputScope: result.continuation! };
    await delay(250);
  }
  await page.waitForFunction('document.querySelectorAll(".written").length === 2');
  assert.equal((await send(target, [{ kind: 'text', text: 'd' }])).status, 'applied', 'parser writes are not a new document');
  // Playwright's own reads run in an isolated world of the page; they never end a viewer's typing either.
  assert.equal(await page.locator('#q').inputValue(), 'abcd');
  const after = await send(target, [{ kind: 'text', text: 'e' }]);
  assert.deepEqual([after.status, await page.locator('#q').inputValue()], ['applied', 'abcde']);
  // An iframe in the tab's own process changing its address with the history API keeps its document, and the typing.
  await manager.action('workspace', { kind: 'navigate', url: `${base}/frame-host` }, await currentTarget(manager));
  const frame = await childFrame(browserPage(page, base, '/frame-host'), '/frame-old');
  await frame.locator('#q').focus();
  const typed = await send(await picture(), [{ kind: 'text', text: 'f' }]);
  assert.equal(typed.status, 'applied');
  await frame.evaluate(`history.pushState({}, '', '/frame-moved')`);
  await waitFor(async () => frame.url().endsWith('/frame-moved'), 'the frame changed its address');
  await delay(300);
  const moved = await send({ ...(await currentTarget(manager)), inputScope: typed.continuation! }, [{ kind: 'text', text: 'g' }]);
  assert.equal(moved.status, 'applied', 'a frame\'s history API change is not a new document');
  assert.equal(await frame.locator('#q').inputValue(), 'fg');
});

test('with site isolation, a frame in its own process that reloads, rewrites itself or loads a frame of its own ends live input; its history API does not (grok-sb-F2)', { timeout: 120_000 }, async t => {
  const executablePath = fullChromium();
  if (!executablePath) { t.skip('full Chromium (site isolation) is not installed'); return; }
  const { manager, page, base, picture, send } = await fixture(t, { executablePath });
  // Another site (another host name): its page focuses its own field whenever it loads.
  const other = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><input id="q" autocomplete="off"><script>document.getElementById("q").focus()</script>'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(async () => { other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve())); });
  const otherBase = `http://localhost:${(other.address() as { port: number }).port}`;
  await manager.action('workspace', { kind: 'navigate', url: `${base}/frame-host` }, await currentTarget(manager));
  const host = browserPage(page, base, '/frame-host');
  let frame = await childFrame(host, '/frame-old');
  await frame.goto(`${otherBase}/remote`);
  frame = await childFrame(host, '/remote');
  // This is the case at hand: the frame is a target of its own, not part of the tab's.
  const own = await host.context().newCDPSession(frame); await own.detach();
  await frame.locator('#q').focus();
  const live = async () => { const result = await send(await picture(), [{ kind: 'text', text: 'x' }]); assert.equal(result.status, 'applied'); return { ...(await currentTarget(manager)), inputScope: result.continuation! }; };
  const refused = async (target: BrowserTarget, why: string) => { const late = await send(target, [{ kind: 'text', text: 'OLD' }]); assert.deepEqual([late.status, late.applied], ['stale', 0], why); };
  // The frame reloads itself (the same address again): Playwright reports the same URL and the tab's own CDP target sees
  // nothing; only the frame's own target reports a new document.
  let target = await live();
  await frame.evaluate('location.reload()').catch(() => {});
  // The reloaded page has its field focused again (Chrome keeps a cross-site frame's own script from taking focus unasked).
  await frame.waitForFunction('document.getElementById("q") && document.getElementById("q").value === ""');
  await frame.locator('#q').focus();
  await refused(target, 'input made before the frame reloaded never reaches the reloaded document');
  assert.equal(await frame.locator('#q').inputValue(), '');
  // A history API change in that frame keeps its document: typing goes on.
  target = await live();
  await frame.evaluate(`history.pushState({}, '', '/remote-moved')`);
  await delay(400);
  const moved = await send(target, [{ kind: 'text', text: 'y' }]);
  assert.equal(moved.status, 'applied', 'a history API change in a frame is not a new document');
  target = { ...target, inputScope: moved.continuation! };
  // document.open() inside the frame replaces its document in place.
  await frame.evaluate(`document.open(); document.write('<!doctype html><input id="q" autocomplete="off">'); document.close(); document.getElementById('q').focus()`);
  await refused(target, 'nor the document the frame wrote over itself');
  assert.equal(await frame.locator('#q').inputValue(), '');
  // A frame inside it, of the same site, runs in that same process: its navigations come from the frame's target too.
  target = await live();
  await frame.evaluate(`const inner = document.createElement('iframe'); inner.src = ${JSON.stringify(`${otherBase}/inner`)}; document.body.append(inner)`);
  await waitFor(async () => frame.childFrames().some(child => child.url().endsWith('/inner')), 'the inner frame loaded');
  await refused(target, 'nor a document loaded in a frame inside it');
});

test('a viewer forgotten after 64 others still cannot replay older batches; viewers numbering above the floor type on (grok-sb-F3)', { timeout: 120_000 }, async t => {
  const { manager, picture, value } = await fixture(t);
  const input = (viewerId: string, seq: number, target: BrowserTarget, events: BrowserInputEvent[]) => manager.input('workspace', { workspaceId: 'workspace', viewerId, seq, target, events });
  assert.equal((await input('a', 100, await picture(), [{ kind: 'click', x: 200, y: 40 }])).status, 'applied');
  // 64 other viewers, each numbering its first batch as the client does (nextInputSeq over the session), push 'a' out.
  for (let index = 0; index < 64; index++) {
    const result = await input(`v${index}`, nextInputSeq(0, await manager.state('workspace')), await picture(), [{ kind: 'scroll', deltaX: 0, deltaY: 0 }]);
    assert.equal(result.status, 'applied', `viewer ${index}`);
  }
  assert.equal((await manager.state('workspace')).inputSeqFloor, 100, "'a' is forgotten; its last batch becomes the floor");
  // 'a' sending an older batch number on the page as it is now: refused, as it was while remembered.
  assert.equal((await input('a', 2, await picture(), [{ kind: 'text', text: 'REPLAY' }])).status, 'stale');
  // A new viewer and 'a' itself, numbering above the floor as the client does, are taken; so is the newest viewer's next batch.
  assert.equal((await input('new', nextInputSeq(0, await manager.state('workspace')), await picture(), [{ kind: 'text', text: 'n' }])).status, 'applied');
  assert.equal((await input('a', nextInputSeq(100, await manager.state('workspace')), await picture(), [{ kind: 'text', text: 'a' }])).status, 'applied');
  assert.equal((await input('v63', 2, await picture(), [{ kind: 'text', text: 'v' }])).status, 'applied');
  assert.equal(await value(), 'nav');
  // An older client that always starts at 1 is below the floor until its own numbers pass it (see README).
  assert.equal((await input('old-client', 1, await picture(), [{ kind: 'text', text: 'OLD' }])).status, 'stale');
});
