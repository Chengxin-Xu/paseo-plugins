import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { getInsightOverview, suggestionJobSchema, suggestionSummarySchema, type SuggestionJob, type SuggestionReport } from "../shared/insight-overview";
import { insightJobSchema, type InsightJob, type InsightReport } from "../shared/insights";
import { AUTO_SUGGESTION_COOLDOWN_MS, MAX_OVERVIEW_BYTES, buildInsightOverview, getInsightWindow, getSuggestionTiming, summarizeSuggestion, type BuildInsightOverviewOptions } from "../server/insight-overview";

const now = Date.parse("2026-09-23T12:00:00Z"), at = new Date(now).toISOString();
const finding = (id: string, severity: "high" | "medium" | "low" = "high", category: InsightReport["findings"][number]["category"] = "failure"): InsightReport["findings"][number] => ({
  id, severity, category, title: `修复 ${id}`, detail: "检查失败后继续重复同一操作。", evidence: ["r1"], recommendation: "先读取错误并确认原因。",
});
function job(id: string, patch: Partial<InsightJob> = {}): InsightJob {
  return { id, agentId: id, agentTitle: `Agent ${id}`, projectName: "项目甲", createdAt: at, updatedAt: at,
    status: "completed", trigger: "manual", stage: "分析完成", eligibility: null, coverage: null, model: "grok-4.7", effort: "xhigh", usage: null, error: null,
    report: { summary: "需要先核对失败原因。", health: "watch", confidence: "high", findings: [finding("f1")], strengths: [], nextActions: [], limitations: [] }, ...patch };
}
const suggestionReport = (): SuggestionReport => ({ headline: "统一验证步骤", summary: "多个会话重复检查同一失败。", themes: [],
  actions: [{ id: "action", title: "增加验证规则", why: "让重复检查有明确退出条件。", steps: ["保存第一次失败的输出。"], scope: "instructions", impact: "high", effort: "small", projects: [], evidence: ["R1"], instruction: "第一次失败后先定位原因。", task: null }], wins: [], watch: [] });
function suggestion(id: string, patch: Partial<SuggestionJob> = {}): SuggestionJob {
  return { id, createdAt: at, updatedAt: at, status: "completed", trigger: "manual", stage: "建议已生成",
    window: { days: 7, from: "2026-09-17", to: "2026-09-23", reports: 3, findings: 3, agents: 3 },
    runner: { kind: "grok", label: "Grok 4.7 · xhigh", provider: null, model: "grok-4.7", thinkingOptionId: "xhigh", modeId: null, sessionAgentId: null },
    usage: null, error: null, report: suggestionReport(), basis: [], ...patch };
}
const base = (patch: Partial<BuildInsightOverviewOptions> = {}): BuildInsightOverviewOptions => ({ jobs: [], suggestionJobs: [], autoEnabled: false, runnerLabel: "Grok 4.7 · xhigh", now, days: 7, utcOffsetMinutes: 0, ...patch });
function full(options: BuildInsightOverviewOptions) { const result = buildInsightOverview(options); assert.equal(result.mode, "full"); if (result.mode !== "full") throw new Error("full expected"); return result; }

test("empty overview follows the RPC contract with every local day and all five categories", () => {
  const result = full(base());
  assert.ok(getInsightOverview.output.safeParse(result).success);
  assert.equal(result.from, "2026-09-17"); assert.equal(result.to, "2026-09-23");
  assert.equal(result.daily.length, 7); assert.equal(result.categories.length, 5); assert.equal(result.totals.reports, 0);
  assert.equal(result.totals.tokens, null); assert.equal(result.nextSuggestionAt, null); assert.equal(result.autoEnabled, false);
  assert.deepEqual(result.findings, []); assert.equal(result.suggestions, null); assert.equal(result.suggestionJob, null);
});

