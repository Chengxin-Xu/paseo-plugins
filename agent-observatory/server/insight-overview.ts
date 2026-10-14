import { createHash } from "node:crypto";
import { FINDING_CATEGORIES, type InsightOverview, type InsightOverviewResponse, type OverviewDays, type SuggestionJob, type SuggestionSummary } from "../shared/insight-overview";
import type { InsightJob } from "../shared/insights";
import { statsDayText, statsLocalDay, statsZone, type StatsZone } from "./stats-types";

const DAY_MS = 24 * 60 * 60 * 1000, QUARTER_MS = 15 * 60_000;
export const AUTO_SUGGESTION_COOLDOWN_MS = 20 * 60 * 60 * 1000;
export const MAX_OVERVIEW_BYTES = 30_000;
const ACTIVE = new Set(["queued", "collecting", "analyzing"]);
const severityOrder = { high: 0, medium: 1, low: 2 };
const healthOrder = { blocked: 0, watch: 1, healthy: 2 };
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const timestamp = (value: string) => { const result = Date.parse(value); return Number.isFinite(result) ? result : 0; };
const latestCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => timestamp(b.createdAt) - timestamp(a.createdAt) || compareText(a.id, b.id);
const latestUpdated = (a: InsightJob, b: InsightJob) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || latestCreated(a, b);
const latestReport = (a: InsightJob, b: InsightJob) => timestamp(b.createdAt) - timestamp(a.createdAt) || latestUpdated(a, b);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Display text only: never shorten an Agent, report, finding or suggestion identifier. */
function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = maximum - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end) + "…";
}
const boundedDate = (value: string) => { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toISOString() : clip(value, 40); };

/**
 * The device's clock (grok-F3): `utcOffsetMinutes` now, and its IANA `timeZone` when the client knows it. A known zone
 * that agrees with the offset gives every instant its own offset (statsZone); otherwise the fixed offset.
 */
export interface InsightWindowOptions { now: number; days: OverviewDays; utcOffsetMinutes: number; timeZone?: string | null }
export interface InsightWindow {
  /** Inclusive local dates, and their UTC interval [startAt, endAt). */
  from: string; to: string; startAt: number; endAt: number; dayKeys: string[];
  /** The zone the days follow; `timeZone` null: the fixed offset. */
  zone: StatsZone; timeZone: string | null;
}
/**
 * The first instant of local day `day` (days since 1970-01-01 in the zone's wall time). Offsets and the instants they
 * change at are whole quarter hours, so stepping by 15 minutes from the UTC midnight's guess lands on it exactly, also
 * on a day that starts at 01:00 because the clocks skipped midnight.
 */
export function localDayStart(day: number, zone: StatsZone): number {
  let at = day * DAY_MS - zone.offsetAt(day * DAY_MS);
  while (statsLocalDay(at - QUARTER_MS, zone) >= day) at -= QUARTER_MS;
  while (statsLocalDay(at, zone) < day) at += QUARTER_MS;
  return at;
}
/** Today and the `days − 1` local days before it, from local midnight to the next one, each day by its own offset. */
export function getInsightWindow({ now, days, utcOffsetMinutes, timeZone }: InsightWindowOptions): InsightWindow {
  if (!Number.isFinite(now) || (days !== 7 && days !== 30) || !Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 840) throw new Error("总览时间范围无效");
  const zone = statsZone(utcOffsetMinutes, timeZone, now), today = statsLocalDay(now, zone), first = today - (days - 1);
  const dayKeys = Array.from({ length: days }, (_, index) => statsDayText(first + index));
  return { from: dayKeys[0], to: dayKeys[days - 1], startAt: localDayStart(first, zone), endAt: localDayStart(today + 1, zone), dayKeys, zone, timeZone: zone.name };
}

