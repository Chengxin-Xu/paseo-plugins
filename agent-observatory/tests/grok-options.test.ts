import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { SessionTrajectory } from "../shared/trajectory";
import { GROK_EFFORTS, insightRunnerSchema, insightSettingsSchema, type InsightReport } from "../shared/insights";
import { BUILTIN_INSIGHT_RUNNER, GROK_RUNNER_DETAIL, InsightRunnerRegistry } from "../server/insight-runner";
import { InsightManager } from "../server/insights";
import { runGrokAnalysis, type GrokRunOptions } from "../server/grok-runner";

const paseo = {} as PaseoApi;
function trajectory(): SessionTrajectory {
  return { agent: { id: "agent-a", title: "Investigate", provider: "codex", model: "m", cwd: "/repo", workspaceId: "w", archivedAt: null, status: "idle", attentionReason: "finished" },
    project: { id: "p", name: "Project", rootPath: "/repo" }, capturedAt: "2026-09-16T12:00:00Z",
    rows: Array.from({ length: 12 }, (_, index) => ({ ref: `ref-${index}`, epoch: "e", seqStart: index, seqEnd: index, at: "2026-09-16T12:00:00Z", turnId: null,
      kind: index < 3 ? "user_message" : index < 6 ? "tool_call" : "assistant_message", text: "Sample evidence", toolName: null, toolStatus: null })),
    coverage: { complete: true, hasOlder: false, hasNewer: false, gap: false, truncated: false, reason: null, projectedItems: 12, characters: 180, pages: 1, firstAt: null, lastAt: null, epoch: "e" },
    counts: { userTurns: 3, assistantMessages: 6, tools: 3, toolFailures: 0, errors: 0, observedTurnIds: 0 }, completionEvidence: { kind: "attention_finished", at: null } };
}
const report: InsightReport = { summary: "执行过程清晰", health: "watch", confidence: "high",
  findings: [{ id: "one", severity: "low", category: "efficiency", title: "减少重复读取", detail: "重复读取相同输出", evidence: ["ref-3"], recommendation: "复用结果" }], strengths: ["已有验证"], nextActions: ["检查结果"], limitations: [] };
const output = () => JSON.stringify({ structured_output: report, usage: { input_tokens: 30, output_tokens: 20 } });

test("the built-in Grok runner accepts an optional model and reasoning effort; old saved settings stay valid", () => {
  assert.deepEqual(insightRunnerSchema.parse({ kind: "grok" }), { kind: "grok" });
  assert.deepEqual(insightRunnerSchema.parse({ kind: "grok", model: "grok-4.6", effort: "high" }), { kind: "grok", model: "grok-4.6", effort: "high" });
  assert.deepEqual([...GROK_EFFORTS], ["xhigh", "high", "medium", "low"]);
  // A model id is passed to the CLI as one argument: no leading dash (an option), no spaces or shell characters.
  for (const model of ["--always-approve", "-m", "grok 4", "grok;rm", "$(id)", "", "x".repeat(81)]) assert.equal(insightRunnerSchema.safeParse({ kind: "grok", model }).success, false, model);
  for (const effort of ["max", "", "XHIGH"]) assert.equal(insightRunnerSchema.safeParse({ kind: "grok", effort }).success, false, effort);
  assert.deepEqual(insightSettingsSchema.parse({ autoEnabled: true, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "grok" } }).runner, { kind: "grok" });
});

test("a saved {kind: grok} resolves to Grok 4.7 · xhigh; a configured model and effort replace them", async () => {
  const registry = new InsightRunnerRegistry(paseo, { findBinary: async () => "/fake/grok" });
  const saved = await registry.resolve({ kind: "grok" });
  assert.deepEqual([saved.model, saved.effort, saved.info], ["grok-4.7", "xhigh", BUILTIN_INSIGHT_RUNNER]);
  const custom = await registry.resolve({ kind: "grok", model: "grok-4.6", effort: "high" });
  assert.deepEqual([custom.model, custom.effort, custom.info.label, custom.info.model, custom.info.thinkingOptionId, custom.access], ["grok-4.6", "high", "Grok 4.6 · high", "grok-4.6", "high", "none"]);
  assert.equal((await registry.resolve({ kind: "grok", model: "grok-4.7-build-fast" })).info.label, "grok-4.7-build-fast · xhigh");
});

