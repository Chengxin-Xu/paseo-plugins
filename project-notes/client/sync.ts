import type { BoardProject, BoardSnapshot, DashboardUpdate, UnavailableBoard } from "../shared/board";

/**
 * The shared client copy of the dashboard. `revision` is the last server revision merged into it. `unavailable` lists
 * the boards the server left out because of their size; their projects show a notice instead of stale notes.
 */
export interface DashboardData { revision: string | null; changedAt: number; projects: BoardProject[]; boards: BoardSnapshot[]; unavailable?: UnavailableBoard[]; writeEpoch?: number; pendingProjectIds?: string[] }

export const POLL_FAST_MS = 5_000;
export const POLL_IDLE_MS = 15_000;
/** Without any change for this long, polling relaxes to the idle interval. */
export const IDLE_AFTER_MS = 60_000;

/**
 * Merges a full, partial or unchanged server update. An unchanged update returns `current`
 * itself, so React Query keeps the same data and nothing re-renders. Content tokens, not
 * numeric board revisions, are authoritative after an external backup restore. A request
 * that started before a local write cannot replace that write's result.
 */
export function mergeDashboard(current: DashboardData | undefined, update: DashboardUpdate, now: number, expectedWriteEpoch?: number): DashboardData {
  if (current && expectedWriteEpoch !== undefined && expectedWriteEpoch !== (current.writeEpoch ?? 0)) return current;
  if (update.unchanged) return current ?? { revision: null, changedAt: now, projects: [], boards: [] };
  if (update.mode === "delta" && update.baseRevision !== current?.revision) return { ...(current ?? { changedAt: now, projects: [], boards: [] }), revision: null };
  // Every server reply with data carries the full list; a write result (or an older server) keeps the current one.
  const unavailable = update.unavailable ?? current?.unavailable;
  const hidden = new Set(unavailable?.flatMap(board => board.projectId ? [board.projectId] : []));
  const removed = new Set(update.removedProjectIds ?? []);
  const boards = new Map((update.mode === "full" ? [] : current?.boards ?? []).filter(board => !hidden.has(board.projectId) && !removed.has(board.projectId)).map(board => [board.projectId, board]));
  for (const next of update.boards) {
    const previous = boards.get(next.projectId);
    if (!hidden.has(next.projectId) && (update.mode || !previous || next.revision >= previous.revision)) boards.set(next.projectId, next);
  }
  return { revision: update.revision ?? null, changedAt: now, projects: update.projects?.map(project => update.retiredProjectIds?.includes(project.id) ? { ...project, retired: true } : project) ?? current?.projects ?? [], boards: [...boards.values()], unavailable, ...(current?.writeEpoch ? { writeEpoch: current.writeEpoch } : {}) };
}

/** Keep the last known server revision, and ask the next delta to authoritatively refresh written boards.
 * This also covers a restored backup with the same token as before the write acknowledgement. */
export function patchDashboard(current: DashboardData | undefined, board: BoardSnapshot, now: number): DashboardData {
  return { ...mergeDashboard(current, { boards: [board] }, now), revision: current?.revision ?? null, pendingProjectIds: [...new Set([...(current?.pendingProjectIds ?? []), board.projectId])], writeEpoch: (current?.writeEpoch ?? 0) + 1 };
}

export function pollInterval(visible: boolean, data: Pick<DashboardData, "changedAt"> | undefined, now: number): number | false {
  if (!visible) return false;
  return data && now - data.changedAt >= IDLE_AFTER_MS ? POLL_IDLE_MS : POLL_FAST_MS;
}
