import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { RUN_WINDOWS, cadenceLabel, findChangeRequest, getScheduleRun, listScheduleRuns, parseTime, previewOf, type RunLink, type RunStatus, type RunWindow,
  type ScheduleRunDetail, type ScheduleRunRow, type ScheduleRunsResponse, type ScheduleRunsState, type ScheduleSummary } from "../shared/schedules";
import { contentRevision } from "./revision";
import type { StatsDirectoryAgent } from "./stats-types";
import { telemetryDirectory } from "./telemetry";

/**
 * 定时运行 index. The plugin SDK has no schedules API, so the daemon's own records are read (read-only):
 * `$PASEO_HOME/schedules/*.json` (one file per schedule, every run with its final reply) and
 * `$PASEO_HOME/projects/workspaces.json` (archived workspaces keep their name and branch only there).
 * Agents come from the shared StatsDirectory walk (once a minute, already paid for by 看板 / Token), joined by
 * run id, the `paseo.schedule-run` label, or — for heartbeats — the schedule's target Agent. Paseo's agent list leaves
 * out every Agent whose project was removed (each run gets its own workspace, so old runs lose their project easily),
 * so the records under `$PASEO_HOME/agents/` fill the gaps for Agents a schedule created or points at.
 *
 * A schedule's file disappears with the schedule, and its run history with it. The observatory keeps a small
 * metadata ledger (no replies, no prompts) so a deleted schedule's runs stay listed, and rebuilds runs it never saw
 * from the labels Paseo stamps on every Agent a schedule creates.
 */

const LOG = "[agent-observatory:schedules]";
const MAX_FILE_BYTES = 32 * 1024 * 1024, LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const LEDGER_RUNS = 3000, LEDGER_SCHEDULES = 400, LEDGER_DAYS = 400;
const OUTPUT_MAX = 60_000, PROMPT_MAX = 8000, ERROR_MAX = 2000;
const DAY_MS = 86_400_000, WINDOW_STEP_MS = 10 * 60_000;
/** Agent records are listed at most once a minute (like the directory walk) and parsed only when they change. */
const AGENT_SCAN_MS = 60_000, AGENT_RECORD_MAX_BYTES = 1024 * 1024;
/** Temporary ledger files are unique per write, so two indexes on one directory (tests, an overlapping reload) cannot collide. */
let temporarySequence = 0;

/** Mirrors the daemon's resolvePaseoHome, `~` included, so the plugin reads the directory the daemon writes. */
export function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim() || "~/.paseo";
  if (raw === "~") return homedir();
  return resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

// Loose mirrors of Paseo's StoredScheduleSchema / workspace registry: unknown keys pass, ids are plain strings.
const runSchema = z.object({ id: z.string(), scheduledFor: z.string().nullable().optional(), startedAt: z.string(), endedAt: z.string().nullable().optional(),
  status: z.enum(["running", "succeeded", "failed"]), agentId: z.string().nullable().optional(), workspaceId: z.string().nullable().optional(),
  output: z.string().nullable().optional(), error: z.string().nullable().optional() });
const scheduleSchema = z.object({ id: z.string(), name: z.string().nullable().optional(), prompt: z.string().optional(),
  cadence: z.discriminatedUnion("type", [z.object({ type: z.literal("cron"), expression: z.string(), timezone: z.string().nullable().optional() }), z.object({ type: z.literal("every"), everyMs: z.number().positive() })]),
  target: z.discriminatedUnion("type", [z.object({ type: z.literal("agent"), agentId: z.string() }),
    z.object({ type: z.literal("new-agent"), config: z.object({ provider: z.string().optional(), cwd: z.string().optional(), title: z.string().nullable().optional() }).passthrough() })]),
  status: z.enum(["active", "paused", "completed"]), nextRunAt: z.string().nullable().optional(), lastRunAt: z.string().nullable().optional(), runs: z.array(z.unknown()) });
type StoredRun = z.output<typeof runSchema>;
type StoredSchedule = Omit<z.output<typeof scheduleSchema>, "runs"> & { runs: StoredRun[] };
const workspaceSchema = z.object({ workspaceId: z.string(), displayName: z.string().nullable().optional(), title: z.string().nullable().optional(), branch: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(), autoArchivedChangeRequestUrl: z.string().nullable().optional() });
type WorkspaceRecord = z.output<typeof workspaceSchema>;

