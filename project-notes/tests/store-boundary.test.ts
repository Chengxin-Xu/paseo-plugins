import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../server/store";
import type { NoteFields } from "../shared/schema";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fields: NoteFields = { kind: "task", title: "边界", body: "x".repeat(300), status: "todo", priority: "normal", pinned: false };

// Regression for the independently reviewed boundary: grow until create fails, then exercise every cleanup path.
describe("board at the size limit", () => {
  it.each([12_000, 40_000])("updates, trashes, restores, purges and empties after creates reach the %i byte limit", async limit => {
    const root = await mkdtemp(join(tmpdir(), "notes-boundary-")); roots.push(root);
    const store = new BoardStore(root, { maxFileBytes: limit }), projectId = "boundary";
    let sequence = 0, created = 0;
    const requestId = () => `boundary-${"r".repeat(120)}-${++sequence}`;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await store.write({ projectId, requestId: requestId(), operation: { type: "create", fields } }); created++; }
      catch (error) { expect(String(error)).toMatch(/存储上限/); break; }
    }
    expect(created).toBeGreaterThan(2); expect(created).toBeLessThan(200);
    const file = join(root, store.boardFile(projectId));
    expect((await stat(file)).size).toBeLessThanOrEqual(limit);
    let board = await store.read(projectId), first = board.items[0]!;
    const status = await store.write({ projectId, requestId: requestId(), operation: { type: "update", id: first.id, expectedRevision: first.revision, fields: { status: "done" } } });
    expect(status.board.items.find(item => item.id === first.id)?.status).toBe("done");
    // Shortening content must also work without reserving more space for the new history reference.
    first = status.board.items.find(item => item.id === first.id)!;
    const shortened = await store.write({ projectId, requestId: requestId(), operation: { type: "update", id: first.id, expectedRevision: first.revision, fields: { body: "短正文" } } });
    expect(shortened.board.items.find(item => item.id === first.id)?.body).toBe("短正文");
    board = await store.read(projectId);
    for (const item of board.items) {
      const result = await store.write({ projectId, requestId: requestId(), operation: { type: "delete", id: item.id, expectedRevision: item.revision } });
      expect(result.board.items.find(next => next.id === item.id)?.deletedAt).not.toBeNull();
      expect((await stat(file)).size).toBeLessThanOrEqual(limit);
    }
    board = await store.read(projectId); expect(board.items.filter(item => item.deletedAt !== null)).toHaveLength(created);
    const victim = board.items[0]!;
    const restored = await store.write({ projectId, requestId: requestId(), operation: { type: "restore", id: victim.id, expectedRevision: victim.revision } });
    expect(restored.board.items.find(item => item.id === victim.id)).toMatchObject({ deletedAt: null, body: victim.body });
    const purged = restored.board.items.find(item => item.deletedAt !== null)!;
    const purge = await store.write({ projectId, requestId: requestId(), operation: { type: "purge", id: purged.id, expectedRevision: purged.revision } });
    expect(purge.board.items).toHaveLength(created - 1); expect(purge.board.items.some(item => item.id === purged.id)).toBe(false);
    const empty = await store.write({ projectId, requestId: requestId(), operation: { type: "emptyTrash", expectedRevision: purge.board.revision } });
    expect(empty.board.items.map(item => item.id)).toEqual([victim.id]); expect(empty.board.items[0]!.deletedAt).toBeNull();
    expect((await stat(file)).size).toBeLessThanOrEqual(limit);
    expect((await new BoardStore(root, { maxFileBytes: limit }).read(projectId)).items).toEqual(empty.board.items);
  });
});
