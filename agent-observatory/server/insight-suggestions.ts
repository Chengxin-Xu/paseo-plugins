import { languageName } from "./locales";
import { currentLanguage, onTextChange } from "../shared/i18n";
import { t } from "../shared/text";
import { FINDING_CATEGORIES, suggestionReportSchema, type FindingCategory, type FindingSeverity, type OverviewDays, type SuggestionEvidence, type SuggestionJob, type SuggestionReport } from "../shared/insight-overview";
import type { FindingFeedback, InsightJob } from "../shared/insights";
import { excerptText } from "../shared/evidence";
import { InsightReportError, parseInsightOutput, redactSecrets, redactStrings } from "./insight-analysis";
import { deviceZone } from "./analytics";
import { localDayStart } from "./insight-overview";
import { statsLocalDay, type StatsZone } from "./stats-types";

export const MAX_SUGGESTION_REPORTS = 60;
export const MAX_SUGGESTION_PROMPT_CHARACTERS = 120000;
const DATA_CHARACTERS = 112000;
const DAY = 86400000;
const stamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const safeText = (value: string, maximum: number) => excerptText(redactSecrets(value), maximum).text;
const statusOf = (job: InsightJob, id: string): FindingFeedback["status"] => job.findingFeedback?.[id]?.status ?? "open";
const serialize = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

export interface SuggestionContextReport {
  ref: string; jobId: string; agentId: string; agentTitle: string; projectName: string; model: string; at: string;
  health: "healthy" | "watch" | "blocked"; summary: string;
  findings: { ref: string; id: string; severity: FindingSeverity; category: FindingCategory; status: FindingFeedback["status"]; title: string; detail: string; recommendation: string }[];
  strengths: string[]; nextActions: string[];
}
export interface SuggestionContext {
  window: SuggestionJob["window"];
  basis: string[];
  /** Newest source report, independent of the priority ordering used in the prompt. */
  parentJob: InsightJob | null;
  reports: SuggestionContextReport[];
  references: Record<string, SuggestionEvidence>;
  aggregates: {
    sourceReports: number; sourceAgents: number;
    categories: { category: FindingCategory; high: number; medium: number; low: number; open: number; resolved: number; falsePositive: number }[];
    projects: { name: string; reports: number; openFindings: number; highOpen: number; resolved: number }[];
  };
  truncated: boolean;
  eligible: boolean;
  reason: string;
}

/**
 * The device's clock for a suggestion window: the requesting client's (manual), else the zone a client reported last
 * (automatic work, DeviceZone). Either may be missing.
 */
export interface SuggestionClock { timeZone?: string | null; utcOffsetMinutes?: number | null }
/** The zone a clock resolves to (deviceZone); null: none usable, the window is UTC days. */
export const suggestionZone = (clock: SuggestionClock | null | undefined, now: number): StatsZone | null => deviceZone(clock?.timeZone, clock?.utcOffsetMinutes, now);
/** What a window records of its clock (shared/insight-overview: `timeZone` null and no offset is UTC days). */
export function windowClock(zone: StatsZone | null, now: number): Pick<SuggestionJob["window"], "timeZone" | "utcOffsetMinutes"> {
  return zone ? { timeZone: zone.name, utcOffsetMinutes: Math.round(zone.offsetAt(now) / 60_000) } : { timeZone: null };
}

/**
 * The window is `days` local days of the device's clock, inclusive of today through now (grok-F3): from local midnight
 * `days − 1` days back, each day by its own offset, so a US evening is still today and the start moves with daylight
 * saving. Without any device clock it is UTC calendar days, and the window says so (`timeZone` null, no offset).
 */
