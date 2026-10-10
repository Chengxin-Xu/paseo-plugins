import type { BoardProject, BoardSnapshot, DashboardUpdate, UnavailableBoard } from "../shared/board";

/**
 * The shared client copy of the dashboard. `revision` is the last server revision merged into it. `unavailable` lists
 * the boards the server left out because of their size; their projects show a notice instead of stale notes.
 */
export interface DashboardData { revision: string | null; changedAt: number; projects: BoardProject[]; boards: BoardSnapshot[]; unavailable?: UnavailableBoard[] }

export const POLL_FAST_MS = 5_000;
export const POLL_IDLE_MS = 15_000;
/** Without any change for this long, polling relaxes to the idle interval. */
export const IDLE_AFTER_MS = 60_000;

/**
 * Merges a full, partial or unchanged server update. An unchanged update returns `current`
 * itself, so React Query keeps the same data and nothing re-renders. No board is ever rolled
 * back to an older revision (another view may already hold a newer write result).
 */
export function mergeDashboard(current: DashboardData | undefined, update: DashboardUpdate, now: number): DashboardData {
  if (update.unchanged) return current ?? { revision: null, changedAt: now, projects: [], boards: [] };
  // Every server reply with data carries the full list; a write result (or an older server) keeps the current one.
  const unavailable = update.unavailable ?? current?.unavailable;
  const hidden = new Set(unavailable?.flatMap(board => board.projectId ? [board.projectId] : []));
  const boards = new Map((current?.boards ?? []).filter(board => !hidden.has(board.projectId)).map(board => [board.projectId, board]));
  for (const next of update.boards) {
    const previous = boards.get(next.projectId);
    if (!hidden.has(next.projectId) && (!previous || next.revision >= previous.revision)) boards.set(next.projectId, next);
  }
  return { revision: update.revision ?? null, changedAt: now, projects: update.projects ?? current?.projects ?? [], boards: [...boards.values()], unavailable };
}

/** Applies a write result locally. The server revision stays, so the next poll still reports what changed. */
export function patchDashboard(current: DashboardData | undefined, board: BoardSnapshot, now: number): DashboardData {
  return mergeDashboard(current, { revision: current?.revision ?? undefined, boards: [board] }, now);
}

export function pollInterval(visible: boolean, data: Pick<DashboardData, "changedAt"> | undefined, now: number): number | false {
  if (!visible) return false;
  return data && now - data.changedAt >= IDLE_AFTER_MS ? POLL_IDLE_MS : POLL_FAST_MS;
}
