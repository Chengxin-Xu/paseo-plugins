import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { BoardStore, defaultStorageRoot, paseoHome } from "../server/store";
import { CliError, loadPaseoProjects, parseArgs, readLimited, resolveProject, runCli, terminalSafe, type CliDeps } from "../server/cli";
import { INBOX_DESCRIPTION, INBOX_PROJECT_ID, type BoardProject } from "../shared/schema";

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

describe("CLI input limits", () => {
  it("reads a body file up to the byte limit, which a valid body can never exceed", async () => {
    const { root, runJson } = await harness();
    // 32,000 three-byte characters: exactly the body limit and exactly 96,000 bytes.
    await writeFile(join(root, "full.md"), "字".repeat(32_000), "utf8");
    const added = await runJson("add", "--title", "满长度正文", "--body-file", join(root, "full.md"));
    expect((await runJson("show", added.itemId)).body).toHaveLength(32_000);
    await writeFile(join(root, "over.md"), "字".repeat(32_000) + "!", "utf8");
    await expect(runJson("add", "--title", "超长", "--body-file", join(root, "over.md"))).rejects.toThrow(/正文文件过大.*96000 字节/);
  });

  it("refuses a huge body file from its size alone, before reading it", async () => {
    const { root, run } = await harness();
    const huge = join(root, "huge.log");
    await writeFile(huge, ""); await truncate(huge, 64 * 1024 * 1024); // sparse: costs nothing unless read
    await expect(run("add", "--title", "大文件", "--body-file", huge)).rejects.toThrow(CliError);
    await expect(run("add", "--title", "大文件", "--body-file", huge)).rejects.toThrow(/正文文件过大.*67108864 字节/);
  });

  it("refuses directories and FIFOs as body files without blocking", async () => {
    const { root, run } = await harness();
    await mkdir(join(root, "folder"));
    await expect(run("add", "--title", "目录", "--body-file", join(root, "folder"))).rejects.toThrow(/不是普通文件/);
    const fifo = join(root, "pipe");
    await promisify(execFile)("mkfifo", [fifo]);
    try { await expect(run("add", "--title", "管道", "--body-file", fifo)).rejects.toThrow(/不是普通文件.*--body-file -/); }
    finally { try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* nobody is reading it */ } }
  }, 10_000);

  it.runIf(process.platform !== "win32")("refuses endless devices such as /dev/zero", async () => {
    const { run } = await harness();
    await expect(run("add", "--title", "设备", "--body-file", "/dev/zero")).rejects.toThrow(/不是普通文件/);
  });

  it("reads /dev/stdin like '-', and stops reading stdin past the limit", async () => {
    let limit = 0;
    const { runJson } = await harness({ readStdin: async maxBytes => { limit = maxBytes; return "管道正文"; } });
    const added = await runJson("add", "--title", "经由 /dev/stdin", "--body-file", "/dev/stdin");
    expect((await runJson("show", added.itemId)).body).toBe("管道正文");
    expect(limit).toBe(96_000);
    expect(await readLimited(Readable.from([Buffer.from("ab"), "cd"]), 4, "标准输入")).toBe("abcd");
    let pulled = 0;
    const endless = Readable.from((function* () { for (;;) { pulled++; yield Buffer.alloc(1024, 120); } })());
    await expect(readLimited(endless, 96_000, "标准输入")).rejects.toThrow(/标准输入过大.*96000 字节/);
    expect(pulled).toBeLessThan(100);
  });

  it("falls back to a bounded projects.json and explains an oversized one", async () => {
    const home = await mkdtemp(join(tmpdir(), "project-notes-cli-projects-")); directories.push(home);
    // No `paseo` on PATH: the CLI falls back to the daemon's projects.json.
    const env = { PASEO_HOME: home, PATH: join(home, "no-bin") };
    await mkdir(join(home, "projects"));
    const file = join(home, "projects", "projects.json");
    await writeFile(file, JSON.stringify([{ projectId: "prj_a", rootPath: "/repo/a", displayName: "A", customName: null, archivedAt: null }]));
    expect(await loadPaseoProjects(env)).toEqual([{ id: "prj_a", name: "A", path: "/repo/a" }]);
    await truncate(file, 9 * 1024 * 1024);
    await expect(loadPaseoProjects(env)).rejects.toThrow(/projects\.json 过大/);
  });
});

describe("CLI human output", () => {
  it("escapes terminal control characters in notes but leaves --json unchanged", async () => {
    const { run, runJson } = await harness();
    const title = "\u001b]52;c;ZXZpbA==\u0007提醒";
    const body = "第一行\r\n\u001b[2J第二行\r覆盖\u009b31m\t缩进";
    const added = await runJson("add", "--title", title, "--body", body);
    const shown = (await run("show", added.itemId)).text;
    expect(shown).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(shown).toContain("\\x1b]52;c;ZXZpbA==\\x07提醒");
    expect(shown).toContain("第一行\n\\x1b[2J第二行\\x0d覆盖\\x9b31m\t缩进");
    const listed = (await run("list")).text;
    expect(listed).toContain("\\x1b]52");
    expect(listed).not.toContain("\u001b");
    const json = await runJson("show", added.itemId);
    expect([json.title, json.body]).toEqual([title, body]);
    expect(terminalSafe("a\tb\nc")).toBe("a\tb\nc");
  });

  it("prints times in UTC and says so", async () => {
    const { run, runJson } = await harness();
    const added = await runJson("add", "--title", "带时间");
    const updatedAt: string = (await runJson("show", added.itemId)).updatedAt;
    expect((await run("show", added.itemId)).text).toContain(`${updatedAt.slice(0, 10)} ${updatedAt.slice(11, 16)} UTC`);
  });

  it("describes the inbox with the same wording as the plugin", async () => {
    const { run } = await harness();
    expect((await run("projects")).text).toContain(`__inbox__\t随手记\t（${INBOX_DESCRIPTION}）`);
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
