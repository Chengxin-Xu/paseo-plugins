import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { loadPaseoWorkspaces, resolveProject } from "../server/cli";
import { BoardStore, defaultStorageRoot } from "../server/store";

const directories: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), "project-notes-workspaces-")); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
let bundleRoot = "", bundle = "";
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "project-notes-cli-bundle-")); bundle = join(bundleRoot, "notes.mjs");
  await build({ entryPoints: [resolve("server/cli.ts")], outfile: bundle, bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });

async function fixture() {
  const root = await temp(), home = join(root, "paseo"), checkout = join(root, "repository"), worktree = join(home, "worktrees", "project", "topic");
  await Promise.all([mkdir(join(home, "projects"), { recursive: true }), mkdir(checkout), mkdir(join(worktree, "packages", "app"), { recursive: true })]);
  const projects = [{ projectId: "prj_first", rootPath: checkout, displayName: "同名项目", archivedAt: null }, { projectId: "prj_other", rootPath: home, displayName: "同名项目", archivedAt: null }];
  await writeFile(join(home, "projects", "projects.json"), JSON.stringify(projects));
  const workspace = { workspaceId: "wks_example", projectId: "prj_first", cwd: worktree, kind: "worktree", archivedAt: null };
  await writeFile(join(home, "projects", "workspaces.json"), JSON.stringify([workspace]));
  await mkdir(join(home, "plugin-data/project-notes"), { recursive: true });
  await writeFile(join(home, "plugin-data/project-notes/i18n-state.json"), JSON.stringify({ setting: "zh-CN", device: "zh-CN" }));
  // No CLI on PATH: both registries come only from this fixture, never from a running daemon.
  const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: home, PATH: join(root, "no-bin") };
  delete env.PASEO_AGENT_ID; delete env.PASEO_AGENT_CWD;
  const run = async (args: string[], cwd = worktree, extraEnv = {}) => JSON.parse((await promisify(execFile)(process.execPath, [bundle, ...args, "--json"], { cwd, env: { ...env, ...extraEnv }, timeout: 10_000 })).stdout);
  return { root, home, checkout, worktree, workspace, env, run };
}