/** A bounded list projection; full suggestion text and evidence remain in the detail RPC. */
export function summarizeSuggestion(job: SuggestionJob): SuggestionSummary {
  const actions = job.report?.actions ?? [];
  return { id: job.id, createdAt: boundedDate(job.createdAt), updatedAt: boundedDate(job.updatedAt), status: job.status, trigger: job.trigger,
    stage: clip(job.stage, 400), window: { ...job.window, from: clip(job.window.from, 40), to: clip(job.window.to, 40) },
    runnerLabel: clip(job.runner.label, 160), error: job.error === null ? null : clip(job.error, 400),
    headline: job.report ? clip(job.report.headline, 200) : null, themes: job.report?.themes.length ?? 0, actions: actions.length,
    openActions: actions.filter(action => !job.feedback?.[action.id] || job.feedback[action.id].status === "open").length };
}

export interface SuggestionTimingOptions { jobs: readonly InsightJob[]; suggestionJobs: readonly SuggestionJob[]; autoEnabled: boolean; now: number }
export interface SuggestionTiming {
  /** Since the latest completed set, for the overview's explanatory count. */
  reportsSinceSuggestions: number;
  /** Since the latest attempt, to avoid repeatedly retrying the same failed input. */
  reportsSinceLatestJob: number;
  nextSuggestionAt: string | null; ready: boolean;
}
export function getSuggestionTiming({ jobs, suggestionJobs, autoEnabled, now }: SuggestionTimingOptions): SuggestionTiming {
  const ordered = [...suggestionJobs].filter(job => timestamp(job.createdAt) <= now).sort(latestCreated);
  const latest = ordered[0], completed = ordered.find(job => job.status === "completed" && job.report), automatic = ordered.find(job => job.trigger === "auto");
  const reports = jobs.filter(job => job.status === "completed" && job.report && Number.isFinite(Date.parse(job.updatedAt)) && timestamp(job.updatedAt) <= now);
  const since = (job: SuggestionJob | undefined) => {
    const basis = new Set(job?.basis ?? []), after = job ? timestamp(job.createdAt) : -Infinity;
    // Jobs can complete in the same clock tick as the suggestion starts. Its recorded basis distinguishes the
    // already-read reports from later completions without dropping all equal-timestamp reports.
    return reports.filter(report => timestamp(report.updatedAt) >= after && !basis.has(report.id)).sort(latestUpdated);
  };
  const fresh = since(latest), reportsSinceSuggestions = since(completed).length;
  if (!autoEnabled || fresh.length < 3 || ordered.some(job => ACTIVE.has(job.status))) return { reportsSinceSuggestions, reportsSinceLatestJob: fresh.length, nextSuggestionAt: null, ready: false };
  // The earliest three fresh reports establish eligibility. Never use `now` in the returned deadline: polling must
  // keep the same revision after this deadline passes, until the queue or source reports actually change.
  const thirdAt = timestamp(fresh[fresh.length - 3].updatedAt);
  const due = Math.max(thirdAt, automatic ? timestamp(automatic.createdAt) + AUTO_SUGGESTION_COOLDOWN_MS : -Infinity);
  return { reportsSinceSuggestions, reportsSinceLatestJob: fresh.length, nextSuggestionAt: new Date(due).toISOString(), ready: due <= now };
}

export interface BuildInsightOverviewOptions extends InsightWindowOptions {
  jobs: readonly InsightJob[]; suggestionJobs: readonly SuggestionJob[];
  autoEnabled: boolean; runnerLabel: string; revision?: string;
}