const ledgerRunSchema = z.object({ scheduleId: z.string().max(80), kind: z.enum(["new-agent", "heartbeat"]), status: z.enum(["running", "succeeded", "failed", "unknown"]),
  scheduledFor: z.string().nullable(), startedAt: z.string(), endedAt: z.string().nullable(), agentId: z.string().max(256).nullable(), workspaceId: z.string().max(256).nullable(),
  error: z.string().max(300).nullable(), link: z.string().max(2000).nullable(), hadOutput: z.boolean() });
const ledgerScheduleSchema = z.object({ name: z.string().max(200), kind: z.enum(["new-agent", "heartbeat"]), cadence: z.string().max(160), timezone: z.string().max(80).nullable().default(null),
  provider: z.string().max(120).nullable(), projectName: z.string().max(240).nullable(), lastSeenAt: z.string(), deletedAt: z.string().nullable() });
const ledgerSchema = z.object({ version: z.literal(1), schedules: z.record(z.string(), ledgerScheduleSchema), runs: z.record(z.string(), ledgerRunSchema) });
export type ScheduleLedger = z.infer<typeof ledgerSchema>;

interface Cached<Value> { mtimeMs: number; size: number; value: Value }
async function readCached<Value>(path: string, cached: Cached<Value> | undefined, parse: (raw: unknown) => Value, maxBytes = MAX_FILE_BYTES): Promise<Cached<Value> | null> {
  let info;
  try { info = await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
  if (info.size > maxBytes) throw new Error(`${basename(path)} is larger than ${maxBytes} bytes`);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return { mtimeMs: info.mtimeMs, size: info.size, value: parse(raw) };
}
function parseSchedule(raw: unknown, file: string, warn: (message: string) => void): StoredSchedule | null {
  const parsed = scheduleSchema.safeParse(raw);
  if (!parsed.success) { warn(`ignoring unreadable schedule file ${file}`); return null; }
  const runs: StoredRun[] = [];
  for (const candidate of parsed.data.runs) { const run = runSchema.safeParse(candidate); if (run.success) runs.push(run.data); }
  return { ...parsed.data, runs };
}
function parseWorkspaces(raw: unknown): Map<string, WorkspaceRecord> {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { workspaces?: unknown }).workspaces) ? (raw as { workspaces: unknown[] }).workspaces : [];
  const records = new Map<string, WorkspaceRecord>();
  for (const candidate of list) { const parsed = workspaceSchema.safeParse(candidate); if (parsed.success) records.set(parsed.data.workspaceId, parsed.data); }
  return records;
}

const recordText = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
/**
 * An Agent record (`$PASEO_HOME/agents/<folder>/<id>.json`, Paseo's StoredAgentRecord) as a directory entry, with the
 * schedule labels when it has them; internal Agents and anything unreadable are null.
 */
export function agentFromRecord(raw: unknown): StatsDirectoryAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const labels = record.labels && typeof record.labels === "object" && !Array.isArray(record.labels) ? record.labels as Record<string, unknown> : {};
  const id = recordText(record.id, 256), scheduleId = recordText(labels["paseo.schedule-id"], 80), scheduleRunId = recordText(labels["paseo.schedule-run"], 120);
  if (!id || record.internal === true) return null;
  const cwd = typeof record.cwd === "string" ? record.cwd : "", cwdName = (basename(cwd) || "未知").slice(0, 240);
  const nested = (key: string) => record[key] && typeof record[key] === "object" ? record[key] as Record<string, unknown> : {};
  const persistence = nested("persistence");
  return { id, createdAt: recordText(record.createdAt, 64) ?? "", provider: recordText(record.provider, 1024) ?? "unknown",
    model: recordText(nested("config").model, 1024) ?? recordText(nested("runtimeInfo").model, 1024),
    parentAgentId: recordText(labels["paseo.parent-agent-id"], 256), projectKey: cwdName, projectName: cwdName, status: recordText(record.lastStatus, 40) ?? "closed",
    archivedAt: recordText(record.archivedAt, 64), title: recordText(record.title, 240), requiresAttention: record.requiresAttention === true,
    attentionReason: recordText(record.attentionReason, 80), pendingPermissions: 0, activeTurn: false, lastUserMessageAt: recordText(record.lastUserMessageAt, 64),
    updatedAt: recordText(record.updatedAt, 64), contextUsed: null, contextMax: null, sessionId: recordText(persistence.sessionId, 256), cwd,
    workspaceId: recordText(record.workspaceId, 256), scheduleId, scheduleRunId };
}