test("local-day bounds respect positive and negative offsets and include the first midnight", () => {
  const localNow = Date.parse("2026-09-23T01:00:00Z");
  const positive = getInsightWindow({ now: localNow, days: 7, utcOffsetMinutes: 480 });
  const negative = getInsightWindow({ now: localNow, days: 30, utcOffsetMinutes: -420 });
  assert.equal(positive.from, "2026-09-17"); assert.equal(new Date(positive.startAt).toISOString(), "2026-09-16T16:00:00.000Z");
  assert.equal(negative.to, "2026-09-22"); assert.equal(negative.from, "2026-08-24"); assert.equal(negative.dayKeys.length, 30);
  const jobs = [job("at-start", { updatedAt: new Date(positive.startAt).toISOString() }), job("before-start", { updatedAt: new Date(positive.startAt - 1).toISOString() }),
    job("now", { updatedAt: new Date(localNow).toISOString() }), job("future", { updatedAt: new Date(localNow + 1).toISOString() }), job("bad-date", { updatedAt: "not-a-date" })];
  const result = full(base({ jobs, now: localNow, utcOffsetMinutes: 480 }));
  assert.equal(result.totals.reports, 2); assert.equal(result.daily[0].watch, 1); assert.equal(result.daily[6].watch, 1);
  assert.throws(() => getInsightWindow({ now, days: 7, utcOffsetMinutes: 841 }), /时间范围/);
});

test("historical counts include every report while open totals and cards use the latest report per Agent", () => {
  const old = job("old-a", { agentId: "a", updatedAt: "2026-09-20T12:00:00Z", trigger: "auto", usage: { inputTokens: 100, outputTokens: 10, costUsd: null } });
  old.report!.health = "blocked";
  const newest = job("new-a", { agentId: "a" });
  newest.report!.findings = [finding("loop", "medium", "loop"), finding("resolved", "high", "quality")];
  newest.findingFeedback = { resolved: { status: "resolved", updatedAt: at }, staleUnknownId: { status: "resolved", updatedAt: at } };
  const blocked = job("b", { projectName: "项目乙", updatedAt: "2026-09-22T12:00:00Z", trigger: "auto", usage: { inputTokens: null, outputTokens: 5, costUsd: null } });
  blocked.report!.health = "blocked"; blocked.report!.findings.push(finding("dismissed", "low", "efficiency"));
  blocked.findingFeedback = { dismissed: { status: "false_positive", updatedAt: at } };
  const healthy = job("c", { projectName: "项目乙" }); healthy.report!.health = "healthy"; healthy.report!.findings = [];
  const result = full(base({ jobs: [old, newest, blocked, healthy, job("failed", { status: "failed", report: null }), job("queued", { status: "queued", report: null })] }));
  assert.deepEqual(result.totals, { reports: 4, agents: 3, projects: 2, auto: 2, manual: 2, failedRuns: 1, openFindings: 2, resolvedFindings: 1, dismissedFindings: 1, highOpen: 1, tokens: 115 });
  assert.deepEqual(result.health, { healthy: 1, watch: 1, blocked: 2 });
  assert.deepEqual(result.findings.map(value => [value.jobId, value.findingId]), [["b", "f1"], ["new-a", "loop"]]);
  assert.deepEqual(result.agents.map(value => value.agentId), ["b", "a"]);
  assert.equal(result.agents[1].reports, 2); assert.equal(result.projects[0].name, "项目乙");
  assert.deepEqual(result.categories.find(value => value.category === "failure"), { category: "failure", high: 2, medium: 0, low: 0, open: 1, resolved: 0 });
  assert.equal(result.categories.find(value => value.category === "quality")?.resolved, 1);
});

test("revision ignores polling time and array order but follows feedback, settings, runners and local-day changes", () => {
  const jobs = [job("a"), job("b")], first = full(base({ jobs }));
  const unchanged = buildInsightOverview(base({ jobs: [...jobs].reverse(), now: now + 600_000, revision: first.revision }));
  assert.deepEqual(unchanged, { mode: "unchanged", unchanged: true, revision: first.revision });
  assert.ok(getInsightOverview.output.safeParse(unchanged).success); assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < 160);
  assert.notEqual(full(base({ jobs, autoEnabled: true })).revision, first.revision);
  assert.notEqual(full(base({ jobs, runnerLabel: "研究 Profile" })).revision, first.revision);
  assert.notEqual(full(base({ jobs, now: now + 86_400_000 })).revision, first.revision);
  const feedbackJobs = structuredClone(jobs); feedbackJobs[0].findingFeedback = { f1: { status: "resolved", updatedAt: at } };
  assert.notEqual(full(base({ jobs: feedbackJobs })).revision, first.revision);
  const outside = job("outside", { updatedAt: "2026-09-01T00:00:00Z" });
  // Historical reports still affect the cross-window suggestion counter, so use a non-report status here.
  assert.equal(full(base({ jobs: [...jobs, { ...outside, status: "failed", report: null }] })).revision, first.revision);
});

