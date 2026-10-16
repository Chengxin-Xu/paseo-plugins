import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createAgentDirectory, liteAgent, type AgentLite } from "../client/agent-directory";
import { agentPhase, launchEntries, primaryLaunch, type LaunchPhase } from "../client/launch-status";
import { LaunchService } from "../server/launch";
import type { BoardStore } from "../server/store";
import type { LaunchRecord } from "../shared/launch";

// What a task card shows about the agents its note started: Paseo's agent directory (never a timeline) plus the
// plugin's launch records, so archived or deleted agents read as ended instead of failing.

const itemId = "00000000-0000-4000-8000-000000000001";
const raw = (patch: Record<string, unknown> = {}) => ({ id: "agent-1", workspaceId: "ws-1", provider: "example", status: "idle", pendingPermissions: [], labels: { "project-notes.item-id": itemId, "project-notes.launch-id": "launch-0001" }, createdAt: "2026-10-15T08:00:00.000Z", updatedAt: "2026-10-15T08:05:00.000Z", lastUserMessageAt: null, ...patch });
const lite = (patch: Record<string, unknown> = {}) => liteAgent(raw(patch) as never)!;
/** A directory as the board reads it. */
function directory(agents: AgentLite[], ready = true) {
  const map = new Map(agents.map(agent => [agent.id, agent]));
  return { ready: () => ready, get: (id: string) => map.get(id), list: () => [...map.values()], version: () => 1 };
}
const record = (patch: Partial<LaunchRecord> = {}): LaunchRecord => ({ launchId: "launch-0001", itemId, stage: "started", workspaceId: "ws-1", agentId: "agent-1", error: null, at: "2026-10-15T08:00:00.000Z", ...patch });
const phases = (entries: { phase: LaunchPhase }[]) => entries.map(entry => entry.phase);

