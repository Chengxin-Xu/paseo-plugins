// Screenshots of the fixture preview: every main view at desktop 1120×760 and phone 390×844, dark and light.
//   npm run preview:build && node scripts/shots.mjs --out <dir> [--prefix after] [--only tasks,detail] [--device phone] [--theme dark] [--timezone UTC]
// Times render in --timezone (default UTC) against a fixed clock, so shots are identical on every host.
// Hosts without system Chromium libraries need LD_LIBRARY_PATH pointing at them.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const out = arg("out", join(root, "artifacts", "shots"));
const prefix = arg("prefix", "after");
const only = arg("only", "")?.split(",").filter(Boolean);
const timezoneId = arg("timezone", "UTC");
const page = pathToFileURL(join(root, "preview", "dist", "index.html")).href;
const devices = { desktop: { viewport: { width: 1120, height: 760 } }, phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } };
const button = (p, name) => p.getByRole("button", { name, exact: true }).first().click();
const views = {
  tasks: {},
  prompts: { act: p => p.getByRole("tab", { name: /^提示词/ }).click() },
  ideas: { act: p => p.getByRole("tab", { name: /^想法/ }).click() },
  detail: { act: p => button(p, "弱网时给购物车加上重试提示") },
  "prompt-detail": { act: async p => { await p.getByRole("tab", { name: /^提示词/ }).click(); await button(p, "排查线上告警"); } },
  editor: { act: p => button(p, "新建任务") },
  edit: { act: async p => { await button(p, "弱网时给购物车加上重试提示"); await button(p, "编辑"); } },
  launch: { act: async p => { await button(p, "弱网时给购物车加上重试提示"); await button(p, "开始处理"); await p.waitForTimeout(400); } },
  "launch-running": { query: "scenario=launch-hold", act: async p => { await button(p, "弱网时给购物车加上重试提示"); await button(p, "开始处理"); await p.waitForTimeout(300); await button(p, "创建工作区并开始"); await p.waitForTimeout(2400); } },
  "launch-rejected": { query: "scenario=launch-reject", act: async p => { await button(p, "弱网时给购物车加上重试提示"); await button(p, "开始处理"); await p.waitForTimeout(300); await button(p, "创建工作区并开始"); await p.waitForTimeout(2400); } },
  "launch-started": { query: "nav=0", act: async p => { await button(p, "弱网时给购物车加上重试提示"); await button(p, "开始处理"); await p.waitForTimeout(300); await button(p, "创建工作区并开始"); await p.waitForTimeout(4400); } },
  projects: { act: p => button(p, "筛选项目：全部项目") },
  menu: { act: p => button(p, "更多操作") },
  trash: { act: async p => { await button(p, "更多操作"); await button(p, "回收站"); } },
  grouped: { act: async p => { await button(p, "更多操作"); await button(p, "按项目分组"); } },
  empty: { query: "scenario=empty" },
  loading: { query: "scenario=slow" },
  error: { query: "scenario=error" },
  stale: { query: "scenario=stale", act: p => p.waitForTimeout(5600) },
};
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
let failures = 0;
for (const [device, options] of Object.entries(devices)) {
  if (arg("device") && arg("device") !== device) continue;
  for (const theme of ["dark", "light"]) {
    if (arg("theme") && arg("theme") !== theme) continue;
    for (const [name, view] of Object.entries(views)) {
      if (only?.length && !only.includes(name)) continue;
      const context = await browser.newContext({ ...options, deviceScaleFactor: 2, timezoneId, locale: "zh-CN" });
      context.setDefaultTimeout(5000);
      const tab = await context.newPage();
      await tab.clock.setFixedTime(new Date("2026-09-23T15:00:00Z")); // preview/fixtures.js NOW
      const errors = [];
      tab.on("pageerror", error => errors.push(error.message));
      tab.on("console", message => { if (message.type() === "error" || message.type() === "warning") errors.push(message.text()); });
      await tab.goto(`${page}?theme=${theme}${view.query ? `&${view.query}` : ""}`);
      await tab.waitForTimeout(350);
      try { await view.act?.(tab); } catch (error) { errors.push(`action failed: ${error.message.split("\n")[0]}`); }
      await tab.waitForTimeout(250);
      await tab.screenshot({ path: join(out, `${prefix}-${name}-${device}-${theme}.png`) });
      if (errors.length) { failures++; console.log(`${name} ${device} ${theme}:`, errors.slice(0, 4)); }
      await context.close();
    }
  }
}
await browser.close();
console.log(`screenshots → ${out}${failures ? ` (${failures} with console errors)` : ""}`);
process.exitCode = failures ? 1 : 0;