test("feedback on an older report preserves the latest analysis and follows updatedAt for daily counts", () => {
  const older = job("older", { agentId: "a", createdAt: "2026-09-19T08:00:00Z", updatedAt: at });
  older.report!.health = "blocked";
  older.report!.findings = [finding("historical-open"), finding("historical-resolved")];
  older.findingFeedback = { "historical-resolved": { status: "resolved", updatedAt: at } };
  const newer = job("newer", { agentId: "a", createdAt: "2026-09-22T08:00:00Z", updatedAt: "2026-09-22T09:00:00Z" });
  newer.report!.findings = [finding("current", "medium", "loop")];
  const options = base({ jobs: [older, newer] }), result = full(options);
  assert.equal(result.agents[0].lastJobId, "newer"); assert.equal(result.agents[0].health, "watch");
  assert.deepEqual(result.findings.map(value => value.findingId), ["current"]);
  assert.equal(result.totals.openFindings, 1); assert.equal(result.totals.highOpen, 0); assert.equal(result.totals.resolvedFindings, 1);
  assert.equal(result.daily[6].blocked, 1); assert.equal(result.daily[5].watch, 1); assert.equal(result.projects[0].lastAt, at);
  assert.equal(full({ ...options, jobs: [newer, older] }).revision, result.revision);
  const tied = { ...newer, id: "a-tie" };
  const tieResult = full(base({ jobs: [newer, tied] }));
  assert.equal(tieResult.agents[0].lastJobId, "a-tie");
  assert.equal(full(base({ jobs: [tied, newer] })).revision, tieResult.revision);
});

test("completed suggestions and active jobs are separate and feedback changes open action counts", () => {
  const done = suggestion("done", { createdAt: "2026-09-22T08:00:00Z", updatedAt: "2026-09-22T08:30:00Z" });
  const failed = suggestion("failed", { createdAt: "2026-09-23T08:00:00Z", status: "failed", report: null });
  const active = suggestion("active", { createdAt: "2026-09-22T10:00:00Z", status: "analyzing", report: null });
  const result = full(base({ suggestionJobs: [failed, done, active] }));
  assert.equal(result.suggestions?.id, "done"); assert.equal(result.suggestionJob?.id, "active"); assert.equal(result.suggestions?.openActions, 1);
  done.feedback = { action: { status: "adopted", updatedAt: at } };
  const changed = full(base({ suggestionJobs: [failed, done, active] }));
  assert.equal(changed.suggestions?.openActions, 0); assert.notEqual(changed.revision, result.revision);
  assert.equal(full(base({ suggestionJobs: [done] })).suggestionJob, null);
  assert.ok(suggestionSummarySchema.safeParse(summarizeSuggestion(done)).success);
});

test("auto suggestion timing requires three reports and preserves a stable due time", () => {
  const jobs = [1, 2, 3].map(index => job(`j${index}`, { updatedAt: new Date(now - (4 - index) * 60_000).toISOString() }));
  assert.equal(getSuggestionTiming({ jobs, suggestionJobs: [], autoEnabled: false, now }).nextSuggestionAt, null);
  assert.equal(getSuggestionTiming({ jobs: jobs.slice(0, 2), suggestionJobs: [], autoEnabled: true, now }).ready, false);
  const ready = getSuggestionTiming({ jobs, suggestionJobs: [], autoEnabled: true, now });
  assert.equal(ready.ready, true); assert.equal(ready.reportsSinceSuggestions, 3); assert.equal(ready.nextSuggestionAt, jobs[2].updatedAt);
  const first = full(base({ jobs, autoEnabled: true }));
  assert.equal(buildInsightOverview(base({ jobs, autoEnabled: true, now: now + 1000, revision: first.revision })).mode, "unchanged");
});