describe("agent states on a card", () => {
  it("maps the directory like Paseo's own sidebar: needs you, error, running, done unread, idle", () => {
    expect(agentPhase(lite({ status: "running" }))).toBe("running");
    expect(agentPhase(lite({ status: "running", pendingPermissions: [{ id: "perm-1" }] }))).toBe("needs");
    expect(agentPhase(lite({ status: "idle", requiresAttention: true, attentionReason: "permission" }))).toBe("needs");
    expect(agentPhase(lite({ status: "idle", requiresAttention: true, attentionReason: "finished" }))).toBe("unread");
    expect(agentPhase(lite({ status: "error" }))).toBe("failed");
    expect(agentPhase(lite({ status: "idle", requiresAttention: true, attentionReason: "error" }))).toBe("failed");
    expect(agentPhase(lite({ status: "initializing" }))).toBe("starting");
    expect(agentPhase(lite({ status: "idle" }))).toBe("idle");
    expect(agentPhase(lite({ status: "closed" }))).toBe("idle");
  });

  it("keeps only what it needs of a snapshot, and drops archived agents", () => {
    expect(lite({ status: "running", pendingPermissions: [{ id: "b" }, { id: "a" }], activeTurn: { turnId: "t-1", startedAt: "2026-10-15T08:01:00.000Z" }, labels: { "project-notes.item-id": itemId, "paseo.parent-agent-id": "parent-1" } }))
      .toMatchObject({ pending: ["a", "b"], turn: "t-1@2026-10-15T08:01:00.000Z", itemId, parentId: "parent-1", launchId: null });
    expect(liteAgent(raw({ archivedAt: "2026-10-15T09:00:00.000Z" }) as never)).toBeNull();
  });

  it("shows live agents, sub-agents and the latest activity; the most urgent launch leads", () => {
    const agents = [lite({ status: "idle", requiresAttention: true, attentionReason: "finished" }),
      lite({ id: "agent-2", status: "running", updatedAt: "2026-10-15T09:00:00.000Z", labels: { "project-notes.item-id": itemId, "project-notes.launch-id": "launch-0002" } }),
      lite({ id: "child-1", status: "running", labels: { "paseo.parent-agent-id": "agent-2" } }),
      lite({ id: "child-2", status: "idle", labels: { "paseo.parent-agent-id": "agent-2" } })];
    const entries = launchEntries(directory(agents), itemId, [record()]);
    expect(phases(entries).sort()).toEqual(["running", "unread"]);
    const primary = primaryLaunch(entries)!;
    expect(primary).toMatchObject({ agentId: "agent-2", phase: "running", children: 2, childrenRunning: 1, at: "2026-10-15T09:00:00.000Z" });
  });

  it("calls an agent ended once the directory no longer lists it (archived or deleted), never before the first listing", () => {
    expect(phases(launchEntries(directory([]), itemId, [record()]))).toEqual(["ended"]);
    expect(phases(launchEntries(directory([], false), itemId, [record()]))).toEqual([]);
    // The note's agents from the directory's own list (archived ones too) name what ended.
    const archived = [{ agentId: "agent-9", launchId: null, workspaceId: "ws-9", title: "旧会话", provider: "example", status: "idle", archivedAt: "2026-10-14T00:00:00.000Z", createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z" }];
    expect(launchEntries(directory([]), itemId, [], archived)).toMatchObject([{ phase: "ended", title: "旧会话", agentId: "agent-9" }]);
  });

  it("shows launches still being created, interrupted ones to check, and refused ones", () => {
    const entries = launchEntries(directory([]), itemId, [
      record({ launchId: "launch-a", stage: "creating_workspace", agentId: null, workspaceId: null }),
      record({ launchId: "launch-b", stage: "uncertain", agentId: null, error: "需要核对" }),
      record({ launchId: "launch-c", stage: "rejected", agentId: null, workspaceId: null, error: "所选 provider 不可用" }),
    ]);
    expect(phases(entries)).toEqual(["launching", "check", "rejected"]);
    expect(primaryLaunch(entries)?.phase).toBe("launching");
    expect(entries.find(entry => entry.phase === "rejected")?.error).toBe("所选 provider 不可用");
  });

  it("finds the live agent of a record by its launch label too, once", () => {
    const entries = launchEntries(directory([lite({ id: "agent-x" })]), itemId, [record({ agentId: null, stage: "uncertain" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ agentId: "agent-x", phase: "idle" });
  });
});

describe("the shared agent directory", () => {
  function fakePaseo() {
    let observer: any;
    const subscription = { subscribe: vi.fn((value: unknown) => { observer = value; return () => {}; }), release: vi.fn(async () => {}) };
    const list = vi.fn(async () => ({ entries: [{ agent: raw() }], pageInfo: { hasMore: false }, subscription }));
    return { paseo: { agents: { list, subscribe: vi.fn() } }, observer: () => observer };
  }
  it("lists once, follows updates, and stays quiet for updates that change nothing it keeps", async () => {
    const fake = fakePaseo(), seen: (string[] | null)[] = [];
    const store = createAgentDirectory(fake.paseo as never);
    store.subscribe(changed => seen.push(changed ? [...changed] : null));
    await vi.waitFor(() => expect(store.ready()).toBe(true));
    expect(seen).toEqual([null]);
    fake.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { ...raw(), lastUsage: { inputTokens: 5 } } } });
    expect(seen).toHaveLength(1);
    fake.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: raw({ status: "running" }) } });
    expect(seen.at(-1)).toEqual(["agent-1"]);
    expect(store.get("agent-1")?.status).toBe("running");
    fake.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: raw({ archivedAt: "2026-10-15T10:00:00.000Z" }) } });
    expect(store.get("agent-1")).toBeUndefined();
    expect(fake.paseo.agents.list).toHaveBeenCalledWith(expect.objectContaining({ filter: { includeArchived: false }, subscribe: {} }));
    store.dispose();
  });
});

