import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { suggestionJobSchema, type SuggestionJob } from "../shared/insight-overview";
import { ensurePrivateDirectory } from "./paseo-home";

export const MAX_SUGGESTION_JOBS = 20;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const active = new Set<SuggestionJob["status"]>(["queued", "collecting", "analyzing"]);
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
/** Active queue entries have priority; the manager bounds the shared queue below this capacity. */
export function retainSuggestionJobs(jobs: readonly SuggestionJob[]): SuggestionJob[] {
  const unique = new Map<string, SuggestionJob>();
  for (const job of jobs) if (!unique.has(job.id) || timestamp(unique.get(job.id)!.updatedAt) < timestamp(job.updatedAt)) unique.set(job.id, job);
  const sorted = [...unique.values()].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id));
  const retained = new Set(sorted.filter(job => active.has(job.status)).slice(0, MAX_SUGGESTION_JOBS).map(job => job.id));
  for (const job of sorted) if (retained.size < MAX_SUGGESTION_JOBS) retained.add(job.id);
  return sorted.filter(job => retained.has(job.id));
}

export class SuggestionStorage {
  error: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  private digest: string | null = null;
  private readonly file: string;
  constructor(private readonly directory: string) { this.file = join(directory, "insight-suggestions.json"); }
  async load(): Promise<SuggestionJob[]> {
    try {
      if ((await stat(this.file)).size > MAX_FILE_BYTES) throw new Error("too large");
      const raw = JSON.parse(await readFile(this.file, "utf8")) as { version?: unknown; jobs?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.jobs) || raw.jobs.length > 1000) throw new Error("invalid suggestions");
      const jobs: SuggestionJob[] = [];
      for (const value of raw.jobs) {
        const parsed = suggestionJobSchema.safeParse(value);
        if (parsed.success) jobs.push(parsed.data);
        else this.error = "部分建议记录无法恢复，其余记录已保留。";
      }
      const retained = retainSuggestionJobs(jobs);
      if (!this.error && retained.length === raw.jobs.length) this.digest = this.hash(JSON.stringify({ version: 1, jobs: retained }));
      return retained;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      this.error = "建议记录无法恢复，原文件已保留，分析报告不受影响。";
      await rename(this.file, `${this.file}.${randomUUID()}.backup`).catch(() => {});
      return [];
    }
  }
  private hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
  save(jobs: readonly SuggestionJob[]): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, jobs: retainSuggestionJobs(jobs) });
    const digest = this.hash(snapshot);
    this.writes = this.writes.then(async () => {
      if (digest === this.digest) return;
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        if (Buffer.byteLength(snapshot, "utf8") > MAX_FILE_BYTES) throw new Error("too large");
        await ensurePrivateDirectory(this.directory);
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(snapshot); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.file); this.digest = digest;
      } catch { this.error = "建议暂时无法保存，已保留内存状态与原有文件。"; }
      finally { await unlink(temp).catch(() => {}); }
    });
    return this.writes;
  }
  async close() { await this.writes; }
}