test("automatic cooldown uses attempt creation, not later feedback, and in-flight jobs prevent another queue entry", () => {
  const created = now - AUTO_SUGGESTION_COOLDOWN_MS + 3_600_000;
  const previous = suggestion("previous", { trigger: "auto", createdAt: new Date(created).toISOString(), updatedAt: at, basis: ["old"] });
  const jobs = [job("old"), ...[1, 2, 3].map(index => job(`new${index}`, { updatedAt: new Date(now - index * 60_000).toISOString() }))];
  const timing = getSuggestionTiming({ jobs, suggestionJobs: [previous], autoEnabled: true, now });
  assert.equal(timing.reportsSinceSuggestions, 3); assert.equal(timing.reportsSinceLatestJob, 3); assert.equal(timing.ready, false);
  assert.equal(timing.nextSuggestionAt, new Date(now + 3_600_000).toISOString());
  assert.equal(getSuggestionTiming({ jobs, suggestionJobs: [previous], autoEnabled: true, now: now + 3_600_000 }).ready, true);
  const active = suggestion("active", { status: "queued", report: null, createdAt: new Date(now - 5 * 60_000).toISOString() });
  assert.equal(getSuggestionTiming({ jobs, suggestionJobs: [previous, active], autoEnabled: true, now }).nextSuggestionAt, null);
});

test("equal-timestamp completions count as new unless they are already in the suggestion basis", () => {
  const previous = suggestion("previous", { basis: ["included"] });
  const included = job("included");
  assert.equal(getSuggestionTiming({ jobs: [included], suggestionJobs: [previous], autoEnabled: true, now }).reportsSinceSuggestions, 0);
  const fresh = [1, 2, 3].map(index => job(`fresh-${index}`));
  const result = getSuggestionTiming({ jobs: [included, ...fresh], suggestionJobs: [previous], autoEnabled: true, now });
  assert.equal(result.reportsSinceSuggestions, 3); assert.equal(result.reportsSinceLatestJob, 3);
  assert.equal(result.ready, true); assert.equal(result.nextSuggestionAt, at);
  assert.deepEqual(getSuggestionTiming({ jobs: [...fresh].reverse().concat(included), suggestionJobs: [previous], autoEnabled: true, now }), result);
});

test("a failed latest attempt gates repeat automation but does not hide reports since the latest completed set", () => {
  const completed = suggestion("completed", { createdAt: new Date(now - 86_400_000).toISOString() });
  const failed = suggestion("failed", { createdAt: new Date(now - 60_000).toISOString(), status: "failed", report: null });
  const jobs = [1, 2, 3].map(index => job(`j${index}`, { updatedAt: new Date(now - (index + 1) * 60_000).toISOString() }));
  const timing = getSuggestionTiming({ jobs, suggestionJobs: [completed, failed], autoEnabled: true, now });
  assert.equal(timing.reportsSinceSuggestions, 3); assert.equal(timing.reportsSinceLatestJob, 0); assert.equal(timing.ready, false);
});

test("cards and lists honor count caps and keep exact identifiers", () => {
  const jobs = Array.from({ length: 40 }, (_, index) => job(`j${index}`, { projectName: `项目${index}` }));
  const result = full(base({ jobs }));
  assert.equal(result.projects.length, 12); assert.equal(result.agents.length, 12); assert.equal(result.findings.length, 16);
  assert.equal(result.totals.reports, 40); assert.equal(result.totals.openFindings, 40);
  for (const row of result.findings) assert.ok(jobs.some(job => job.id === row.jobId && job.agentId === row.agentId));
  const oversized = job("x".repeat(129), { agentId: "y".repeat(257) });
  const small = full(base({ jobs: [oversized] }));
  assert.equal(small.totals.reports, 1); assert.equal(small.totals.openFindings, 1); assert.deepEqual(small.agents, []); assert.deepEqual(small.findings, []);
  assert.ok(getInsightOverview.output.safeParse(small).success);
});

