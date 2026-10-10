import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaseoApi } from "@getpaseo/client";
import type { InsightJob, InsightReport } from "../shared/insights";
import { insightJobSchema } from "../shared/insights";
import type { SessionTrajectory } from "../shared/trajectory";
import { InsightManager, type InsightManagerOptions } from "../server/insights";
import { fitInsightReport, MAX_REPORT_BYTES } from "../server/insight-storage";
import { fetchTrajectory } from "../server/trajectory";

const epoch = Date.parse("2026-09-17T12:00:00Z"), at = new Date(epoch).toISOString();
const report = (ref = "r3"): InsightReport => ({ summary: "验证已完成，保持当前检查流程。", health: "healthy", confidence: "high",
  findings: [{ id: "finding", severity: "low", category: "quality", title: "持续验证", detail: "工具结果可用于核对", evidence: [ref], recommendation: "保留检查" }], strengths: ["已完成验证"], nextActions: [], limitations: [] });
const trajectory = (id = "a", start = 0, count = 12): SessionTrajectory => ({ agent: { id, title: id, provider: "test", model: null, cwd: "/repo", workspaceId: "w", archivedAt: null, status: "idle", attentionReason: "finished" },
  project: { id: "p", name: "p", rootPath: "/repo" }, capturedAt: at,
  rows: Array.from({ length: count }, (_, index) => ({ ref: `r${start + index}`, epoch: "e", seqStart: start + index, seqEnd: start + index, at, turnId: `turn-${Math.floor((start + index) / 4)}`, kind: index < 3 ? "user_message" : index < 6 ? "tool_call" : "assistant_message", text: `evidence ${start + index}`, toolName: index >= 3 && index < 6 ? "test" : null, toolStatus: null })),
  coverage: { complete: true, hasOlder: false, hasNewer: false, gap: false, truncated: false, reason: null, projectedItems: count, characters: count * 12, pages: 1, firstAt: at, lastAt: at, epoch: "e" },
  counts: { userTurns: 3, tools: 3, assistantMessages: 6, toolFailures: 0, errors: 0, observedTurnIds: 3 }, completionEvidence: { kind: "attention_finished", at } });
