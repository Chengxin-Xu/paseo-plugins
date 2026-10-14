import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { getInsightOverview, startInsightSuggestions, suggestionJobSchema, suggestionWindowNote, type SuggestionJob, type SuggestionReport } from "../shared/insight-overview";
import type { InsightJob, InsightReport } from "../shared/insights";
import { buildInsightOverview, getInsightWindow, localDayStart } from "../server/insight-overview";
import { collectSuggestionContext } from "../server/insight-suggestions";
import { InsightManager, registerInsights } from "../server/insights";
import { InsightStorage } from "../server/insight-storage";
import { statsZone } from "../server/stats-types";
import { deviceZone } from "../server/analytics";

// 智能分析's 7 / 30 days are the device's local days (grok-F3), across the 2026-11-01 and 2027-03-14 US changes.
const at = (iso: string) => Date.parse(iso), iso = (time: number) => new Date(time).toISOString();
const winter = at("2026-11-03T20:00:00Z"); // 12:00 PST, two days after clocks went back
const report: InsightReport = { summary: "实现已完成，验证流程有可复用之处", health: "watch", confidence: "high",
  findings: [{ id: "f1", severity: "medium", category: "quality", title: "补齐验证", detail: "缺少回归检查", evidence: ["r3"], recommendation: "新增回归检查" }], strengths: ["变更有明确范围"], nextActions: [], limitations: [] };
function job(id: string, finished: number, patch: Partial<InsightJob> = {}): InsightJob {
  return { id, agentId: `agent-${id}`, agentTitle: `会话 ${id}`, projectName: "app", createdAt: iso(finished - 60_000), updatedAt: iso(finished), status: "completed", trigger: "manual", stage: "完成",
    eligibility: null, coverage: null, report: structuredClone(report), model: "grok-4.7", effort: "xhigh", usage: null, error: null, ...patch };
}
const overview = (jobs: InsightJob[], options: { now?: number; days?: 7 | 30; utcOffsetMinutes?: number; timeZone?: string } = {}) => {
  const result = buildInsightOverview({ jobs, suggestionJobs: [], autoEnabled: false, runnerLabel: "Grok", now: options.now ?? winter, days: options.days ?? 7, utcOffsetMinutes: options.utcOffsetMinutes ?? -480, timeZone: options.timeZone });
  assert.equal(result.mode, "full"); if (result.mode !== "full") throw new Error("full expected");
  assert.ok(getInsightOverview.output.safeParse(result).success);
  return result;
};

test("the 7-day window across the fall-back night starts at the device's local midnight, not a fixed-offset or UTC one", () => {
  const window = getInsightWindow({ now: winter, days: 7, utcOffsetMinutes: -480, timeZone: "US/Pacific" });
  assert.deepEqual([window.from, window.to, window.timeZone], ["2026-10-28", "2026-11-03", "US/Pacific"]);
  assert.equal(iso(window.startAt), "2026-10-28T07:00:00.000Z", "10-28 was still daylight time: midnight is 07:00 UTC");
  assert.equal(iso(window.endAt), "2026-11-04T08:00:00.000Z");
  // A fixed −08:00 (the offset on the viewing day) is an hour late at the start; UTC days are 7 or 8 hours off.
  assert.equal(iso(getInsightWindow({ now: winter, days: 7, utcOffsetMinutes: -480 }).startAt), "2026-10-28T08:00:00.000Z");
  const month = getInsightWindow({ now: winter, days: 30, utcOffsetMinutes: -480, timeZone: "US/Pacific" });
  assert.deepEqual([month.from, iso(month.startAt), month.dayKeys.length], ["2026-10-05", "2026-10-05T07:00:00.000Z", 30]);
  // The spring change: 03-10 was still standard time.
  const spring = getInsightWindow({ now: at("2027-03-16T18:00:00Z"), days: 7, utcOffsetMinutes: -420, timeZone: "US/Pacific" });
  assert.deepEqual([spring.from, iso(spring.startAt), iso(spring.endAt)], ["2027-03-10", "2027-03-10T08:00:00.000Z", "2027-03-17T07:00:00.000Z"]);
  // A zone the server does not know, or one that disagrees with the device's offset: the device's fixed offset.
  assert.equal(getInsightWindow({ now: winter, days: 7, utcOffsetMinutes: -480, timeZone: "Mars/Olympus_Mons" }).timeZone, null);
  assert.equal(getInsightWindow({ now: winter, days: 7, utcOffsetMinutes: 330, timeZone: "US/Pacific" }).timeZone, null);
});

