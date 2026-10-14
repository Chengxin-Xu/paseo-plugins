import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { LaunchInput } from "../shared/launch";
import type { BoardStore } from "../server/store";

const io = vi.hoisted(() => ({
  root: "", file: "", stage: "", blocked: false, failSync: false,
  entered: undefined as (() => void) | undefined,
  observed: undefined as (() => void) | undefined,
  release: Promise.resolve(),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (String(args[0]) === io.file) io.observed?.();
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === io.root) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const record = JSON.parse(await actual.readFile(io.file, "utf8"));
          // The real rename has completed, but the final directory fsync is still pending.
          if (!io.blocked && record.stage === io.stage) {
            io.blocked = true; io.entered?.(); await io.release;
            if (io.failSync) throw new Error("模拟目录同步失败");
          }
          await sync();
        };
      }
      return handle;
    },
  };
});
const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
const { LaunchService } = await import("../server/launch");
const { ProjectDirectory } = await import("../server/dashboard");
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const launchId = "launch-terminal-race";
const note = { id: "00000000-0000-4000-8000-000000000001", projectId: "project-one", title: "任务", body: "正文", status: "todo", priority: "normal", deletedAt: null };
const input: LaunchInput = { launchId, sourceProjectId: note.projectId, itemId: note.id, projectId: note.projectId, isolation: "local", provider: "example", model: "default", title: "任务", prompt: "任务正文" };
function fakePaseo() {
  const send = vi.fn(async () => {});
  const createAgent = vi.fn(async () => ({ id: "created-agent", send }));
  const catalogue = { entries: [{ provider: "example", status: "ready", models: [{ id: "default", label: "默认" }] }] };
  const api = {
    agents: { list: vi.fn(async () => ({ entries: [{ agent: { id: "recovered-agent", workspaceId: "workspace-one", labels: { "project-notes.launch-id": launchId } } }] })) },
    workspaces: { create: vi.fn(async () => ({ id: "workspace-one", agents: { create: createAgent } })) },
    projects: { list: async () => ({ projects: [{ projectId: note.projectId, projectDisplayName: "示例项目", projectRootPath: "/example", projectKind: "non_git" }] }), subscribe: () => () => {} },
    providers: { snapshot: vi.fn(async () => catalogue) },
    config: { get: async () => ({ config: { agentProfiles: [] } }) },
  };
  return { api, paseo: api as unknown as PluginHandlerContext["paseo"], createAgent, send, catalogue };
}
let service: InstanceType<typeof LaunchService>, projects: InstanceType<typeof ProjectDirectory>, release = () => {};
beforeEach(async () => {
  io.root = await mkdtemp(join(tmpdir(), "notes-launch-race-")); io.file = join(io.root, launchId + ".json");
  io.stage = ""; io.blocked = false; io.failSync = false; io.entered = io.observed = undefined;
  const gate = latch(); io.release = gate.promise; release = gate.resolve;
  projects = new ProjectDirectory();
});
afterEach(async () => { release(); await service?.stop(); projects.stop(); await rm(io.root, { recursive: true, force: true }); });

describe("launch journal completion races", () => {
  it.each(["uncertain", "started", "rejected"] as const)("waits for its own %s journal fsync before returning or recovering", async stage => {
    const h = fakePaseo(), entered = latch(), observed = latch(); io.stage = stage; io.entered = entered.resolve;
    if (stage === "uncertain") h.createAgent.mockRejectedValueOnce(new Error("创建响应丢失"));
    service = new LaunchService({ read: async () => {
      if (stage === "rejected") throw new Error("手记读取失败");
      return { items: [note] };
    } } as unknown as BoardStore, projects, io.root);
    await service.start(input, h.paseo); await entered.promise;
    expect(JSON.parse(await readFile(io.file, "utf8")).stage).toBe(stage);
    io.observed = observed.resolve;
    let settled = false;
    const status = service.status(launchId, h.paseo).finally(() => { settled = true; });
    try {
      await observed.promise; await nextTurn();
      expect(settled).toBe(false);
      expect(h.api.agents.list).not.toHaveBeenCalled();
    } finally { release(); await status; }
    const result = await status;
    expect(result).toMatchObject({ stage, agentId: stage === "uncertain" ? "recovered-agent" : stage === "started" ? "created-agent" : null });
    expect(JSON.parse(await readFile(io.file, "utf8")).agentId).toBe(result!.agentId);
    expect(h.api.agents.list).toHaveBeenCalledTimes(stage === "uncertain" ? 1 : 0);
    expect(h.api.workspaces.create).toHaveBeenCalledTimes(stage === "rejected" ? 0 : 1);
    expect(h.send).toHaveBeenCalledTimes(stage === "started" ? 1 : 0);
  });

  it("rereads a started journal when its directory fsync fails and run writes uncertain", async () => {
    const h = fakePaseo(), entered = latch(), observed = latch(); io.stage = "started"; io.failSync = true; io.entered = entered.resolve;
    service = new LaunchService({ read: async () => ({ items: [note] }) } as unknown as BoardStore, projects, io.root);
    await service.start(input, h.paseo); await entered.promise;
    io.observed = observed.resolve;
    const status = service.status(launchId, h.paseo);
    await observed.promise; await nextTurn(); release();
    expect(await status).toMatchObject({ stage: "uncertain", agentId: "created-agent", error: expect.stringContaining("目录同步失败") });
    expect(JSON.parse(await readFile(io.file, "utf8")).stage).toBe("uncertain");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("still reports an intermediate phase without waiting for the run", async () => {
    const h = fakePaseo(), entered = latch(), observed = latch(); io.stage = "creating_workspace"; io.entered = entered.resolve;
    service = new LaunchService({ read: async () => ({ items: [note] }) } as unknown as BoardStore, projects, io.root);
    await service.start(input, h.paseo); await entered.promise;
    io.observed = observed.resolve;
    let settled = false;
    const status = service.status(launchId, h.paseo).finally(() => { settled = true; });
    try {
      await observed.promise; await nextTurn(); expect(settled).toBe(true);
      expect(await status).toMatchObject({ stage: "creating_workspace" });
      expect(h.api.workspaces.create).not.toHaveBeenCalled();
    } finally { release(); await status; }
  });

  it("does not await this process's provider request when another process wrote a terminal journal", async () => {
    const h = fakePaseo(), validating = latch(), provider = latch(), observed = latch();
    h.api.providers.snapshot.mockImplementation(async () => { validating.resolve(); await provider.promise; return h.catalogue; });
    service = new LaunchService({ read: async () => ({ items: [note] }) } as unknown as BoardStore, projects, io.root);
    await service.start(input, h.paseo); await validating.promise;
    const record = JSON.parse(await readFile(io.file, "utf8"));
    await writeFile(io.file, JSON.stringify({ ...record, stage: "started", workspaceId: "other-workspace", agentId: "other-agent" }));
    io.observed = observed.resolve;
    let settled = false;
    const status = service.status(launchId, h.paseo).finally(() => { settled = true; });
    try {
      await observed.promise; await nextTurn(); expect(settled).toBe(true);
      expect(await status).toMatchObject({ stage: "started", agentId: "other-agent" });
    } finally { provider.resolve(); await status; }
  });
});