const makeJob = (id: string): InsightJob => ({ id, agentId: id, agentTitle: id, projectName: "p", createdAt: at, updatedAt: at, status: "completed", trigger: "manual", stage: "complete", eligibility: null, coverage: null, report: report(), model: "grok-4.6", effort: "xhigh", usage: null, error: null });
const paseo = {} as PaseoApi;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function wait(manager: InsightManager, id: string, statuses: InsightJob["status"][] = ["completed", "failed", "skipped", "canceled"]) {
  for (let index = 0; index < 1000; index++) { const job = (await manager.state()).jobs.find(item => item.id === id); if (job && statuses.includes(job.status)) return job; await new Promise(done => setTimeout(done, 2)); }
  throw new Error("job did not settle");
}
async function fixture(options: InsightManagerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-ai-upgrade-"));
  const manager = new InsightManager({ directory, now: () => epoch, findBinary: async () => "/fake", fetch: async (_p, id) => trajectory(id), run: async () => JSON.stringify(report()), ...options });
  return { directory, manager, async close() { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("migrates legal legacy history over eight megabytes without losing disabled settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-ai-large-migration-"));
  const jobs = Array.from({ length: 60 }, (_, index) => ({ ...makeJob(`job-${index}`), evidence: Array.from({ length: 80 }, (_, n) => ({ ref: `r${n}`, at, kind: "tool_call", toolName: "test", text: "x".repeat(2000) })) }));
  assert.ok(jobs.every(job => insightJobSchema.safeParse(job).success));
  const legacy = JSON.stringify({ version: 1, settings: { autoEnabled: false, minTurns: 3, minTools: 3, cooldownHours: 6 }, jobs, fingerprints: {} });
  assert.ok(Buffer.byteLength(legacy) > 8000000); await writeFile(join(directory, "insights.json"), legacy);
  const first = new InsightManager({ directory, findBinary: async () => "/fake" });
  let second: InsightManager | undefined;
  try { const state = await first.state(); assert.equal(state.jobs.length, 60); assert.equal(state.settings.autoEnabled, false); await first.close();
    second = new InsightManager({ directory, findBinary: async () => "/fake" }); assert.equal((await second.state()).jobs.length, 60); assert.equal((await second.state()).settings.autoEnabled, false);
    assert.equal((await readdir(join(directory, "insight-reports"))).filter(name => name.endsWith(".json")).length, 60);
  } finally { await first.close(); await second?.close(); await rm(directory, { recursive: true, force: true }); }
});
test("corrupt index recovers independent reports and never enables disabled automation", async () => {
  const f = await fixture(); let restored: InsightManager | undefined;
  try { const job = await f.manager.start(paseo, "a"); await wait(f.manager, job.id); await f.manager.configure(false); await f.manager.close();
    await writeFile(join(f.directory, "insight-index.json"), "{broken");
    restored = new InsightManager({ directory: f.directory, findBinary: async () => "/fake" });
    assert.equal((await restored.state()).settings.autoEnabled, false); assert.equal((await restored.state()).jobs.filter(job => job.report).length, 1);
  } finally { await restored?.close(); await f.close(); }
});
test("unrecoverable configuration fails closed while reports remain readable", async () => {
  const f = await fixture(); let restored: InsightManager | undefined;
  try { const job = await f.manager.start(paseo, "a"); await wait(f.manager, job.id); await f.manager.close(); await writeFile(join(f.directory, "insight-settings.json"), "invalid");
    restored = new InsightManager({ directory: f.directory, findBinary: async () => "/fake" });
    assert.equal((await restored.state()).settings.autoEnabled, false); assert.equal((await restored.state()).jobs.length, 1);
    await assert.rejects(restored.start(paseo, "b", "auto"), /关闭/);
  } finally { await restored?.close(); await f.close(); }
});
test("coalesced automatic skips preserve successful reports and cooldown beyond sixty attempts", async () => {
  let calls = 0; const f = await fixture({ run: async () => { calls++; return JSON.stringify(report()); } });
  try { await f.manager.configure(true); const first = await f.manager.start(paseo, "a"); await wait(f.manager, first.id);
    for (let n = 0; n < 100; n++) assert.equal((await f.manager.start(paseo, "a", "auto")).status, "skipped");
    const state = await f.manager.state(); assert.equal(calls, 1); assert.ok(state.jobs.some(job => job.id === first.id));
    assert.equal(state.jobs.filter(job => job.status === "skipped").length, 1); assert.equal(state.jobs.find(job => job.status === "skipped")?.skipCount, 100);
  } finally { await f.close(); }
});
test("canceling an unresolved collection immediately lets the next queued job run", async () => {
  const gate = deferred<SessionTrajectory>(); const f = await fixture({ fetch: async (_p, id) => id === "blocked" ? gate.promise : trajectory(id) });
  try { const first = await f.manager.start(paseo, "blocked"); await wait(f.manager, first.id, ["collecting"]); const next = await f.manager.start(paseo, "next");
    await f.manager.cancel(first.id); assert.equal((await wait(f.manager, next.id)).status, "completed");
  } finally { gate.resolve(trajectory("blocked")); await f.close(); }
});
test("manual queued work precedes automatic jobs without interrupting active work", async () => {
  const gate = deferred<string>(); const order: string[] = [];
  const f = await fixture({ run: async ({ prompt }) => { const id = JSON.parse(prompt.split("<trajectory_data>")[1].split("</trajectory_data>")[0]).agent.id; order.push(id); return id === "first" ? gate.promise : JSON.stringify(report()); } });
  try { await f.manager.configure(true); const first = await f.manager.start(paseo, "first"); await wait(f.manager, first.id, ["analyzing"]);
    const automatic = await f.manager.start(paseo, "automatic", "auto"), manual = await f.manager.start(paseo, "manual");
    gate.resolve(JSON.stringify(report())); await wait(f.manager, automatic.id); await wait(f.manager, manual.id); assert.deepEqual(order, ["first", "manual", "automatic"]);
  } finally { gate.resolve(JSON.stringify(report())); await f.close(); }
});
test("lightweight list excludes report bodies, supports revision probes, and loads report separately", async () => {
  const f = await fixture();
  try { const job = await f.manager.start(paseo, "a"); await wait(f.manager, job.id); const list = await f.manager.list();
    assert.equal(list.jobs[0].reportAvailable, true); assert.equal("report" in list.jobs[0], false); assert.equal("evidence" in list.jobs[0], false);
    assert.ok(Buffer.byteLength(JSON.stringify(list)) < 12000);
    const unchanged = await f.manager.list(undefined, list.revision); assert.equal(unchanged.unchanged, true); assert.deepEqual(unchanged.jobs, []);
    assert.ok((await f.manager.report(job.id)).job?.report);
  } finally { await f.close(); }
});
test("feedback persists independently and new turns mark an existing report stale", async () => {
  const f = await fixture(); let restored: InsightManager | undefined;
  try { const job = await f.manager.start(paseo, "a"); const done = await wait(f.manager, job.id); assert.equal(done.source?.endSeq, 11);
    await f.manager.feedback(job.id, "finding", "resolved"); f.manager.turnStarted("a"); f.manager.turnEnded("a");
    assert.equal((await f.manager.report(job.id)).job?.freshness?.newTurns, 1); assert.equal((await f.manager.report(job.id)).job?.freshness?.state, "new_activity");
    await f.manager.close(); restored = new InsightManager({ directory: f.directory, findBinary: async () => "/fake" });
    assert.equal((await restored.report(job.id)).job?.findingFeedback?.finding.status, "resolved"); assert.equal((await restored.report(job.id)).job?.freshness?.newTurns, 1);
  } finally { await restored?.close(); await f.close(); }
});
test("incremental review requests only new cursor history and excludes resolved old findings", async () => {
  let fetches = 0; const afters: unknown[] = []; const requests: any[] = [];
  const f = await fixture({ fetch: async (_p, id, options) => { afters.push(options?.after); return trajectory(id, fetches++ ? 12 : 0); }, run: async ({ prompt }) => {
    const data = JSON.parse(prompt.split("<trajectory_data>")[1].split("</trajectory_data>")[0]); requests.push(data);
    return JSON.stringify(report(requests.length === 1 ? "r3" : "r15"));
  } });
  try { const first = await f.manager.start(paseo, "a"); await wait(f.manager, first.id); await f.manager.feedback(first.id, "finding", "resolved");
    const second = await f.manager.start(paseo, "a"); const done = await wait(f.manager, second.id);
    assert.deepEqual(afters[1], { epoch: "e", seq: 11 }); assert.equal(done.reviewContext?.mode, "incremental"); assert.equal(done.source?.endSeq, 23);
    assert.deepEqual(requests[1].previousReview.findings, []); assert.ok(requests[1].rows.every((row: any) => Number(row.ref.slice(1)) >= 12));
  } finally { await f.close(); }
});
test("single report byte budget compresses evidence while keeping findings intact", () => {
  const job = makeJob("large"); job.report = { ...report(), summary: "字".repeat(4000), findings: Array.from({ length: 12 }, (_, index) => ({ ...report().findings[0], id: `f${index}`, detail: "字".repeat(4000), recommendation: "字".repeat(2500), title: "字".repeat(180), evidence: Array(12).fill("r".repeat(300)) })), strengths: Array(8).fill("字".repeat(1500)), nextActions: Array(8).fill("字".repeat(1500)), limitations: Array(8).fill("字".repeat(1500)) };
  job.evidence = Array.from({ length: 80 }, (_, index) => ({ ref: `r${index}`, at, kind: "tool_call", toolName: "test", text: "字".repeat(2000) }));
  const bounded = fitInsightReport(job); assert.ok(Buffer.byteLength(JSON.stringify({ version: 1, job: bounded })) <= MAX_REPORT_BYTES); assert.equal(bounded.report?.findings.length, 12);
});
test("trajectory cancellation stops an in-flight page and prevents fetching more pages", async () => {
  const gate = deferred<unknown>(), abort = new AbortController(); let reads = 0;
  const mock = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a" }, project: null }), timeline: { refetch: async () => { reads++; return gate.promise; } } }) } } as unknown as PaseoApi;
  const pending = fetchTrajectory(mock, "a", { signal: abort.signal });
  await new Promise(done => setTimeout(done, 2)); abort.abort(); await assert.rejects(pending, /取消/); assert.equal(reads, 1);
  gate.resolve({ epoch: "e", entries: [], hasOlder: true });
});
test("incremental trajectory follows authoritative cursors rather than a tool's future seqEnd", async () => {
  const seen: unknown[] = [];
  const mock = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a" }, project: null }), timeline: { refetch: async (options: unknown) => {
    seen.push(options);
    return seen.length === 1 ? { epoch: "e", entries: [{ seqStart: 1, seqEnd: 200, item: { type: "tool_call", callId: "long", name: "test", status: "completed" } }], endCursor: { epoch: "e", seq: 15 }, hasOlder: true, hasNewer: true }
      : { epoch: "e", entries: [{ seqStart: 16, seqEnd: 16, item: { type: "user_message", text: "new input" } }], endCursor: { epoch: "e", seq: 16 }, hasOlder: true, hasNewer: false };
  } } }) } } as unknown as PaseoApi;
  const result = await fetchTrajectory(mock, "a", { after: { epoch: "e", seq: 10 } });
  assert.deepEqual((seen[1] as { cursor: unknown }).cursor, { epoch: "e", seq: 15 });
  assert.equal(result.coverage.endSeq, 16); assert.equal(result.rows[0].seqEnd, 200);
});

