import { expect, test, type Page } from "@playwright/test";

// Main flows against the fixture preview (npm run test:ui). RPCs are in-memory; __notesCalls records every call.
type Call = { method: string; input: any };
declare global { var __notesCalls: Call[]; var __notesToasts: { message: string }[]; var __clipboard: string | null; var __notesNavigation: unknown[] }

let problems: string[] = [];
async function open(page: Page, query = "") {
  problems = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") problems.push(message.text()); });
  await page.goto(`/?chrome=0${query}`);
}
const calls = (page: Page) => page.evaluate(() => globalThis.__notesCalls.map(({ method, input }) => ({ method, input })));
const writes = async (page: Page) => (await calls(page)).filter(call => call.method === "project-notes.write");
const toasts = (page: Page) => page.evaluate(() => globalThis.__notesToasts.map(toast => toast.message));
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
test.afterEach(() => { expect(problems).toEqual([]); });

test("create: 保存 stays disabled until there is a title, then one create write", async ({ page }) => {
  await open(page);
  await button(page, "新建任务").click();
  const dialog = page.getByRole("dialog", { name: "新建任务" });
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "标题" }).fill("整理周报");
  await dialog.getByRole("textbox", { name: "正文" }).fill("按项目分组。");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(button(page, "整理周报")).toBeVisible();
  const created = await writes(page);
  expect(created).toHaveLength(1);
  expect(created[0]!.input).toMatchObject({ projectId: "__inbox__", operation: { type: "create", fields: { kind: "task", status: "todo", title: "整理周报", body: "按项目分组。", priority: "normal", pinned: false } } });
  expect(await toasts(page)).toContain("已保存到「随手记」");
});

test("keyboard: Enter in 标题 saves", async ({ page }) => {
  await open(page);
  await button(page, "新建任务").click();
  const title = page.getByRole("dialog", { name: "新建任务" }).getByRole("textbox", { name: "标题" });
  await expect(title).toBeFocused();
  await title.fill("回车保存");
  await title.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await writes(page)).map(call => call.input.operation.fields.title)).toEqual(["回车保存"]);
});

test("edit: from the detail sheet, one update with the item's revision, back to the detail", async ({ page }) => {
  await open(page);
  await button(page, "整理 2.0 迁移后的发布清单").click();
  await button(page, "编辑").click();
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(dialog.getByRole("button", { name: "所属项目：web-app，不可更改" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "标题" }).fill("整理 2.0 迁移后的发布清单与回滚步骤");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "任务详情" });
  await expect(detail.getByText("整理 2.0 迁移后的发布清单与回滚步骤", { exact: true })).toBeVisible();
  const updated = await writes(page);
  expect(updated).toHaveLength(1);
  expect(updated[0]!.input.operation).toMatchObject({ type: "update", expectedRevision: 1, fields: { title: "整理 2.0 迁移后的发布清单与回滚步骤", kind: "task", status: "todo" } });
});

test("status: the glyph advances a task with one write and does not open the card", async ({ page }) => {
  await open(page);
  await button(page, "整理 2.0 迁移后的发布清单：移到进行中").click();
  await expect(button(page, "整理 2.0 迁移后的发布清单：移到已完成")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const changed = await writes(page);
  expect(changed.map(call => call.input.operation)).toEqual([expect.objectContaining({ type: "update", expectedRevision: 1, fields: { status: "doing" } })]);
  // In the detail sheet the same change is one tap on the status control.
  await button(page, "整理 2.0 迁移后的发布清单").click();
  await page.getByRole("dialog", { name: "任务详情" }).getByRole("tab", { name: "已完成" }).click();
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  expect((await writes(page))[1]!.input.operation).toMatchObject({ expectedRevision: 2, fields: { status: "done" } });
});

test("delete moves the note to 回收站 in one write; 恢复 brings it back", async ({ page }) => {
  await open(page);
  await button(page, "复核 checkout-service 压测报告").click();
  await button(page, "删除").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button(page, "复核 checkout-service 压测报告")).toHaveCount(0);
  expect(await toasts(page)).toContain("已移到回收站");
  await button(page, "更多操作").click();
  await button(page, "回收站").click();
  await button(page, "恢复：复核 checkout-service 压测报告").click();
  await expect(button(page, "恢复：复核 checkout-service 压测报告")).toHaveCount(0);
  await button(page, "返回手记").click();
  await expect(button(page, "复核 checkout-service 压测报告")).toBeVisible();
  expect((await writes(page)).map(call => call.input.operation)).toEqual([
    expect.objectContaining({ type: "delete", expectedRevision: 1 }), expect.objectContaining({ type: "restore", expectedRevision: 2 }),
  ]);
});

