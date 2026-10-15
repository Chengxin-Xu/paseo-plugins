import { t } from "../shared/text";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { insightJobSchema, insightJobSummarySchema, insightSettingsSchema, insightSourceSchema, type InsightJob, type InsightJobSummary, type InsightSettings } from "../shared/insights";
import { excerptText } from "../shared/evidence";
import { ensurePrivateDirectory } from "./paseo-home";

export const MAX_SUCCESSFUL_REPORTS = 60;
export const MAX_REPORT_BYTES = 768 * 1024;
export const MAX_REPORT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const active = new Set(["queued", "collecting", "analyzing"]);
export const cooldownSchema = z.object({ fingerprint: z.string(), analyzedAt: z.string(), reportId: z.string(), source: insightSourceSchema.optional() });
export const activitySchema = z.object({ turns: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), latestTurnAt: z.string().nullable() });
export type InsightCooldown = z.infer<typeof cooldownSchema>;
export type InsightActivity = z.infer<typeof activitySchema>;
export interface InsightStoredState { settings: InsightSettings; jobs: InsightJob[]; cooldowns: Record<string, InsightCooldown>; activity: Record<string, InsightActivity>; revision: number }
const settingsFileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), settings: insightSettingsSchema });
const indexSchema = z.object({ version: z.literal(2), revision: z.number().int().nonnegative(), jobs: z.array(insightJobSummarySchema).max(140),
  cooldowns: z.record(z.string(), cooldownSchema), activity: z.record(z.string(), activitySchema) });