describe("Paseo workspace project ownership", () => {
  it("uses the nearest workspace project ID before project directory prefixes", () => {
    const projects = [{ id: "prj_a", name: "重复", path: "/repo/a" }, { id: "prj_b", name: "重复", path: "/worktrees" }];
    const workspaces = [{ projectId: "prj_a", cwd: "/worktrees/topic" }, { projectId: "prj_b", cwd: "/worktrees/topic/nested" }];
    expect(resolveProject(undefined, projects, "/worktrees/topic/src", workspaces).id).toBe("prj_a");
    expect(resolveProject(undefined, projects, "/worktrees/topic/nested/src", workspaces).id).toBe("prj_b");
    expect(resolveProject("/worktrees/topic/src", projects, "/", workspaces).id).toBe("prj_a");
    expect(resolveProject(undefined, projects, "/worktrees/topic-other", workspaces).id).toBe("prj_b");
    expect(() => resolveProject(undefined, projects, "/worktrees/topic", [{ projectId: "missing", cwd: "/worktrees/topic" }])).toThrow(/所属项目已不可用/);
    expect(() => resolveProject(undefined, projects, "/worktrees/topic", [...workspaces, { projectId: "prj_b", cwd: "/worktrees/topic" }])).toThrow(/多个工作区项目/);
  });

  it("reads active persisted records and rejects damaged or oversized registries", async () => {
    const { home, env, workspace, worktree, run } = await fixture();
    const file = join(home, "projects", "workspaces.json");
    await writeFile(file, JSON.stringify([workspace, { ...workspace, workspaceId: "old", archivedAt: "2026-01-01T00:00:00Z" }]));
    expect(await loadPaseoWorkspaces(env)).toEqual([{ projectId: "prj_first", cwd: worktree }]);
    await writeFile(file, "{}");
    await expect(loadPaseoWorkspaces(env)).rejects.toThrow(/无法读取 Paseo 工作区归属[\s\S]*--project/);
    expect((await run(["add", "--project", "prj_first", "--title", "显式指定归属"])).projectId).toBe("prj_first");
    await truncate(file, 9 * 1024 * 1024);
    await expect(loadPaseoWorkspaces(env)).rejects.toThrow(/workspaces\.json 过大/);
    await rm(file);
    expect(await loadPaseoWorkspaces(env)).toEqual([]);
  });

  it("assigns a real CLI in a nested external worktree and accepts symlinked paths", async () => {
    const { root, env, home, worktree, workspace, run } = await fixture();
    const nested = join(worktree, "packages", "app");
    expect((await run(["add", "--title", "外置工作区"], nested)).projectId).toBe("prj_first");
    const alias = join(root, "alias"); await symlink(worktree, alias, "dir");
    expect((await run(["add", "--title", "符号链接"], root, { PASEO_AGENT_CWD: join(alias, "packages", "app") })).projectId).toBe("prj_first");
    // The persisted cwd can itself use an alias; realpath joins it to the shell's physical cwd.
    await writeFile(join(home, "projects", "workspaces.json"), JSON.stringify([{ ...workspace, cwd: alias }]));
    expect((await run(["add", "--title", "记录路径是链接"], nested)).projectId).toBe("prj_first");
    expect((await run(["list", "--project", nested])).total).toBe(3);
    expect((await new BoardStore(defaultStorageRoot(env)).read("prj_first")).items).toHaveLength(3);
    expect((await new BoardStore(defaultStorageRoot(env)).read("prj_other")).items).toHaveLength(0);
  });

  it("canonicalizes a symlinked project root when no workspace record matches", async () => {
    const { root, home, checkout, run } = await fixture();
    const alias = join(root, "repository-alias"); await symlink(checkout, alias, "dir");
    await writeFile(join(home, "projects", "projects.json"), JSON.stringify([{ projectId: "prj_first", rootPath: alias, displayName: "项目", archivedAt: null }]));
    expect((await run(["add", "--title", "普通项目"], checkout)).projectId).toBe("prj_first");
  });
});

describe("CLI request ID replay across processes", () => {
  it("replays update, done, delete and restore despite a newer item revision", async () => {
    const { run } = await fixture();
    const created = await run(["add", "--title", "任务"]);
    const commands = [["update", created.itemId, "--title", "新标题"], ["done", created.itemId], ["delete", created.itemId], ["restore", created.itemId]];
    for (const [index, command] of commands.entries()) {
      const args = [...command, "--request-id", `repeat-command-${index}`];
      const first = await run(args), second = await run(args);
      expect(first.replayed).toBe(false);
      expect(second).toEqual({ ...first, replayed: true });
      expect(second.revision).toBe(index + 2);
    }
    await expect(run(["update", created.itemId, "--title", "不同内容", "--request-id", "repeat-command-0"])).rejects.toThrow(/请求标识已用于另一项修改/);
    expect((await run(["show", created.itemId])).revision).toBe(5);
  });

  it("keeps only the latest 300 receipts and treats an expired request as new", async () => {
    const { run, env } = await fixture();
    const created = await run(["add", "--title", "回执窗口"]);
    await run(["done", created.itemId, "--request-id", "old-done-request"]);
    const store = new BoardStore(defaultStorageRoot(env));
    for (let index = 0; index < 300; index++) await store.write({ projectId: created.projectId, requestId: `window-update-${index}`, operation: { type: "update", id: created.itemId, expectedRevision: index + 2, fields: { body: String(index) } } });
    const doc = JSON.parse(await readFile(join(defaultStorageRoot(env), store.boardFile(created.projectId)), "utf8"));
    expect(doc.receipts).toHaveLength(300);
    expect(doc.receipts.some((receipt: { requestId: string }) => receipt.requestId === "old-done-request")).toBe(false);
    expect(await run(["done", created.itemId, "--request-id", "old-done-request"])).toMatchObject({ replayed: false, revision: 303 });
  }, 30_000); // 300 durable writes plus three CLI processes: about 3.5 s alone, more under a parallel full check.
});
