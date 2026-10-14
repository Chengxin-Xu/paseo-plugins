import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../server/store";
import type { NoteFields } from "../shared/schema";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const fields: NoteFields = { kind: "prompt", title: "初版", body: "请检查 {{路径}}，保留 `npm test`。", status: "todo", priority: "normal", pinned: false };

describe("修改快照", () => {
  it("retains the last ten versions across reloads and restores as a new revision with an undo snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "notes-history-")); dirs.push(root);
    const store = new BoardStore(root), projectId = "test-project";
    const first = await store.write({ projectId, requestId: "history-create", operation: { type: "create", fields } });
    const id = first.itemId;
    for (let revision = 1; revision <= 12; revision++) await store.write({ projectId, requestId: `history-update-${revision}`, operation: { type: "update", id, expectedRevision: revision, fields: { title: `第 ${revision + 1} 版` } } });
    const fresh = new BoardStore(root);
    const item = (await fresh.read(projectId)).items[0]!;
    expect((await fresh.readHistory(projectId, id)).versions.map(version => version.revision)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(fresh.write({ projectId, requestId: "history-stale", operation: { type: "restoreVersion", id, expectedRevision: 12, revision: 3 } })).rejects.toThrow(/另一台设备/);
    await expect(fresh.write({ projectId, requestId: "history-evicted", operation: { type: "restoreVersion", id, expectedRevision: 13, revision: 1 } })).rejects.toThrow(/最近 10 版/);
    const request = { projectId, requestId: "history-restore", operation: { type: "restoreVersion" as const, id, expectedRevision: 13, revision: 3 } };
    const restored = await fresh.write(request);
    expect(restored.board.items[0]).toMatchObject({ title: "第 3 版", body: fields.body, revision: 14 });
    expect((await fresh.readHistory(projectId, id)).versions.at(-1)).toMatchObject({ title: "第 13 版", revision: 13 });
    expect((await fresh.write(request)).replayed).toBe(true);
    expect((await fresh.readHistory(projectId, id)).versions).toHaveLength(10);
  });
});
