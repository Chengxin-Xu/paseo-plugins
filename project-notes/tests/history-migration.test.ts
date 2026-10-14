import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type NoteFields, type NoteVersion } from "../shared/schema";

const io = vi.hoisted(() => ({ failMain: false, failCleanup: false, renameFailureAt: 0, renameCount: 0, directoryError: null as { at: "open" | "sync"; code: string } | null, fileSyncError: false, events: [] as string[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (io.directoryError?.at === "open" && args[1] === "r" && await actual.stat(args[0]).then(info => info.isDirectory(), () => false)) {
        throw Object.assign(new Error("directory open unsupported"), { code: io.directoryError.code });
      }
      const handle = await actual.open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => {
        io.events.push(`sync:${String(args[0])}`);
        const directory = (await handle.stat()).isDirectory();
        if (directory && io.directoryError?.at === "sync") throw Object.assign(new Error("directory sync unsupported"), { code: io.directoryError.code });
        if (!directory && io.fileSyncError) throw Object.assign(new Error("file sync failed"), { code: "EACCES" });
        await sync();
      };
      return handle;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (io.failCleanup && String(args[0]).includes("/history/") && String(args[0]).endsWith(".json")) {
        io.failCleanup = false; throw new Error("simulated interruption during committed cleanup");
      }
      return actual.unlink(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const target = String(args[1]); io.events.push(`rename:${target}`);
      if (io.renameFailureAt && ++io.renameCount === io.renameFailureAt) { io.renameFailureAt = 0; throw new Error("simulated transaction interruption"); }
      if (io.failMain && !target.includes("/history/")) { io.failMain = false; throw new Error("simulated interruption before main commit"); }
      return actual.rename(...args);
    },
  };
});
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = await import("node:fs/promises");
const { BoardStore } = await import("../server/store");
const roots: string[] = [];
afterEach(async () => { io.failMain = io.failCleanup = io.fileSyncError = false; io.renameFailureAt = io.renameCount = 0; io.directoryError = null; io.events.length = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fields: NoteFields = { kind: "task", title: "现有手记", body: "现有正文", status: "todo", priority: "normal", pinned: false };
const projectId = "migration-project", now = "2026-10-01T00:00:00.000Z";
async function fixture(count = 2) {
  const root = await mkdtemp(join(tmpdir(), "notes-history-migration-")); roots.push(root);
  const store = new BoardStore(root), file = join(root, store.boardFile(projectId));
  const items = Array.from({ length: count }, (_, index) => ({ ...fields, id: randomUUID(), projectId, revision: 11,
    createdAt: now, updatedAt: now, deletedAt: index ? now : null,
    history: Array.from({ length: 10 }, (_, version) => ({ ...fields, title: `手记 ${index} 第 ${version + 1} 版`, body: `完整正文 ${index} / ${version} \n` + "历".repeat(1000), revision: version + 1, updatedAt: now, deletedAt: null })),
  }));
  const original = JSON.stringify({ version: 1, projectId, revision: 22, items, receipts: [{ requestId: "retained-receipt", hash: "original-hash", itemId: items[0]!.id }] }, null, 2) + "\n";
  await writeFile(file, original);
  return { root, store, file, items, original, historyFile: (id: string) => join(root, "history", `${basename(file, ".json")}.${id}.json`) };
}

describe("durable history migration", () => {
  it("moves every legacy version before the main rename, preserves receipts, and resumes idempotently under concurrent readers", async () => {
    const { root, store, file, items, historyFile } = await fixture();
    const [a, b] = await Promise.all([store.read(projectId), new BoardStore(root).read(projectId)]);
    expect(a).toEqual(b);
    expect(a.items.every(item => !("history" in item) && !("historyKeys" in item) && item.historyCount === 10)).toBe(true);
    for (const item of items) {
      expect((await store.readHistory(projectId, item.id)).versions).toEqual(item.history);
      const sidecar = JSON.parse(await readFile(historyFile(item.id), "utf8"));
      expect(sidecar.versions).toEqual(item.history); expect(sidecar.protectedKeys).toHaveLength(10);
      expect((await stat(historyFile(item.id))).mode & 0o777).toBe(0o600);
      expect(io.events.indexOf(`rename:${historyFile(item.id)}`)).toBeLessThan(io.events.indexOf(`rename:${file}`));
    }
    expect(io.events.indexOf(`sync:${join(root, "history")}`)).toBeLessThan(io.events.indexOf(`rename:${file}`));
    const disk = JSON.parse(await readFile(file, "utf8"));
    expect(disk.items.every((item: Record<string, unknown>) => !("history" in item))).toBe(true);
    expect(disk.receipts).toEqual([{ requestId: "retained-receipt", hash: "original-hash", itemId: items[0]!.id }]);
    const before = await readFile(file, "utf8");
    await new BoardStore(root).readAll(); expect(await readFile(file, "utf8")).toBe(before);
  });

  it("keeps the original board intact if interrupted after sidecars persist and migrates again without duplicates", async () => {
    const { root, store, file, items, original, historyFile } = await fixture();
    io.failMain = true;
    await expect(store.read(projectId)).rejects.toThrow(/simulated interruption/);
    expect(await readFile(file, "utf8")).toBe(original);
    for (const item of items) expect(JSON.parse(await readFile(historyFile(item.id), "utf8")).versions).toEqual(item.history);
    const restarted = new BoardStore(root);
    await restarted.readAll();
    for (const item of items) {
      expect((await restarted.readHistory(projectId, item.id)).versions).toEqual(item.history);
      expect(JSON.parse(await readFile(historyFile(item.id), "utf8")).versions).toHaveLength(10);
    }
    expect((await readdir(root)).some(name => name.endsWith(".lock") || name.endsWith(".tmp"))).toBe(false);
  });

  it("preserves legacy history when a sidecar is invalid rather than treating it as empty", async () => {
    const { store, root, file, original, items, historyFile } = await fixture();
    await mkdir(join(root, "history")); await writeFile(historyFile(items[0]!.id), "broken history");
    await expect(store.read(projectId)).rejects.toThrow(/修改快照文件校验失败/);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readFile(historyFile(items[0]!.id), "utf8")).toBe("broken history");
  });

  it.each(["missing", "partial"] as const)("reports %s committed history instead of silently replacing it", async mode => {
    const { store, items, file, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId); const migrated = await readFile(file, "utf8");
    if (mode === "missing") await rm(historyFile(id));
    else {
      const sidecar = JSON.parse(await readFile(historyFile(id), "utf8")); sidecar.versions.pop();
      await writeFile(historyFile(id), JSON.stringify(sidecar));
    }
    const readable = await store.readHistory(projectId, id);
    expect(readable).toMatchObject({ missing: true, missingCount: mode === "missing" ? 10 : 1, itemRevision: 11 });
    expect(readable.versions).toHaveLength(mode === "missing" ? 0 : 9);
    await expect(store.write({ projectId, requestId: "missing-history-edit", operation: { type: "update", id, expectedRevision: 11, fields: { body: "新正文" } } })).rejects.toThrow(/修改快照文件缺失/);
    expect(await readFile(file, "utf8")).toBe(migrated);
  });

  it.each(["missing", "partial"] as const)("repairs %s history only after an explicit version-checked request and preserves every available body", async mode => {
    const { store, items, file, historyFile } = await fixture(1), id = items[0]!.id;
    const before = (await store.read(projectId)).items[0]!;
    let saved = JSON.parse(await readFile(historyFile(id), "utf8"));
    if (mode === "missing") { await rm(historyFile(id)); saved.versions = []; }
    else { saved.versions.pop(); await writeFile(historyFile(id), JSON.stringify(saved)); }
    const status = await store.readHistory(projectId, id);
    expect(status.missing).toBe(true);
    await expect(store.write({ projectId, requestId: "stale-explicit-repair", operation: { type: "repairHistory", id, expectedRevision: 10 } })).rejects.toThrow(/另一台设备/);
    const request = { projectId, requestId: "confirmed-repair", operation: { type: "repairHistory" as const, id, expectedRevision: status.itemRevision } };
    const result = await store.write(request), repaired = result.board.items[0]!;
    expect(repaired).toMatchObject({ ...before, revision: before.revision + 1, updatedAt: expect.any(String), historyCount: saved.versions.length });
    expect((await store.readHistory(projectId, id))).toMatchObject({ missing: false, missingCount: 0, itemRevision: 12, versions: saved.versions });
    expect(JSON.parse(await readFile(historyFile(id), "utf8")).versions).toEqual(saved.versions);
    expect(JSON.parse(await readFile(file, "utf8")).pendingHistory).toBeUndefined();
    expect((await store.write(request)).replayed).toBe(true);
    const edited = await store.write({ projectId, requestId: "edit-after-repair", operation: { type: "update", id, expectedRevision: 12, fields: { body: "恢复编辑能力" } } });
    expect(edited.board.items[0]!.body).toBe("恢复编辑能力");
    expect((await store.readHistory(projectId, id)).versions.at(-1)).toMatchObject({ body: before.body, revision: 12 });
  });

  it("can repair a trashed note, preserves unrelated existing versions, and refuses malformed sidecars", async () => {
    const { store, items, historyFile } = await fixture(2), id = items[1]!.id;
    await store.read(projectId);
    const saved = JSON.parse(await readFile(historyFile(id), "utf8"));
    saved.versions.pop(); saved.versions.push({ ...items[1]!.history[0], body: "同一旁路的其他已有正文", revision: 99 });
    await writeFile(historyFile(id), JSON.stringify(saved));
    const result = await store.write({ projectId, requestId: "repair-trash-history", operation: { type: "repairHistory", id, expectedRevision: 11 } });
    expect(result.board.items.find(item => item.id === id)).toMatchObject({ deletedAt: now, body: fields.body, revision: 12, historyCount: 9 });
    expect(JSON.parse(await readFile(historyFile(id), "utf8")).versions).toEqual(saved.versions);
    await writeFile(historyFile(id), "broken history");
    await expect(store.write({ projectId, requestId: "do-not-guess-repair", operation: { type: "repairHistory", id, expectedRevision: 12 } })).rejects.toThrow(/文件校验失败/);
    expect(await readFile(historyFile(id), "utf8")).toBe("broken history");
  });

  it.each([1, 2, 3, 4])("recovers an interrupted content transaction at rename %i without promoting an uncommitted candidate", async failureAt => {
    const { root, store, file, items, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId); io.renameCount = 0; io.renameFailureAt = failureAt;
    await expect(store.write({ projectId, requestId: "interrupted-two-phase-edit", operation: { type: "update", id, expectedRevision: 11, fields: { body: "已提交的新正文" } } })).rejects.toThrow(/transaction interruption/);
    io.renameFailureAt = 0;
    const restarted = new BoardStore(root), board = await restarted.read(projectId), history = await restarted.readHistory(projectId, id);
    if (failureAt <= 2) {
      expect(board.items[0]!.body).toBe(fields.body); expect(history.versions).toEqual(items[0]!.history);
    } else {
      expect(board.items[0]!.body).toBe("已提交的新正文");
      expect(history.versions.map(version => version.revision)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }
    const doc = JSON.parse(await readFile(file, "utf8")), sidecar = JSON.parse(await readFile(historyFile(id), "utf8"));
    expect(doc.pendingHistory).toBeUndefined(); expect(sidecar.committedKeys).toEqual(doc.items[0].historyKeys);
    // The sidecar acknowledgement is independently useful after recovery, even if a later main-file copy loses keys.
    delete doc.items[0].historyKeys; delete doc.items[0].historyCount;
    await writeFile(file, JSON.stringify(doc));
    const recoveredAgain = new BoardStore(root);
    expect((await recoveredAgain.read(projectId)).items[0]!.historyCount).toBe(history.versions.length);
    expect((await recoveredAgain.readHistory(projectId, id)).versions).toEqual(history.versions);
  });

  it.each(["missing", "empty"] as const)("recovers the just-committed candidate when item references are %s before a pending sidecar acknowledgement restarts", async mode => {
    const { root, store, file, items, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId); io.renameCount = 0; io.renameFailureAt = 3; // sidecar prepare, main commit, sidecar acknowledgement
    await expect(store.write({ projectId, requestId: "commit-before-reference-loss", operation: { type: "update", id, expectedRevision: 11, fields: { body: "已提交正文" } } })).rejects.toThrow(/transaction interruption/);
    const interrupted = JSON.parse(await readFile(file, "utf8"));
    expect(interrupted.pendingHistory[0]).toMatchObject({ itemId: id, keys: expect.any(Array) });
    expect(interrupted.items[0].body).toBe("已提交正文");
    if (mode === "missing") { delete interrupted.items[0].historyKeys; delete interrupted.items[0].historyCount; }
    else { interrupted.items[0].historyKeys = []; interrupted.items[0].historyCount = 0; }
    await writeFile(file, JSON.stringify(interrupted));
    const restarted = new BoardStore(root), recovered = await restarted.readHistory(projectId, id);
    expect(recovered.versions.map(version => version.revision)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(recovered.versions.at(-1)!.body).toBe(fields.body); expect(recovered.missing).toBe(false);
    await restarted.write({ projectId, requestId: "edit-after-combined-recovery", operation: { type: "update", id, expectedRevision: 12, fields: { body: "下一版正文" } } });
    const sidecar = JSON.parse(await readFile(historyFile(id), "utf8"));
    expect(sidecar.versions).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 11, body: fields.body }), expect.objectContaining({ revision: 12, body: "已提交正文" })]));
    expect((await restarted.readHistory(projectId, id)).versions.map(version => version.revision)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps an explicitly confirmed empty repair intent after interruption instead of reviving old sidecar commitments", async () => {
    const { root, store, file, items, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId);
    const sidecar = JSON.parse(await readFile(historyFile(id), "utf8")); sidecar.versions = [];
    await writeFile(historyFile(id), JSON.stringify(sidecar));
    io.renameCount = 0; io.renameFailureAt = 2; // repair main commit succeeds; sidecar acknowledgement fails
    await expect(store.write({ projectId, requestId: "interrupted-empty-repair", operation: { type: "repairHistory", id, expectedRevision: 11 } })).rejects.toThrow(/transaction interruption/);
    const doc = JSON.parse(await readFile(file, "utf8")); expect(doc.pendingHistory).toEqual([{ itemId: id, keys: [] }]);
    delete doc.items[0].historyKeys; delete doc.items[0].historyCount; await writeFile(file, JSON.stringify(doc));
    const restarted = new BoardStore(root);
    expect(await restarted.readHistory(projectId, id)).toMatchObject({ versions: [], missing: false, missingCount: 0, itemRevision: 12 });
    expect(JSON.parse(await readFile(historyFile(id), "utf8")).committedKeys).toEqual([]);
    expect((await restarted.read(projectId)).items[0]!.body).toBe(fields.body);
  });

  it("protects migrated originals while bounding subsequent history and excluding bodies from reads and writes", async () => {
    const { store, items, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId);
    for (let revision = 11; revision < 35; revision++) {
      const result = await store.write({ projectId, requestId: `content-edit-${revision}`, operation: { type: "update", id, expectedRevision: revision, fields: { body: `正文 ${revision}` } } });
      expect(result.board.items[0]).not.toHaveProperty("history");
      expect(result.board.items[0]).not.toHaveProperty("historyKeys");
    }
    const saved = JSON.parse(await readFile(historyFile(id), "utf8")) as { versions: NoteVersion[] };
    expect(saved.versions).toEqual(expect.arrayContaining(items[0]!.history));
    expect(saved.versions.length).toBeLessThanOrEqual(21); // ten protected originals, ten committed versions, one candidate
    expect((await store.readHistory(projectId, id)).versions.map(version => version.revision)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
    expect(JSON.stringify(await store.readEntries())).not.toContain("完整正文");
  });

  it("does not make an uncommitted candidate visible after a metadata-only write", async () => {
    const { store, items } = await fixture(1), id = items[0]!.id;
    await store.read(projectId); io.failMain = true;
    await expect(store.write({ projectId, requestId: "interrupted-update", operation: { type: "update", id, expectedRevision: 11, fields: { body: "未提交" } } })).rejects.toThrow(/simulated interruption/);
    await store.write({ projectId, requestId: "metadata-after-interruption", operation: { type: "update", id, expectedRevision: 11, fields: { pinned: true, status: "doing", priority: "high" } } });
    expect((await store.readHistory(projectId, id)).versions).toEqual(items[0]!.history);
    const board = await store.read(projectId); expect(board.items[0]).toMatchObject({ body: fields.body, revision: 12, historyCount: 10 });
  });
});

describe("history-free metadata and cleanup capacity", () => {
  it("keeps content versions through status, priority, pin, delete and restore changes", async () => {
    const { store, items } = await fixture(1), id = items[0]!.id;
    for (const [index, changes] of [{ status: "doing" as const }, { pinned: true }, { priority: "high" as const }].entries()) {
      await store.write({ projectId, requestId: `metadata-update-${index}`, operation: { type: "update", id, expectedRevision: 11 + index, fields: changes } });
    }
    await store.write({ projectId, requestId: "metadata-delete", operation: { type: "delete", id, expectedRevision: 14 } });
    await store.write({ projectId, requestId: "metadata-restore", operation: { type: "restore", id, expectedRevision: 15 } });
    expect((await store.readHistory(projectId, id)).versions).toEqual(items[0]!.history);
  });

  it.each([["read", "purge"], ["write", "purge"], ["read", "emptyTrash"], ["write", "emptyTrash"]] as const)("finishes committed deletion after interruption on a fresh %s after %s without replaying its request", async (resume, cleanup) => {
    const { root, store, items, file, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId);
    const trashed = await store.write({ projectId, requestId: "cleanup-trash", operation: { type: "delete", id, expectedRevision: 11 } });
    const operation = cleanup === "purge" ? { type: "purge" as const, id, expectedRevision: 12 } : { type: "emptyTrash" as const, expectedRevision: trashed.board.revision };
    const request = { projectId, requestId: "cleanup-purge", operation };
    io.failCleanup = true;
    await expect(store.write(request)).rejects.toThrow(/committed cleanup/);
    const committed = JSON.parse(await readFile(file, "utf8"));
    expect(committed.items).toEqual([]);
    expect(committed.receipts.at(-1)).toMatchObject({ requestId: "cleanup-purge", removedIds: [id] });
    expect(JSON.parse(await readFile(historyFile(id), "utf8")).versions).toHaveLength(10);
    const restarted = new BoardStore(root);
    if (resume === "read") expect((await restarted.read(projectId)).items).toEqual([]);
    else await restarted.write({ projectId, requestId: "cleanup-unrelated-write", operation: { type: "create", fields } });
    await expect(stat(historyFile(id))).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = JSON.parse(await readFile(file, "utf8"));
    expect(recovered.receipts.find((receipt: { requestId: string }) => receipt.requestId === "cleanup-purge")).not.toHaveProperty("removedIds");
    expect((await restarted.write(request)).replayed).toBe(true);
  });

  it("does not delete a restored current note or unrelated history while draining committed cleanup", async () => {
    const { root, store, items, file, historyFile } = await fixture(1), id = items[0]!.id;
    await store.read(projectId);
    const board = JSON.parse(await readFile(file, "utf8")), unrelatedId = randomUUID();
    await writeFile(historyFile(unrelatedId), "unrelated backup history");
    board.receipts.push({ requestId: "old-delete-receipt", hash: "hash", itemId: id, removedIds: [id] });
    await writeFile(file, JSON.stringify(board));
    await new BoardStore(root).readAll();
    expect((await store.readHistory(projectId, id)).versions).toEqual(items[0]!.history);
    expect(await readFile(historyFile(unrelatedId), "utf8")).toBe("unrelated backup history");
    expect(JSON.parse(await readFile(file, "utf8")).receipts.at(-1)).not.toHaveProperty("removedIds");
  });

  it("still trashes, permanently deletes and empties a full board with revision checks and replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "notes-history-capacity-")); roots.push(root);
    const store = new BoardStore(root, { maxFileBytes: 4000 });
    const created = await store.write({ projectId, requestId: "full-board-create", operation: { type: "create", fields: { ...fields, body: "x".repeat(1500) } } });
    await store.write({ projectId, requestId: "full-board-edit", operation: { type: "update", id: created.itemId, expectedRevision: 1, fields: { body: "y".repeat(1500) } } });
    await expect(store.write({ projectId, requestId: "full-board-refused", operation: { type: "create", fields: { ...fields, body: "x".repeat(1500) } } })).rejects.toThrow(/存储上限/);
    await expect(store.write({ projectId, requestId: "purge-needs-trash", operation: { type: "purge", id: created.itemId, expectedRevision: 2 } })).rejects.toThrow(/先把这条记录移入回收站/);
    const deleted = await store.write({ projectId, requestId: "x".repeat(160), operation: { type: "delete", id: created.itemId, expectedRevision: 2 } });
    expect(deleted.board.items[0]!.deletedAt).not.toBeNull();
    await expect(store.write({ projectId, requestId: "stale-empty-trash", operation: { type: "emptyTrash", expectedRevision: deleted.board.revision - 1 } })).rejects.toThrow(/重新确认/);
    const input = { projectId, requestId: "empty-trash-now", operation: { type: "emptyTrash" as const, expectedRevision: deleted.board.revision } };
    expect((await store.write(input)).board.items).toEqual([]);
    expect((await store.write(input)).replayed).toBe(true);
    expect(await readdir(join(root, "history"))).toEqual([]);
    const another = await store.write({ projectId, requestId: "create-after-cleanup", operation: { type: "create", fields } });
    await store.write({ projectId, requestId: "trash-after-cleanup", operation: { type: "delete", id: another.itemId, expectedRevision: 1 } });
    const purge = { projectId, requestId: "purge-after-cleanup", operation: { type: "purge" as const, id: another.itemId, expectedRevision: 2 } };
    expect((await store.write(purge)).board.items).toEqual([]); expect((await store.write(purge)).replayed).toBe(true);
    await expect(store.readHistory(projectId, another.itemId)).rejects.toThrow(/已不存在/);
  });
});


