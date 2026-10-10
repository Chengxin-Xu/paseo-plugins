import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BoardStore, defaultStorageRoot, paseoHome } from "../server/store";
import { CliError, parseArgs, resolveProject, runCli, type CliDeps } from "../server/cli";
import { INBOX_PROJECT_ID, type BoardProject } from "../shared/schema";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const projects: BoardProject[] = [
  { id: "prj_web", name: "Storefront", path: "/repo/acme/storefront" },
  { id: "prj_web_docs", name: "storefront-docs", path: "/repo/acme/storefront/docs" },
  { id: "prj_billing", name: "billing_service", path: "/repo/payments/billing_service" },
  { id: "prj_billing_jobs", name: "billing_service_jobs", path: "/repo/payments/billing_service_jobs" },
];

async function harness(overrides: Partial<CliDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "project-notes-cli-")); directories.push(root);
  const output: string[] = [];
  const deps: CliDeps = {
    store: new BoardStore(root), loadProjects: async () => projects, stdout: text => { output.push(text); },
    readStdin: async () => "来自 stdin 的正文", cwd: "/repo/acme/storefront/packages/ui", env: {}, ...overrides,
  };
  const run = async (...argv: string[]) => { output.length = 0; const code = await runCli(argv, deps); return { code, text: output.join("") }; };
  const runJson = async (...argv: string[]) => { const { text } = await run(...argv, "--json"); return JSON.parse(text) as any; };
  return { root, deps, run, runJson };
}

describe("parseArgs", () => {
  it("separates command, positionals, values and flags", () => {
    const parsed = parseArgs(["update", "abc", "--title", "新标题", "--body=多行\n正文", "--pinned", "--json"]);
    expect(parsed.command).toBe("update"); expect(parsed.positionals).toEqual(["abc"]);
    expect(parsed.values.get("title")).toBe("新标题"); expect(parsed.values.get("body")).toBe("多行\n正文");
    expect(parsed.flags.has("pinned")).toBe(true); expect(parsed.flags.has("json")).toBe(true);
  });
  it("accepts '-' as a value and rejects unknown or valueless options", () => {
    expect(parseArgs(["add", "--body-file", "-"]).values.get("body-file")).toBe("-");
    expect(() => parseArgs(["add", "--nope"])).toThrow(CliError);
    expect(() => parseArgs(["add", "--title"])).toThrow(/需要一个值/);
    expect(() => parseArgs(["add", "--json=1"])).toThrow(/不接受值/);
  });
});

describe("resolveProject", () => {
  it("resolves inbox, ids, paths (longest root wins) and names", () => {
    expect(resolveProject("inbox", projects, "/").id).toBe(INBOX_PROJECT_ID);
    expect(resolveProject("prj_billing", projects, "/").id).toBe("prj_billing");
    expect(resolveProject("/repo/acme/storefront/src/cart", projects, "/").id).toBe("prj_web");
    expect(resolveProject("/repo/acme/storefront/docs/guide", projects, "/").id).toBe("prj_web_docs");
    expect(resolveProject("storefront", projects, "/").id).toBe("prj_web");
    expect(resolveProject("jobs", projects, "/").id).toBe("prj_billing_jobs");
  });
  it("falls back to the working directory and explains failures", () => {
    expect(resolveProject(undefined, projects, "/repo/acme/storefront").id).toBe("prj_web");
    expect(() => resolveProject(undefined, projects, "/elsewhere")).toThrow(/--project/);
    expect(() => resolveProject("billing", projects, "/")).toThrow(/匹配多个项目/);
    expect(() => resolveProject("nothing", projects, "/")).toThrow(/找不到项目/);
    expect(() => resolveProject("/repo/other", projects, "/")).toThrow(/不属于任何/);
  });
});