export interface ScheduleDirectory { agents: StatsDirectoryAgent[]; digest: string; refresh(paseo: PaseoApi): Promise<void> }
export interface ScheduleIndexOptions {
  home?: string; dataDirectory?: string; directory: ScheduleDirectory; now?: () => number; writeDelayMs?: number;
  /** Test overrides for the 32 MB schedule-file and 8 MB ledger ceilings. */ maxFileBytes?: number; maxLedgerBytes?: number;
  /** Where warnings go (console.warn); tests collect them. */ log?: (message: string) => void;
}
interface Base { rows: ScheduleRunRow[]; summaries: ScheduleSummary[]; reconstructed: number; error: string | null }

const clip = (value: string | null | undefined, max: number) => value ? value.length > max ? `${value.slice(0, max - 1)}…` : value : null;
function nameOf(schedule: StoredSchedule): string {
  const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
  return clip(schedule.name?.trim() || config?.title?.trim() || previewOf(schedule.prompt, 40) || `定时任务 ${schedule.id}`, 200)!;
}
/** Paseo runs a cron without a zone in UTC; intervals have none. */
const zoneOf = (schedule: StoredSchedule) => schedule.cadence.type === "cron" ? schedule.cadence.timezone?.trim() || "UTC" : null;
/** Agent-only evidence: a finished turn reads as success, an error as failure; anything else stays unknown. */
function agentRunStatus(agent: StatsDirectoryAgent): RunStatus {
  if (!agent.archivedAt && (agent.activeTurn || agent.status === "running" || agent.status === "initializing")) return "running";
  if (agent.status === "error") return "failed";
  return agent.attentionReason === "finished" ? "succeeded" : "unknown";
}

export class ScheduleIndex {
  private readonly home: string;
  private readonly ledgerFile: string;
  private readonly now: () => number;
  private readonly writeDelayMs: number;
  private files = new Map<string, Cached<StoredSchedule | null>>();
  private workspaces: Cached<Map<string, WorkspaceRecord>> | null = null;
  private ledger: ScheduleLedger = { version: 1, schedules: {}, runs: {} };
  private ledgerRevision = contentRevision(this.ledger);
  /** False when an unreadable ledger could not be set aside: it is never overwritten then. */
  private ledgerWritable = true;
  private notice: string | null = null;
  private ready: Promise<void>;
  private baseKey: string | null = null;
  private base: Base | null = null;
  private building: Promise<Base> | null = null;
  /** One cached response per window, keyed by its 30-day edge and notice. */
  private windows = new Map<RunWindow, { key: string; state: ScheduleRunsState }>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Changes not on disk yet; `close()` saves them once and no timer runs after it. */
  private dirty = false;
  private closed = false;
  /** Agent records by path (null when internal or unreadable), and the last scan. */
  private agentFiles = new Map<string, { mtimeMs: number; size: number; agent: StatsDirectoryAgent | null }>();
  private agentScanAt = -Infinity;
  private agentScan: { agents: StatsDirectoryAgent[] } = { agents: [] };
  private readonly warn: (message: string) => void;

  constructor(private readonly options: ScheduleIndexOptions) {
    this.home = options.home ?? paseoHome();
    this.ledgerFile = join(options.dataDirectory ?? telemetryDirectory(), "schedule-ledger.json");
    this.now = options.now ?? Date.now;
    this.writeDelayMs = options.writeDelayMs ?? 2000;
    this.warn = options.log ?? (message => console.warn(`${LOG} ${message}`));
    this.ready = this.loadLedger();
  }