export function collectSuggestionContext(jobs: readonly InsightJob[], days: OverviewDays, now: number, clock?: SuggestionClock | null): SuggestionContext {
  const zone = suggestionZone(clock, now);
  const from = zone ? localDayStart(statsLocalDay(now, zone) - (days - 1), zone) : Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const latest = new Map<string, InsightJob>();
  for (const job of jobs) {
    const at = Date.parse(job.updatedAt);
    if (job.status !== "completed" || !job.report || !Number.isFinite(at) || at < from || at > now || job.id.length > 128 || job.agentId.length > 256) continue;
    if (!latest.has(job.id) || stamp(latest.get(job.id)!.updatedAt) < at) latest.set(job.id, job);
  }
  const newest = [...latest.values()].sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || a.id.localeCompare(b.id));
  const categories = FINDING_CATEGORIES.map(category => ({ category, high: 0, medium: 0, low: 0, open: 0, resolved: 0, falsePositive: 0 }));
  const projects = new Map<string, { name: string; reports: number; openFindings: number; highOpen: number; resolved: number }>();
  for (const job of newest) {
    const project = projects.get(job.projectName) ?? { name: safeText(job.projectName, 240), reports: 0, openFindings: 0, highOpen: 0, resolved: 0 };
    project.reports++;
    for (const finding of job.report!.findings) {
      const category = categories.find(value => value.category === finding.category)!;
      category[finding.severity]++;
      const status = statusOf(job, finding.id);
      if (status === "open") { category.open++; project.openFindings++; if (finding.severity === "high") project.highOpen++; }
      if (status === "resolved") { category.resolved++; project.resolved++; }
      if (status === "false_positive") category.falsePositive++;
    }
    projects.set(job.projectName, project);
  }
  const aggregates: SuggestionContext["aggregates"] = { sourceReports: newest.length, sourceAgents: new Set(newest.map(job => job.agentId)).size, categories,
    projects: [...projects.values()].sort((a, b) => b.openFindings - a.openFindings || b.highOpen - a.highOpen || b.reports - a.reports || a.name.localeCompare(b.name)).slice(0, 12) };
  const priority = (job: InsightJob) => Number(job.report!.findings.some(finding => finding.severity !== "low" && statusOf(job, finding.id) === "open"));
  const candidates = [...newest].sort((a, b) => priority(b) - priority(a) || stamp(b.updatedAt) - stamp(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, MAX_SUGGESTION_REPORTS);
  const reports: SuggestionContextReport[] = [];
  let trimmed = false;
  for (const job of candidates) {
    const ref = `R${reports.length + 1}`, report = job.report!;
    trimmed ||= report.strengths.length > 6 || report.nextActions.length > 6;
    let scale = 1;
    const text = (value: string, maximum: number) => { const result = safeText(value, Math.max(20, Math.floor(maximum * scale))); trimmed ||= result !== redactSecrets(value); return result; };
    const makeRow = (): SuggestionContextReport => ({ ref, jobId: job.id, agentId: job.agentId, agentTitle: text(job.agentTitle, 240), projectName: text(job.projectName, 240), model: text(job.runner?.model ?? job.model, 240), at: new Date(stamp(job.updatedAt)).toISOString(),
      health: report.health, summary: text(report.summary, 1200),
      findings: report.findings.map(finding => ({ ref: `${ref}#${finding.id}`, id: finding.id, severity: finding.severity, category: finding.category, status: statusOf(job, finding.id),
        title: text(finding.title, 180), detail: text(finding.detail, 700), recommendation: text(finding.recommendation, 500) })),
      strengths: report.strengths.slice(0, 6).map(value => text(value, 350)), nextActions: report.nextActions.slice(0, 6).map(value => text(value, 350)) });
    let row = makeRow();
    // Escape-heavy report text must not consume the entire window and exclude a second valid report.
    while (serialize(row).length > 36000 && scale > 0.02) { scale *= 0.5; row = makeRow(); }
    if (serialize({ aggregates, reports: [...reports, row] }).length > DATA_CHARACTERS) break;
    reports.push(row);
  }
  const references: Record<string, SuggestionEvidence> = {};
  for (const report of reports) {
    const base = { jobId: report.jobId, agentId: report.agentId, agentTitle: report.agentTitle, projectName: report.projectName };
    references[report.ref] = { ...base, findingId: null, title: safeText(report.summary, 180), severity: null, category: null };
    for (const finding of report.findings) references[finding.ref] = { ...base, findingId: finding.id, title: finding.title, severity: finding.severity, category: finding.category };
  }
  const eligible = reports.length >= 2;
  return { window: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString(), reports: reports.length,
    findings: reports.reduce((sum, report) => sum + report.findings.length, 0), agents: new Set(reports.map(report => report.agentId)).size, ...windowClock(zone, now) },
    basis: reports.map(report => report.jobId), parentJob: newest[0] ?? null, reports, references, aggregates,
    truncated: trimmed || reports.length < newest.length, eligible,
    reason: eligible ? t("serverInsightSuggestions.m001", { value1: reports.length, value2: new Set(reports.map(report => report.agentId)).size }) : t("serverInsightSuggestions.m002", { days: days, value2: reports.length }) };
}

