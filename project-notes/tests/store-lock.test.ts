import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { BoardStore } from "../server/store";
import { DashboardService, ProjectDirectory } from "../server/dashboard";
import type { NoteFields } from "../shared/board";

const run = promisify(execFile);
const fields: NoteFields = { kind: "idea", title: "锁", body: "", status: "todo", priority: "normal", pinned: false };
const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function temp(prefix: string) { const path = await mkdtemp(join(tmpdir(), prefix)); directories.push(path); return path; }
async function lockFor(root: string, store: BoardStore, projectId: string) {
  await store.write({ projectId, requestId: `seed-${projectId}`, operation: { type: "create", fields } });
  return join(root, (await readdir(root)).find(name => name.endsWith(".json"))! + ".lock");
}
const create = (title: string) => ({ type: "create" as const, fields: { ...fields, title } });
const leftovers = async (root: string) => (await readdir(root)).filter(name => !/^[a-f0-9]{64}\.json$/.test(name));
const ago = async (file: string, ms: number) => { const when = new Date(Date.now() - ms); await utimes(file, when, when); };
/** A process that is running now, and the pid of one that has exited. */
async function runningPid() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child); await once(child, "spawn");
  return { pid: child.pid!, stop: async () => { child.kill("SIGKILL"); await once(child, "exit"); } };
}
async function exitedPid() { const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); await once(child, "exit"); return child.pid!; }
/** The lock record this host writes (0.8.1): pid, owner token, host, PID namespace and Linux start time. */
async function lockRecord(pid: number, extra: Record<string, unknown> = {}) {
  const ns = await readlink("/proc/self/ns/pid").catch(() => null);
  return JSON.stringify({ pid, token: "other-writer-token", host: hostname(), ns, start: null, at: new Date().toISOString(), ...extra }) + "\n";
}

describe("cross-process lock", () => {
  it("waits for a live lock and proceeds once it is released", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root);
    const lock = await lockFor(root, store, "project-a");
    await writeFile(lock, `${process.pid} held\n`);
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
    await writeFile(lock, `${process.pid} held\n`);
    await expect(store.write({ projectId: "project-a", requestId: "blocked-write", operation: { type: "create", fields } })).rejects.toThrow(/正被另一个进程修改/);
    expect((await new BoardStore(root).read("project-a")).items).toHaveLength(1);
  });

  it("never takes a lock from a running holder, however old the lock file is", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root, { waitMs: 300, staleMs: 50 });
    const lock = await lockFor(root, store, "project-a");
    const holder = await runningPid();
    for (const record of [await lockRecord(holder.pid), `${holder.pid} 2026-01-01T00:00:00.000Z\n`]) {
      await writeFile(lock, record); await ago(lock, 10 * 60_000);
      await expect(store.write({ projectId: "project-a", requestId: "while-held-1", operation: create("不该写入") })).rejects.toThrow(/正被另一个进程修改（pid \d+）/);
      expect(await readFile(lock, "utf8")).toBe(record);
    }
    // Once the holder exits, its lock is reclaimed at once.
    await holder.stop();
    expect((await store.write({ projectId: "project-a", requestId: "after-exit-1", operation: create("持有者退出后") })).board.items).toHaveLength(2);
    expect(await leftovers(root)).toEqual([]);
  });

  it("reclaims a lock whose holder has exited without waiting for it to age", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root, { waitMs: 1_500, staleMs: 60_000 });
    const lock = await lockFor(root, store, "project-a");
    const dead = await exitedPid();
    // The 0.8.0 format (`<pid> <time>`) and the current one.
    for (const [index, record] of [`${dead} ${new Date().toISOString()}\n`, await lockRecord(dead)].entries()) {
      await writeFile(lock, record);
      const started = Date.now();
      await store.write({ projectId: "project-a", requestId: `after-crash-${index}`, operation: create(`崩溃之后 ${index}`) });
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    expect((await store.read("project-a")).items).toHaveLength(3);
    expect(await leftovers(root)).toEqual([]);
  });

  it.runIf(process.platform === "linux")("treats a reused pid as an exited holder (Linux start time)", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root, { waitMs: 1_500, staleMs: 60_000 });
    const lock = await lockFor(root, store, "project-a");
    // This process is alive, but it is not the process that wrote this lock: its start time differs.
    await writeFile(lock, await lockRecord(process.pid, { start: "1" }));
    expect((await store.write({ projectId: "project-a", requestId: "reused-pid-1", operation: create("pid 被复用") })).board.items).toHaveLength(2);
  });

  it("reclaims a lock it cannot check only once it is clearly overdue", async () => {
    const root = await temp("project-notes-lock-");
    const store = new BoardStore(root, { waitMs: 200, staleMs: 60_000 });
    const lock = await lockFor(root, store, "project-a");
    const dead = await exitedPid();
    // Unreadable content, or a pid from another host or another PID namespace (a sandboxed CLI): nothing to check, so only the age counts.
    const records = ["\n", "garbage", await lockRecord(dead, { host: "another-host" }), await lockRecord(dead, { ns: "pid:[1]" })];
    for (const [index, record] of records.entries()) {
      await writeFile(lock, record);
      await expect(store.write({ projectId: "project-a", requestId: "young-unknown", operation: create("不该写入") })).rejects.toThrow(/正被另一个进程修改/);
      await ago(lock, 61_000);
      await store.write({ projectId: "project-a", requestId: `old-unknown-${index}`, operation: create(`过期之后 ${index}`) });
    }
    expect((await store.read("project-a")).items).toHaveLength(5);
    expect(await leftovers(root)).toEqual([]);
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

  it("lets CLI processes and plugin writes that all find a crashed writer's lock land every write", async () => {
    const home = await temp("project-notes-cli-home-");
    const env = { ...process.env, PASEO_HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const boards = join(home, "plugin-data", "project-notes", "boards");
    const store = new BoardStore(boards);
    await store.write({ projectId: "__inbox__", requestId: "seed-inbox-1", operation: create("种子") });
    const lock = join(boards, (await readdir(boards)).find(name => name.endsWith(".json"))! + ".lock");
    // Left by a writer that crashed two minutes ago: every writer below starts by finding it.
    await writeFile(lock, `${await exitedPid()} ${new Date().toISOString()}\n`); await ago(lock, 120_000);
    const cliWrites = Array.from({ length: 6 }, (_, index) => run(process.execPath, [cli, "add", "--project", "inbox", "--title", `命令行 ${index}`, "--json"], { env }));
    const pluginWrites = Array.from({ length: 4 }, (_, index) => store.write({ projectId: "__inbox__", requestId: `plugin-crash-${index}`, operation: create(`插件 ${index}`) }));
    await Promise.all([...cliWrites, ...pluginWrites]);
    const board = await store.read("__inbox__");
    expect(board.items).toHaveLength(11);
    expect(board.revision).toBe(11);
    expect(await leftovers(boards)).toEqual([]);
  }, 30_000);
});
