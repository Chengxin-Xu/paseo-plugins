import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, open, readFile, readdir, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../server/store";
import type { NoteFields } from "../shared/board";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const fields: NoteFields = { kind: "task", title: "缓存", body: "正文", status: "todo", priority: "normal", pinned: false };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-notes-cache-")); directories.push(root);
  return { root, store: new BoardStore(root) };
}
async function boardFile(root: string) { return join(root, (await readdir(root)).find(name => name.endsWith(".json"))!); }

describe("BoardStore read cache", () => {
  it("reuses parsed boards while their files are unchanged", async () => {
    const { store } = await fixture();
    await store.write({ projectId: "project-a", requestId: "cache-create-1", operation: { type: "create", fields } });
    await store.write({ projectId: "project-b", requestId: "cache-create-2", operation: { type: "create", fields } });
    const first = (await store.readEntries()).entries;
    const second = (await store.readEntries()).entries;
    expect(second.map(entry => entry.snapshot.projectId)).toEqual(["project-a", "project-b"]);
    // Same objects: nothing was re-read or re-validated.
    expect(second[0]!.snapshot).toBe(first[0]!.snapshot);
    expect(second[1]!.snapshot).toBe(first[1]!.snapshot);
    expect(await store.read("project-a")).toBe(first[0]!.snapshot);
  });

  it("sees writes from its own process, another store instance (the CLI) and manual edits", async () => {
    const { root, store } = await fixture();
    const created = await store.write({ projectId: "project-a", requestId: "cache-own-1", operation: { type: "create", fields } });
    const before = (await store.readEntries()).entries;
    // Another process writes through its own store and the lock file.
    await new BoardStore(root).write({ projectId: "project-a", requestId: "cache-other-1", operation: { type: "update", id: created.itemId, expectedRevision: 1, fields: { status: "doing" } } });
    const afterOther = (await store.readEntries()).entries;
    expect(afterOther[0]!.token).not.toBe(before[0]!.token);
    expect(afterOther[0]!.snapshot.items[0]!.status).toBe("doing");
    // Own writes drop the cached copy immediately.
    await store.write({ projectId: "project-a", requestId: "cache-own-2", operation: { type: "update", id: created.itemId, expectedRevision: 2, fields: { status: "done" } } });
    expect((await store.read("project-a")).items[0]!.status).toBe("done");
  });

  it("detects an in-place edit that keeps the size and restores the modification time", async () => {
    const { root, store } = await fixture();
    await store.write({ projectId: "project-a", requestId: "cache-inplace-1", operation: { type: "create", fields: { ...fields, title: "AAAA" } } });
    const file = await boardFile(root);
    // Whole seconds survive utimes exactly, so only ctime can reveal the edit below.
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const before = (await store.readEntries()).entries;
    // ctime comes from the kernel's coarse clock: let it tick, or an edit within the same tick keeps the same ctime.
    await new Promise(resolve => setTimeout(resolve, 25));
    const original = await stat(file, { bigint: true });
    const text = await readFile(file, "utf8");
    const handle = await open(file, "r+");
    try { await handle.write(text.replace("\"AAAA\"", "\"BBBB\""), 0, "utf8"); } finally { await handle.close(); }
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const edited = await stat(file, { bigint: true });
    expect([edited.ino, edited.size, edited.mtimeNs]).toEqual([original.ino, original.size, original.mtimeNs]);
    const after = (await store.readEntries()).entries;
    expect(after[0]!.token).not.toBe(before[0]!.token);
    expect(after[0]!.snapshot.items[0]!.title).toBe("BBBB");
  });

  it("never caches a failed read: a repaired file is served again", async () => {
    const { root, store } = await fixture();
    await store.write({ projectId: "project-a", requestId: "cache-corrupt-1", operation: { type: "create", fields } });
    const file = await boardFile(root);
    const good = await readFile(file, "utf8");
    await writeFile(file, "{ broken");
    await expect(store.readAll()).rejects.toThrow(/不会把读取失败当作空看板/);
    await expect(store.read("project-a")).rejects.toThrow(/保留原文件/);
    expect(await readFile(file, "utf8")).toBe("{ broken");
    await writeFile(file, good);
    expect((await store.readAll())[0]!.items).toHaveLength(1);
  });

  it("rejects boards whose content belongs to a different project file", async () => {
    const { root, store } = await fixture();
    await store.write({ projectId: "project-a", requestId: "cache-mismatch-1", operation: { type: "create", fields } });
    const file = await boardFile(root);
    await writeFile(join(root, "0".repeat(64) + ".json"), await readFile(file, "utf8"));
    await expect(store.readAll()).rejects.toThrow(/校验失败/);
  });

  it("leaves a board over the per-board limit out of the overview, unread, and keeps the others", async () => {
    const { root, store } = await fixture();
    await store.write({ projectId: "project-a", requestId: "cache-size-1", operation: { type: "create", fields } });
    await store.write({ projectId: "project-b", requestId: "cache-size-2", operation: { type: "create", fields } });
    const file = store.boardFile("project-a");
    await truncate(join(root, file), 33 * 1024 * 1024); // sparse: the limit is checked from stat, before reading
    const overview = await store.readEntries();
    expect(overview.entries.map(entry => entry.snapshot.projectId)).toEqual(["project-b"]);
    expect(overview.unavailable).toEqual([{ file, projectId: "project-a", bytes: 33 * 1024 * 1024, reason: "file" }]);
    expect((await store.readAll()).map(board => board.projectId)).toEqual(["project-b"]);
    // A process that never read that board cannot tell whose it is.
    expect((await new BoardStore(root).readEntries()).unavailable).toEqual([{ file, projectId: null, bytes: 33 * 1024 * 1024, reason: "file" }]);
    // On its own the board still refuses reads and writes, as before.
    await expect(store.read("project-a")).rejects.toThrow(/记录文件过大/);
    await expect(store.write({ projectId: "project-a", requestId: "cache-size-3", operation: { type: "create", fields } })).rejects.toThrow(/记录文件过大/);
  });

  it("fills the overview budget smallest board first and leaves out what does not fit", async () => {
    const { root } = await fixture();
    const writer = new BoardStore(root), bytes: Record<string, number> = {};
    for (const [projectId, length] of [["project-small", 100], ["project-medium", 3_000], ["project-large", 9_000]] as const) {
      await writer.write({ projectId, requestId: `cache-total-${projectId}`, operation: { type: "create", fields: { ...fields, body: "正".repeat(length) } } });
      bytes[projectId] = (await stat(join(root, writer.boardFile(projectId)))).size;
    }
    const store = new BoardStore(root, { maxTotalBytes: bytes["project-small"]! + bytes["project-large"]! + 10 });
    const overview = await store.readEntries();
    expect(overview.entries.map(entry => entry.snapshot.projectId)).toEqual(["project-medium", "project-small"]);
    expect(overview.unavailable).toEqual([{ file: store.boardFile("project-large"), projectId: null, bytes: bytes["project-large"], reason: "total" }]);
    // Only the overview is limited: the board itself still reads and writes, and then the store knows whose it is.
    expect((await store.read("project-large")).items).toHaveLength(1);
    expect((await store.readEntries()).unavailable[0]!.projectId).toBe("project-large");
    // With room again, it is back.
    await rm(join(root, store.boardFile("project-medium")));
    expect((await store.readEntries()).entries.map(entry => entry.snapshot.projectId)).toEqual(["project-large", "project-small"]);
  });

  it("drops boards whose files disappear and ignores foreign files", async () => {
    const { root, store } = await fixture();
    await store.write({ projectId: "project-a", requestId: "cache-gone-1", operation: { type: "create", fields } });
    await writeFile(join(root, "notes.txt"), "not a board");
    await writeFile(join(root, "abc.json"), "{}");
    expect(await store.readAll()).toHaveLength(1);
    await rm(await boardFile(root));
    expect(await store.readAll()).toEqual([]);
    expect(await store.read("project-a")).toEqual({ projectId: "project-a", revision: 0, items: [] });
    await rm(root, { recursive: true });
    expect(await store.readAll()).toEqual([]);
  });

  it("reads many boards consistently while writes run", async () => {
    const { store } = await fixture();
    const writes = Array.from({ length: 24 }, (_, index) => store.write({ projectId: `project-${index % 12}`, requestId: `cache-many-${index}`, operation: { type: "create", fields: { ...fields, title: `第 ${index} 条` } } }));
    const reads = Array.from({ length: 6 }, () => store.readAll());
    await Promise.all([...writes, ...reads]);
    const boards = await store.readAll();
    expect(boards).toHaveLength(12);
    expect(boards.every(board => board.revision === 2 && board.items.length === 2)).toBe(true);
    expect(boards.map(board => board.projectId)).toEqual([...boards.map(board => board.projectId)].sort());
  });
});