export let SUGGESTION_SYSTEM_PROMPT = t("serverInsightSuggestions.m003", { language: currentLanguage(), languageName: languageName() });
export function buildSuggestionPrompt(context: SuggestionContext, options: { compact?: boolean } = {}): string {
  const instructions = [SUGGESTION_SYSTEM_PROMPT,
    t("serverInsightSuggestions.m004"),
    t("serverInsightSuggestions.m005", { language: currentLanguage(), languageName: languageName() }),
    t("serverInsightSuggestions.m006"),
    t("serverInsightSuggestions.m007"),
    t("serverInsightSuggestions.m008"),
    t("serverInsightSuggestions.m009"),
    t("serverInsightSuggestions.m010"),
    options.compact ? t("serverInsightSuggestions.m011") : "",
  ].filter(Boolean).join("\n\n");
  const compactText = (value: string, maximum: number) => safeText(value, Math.min(maximum, Math.ceil(value.length * 0.55)));
  const reports = options.compact ? context.reports.map(report => ({ ...report, summary: compactText(report.summary, 500),
    findings: report.findings.map(finding => ({ ...finding, detail: compactText(finding.detail, 260), recommendation: compactText(finding.recommendation, 220) })),
    strengths: report.strengths.map(value => compactText(value, 180)), nextActions: report.nextActions.map(value => compactText(value, 180)) })) : context.reports;
  const prompt = `${instructions}\n\n<reports_data>${serialize({ window: context.window, aggregates: context.aggregates, truncated: context.truncated || !!options.compact, reports })}</reports_data>`;
  if (prompt.length > MAX_SUGGESTION_PROMPT_CHARACTERS) throw new Error(t("serverInsightSuggestions.m012"));
  return prompt;
}

export function parseSuggestionText(output: string, references: Readonly<Record<string, SuggestionEvidence>>): { report: SuggestionReport; evidence: Record<string, SuggestionEvidence>; usage: InsightJob["usage"] } {
  const { data, usage } = parseInsightOutput(output, value => suggestionReportSchema.safeParse(value).success);
  const parsed = suggestionReportSchema.safeParse(redactStrings(data));
  if (!parsed.success) throw new InsightReportError(t("serverInsightSuggestions.m013"), usage);
  const known = (refs: string[]) => [...new Set(refs.filter(ref => Object.prototype.hasOwnProperty.call(references, ref)))];
  const report = parsed.data;
  const actionIds = new Set<string>(), themeIds = new Set<string>();
  report.themes = report.themes.flatMap(theme => {
    const evidence = known(theme.evidence);
    if (!evidence.length || themeIds.has(theme.id)) return [];
    themeIds.add(theme.id); return [{ ...theme, evidence }];
  });
  report.actions = report.actions.flatMap(action => {
    const evidence = known(action.evidence);
    if (!evidence.length || actionIds.has(action.id) || !(action.steps.some(step => step.trim()) || action.instruction?.trim() || action.task?.trim())) return [];
    actionIds.add(action.id); return [{ ...action, evidence }];
  });
  if (!report.actions.length) throw new InsightReportError(t("serverInsightSuggestions.m014"), usage);
  const refs = new Set([...report.themes.flatMap(theme => theme.evidence), ...report.actions.flatMap(action => action.evidence)]);
  return { report, evidence: Object.fromEntries([...refs].map(ref => [ref, { ...references[ref] }])), usage };
}

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  SUGGESTION_SYSTEM_PROMPT = t("serverInsightSuggestions.m003", { language: currentLanguage(), languageName: languageName() });
});
