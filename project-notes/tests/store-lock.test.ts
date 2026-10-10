import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { BoardStore } from "../server/store";
import { DashboardService, ProjectDirectory } from "../server/dashboard";
import type { NoteFields } from "../shared/board";

const run = promisify(execFile);
const fields: NoteFields = { kind: "idea", title: "锁", body: "", status: "todo", priority: "normal", pinned: false };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temp(prefix: string) { const path = await mkdtemp(join(tmpdir(), prefix)); directories.push(path); return path; }
async function lockFor(root: string, store: BoardStore, projectId: string) {
  await store.write({ projectId, requestId: `seed-${projectId}`, operation: { type: "create", fields } });
  return join(root, (await readdir(root)).find(name => name.endsWith(".json"))! + ".lock");
}

describe("cross-process lock", () => {
  it("waits for a live lock and proceeds once it is released", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root);
    const lock = await lockFor(root, store, "project-a");
    await writeFile(lock, "12345 held\n");
    let settled = false;
    const write = store.write({ projectId: "project-a", requestId: "after-release", operation: { type: "create", fields } }).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await rm(lock);
    expect((await write).board.items).toHaveLength(2);
  });

  it("gives up with a clear message when another writer holds the lock too long", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root, { waitMs: 120, staleMs: 60_000 });
    const lock = await lockFor(root, store, "project-a");
    await writeFile(lock, "12345 held\n");
    await expect(store.write({ projectId: "project-a", requestId: "blocked-write", operation: { type: "create", fields } })).rejects.toThrow(/正被另一个进程修改/);
    expect((await new BoardStore(root).read("project-a")).items).toHaveLength(1);
  });
});

describe("bin/notes.mjs processes and the plugin store", () => {
  let cli = "", bin = "";
  beforeAll(async () => {
    const out = await mkdtemp(join(tmpdir(), "project-notes-cli-build-"));
    cli = join(out, "notes.mjs"); bin = join(out, "bin");
    await build({ entryPoints: [join(__dirname, "..", "server", "cli.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: cli, banner: { js: "#!/usr/bin/env node" }, logLevel: "silent" });
    // A stand-in `paseo` so the CLI never reaches a real daemon.
    await mkdir(bin);
    await writeFile(join(bin, "paseo"), "#!/bin/sh\necho '[{\"projectId\":\"prj_cli\",\"name\":\"CLI 项目\",\"path\":\"/nonexistent/cli\"}]'\n");
    await chmod(join(bin, "paseo"), 0o755);
  });
  afterAll(async () => { if (cli) await rm(join(cli, ".."), { recursive: true, force: true }); });

  it("serializes concurrent CLI processes and in-process writes, and the dashboard sees every CLI write", async () => {
    const home = await temp("project-notes-cli-home-");
    const env = { ...process.env, PASEO_HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const store = new BoardStore(join(home, "plugin-data", "project-notes", "boards"));
    const projects = { projects: { list: async () => ({ projects: [] }), subscribe: () => () => {} } };
    const dashboard = new DashboardService(store, new ProjectDirectory());
    const first = await dashboard.read(projects as never);
    const cliWrites = Array.from({ length: 5 }, (_, index) => run(process.execPath, [cli, "add", "--project", "inbox", "--kind", "idea", "--title", `命令行 ${index}`, "--json"], { env }));
    const pluginWrites = Array.from({ length: 5 }, (_, index) => store.write({ projectId: "__inbox__", requestId: `plugin-${index}`, operation: { type: "create", fields: { ...fields, title: `插件 ${index}` } } }));
    const results = await Promise.all([...cliWrites, ...pluginWrites]);
    expect(results.slice(0, 5).map(result => JSON.parse((result as { stdout: string }).stdout).projectId)).toEqual(Array(5).fill("__inbox__"));
    const board = await store.read("__inbox__");
    expect(board.items).toHaveLength(10);
    expect(board.revision).toBe(10);
    expect(new Set(board.items.map(item => item.title)).size).toBe(10);
    const boardsDir = join(home, "plugin-data", "project-notes", "boards");
    expect((await readdir(boardsDir)).filter(name => name.endsWith(".lock") || name.endsWith(".tmp"))).toEqual([]);
    const next = await dashboard.read(projects as never, first.revision);
    expect(next.unchanged).toBeFalsy();
    expect(next.revision).not.toBe(first.revision);
    // One more CLI write after the plugin has cached the board.
    await run(process.execPath, [cli, "add", "--project", "inbox", "--title", "最后一条", "--json"], { env });
    const last = await dashboard.read(projects as never, next.revision);
    expect(last.unchanged).toBeFalsy();
    if (last.unchanged) return;
    expect(last.boards.map(b => b.items.length)).toEqual([11]);
    const { stdout } = await run(process.execPath, [cli, "list", "--project", "inbox", "--json"], { env });
    expect(JSON.parse(stdout).total).toBe(11);
  }, 30_000);
});
