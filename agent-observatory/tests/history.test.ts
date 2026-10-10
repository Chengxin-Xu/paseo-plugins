import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { restoreArchivedSession, type HistoryTransport } from "../server/history";
import { fetchTrajectory, summarizeTrajectoryRow } from "../server/trajectory";
import { normalizeTimelinePage } from "../shared/timeline";

function restoreFixture(options: { active?: boolean; missingPersistence?: boolean; workspaceActive?: boolean; workspaceRecoverable?: boolean; race?: boolean } = {}) {
  let archived = !options.active; let reads = 0;
  const messages: Record<string, unknown>[] = [];
  const snapshot = () => ({ id: "agent-a", workspaceId: "workspace-a", provider: "codex", title: "Original", status: "closed",
    lastUserMessageAt: "2026-09-15T11:00:00Z",
    archivedAt: archived ? "2026-09-15T12:00:00Z" : null, persistence: options.missingPersistence ? null : { provider: "codex", sessionId: "original-session" },
    activeTurn: options.race && reads > 1 ? { turnId: "active", startedAt: "2026-09-16T12:00:00Z" } : null });
  const paseo = { agents: { ref() { return { async refresh() { reads++; return { agent: snapshot(), project: null }; } }; } },
    workspaces: { ref() { return { async refresh() { return options.workspaceActive ? { id: "workspace-a" } : null; } }; } } } as unknown as PaseoApi;
  const transport: HistoryTransport = { async request(message) {
    messages.push(message);
    if (message.type === "workspace.recovery.inspect.request") return { state: options.workspaceRecoverable === false
      ? { kind: "unavailable", reason: "workspace_directory_missing", message: "directory missing" }
      : { kind: "recoverable", action: "unarchive" } };
    if (message.type === "workspace.recovery.restore.request") return { accepted: true };
    if (message.type === "refresh_agent_request") { archived = false; return { status: "agent_refreshed", agentId: "agent-a" }; }
    throw new Error("Unexpected mutation");
  } };
  return { paseo, transport, messages };
}
test("restore active session is a no-op", async () => {
  const f = restoreFixture({ active: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "already_active"); assert.equal(f.messages.length, 0);
});
test("restore without original persistence never creates a replacement agent", async () => {
  const f = restoreFixture({ missingPersistence: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "needs_native"); assert.equal(f.messages.length, 0);
});
test("restore reuses exact agent and workspace without a prompt or sibling mutation", async () => {
  const f = restoreFixture();
  const origins: object[] = [];
  const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport, async origin => {
    assert.equal(f.messages.length, 0, "archive read provenance must be recorded before unarchiving mutates state");
    origins.push(origin); return origin;
  });
  assert.deepEqual(origins, [{ agentId: "agent-a", archivedAt: "2026-09-15T12:00:00Z", lastUserMessageAt: "2026-09-15T11:00:00Z" }]);
  assert.equal(result.status, "restored"); assert.equal(result.workspaceRestored, true);
  assert.deepEqual(f.messages, [
    { type: "workspace.recovery.inspect.request", workspaceId: "workspace-a" },
    { type: "workspace.recovery.restore.request", workspaceId: "workspace-a" },
    { type: "refresh_agent_request", agentId: "agent-a" },
  ]);
});
test("active workspace does not need workspace recovery", async () => {
  const f = restoreFixture({ workspaceActive: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "restored"); assert.equal(result.workspaceRestored, false);
  assert.deepEqual(f.messages, [{ type: "refresh_agent_request", agentId: "agent-a" }]);
});
test("unrecoverable workspace leaves archived session untouched", async () => {
  const f = restoreFixture({ workspaceRecoverable: false }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "needs_native"); assert.equal(f.messages.length, 1);
});
test("restore rechecks liveness and never refreshes a newly active turn", async () => {
  const f = restoreFixture({ workspaceActive: true, race: true }); const result = await restoreArchivedSession(f.paseo, "agent-a", f.transport);
  assert.equal(result.status, "needs_native"); assert.equal(f.messages.length, 0);
});

const row = (seq: number, type: string, text: string) => ({ seqStart: seq, seqEnd: seq, timestamp: `2026-09-16T12:00:${String(seq).padStart(2, "0")}Z`, item: { type, text } });
function trajectoryFixture(pages: unknown[], status = "closed", checkout: Record<string, unknown> = { cwd: "/project" }) {
  const requests: Array<Record<string, unknown>> = []; let index = 0;
  const agent = { id: "a", title: "History", provider: "codex", status, archivedAt: "2026-09-15T12:00:00Z", cwd: "/project" };
  const paseo = { agents: { ref() { return { refresh: async () => ({ agent, project: { projectKey: "p", projectName: "Project", checkout } }),
    current: () => agent, timeline: { async refetch(options: Record<string, unknown>) { requests.push(options); const next = pages[Math.min(index++, pages.length - 1)]; if (next instanceof Error) throw next; return next; } } }; } } } as unknown as PaseoApi;
  return { paseo, requests };
}
test("trajectory fetches real cursor history and does not equate closed with complete", async () => {
  const f = trajectoryFixture([
    { epoch: "e", entries: [row(3, "user_message", "second"), row(4, "assistant_message", "answer")], hasOlder: true, startCursor: { epoch: "e", seq: 3 } },
    { epoch: "e", entries: [row(1, "user_message", "first"), row(2, "assistant_message", "answer")], hasOlder: false, hasNewer: true, startCursor: { epoch: "e", seq: 1 } },
  ]);
  const result = await fetchTrajectory(f.paseo, "a");
  assert.equal(result.counts.userTurns, 2); assert.equal(result.coverage.complete, true);
  assert.equal(result.completionEvidence.kind, "none"); assert.equal(result.rows[0].ref, "a:e:1-1");
  assert.deepEqual(f.requests[1].cursor, { epoch: "e", seq: 3 });
  assert.equal(result.agent.archivedAt, "2026-09-15T12:00:00Z");
});
test("trajectory budget preserves newest evidence and declares partial coverage", async () => {
  const f = trajectoryFixture([{ epoch: "e", entries: [row(1, "user_message", "a".repeat(900)), row(2, "assistant_message", "b".repeat(900))], hasOlder: false }]);
  const result = await fetchTrajectory(f.paseo, "a", { maxCharacters: 1000 });
  assert.ok(result.coverage.characters <= 1000); assert.equal(result.rows.length, 2);
  assert.ok(result.rows[0].text.startsWith("a")); assert.ok(result.rows.at(-1)?.text.endsWith("b"));
  assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.complete, false);
});
test("earlier-page failure retains usable sampled evidence", async () => {
  const f = trajectoryFixture([{ epoch: "e", entries: [row(3, "user_message", "recent")], hasOlder: true, startCursor: { epoch: "e", seq: 3 } }, new Error("offline")]);
  const result = await fetchTrajectory(f.paseo, "a");
  assert.equal(result.rows.length, 1); assert.equal(result.coverage.complete, false); assert.match(result.coverage.reason ?? "", /offline/);
});
test("trajectory project identity favors main repository over child worktree", async () => {
  const f = trajectoryFixture([{ epoch: "e", entries: [row(1, "user_message", "inspect")], hasOlder: false }], "idle",
    { mainRepoRoot: "/main/project", worktreeRoot: "/worktrees/task", cwd: "/worktrees/task/subdir" });
  assert.equal((await fetchTrajectory(f.paseo, "a")).project?.rootPath, "/main/project");
});
test("tool evidence summarizes giant embedded scripts and preserves failure signals", () => {
  const raw = normalizeTimelinePage({ epoch: "e", rows: [{ seq: 1, item: { type: "tool_call", name: "exec", status: "failed",
    detail: { type: "shell", command: "python - <<'PY'\n" + "embedded-code\n".repeat(10000) + "\nPY",
      output: "beginning\n" + "ordinary log\n".repeat(2000) + "ERROR: missing fixture\n" + "later log\n".repeat(2000) + "terminal failure end", exitCode: 1 } } }] });
  const summary = summarizeTrajectoryRow(raw.rows[0]);
  assert.ok(summary.text.length <= 6000); assert.equal(summary.truncated, true);
  assert.match(summary.text, /python/); assert.match(summary.text, /missing fixture/); assert.match(summary.text, /terminal failure end/);
});
test("giant recent tool output does not prevent acquiring earlier user turns", async () => {
  const recent = normalizeTimelinePage({ epoch: "e", rows: [{ seq: 10, item: { type: "tool_call", name: "exec", status: "completed", detail: { type: "shell", command: "inspect", output: "large\n".repeat(100000) } } }], hasOlder: true, startCursor: { epoch: "e", seq: 10 } });
  const f = trajectoryFixture([
    { epoch: "e", entries: recent.rows.map(item => ({ seqStart: item.seqStart, seqEnd: item.seqEnd, item: item.item })), hasOlder: true, startCursor: { epoch: "e", seq: 10 } },
    { epoch: "e", entries: [row(1, "user_message", "first user intent"), row(2, "user_message", "second user intent")], hasOlder: false },
  ]);
  const result = await fetchTrajectory(f.paseo, "a", { maxCharacters: 2000 });
  assert.equal(result.counts.userTurns, 2); assert.equal(result.coverage.pages, 2);
  assert.ok(result.rows.some(item => item.text.includes("first user intent")));
  assert.ok(result.coverage.characters <= 2000); assert.equal(result.coverage.truncated, true);
});