test("list revisions follow visible content: unrelated turn activity keeps them, report activity and job changes move them", async () => {
  const f = await fixture();
  try {
    const job = await f.manager.start(paseo, "reported"); await wait(f.manager, job.id);
    const hub = await f.manager.list();
    f.manager.turnStarted("no-report-agent"); f.manager.turnEnded("no-report-agent");
    const quiet = await f.manager.list(undefined, hub.revision);
    assert.equal(quiet.unchanged, true, "activity of an Agent without analysis does not resend the list"); assert.deepEqual(quiet.jobs, []);
    const scoped = await f.manager.list("reported");
    f.manager.turnStarted("other-agent");
    assert.equal((await f.manager.list("reported", scoped.revision)).unchanged, true);
    f.manager.turnStarted("reported");
    const fresh = await f.manager.list(undefined, hub.revision);
    assert.equal(fresh.unchanged, false); assert.equal(fresh.jobs[0].freshness?.state, "new_activity");
    const cancelled = await f.manager.start(paseo, "reported", "manual", undefined, "full"); await wait(f.manager, cancelled.id);
    assert.equal((await f.manager.list(undefined, fresh.revision)).unchanged, false, "a job change always changes the revision");
  } finally { await f.close(); }
});

test("revision-only saves do not rewrite the analysis index", async () => {
  const f = await fixture();
  try {
    const job = await f.manager.start(paseo, "a"); await wait(f.manager, job.id);
    await f.manager.configure(false);
    const index = join(f.directory, "insight-index.json"), before = (await stat(index)).ino;
    await f.manager.configure(false); await f.manager.configure(false);
    assert.equal((await stat(index)).ino, before, "settings live in their own file; the index content is unchanged");
    f.manager.turnStarted("a"); await f.manager.configure(false);
    assert.notEqual((await stat(index)).ino, before, "changed activity is still persisted with the next save");
  } finally { await f.close(); }
});