describe("directory durability portability", () => {
  it.each([["open", "EPERM"], ["open", "EACCES"], ["sync", "EPERM"], ["sync", "EACCES"]] as const)("tolerates unsupported directory %s with %s without weakening file writes", async (at, code) => {
    const { store, items, file } = await fixture(1), id = items[0]!.id;
    io.directoryError = { at, code };
    await store.read(projectId);
    const result = await store.write({ projectId, requestId: "portable-history-write", operation: { type: "update", id, expectedRevision: 11, fields: { body: "可移植写入" } } });
    expect(result.board.items[0]!.body).toBe("可移植写入"); expect(JSON.parse(await readFile(file, "utf8")).version).toBe(2);
  });

  it("propagates real directory I/O failures and permission failures from file fsync", async () => {
    const { store, file, original, items } = await fixture(1), id = items[0]!.id;
    io.fileSyncError = true;
    await expect(store.read(projectId)).rejects.toThrow(/file sync failed/);
    expect(await readFile(file, "utf8")).toBe(original);
    io.fileSyncError = false; await store.read(projectId);
    io.directoryError = { at: "sync", code: "EIO" };
    await expect(store.write({ projectId, requestId: "real-directory-failure", operation: { type: "update", id, expectedRevision: 11, fields: { body: "不能吞掉I\/O错误" } } })).rejects.toThrow(/directory sync unsupported/);
  });
});