describe("launch records on the server", () => {
  type Paseo = PluginHandlerContext["paseo"];
  let root: string, service: LaunchService;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "notes-launch-records-")); service = new LaunchService({ read: async () => ({ items: [] }) } as unknown as BoardStore, undefined, root); });
  afterEach(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const journal = (launchId: string, patch: Record<string, unknown> = {}) => writeFile(join(root, `${launchId}.json`), JSON.stringify({ launchId, inputHash: "h", stage: "started", workspaceId: "ws-1", agentId: `agent-${launchId}`, error: null, itemId, sourceProjectId: "prj", createdAt: "2026-10-15T08:00:00.000Z", ...patch }));

  it("lists records newest first with a revision that holds while nothing changes", async () => {
    await journal("launch-0001");
    await journal("launch-0002", { createdAt: "2026-10-15T09:00:00.000Z", itemId: "00000000-0000-4000-8000-000000000002" });
    const first = await service.records();
    expect(first.records.map(entry => entry.launchId)).toEqual(["launch-0002", "launch-0001"]);
    expect((await service.records()).revision).toBe(first.revision);
    await journal("launch-0001", { stage: "uncertain", error: "x" });
    expect((await service.records()).revision).not.toBe(first.revision);
  });

  it("reports a launch this process no longer runs as uncertain, and leaves out what is not a launch record", async () => {
    await journal("launch-0003", { stage: "creating_agent", agentId: null });
    await mkdir(join(root, "nested-dir.json"));
    await writeFile(join(root, "launch-0004.json"), "{ not json");
    await writeFile(join(root, "big-0005.json"), JSON.stringify({ launchId: "big-0005", filler: "x".repeat(70_000) }));
    await writeFile(join(root, "elsewhere.json"), JSON.stringify({ launchId: "launch-0006", inputHash: "h", stage: "started", workspaceId: null, agentId: null, error: null, itemId }));
    await writeFile(join(root, "..", "outside-launch.json"), JSON.stringify({ launchId: "link-0007", inputHash: "h", stage: "started", workspaceId: null, agentId: null, error: null, itemId }));
    await symlink(join(root, "..", "outside-launch.json"), join(root, "link-0007.json"));
    const { records } = await service.records();
    expect(records).toEqual([expect.objectContaining({ launchId: "launch-0003", stage: "uncertain" })]);
    await rm(join(root, "..", "outside-launch.json"), { force: true });
  });

  it("leaves records written before 0.12 out of the board, and finds them for a note through its agents' labels", async () => {
    await journal("launch-0008", { itemId: undefined, sourceProjectId: undefined, createdAt: undefined });
    expect((await service.records()).records).toEqual([]);
    const list = vi.fn(async () => ({ entries: [{ agent: { id: "agent-old", provider: "example", status: "idle", workspaceId: "ws-8", title: "旧任务", archivedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", labels: { "project-notes.item-id": itemId, "project-notes.launch-id": "launch-0008" } } }] }));
    const result = await service.records({ itemId, paseo: { agents: { list } } as unknown as Paseo });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ filter: { labels: { "project-notes.item-id": itemId }, includeArchived: true } }));
    expect(result.records.map(entry => entry.launchId)).toEqual(["launch-0008"]);
    expect(result.agents).toMatchObject([{ agentId: "agent-old", launchId: "launch-0008", archivedAt: "2026-10-01T00:00:00.000Z" }]);
  });

  it("keeps the note and start time in new records without showing them in receipts", async () => {
    const workspaceCreate = vi.fn(async () => ({ id: "ws-new", agents: { create: vi.fn(async () => ({ id: "agent-new", send: vi.fn(async () => {}) })) } }));
    const paseo = {
      projects: { list: async () => ({ projects: [{ projectId: "prj", projectDisplayName: "示例", projectRootPath: "/repo", projectKind: "git" }] }), subscribe: () => () => {} },
      config: { get: async () => ({ config: { agentProfiles: [] } }) },
      providers: { snapshot: async () => ({ entries: [{ provider: "example", status: "ready", models: [{ id: "default", label: "默认" }] }] }) },
      workspaces: { create: workspaceCreate },
      agents: { list: async () => ({ entries: [] }) },
    } as unknown as Paseo;
    service = new LaunchService({ read: async () => ({ items: [{ id: itemId, projectId: "prj", kind: "task", title: "任务", body: "", status: "todo", priority: "normal", pinned: false, revision: 1, createdAt: "", updatedAt: "", deletedAt: null }] }) } as unknown as BoardStore, undefined, root);
    const receipt = await service.start({ launchId: "launch-0009", sourceProjectId: "prj", itemId, projectId: "prj", title: "任务", prompt: "做事", isolation: "local", provider: "example", model: "default" }, paseo);
    expect(Object.keys(receipt).sort()).toEqual(["agentId", "error", "launchId", "replayed", "stage", "workspaceId"]);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, "launch-0009.json"), "utf8")).stage).toBe("started"));
    expect(JSON.parse(await readFile(join(root, "launch-0009.json"), "utf8"))).toMatchObject({ itemId, sourceProjectId: "prj", createdAt: expect.any(String) });
    expect((await service.records()).records).toMatchObject([{ launchId: "launch-0009", itemId, stage: "started", agentId: "agent-new" }]);
  });
});
