import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../server/store";
import { DashboardService, ProjectDirectory, withTimeout, type PaseoProject } from "../server/dashboard";
import { dashboardUpdateSchema, type NoteFields } from "../shared/board";

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fields: NoteFields = { kind: "task", title: "看板", body: "", status: "todo", priority: "normal", pinned: false };
const project = (id: string, name = id): PaseoProject => ({ projectId: id, projectDisplayName: name, projectRootPath: `/repo/${id}`, projectKind: "git" }) as PaseoProject;

/** Minimal PaseoApi projects surface: counts list calls and lets tests fire project.update. */
function fakePaseo(initial: PaseoProject[]) {
  let projects = initial;
  const listeners = new Set<() => void>();
  const api = {
    calls: 0,
    projects: {
      list: vi.fn(async () => { api.calls++; return { requestId: "r", projects }; }),
      subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    },
    set(next: PaseoProject[]) { projects = next; },
    emit() { for (const listener of listeners) listener(); },
    listeners,
  };
  return api;
}
async function fixture(projects = [project("prj_a", "Alpha"), project("prj_b", "Beta")]) {
  const root = await mkdtemp(join(tmpdir(), "project-notes-dashboard-")); directories.push(root);
  const store = new BoardStore(root);
  const paseo = fakePaseo(projects);
  const directory = new ProjectDirectory();
  return { root, store, paseo, directory, dashboard: new DashboardService(store, directory), api: paseo as never };
}
const create = (store: BoardStore, projectId: string, requestId: string, title = "看板") => store.write({ projectId, requestId, operation: { type: "create", fields: { ...fields, title } } });

describe("DashboardService revisions", () => {
  it("returns the full dashboard, then a tiny unchanged reply for the same revision", async () => {
    const { store, dashboard, api } = await fixture();
    await create(store, "prj_a", "dash-create-1");
    const full = await dashboard.read(api);
    expect(dashboardUpdateSchema.parse(full)).toEqual(full);
    if (full.unchanged) throw new Error("expected data");
    expect(full.revision).toMatch(/^[a-f0-9]{24}$/);
    expect(full.projects!.map(p => p.name)).toEqual(["随手记", "Alpha", "Beta"]);
    expect(full.boards.map(b => b.projectId)).toEqual(["prj_a"]);
    const again = await dashboard.read(api, full.revision);
    expect(again).toEqual({ unchanged: true, revision: full.revision });
    expect(JSON.stringify(again).length).toBeLessThan(80);
  });

  it("sends only boards that changed since the caller's revision", async () => {
    const { store, dashboard, api } = await fixture();
    await create(store, "prj_a", "dash-delta-1");
    await create(store, "prj_b", "dash-delta-2");
    const base = await dashboard.read(api);
    await create(store, "prj_b", "dash-delta-3", "新的一条");
    const delta = await dashboard.read(api, base.revision);
    if (delta.unchanged) throw new Error("expected a delta");
    expect(delta.revision).not.toBe(base.revision);
    expect(delta.projects).toBeUndefined();
    expect(delta.boards.map(b => [b.projectId, b.revision])).toEqual([["prj_b", 2]]);
    // A brand-new board is part of the delta too.
    await create(store, "__inbox__", "dash-delta-4");
    const next = await dashboard.read(api, delta.revision);
    if (next.unchanged) throw new Error("expected a delta");
    expect(next.boards.map(b => b.projectId)).toEqual(["__inbox__"]);
  });

  it("bumps the revision for writes from another store instance and for manual file edits", async () => {
    const { root, store, dashboard, api } = await fixture();
    await create(store, "prj_a", "dash-ext-1");
    const base = await dashboard.read(api);
    await create(new BoardStore(root), "prj_a", "dash-ext-2");
    const afterCli = await dashboard.read(api, base.revision);
    expect(afterCli.unchanged).toBeFalsy();
    const file = join(root, (await readdir(root)).find(name => name.endsWith(".json"))!);
    await writeFile(file, (await readFile(file, "utf8")).replace("\"看板\"", "\"手改\""));
    const afterEdit = await dashboard.read(api, afterCli.revision);
    if (afterEdit.unchanged) throw new Error("expected a delta");
    expect(afterEdit.boards[0]!.items.some(item => item.title === "手改")).toBe(true);
  });

  it("includes the project list only when it changed", async () => {
    const { dashboard, paseo, api } = await fixture();
    const base = await dashboard.read(api);
    paseo.set([project("prj_a", "Alpha 改名"), project("prj_b", "Beta")]);
    paseo.emit(); // project.update
    const renamed = await dashboard.read(api, base.revision);
    if (renamed.unchanged) throw new Error("expected a delta");
    expect(renamed.boards).toEqual([]);
    expect(renamed.projects!.find(p => p.id === "prj_a")!.name).toBe("Alpha 改名");
  });

  it("keeps notes of removed projects visible as history projects", async () => {
    const { store, dashboard, paseo, api } = await fixture();
    await create(store, "prj_gone_1234abcd", "dash-gone-1");
    const full = await dashboard.read(api);
    if (full.unchanged) throw new Error("expected data");
    expect(full.projects!.at(-1)).toEqual({ id: "prj_gone_1234abcd", name: "历史项目 · 1234abcd", path: "项目已移除，手记仍保留" });
    paseo.set([project("prj_gone_1234abcd", "回来了")]); paseo.emit();
    const back = await dashboard.read(api, full.revision);
    if (back.unchanged) throw new Error("expected a delta");
    expect(back.projects!.filter(p => p.id === "prj_gone_1234abcd").map(p => p.name)).toEqual(["回来了"]);
  });

  it("answers unknown or evicted revisions with everything, and is deterministic across restarts", async () => {
    const { store, directory, api } = await fixture();
    const dashboard = new DashboardService(store, directory, 2);
    await create(store, "prj_a", "dash-evict-1");
    const oldest = await dashboard.read(api);
    for (const id of ["dash-evict-2", "dash-evict-3"]) { await create(store, "prj_b", id); await dashboard.read(api); }
    const evicted = await dashboard.read(api, oldest.revision);
    if (evicted.unchanged) throw new Error("expected data");
    expect(evicted.projects).toBeDefined();
    expect(evicted.boards.map(b => b.projectId)).toEqual(["prj_a", "prj_b"]);
    const unknown = await dashboard.read(api, "f".repeat(24));
    expect(unknown.unchanged).toBeFalsy();
    // A restarted plugin computes the same revision for the same content.
    const restarted = new DashboardService(new BoardStore((store as unknown as { root: string }).root), new ProjectDirectory());
    expect(await restarted.read(api, evicted.revision)).toEqual({ unchanged: true, revision: evicted.revision });
  });
});

