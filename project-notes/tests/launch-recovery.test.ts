import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { BoardItem } from "../shared/board";
import type { LaunchInput, LaunchReceipt } from "../shared/launch";
import { ProjectDirectory } from "../server/dashboard";
import { LaunchService } from "../server/launch";
import type { BoardStore } from "../server/store";

type Paseo = PluginHandlerContext["paseo"];
type Workspace = { id: string; projectId: string; name: string; worktreeSlug?: string };
type WorkspaceQuery = { filter?: { query?: string; projectId?: string }; page?: { cursor?: string; limit?: number } };
const slugFor = (id: string) => `notes-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
const now = "2026-10-12T00:00:00.000Z";
const note: BoardItem = { id: "00000000-0000-4000-8000-000000000001", projectId: "project-one", title: "来源手记", body: "用户已经从初始任务删除的内容 PRIVATE_NOTE_ONLY", status: "doing", priority: "high", pinned: false, kind: "task", revision: 1, createdAt: now, updatedAt: now, deletedAt: null };
const inputFor = (launchId: string, isolation: LaunchInput["isolation"] = "worktree"): LaunchInput => ({ launchId, sourceProjectId: note.projectId, itemId: note.id, projectId: note.projectId, title: "用户确认的标题", prompt: "只发送用户确认后的任务", isolation, provider: "example", model: "default" });

/** Mirrors daemon 0.11.1: query matches name/projectId/id, never worktreeSlug. */
function fakePaseo(workspaces: Workspace[] = []) {
  const send = vi.fn(async () => {});
  const createAgent = vi.fn(async () => ({ id: "agent-created", send }));
  const api = {
    agents: { list: vi.fn(async () => ({ entries: [] as { agent: { id: string; workspaceId: string; labels: Record<string, string> } }[] })) },
    projects: { list: vi.fn(async () => ({ projects: [{ projectId: note.projectId, projectDisplayName: "示例项目", projectRootPath: "/repo/example", projectKind: "git" }] })), subscribe: vi.fn(() => () => {}) },
    config: { get: vi.fn(async () => ({ config: { agentProfiles: [] } })) },
    providers: { snapshot: vi.fn(async () => ({ entries: [{ provider: "example", status: "ready", models: [{ id: "default", label: "默认" }] }] })) },
    workspaces: {
      list: vi.fn(async (options: WorkspaceQuery = {}) => {
        const eligible = workspaces.filter(workspace => (!options.filter?.projectId || workspace.projectId === options.filter.projectId)
          && (!options.filter?.query || [workspace.name, workspace.projectId, workspace.id].some(value => value.includes(options.filter!.query!))));
        const offset = Number(options.page?.cursor ?? 0), entries = eligible.slice(offset, offset + 2), next = offset + entries.length;
        return { entries, pageInfo: { hasMore: next < eligible.length, nextCursor: next < eligible.length ? String(next) : null } };
      }),
      create: vi.fn(async (_options: unknown) => ({ id: "workspace-created", agents: { create: createAgent } })),
    },
  };
  return { api, paseo: api as unknown as Paseo, send, createAgent };
}

let root: string, service: LaunchService, projects: ProjectDirectory;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "notes-launch-recovery-")); projects = new ProjectDirectory();
  service = new LaunchService({ read: async () => ({ items: [note] }) } as unknown as BoardStore, projects, root);
});
afterEach(async () => { await service.stop(); projects.stop(); await rm(root, { recursive: true, force: true }); });
async function journal(launchId: string, stage: LaunchReceipt["stage"], metadata: Record<string, unknown> = {}) {
  await writeFile(join(root, `${launchId}.json`), JSON.stringify({ launchId, inputHash: "test", stage, workspaceId: null, agentId: null, error: null, ...metadata }));
}
const persisted = async (id: string) => JSON.parse(await readFile(join(root, `${id}.json`), "utf8"));
async function settle(id: string, paseo: Paseo) {
  let result: LaunchReceipt | null = null;
  await vi.waitFor(async () => {
    result = await service.status(id, paseo);
    expect(result?.stage).toMatch(/^(started|rejected|uncertain)$/);
  });
  return result!;
}

describe("interrupted workspace recovery", () => {
  it.each(["prepared", "creating_workspace", "uncertain"] as const)("recovers and persists a %s worktree beyond the first page", async stage => {
    const launchId = `recover-${stage}`;
    const workspace = { id: "workspace-found", projectId: note.projectId, name: "真实工作区标题", worktreeSlug: slugFor(launchId) };
    const h = fakePaseo([
      { id: "other-project", projectId: "project-two", name: "另一项目", worktreeSlug: slugFor(launchId) },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `filler-${index}`, projectId: note.projectId, name: "其他工作区" })), workspace,
    ]);
    expect((await h.api.workspaces.list({ filter: { query: slugFor(launchId) } })).entries).toEqual([]);
    h.api.workspaces.list.mockClear();
    await journal(launchId, stage, { projectId: note.projectId, isolation: "worktree" });
    expect(await service.status(launchId, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: workspace.id, agentId: null });
    expect(h.api.workspaces.list.mock.calls.map(([options]) => options)).toEqual([
      { filter: { projectId: note.projectId }, page: { limit: 100 } },
      { filter: { projectId: note.projectId }, page: { limit: 100, cursor: "2" } },
      { filter: { projectId: note.projectId }, page: { limit: 100, cursor: "4" } },
    ]);
    expect(await persisted(launchId)).toMatchObject({ stage: "uncertain", workspaceId: workspace.id, projectId: note.projectId, isolation: "worktree" });
    const fresh = new LaunchService({} as BoardStore, projects, root);
    expect(await fresh.status(launchId, h.paseo)).toMatchObject({ workspaceId: workspace.id });
    expect(h.api.workspaces.list).toHaveBeenCalledTimes(3);
    expect(h.api.workspaces.create).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });

  it("scans old journals without guessing a project and persists discovered recovery metadata", async () => {
    const id = "legacy-worktree", h = fakePaseo([
      { id: "another", projectId: "project-two", name: "其他工作区" },
      { id: "second", projectId: "project-three", name: "其他工作区" },
      { id: "legacy-found", projectId: "removed-project", name: "旧工作区", worktreeSlug: slugFor(id) },
    ]);
    await journal(id, "creating_workspace");
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: "legacy-found" });
    expect(h.api.workspaces.list.mock.calls.every(([options]) => !options?.filter)).toBe(true);
    expect(await persisted(id)).toMatchObject({ projectId: "removed-project", isolation: "worktree", workspaceId: "legacy-found" });
    expect(h.api.projects.list).not.toHaveBeenCalled();
  });

  it.each(["prepared", "creating_workspace", "uncertain"] as const)("never declares an unknown legacy %s launch rejected", async stage => {
    const id = `legacy-empty-${stage}`, h = fakePaseo();
    await journal(id, stage);
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: null });
    expect((await persisted(id)).stage).toBe(stage);
  });

  it("does not reject a partially migrated journal that still lacks projectId", async () => {
    const id = "legacy-missing-project", h = fakePaseo();
    await journal(id, "prepared", { isolation: "worktree" });
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: null });
    expect((await persisted(id)).stage).toBe("prepared");
  });

  it.each(["prepared", "creating_workspace", "uncertain"] as const)("keeps a Local %s launch uncertain without inferring ownership from its title", async stage => {
    const id = `local-${stage}`, h = fakePaseo([{ id: "unrelated", projectId: note.projectId, name: "用户确认的标题" }]);
    await journal(id, stage, { projectId: note.projectId, isolation: "local" });
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: null });
    expect(h.api.workspaces.list).not.toHaveBeenCalled();
  });

  it("rejects only a known prepared worktree after a complete empty scan", async () => {
    const id = "prepared-empty", h = fakePaseo();
    await journal(id, "prepared", { projectId: note.projectId, isolation: "worktree" });
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "rejected", workspaceId: null, error: expect.stringContaining("尚未创建") });
    expect((await persisted(id)).stage).toBe("rejected");
  });

  it.each(["creating_workspace", "uncertain"] as const)("keeps a %s worktree uncertain when the directory may lag a create request", async stage => {
    const id = `empty-${stage}`, h = fakePaseo();
    await journal(id, stage, { projectId: note.projectId, isolation: "worktree" });
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: null });
  });

  it.each(["offline", "missing cursor", "repeated cursor", "too many pages"])("does not turn an incomplete lookup (%s) into permission to retry", async failure => {
    const id = "prepared-incomplete", h = fakePaseo();
    if (failure === "offline") h.api.workspaces.list.mockRejectedValue(new Error("offline"));
    else h.api.workspaces.list.mockImplementation(async options => ({ entries: [], pageInfo: { hasMore: true, nextCursor: failure === "missing cursor" ? null : failure === "repeated cursor" ? "repeat" : String(Number(options?.page?.cursor ?? 0) + 1) } }));
    await journal(id, "prepared", { projectId: note.projectId, isolation: "worktree" });
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: null });
    expect((await persisted(id)).stage).toBe("prepared");
    expect(h.api.workspaces.list.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it("can recover a workspace when the agent catalogue is offline, but never treats that as proof of absence", async () => {
    const id = "agents-offline", h = fakePaseo([{ id: "workspace-found", projectId: note.projectId, name: "工作区", worktreeSlug: slugFor(id) }]);
    h.api.agents.list.mockRejectedValue(new Error("offline"));
    await journal(id, "prepared", { projectId: note.projectId, isolation: "worktree" });
    expect(await service.status(id, h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: "workspace-found" });
    await journal("agents-offline-empty", "prepared", { projectId: note.projectId, isolation: "worktree" });
    expect(await service.status("agents-offline-empty", h.paseo)).toMatchObject({ stage: "uncertain", workspaceId: null });
  });
});

describe("explicit launch intent", () => {
  it.each(["local", "worktree"] as const)("creates a %s workspace without naming context and sends edited text with metadata only", async isolation => {
    const h = fakePaseo(), input = inputFor(`explicit-${isolation}`, isolation);
    await service.start(input, h.paseo);
    expect(await settle(input.launchId, h.paseo)).toMatchObject({ stage: "started" });
    const request = h.api.workspaces.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("firstAgentContext");
    expect(request.title).toBe(input.title);
    if (isolation === "worktree") expect(request.source).toMatchObject({ branchName: `notes/${slugFor(input.launchId).slice(6)}`, worktreeSlug: slugFor(input.launchId) });
    expect(h.send).toHaveBeenCalledWith(input.prompt, { messageId: `project-notes-${input.launchId}`, attachments: [{
      type: "text", mimeType: "text/plain", contextKind: "project-notes", title: `手记 #${note.id.slice(0, 8)} · ${note.title}`,
      text: `来源：手记 #${note.id}\n项目：示例项目\n标题：${note.title}\n状态：进行中\n重点：是`,
    }] });
    expect(JSON.stringify([h.api.workspaces.create.mock.calls, h.createAgent.mock.calls, h.send.mock.calls])).not.toContain("PRIVATE_NOTE_ONLY");
    expect(await persisted(input.launchId)).toMatchObject({ projectId: note.projectId, isolation });
    expect(await service.status(input.launchId, h.paseo)).not.toHaveProperty("isolation");
    expect(await service.status(input.launchId, h.paseo)).not.toHaveProperty("projectId");
  });
});
