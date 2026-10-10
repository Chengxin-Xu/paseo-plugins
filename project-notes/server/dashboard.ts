import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { INBOX_DESCRIPTION, INBOX_PROJECT_ID, type BoardProject, type DashboardUpdate, type UnavailableBoard } from "../shared/board";
import type { BoardStore } from "./store";

type Paseo = PluginHandlerContext["paseo"];
export type PaseoProject = Awaited<ReturnType<Paseo["projects"]["list"]>>["projects"][number];
const PROJECTS_KEY = "\u0000projects";
const UNAVAILABLE_KEY = "\u0000unavailable:";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Rejects after `ms`; the underlying call keeps running but no longer holds the RPC. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Paseo project list shared by every RPC. `project.update` events invalidate it immediately;
 * the TTL covers events missed while the plugin session reconnects.
 */
export class ProjectDirectory {
  private value: { at: number; projects: PaseoProject[] } | null = null;
  private pending: Promise<PaseoProject[]> | null = null;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {}) {}
  private watch(paseo: Paseo) {
    if (this.unsubscribe) return;
    try { this.unsubscribe = paseo.projects.subscribe(() => this.invalidate()); }
    catch { this.unsubscribe = () => {}; }
  }
  invalidate() { this.generation++; this.value = null; this.pending = null; }
  /** `fresh` bypasses the cache (launch validation). A failed refresh falls back to the last list. */
  list(paseo: Paseo, fresh = false): Promise<PaseoProject[]> {
    this.watch(paseo);
    const now = this.options.now ?? Date.now;
    if (!fresh && this.value && now() - this.value.at < (this.options.ttlMs ?? 30_000)) return Promise.resolve(this.value.projects);
    if (!fresh && this.pending) return this.pending;
    const generation = this.generation, stale = this.value;
    const task = withTimeout(paseo.projects.list(), this.options.timeoutMs ?? 8_000, "读取 Paseo 项目列表超时，请稍后刷新。")
      .then(result => {
        if (generation === this.generation) this.value = { at: now(), projects: result.projects };
        return result.projects;
      }, error => { if (stale && !fresh) return stale.projects; throw error; })
      .finally(() => { if (this.pending === task) this.pending = null; });
    if (!fresh) this.pending = task;
    return task;
  }
  stop() { this.unsubscribe?.(); this.unsubscribe = () => {}; }
}

export function boardProjects(projects: readonly PaseoProject[]): BoardProject[] {
  return [{ id: INBOX_PROJECT_ID, name: "随手记", path: INBOX_DESCRIPTION }, ...projects.map(p => ({ id: p.projectId, name: p.projectDisplayName, path: p.projectRootPath }))];
}

/**
 * Dashboard reads with content revisions. A caller that sends its last revision gets
 * `{ unchanged: true }` or only what changed since then; unknown revisions get everything.
 * Boards the size limits leave out are listed in `unavailable` (part of the revision), never a failed overview.
 */
export class DashboardService {
  /** Recent revisions → per-board tokens, so a delta can be computed against any of them. */
  private history = new Map<string, Map<string, string>>();
  constructor(private readonly store: BoardStore, private readonly projects: ProjectDirectory, private readonly historyLimit = 64) {}
  async read(paseo: Paseo, known?: string): Promise<DashboardUpdate> {
    const [listed, { entries, unavailable: skipped }] = await Promise.all([this.projects.list(paseo), this.store.readEntries()]);
    const projects = boardProjects(listed);
    const knownIds = new Set(projects.map(p => p.id));
    // Notes of a removed project stay visible under a stand-in name.
    const keep = (projectId: string) => {
      if (knownIds.has(projectId)) return;
      projects.push({ id: projectId, name: `历史项目 · ${projectId.slice(-8)}`, path: "项目已移除，手记仍保留" });
      knownIds.add(projectId);
    };
    for (const { snapshot } of entries) keep(snapshot.projectId);
    // Boards left out by the size limits: name them from the project list when this process has not read them.
    const byFile = skipped.length ? new Map(projects.map(p => [this.store.boardFile(p.id), p.id])) : new Map<string, string>();
    const unavailable: UnavailableBoard[] = skipped.map(board => ({ projectId: board.projectId ?? byFile.get(board.file) ?? null, bytes: board.bytes, reason: board.reason }));
    for (const board of unavailable) if (board.projectId) keep(board.projectId);
    const tokens = new Map([
      [PROJECTS_KEY, hash(JSON.stringify(projects)).slice(0, 16)], ...entries.map(e => [e.snapshot.projectId, e.token] as const),
      ...skipped.map((board, index) => [`${UNAVAILABLE_KEY}${board.file}`, `${board.reason}:${unavailable[index]!.projectId ?? ""}`] as const),
    ]);
    const revision = hash([...tokens].map(([key, token]) => `${key}\u0000${token}`).join("\n")).slice(0, 24);
    this.history.delete(revision); this.history.set(revision, tokens);
    for (const oldest of this.history.keys()) { if (this.history.size <= this.historyLimit) break; this.history.delete(oldest); }
    if (known === revision) return { unchanged: true, revision };
    const base = known ? this.history.get(known) : undefined;
    if (!base) return { revision, projects, boards: entries.map(e => e.snapshot), unavailable };
    return {
      revision, ...(base.get(PROJECTS_KEY) === tokens.get(PROJECTS_KEY) ? {} : { projects }),
      boards: entries.filter(e => base.get(e.snapshot.projectId) !== e.token).map(e => e.snapshot), unavailable,
    };
  }
}