function fitOverview(data: InsightOverview): void {
  const fullBytes = () => bytes({ ...data, mode: "full", unchanged: false, revision: "0".repeat(64) });
  if (fullBytes() <= MAX_OVERVIEW_BYTES) return;
  // Controls, astral characters and escaped surrogates can exceed a character-based estimate by several times.
  // Shorten display text before dropping the least-prioritized cards; all aggregate counts stay exact.
  data.runnerLabel = clip(data.runnerLabel, 80);
  for (const project of data.projects) project.name = clip(project.name, 80);
  for (const agent of data.agents) { agent.title = clip(agent.title, 80); agent.projectName = clip(agent.projectName, 80); }
  for (const finding of data.findings) { finding.agentTitle = clip(finding.agentTitle, 80); finding.projectName = clip(finding.projectName, 80); finding.title = clip(finding.title, 100); }
  for (const summary of [data.suggestions, data.suggestionJob]) if (summary) {
    summary.runnerLabel = clip(summary.runnerLabel, 80); summary.stage = clip(summary.stage, 100);
    if (summary.error !== null) summary.error = clip(summary.error, 160);
    if (summary.headline !== null) summary.headline = clip(summary.headline, 120);
  }
  while (fullBytes() > MAX_OVERVIEW_BYTES) {
    const largest = [data.findings, data.agents, data.projects].filter(rows => rows.length).sort((a, b) => bytes(b) - bytes(a))[0];
    if (!largest) throw new Error("总览摘要超过传输容量");
    largest.pop();
  }
}