  /** A damaged or oversized ledger is renamed aside (never silently overwritten) and recording starts again. */
  private async loadLedger() {
    try {
      const info = await stat(this.ledgerFile);
      if (info.size > (this.options.maxLedgerBytes ?? LEDGER_MAX_BYTES)) throw new Error("ledger too large");
      const parsed = ledgerSchema.parse(JSON.parse(await readFile(this.ledgerFile, "utf8")));
      this.ledger = parsed; this.ledgerRevision = contentRevision(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      const backup = this.ledgerFile.replace(/\.json$/, `.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.json`);
      try {
        await rename(this.ledgerFile, backup);
        this.notice = `定时运行账本损坏，已另存为 ${basename(backup)} 并重新记录；已删除任务的旧运行会从 Agent 记录还原。`;
      } catch {
        this.ledgerWritable = false;
        this.notice = "定时运行账本无法读取，本次不会改写它，只显示宿主现有记录。";
      }
      this.warn(`ledger unreadable: ${String(error)}`);
    }
  }

  private async readSchedules(): Promise<{ schedules: StoredSchedule[]; stamps: string[]; error: string | null }> {
    const directory = join(this.home, "schedules");
    let names: string[];
    try { names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.files.clear(); return { schedules: [], stamps: [], error: null }; } return { schedules: [], stamps: ["unreadable"], error: "定时任务目录无法读取，只显示观测台记下的运行。" }; }
    const schedules: StoredSchedule[] = [], stamps: string[] = [], seen = new Set<string>();
    for (const name of names) {
      const path = join(directory, name);
      seen.add(path);
      try {
        const file = await readCached(path, this.files.get(path), raw => parseSchedule(raw, name, this.warn), this.options.maxFileBytes);
        if (!file) { this.files.delete(path); continue; }
        this.files.set(path, file);
        stamps.push(`${name}:${file.mtimeMs}:${file.size}`);
        if (file.value) schedules.push(file.value);
      } catch (error) { stamps.push(`${name}:error`); this.warn(`could not read ${name}: ${String(error)}`); }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    return { schedules, stamps, error: null };
  }

  private async readWorkspaces(): Promise<{ records: Map<string, WorkspaceRecord>; stamp: string }> {
    try {
      const file = await readCached(join(this.home, "projects", "workspaces.json"), this.workspaces ?? undefined, parseWorkspaces);
      this.workspaces = file;
      return { records: file?.value ?? new Map(), stamp: file ? `${file.mtimeMs}:${file.size}` : "none" };
    } catch (error) {
      this.warn(`could not read the workspace registry: ${String(error)}`);
      return { records: this.workspaces?.value ?? new Map(), stamp: "error" };
    }
  }

  /** Re-reads only changed files; rebuilds rows only when a file, the workspace registry or the Agent directory changed. */
  /**
   * Agent records under `$PASEO_HOME/agents/<folder>/<id>.json`. Paseo 0.11's agent list (what `paseo.agents.list`
   * returns) drops an Agent whose workspace's project is gone, while the record and the host's per-id lookup remain; on
   * this host that hid every past run of a schedule. Folders are listed at most once a minute and a record is parsed
   * again only when its size or modification time changes.
   */
  private async scanAgentRecords(): Promise<{ agents: StatsDirectoryAgent[] }> {
    if (this.now() - this.agentScanAt < AGENT_SCAN_MS) return this.agentScan;
    this.agentScanAt = this.now();
    const root = join(this.home, "agents");
    let folders: string[];
    try { folders = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`could not list Agent records: ${String(error)}`);
      else { this.agentFiles.clear(); this.agentScan = { agents: [] }; }
      return this.agentScan;
    }
    const agents: StatsDirectoryAgent[] = [], seen = new Set<string>();
    for (const folder of folders) {
      let names: string[];
      try { names = (await readdir(join(root, folder), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort(); }
      catch { continue; }
      for (const name of names) {
        const path = join(root, folder, name);
        seen.add(path);
        try {
          const info = await stat(path);
          let file = this.agentFiles.get(path);
          if (!file || file.mtimeMs !== info.mtimeMs || file.size !== info.size) {
            let agent: StatsDirectoryAgent | null = null;
            // A record being rewritten (or not JSON) is skipped quietly; the next change brings it back.
            if (info.size <= AGENT_RECORD_MAX_BYTES) { try { agent = agentFromRecord(JSON.parse(await readFile(path, "utf8"))); } catch { agent = null; } }
            file = { mtimeMs: info.mtimeMs, size: info.size, agent };
            this.agentFiles.set(path, file);
          }
          if (file.agent) agents.push(file.agent);
        } catch { /* removed while listing */ }
      }
    }
    for (const path of this.agentFiles.keys()) if (!seen.has(path)) this.agentFiles.delete(path);
    this.agentScan = { agents };
    return this.agentScan;
  }

  private async current(paseo: PaseoApi | null): Promise<Base> {
    await this.ready;
    if (paseo) await this.options.directory.refresh(paseo).catch(() => {});
    const [{ schedules, stamps, error }, { records, stamp }, scanned] = await Promise.all([this.readSchedules(), this.readWorkspaces(), this.scanAgentRecords()]);
    // Records only add Agents the host does not list (its own entry has live status and the project name): those a
    // schedule created, and those a schedule, a run or the ledger points at (a heartbeat's target, a run's Agent).
    const listed = this.options.directory.agents, listedIds = new Set(listed.map(agent => agent.id)), referenced = new Set<string>();
    for (const schedule of schedules) { if (schedule.target.type === "agent") referenced.add(schedule.target.agentId); for (const run of schedule.runs) if (run.agentId) referenced.add(run.agentId); }
    for (const run of Object.values(this.ledger.runs)) if (run.agentId) referenced.add(run.agentId);
    const unlisted = scanned.agents.filter(agent => !listedIds.has(agent.id) && (agent.scheduleRunId || referenced.has(agent.id)));
    const key = contentRevision([stamps, stamp, this.options.directory.digest,
      unlisted.map(agent => [agent.id, agent.status, agent.archivedAt, agent.attentionReason, agent.title, agent.updatedAt, agent.workspaceId])]);
    if (key !== this.baseKey || !this.base) {
      const agents = [...listed, ...unlisted];
      const unlistedIds = new Set(unlisted.map(agent => agent.id));
      this.building ??= Promise.resolve().then(() => this.build(schedules, records, error, agents, unlistedIds)).finally(() => { this.building = null; });
      this.base = await this.building; this.baseKey = key; this.windows.clear();
    }
    return this.base;
  }

  /** The run feed for a window; an unchanged `revision` answers in a few bytes. */
  async list(paseo: PaseoApi | null, input: { revision?: string; window?: RunWindow } = {}): Promise<ScheduleRunsResponse> {
    const base = await this.current(paseo);
    const window = input.window ?? "recent", limits = RUN_WINDOWS[window];
    // Window edges move in 10-minute steps; a step that moves no run keeps the revision, so polls stay a few bytes.
    const bucket = Math.floor(this.now() / WINDOW_STEP_MS) * WINDOW_STEP_MS;
    const cutoff = limits.days === null ? null : bucket - limits.days * DAY_MS;
    const cacheKey = `${bucket}:${this.notice ?? ""}`;
    let state = this.windows.get(window)?.key === cacheKey ? this.windows.get(window)!.state : undefined;
    if (!state) {
      let runs = 0, heartbeats = 0;
      const kept = base.rows.filter(row => {
        if (cutoff !== null && (parseTime(row.startedAt) || parseTime(row.scheduledFor)) < cutoff && row.status !== "running") return false;
        return row.kind === "heartbeat" ? heartbeats++ < limits.heartbeats : runs++ < limits.runs;
      });
      const week = { runs: 0, failed: 0, heartbeats: 0, heartbeatsFailed: 0 }, weekFloor = bucket - 7 * DAY_MS;
      for (const row of base.rows) {
        if ((parseTime(row.startedAt) || parseTime(row.scheduledFor)) < weekFloor) continue;
        if (row.kind === "heartbeat") { week.heartbeats++; if (row.status === "failed") week.heartbeatsFailed++; }
        else { week.runs++; if (row.status === "failed") week.failed++; }
      }
      const keptHeartbeats = kept.filter(row => row.kind === "heartbeat").length, allHeartbeats = base.rows.filter(row => row.kind === "heartbeat").length;
      const body = { window, schedules: base.summaries.slice(0, 400), runs: kept, older: base.rows.length - allHeartbeats - (kept.length - keptHeartbeats), olderHeartbeats: allHeartbeats - keptHeartbeats,
        truncated: kept.length < base.rows.length, week,
        reconstructed: base.reconstructed, error: base.error, notice: this.notice };
      state = { mode: "full", unchanged: false, revision: contentRevision(body), generatedAt: new Date(this.now()).toISOString(), ...body };
      this.windows.set(window, { key: cacheKey, state });
    }
    return input.revision && input.revision === state.revision ? { mode: "unchanged", unchanged: true, revision: state.revision } : state;
  }

  private build(schedules: StoredSchedule[], workspaces: Map<string, WorkspaceRecord>, readError: string | null, agents: StatsDirectoryAgent[], unlistedIds: ReadonlySet<string>): Base {
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const byRun = new Map<string, StatsDirectoryAgent>();
    for (const agent of agents) if (agent.scheduleRunId) byRun.set(agent.scheduleRunId, agent);
    const nowIso = new Date(this.now()).toISOString();
    const rows: ScheduleRunRow[] = [];
    const summaries = new Map<string, Omit<ScheduleSummary, "recent" | "total" | "failed" | "running">>();
    const seenRuns = new Set<string>();

    const agentRef = (agent: StatsDirectoryAgent | undefined, id: string | null): ScheduleRunRow["agent"] =>
      agent ? { id: agent.id, title: clip(agent.title, 240), status: agent.status.slice(0, 40), archivedAt: agent.archivedAt, known: true, ...(unlistedIds.has(agent.id) ? { listed: false } : {}) } : id ? { id, title: null, status: null, archivedAt: null, known: false } : null;
    const workspaceRef = (id: string | null): ScheduleRunRow["workspace"] => {
      if (!id) return null;
      const record = workspaces.get(id);
      return { id, name: clip(record?.title?.trim() || record?.displayName?.trim() || null, 240), branch: clip(record?.branch?.trim() || null, 240), archivedAt: record?.archivedAt ?? null };
    };
    const linkOf = (output: string | null | undefined, workspaceId: string | null, stored: string | null = null): RunLink | null => {
      const archived = workspaceId ? workspaces.get(workspaceId)?.autoArchivedChangeRequestUrl : null;
      if (archived) { const found = findChangeRequest(archived); return found ? { ...found, state: "merged" } : null; }
      return findChangeRequest(output) ?? findChangeRequest(stored);
    };

    // 1. Live schedule files.
    for (const schedule of schedules) {
      const kind = schedule.target.type === "agent" ? "heartbeat" as const : "new-agent" as const;
      const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
      const name = nameOf(schedule), timezone = zoneOf(schedule);
      const targetAgentId = schedule.target.type === "agent" ? schedule.target.agentId : null;
      const targetAgent = targetAgentId ? byId.get(targetAgentId) : undefined;
      const projectName = targetAgent?.projectName ?? (config?.cwd ? basename(config.cwd) : null);
      const provider = clip(config?.provider ?? targetAgent?.provider ?? null, 120);
      summaries.set(schedule.id, { id: schedule.id, name, kind, status: schedule.status, cadence: cadenceLabel(schedule.cadence), timezone, target: clip(targetAgent?.title ?? (config?.cwd ? basename(config.cwd) : null), 240),
        nextRunAt: schedule.nextRunAt ?? null, lastRunAt: schedule.lastRunAt ?? null, provider });
      this.ledger.schedules[schedule.id] = { name, kind, cadence: cadenceLabel(schedule.cadence), timezone, provider, projectName: clip(projectName, 240), lastSeenAt: nowIso, deletedAt: null };
      for (const run of schedule.runs) {
        // A failed heartbeat never records its Agent; the schedule's own target is the Agent it prompted.
        const agent = (run.agentId ? byId.get(run.agentId) : undefined) ?? byRun.get(run.id) ?? targetAgent;
        const agentId = run.agentId ?? agent?.id ?? targetAgentId;
        const workspaceId = run.workspaceId ?? agent?.workspaceId ?? null;
        const link = linkOf(run.output, workspaceId);
        seenRuns.add(run.id);
        rows.push({ id: run.id, scheduleId: schedule.id, scheduleName: name, kind, status: run.status, source: "schedule", scheduledFor: run.scheduledFor ?? null, startedAt: run.startedAt, endedAt: run.endedAt ?? null,
          preview: previewOf(run.output), hasOutput: !!run.output?.trim(), error: clip(run.error, ERROR_MAX), agent: agentRef(agent, agentId ?? null), workspace: workspaceRef(workspaceId),
          projectName: clip(agent?.projectName ?? projectName, 240), link });
        this.ledger.runs[run.id] = { scheduleId: schedule.id, kind, status: run.status, scheduledFor: run.scheduledFor ?? null, startedAt: run.startedAt, endedAt: run.endedAt ?? null,
          agentId: agentId ?? null, workspaceId, error: clip(run.error, 300), link: link?.url ?? null, hadOutput: !!run.output?.trim() };
      }
    }
    // 2. Ledger runs whose schedule file (or run record) is gone.
    const live = new Set(schedules.map(schedule => schedule.id));
    for (const [id, meta] of Object.entries(this.ledger.schedules)) if (!live.has(id) && !meta.deletedAt) this.ledger.schedules[id] = { ...meta, deletedAt: nowIso };
    for (const [runId, run] of Object.entries(this.ledger.runs)) {
      if (seenRuns.has(runId)) continue;
      const meta = this.ledger.schedules[run.scheduleId];
      const agent = (run.agentId ? byId.get(run.agentId) : undefined) ?? byRun.get(runId);
      // A run still "running" in the ledger after its file vanished never finished as far as anyone recorded.
      const status: RunStatus = run.status === "running" ? agent ? agentRunStatus(agent) : "unknown" : run.status;
      seenRuns.add(runId);
      rows.push({ id: runId, scheduleId: run.scheduleId, scheduleName: meta?.name ?? `定时任务 ${run.scheduleId}`, kind: run.kind, status, source: "ledger", scheduledFor: run.scheduledFor, startedAt: run.startedAt, endedAt: run.endedAt,
        preview: null, hasOutput: false, error: run.error, agent: agentRef(agent, run.agentId), workspace: workspaceRef(run.workspaceId ?? agent?.workspaceId ?? null), projectName: agent?.projectName ?? meta?.projectName ?? null, link: linkOf(null, run.workspaceId, run.link) });
      if (!summaries.has(run.scheduleId)) summaries.set(run.scheduleId, { id: run.scheduleId, name: meta?.name ?? `定时任务 ${run.scheduleId}`, kind: run.kind, status: "deleted", cadence: meta?.cadence ?? "",
        timezone: meta?.timezone ?? null, target: meta?.projectName ?? null, nextRunAt: null, lastRunAt: null, provider: meta?.provider ?? null });
    }
    // 3. Agents a schedule created that nobody recorded (schedule deleted before the observatory saw it).
    const orphanTitles = new Map<string, Map<string, number>>();
    let reconstructed = 0;
    for (const agent of agents) {
      if (!agent.scheduleRunId || !agent.scheduleId || seenRuns.has(agent.scheduleRunId)) continue;
      reconstructed++;
      seenRuns.add(agent.scheduleRunId);
      const titles = orphanTitles.get(agent.scheduleId) ?? new Map<string, number>();
      if (agent.title) titles.set(agent.title, (titles.get(agent.title) ?? 0) + 1);
      orphanTitles.set(agent.scheduleId, titles);
      const meta = this.ledger.schedules[agent.scheduleId];
      rows.push({ id: agent.scheduleRunId, scheduleId: agent.scheduleId, scheduleName: meta?.name ?? "", kind: "new-agent", status: agentRunStatus(agent), source: "agent", scheduledFor: null, startedAt: agent.createdAt,
        endedAt: agent.archivedAt ?? agent.updatedAt ?? null, preview: null, hasOutput: false, error: null, agent: agentRef(agent, agent.id), workspace: workspaceRef(agent.workspaceId ?? null), projectName: agent.projectName, link: null });
    }
    for (const [scheduleId, titles] of orphanTitles) {
      const meta = this.ledger.schedules[scheduleId];
      const title = [...titles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const name = meta?.name ?? clip(title ? previewOf(title, 60) : null, 200) ?? `定时任务 ${scheduleId}`;
      for (const row of rows) if (row.scheduleId === scheduleId && row.source === "agent") row.scheduleName = name;
      if (!summaries.has(scheduleId)) summaries.set(scheduleId, { id: scheduleId, name, kind: "new-agent", status: "deleted", cadence: meta?.cadence ?? "", timezone: meta?.timezone ?? null,
        target: meta?.projectName ?? rows.find(row => row.scheduleId === scheduleId)?.projectName ?? null, nextRunAt: null, lastRunAt: null, provider: meta?.provider ?? null });
    }

    rows.sort((a, b) => parseTime(b.startedAt) - parseTime(a.startedAt) || a.id.localeCompare(b.id));
    const scheduleList: ScheduleSummary[] = [...summaries.values()].map(summary => {
      const own = rows.filter(row => row.scheduleId === summary.id);
      return { ...summary, recent: own.slice(0, 10).reverse().map(row => row.status), total: own.length, failed: own.filter(row => row.status === "failed").length, running: own.filter(row => row.status === "running").length };
    }).sort((a, b) => Number(a.status === "deleted") - Number(b.status === "deleted") || Number(b.running > 0) - Number(a.running > 0) || a.name.localeCompare(b.name, "zh-CN"));

    this.trimLedger();
    this.scheduleLedgerWrite();
    return { rows, summaries: scheduleList, reconstructed, error: readError };
  }

  /** Newest 3000 runs within 400 days; schedules only while a run still points at them (or they still exist). */
  private trimLedger() {
    const floor = this.now() - LEDGER_DAYS * DAY_MS;
    const runs = Object.entries(this.ledger.runs).filter(([, run]) => (parseTime(run.startedAt) || this.now()) >= floor)
      .sort((a, b) => parseTime(b[1].startedAt) - parseTime(a[1].startedAt)).slice(0, LEDGER_RUNS);
    this.ledger.runs = Object.fromEntries(runs);
    const used = new Set(runs.map(([, run]) => run.scheduleId));
    const schedules = Object.entries(this.ledger.schedules).filter(([id, meta]) => used.has(id) || !meta.deletedAt);
    this.ledger.schedules = Object.fromEntries(schedules.sort((a, b) => parseTime(b[1].lastSeenAt) - parseTime(a[1].lastSeenAt)).slice(0, LEDGER_SCHEDULES));
  }

  private scheduleLedgerWrite() {
    if (!this.ledgerWritable) return;
    // `lastSeenAt` alone moving is not worth a write.
    const next = contentRevision({ ...this.ledger, schedules: Object.fromEntries(Object.entries(this.ledger.schedules).map(([id, meta]) => [id, { ...meta, lastSeenAt: "" }])) });
    if (next === this.ledgerRevision) return;
    this.ledgerRevision = next;
    this.dirty = true;
    // After close() a change is only kept in memory: nothing may write once the plugin (or a test) has let go of the directory.
    if (this.closed) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush(); }, this.writeDelayMs);
    this.writeTimer.unref?.();
  }

  /** Writes the ledger now (atomically: a unique temporary file, then rename); writes run one after another. */
  flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    if (!this.ledgerWritable) return this.writes;
    const snapshot = JSON.stringify(this.ledger);
    this.dirty = false;
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.ledgerFile), { recursive: true });
      const temporary = `${this.ledgerFile}.${process.pid}.${(++temporarySequence).toString(36)}.tmp`;
      try {
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, this.ledgerFile);
      } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      if (this.notice?.startsWith("定时运行账本无法保存")) this.notice = null;
    }).catch(error => {
      this.notice = "定时运行账本无法保存，已删除任务的运行可能不会保留。";
      this.warn(`could not save the ledger: ${String(error)}`);
    });
    return this.writes;
  }

  /** Stops the write timer, saves pending changes once and waits for every write (and the initial ledger read); later changes stay in memory. */
  async close(): Promise<void> {
    if (this.closed) return this.writes;
    this.closed = true;
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    await this.ready.catch(() => {});
    return this.dirty ? this.flush() : this.writes;
  }

  /** One run's full recorded reply (only the live schedule file has it), its prompt, and how the feed describes it. */
  async run(paseo: PaseoApi | null, runId: string): Promise<ScheduleRunDetail> {
    const base = await this.current(paseo);
    const row = base.rows.find(candidate => candidate.id === runId) ?? null;
    const schedule = row ? base.summaries.find(summary => summary.id === row.scheduleId) ?? null : null;
    for (const file of this.files.values()) {
      const stored = file.value;
      const run = stored?.runs.find(candidate => candidate.id === runId);
      if (!stored || !run) continue;
      const output = run.output?.replace(/^\s*---\s*\n/, "").trim() || null;
      return { runId, output: output ? output.slice(0, OUTPUT_MAX) : null, outputTruncated: !!output && output.length > OUTPUT_MAX, prompt: clip(stored.prompt ?? null, PROMPT_MAX),
        note: output ? null : run.status === "running" ? "还在运行，结束后会记录最终回复。" : "这次运行没有记录最终回复，可以读取会话记录。", row, schedule };
    }
    return { runId, output: null, outputTruncated: false, prompt: null, row, schedule,
      note: row?.source === "ledger" || this.ledger.runs[runId] ? "这个定时任务已被删除，回复没有保留；可以读取会话记录查看最后回复。" : "定时任务记录已不存在，可以读取会话记录查看最后回复。" };
  }
}

export function registerSchedules(server: PluginServerContext, dependencies: { directory: ScheduleDirectory }): () => Promise<void> {
  const index = new ScheduleIndex({ directory: dependencies.directory });
  server.handle(listScheduleRuns, (input, { paseo }) => index.list(paseo, input));
  server.handle(getScheduleRun, (input, { paseo }) => index.run(paseo, input.runId));
  // Plugin stop / reload: pending ledger changes are saved before the process lets go.
  return () => index.close();
}
