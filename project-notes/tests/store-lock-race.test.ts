import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NoteFields } from "../shared/board";

// Deterministic interleavings of two writers. The store's own file calls are intercepted at the moments where another
// process could step in, and the test runs the other writer right there.
const hook = vi.hoisted(() => ({
  /** Runs once, when a writer that judged a lock stale is about to remove it (the old code unlinked it directly, the
   * current code first takes the reclaim guard). */
  reclaim: null as null | (() => Promise<void>),
  /** Runs once, when a writer inside its critical section opens the temporary file of the board it is committing. */
  commit: null as null | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  const fire = async (key: keyof typeof hook) => { const run = hook[key]; hook[key] = null; await run?.(); };
  const open = async (...args: Parameters<typeof actual.open>) => {
    const file = String(args[0]);
    if (file.endsWith(".lock.reclaim")) await fire("reclaim");
    else if (file.endsWith(".tmp")) await fire("commit");
    return actual.open(...args);
  };
  const unlink = async (...args: Parameters<typeof actual.unlink>) => {
    if (String(args[0]).endsWith(".lock")) await fire("reclaim");
    return actual.unlink(...args);
  };
  return { ...actual, open, unlink, default: { ...actual, open, unlink } };
});
const { mkdtemp, readFile, readdir, rm, utimes, writeFile } = await import("node:fs/promises");
const { BoardStore } = await import("../server/store");

const fields: NoteFields = { kind: "task", title: "", body: "", status: "todo", priority: "normal", pinned: false };
const create = (title: string) => ({ type: "create" as const, fields: { ...fields, title } });
const directories: string[] = [];
afterEach(async () => { hook.reclaim = hook.commit = null; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function seeded() {
  const root = await mkdtemp(join(tmpdir(), "project-notes-race-")); directories.push(root);
  await new BoardStore(root).write({ projectId: "project-a", requestId: "race-seed-1", operation: create("种子") });
  return { root, lock: join(root, (await readdir(root)).find(name => name.endsWith(".json"))! + ".lock") };
}
const titles = async (root: string) => (await new BoardStore(root).read("project-a")).items.map(item => item.title).sort();
const leftovers = async (root: string) => (await readdir(root)).filter(name => !/^[a-f0-9]{64}\.json$/.test(name));

describe("lock interleavings", () => {
  it("lets only one of two writers that found the same dead holder's lock take it over", async () => {
    const { root, lock } = await seeded();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); await once(child, "exit");
    // A crashed writer's lock, old enough that the 0.8.0 rule (age only) treats it as stale too.
    await writeFile(lock, `${child.pid} 2026-01-01T00:00:00.000Z\n`);
    const old = new Date(Date.now() - 120_000); await utimes(lock, old, old);
    const a = new BoardStore(root), b = new BoardStore(root);
    let writeA: Promise<unknown> = Promise.resolve(), holding!: () => void, release!: () => void;
    const aHolds = new Promise<void>(resolve => { holding = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    hook.reclaim = async () => {
      // B has judged the dead holder's lock stale. Before it removes anything, A takes the lock over and pauses mid-write.
      hook.commit = async () => { holding(); await gate; };
      writeA = a.write({ projectId: "project-a", requestId: "race-writer-a", operation: create("A") });
      await aHolds;
    };
    const writeB = b.write({ projectId: "project-a", requestId: "race-writer-b", operation: create("B") });
    // A finishes once B has (the 0.8.0 code let B in beside A), or after 300 ms while B correctly waits for A.
    await Promise.race([writeB.catch(() => {}), new Promise(resolve => setTimeout(resolve, 300))]);
    release();
    await Promise.all([writeA, writeB]);
    expect(await titles(root)).toEqual(["A", "B", "种子"]);
    expect(await leftovers(root)).toEqual([]);
  });

  it("refuses to commit, and leaves the lock alone, when its lock was taken over mid-write", async () => {
    const { root, lock } = await seeded();
    const foreign = JSON.stringify({ pid: process.pid, token: "another-writer", host: "elsewhere", ns: null, start: null, at: new Date().toISOString() }) + "\n";
    // Whatever took it over (a reclaimer that misjudged this writer, a manual delete), the lock is someone else's now.
    hook.commit = async () => { await writeFile(lock, foreign); };
    await expect(new BoardStore(root).write({ projectId: "project-a", requestId: "race-takeover-1", operation: create("不该保存") })).rejects.toThrow(/锁被其他进程接管/);
    expect(await titles(root)).toEqual(["种子"]);
    expect(await readFile(lock, "utf8")).toBe(foreign);
  });
});