const reportSchema = z.object({ version: z.literal(1), job: insightJobSchema });
const filename = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function summarizeInsight(job: InsightJob): InsightJobSummary {
  const { report, evidence: _evidence, ...summary } = job;
  return { ...summary, reportAvailable: !!report, summary: report?.summary.slice(0, 300) ?? null, health: report?.health ?? null,
    findings: report?.findings.length ?? 0, resolvedFindings: Object.values(job.findingFeedback ?? {}).filter(value => value.status === "resolved").length };
}
export function fitInsightReport(job: InsightJob): InsightJob {
  if (bytes({ version: 1, job }) <= MAX_REPORT_BYTES) return job;
  const bounded = structuredClone(job);
  bounded.agentTitle = bounded.agentTitle.slice(0, 240); bounded.projectName = bounded.projectName.slice(0, 240);
  bounded.stage = bounded.stage.slice(0, 1500); bounded.error = bounded.error?.slice(0, 2000) ?? null;
  for (let limit = 1200; bytes({ version: 1, job: bounded }) > MAX_REPORT_BYTES && limit >= 100; limit = Math.floor(limit / 2)) {
    bounded.evidence = bounded.evidence?.map(row => ({ ...row, text: excerptText(row.text, limit).text }));
  }
  while (bytes({ version: 1, job: bounded }) > MAX_REPORT_BYTES && bounded.evidence?.length) bounded.evidence.pop();
  if (bounded.report) bounded.report.limitations = [...bounded.report.limitations.slice(0, 7), t("serverInsightStorage.m001")];
  if (bytes({ version: 1, job: bounded }) > MAX_REPORT_BYTES) throw new Error(t("serverInsightStorage.m002"));
  return bounded;
}
/** Status noise has its own budget and can never evict a successful report. */
export function retainInsightJobs(jobs: InsightJob[]): InsightJob[] {
  let reports = 0, statuses = 0, totalBytes = 0;
  const skips = new Set<string>();
  return [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).filter(job => {
    if (active.has(job.status)) return true;
    if (job.status === "completed" && job.report) {
      const size = bytes({ version: 1, job });
      if (reports >= MAX_SUCCESSFUL_REPORTS || totalBytes + size > MAX_REPORT_TOTAL_BYTES) return false;
      reports++; totalBytes += size; return true;
    }
    if (job.status === "skipped") { if (skips.has(job.agentId)) return false; skips.add(job.agentId); }
    return statuses++ < 60;
  });
}
export class InsightStorage {
  error: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly saved = new Map<string, string>();
  private savedIndex: string | null = null;
  private savedSettings: string | null = null;
  private readonly reports: string;
  private lastSaveSucceeded = false;
  constructor(private readonly directory: string) { this.reports = join(directory, "insight-reports"); }
  private async read(path: string, maximum: number): Promise<unknown | undefined> {
    try { if ((await stat(path)).size > maximum) throw new Error("file too large"); return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return undefined; throw error; }
  }
  private async atomic(path: string, data: unknown) {
    await ensurePrivateDirectory(this.directory);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); } await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  }
  private async backup(path: string) { await rename(path, `${path}.backup`).catch(() => {}); }
  private async recoverReports(): Promise<InsightJob[]> {
    const recovered: InsightJob[] = [];
    let files: string[];
    try { files = await readdir(this.reports); } catch { return recovered; }
    for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 120)) {
      try { const value = reportSchema.parse(await this.read(join(this.reports, name), MAX_REPORT_BYTES)); if (filename(value.job.id) === name) recovered.push(value.job); }
      catch { await rename(join(this.reports, name), join(this.directory, "insight-report.corrupt.backup")).catch(() => {}); }
    }
    return retainInsightJobs(recovered);
  }
  async load(defaults: InsightSettings): Promise<InsightStoredState> {
    let settings = structuredClone(defaults), settingsKnown = false, settingsBroken = false, settingsMigrated = false;
    const config = join(this.directory, "insight-settings.json"), index = join(this.directory, "insight-index.json"), legacy = join(this.directory, "insights.json");
    try { const raw = await this.read(config, 65536); if (raw !== undefined) {
      const saved = settingsFileSchema.parse(raw); settings = saved.settings; settingsKnown = true;
      if (saved.version === 1) { settings = { ...settings, autoEnabled: false, runner: { kind: "grok" } }; settingsMigrated = true; }
      else this.savedSettings = JSON.stringify(settings);
    } }
    catch { settingsBroken = true; settings.autoEnabled = false; this.error = t("serverInsightStorage.m003"); await this.backup(config); }
    const result: InsightStoredState = { settings, jobs: [], cooldowns: {}, activity: {}, revision: 1 };
    let imported = false;
    try {
      const raw = await this.read(index, MAX_INDEX_BYTES);
      if (raw !== undefined) {
        const saved = indexSchema.parse(raw); result.cooldowns = saved.cooldowns; result.activity = saved.activity; result.revision = saved.revision;
        if (!settingsKnown && !settingsBroken) { result.settings.autoEnabled = false; this.error = t("serverInsightStorage.m004"); }
        for (const summary of saved.jobs) {
          let job: InsightJob = insightJobSchema.parse({ ...summary, report: null });
          if (summary.reportAvailable) try {
            const stored = reportSchema.parse(await this.read(join(this.reports, filename(summary.id)), MAX_REPORT_BYTES));
            if (stored.job.id !== summary.id) throw new Error("report ID mismatch"); job = stored.job;
          } catch { await rename(join(this.reports, filename(summary.id)), join(this.directory, "insight-report.corrupt.backup")).catch(() => {}); job = { ...job, status: "failed", stage: t("serverInsightStorage.m005"), error: t("serverInsightStorage.m006") }; this.error = t("serverInsightStorage.m007"); }
          result.jobs.push(job);
        }
      } else {
        // Legacy legal maxima can exceed 8 MB. Recover settings independently
        // and validate each report, rather than dropping the whole history.
        const old = await this.read(legacy, 128 * 1024 * 1024);
        if (old !== undefined) {
          imported = true; const saved = old as Record<string, unknown>;
          if (!settingsKnown && !settingsBroken) { const parsed = insightSettingsSchema.safeParse(saved.settings); result.settings = { ...(parsed.success ? parsed.data : defaults), autoEnabled: false, runner: { kind: "grok" } }; }
          if (Array.isArray(saved.jobs)) for (const value of saved.jobs) {
            const parsed = insightJobSchema.safeParse(value); if (!parsed.success) { this.error = t("serverInsightStorage.m008"); continue; }
            try { result.jobs.push(fitInsightReport(parsed.data)); } catch { this.error = t("serverInsightStorage.m009"); }
          }
          const fingerprints = saved.fingerprints && typeof saved.fingerprints === "object" ? saved.fingerprints as Record<string, unknown> : {};
          for (const job of [...result.jobs].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))) if (job.status === "completed") result.cooldowns[job.agentId] = {
            fingerprint: typeof fingerprints[job.id] === "string" ? fingerprints[job.id] as string : "", analyzedAt: job.updatedAt, reportId: job.id, source: job.source };
        } else result.jobs = await this.recoverReports();
      }
    } catch {
      if (!settingsKnown) result.settings.autoEnabled = false;
      this.error = t("serverInsightStorage.m010");
      await this.backup(index); await this.backup(legacy);
      result.jobs = await this.recoverReports();
    }
    for (const job of [...result.jobs].reverse()) if (job.status === "completed" && !result.cooldowns[job.agentId]) result.cooldowns[job.agentId] = {
      fingerprint: "", analyzedAt: job.source?.capturedAt ?? job.updatedAt, reportId: job.id, source: job.source };
    result.jobs = retainInsightJobs(result.jobs);
    if (!settingsKnown || settingsBroken || settingsMigrated) await this.saveSettings(result.settings);
    if (imported) { await this.save(result); if (this.lastSaveSucceeded) await this.backup(legacy); }
    return result;
  }
  async saveSettings(settings: InsightSettings) {
    const snapshot = structuredClone(settings), signature = JSON.stringify(snapshot);
    this.writes = this.writes.then(async () => {
      if (this.savedSettings === signature) return;
      try { await this.atomic(join(this.directory, "insight-settings.json"), { version: 2, settings: snapshot }); this.savedSettings = signature; }
      catch { this.error = t("serverInsightStorage.m011"); }
    });
    await this.writes;
  }
  save(state: InsightStoredState): Promise<void> {
    const snapshot = { ...state, jobs: [...state.jobs], cooldowns: { ...state.cooldowns }, activity: { ...state.activity } };
    this.writes = this.writes.then(async () => {
      this.lastSaveSucceeded = false;
      try {
        await ensurePrivateDirectory(this.directory); await ensurePrivateDirectory(this.reports);
        for (const job of snapshot.jobs) if (job.report) {
          const signature = createHash("sha256").update(JSON.stringify(job)).digest("base64");
          if (this.saved.get(job.id) === signature) continue;
          await this.atomic(join(this.reports, filename(job.id)), { version: 1, job: fitInsightReport(job) }); this.saved.set(job.id, signature);
        }
        const index = { jobs: snapshot.jobs.map(summarizeInsight), cooldowns: snapshot.cooldowns, activity: snapshot.activity };
        // Revision-only bumps are not worth a 170 KB rewrite and fsync; content changes always are.
        const digest = createHash("sha256").update(JSON.stringify(index)).digest("base64");
        if (digest !== this.savedIndex) { await this.atomic(join(this.directory, "insight-index.json"), { version: 2, revision: snapshot.revision, ...index }); this.savedIndex = digest; }
        this.lastSaveSucceeded = true;
        const retained = new Set(snapshot.jobs.filter(job => job.report).map(job => filename(job.id)));
        for (const name of await readdir(this.reports)) if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name)) await unlink(join(this.reports, name)).catch(() => {});
      } catch { this.error = t("serverInsightStorage.m012"); }
    });
    return this.writes;
  }
  async close() { await this.writes; }
}
