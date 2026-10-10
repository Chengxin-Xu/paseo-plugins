import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { mergeReadReceipts, type MarkCompletionReadInput, type ReadReceipt } from "../shared/read-state";
import { CompletionReadController, ReadReceiptStore } from "../server/read-state";

const completed = "2026-09-17T12:10:00.000Z";
const prompted = "2026-09-17T12:00:00.000Z";
const readAt = "2026-09-17T12:12:00.000Z";
const input: MarkCompletionReadInput = { agentId: "a", attentionTimestamp: completed, lastUserMessageAt: prompted };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { state?: Record<string, unknown>; beforeClear?: (controller: CompletionReadController, state: Record<string, unknown>) => void;
  postRead?: (controller: CompletionReadController, state: Record<string, unknown>) => void; gate?: Promise<void>; failure?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-read-state-"));
  const store = new ReadReceiptStore({ directory });
  const state: Record<string, unknown> = { id: "a", status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [],
    requiresAttention: true, attentionReason: "finished", attentionTimestamp: completed, lastUserMessageAt: prompted, ...options.state };
  let reads = 0; const calls: Record<string, unknown>[] = [];
  const controller = new CompletionReadController(store, { async request(message, responseType) {
    calls.push(message); assert.equal(responseType, "clear_agent_attention_response");
    await options.gate;
    if (options.failure) throw new Error("offline");
    options.beforeClear?.(controller, state);
    state.requiresAttention = false; state.attentionReason = null; state.attentionTimestamp = null;
    return { agentId: "a", agents: [structuredClone(state)] };
  } }, () => Date.parse(readAt));
  const paseo = { agents: { ref(id: string) { assert.equal(id, "a"); return { async refresh() {
    reads++; if (reads > 1) options.postRead?.(controller, state);
    return { agent: structuredClone(state), project: null };
  } }; } } } as unknown as PaseoApi;
  return { directory, store, controller, paseo, state, calls,
    async close() { await controller.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("confirmed native single-agent read persists completion proof after both snapshots", async () => {
  const f = await fixture();
  try {
    const result = await f.controller.mark(f.paseo, input);
    assert.equal(result.status, "read");
    assert.deepEqual(f.calls, [{ type: "clear_agent_attention", agentId: "a" }]);
    assert.equal(f.state.requiresAttention, false); assert.equal(f.state.attentionTimestamp, null);
    assert.deepEqual(result.receipt, { agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    const persisted = JSON.parse(await readFile(join(f.directory, "read-receipts.json"), "utf8"));
    assert.equal(persisted.version, 2); assert.deepEqual(persisted.receipts, [result.receipt]);
    assert.equal((await stat(join(f.directory, "read-receipts.json"))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});
test("stale completion or prompt token never clears current native state", async () => {
  for (const patch of [{ attentionTimestamp: "2026-09-17T12:11:00.000Z" }, { lastUserMessageAt: "2026-09-17T12:09:00.000Z" }]) {
    const f = await fixture({ state: patch });
    try { const result = await f.controller.mark(f.paseo, input); assert.equal(result.status, "stale"); assert.equal(f.calls.length, 0); assert.equal((await f.store.snapshot()).receipts.length, 0); }
    finally { await f.close(); }
  }
});
test("running, pending-permission, archived and new-error sessions cannot be marked complete-read", async () => {
  for (const state of [{ status: "running" }, { activeTurn: { turnId: "next" } }, { pendingPermissions: [{ id: "approval" }] },
    { attentionReason: "permission" }, { archivedAt: completed }, { status: "error" }]) {
    const f = await fixture({ state });
    try { assert.equal((await f.controller.mark(f.paseo, input)).status, "stale"); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});
test("explicit native already-read and unknown attention state are no-op", async () => {
  for (const state of [{ requiresAttention: false, attentionReason: null, attentionTimestamp: null }, { requiresAttention: undefined }]) {
    const f = await fixture({ state });
    try { assert.equal((await f.controller.mark(f.paseo, input)).status, "not_unread"); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});
test("lifecycle race during clear returns stale without a new persisted receipt", async () => {
  const f = await fixture({ beforeClear(controller) { controller.bump("a"); } });
  try { assert.equal((await f.controller.mark(f.paseo, input)).status, "stale"); assert.equal((await f.store.snapshot()).receipts.length, 0); }
  finally { await f.close(); }
});
test("a newer completion in postcheck remains unread and has no matching old receipt", async () => {
  const f = await fixture({ postRead(controller, state) { controller.bump("a"); state.requiresAttention = true; state.attentionReason = "finished"; state.attentionTimestamp = "2026-09-17T12:11:00.000Z"; } });
  try {
    const result = await f.controller.mark(f.paseo, input); assert.equal(result.status, "stale");
    assert.equal(f.state.requiresAttention, true); assert.equal((await f.store.snapshot()).receipts.length, 0);
  } finally { await f.close(); }
});
test("native clear failure never publishes an optimistic read receipt", async () => {
  const f = await fixture({ failure: true });
  try { const result = await f.controller.mark(f.paseo, input); assert.equal(result.status, "failed"); assert.match(result.message, /offline/); assert.equal(f.state.requiresAttention, true); assert.equal((await f.store.snapshot()).receipts.length, 0); }
  finally { await f.close(); }
});
test("repeated clicks deduplicate one native clear and a later no-op preserves receipt", async () => {
  const gate = deferred(); const f = await fixture({ gate: gate.promise });
  try {
    const first = f.controller.mark(f.paseo, input), second = f.controller.mark(f.paseo, input);
    gate.resolve(); const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b); assert.equal(f.calls.length, 1);
    const already = await f.controller.mark(f.paseo, input); assert.equal(already.status, "not_unread"); assert.deepEqual(already.receipt, a.receipt); assert.equal(f.calls.length, 1);
  } finally { gate.resolve(); await f.close(); }
});
test("receipt storage is bounded, reloadable and contains only timestamps and IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-store-"));
  const store = new ReadReceiptStore({ directory, limit: 2 });
  try {
    for (let index = 0; index < 3; index++) await store.record({ agentId: `agent-${index}`, completionAt: completed, lastUserMessageAt: prompted,
      readAt: `2026-09-17T12:1${index}:00.000Z`, prompt: "MUST_NOT_PERSIST", title: "MUST_NOT_PERSIST" } as ReadReceipt);
    assert.equal((await store.snapshot()).receipts.length, 2);
    assert.equal((await store.snapshot()).receipts.some(row => row.agentId === "agent-0"), false);
    const content = await readFile(join(directory, "read-receipts.json"), "utf8"); assert.equal(content.includes("MUST_NOT_PERSIST"), false);
    const reloaded = new ReadReceiptStore({ directory }); assert.equal((await reloaded.snapshot()).receipts.length, 2); await reloaded.close();
    assert.deepEqual(await readdir(directory), ["read-receipts.json"]);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("older late acknowledgement cannot overwrite a newer completion receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-order-")); const store = new ReadReceiptStore({ directory });
  try {
    await store.record({ agentId: "a", completionAt: "2026-09-17T12:11:00.000Z", lastUserMessageAt: prompted, readAt });
    await store.record({ agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    assert.equal((await store.get("a"))?.completionAt, "2026-09-17T12:11:00.000Z");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("corrupt receipt storage reports error and preserves original on next successful save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-corrupt-"));
  await writeFile(join(directory, "read-receipts.json"), "{invalid"); const store = new ReadReceiptStore({ directory });
  try {
    assert.ok((await store.snapshot()).error); await store.record({ agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt });
    const files = await readdir(directory); assert.ok(files.some(name => name.endsWith(".backup")));
    assert.equal((await store.snapshot()).error, null);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("archive origins are bounded and survive reload independently of read receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-archive-origins-"));
  const store = new ReadReceiptStore({ directory, limit: 2 });
  try {
    await store.recordArchiveOrigin({ agentId: "a", archivedAt: "2026-09-17T12:13:00Z", lastUserMessageAt: prompted });
    await store.recordArchiveOrigin({ agentId: "b", archivedAt: "2026-09-17T12:14:00Z", lastUserMessageAt: null });
    await store.recordArchiveOrigin({ agentId: "c", archivedAt: "2026-09-17T12:15:00Z", lastUserMessageAt: prompted });
    assert.deepEqual((await store.snapshot()).archiveOrigins.map(origin => origin.agentId), ["c", "b"]);
    assert.equal((await store.snapshot()).receipts.length, 0, "archival metadata must never fabricate a read receipt");
    const reloaded = new ReadReceiptStore({ directory });
    assert.equal((await reloaded.snapshot()).archiveOrigins.length, 2); await reloaded.close();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy receipt files migrate and repeated archive hooks retain the known prompt timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-archive-migration-"));
  const receipt = { agentId: "a", completionAt: completed, lastUserMessageAt: prompted, readAt };
  await writeFile(join(directory, "read-receipts.json"), JSON.stringify({ version: 1, receipts: [receipt] }));
  const store = new ReadReceiptStore({ directory });
  try {
    assert.equal((await store.snapshot()).receipts.length, 1); assert.equal((await store.snapshot()).archiveOrigins.length, 0);
    await store.recordArchiveOrigin({ agentId: "a", archivedAt: readAt, lastUserMessageAt: prompted });
    await store.recordArchiveOrigin({ agentId: "a", archivedAt: readAt, lastUserMessageAt: null });
    assert.equal((await store.snapshot()).archiveOrigins[0]?.lastUserMessageAt, prompted);
    assert.equal(JSON.parse(await readFile(join(directory, "read-receipts.json"), "utf8")).version, 2);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("receipt reads short-circuit until a receipt or archive origin changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-receipts-revision-"));
  const store = new ReadReceiptStore({ directory });
  try {
    const first = await store.read();
    assert.equal(first.mode, "full");
    const same = await store.read(first.revision);
    assert.equal(same.mode, "unchanged"); assert.ok(JSON.stringify(same).length < 90);
    assert.deepEqual(mergeReadReceipts(mergeReadReceipts(undefined, first), same), mergeReadReceipts(undefined, first));
    await store.record({ agentId: "a", completionAt: "2026-09-16T12:00:00.000Z", lastUserMessageAt: null, readAt: "2026-09-16T12:01:00.000Z" });
    const receipt = await store.read(first.revision);
    assert.equal(receipt.mode, "full"); assert.ok(receipt.mode === "full" && receipt.receipts.length === 1);
    await store.recordArchiveOrigin({ agentId: "b", archivedAt: "2026-09-16T12:02:00.000Z", lastUserMessageAt: null });
    assert.equal((await store.read(receipt.revision)).mode, "full");
    const reloaded = new ReadReceiptStore({ directory });
    assert.equal((await reloaded.read((await store.read()).revision)).mode, "unchanged", "content revisions survive a plugin reload");
    await reloaded.close();
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
