import { expect, test, type Page } from "@playwright/test";

type Call = { name: string; input: { workspaceId?: string; action?: { kind: string; [key: string]: unknown }; quality?: string; maxWidth?: number } };
const calls = (page: Page): Promise<Call[]> => page.evaluate(() => (globalThis as unknown as { __browserCalls: Call[] }).__browserCalls);
const writes = async (page: Page) => (await calls(page)).filter(call => ["browser.action", "browser.start", "browser.agent", "browser.input"].includes(call.name));
type LiveEvent = { kind: string; text?: string; key?: string; deltaY?: number; x?: number };
/** Live input batches (typing, keys, wheel, clicks) and their events in order. */
const inputs = async (page: Page) => (await calls(page)).filter(call => call.name === "browser.input") as unknown as { input: { target: { tabId: string; viewRevision: string; inputScope?: string }; seq: number; events: LiveEvent[] } }[];
const liveEvents = async (page: Page) => (await inputs(page)).flatMap(call => call.input.events);
/** What reached the fixture's page: text, keys as ⟨Enter⟩, clicks as ⟨click⟩. */
const typed = (page: Page, workspaceId: string) => page.evaluate(id => (globalThis as unknown as { __typed: Record<string, string> }).__typed[id] ?? "", workspaceId);
/** Press on the page picture itself (the image lets the frame above it take the pointer). */
async function pressPicture(page: Page, x = 160, y = 90, touch = false) {
  const image = (await page.getByTestId("server-browser-image").boundingBox())!;
  if (touch) await page.touchscreen.tap(image.x + x, image.y + y); else await page.mouse.click(image.x + x, image.y + y);
}
const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null);
const actions = async (page: Page, kind?: string) => (await writes(page)).filter(call => call.name === "browser.action" && (!kind || call.input.action?.kind === kind));
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 760;
// Control colours by hue family, robust to palette tweaks: the Agent is violet (blue > red > green), manual control amber (red > green > blue).
const tint = async (locator: ReturnType<Page["getByRole"]>) => (await locator.evaluate(element => getComputedStyle(element).backgroundColor)).match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
const violet = ([red, green, blue]: number[]) => blue > red && red > green, amber = ([red, green, blue]: number[]) => red > green && green > blue;

