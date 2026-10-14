import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { SessionTrajectory } from "../shared/trajectory";
import type { InsightJob, InsightReport } from "../shared/insights";
import type { SuggestionJob, SuggestionReport } from "../shared/insight-overview";
import { InsightStorage } from "../server/insight-storage";
import { InsightManager, type InsightManagerOptions } from "../server/insights";
import { GrokTurnLimitError } from "../server/grok-runner";

// opus-F72's other half (s5's runner throws GrokTurnLimitError on "max turns reached"): server/insights.ts gives that
// failure the same one compact retry as a report that fails its checks, for analyses and suggestions alike.
const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
function trajectory(): SessionTrajectory {
  const length = 12, turns = 3, tools = 3;
  return { agent: { id: "agent-a", title: "Investigate", provider: "my-codex", model: "m", cwd: "/home/me/app", workspaceId: "w", archivedAt: null, status: "idle", attentionReason: "finished" },
    project: { id: "p", name: "Project", rootPath: "/home/me/app" }, capturedAt: "2026-09-16T12:00:00Z",
    rows: Array.from({ length }, (_, index) => ({ ref: `ref-${index}`, epoch: "e", seqStart: index, seqEnd: index, at: "2026-09-16T12:00:00Z", turnId: null,
      kind: index < turns ? "user_message" : index < turns + tools ? "tool_call" : "assistant_message", text: "Sample evidence", toolName: null, toolStatus: null })),
    coverage: { complete: true, hasOlder: false, hasNewer: false, gap: false, truncated: false, reason: null, projectedItems: length, characters: length * 15, pages: 1, firstAt: null, lastAt: null, epoch: "e" },
    counts: { userTurns: turns, assistantMessages: length - turns - tools, tools, toolFailures: 0, errors: 0, observedTurnIds: 0 },
    completionEvidence: { kind: "attention_finished", at: null } };
}
const report = (): InsightReport => ({ summary: "执行过程清晰", health: "watch", confidence: "high",
  findings: [{ id: "one", severity: "low", category: "efficiency", title: "减少重复读取", detail: "重复读取相同输出", evidence: ["ref-3"], recommendation: "复用结果" }], strengths: ["已有验证"], nextActions: ["检查结果"], limitations: [] });
const output = () => JSON.stringify({ structured_output: report(), usage: { input_tokens: 30, output_tokens: 20 }, total_cost_usd: 0.002 });
const suggestion: SuggestionReport = { headline: "统一跨项目的验证入口", summary: "多个会话均可改进验证流程", themes: [],
  actions: [{ id: "action1", title: "补齐验证入口", why: "减少重复检查", steps: ["确认各项目的检查命令"], scope: "workflow", impact: "high", effort: "small",
    projects: [], evidence: ["R1#one"], instruction: "完成变更后执行项目规定的验证命令，并报告结果。", task: null }], wins: [], watch: [] };
async function fixture(options: InsightManagerOptions = {}, seeded: InsightJob[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-turn-limit-"));
  if (seeded.length) {
    const storage = new InsightStorage(directory), settings = { autoEnabled: false, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "grok" as const } };
    await storage.saveSettings(settings); await storage.save({ settings, jobs: seeded, cooldowns: {}, activity: {}, revision: 1 }); await storage.close();
  }
  const manager = new InsightManager({ directory, findBinary: async () => "/fake/grok", fetch: async () => trajectory(), run: async () => output(), ...options });
  return { manager, async close() { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function until<T>(read: () => Promise<T | null | undefined>, done: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 10_000; n++) { const value = await read(); if (value && done(value)) return value; await tick(); }
  throw new Error("the fake runner did not settle");
}
const seed = (id: string): InsightJob => ({ id, agentId: id, agentTitle: id, projectName: "Project", createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  status: "completed", trigger: "manual", stage: "完成", eligibility: null, coverage: null, report: report(), model: "grok-4.7", effort: "xhigh", usage: null, error: null });

test("max turns reached retries once with the compact evidence and completes (opus-F72)", async () => {
  let calls = 0, release!: () => void; const prompts: string[] = [], held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ run: async ({ prompt }) => { prompts.push(prompt); if (++calls === 1) throw new GrokTurnLimitError(3); await held; return output(); } });
  try {
    const job = await f.manager.start(paseo, "agent-a");
    // While the retry runs, the job says why it is running again.
    const retrying = await until(async () => calls === 2 ? (await f.manager.state()).jobs.find(item => item.id === job.id) : null, () => true);
    assert.equal(retrying.status, "analyzing"); assert.equal(retrying.stage, "Grok 用完轮次仍没有报告，使用精简证据重试一次");
    release();
    const done = await until(async () => (await f.manager.state()).jobs.find(item => item.id === job.id), current => current.status === "completed" || current.status === "failed");
    assert.equal(done.status, "completed"); assert.equal(calls, 2);
    assert.match(prompts[1]!, /上一次报告/, "the retry carries the compact evidence");
  } finally { release(); await f.close(); }
});

test("a second turn limit fails in Chinese; an abort is never retried", async () => {
  let calls = 0;
  const f = await fixture({ run: async () => { calls++; throw new GrokTurnLimitError(3); } });
  try {
    const job = await f.manager.start(paseo, "agent-a");
    const done = await until(async () => (await f.manager.state()).jobs.find(item => item.id === job.id), current => current.status === "failed" || current.status === "completed");
    assert.equal(done.status, "failed"); assert.equal(calls, 2, "one retry, no more");
    assert.match(done.error ?? "", /Grok 用完 3 轮仍没有给出报告/);
  } finally { await f.close(); }
  let started = 0;
  const g = await fixture({ run: ({ signal }) => new Promise<string>((_resolve, reject) => { started++; signal.addEventListener("abort", () => reject(new GrokTurnLimitError(3))); }) });
  try {
    const job = await g.manager.start(paseo, "agent-a");
    await until(async () => started ? (await g.manager.state()).jobs.find(item => item.id === job.id) : null, current => current.status === "analyzing");
    await g.manager.cancel(job.id);
    const canceled = await until(async () => (await g.manager.state()).jobs.find(item => item.id === job.id), current => current.status === "canceled");
    assert.equal(canceled.status, "canceled"); await tick(); assert.equal(started, 1, "a canceled run is not retried");
  } finally { await g.close(); }
});

test("a suggestion run that hits the turn limit is retried once with the compact reports", async () => {
  let calls = 0; const prompts: string[] = [];
  const f = await fixture({ run: async ({ prompt }) => { prompts.push(prompt); if (++calls === 1) throw new GrokTurnLimitError(3); return JSON.stringify(suggestion); } }, [seed("first"), seed("second")]);
  try {
    const job = await f.manager.suggest(paseo, 7);
    const done = await until<SuggestionJob>(async () => (await f.manager.suggestions(job.id)).job, current => !["queued", "collecting", "analyzing"].includes(current.status));
    assert.equal(done.status, "completed"); assert.equal(calls, 2);
    assert.match(prompts[1]!, /上次输出未通过结构或引用检查/, "the second prompt is the compact one");
  } finally { await f.close(); }
});
