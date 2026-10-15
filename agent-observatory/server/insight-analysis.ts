import { currentLanguage } from "../shared/i18n";
import { languageName } from "./locales";
import { t } from "../shared/text";
import { createHash } from "node:crypto";
import { insightReportSchema, type InsightReport, type InsightJob } from "../shared/insights";
import type { SessionTrajectory, TrajectoryRow } from "../shared/trajectory";
import { excerptText } from "../shared/evidence";

// Credential shapes that are masked before a trajectory leaves the host. Every pattern stays linear on hostile input: a JWT
// only starts where the previous character cannot belong to it, and no two quantifiers compete for the same run. A value that
// is already a `[… redacted]` marker is left alone.
/** A PEM private key: header to footer, or to the end of the text when an excerpt cut the block. */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** header.payload.signature, both JSON parts base64url (`eyJ` is `{"`); an unsigned token has an empty signature. */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
/**
 * Vendor prefixes: OpenAI/Stripe-style sk-/pk-/rk-, GitHub gh?_ and github_pat_, xAI, Groq, AWS access keys (long-term and
 * temporary), Google API keys, OAuth tokens and client secrets, Slack bot/user/app/refresh tokens, GitLab, npm, Hugging Face,
 * SendGrid, Stripe webhook secrets, Composio. A prefix also counts right after a JSON escape such as `\n`.
 */
const PREFIXED = /(?:\b|(?<=\\[nrt]))(?:(?:sk|pk|rk|gh[pousr]|github_pat|xai)[-_][A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gl(?:pat|dt|rt|ptt|cbt|ft|oas|soat|imt|agent|wt)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9]{24,}|gsk_[A-Za-z0-9]{40,}|ak_[A-Za-z0-9]{20,})/g;
/**
 * `password=…`, `"api_key": "…"`, `Authorization: Basic …`: the value after a credential key (any prefix, e.g. `DB_PASSWORD`),
 * also in JSON that was stringified once more (`\"password\": \"…\"`).
 */