test("reports count on the local day they finished, each with the offset in force then", () => {
  const jobs = [
    job("before", at("2026-10-28T06:30:00Z")), // 10-27 23:30 PDT: outside
    job("first", at("2026-10-28T07:30:00Z")), // 10-28 00:30 PDT
    job("halloween", at("2026-10-31T07:30:00Z")), // 10-31 00:30 PDT (a fixed −08:00 says 10-30 23:30)
    job("daylight", at("2026-11-01T08:30:00Z")), // 01:30 PDT
    job("standard", at("2026-11-01T09:30:00Z")), // 01:30 PST, the same wall-clock hour
    job("evening", at("2026-11-03T05:00:00Z")), // 11-02 21:00 PST (UTC already says 11-03)
  ];
  const local = overview(jobs, { timeZone: "US/Pacific" });
  assert.equal(local.timeZone, "US/Pacific"); assert.equal(local.totals.reports, 5);
  const count = (result: typeof local, day: string) => result.daily.find(row => row.day === day)!.watch;
  assert.deepEqual(["2026-10-28", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"].map(day => count(local, day)), [1, 0, 1, 2, 1, 0]);
  // The fixed offset of the viewing day moves the 00:30 PDT report to the evening before and drops the first one.
  const fixed = overview(jobs);
  assert.equal(fixed.timeZone, null); assert.equal(fixed.totals.reports, 4);
  assert.deepEqual(["2026-10-30", "2026-10-31"].map(day => count(fixed, day)), [1, 0]);
  // The zone changes the revision: the same reports in another clock are another overview.
  assert.notEqual(local.revision, fixed.revision);
});

test("local midnight is found exactly, also in zones off by part of an hour and on the change days", () => {
  const pacific = statsZone(-480, "US/Pacific", winter), kathmandu = statsZone(345, "Asia/Kathmandu", winter);
  const day = (text: string) => Date.parse(`${text}T00:00:00Z`) / 86_400_000;
  assert.equal(iso(localDayStart(day("2026-11-01"), pacific)), "2026-11-01T07:00:00.000Z");
  assert.equal(iso(localDayStart(day("2026-11-02"), pacific)), "2026-11-02T08:00:00.000Z");
  assert.equal(iso(localDayStart(day("2027-03-14"), statsZone(-420, "US/Pacific", at("2027-03-16T18:00:00Z")))), "2027-03-14T08:00:00.000Z");
  assert.equal(iso(localDayStart(day("2026-11-03"), kathmandu)), "2026-11-02T18:15:00.000Z");
  assert.equal(iso(localDayStart(day("2026-11-03"), statsZone(0, null, winter))), "2026-11-03T00:00:00.000Z");
});

test("suggestion windows follow the device clock, by name alone too, and say when they are UTC days", () => {
  const jobs = [job("a", at("2026-10-28T07:30:00Z")), job("b", at("2026-10-28T06:30:00Z")), job("c", at("2026-11-02T18:00:00Z"))];
  const local = collectSuggestionContext(jobs, 7, winter, { timeZone: "US/Pacific", utcOffsetMinutes: -480 });
  assert.equal(local.window.from, "2026-10-28T07:00:00.000Z"); assert.equal(local.window.timeZone, "US/Pacific"); assert.equal(local.window.utcOffsetMinutes, -480);
  assert.deepEqual(local.basis.sort(), ["a", "c"], "23:30 PDT the evening before is outside");
  assert.equal(suggestionWindowNote(local.window), null);
  const byName = collectSuggestionContext(jobs, 7, winter, { timeZone: "US/Pacific" });
  assert.deepEqual(byName.window, local.window, "the zone a device reported, without its offset");
  const utc = collectSuggestionContext(jobs, 7, winter, null);
  assert.equal(utc.window.from, "2026-10-28T00:00:00.000Z"); assert.equal(utc.window.timeZone, null); assert.equal(utc.window.utcOffsetMinutes, undefined);
  assert.deepEqual(utc.basis.sort(), ["a", "b", "c"]);
  assert.equal(suggestionWindowNote(utc.window), "按 UTC 日期");
  const fixed = collectSuggestionContext(jobs, 7, winter, { utcOffsetMinutes: -480 });
  assert.equal(fixed.window.from, "2026-10-28T08:00:00.000Z"); assert.equal(suggestionWindowNote(fixed.window), "按 UTC−08:00 的日期");
  // Jobs from 2.13 and older carry neither field: UTC days.
  assert.equal(suggestionWindowNote({}), "按 UTC 日期");
  assert.ok(suggestionJobSchema.shape.window.safeParse(local.window).success && suggestionJobSchema.shape.window.safeParse(utc.window).success);
});

const suggestion: SuggestionReport = { headline: "统一跨项目的验证入口", summary: "多个会话均可改进验证流程", themes: [],
  actions: [{ id: "action1", title: "补齐验证入口", why: "减少重复检查", steps: ["确认各项目的检查命令"], scope: "workflow", impact: "high", effort: "small",
    projects: [], evidence: ["R1#f1"], instruction: "完成变更后执行项目规定的验证命令，并报告结果。", task: null }], wins: [], watch: [] };
const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
async function manager(zone?: () => string | null) {
  const directory = await mkdtemp(join(tmpdir(), "insight-zone-")), storage = new InsightStorage(directory);
  const settings = { autoEnabled: true, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "grok" as const } };
  await storage.saveSettings(settings); await storage.save({ settings, jobs: [job("old1", winter - 3_600_000), job("old2", winter - 7_200_000)], cooldowns: {}, activity: {}, revision: 1 }); await storage.close();
  const instance = new InsightManager({ directory, now: () => winter, findBinary: async () => "/fake/grok", run: async () => JSON.stringify(suggestion), zone });
  return { instance, close: async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function settled(instance: InsightManager, id: string): Promise<SuggestionJob> {
  for (let n = 0; n < 10_000; n++) { const value = (await instance.suggestions(id)).job; if (value && !["queued", "collecting", "analyzing"].includes(value.status)) return value; await tick(); }
  throw new Error("suggestion did not settle");
}

test("background suggestions use the zone a device reported last; without one they are UTC days and say so", async () => {
  const reported = await manager(() => "US/Pacific");
  try {
    const automatic = await reported.instance.suggest(paseo, 7, undefined, "auto");
    assert.equal(automatic.window.timeZone, "US/Pacific", "the queued job already names its clock");
    const done = await settled(reported.instance, automatic.id);
    assert.equal(done.status, "completed"); assert.equal(done.window.from, "2026-10-28T07:00:00.000Z"); assert.equal(done.window.timeZone, "US/Pacific");
    // A manual request brings the client's own clock; it wins over the reported zone.
    const manual = await settled(reported.instance, (await reported.instance.suggest(paseo, 30, undefined, "manual", { timeZone: "Asia/Singapore", utcOffsetMinutes: 480 })).id);
    assert.equal(manual.window.timeZone, "Asia/Singapore"); assert.equal(manual.window.from, "2026-10-05T16:00:00.000Z", "11-04 in Singapore: 30 days from 10-06 00:00 SGT");
  } finally { await reported.close(); }
  const unknown = await manager();
  try {
    const done = await settled(unknown.instance, (await unknown.instance.suggest(paseo, 7, undefined, "auto")).id);
    assert.equal(done.window.from, "2026-10-28T00:00:00.000Z"); assert.equal(done.window.timeZone, null); assert.equal(suggestionWindowNote(done.window), "按 UTC 日期");
  } finally { await unknown.close(); }
});

test("registerInsights passes the clock through: the overview's zone and a manual suggestion's", async () => {
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>>();
  const server = { handle: (contract: { name: string }, handler: never) => { handlers.set(contract.name, handler); }, on: () => () => {} };
  const remove = registerInsights(server as never, { zone: () => "America/New_York" });
  try {
    // The registered manager runs on the real clock: send the offset US/Pacific has right now, as a device there would.
    const offset = Math.round(deviceZone("US/Pacific", null, Date.now())!.offsetAt(Date.now()) / 60_000);
    const result = await handlers.get(getInsightOverview.name)!(getInsightOverview.input.parse({ days: 7, utcOffsetMinutes: offset, timeZone: "US/Pacific" }), { paseo });
    assert.equal((result as { timeZone?: string | null }).timeZone, "US/Pacific");
    assert.ok(startInsightSuggestions.input.safeParse({ days: 7, utcOffsetMinutes: -480, timeZone: "US/Pacific" }).success);
    assert.ok(startInsightSuggestions.input.safeParse({ days: 7 }).success, "older clients still send no clock");
    const queued = await handlers.get(startInsightSuggestions.name)!(startInsightSuggestions.input.parse({ days: 7 }), { paseo }) as SuggestionJob;
    assert.equal(queued.window.timeZone, "America/New_York", "a client without a clock falls back to the zone reported last");
  } finally { await remove(); }
});