/** Historical distributions cover every report; outstanding work uses only each Agent's latest report. */
export function buildInsightOverview(options: BuildInsightOverviewOptions): InsightOverviewResponse {
  const { jobs, suggestionJobs, autoEnabled, runnerLabel, now, days, utcOffsetMinutes } = options;
  const range = getInsightWindow(options);
  const inWindow = (job: InsightJob) => { const at = Date.parse(job.updatedAt); return at >= range.startAt && at < range.endAt && at <= now; };
  // Feedback changes updatedAt, so report creation order chooses each Agent's current analysis. The requested
  // window and daily history still use updatedAt; ties use updatedAt then id for deterministic snapshots.
  const reports = jobs.filter(job => job.status === "completed" && job.report && inWindow(job)).sort(latestReport);
  const daily = range.dayKeys.map(day => ({ day, healthy: 0, watch: 0, blocked: 0 }));
  const dailyByDay = new Map(daily.map(day => [day.day, day]));
  const categories: InsightOverview["categories"] = FINDING_CATEGORIES.map(category => ({ category, high: 0, medium: 0, low: 0, open: 0, resolved: 0 }));
  const categoryByName = new Map(categories.map(category => [category.category, category]));
  const projectByName = new Map<string, InsightOverview["projects"][number]>();
  const agentById = new Map<string, InsightOverview["agents"][number]>();
  const latestByAgent = new Map<string, InsightJob>();
  const totals: InsightOverview["totals"] = { reports: reports.length, agents: 0, projects: 0, auto: 0, manual: 0,
    failedRuns: jobs.filter(job => job.status === "failed" && inWindow(job)).length,
    openFindings: 0, resolvedFindings: 0, dismissedFindings: 0, highOpen: 0, tokens: null };
  const health = { healthy: 0, watch: 0, blocked: 0 };
  for (const job of reports) {
    const report = job.report!;
    totals[job.trigger]++; health[report.health]++;
    // The local day it finished on, with the offset in force then (a report from before a daylight-saving change too).
    // A zone that falls back across midnight can put the window's first hour on the day before: it counts in the totals only.
    const day = dailyByDay.get(statsDayText(statsLocalDay(timestamp(job.updatedAt), range.zone)));
    if (day) day[report.health]++;
    let project = projectByName.get(job.projectName);
    if (!project) { project = { name: clip(job.projectName, 240), reports: 0, openFindings: 0, highOpen: 0, blocked: 0, lastAt: boundedDate(job.updatedAt) }; projectByName.set(job.projectName, project); }
    if (timestamp(job.updatedAt) > timestamp(project.lastAt)) project.lastAt = boundedDate(job.updatedAt);
    project.reports++; if (report.health === "blocked") project.blocked++;
    let agent = agentById.get(job.agentId);
    if (!agent) {
      agent = { agentId: job.agentId, title: clip(job.agentTitle, 240), projectName: clip(job.projectName, 240), reports: 0,
        health: report.health, openFindings: 0, highOpen: 0, lastJobId: job.id, lastAt: boundedDate(job.updatedAt) };
      agentById.set(job.agentId, agent); latestByAgent.set(job.agentId, job);
    }
    agent.reports++;
    for (const finding of report.findings) {
      const category = categoryByName.get(finding.category)!; category[finding.severity]++;
      const status = job.findingFeedback?.[finding.id]?.status ?? "open";
      if (status === "resolved") { totals.resolvedFindings++; category.resolved++; }
      else if (status === "false_positive") totals.dismissedFindings++;
    }
    for (const amount of [job.usage?.inputTokens, job.usage?.outputTokens]) if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
      totals.tokens = Math.min(Number.MAX_SAFE_INTEGER, (totals.tokens ?? 0) + amount);
    }
  }
  const findings: InsightOverview["findings"] = [];
  for (const [agentId, job] of latestByAgent) {
    const agent = agentById.get(agentId)!, project = projectByName.get(job.projectName)!;
    for (const finding of job.report!.findings) {
      if ((job.findingFeedback?.[finding.id]?.status ?? "open") !== "open") continue;
      totals.openFindings++; agent.openFindings++; project.openFindings++; categoryByName.get(finding.category)!.open++;
      if (finding.severity === "high") { totals.highOpen++; agent.highOpen++; project.highOpen++; }
      if (job.id.length > 128 || job.agentId.length > 256 || finding.id.length > 80) continue;
      findings.push({ jobId: job.id, findingId: finding.id, agentId: job.agentId, agentTitle: clip(job.agentTitle, 240),
        projectName: clip(job.projectName, 240), title: clip(finding.title, 180), category: finding.category,
        severity: finding.severity, status: "open", at: boundedDate(job.updatedAt) });
    }
  }
  totals.agents = agentById.size; totals.projects = projectByName.size;
  const projects = [...projectByName.entries()].sort(([aName, a], [bName, b]) => b.openFindings - a.openFindings || b.highOpen - a.highOpen || timestamp(b.lastAt) - timestamp(a.lastAt) || compareText(aName, bName)).slice(0, 12).map(([, project]) => project);
  const agents = [...agentById.values()].filter(agent => agent.agentId.length <= 256 && agent.lastJobId.length <= 128 && (agent.openFindings || agent.health === "blocked" || agent.health === "watch"))
    .sort((a, b) => b.highOpen - a.highOpen || healthOrder[a.health ?? "healthy"] - healthOrder[b.health ?? "healthy"] || b.openFindings - a.openFindings || timestamp(b.lastAt) - timestamp(a.lastAt) || compareText(a.agentId, b.agentId)).slice(0, 12);
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || timestamp(b.at) - timestamp(a.at) || compareText(a.jobId, b.jobId) || compareText(a.findingId, b.findingId));
  const suggestionOrder = [...suggestionJobs].filter(job => timestamp(job.createdAt) <= now).sort(latestCreated);
  const completed = suggestionOrder.find(job => job.status === "completed" && job.report);
  const activeOrLatest = suggestionOrder.find(job => ACTIVE.has(job.status)) ?? suggestionOrder[0];
  const timing = getSuggestionTiming({ jobs, suggestionJobs, autoEnabled, now });
  const data: InsightOverview = { generatedAt: new Date(now).toISOString(), days, utcOffsetMinutes, timeZone: range.timeZone, from: range.from, to: range.to,
    autoEnabled, runnerLabel: clip(runnerLabel, 160), totals, health, daily, categories, projects, agents, findings: findings.slice(0, 16),
    suggestions: completed ? summarizeSuggestion(completed) : null,
    suggestionJob: activeOrLatest && activeOrLatest.id !== completed?.id ? summarizeSuggestion(activeOrLatest) : null,
    nextSuggestionAt: timing.nextSuggestionAt, reportsSinceSuggestions: timing.reportsSinceSuggestions };
  fitOverview(data);
  const { generatedAt: _generatedAt, ...content } = data;
  const revision = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return options.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { ...data, mode: "full", unchanged: false, revision };
}