const KEYED = /((?:authorization|api[_-]?key|access[_-]?(?:token|key)|refresh[_-]?token|secret[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|secret)\\?["']?\s*[=:]\s*\\?["']?)(?:(?:Bearer|Basic|Token)[ \t]+)?(?!\[)(?:[^\s"'`,;\]}\\]|\\(?!["'])){8,}/gi;
/**
 * `token=…` / `GITHUB_TOKEN: …` (not `tokens`, `max_tokens`). Only values that look generated: token characters with a digit or at
 * least 32 of them, not followed by `(`, `[` or `{` (code such as `const token = readToken(agent)` stays). The value is matched once
 * (an atomic lookahead), so a long run cannot backtrack.
 */
const TOKEN = /(token\\?["']?\s*[=:]\s*\\?["']?)(?!\[)(?=[\w.~+/=%-]*[0-9]|[\w.~+/=%-]{32})(?=([\w.~+/=%-]{8,}))\2(?![(\[{])/gi;
/** A bare `Bearer <token>` (headers in curl commands, logs). */
const BEARER = /(\bBearer[ \t]+)(?!\[)[A-Za-z0-9._~+/=-]{16,}/gi;
/** `user:password@` in a URL of any scheme (https, postgres, mongodb+srv, redis, amqp…); a scheme starts where a word does. */
const USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
/** Slack and Discord webhook URLs carry their secret in the path. */
const WEBHOOK = /((?:hooks\.slack\.com\/(?:services|workflows|triggers)|discord(?:app)?\.com\/api\/webhooks)\/)[A-Za-z0-9_/-]{8,}/gi;
/** Signing and key parameters of a URL query (`?key=`, presigned `X-Amz-Signature=`, Azure SAS `sig=`). */
const QUERY_KEY = /([?&](?:key|sig|signature|x-amz-signature)=)(?!\[)[^\s&#"'<>]{8,}/gi;

/**
 * A field whose name says it holds a credential (`password`, `PGPASSWORD`, `api_key`, `x-api-key`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_SESSION_TOKEN`, `Authorization`, `client_secret`, `credentials`): every string under it is masked whole, whatever it looks
 * like, before anything is cut or turned into JSON. `max_tokens`, `tokenCount` or `secretName` are not credentials.
 */
const CREDENTIAL_FIELD = /(?:authorization|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|password|passwd|passphrase|token|credentials?)$/i;
export const isCredentialField = (name: string): boolean => CREDENTIAL_FIELD.test(name);

/**
 * Never forward common credential literals into a trajectory analysis prompt. Not exhaustive: unknown formats, bare secrets
 * without a key or prefix (an AWS secret key on its own line) and passwords under 8 characters or with spaces pass through.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY, "[private key redacted]")
    .replace(JWT, "[credential redacted]")
    .replace(PREFIXED, "[credential redacted]")
    .replace(KEYED, "$1[redacted]")
    .replace(TOKEN, "$1[redacted]")
    .replace(BEARER, "$1[redacted]")
    .replace(USERINFO, "$1[redacted]@")
    .replace(WEBHOOK, "$1[redacted]")
    .replace(QUERY_KEY, "$1[redacted]");
}
/** redactSecrets on every string of a parsed model answer: a provider reviewer can read files on its own and quote them. */
export function redactStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth > 8 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(entry => redactStrings(entry, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStrings(entry, depth + 1)]));
}
export function assessTrajectory(trajectory: SessionTrajectory, trigger: "manual" | "auto", minimumTurns = 3, minimumTools = 3) {
  const turnCount = trajectory.counts.userTurns;
  const toolCount = trajectory.counts.tools;
  const turnsNeeded = trigger === "manual" ? 2 : minimumTurns;
  const toolsNeeded = trigger === "manual" ? 2 : minimumTools;
  if (turnCount < turnsNeeded) return { eligible: false, turnCount, toolCount, reason: t("serverInsightAnalysis.m001", { turnsNeeded: turnsNeeded, turnCount: turnCount }) };
  if (toolCount < toolsNeeded) return { eligible: false, turnCount, toolCount, reason: t("serverInsightAnalysis.m002", { toolsNeeded: toolsNeeded, toolCount: toolCount }) };
  if (trigger === "auto" && trajectory.rows.length < 12 && trajectory.counts.toolFailures === 0 && trajectory.counts.errors === 0) return { eligible: false, turnCount, toolCount, reason: t("serverInsightAnalysis.m003") };
  if (trigger === "auto" && ["running", "initializing"].includes(trajectory.agent.status)) return { eligible: false, turnCount, toolCount, reason: t("serverInsightAnalysis.m004") };
  return { eligible: true, turnCount, toolCount, reason: t("serverInsightAnalysis.m005", { turnCount: turnCount, toolCount: toolCount, value3: trigger === "auto" ? t("serverInsightAnalysis.m006") : t("serverInsightAnalysis.m007") }) };
}
export function trajectoryFingerprint(trajectory: SessionTrajectory): string {
  return createHash("sha256").update(JSON.stringify(trajectory.rows.map(row => [row.ref, row.kind, row.toolStatus, row.text]))).digest("hex");
}
function evenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return count ? [items[0]] : [];
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * (items.length - 1) / (count - 1))]);
}
function selectAnalysisRows(rows: readonly TrajectoryRow[], limit: number): TrajectoryRow[] {
  if (rows.length <= limit) return [...rows];
  const selected = new Set<number>();
  const indexes = rows.map((_, index) => index);
  const take = (candidates: number[], count: number) => { for (const index of evenly(candidates, count)) if (selected.size < limit) selected.add(index); };
  take([0, rows.length - 1], 2);
  take(indexes.filter(index => rows[index].kind === "user_message"), Math.floor(limit / 3));
  take(indexes.filter(index => rows[index].kind === "error" || rows[index].toolStatus === "failed"), Math.floor(limit / 3));
  take(indexes.filter(index => rows[index].kind === "tool_call"), Math.floor(limit / 3));
  take(indexes.filter(index => rows[index].kind === "assistant_message"), Math.floor(limit / 6));
  take(indexes.filter(index => !selected.has(index)), limit - selected.size);
  return [...selected].sort((a, b) => a - b).map(index => rows[index]);
}
export interface AnalysisRequestOptions { compact?: boolean; previousReview?: { jobId: string; summary: string; findings: InsightReport["findings"] }; historicalEvidence?: TrajectoryRow[] }
export function buildAnalysisRequest(trajectory: SessionTrajectory, question?: string, options: AnalysisRequestOptions = {}) {
  const limit = options.compact ? 70000 : 120000;
  const combined = [...new Map([...(options.historicalEvidence ?? []), ...trajectory.rows].map(row => [row.ref, row])).values()];
  const selected = selectAnalysisRows(combined, options.compact ? 90 : 180);
  // Masked before it is cut, with the field names in mind (see summarizeTrajectoryRow).
  const safeMetadata = (value: unknown, secret = false): unknown => {
    if (typeof value === "string") return excerptText(secret && value ? "[redacted]" : redactSecrets(value), 1000).text;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeMetadata(entry, secret || isCredentialField(key))]));
    return value;
  };
  const instructions = [
    t("serverInsightAnalysis.m008", { language: currentLanguage(), languageName: languageName() }),
    t("serverInsightAnalysis.m009"),
    t("serverInsightAnalysis.m010"),
    t("serverInsightAnalysis.m011"),
    t("serverInsightAnalysis.m012"),
    t("serverInsightAnalysis.m013"),
    t("serverInsightAnalysis.m014"),
    options.compact ? t("serverInsightAnalysis.m015") : "",
    options.previousReview ? t("serverInsightAnalysis.m016") : "",
    question ? t("serverInsightAnalysis.m017", { value1: redactSecrets(question).slice(0, 2000) }) : "",
  ].filter(Boolean).join("\n\n");
  let perRow = Math.min(options.compact ? 2400 : 4200, Math.floor((limit - 16000) / Math.max(1, selected.length) * 0.72));
  let evidence = selected;
  let prompt = "";
  let sampled = selected.length < combined.length;
  for (let attempt = 0; attempt < 8; attempt++) {
    evidence = selected.map(row => {
      const excerpt = excerptText(redactSecrets(row.text), Math.max(20, perRow));
      sampled ||= excerpt.truncated;
      return { ...row, text: excerpt.text };
    });
    const data = { agent: safeMetadata(trajectory.agent), project: safeMetadata(trajectory.project), capturedAt: trajectory.capturedAt,
      coverage: safeMetadata(trajectory.coverage), counts: trajectory.counts,
      previousReview: options.previousReview ? { jobId: options.previousReview.jobId, summary: excerptText(redactSecrets(options.previousReview.summary), 600).text,
        findings: options.previousReview.findings.slice(0, 12).map(finding => ({ id: finding.id, title: redactSecrets(finding.title), detail: excerptText(redactSecrets(finding.detail), 600).text,
          recommendation: excerptText(redactSecrets(finding.recommendation), 400).text, evidence: finding.evidence.filter(ref => selected.some(row => row.ref === ref)).slice(0, 6) })) } : undefined,
      analysisWindow: { providedRows: evidence.length, sourceRows: trajectory.rows.length, sampled, sourceCountsAreWindowTotals: true },
      rows: evidence.map(row => ({ ref: row.ref, at: row.at, turnId: row.turnId, type: row.kind, tool: row.toolName, status: row.toolStatus, text: row.text })) };
    prompt = `${instructions}\n\n<trajectory_data>${JSON.stringify(data)}</trajectory_data>`;
    if (prompt.length <= limit) break;
    perRow = Math.floor(perRow * 0.6);
  }
  if (prompt.length > limit) throw new Error(t("serverInsightAnalysis.m018"));
  return { prompt, references: new Set(evidence.map(row => row.ref)), evidence, sampled };
}
export function buildAnalysisPrompt(trajectory: SessionTrajectory, question?: string): string {
  return buildAnalysisRequest(trajectory, question).prompt;
}
export class InsightReportError extends Error {
  constructor(message: string, readonly usage: InsightJob["usage"] = null) { super(message); this.name = "InsightReportError"; }
}
export function isUsefulInsightReport(report: InsightReport | null): boolean {
  if (!report) return false;
  if (report.findings.some(finding => finding.evidence.length > 0 && finding.detail.trim())) return true;
  if (report.strengths.some(item => item.trim())) return true;
  return report.nextActions.some(item => item.trim() && !/(?:读取|提供|获取).*(?:完整|更多|全部).*(?:轨迹|数据)|先.*读取/i.test(item)); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
}
/** Parse plain JSON, a fenced object, or a complete object in surrounding text. Models sometimes repeat the whole answer, so the last object `accept` approves wins; otherwise the largest one. */
export function extractInsightJson(output: string, accept?: (value: unknown) => boolean): unknown {
  const text = output.trim();
  if (text.length > 4_000_000) throw new InsightReportError(t("serverInsightAnalysis.m019"));
  try { return JSON.parse(text); } catch { /* providers sometimes add a fence or preamble */ }
  const spans: Array<[number, number]> = []; let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) { if (char === "{") { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { spans.push([start, index + 1]); start = -1; }
  }
  const objects = spans.flatMap(([from, to]) => { try { return [{ value: JSON.parse(text.slice(from, to)) as unknown, size: to - from }]; } catch { return []; } });
  const accepted = accept ? objects.filter(object => accept(object.value)) : [];
  const chosen = accepted.at(-1) ?? objects.sort((a, b) => b.size - a.size)[0];
  if (chosen) return chosen.value;
  throw new InsightReportError(t("serverInsightAnalysis.m020"));
}
export function parseInsightOutput(output: string, accept?: (value: unknown) => boolean): { data: unknown; usage: InsightJob["usage"] } {
  const envelope = extractInsightJson(output);
  const object = envelope !== null && typeof envelope === "object" ? envelope as Record<string, unknown> : {};
  const body = object.structured_output ?? object.structuredOutput ?? object.text ?? object.result ?? envelope;
  const usage = object.usage && typeof object.usage === "object" ? object.usage as Record<string, unknown> : {};
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const reportedUsage = { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), costUsd: number(object.total_cost_usd) };
  try { return { data: typeof body === "string" ? extractInsightJson(body, accept) : body, usage: reportedUsage }; }
  catch (error) { throw new InsightReportError(error instanceof Error ? error.message : t("serverInsightAnalysis.m021"), reportedUsage); }
}
export function parseInsightText(output: string, references: Set<string>): { report: InsightReport; usage: InsightJob["usage"] } {
  const { data, usage: reportedUsage } = parseInsightOutput(output, value => insightReportSchema.safeParse(value).success);
  const parsed = insightReportSchema.safeParse(redactStrings(data));
  if (!parsed.success) throw new InsightReportError(t("serverInsightAnalysis.m022"), reportedUsage);
  const report = parsed.data;
  let unsupported = 0, invalidReferences = 0;
  report.findings = report.findings.flatMap(finding => {
    invalidReferences += finding.evidence.filter(ref => !references.has(ref)).length;
    const evidence = [...new Set(finding.evidence.filter(ref => references.has(ref)))];
    if (!evidence.length) { unsupported++; return []; }
    return [{ ...finding, evidence }];
  });
  if (unsupported || invalidReferences) {
    report.confidence = "low";
    report.limitations = [...report.limitations.slice(0, 7), t("serverInsightAnalysis.m023", { invalidReferences: invalidReferences, unsupported: unsupported })];
    if (!report.findings.length) report.health = "watch";
  }
  if (!isUsefulInsightReport(report)) throw new InsightReportError(t("serverInsightAnalysis.m024"), reportedUsage);
  return { report, usage: reportedUsage };
}
export const parseGrokReport = parseInsightText;