test("the analysis passes the saved Grok model and effort to the CLI, and the settings file keeps an unchanged choice as written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-grok-options-"));
  await writeFile(join(directory, "insight-settings.json"), JSON.stringify({ version: 2, settings: { autoEnabled: true, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "grok" } } }));
  const calls: GrokRunOptions[] = [];
  let manager = new InsightManager({ directory, findBinary: async () => "/fake/grok", fetch: async () => trajectory(), run: async options => { calls.push(options); return output(); } });
  try {
    const state = await manager.state();
    assert.deepEqual(state.settings.runner, { kind: "grok" }); assert.equal((await manager.list()).runnerLabel, "Grok 4.7 · xhigh");
    const first = await manager.start(paseo, "agent-a");
    for (let index = 0; index < 200 && (await manager.state()).jobs.find(job => job.id === first.id)?.status !== "completed"; index++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.deepEqual([calls[0].model, calls[0].effort], ["grok-4.7", "xhigh"]);
    assert.deepEqual([(await manager.state()).jobs[0].model, (await manager.state()).jobs[0].effort], ["grok-4.7", "xhigh"]);
    await manager.close();
    // Reading and saving an unchanged choice keeps the file's runner exactly as it was.
    assert.deepEqual(JSON.parse(await readFile(join(directory, "insight-settings.json"), "utf8")).settings.runner, { kind: "grok" });

    manager = new InsightManager({ directory, findBinary: async () => "/fake/grok", fetch: async () => trajectory(), run: async options => { calls.push(options); return output(); } });
    await manager.configure({ runner: { kind: "grok", model: "grok-4.6", effort: "medium" } });
    assert.equal((await manager.list()).runnerLabel, "Grok 4.6 · medium");
    const runners = await manager.runners({ config: { get: async () => ({ config: { providers: {}, agentProfiles: [] } }) }, providers: { snapshot: async () => ({ entries: [] }) } } as unknown as PaseoApi);
    assert.deepEqual([runners.builtin.runner, runners.builtin.label, runners.builtin.modelLabel, runners.builtin.thinkingLabel], [{ kind: "grok", model: "grok-4.6", effort: "medium" }, "Grok 4.6 · medium", "Grok 4.6", "medium"]);
    // Says what really happens (opus-F71, opus-F72): Grok does keep a session per run, which the observatory deletes.
    assert.equal(runners.builtin.detail, GROK_RUNNER_DETAIL); assert.match(runners.builtin.detail ?? "", /拒绝/); assert.match(runners.builtin.detail ?? "", /删除/);
    const second = await manager.start(paseo, "agent-b");
    for (let index = 0; index < 200 && (await manager.state()).jobs.find(job => job.id === second.id)?.status !== "completed"; index++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.deepEqual([calls[1].model, calls[1].effort], ["grok-4.6", "medium"]);
    const job = (await manager.state()).jobs.find(item => item.id === second.id)!;
    assert.deepEqual([job.model, job.effort, job.runner?.label], ["grok-4.6", "medium", "Grok 4.6 · medium"]);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the Grok CLI gets the configured model and reasoning effort, xhigh by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fake-grok-options-")); const executable = join(directory, "grok-fake");
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2)}));\n', { mode: 0o700 });
  try {
    const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
    // A scratch GROK_HOME and temp root keep the run's session cleanup away from the real ~/.grok.
    const scratch = { grokHome: join(directory, "grok-home"), tmp: directory };
    const defaults = JSON.parse(await runGrokAnalysis({ binary: executable, prompt: "p", signal: new AbortController().signal, timeoutMs: 2000, ...scratch })).args as string[];
    assert.deepEqual([value(defaults, "--model"), value(defaults, "--reasoning-effort")], ["grok-4.7", "xhigh"]);
    const chosen = JSON.parse(await runGrokAnalysis({ binary: executable, prompt: "p", signal: new AbortController().signal, timeoutMs: 2000, model: "grok-4.6", effort: "low", ...scratch })).args as string[];
    assert.deepEqual([value(chosen, "--model"), value(chosen, "--reasoning-effort")], ["grok-4.6", "low"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
