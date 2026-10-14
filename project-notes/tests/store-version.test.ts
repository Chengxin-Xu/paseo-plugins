import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../server/store";
import { BoardStore as OldStore } from "./fixtures/v0_9/server/store";
import type { NoteFields } from "../shared/schema";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fields: NoteFields = { kind: "task", title: "兼容测试", body: "第一版完整正文", status: "todo", priority: "normal", pinned: false };
const projectId = "version-project";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notes-version-")); roots.push(root);
  const old = new OldStore(root), store = new BoardStore(root);
  const created = await old.write({ projectId, requestId: "legacy-create", operation: { type: "create", fields } });
  const second = await old.write({ projectId, requestId: "legacy-second", operation: { type: "create", fields: { ...fields, title: "另一条" } } });
  for (let revision = 1; revision <= 12; revision++) await old.write({ projectId, requestId: `legacy-edit-${revision}`, operation: { type: "update", id: created.itemId, expectedRevision: revision, fields: { body: `旧版正文 ${revision}` } } });
  await old.write({ projectId, requestId: "legacy-trash", operation: { type: "delete", id: second.itemId, expectedRevision: 1 } });
  const original = await old.read(projectId), file = join(root, store.boardFile(projectId));
  const historyFile = (id: string) => join(root, "history", `${store.boardFile(projectId).slice(0, -5)}.${id}.json`);
  return { root, old, store, original, file, historyFile, id: created.itemId };
}

describe("versioned external history", () => {
  it("migrates actual 0.9.0 output without losing a version and blocks actual 0.9.0 reads and writes afterwards", async () => {
    const { root, old, store, original, file } = await fixture();
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
    const migrated = await store.read(projectId);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(2);
    for (const item of original.items) {
      expect(migrated.items.find(next => next.id === item.id)).toMatchObject({ title: item.title, body: item.body, deletedAt: item.deletedAt, revision: item.revision, historyCount: item.history?.length ?? 0 });
      expect((await store.readHistory(projectId, item.id)).versions).toEqual(item.history ?? []);
    }
    const before = await readFile(file, "utf8"), histories = await readdir(join(root, "history"));
    await expect(old.read(projectId)).rejects.toThrow(/校验失败/);
    await expect(old.write({ projectId, requestId: "old-writer-refused", operation: { type: "update", id: original.items[0]!.id, expectedRevision: original.items[0]!.revision, fields: { status: "done" } } })).rejects.toThrow(/校验失败/);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(join(root, "history"))).toEqual(histories);
  });

  it.each(["missing", "empty"] as const)("recovers %s main-file references and count from sidecar commitments before the next edit", async mode => {
    const { root, store, original, file, historyFile, id } = await fixture();
    await store.read(projectId);
    let revision = original.items.find(item => item.id === id)!.revision;
    for (let index = 0; index < 3; index++) await store.write({ projectId, requestId: `new-edit-${index}`, operation: { type: "update", id, expectedRevision: revision++, fields: { body: `新版正文 ${index}` } } });
    const expected = (await store.readHistory(projectId, id)).versions;
    const sidecar = JSON.parse(await readFile(historyFile(id), "utf8"));
    expect(sidecar.committedKeys).toHaveLength(10);
    const doc = JSON.parse(await readFile(file, "utf8"));
    for (const item of doc.items) { if (mode === "missing") { delete item.historyKeys; delete item.historyCount; } else { item.historyKeys = []; item.historyCount = 0; } }
    await writeFile(file, JSON.stringify(doc));
    const restarted = new BoardStore(root);
    expect((await restarted.read(projectId)).items.find(item => item.id === id)?.historyCount).toBe(10);
    expect((await restarted.readHistory(projectId, id)).versions).toEqual(expected);
    await restarted.write({ projectId, requestId: "after-repaired-keys", operation: { type: "update", id, expectedRevision: revision, fields: { body: "继续编辑" } } });
    const after = JSON.parse(await readFile(historyFile(id), "utf8"));
    expect(after.versions).toEqual(expect.arrayContaining(expected)); // the oldest is retained until the next write
    expect((await restarted.readHistory(projectId, id)).versions.slice(0, -1)).toEqual(expected.slice(1));
  });

  it("upgrades v1 boards without embedded history, including sidecars produced by the initial external format", async () => {
    const { root, store, file, historyFile, id } = await fixture();
    await store.read(projectId);
    const doc = JSON.parse(await readFile(file, "utf8")), sidecar = JSON.parse(await readFile(historyFile(id), "utf8"));
    doc.version = 1; delete sidecar.committedKeys;
    await writeFile(file, JSON.stringify(doc)); await writeFile(historyFile(id), JSON.stringify(sidecar));
    const expectedKeys = doc.items.find((item: { id: string }) => item.id === id).historyKeys;
    await new BoardStore(root).readAll();
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(2);
    expect(JSON.parse(await readFile(historyFile(id), "utf8")).committedKeys).toEqual(expectedKeys);
  });
});