describe("ProjectDirectory", () => {
  it("caches the project list, refreshes after the TTL and on project.update", async () => {
    let now = 1_000;
    const paseo = fakePaseo([project("prj_a")]);
    const directory = new ProjectDirectory({ ttlMs: 30_000, now: () => now });
    await directory.list(paseo as never); await directory.list(paseo as never);
    expect(paseo.calls).toBe(1);
    expect(paseo.projects.subscribe).toHaveBeenCalledTimes(1);
    now += 29_000; await directory.list(paseo as never);
    expect(paseo.calls).toBe(1);
    now += 2_000; await directory.list(paseo as never);
    expect(paseo.calls).toBe(2);
    paseo.emit(); await directory.list(paseo as never);
    expect(paseo.calls).toBe(3);
    await directory.list(paseo as never, true);
    expect(paseo.calls).toBe(4);
    directory.stop();
    expect(paseo.listeners.size).toBe(0);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const paseo = fakePaseo([project("prj_a")]);
    const directory = new ProjectDirectory();
    const [a, b] = await Promise.all([directory.list(paseo as never), directory.list(paseo as never)]);
    expect(a).toBe(b);
    expect(paseo.calls).toBe(1);
  });

  it("times out well inside the RPC budget and falls back to the last list", async () => {
    vi.useFakeTimers();
    let now = 0;
    const paseo = fakePaseo([project("prj_a")]);
    const directory = new ProjectDirectory({ ttlMs: 1_000, timeoutMs: 8_000, now: () => now });
    const first = await directory.list(paseo as never);
    paseo.projects.list.mockImplementation(() => new Promise(() => {}));
    now = 5_000;
    const stale = directory.list(paseo as never);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await stale).toBe(first);
    // Nothing cached yet: the caller gets the timeout error instead of a 30 s host timeout.
    const cold = new ProjectDirectory({ timeoutMs: 8_000 });
    const failing = cold.list(paseo as never);
    const assertion = expect(failing).rejects.toThrow(/项目列表超时/);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it("keeps working when the host cannot subscribe", async () => {
    const paseo = fakePaseo([project("prj_a")]);
    paseo.projects.subscribe.mockImplementation(() => { throw new Error("Paseo API is disposed"); });
    const directory = new ProjectDirectory();
    expect(await directory.list(paseo as never)).toHaveLength(1);
    expect(await directory.list(paseo as never)).toHaveLength(1);
    expect(paseo.projects.subscribe).toHaveBeenCalledTimes(1);
  });

  it("withTimeout clears its timer when the call settles first", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(7), 1_000, "late")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});