async function open(page: Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/${query}`);
  return errors;
}
async function selectBrowser(page: Page, workspaceId: string) {
  const tab = page.getByTestId(`server-browser-agent-tab-${workspaceId}`);
  if (await tab.isVisible()) await tab.click();
  else { await page.getByTestId("server-browser-workspace-picker").click(); await page.getByTestId(`server-browser-overview-card-${workspaceId}`).click(); }
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
}
async function openMenuItem(page: Page, name: string) {
  await page.getByTestId("server-browser-menu").click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function openPageTabs(page: Page) {
  const button = page.getByTestId("server-browser-tabs");
  if (await button.isVisible()) await button.click(); else await openMenuItem(page, "标签页 2");
  await expect(page.getByRole("dialog", { name: /^标签页/ })).toBeVisible();
}

test("watching needs at most two chrome rows and switching browsers never writes", async ({ page }) => {
  const errors = await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  const chrome = await page.getByTestId("server-browser-toolbar").boundingBox();
  const surface = await page.getByTestId("server-browser-shell").boundingBox();
  const stage = await page.getByTestId("server-browser-stage").boundingBox();
  expect(chrome!.height).toBeLessThanOrEqual(desktop(page) ? 82 : 50);
  expect(stage!.height / surface!.height).toBeGreaterThan(desktop(page) ? 0.86 : 0.93);
  await expect(page.getByRole("tab", { name: "Agent", exact: true })).toHaveAttribute("aria-selected", "true");
  if (desktop(page)) {
    await expect(page.getByTestId("server-browser-agent-toolbar")).toBeVisible();
    const demo = page.getByTestId("server-browser-agent-tab-ws-demo");
    await expect(demo).toHaveAttribute("aria-label", /demo-project，手动浏览，工作区 shared-demo/);
    await demo.click();
    await expect(demo).toHaveAttribute("aria-selected", "true");
    await demo.focus(); await demo.press("Enter");
    await expect(demo).toHaveAttribute("aria-selected", "true");
  } else {
    await expect(page.getByTestId("server-browser-agent-toolbar")).toHaveCount(0);
    await expect(page.getByTestId("server-browser-workspace-picker")).toHaveAttribute("aria-label", /当前 .*浏览器验收 Agent/);
    await selectBrowser(page, "ws-demo");
  }
  await expect(page.getByTestId("server-browser-identity-workspace").or(page.getByTestId("server-browser-agent-tab-ws-demo"))).toBeVisible();
  await expect.poll(async () => (await calls(page)).some(call => call.name === "browser.frame" && call.input.workspaceId === "ws-demo")).toBe(true);
  expect(await writes(page)).toEqual([]);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("mode switch sends one write per change, ignores the current mode and is inert while busy", async ({ page }) => {
  await open(page, "?scenario=hold");
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  const manual = page.getByRole("tab", { name: "手动", exact: true }), agent = page.getByRole("tab", { name: "Agent", exact: true });
  expect(violet(await tint(agent))).toBe(true);
  await agent.click();
  expect(await writes(page)).toEqual([]);
  await manual.click();
  await expect(page.getByTestId("server-browser-mode")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("progressbar", { name: "正在切换到手动…" })).toBeVisible();
  await agent.click({ force: true });
  expect((await actions(page, "mode")).map(call => call.input.action?.mode)).toEqual(["manual"]);
  await page.evaluate(() => { (globalThis as unknown as { __browserRelease: Record<string, boolean> }).__browserRelease.mode = true; });
  await expect(manual).toHaveAttribute("aria-selected", "true");
  expect(amber(await tint(manual))).toBe(true);
  await expect(page.getByTestId("server-browser-mode")).not.toHaveAttribute("aria-disabled", "true");
  // The fixture's Agent is still mid-operation: the takeover is acknowledged, page controls wait for it.
  await expect(page.getByRole("progressbar", { name: "等待 Agent 结束当前操作…" })).toBeVisible();
  await manual.click();
  await agent.click();
  await expect(agent).toHaveAttribute("aria-selected", "true");
  expect((await actions(page, "mode")).map(call => call.input.action?.mode)).toEqual(["manual", "agent"]);
});

test("from Agent mode, back, reload and the address ask to take over first; manual control navigates at once", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  await selectBrowser(page, "ws-release");
  if (desktop(page)) {
    await expect(page.getByTestId("server-browser-address")).toHaveValue("https://docs.example.com/guide/getting-started");
    await expect(page.getByTestId("server-browser-address")).toBeEditable();
    await page.getByTestId("server-browser-back").click();
  } else {
    await expect(page.getByTestId("server-browser-address")).toHaveCount(0);
    await openMenuItem(page, "切到手动并后退");
  }
  const sheet = page.getByRole("dialog", { name: "切到手动并后退？" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/等 Agent 做完当前这一步再后退/)).toBeVisible();
  expect(await writes(page)).toEqual([], "nothing changes before the confirmation");
  await sheet.getByRole("button", { name: "取消", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(await writes(page)).toEqual([]);
  if (desktop(page)) {
    await page.getByTestId("server-browser-address").fill("git.example.com/acme/web-app");
    await page.getByTestId("server-browser-address").press("Enter");
  } else {
    await openMenuItem(page, "切到手动并打开网址");
    await page.getByLabel("网址", { exact: true }).fill("git.example.com/acme/web-app");
  }
  const takeover = page.getByRole("dialog", { name: "切到手动并打开网址？" });
  await expect(takeover).toBeVisible();
  await takeover.getByTestId("server-browser-takeover-confirm").click();
  await expect.poll(async () => (await actions(page)).map(call => call.input.action)).toEqual([{ kind: "takeover", then: { kind: "navigate", url: "git.example.com/acme/web-app" } }]);
  await expect(page.getByRole("tab", { name: "手动", exact: true })).toHaveAttribute("aria-selected", "true");
  const address = page.getByTestId("server-browser-address");
  await expect(address).toHaveValue("https://git.example.com/acme/web-app");
  // Under manual control the same buttons act at once.
  await page.getByTestId("server-browser-back").click();
  await page.getByTestId("server-browser-reload").click();
  await expect.poll(async () => (await actions(page)).map(call => call.input.action?.kind)).toEqual(["takeover", "back", "reload"]);
  expect(await noOverflow(page)).toBe(true);
});

test("page tabs: read-only while the Agent drives, switch, pin and new tab in manual control", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  await openPageTabs(page);
  await expect(page.getByTestId("server-browser-tab-t-docs")).toBeDisabled();
  await expect(page.getByTestId("server-browser-new-tab")).toBeDisabled();
  await expect(page.getByTestId("server-browser-tab-t-pr")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await selectBrowser(page, "ws-demo");
  await openPageTabs(page);
  await expect(page.getByTestId("server-browser-close-tab-t-demo")).toBeDisabled();
  await page.getByTestId("server-browser-tab-t-demo-docs").click();
  await expect(page.getByRole("dialog", { name: /^标签页/ })).toHaveCount(0);
  await expect.poll(async () => (await actions(page, "tab")).map(call => call.input.action?.tabId)).toEqual(["t-demo-docs"]);
  await openPageTabs(page);
  await page.getByTestId("server-browser-pin-tab-t-demo").click();
  await expect(page.getByTestId("server-browser-close-tab-t-demo")).toBeEnabled();
  await page.getByTestId("server-browser-new-tab").click();
  await expect.poll(async () => (await actions(page)).map(call => call.input.action?.kind)).toEqual(["tab", "pin", "newTab"]);
});

test("menu: Agent mode hides manual-only actions; match window, quality and confirmed stop", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  await page.getByTestId("server-browser-menu").click();
  const menu = page.getByRole("dialog", { name: "更多操作" });
  await expect(menu.getByRole("button", { name: "页面诊断", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "匹配窗口", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "关闭浏览器", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await selectBrowser(page, "ws-demo");
  const stage = (await page.getByTestId("server-browser-stage").boundingBox())!;
  await openMenuItem(page, "匹配窗口");
  await expect.poll(async () => (await actions(page)).map(call => call.input.action?.kind)).toEqual(["viewport"]);
  const viewport = (await actions(page, "viewport"))[0].input.action!;
  expect(viewport.width).toBe(Math.max(320, Math.floor(stage.width)));
  expect(viewport.height).toBe(Math.max(320, Math.floor(stage.height)));
  await openMenuItem(page, "画面");
  await page.getByRole("tab", { name: "流畅", exact: true }).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.name === "browser.frame").at(-1)?.input.quality).toBe("smooth");
  await page.keyboard.press("Escape");
  await openMenuItem(page, "关闭浏览器");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(await actions(page, "stop")).toEqual([]);
  await openMenuItem(page, "关闭浏览器");
  await page.getByTestId("server-browser-stop-confirm").click();
  await expect(page.getByTestId("server-browser-start")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "已关闭浏览器" })).toBeVisible();
  expect((await actions(page, "stop")).length).toBe(1);
  expect((await writes(page)).map(call => call.input.action?.kind)).toEqual(["viewport", "stop"]);
});

test("overview: grid or list, filters and search, one thumbnail per page and read-only selection", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  await page.getByTestId("server-browser-workspace-picker").click();
  await expect(page.getByTestId("server-browser-overview")).toBeVisible();
  const cards = page.locator('[data-testid^="server-browser-overview-card-"]');
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId("server-browser-overview-card-ws-admin")).toHaveAttribute("aria-label", /，待审批$/);
  await expect(page.getByTestId("server-browser-overview-card-ws-review")).toHaveAttribute("aria-label", /，Agent 操作中$/);
  if (desktop(page)) {
    const boxes = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(new Set(boxes.map(Math.round)).size).toBe(1);
    const thumbnails = async () => (await calls(page)).filter(call => call.name === "browser.frame" && call.input.maxWidth === 480).length;
    await expect.poll(thumbnails).toBe(4);
    await page.waitForTimeout(2500);
    expect(await thumbnails()).toBe(4);
  }
  await page.getByTestId("server-browser-overview-filter-takeover").click();
  await expect(page.getByTestId("server-browser-overview-filter-takeover")).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId("server-browser-overview-card-ws-admin")).toBeVisible();
  await page.getByTestId("server-browser-overview-filter-all").click();
  await page.getByLabel("搜索项目、工作区、Agent 或页面").fill("发布");
  await expect(cards).toHaveCount(1);
  await page.getByTestId("server-browser-overview-card-ws-release").click();
  await expect(page.getByTestId("server-browser-overview")).toHaveCount(0);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  if (desktop(page)) await expect(page.getByTestId("server-browser-agent-tab-ws-release")).toHaveAttribute("aria-selected", "true");
  else await expect(page.getByTestId("server-browser-identity-workspace")).toHaveText("发布检查 Agent");
  expect(await writes(page)).toEqual([]);
  expect(await noOverflow(page)).toBe(true);
});

test("another workspace opens idle and starts with exactly one start call", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  if (!desktop(page)) await page.getByTestId("server-browser-workspace-picker").click();
  await page.getByTestId("server-browser-workspace-add").click();
  await page.getByLabel("搜索工作区").fill("docs");
  await page.getByTestId("server-browser-workspace-ws-docs").click();
  const start = page.getByTestId("server-browser-start");
  await expect(start).toBeVisible();
  await expect(page.getByText("浏览器未启动", { exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([]);
  await start.click();
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  expect((await writes(page)).filter(call => call.name === "browser.start").length).toBe(1);
});

test("typing tray sends text and keys to the page only in manual control", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  await expect(page.getByTestId("server-browser-keyboard")).toHaveCount(0);
  await selectBrowser(page, "ws-demo");
  await page.getByTestId("server-browser-keyboard").click();
  await page.getByTestId("server-browser-input").fill("中文同屏验收");
  await page.getByTestId("server-browser-send").click();
  await expect(page.getByTestId("server-browser-input")).toHaveValue("");
  await page.getByTestId("server-browser-key-Enter").click();
  await page.getByTestId("server-browser-scroll-down").click();
  await expect.poll(async () => (await liveEvents(page)).map(event => [event.kind, event.text ?? event.key ?? event.deltaY])).toEqual([["text", "中文同屏验收"], ["key", "Enter"], ["scroll", 520]]);
  await expect.poll(() => typed(page, "ws-demo")).toBe("中文同屏验收⟨Enter⟩");
  expect(await actions(page)).toEqual([], "live input never goes through the page-command path");
  const tray = (await page.getByTestId("server-browser-input-dock").boundingBox())!;
  expect(tray.y + tray.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
});

test("empty, offline and lost-frame states offer one clear next step", async ({ page }) => {
  await open(page, "?scenario=offline");
  await expect(page.getByRole("alert")).toContainText("与服务器的连接已断开");
  const before = (await calls(page)).filter(call => call.name === "browser.options").length;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.name === "browser.options").length).toBeGreaterThan(before);
  await page.goto("/?scenario=frame-error");
  await expect(page.getByText("画面连接中断", { exact: true })).toBeVisible();
  await expect(page.getByTestId("server-browser-frame-retry")).toBeVisible();
  await page.goto("/?scenario=empty");
  await expect(page.getByTestId("server-browser-start")).toBeVisible();
  await page.getByTestId("server-browser-workspace-picker").click();
  await expect(page.getByText("还没有服务器浏览器", { exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([]);
});

test('tab row pin and close controls are siblings and never switch the viewed page', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo'); await openPageTabs(page);
  expect(await page.locator('button button').count()).toBe(0);
  await page.getByTestId('server-browser-pin-tab-t-demo-docs').click();
  await expect.poll(async () => (await actions(page, 'pin')).length).toBe(1);
  expect((await actions(page, 'tab')).length).toBe(0);
  await expect(page.getByTestId('server-browser-tab-t-demo')).toHaveAttribute('aria-selected', 'true');
});

test('stale displayed page input is rejected and refreshed without touching the other tab', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo');
  await openMenuItem(page, '画面'); await page.getByTestId('server-browser-pause').click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForTimeout(250);
  const frameBounds = (await page.getByTestId('server-browser-image').boundingBox())!;
  await page.evaluate(() => (globalThis as any).__browserFixture.switchTab('ws-demo'));
  await page.mouse.click(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  await expect(page.getByText('画面已经变化，这次点击没有执行。请在新画面上再点一次。')).toBeVisible();
  const clicks = (await inputs(page)).filter(call => call.input.events[0].kind === 'click');
  expect(clicks.length).toBe(1);
  expect(clicks[0].input.target.tabId).toBe('t-demo');
  expect(await typed(page, 'ws-demo')).toBe('', 'nothing reached the other tab');
  await expect(page.getByTestId('server-browser-address')).toHaveValue(/docs\.example\.com/);
});

test('idle viewer follows another device starting without changing its viewport', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo');
  await page.evaluate(() => (globalThis as any).__browserFixture.stop('ws-demo'));
  await expect(page.getByTestId('server-browser-image')).toHaveCount(0);
  await page.evaluate(() => (globalThis as any).__browserFixture.start('ws-demo'));
  await expect(page.getByTestId('server-browser-image')).toBeVisible();
  expect((await writes(page)).length).toBe(0);
  await openMenuItem(page, '画面'); await expect(page.getByText(/网页 1440 × 900/)).toBeVisible();
});

test('pending prompt is visible and sends an explicit answer', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo');
  await page.evaluate(() => (globalThis as any).__browserFixture.dialog('ws-demo'));
  await page.getByRole('button', { name: '查看对话框' }).click();
  await expect(page.getByTestId('server-browser-dialog-input')).toHaveValue('已完成验收');
  await page.getByTestId('server-browser-dialog-input').fill('通过手机验证');
  await page.getByTestId('server-browser-dialog-confirm').click();
  await expect.poll(async () => (await actions(page, 'handleDialog')).length).toBe(1);
  expect((await actions(page, 'handleDialog'))[0].input.action).toMatchObject({ dialogId: 'dialog-fixture', accept: true, promptText: '通过手机验证' });
  await expect(page.getByRole('dialog', { name: '网页对话框' })).toHaveCount(0);
});

test('archived linked Agent can be replaced while unknown status never creates one', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-release');
  await page.evaluate(() => (globalThis as any).__browserFixture.agentUnavailable('ws-release', true));
  await page.waitForTimeout(3200);
  await page.getByTestId('server-browser-menu').click();
  await expect(page.getByRole('button', { name: '重新连接浏览器 Agent', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => (globalThis as any).__browserFixture.agentUnavailable('ws-release'));
  await page.waitForTimeout(3200);
  await openMenuItem(page, '重新连接浏览器 Agent');
  await page.getByTestId('server-browser-agent-open').click();
  await expect.poll(async () => (await calls(page)).filter(call => call.name === 'browser.agent').length).toBe(1);
});

test('late dismissal of the old menu cannot close the new sheet', async ({ page }) => {
  await open(page, '?scenario=delayed-sheets'); await selectBrowser(page, 'ws-demo');
  await openMenuItem(page, '画面');
  await expect(page.getByRole('dialog', { name: '画面', exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole('dialog', { name: '画面', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openMenuItem(page, '连接浏览器 Agent');
  await page.waitForTimeout(700);
  await expect(page.getByTestId('server-browser-agent-open')).toBeVisible();
});

test('refocusing an address draft after a remote tab switch keeps its original target', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo');
  const address = page.getByTestId('server-browser-address');
  await address.fill('https://draft.example.com/private');
  await page.evaluate(() => (globalThis as any).__browserFixture.switchTab('ws-demo'));
  await page.waitForTimeout(3500);
  await address.evaluate((element: HTMLElement) => element.blur());
  await address.focus();
  await expect(address).toHaveValue('https://draft.example.com/private');
  await address.press('Enter');
  await expect.poll(async () => (await actions(page, 'navigate')).length).toBe(1);
  expect((await actions(page, 'navigate'))[0].input).toMatchObject({ target: { tabId: 't-demo', viewRevision: '0' } });
  await expect(page.getByText('画面已变化，这次操作未执行，已刷新当前页面。')).toBeVisible();
});

test('touch drag keeps the page from touch start even when the page changes before movement', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo');
  const image = (await page.getByTestId('server-browser-image').boundingBox())!;
  const x = Math.round(image.x + image.width / 2), y = Math.round(image.y + image.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.evaluate(() => (globalThis as any).__browserFixture.switchTab('ws-demo'));
  await page.waitForTimeout(3500);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 20 }] });
  await page.waitForTimeout(80);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 65 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(350);
  const attempted = await inputs(page);
  // RN may cancel the gesture when the old image goes. A surviving gesture keeps page A and never scrolls page B.
  for (const call of attempted) expect(call.input).toMatchObject({ target: { tabId: 't-demo', viewRevision: '0' } });
  expect(await actions(page)).toEqual([]);
  await expect(page.getByTestId('server-browser-address')).toHaveValue(/docs\.example\.com/);
  await expect(page.getByTestId('server-browser-frame')).toHaveAttribute('tabindex', '0');
  await cdp.detach();
});

test('stopped overview browsers release their thumbnail image', async ({ page }) => {
  await open(page); await selectBrowser(page, 'ws-demo');
  await page.getByTestId('server-browser-workspace-picker').click();
  const card = page.getByTestId('server-browser-overview-card-ws-demo');
  await expect(card).toBeVisible();
  await page.evaluate(() => (globalThis as any).__browserFixture.stop('ws-demo'));
  await page.getByTestId('server-browser-overview-refresh').click();
  await expect(card).toHaveCount(0);
});

test("typing straight on the picture: every key and its Enter arrive, focus survives new pictures (opus-F16)", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  await open(page); await selectBrowser(page, "ws-demo");
  await pressPicture(page);
  await expect.poll(() => focusedTestId(page)).toBe("server-browser-ime");
  await page.keyboard.type("hello", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("abc");
  await page.keyboard.press("Enter");
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩hello⟨Enter⟩abc⟨Enter⟩");
  // Several new pictures arrived meanwhile; the keyboard target never fell back to the page body.
  await page.waitForTimeout(1200);
  expect(await focusedTestId(page)).toBe("server-browser-ime");
  await page.keyboard.type("!");
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩hello⟨Enter⟩abc⟨Enter⟩!");
  const batches = await inputs(page);
  expect(batches.length).toBeLessThan(13, "a burst travels in a few batches, not one request per key");
  expect(batches.every(call => call.input.target.tabId === "t-demo")).toBe(true);
  expect(batches.map(call => call.input.seq)).toEqual(batches.map((_call, index) => index + 1));
  expect(await actions(page)).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an input method composes on the picture and its result arrives in one piece; paste sends plain text (opus-B2)", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  await open(page); await selectBrowser(page, "ws-demo");
  await pressPicture(page);
  await expect.poll(() => focusedTestId(page)).toBe("server-browser-ime");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  // The slot itself is invisible: the badge shows what the input method holds so far.
  await expect(page.getByTestId("server-browser-composing")).toContainText("输入法组合中 · nihao");
  await page.waitForTimeout(300);
  expect(await typed(page, "ws-demo")).toBe("⟨click⟩", "nothing is sent while the input method composes");
  await cdp.send("Input.insertText", { text: "你好" });
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩你好");
  await expect(page.getByTestId("server-browser-composing")).toHaveCount(0);
  await page.evaluate(() => { const data = new DataTransfer(); data.setData("text/plain", "粘贴 the text"); document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩你好粘贴 the text");
  expect(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value)).toBe("", "the slot never keeps what was typed");
  await cdp.detach();
});

test("another device's input drops this device's queued keys with a clear note; the next picture takes keys again", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  await open(page); await selectBrowser(page, "ws-demo");
  await pressPicture(page);
  await page.keyboard.type("ab");
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩ab");
  await page.evaluate(() => (globalThis as any).__browserFixture.otherViewer("ws-demo"));
  await page.keyboard.type("cd");
  await expect(page.getByText(/页面已经变化，刚才的 2 个字或按键没有发送/)).toBeVisible();
  expect(await typed(page, "ws-demo")).toBe("⟨click⟩ab");
  await expect.poll(async () => (await page.getByTestId("server-browser-image").count()) > 0).toBe(true);
  await page.waitForTimeout(400);
  await page.keyboard.type("e");
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩abe");
});

test("on a phone a tap on the picture never opens the soft keyboard; the tray types", async ({ page }) => {
  test.skip(desktop(page), "desktop types on the picture");
  await open(page); await selectBrowser(page, "ws-demo");
  await pressPicture(page, 60, 60, true);
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
});

test("workspace services open in a new tab from the tabs sheet and the menu (opus-B3)", async ({ page }) => {
  await open(page); await selectBrowser(page, "ws-demo");
  await openPageTabs(page);
  const tabs = page.getByRole("dialog", { name: /^标签页/ });
  await expect(tabs.getByText("本工作区服务")).toBeVisible();
  await expect(tabs.getByTestId("server-browser-service-api")).toBeVisible();
  await expect(tabs.getByTestId("server-browser-service-storybook")).toHaveAttribute("aria-disabled", "true");
  await tabs.getByTestId("server-browser-service-web").click();
  await expect.poll(async () => (await actions(page, "newTab")).map(call => call.input.action?.url)).toEqual(["http://127.0.0.1:5173/"]);
  await expect(page.getByRole("alert").filter({ hasText: "已在新标签页打开 web" })).toBeVisible();
  await openMenuItem(page, "本工作区服务");
  const sheet = page.getByRole("dialog", { name: "本工作区服务" });
  await expect(sheet.getByText("端口 8787 · 无响应")).toBeVisible();
  await sheet.getByTestId("server-browser-service-api").click();
  await expect.poll(async () => (await actions(page, "newTab")).length).toBe(2);
  expect(await noOverflow(page)).toBe(true);
});

test("leftover Profiles of gone workspaces are listed with their size and deleted only after confirming (opus-F11)", async ({ page }) => {
  await open(page, "?scenario=orphans"); await selectBrowser(page, "ws-demo");
  await openMenuItem(page, "孤儿浏览器");
  const sheet = page.getByRole("dialog", { name: "孤儿浏览器" });
  await expect(sheet.getByText("仍在运行 1")).toBeVisible();
  await expect(sheet.getByText("留下的浏览器资料 1 · 61.5 MB")).toBeVisible();
  await expect(sheet.getByText("docs-site / fix/typo")).toBeVisible();
  await sheet.getByTestId("server-browser-delete-orphan-wks_gone").click();
  await expect(sheet.getByText(/登录状态、Cookie、历史、缓存和 Agent 截图都会清除，不能恢复/)).toBeVisible();
  expect((await calls(page)).filter(call => call.name === "browser.orphan.delete")).toEqual([], "nothing is deleted before the confirmation");
  await sheet.getByTestId("server-browser-delete-orphan-confirm-wks_gone").click();
  await expect.poll(async () => (await calls(page)).filter(call => call.name === "browser.orphan.delete").map(call => call.input.workspaceId)).toEqual(["wks_gone"]);
  await expect(sheet.getByText("docs-site / fix/typo")).toHaveCount(0);
  expect(await page.locator("button button").count()).toBe(0);
});

test("a composition started on one page is dropped when the page or tab changes, never sent to the new one (codex-sb-F1)", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  for (const change of ["pageChanged", "switchTab"] as const) {
    await open(page); await selectBrowser(page, "ws-demo");
    await page.evaluate(() => { (globalThis as any).__typed["ws-demo"] = ""; });
    await pressPicture(page);
    await expect.poll(() => focusedTestId(page)).toBe("server-browser-ime");
    await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "mima", selectionStart: 4, selectionEnd: 4 });
    await expect(page.getByTestId("server-browser-composing")).toContainText("mima");
    // Another device or the Agent changes what this picture showed while the composition is open.
    await page.evaluate(name => (globalThis as any).__browserFixture[name]("ws-demo"), change);
    await expect(page.getByRole("alert").filter({ hasText: "输入法里还没确认的文字没有发送" })).toBeVisible();
    await expect(page.getByTestId("server-browser-composing")).toHaveCount(0);
    // The slot is released: what the input method commits afterwards goes nowhere, least of all to the new page, even
    // once the new page is on screen.
    expect(await focusedTestId(page)).not.toBe("server-browser-ime");
    await expect(page.getByTestId("server-browser-image")).toBeVisible();
    await page.waitForTimeout(400);
    await cdp.send("Input.insertText", { text: "秘密" });
    await page.waitForTimeout(500);
    expect(await typed(page, "ws-demo"), change).toBe("⟨click⟩");
    expect((await liveEvents(page)).filter(event => event.kind === "text"), change).toEqual([]);
    // A press on the new picture takes the slot back: typing goes to the page now on screen.
    await pressPicture(page);
    await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩⟨click⟩");
    await page.keyboard.type("ok");
    await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩⟨click⟩ok");
    await cdp.detach();
  }
});

test("the takeover sheet goes stale when the page changes before confirming, and confirms nothing (codex-sb-F3)", async ({ page }) => {
  await open(page); await selectBrowser(page, "ws-release");
  if (desktop(page)) await page.getByTestId("server-browser-reload").click(); else await openMenuItem(page, "切到手动并刷新");
  const confirm = page.getByTestId("server-browser-takeover-confirm");
  await expect(confirm).toBeEnabled();
  await page.evaluate(() => (globalThis as any).__browserFixture.pageChanged("ws-release"));
  await expect(page.getByText(/这次确认已失效，不会切到手动，也不会刷新/)).toBeVisible();
  await expect(confirm).toBeDisabled();
  await confirm.click({ force: true });
  await page.waitForTimeout(300);
  expect(await actions(page, "takeover")).toEqual([], "a stale confirmation sends nothing");
  await expect(page.getByRole("tab", { name: "Agent", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("keys after an Enter that opens a page dialog are reported, never sent later (codex-sb-F5)", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  await open(page); await selectBrowser(page, "ws-demo");
  await page.evaluate(() => { (globalThis as any).__typed["ws-demo"] = ""; (globalThis as any).__dialogOnEnter = { "ws-demo": true }; });
  await pressPicture(page);
  await expect.poll(() => focusedTestId(page)).toBe("server-browser-ime");
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩");
  await page.keyboard.type("ok");
  await page.keyboard.press("Enter");
  await page.keyboard.type("lost");
  const note = page.getByRole("alert").filter({ hasText: /网页弹出了对话框，刚才的 \d+ 个字或按键没有发送/ });
  await expect(note).toBeVisible();
  await expect(note.getByRole("button", { name: "查看对话框" })).toBeVisible();
  expect(await typed(page, "ws-demo")).toBe("⟨click⟩ok⟨Enter⟩");
  await page.waitForTimeout(500);
  expect(await typed(page, "ws-demo"), "nothing after the dialog is replayed").toBe("⟨click⟩ok⟨Enter⟩");
});

test("a long paste keeps every character whole across the 10,000-unit pieces (codex-sb-F6)", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  await open(page); await selectBrowser(page, "ws-demo");
  await page.evaluate(() => { (globalThis as any).__typed["ws-demo"] = ""; });
  await pressPicture(page);
  await expect.poll(() => focusedTestId(page)).toBe("server-browser-ime");
  const text = "a".repeat(9999) + "😀" + "尾b";
  await page.evaluate(value => { const data = new DataTransfer(); data.setData("text/plain", value); document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); }, text);
  await expect.poll(async () => (await typed(page, "ws-demo")).length).toBe("⟨click⟩".length + text.length);
  expect(await typed(page, "ws-demo")).toBe("⟨click⟩" + text);
  const pieces = (await liveEvents(page)).filter(event => event.kind === "text").map(event => event.text!);
  expect(pieces.every(piece => !/[\uD800-\uDBFF]$/.test(piece) && !/^[\uDC00-\uDFFF]/.test(piece))).toBe(true);
});

test("a viewer numbers its input above the floor of viewers the server forgot, so its typing lands from the first key (grok-sb-F3)", async ({ page }) => {
  test.skip(!desktop(page), "phones type through the input tray");
  // The server already forgot 64+ viewers: a viewer it does not remember must number its batches above 500.
  await page.addInitScript(() => { (globalThis as unknown as { __inputSeqFloor: Record<string, number> }).__inputSeqFloor = { "ws-demo": 500 }; });
  await open(page); await selectBrowser(page, "ws-demo");
  await pressPicture(page);
  await expect.poll(() => focusedTestId(page)).toBe("server-browser-ime");
  await page.keyboard.type("ok");
  await page.keyboard.press("Enter");
  await expect.poll(() => typed(page, "ws-demo")).toBe("⟨click⟩ok⟨Enter⟩");
  const seqs = (await inputs(page)).map(call => call.input.seq);
  expect(seqs[0]).toBe(501);
  expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