test("adversarial UTF8 and JSON-escaped payloads remain under 30 KB including two maximal summaries", t => {
  for (const character of ["字", "\u0000", "\ud800", "🙂"]) {
    const repeat = (length: number) => character.repeat(length).slice(0, length);
    const jobs = Array.from({ length: 60 }, (_, index) => {
      const value = job(`${index}:${repeat(120)}`, { agentId: `${index}:${repeat(248)}`, agentTitle: repeat(1000), projectName: `${index}:${repeat(1000)}`, usage: { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE, costUsd: null } });
      value.report!.findings = Array.from({ length: 12 }, (_, n) => ({ ...finding(`${n}:${repeat(70)}`), title: repeat(180) }));
      return value;
    });
    const done = suggestion(repeat(128), { createdAt: "2026-09-22T08:00:00Z", stage: repeat(400), error: repeat(2000), runner: { ...suggestion("normal").runner, label: repeat(160) } });
    done.report!.headline = repeat(200);
    const failed = suggestion(`f${repeat(127)}`, { createdAt: "2026-09-23T08:00:00Z", status: "failed", stage: repeat(400), error: repeat(2000), report: null, runner: { ...done.runner } });
    assert.ok(jobs.every(value => insightJobSchema.safeParse(value).success)); assert.ok(suggestionJobSchema.safeParse(done).success); assert.ok(suggestionJobSchema.safeParse(failed).success);
    const options = base({ jobs, suggestionJobs: [done, failed], runnerLabel: repeat(160), days: 30 });
    const before = JSON.stringify(options), result = full(options), size = Buffer.byteLength(JSON.stringify(result));
    t.diagnostic(`UTF8 character ${JSON.stringify(character)}: ${size} bytes, ${result.projects.length}/${result.agents.length}/${result.findings.length} cards`);
    assert.ok(size <= MAX_OVERVIEW_BYTES); assert.ok(getInsightOverview.output.safeParse(result).success);
    assert.equal(result.totals.reports, 60); assert.equal(result.totals.openFindings, 720); assert.equal(result.totals.tokens, Number.MAX_SAFE_INTEGER);
    assert.ok(result.projects.length && result.agents.length && result.findings.length); assert.equal(JSON.stringify(options), before);
  }
});

// The client hook reads AppState from react-native (Flow source node cannot load) and RPCs from the host: stub both, in the background.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const stubs: Record<string, unknown> = { "react-native": { AppState: { currentState: "background", addEventListener: () => ({ remove() {} }) } },
  "@getpaseo/plugin/client": { useRpc: () => async () => { throw new Error("a server render never fetches"); } } };
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };
// A server render runs the hook once, without effects or fetches. react-dom has no type declarations here; React Query is
// imported statically above, so it is the same CommonJS instance the hook requires.
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };

test("总览 polling stops while the app is in the background and never refetches on window focus", async () => {
  // Imported only now, after the stubs are in place.
  const { overviewPollMs, useInsightOverview } = await import("../client/use-insight-overview");
  assert.equal(overviewPollMs(true, "analyzing"), 3000); assert.equal(overviewPollMs(true, "completed"), 60_000); assert.equal(overviewPollMs(true, undefined), 60_000);
  assert.equal(overviewPollMs(false, "queued"), false);
  const client = new QueryClient();
  function Overview() { useInsightOverview(7, true); return null; }
  renderToString(createElement(QueryClientProvider, { client }, createElement(Overview)));
  const query = client.getQueryCache().getAll()[0]!, options = query.options as Record<string, unknown>;
  // Shown, with a suggestion job analyzing, but the app is in the background: no read and no 3 s poll.
  query.setData({ revision: "r", data: { suggestionJob: { status: "analyzing" } } });
  assert.equal(options.enabled, false); assert.equal((options.refetchInterval as (value: typeof query) => unknown)(query), false);
  assert.equal(options.refetchOnWindowFocus, false); assert.ok(Number(options.staleTime) >= 5000);
  client.clear();
});
