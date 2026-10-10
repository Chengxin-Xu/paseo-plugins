import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { createReplyCheck } from "../server/reply-check";
import type { StatsDirectoryAgent } from "../server/stats-types";
import { TelemetryStore } from "../server/telemetry";

const at = (minutes: number) => new Date(Date.parse("2026-09-23T10:00:00Z") + minutes * 60_000).toISOString();
const agent = (id: string, patch: Partial<StatsDirectoryAgent> = {}): StatsDirectoryAgent => ({ id, createdAt: at(0), provider: "claude", model: null, parentAgentId: null,
  projectKey: "p", projectName: "p", status: "idle", archivedAt: null, title: id, requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false,
  contextUsed: null, contextMax: null, sessionId: null, lastUserMessageAt: at(1), ...patch });
const entry = (seq: number, item: Record<string, unknown>, timestamp: string) => ({ seqStart: seq, seqEnd: seq, timestamp, item });

test("the reply check reads each stopped Agent's final reply once, skips live or archived ones and retries failures later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-replies-"));
  let clock = Date.parse(at(30));
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const tails: Record<string, unknown[]> = {
    asks: [entry(1, { type: "user_message", text: "修一下" }, at(1)), entry(2, { type: "assistant_message", text: "改好了。要不要顺便发版？" }, at(5))],
    done: [entry(1, { type: "user_message", text: "部署" }, at(1)), entry(2, { type: "assistant_message", text: "部署完成，健康检查通过。" }, at(6))],
    cut: [entry(1, { type: "user_message", text: "继续" }, at(1)), entry(2, { type: "tool_call", name: "Bash", status: "canceled" }, at(2))],
  };
  const fetched: string[] = []; let broken = true;
  const paseo = { agents: { ref: (id: string) => ({ timeline: { refetch: async () => {
    fetched.push(id);
    if (id === "broken" && broken) throw new Error("timeline unavailable");
    return { epoch: "e", entries: tails[id] ?? tails.done };
  } } }) } } as unknown as PaseoApi;
  const agents = [agent("asks"), agent("done"), agent("cut"), agent("broken"), agent("running", { status: "running" }), agent("archived", { archivedAt: at(2) }),
    agent("fresh", { lastUserMessageAt: null })];
  const check = createReplyCheck(telemetry, { agents, loaded: true, refresh: async () => {} }, { now: () => clock, perRun: 10, intervalMs: 60_000, retryMs: 600_000 });
  try {
    // Only Agents this plugin process has seen are loaded in the daemon; "unseen" must never be read (it would be loaded and replayed).
    for (const id of ["asks", "done", "cut", "broken", "running", "archived", "fresh"]) await telemetry.record({ type: "created", agent: { id, title: id } });
    agents.push(agent("unseen"));
    await check.refresh(paseo);
    assert.deepEqual(fetched.sort(), ["asks", "broken", "cut", "done"]);
    assert.deepEqual([...telemetry.awaitingAgents(agents)], ["asks"]);
    const summaries = new Map((await telemetry.snapshot()).agents.map(summary => [summary.agentId, summary]));
    assert.equal(summaries.get("done")?.outcome, "completed"); assert.equal(summaries.get("done")?.replyAsks, false);
    assert.equal(summaries.get("cut")?.outcome, null, "a turn that ended on a tool call is not called complete");
    assert.equal(summaries.get("broken")?.replyFor, undefined, "a failed read records nothing");
    fetched.length = 0; clock += 30_000;
    await check.refresh(paseo); assert.deepEqual(fetched, [], "throttled to one run per interval");
    clock += 60_000; broken = false;
    await check.refresh(paseo); assert.deepEqual(fetched, [], "read turns are not fetched again; a failure waits for its retry time");
    clock += 600_000;
    await check.refresh(paseo); assert.deepEqual(fetched, ["broken"]);
  } finally { check.close(); await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a reply stamped with the session's load time is capped at the Agent's last update, and earlier bad reads are corrected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-replies-"));
  const clock = Date.parse(at(600));
  const telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  // Loaded from disk long after it ended: every row carries the load time.
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ epoch: "e", entries: [
    entry(1, { type: "user_message", text: "看看" }, at(590)), entry(2, { type: "assistant_message", text: "查完了，原因是限流。" }, at(590)),
  ] }) } }) } } as unknown as PaseoApi;
  const old = agent("old", { lastUserMessageAt: at(1), updatedAt: at(20) });
  try {
    // An earlier version recorded the load time as the end.
    await telemetry.recordReply("old", at(1), { at: at(590), asks: false });
    assert.equal(await telemetry.needsReplyCheck("old", at(1), at(20)), true);
    const check = createReplyCheck(telemetry, { agents: [old], loaded: true, refresh: async () => {} }, { now: () => clock });
    await check.refresh(paseo); check.close();
    const summary = (await telemetry.snapshot("old")).agents[0];
    assert.equal(summary.replyAt, at(20)); assert.equal(summary.turnEndedAt, at(20)); assert.equal(summary.outcome, "completed");
    assert.equal(await telemetry.needsReplyCheck("old", at(1), at(20)), false);
  } finally { await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Agents restored from disk but not seen since this process started are never read in the background", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-replies-"));
  let clock = Date.parse(at(10));
  let telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 0 });
  try {
    await telemetry.record({ type: "created", agent: { id: "old", title: "old" } });
    assert.equal(await telemetry.needsReplyCheck("old", at(1)), true);
    await telemetry.close(); clock += 60_000;
    telemetry = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 0 });
    assert.equal(await telemetry.needsReplyCheck("old", at(1)), false);
    await telemetry.record({ type: "turn_started", agent: { id: "old", title: "old" }, turnId: "t" });
    assert.equal(await telemetry.needsReplyCheck("old", at(1)), true, "seen again: loaded, safe to read");
  } finally { await telemetry.close(); await rm(directory, { recursive: true, force: true }); }
});

