import { describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, POLL_FAST_MS, POLL_IDLE_MS, mergeDashboard, patchDashboard, pollInterval, type DashboardData } from "../client/sync";
import type { BoardSnapshot } from "../shared/board";

const board = (projectId: string, revision: number, title = "条目"): BoardSnapshot => ({
  projectId, revision,
  items: [{ id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", projectId, revision: 1, kind: "task", title, body: "", status: "todo", priority: "normal", pinned: false, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", deletedAt: null }],
});
const projects = [{ id: "__inbox__", name: "随手记", path: "" }, { id: "prj_a", name: "A", path: "/a" }];

describe("mergeDashboard", () => {
  it("returns the very same object for an unchanged reply, so nothing re-renders", () => {
    const current: DashboardData = { revision: "r1", changedAt: 1, projects, boards: [board("prj_a", 1)] };
    expect(mergeDashboard(current, { unchanged: true, revision: "r1" }, 99)).toBe(current);
    expect(mergeDashboard(undefined, { unchanged: true, revision: "r1" }, 99)).toEqual({ revision: null, changedAt: 99, projects: [], boards: [] });
  });

  it("applies a delta: changed boards replace, others and the project list stay", () => {
    const current: DashboardData = { revision: "r1", changedAt: 1, projects, boards: [board("prj_a", 1), board("__inbox__", 3)] };
    const next = mergeDashboard(current, { revision: "r2", boards: [board("prj_a", 2, "新")] }, 50);
    expect(next.revision).toBe("r2");
    expect(next.changedAt).toBe(50);
    expect(next.projects).toBe(projects);
    expect(next.boards.map(b => [b.projectId, b.revision])).toEqual([["prj_a", 2], ["__inbox__", 3]]);
    expect(next.boards[1]).toBe(current.boards[1]);
  });

  it("never rolls a board back to an older revision and treats a sent project list as authoritative", () => {
    const current: DashboardData = { revision: "r1", changedAt: 1, projects, boards: [board("prj_a", 5)] };
    const next = mergeDashboard(current, { revision: "r2", projects: [projects[0]!], boards: [board("prj_a", 4), board("prj_b", 1)] }, 2);
    expect(next.boards.map(b => [b.projectId, b.revision])).toEqual([["prj_a", 5], ["prj_b", 1]]);
    expect(next.projects).toEqual([projects[0]]);
  });

  it("accepts a full reply from an older server that sends no revision", () => {
    const next = mergeDashboard(undefined, { projects, boards: [board("prj_a", 1)] }, 3);
    expect(next.revision).toBeNull();
    expect(next.boards).toHaveLength(1);
  });

  it("patches a write result without claiming a newer server revision", () => {
    const current: DashboardData = { revision: "r1", changedAt: 1, projects, boards: [board("prj_a", 1)] };
    const next = patchDashboard(current, board("prj_a", 2, "刚保存"), 10);
    expect(next.revision).toBe("r1");
    expect(next.changedAt).toBe(10);
    expect(next.boards[0]!.items[0]!.title).toBe("刚保存");
    expect(patchDashboard(undefined, board("prj_a", 1), 4)).toMatchObject({ revision: null, projects: [], boards: [board("prj_a", 1)] });
  });
});

describe("unavailable boards", () => {
  it("hides boards the server left out, until the server reports them back", () => {
    const current: DashboardData = { revision: "r1", changedAt: 1, projects, boards: [board("prj_a", 1), board("__inbox__", 1)] };
    const unavailable = [{ projectId: "prj_a", bytes: 40_000_000, reason: "file" as const }, { projectId: null, bytes: 50_000_000, reason: "total" as const }];
    const next = mergeDashboard(current, { revision: "r2", boards: [], unavailable }, 5);
    expect(next.boards.map(b => b.projectId)).toEqual(["__inbox__"]);
    expect(next.unavailable).toEqual(unavailable);
    // Its own write result does not bring it back while the server leaves it out, and an unchanged reply keeps all.
    expect(patchDashboard(next, board("prj_a", 2), 6).boards.map(b => b.projectId)).toEqual(["__inbox__"]);
    expect(mergeDashboard(next, { unchanged: true, revision: "r2" }, 7)).toBe(next);
    // A reply without the list (an older server) keeps it; an empty list clears it.
    expect(mergeDashboard(next, { revision: "r3", boards: [] }, 8).unavailable).toEqual(unavailable);
    const back = mergeDashboard(next, { revision: "r4", boards: [board("prj_a", 3)], unavailable: [] }, 9);
    expect(back.boards.map(b => [b.projectId, b.revision])).toEqual([["__inbox__", 1], ["prj_a", 3]]);
    expect(back.unavailable).toEqual([]);
  });
});

describe("pollInterval", () => {
  it("stops while hidden, polls fast after changes and relaxes when idle", () => {
    expect(pollInterval(false, { changedAt: 0 }, 0)).toBe(false);
    expect(pollInterval(true, undefined, 0)).toBe(POLL_FAST_MS);
    expect(pollInterval(true, { changedAt: 1_000 }, 1_000 + IDLE_AFTER_MS - 1)).toBe(POLL_FAST_MS);
    expect(pollInterval(true, { changedAt: 1_000 }, 1_000 + IDLE_AFTER_MS)).toBe(POLL_IDLE_MS);
  });
});