test("copy: a prompt row copies its body without any RPC", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "提示词 5" }).click();
  const before = (await calls(page)).length;
  await button(page, "复制：排查线上告警").click();
  expect(await page.evaluate(() => globalThis.__clipboard)).toBe("你是值班工程师。先确认影响面（哪些服务、多少请求、从何时开始），再给出最可能的三个原因和各自的验证命令。只做只读操作，不要改配置。");
  expect(await toasts(page)).toContain("已复制");
  expect((await calls(page)).slice(before).filter(call => call.method !== "project-notes.dashboard")).toEqual([]);
});

test("launch: the dialog opens prefilled and launches only on confirm, then opens the agent", async ({ page }) => {
  await open(page);
  await button(page, "弱网时给购物车加上重试提示").click();
  await button(page, "开始处理").click();
  const dialog = page.getByRole("dialog", { name: "开始处理" });
  await expect(dialog.getByText("Claude Code · Opus 5.5 · 默认 · 中")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "目标项目" })).toContainText("web-app");
  expect((await calls(page)).map(call => call.method)).not.toContain("project-notes.launch");
  await dialog.getByRole("button", { name: "创建工作区并开始" }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__notesNavigation), { timeout: 8_000 }).toEqual([{ type: "agent", agentId: "agent_0f41c9d2", serverId: "fixture-host" }]);
  await expect(dialog).toBeHidden();
  const launches = (await calls(page)).filter(call => call.method === "project-notes.launch");
  expect(launches).toHaveLength(1);
  expect(launches[0]!.input).toMatchObject({ projectId: "prj_web", isolation: "worktree", provider: "claude", model: "opus-5.5", title: "弱网时给购物车加上重试提示" });
});

test("scope: picking a project filters the notes and new notes default to it", async ({ page }) => {
  await open(page);
  await button(page, "筛选项目：全部项目").click();
  await page.getByRole("dialog", { name: "选择项目" }).getByRole("button", { name: "checkout-service", exact: true }).click();
  await expect(button(page, "筛选项目：checkout-service")).toBeVisible();
  await expect(button(page, "复核 checkout-service 压测报告")).toBeVisible();
  await expect(button(page, "弱网时给购物车加上重试提示")).toHaveCount(0);
  await button(page, "新建任务").click();
  await expect(page.getByRole("dialog", { name: "新建任务" }).getByRole("button", { name: "保存到：checkout-service" })).toBeVisible();
});

test("layout: first item near the top and no horizontal overflow", async ({ page }, info) => {
  await open(page);
  const phone = info.project.name === "mobile";
  const first = button(page, phone ? "重写 infra-monitor 的告警分级" : "弱网时给购物车加上重试提示");
  await expect(first).toBeVisible();
  expect((await first.boundingBox())!.y).toBeLessThanOrEqual(phone ? 150 : 120);
  // Evaluated as a string: this tsconfig has no DOM lib.
  expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth && document.getElementById('root').scrollWidth <= innerWidth")).toBe(true);
});

test("states: skeleton while loading, a retry when the host is unreachable", async ({ page }) => {
  await open(page, "&scenario=slow");
  await expect(page.getByRole("progressbar", { name: "加载中" }).first()).toBeVisible();
  await expect(button(page, "新建任务")).toBeDisabled();
  await open(page, "&scenario=error");
  await expect(page.getByText("暂时无法读取手记")).toBeVisible();
  await button(page, "重试").click();
  await expect.poll(async () => (await calls(page)).filter(call => call.method === "project-notes.dashboard").length).toBeGreaterThanOrEqual(2);
});
