import { expect, test, type Page } from "@playwright/test";

type Call = { name: string; input: { workspaceId?: string; action?: { kind: string; [key: string]: unknown }; quality?: string; maxWidth?: number } };
const calls = (page: Page): Promise<Call[]> => page.evaluate(() => (globalThis as unknown as { __browserCalls: Call[] }).__browserCalls);
const writes = async (page: Page) => (await calls(page)).filter(call => ["browser.action", "browser.start", "browser.agent"].includes(call.name));
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

test("address and navigation are read-only for the Agent and navigate once in manual control", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("server-browser-image")).toBeVisible();
  await selectBrowser(page, "ws-release");
  if (desktop(page)) {
    await expect(page.getByTestId("server-browser-address")).toHaveValue("https://docs.example.com/guide/getting-started");
    await expect(page.getByTestId("server-browser-address")).not.toBeEditable();
    await expect(page.getByTestId("server-browser-back")).toBeDisabled();
  } else await expect(page.getByTestId("server-browser-address")).toHaveCount(0);
  await page.getByRole("tab", { name: "手动", exact: true }).click();
  const address = page.getByTestId("server-browser-address");
  await expect(address).toBeEditable();
  await address.fill("git.example.com/acme/web-app");
  await address.press("Enter");
  await expect(address).toHaveValue("https://git.example.com/acme/web-app");
  expect((await actions(page, "navigate")).map(call => call.input.action?.url)).toEqual(["git.example.com/acme/web-app"]);
  await page.getByTestId("server-browser-back").click();
  await page.getByTestId("server-browser-reload").click();
  await expect.poll(async () => (await actions(page)).map(call => call.input.action?.kind)).toEqual(["mode", "navigate", "back", "reload"]);
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
  await expect.poll(async () => (await actions(page)).map(call => call.input.action?.kind)).toEqual(["viewport", "fitWidth"]);
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
  expect((await writes(page)).map(call => call.input.action?.kind)).toEqual(["viewport", "fitWidth", "stop"]);
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
  await expect.poll(async () => (await actions(page)).map(call => [call.input.action?.kind, call.input.action?.text ?? call.input.action?.key ?? call.input.action?.deltaY])).toEqual([["text", "中文同屏验收"], ["key", "Enter"], ["scroll", 520]]);
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