describe("runCli", () => {
  it("adds from the cwd project, reads body from stdin, and lists/shows it", async () => {
    const { run, runJson } = await harness();
    const added = await runJson("add", "--title", "接入新版登录页", "--body-file", "-", "--high", "--pinned");
    expect(added.projectId).toBe("prj_web"); expect(added.replayed).toBe(false);
    const listed = await runJson("list", "--project", "Storefront", "--kind", "task");
    expect(listed.total).toBe(1); expect(listed.items[0]).toMatchObject({ id: added.itemId, title: "接入新版登录页", body: "来自 stdin 的正文", priority: "high", pinned: true, projectName: "Storefront" });
    const { text } = await run("show", added.itemId);
    expect(text).toContain("接入新版登录页"); expect(text).toContain("来自 stdin 的正文"); expect(text).toContain("Storefront");
  });
  it("prefers PASEO_AGENT_CWD over cwd for the default project and supports inbox", async () => {
    const { runJson } = await harness({ env: { PASEO_AGENT_CWD: "/repo/payments/billing_service" } });
    expect((await runJson("add", "--title", "巡检")).projectId).toBe("prj_billing");
    expect((await runJson("add", "--title", "随手", "--project", "inbox", "--kind", "idea")).projectId).toBe(INBOX_PROJECT_ID);
    const listed = await runJson("list");
    expect(listed.items.map((item: any) => item.projectName).sort()).toEqual(["随手记", "billing_service"].sort());
  });
  it("updates with the current revision, hides done tasks by default, and is idempotent per request id", async () => {
    const { run, runJson } = await harness();
    const added = await runJson("add", "--title", "任务", "--request-id", "cli-fixed-request");
    const replay = await runJson("add", "--title", "任务", "--request-id", "cli-fixed-request");
    expect(replay.replayed).toBe(true); expect(replay.itemId).toBe(added.itemId);
    const updated = await runJson("update", added.itemId, "--status", "doing", "--body", "进展");
    expect(updated).toMatchObject({ revision: 2, status: "doing", body: "进展" });
    await run("done", added.itemId);
    expect((await runJson("list")).total).toBe(0);
    expect((await runJson("list", "--all")).items[0]).toMatchObject({ status: "done", revision: 3 });
    await run("delete", added.itemId);
    expect((await runJson("list", "--all")).total).toBe(0);
    expect((await runJson("list", "--trash")).items[0].id).toBe(added.itemId);
    await run("restore", added.itemId);
    expect((await runJson("list", "--all")).total).toBe(1);
  });
  it("reads --body-file from disk relative to cwd and rejects invalid input clearly", async () => {
    const { root, run, runJson } = await harness();
    await writeFile(join(root, "body.md"), "# 设计\n正文", "utf8");
    const added = await runJson("add", "--title", "带文件", "--body-file", join(root, "body.md"));
    expect((await runJson("show", added.itemId)).body).toBe("# 设计\n正文");
    await expect(run("add")).rejects.toThrow(/--title/);
    await expect(run("add", "--title", "x", "--kind", "bug")).rejects.toThrow();
    await expect(run("update", added.itemId)).rejects.toThrow(/至少需要一个/);
    await expect(run("show", "not-a-uuid")).rejects.toThrow(/不是有效的记录 ID/);
    await expect(run("frobnicate")).rejects.toThrow(/未知命令/);
    expect((await run("help")).text).toContain("用法");
  });
});

describe("paseoHome", () => {
  it("follows PASEO_HOME with ~ expansion, else Paseo's default ~/.paseo", () => {
    expect(paseoHome({})).toBe(join(homedir(), ".paseo"));
    expect(paseoHome({ PASEO_HOME: "  " })).toBe(join(homedir(), ".paseo"));
    expect(paseoHome({ PASEO_HOME: "~" })).toBe(homedir());
    expect(paseoHome({ PASEO_HOME: "~/paseo-test" })).toBe(join(homedir(), "paseo-test"));
    expect(paseoHome({ PASEO_HOME: "relative/home" })).toBe(resolve("relative/home"));
    expect(defaultStorageRoot({ PASEO_HOME: "/srv/paseo" })).toBe("/srv/paseo/plugin-data/project-notes/boards");
  });
});
