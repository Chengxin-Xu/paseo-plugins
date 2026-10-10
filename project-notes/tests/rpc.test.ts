import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRpcContract, RpcOutput } from "@getpaseo/plugin";
import type { input as ZodInput } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { INBOX_DESCRIPTION, projectsRpc, readBoardRpc, readDashboardRpc, writeBoardRpc, type NoteFields } from "../shared/board";
import { launchOptionsRpc, launchRpc, launchStatusRpc, type LaunchInput } from "../shared/launch";

const fields: NoteFields = { kind: "task", title: "上线检查", body: "逐项核对", status: "todo", priority: "high", pinned: false };
const ready = (provider: string) => ({
  provider, label: provider.toUpperCase(), status: "ready", enabled: true, error: null, defaultModeId: "auto",
  modes: [{ id: "auto", label: "Auto" }, { id: "plan", label: "Plan" }],
  models: [
    { id: "m1", label: "Model 1", isDefault: true, thinkingOptions: [{ id: "high", label: "High", isDefault: true }], defaultThinkingOptionId: null },
    { id: "hidden", label: "Hidden", isSelectable: false },
  ],
});

/** A PaseoApi double. Creation is deduplicated by idempotency key, like a 0.9 daemon. */
function fakePaseo() {
  const projectListeners = new Set<() => void>();
  const keys = new Map<string, unknown>();
  const log = { workspaces: [] as Record<string, unknown>[], agents: [] as Record<string, unknown>[], sends: [] as unknown[][] };
  let sequence = 0;
  const once = async <T>(key: unknown, create: () => T): Promise<T> => {
    if (typeof key === "string" && keys.has(key)) return keys.get(key) as T;
    const value = create(); if (typeof key === "string") keys.set(key, value); return value;
  };
  const agentHandle = (id: string) => ({ id, send: vi.fn(async (...args: unknown[]) => { log.sends.push([id, ...args]); }) });
  const paseo = {
    log, projectListeners,
    catalog: { entries: [ready("claude"), { ...ready("codex"), enabled: false }, { ...ready("gemini"), status: "loading", models: [] }] },
    projects: {
      list: vi.fn(async () => ({ requestId: "r", projects: [
        { projectId: "prj_git", projectDisplayName: "Git 项目", projectRootPath: "/repo/git", projectKind: "git" },
        { projectId: "prj_dir", projectDisplayName: "目录项目", projectRootPath: "/repo/dir", projectKind: "non_git" },
      ] })),
      subscribe: vi.fn((listener: () => void) => { projectListeners.add(listener); return () => projectListeners.delete(listener); }),
    },
    providers: {
      snapshot: vi.fn(async () => paseo.catalog),
      waitForReady: vi.fn(async () => paseo.catalog),
    },
    config: { get: vi.fn(async () => ({ requestId: "r", config: { agentProfiles: [
      { id: "profile-1", name: "日常", provider: "claude", model: "m1", modeId: "plan", thinkingOptionId: "high", featureValues: { fast: true }, env: { SECRET_TOKEN: "do-not-leak" } },
    ] } })) },
    workspaces: {
      create: vi.fn(async (options: Record<string, unknown>) => once(options.idempotencyKey, () => {
        log.workspaces.push(options);
        const id = `wks_${(++sequence).toString(16).padStart(16, "0")}`;
        return { id, agents: { create: vi.fn(async (agent: Record<string, unknown>) => once(agent.idempotencyKey, () => { log.agents.push({ workspaceId: id, ...agent }); return agentHandle(`agent-${sequence}`); })) } };
      })),
    },
    agents: { list: vi.fn(async () => ({ requestId: "r", entries: [] as unknown[], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } })) },
  };
  return paseo;
}
type FakePaseo = ReturnType<typeof fakePaseo>;

/** Loads index.server.ts like the daemon and validates every RPC like the host and client do. */
function host(paseo: FakePaseo) {
  const handlers = new Map<string, { contract: PluginRpcContract; handler: (input: unknown, context: { paseo: unknown }) => unknown }>();
  const server = { handle: (contract: PluginRpcContract, handler: never) => { handlers.set(contract.name, { contract, handler }); }, on() {}, before() {}, registerSettings() {}, registerProvider() {} };
  const cleanup = contribute(server as unknown as PluginServerContext);
  const invoke = async (method: string, input: unknown) => {
    const entry = handlers.get(method); if (!entry) throw new Error(`no handler ${method}`);
    return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), { paseo }));
  };
  // Same steps as the SDK client (callPluginRpc): validate input, invoke, validate output.
  const call = async <C extends PluginRpcContract>(contract: C, input: ZodInput<C["input"]>): Promise<RpcOutput<C>> =>
    contract.output.parseAsync(await invoke(contract.name, await contract.input.parseAsync(input))) as Promise<RpcOutput<C>>;
  return { call, cleanup, handlers };
}

let home = "";
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "project-notes-rpc-")); process.env.PASEO_HOME = home; });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("board RPCs", () => {
  it("registers every contract and serves dashboard deltas through validated RPCs", async () => {
    const paseo = fakePaseo();
    const { call, handlers, cleanup } = host(paseo);
    expect([...handlers.keys()].sort()).toEqual(["project-notes.dashboard", "project-notes.launch", "project-notes.launch-options", "project-notes.launch-status", "project-notes.projects", "project-notes.read", "project-notes.write"]);
    const empty = await call(readDashboardRpc, {});
    if (empty.unchanged) throw new Error("expected data");
    expect(empty.boards).toEqual([]);
    expect(empty.projects!.map(p => p.id)).toEqual(["__inbox__", "prj_git", "prj_dir"]);
    expect(await call(readDashboardRpc, { revision: empty.revision })).toEqual({ unchanged: true, revision: empty.revision });
    const created = await call(writeBoardRpc, { projectId: "prj_git", requestId: "rpc-create-1", operation: { type: "create", fields } });
    expect(created.replayed).toBe(false);
    const delta = await call(readDashboardRpc, { revision: empty.revision });
    if (delta.unchanged) throw new Error("expected a delta");
    expect(delta.projects).toBeUndefined();
    expect(delta.boards.map(b => [b.projectId, b.revision, b.items.length])).toEqual([["prj_git", 1, 1]]);
    expect((await call(readBoardRpc, { projectId: "prj_git" })).items[0]!.title).toBe("上线检查");
    // One project list for dashboard polls, the projects RPC and launch options.
    // The projects RPC and the dashboard describe the inbox with the same wording.
    expect((await call(projectsRpc, {})).projects[0]).toEqual({ id: "__inbox__", name: "随手记", path: INBOX_DESCRIPTION });
    expect(empty.projects![0]).toEqual({ id: "__inbox__", name: "随手记", path: INBOX_DESCRIPTION });
    await call(launchOptionsRpc, {});
    expect(paseo.projects.list).toHaveBeenCalledTimes(1);
    // project.update drops the cached list.
    for (const listener of paseo.projectListeners) listener();
    await call(projectsRpc, {});
    expect(paseo.projects.list).toHaveBeenCalledTimes(2);
    cleanup();
    expect(paseo.projectListeners.size).toBe(0);
  });

  it("keeps write replay, revision conflicts and the recycle bin behavior", async () => {
    const { call } = host(fakePaseo());
    const input = { projectId: "prj_dir", requestId: "rpc-replay-1", operation: { type: "create" as const, fields } };
    const created = await call(writeBoardRpc, input);
    const replay = await call(writeBoardRpc, input);
    expect(replay).toMatchObject({ itemId: created.itemId, replayed: true });
    await expect(call(writeBoardRpc, { ...input, operation: { type: "create", fields: { ...fields, title: "别的" } } })).rejects.toThrow(/请求标识已用于另一项修改/);
    const updated = await call(writeBoardRpc, { projectId: "prj_dir", requestId: "rpc-update-1", operation: { type: "update", id: created.itemId, expectedRevision: 1, fields: { status: "doing" } } });
    expect(updated.board.items[0]).toMatchObject({ status: "doing", revision: 2 });
    await expect(call(writeBoardRpc, { projectId: "prj_dir", requestId: "rpc-update-2", operation: { type: "update", id: created.itemId, expectedRevision: 1, fields: { title: "旧草稿" } } })).rejects.toThrow(/另一台设备/);
    const deleted = await call(writeBoardRpc, { projectId: "prj_dir", requestId: "rpc-delete-1", operation: { type: "delete", id: created.itemId, expectedRevision: 2 } });
    expect(deleted.board.items[0]!.deletedAt).not.toBeNull();
    await expect(call(writeBoardRpc, { projectId: "prj_dir", requestId: "rpc-update-3", operation: { type: "update", id: created.itemId, expectedRevision: 3, fields: { title: "x" } } })).rejects.toThrow(/回收站/);
    const restored = await call(writeBoardRpc, { projectId: "prj_dir", requestId: "rpc-restore-1", operation: { type: "restore", id: created.itemId, expectedRevision: 3 } });
    expect(restored.board.items[0]!.deletedAt).toBeNull();
    await expect(call(writeBoardRpc, { projectId: "prj_dir", requestId: "short", operation: { type: "create", fields } })).rejects.toThrow();
  });
});

describe("launch RPCs", () => {
  async function seed(call: ReturnType<typeof host>["call"]) {
    return (await call(writeBoardRpc, { projectId: "__inbox__", requestId: "rpc-seed-1", operation: { type: "create", fields } })).itemId;
  }
  const launchInput = (itemId: string, overrides: Partial<LaunchInput> = {}): LaunchInput => ({
    launchId: "launch-test-0001", sourceProjectId: "__inbox__", itemId, projectId: "prj_git", title: "上线检查", prompt: "上线检查\n\n逐项核对",
    isolation: "worktree", baseBranch: "main", profileId: null, provider: "claude", model: "m1", modeId: "auto", thinkingOptionId: "high", ...overrides,
  });
  async function settle(call: ReturnType<typeof host>["call"], launchId: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const receipt = await call(launchStatusRpc, { launchId });
      if (receipt && ["started", "rejected", "uncertain"].includes(receipt.stage)) return receipt;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("launch did not settle");
  }

  it("lists options without leaking daemon config and waits for provider discovery", async () => {
    const paseo = fakePaseo();
    const { call } = host(paseo);
    const none = await call(launchOptionsRpc, {});
    expect(none).toMatchObject({ project: null, providers: [], profiles: [] });
    expect(none.projects.map(p => p.kind)).toEqual(["git", "non_git"]);
    const options = await call(launchOptionsRpc, { projectId: "prj_git" });
    expect(options.providers.map(p => p.id)).toEqual(["claude", "gemini"]);
    expect(options.providers[0]!.models).toEqual([{ id: "m1", label: "Model 1", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" }]);
    expect(JSON.stringify(options)).not.toContain("do-not-leak");
    expect(options.profiles).toEqual([{ id: "profile-1", name: "日常", provider: "claude", model: "m1", modeId: "plan", thinkingOptionId: "high" }]);
    expect(paseo.providers.waitForReady).not.toHaveBeenCalled();
    paseo.catalog = { entries: [{ ...ready("gemini"), status: "loading", models: [] }] };
    await call(launchOptionsRpc, { projectId: "prj_git" });
    expect(paseo.providers.waitForReady).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/git" }));
  });

  it("creates one workspace and agent per launch with 0.9 idempotency keys", async () => {
    const paseo = fakePaseo();
    const { call } = host(paseo);
    const itemId = await seed(call);
    const accepted = await call(launchRpc, launchInput(itemId));
    expect(accepted).toMatchObject({ stage: "prepared", replayed: false, workspaceId: null });
    const done = await settle(call, "launch-test-0001");
    expect(done).toMatchObject({ stage: "started", workspaceId: "wks_0000000000000001", agentId: "agent-1", error: null });
    expect(paseo.log.workspaces).toEqual([{
      idempotencyKey: "project-notes:launch-test-0001:workspace", title: "上线检查",
      source: expect.objectContaining({ kind: "worktree", projectId: "prj_git", cwd: "/repo/git", action: "branch-off", baseBranch: "main", branchName: expect.stringMatching(/^notes\/[a-f0-9]{12}$/) }),
    }]);
    expect(paseo.log.agents).toEqual([expect.objectContaining({
      idempotencyKey: "project-notes:launch-test-0001:agent", title: "上线检查", autoArchive: false,
      config: { provider: "claude/m1", modeId: "auto", thinkingOptionId: "high" },
      labels: { "project-notes.launch-id": "launch-test-0001", "project-notes.item-id": itemId },
    })]);
    expect(paseo.log.sends).toEqual([["agent-1", "上线检查\n\n逐项核对", { messageId: "project-notes-launch-test-0001" }]]);
    // Double tap / retry: the same intent replays the receipt and creates nothing.
    expect(await call(launchRpc, launchInput(itemId))).toMatchObject({ stage: "started", replayed: true, agentId: "agent-1" });
    await expect(call(launchRpc, launchInput(itemId, { title: "另一件事" }))).rejects.toThrow(/已经用于不同内容/);
    expect(paseo.log.workspaces).toHaveLength(1);
    const journal = JSON.parse(await readFile(join(home, "plugin-data", "project-notes", "launches", "launch-test-0001.json"), "utf8"));
    expect(journal).toMatchObject({ stage: "started", agentId: "agent-1" });
    expect((await readdir(join(home, "plugin-data", "project-notes", "launches"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("deduplicates concurrent taps and overlapping plugin processes", async () => {
    const paseo = fakePaseo();
    const first = host(paseo), second = host(paseo);
    const itemId = await seed(first.call);
    const input = launchInput(itemId, { launchId: "launch-test-0002", isolation: "local", baseBranch: undefined });
    await Promise.all([first.call(launchRpc, input), first.call(launchRpc, input), second.call(launchRpc, input)]);
    await settle(first.call, "launch-test-0002");
    await settle(second.call, "launch-test-0002");
    expect(paseo.log.workspaces).toHaveLength(1);
    expect(paseo.log.workspaces[0]!.source).toEqual({ kind: "directory", projectId: "prj_git", path: "/repo/git" });
    expect(paseo.log.agents).toHaveLength(1);
  });

  it("rejects without creating anything when validation fails, and marks later failures uncertain", async () => {
    const paseo = fakePaseo();
    const { call } = host(paseo);
    const itemId = await seed(call);
    await call(launchRpc, launchInput(itemId, { launchId: "launch-bad-provider", provider: "codex" }));
    expect(await settle(call, "launch-bad-provider")).toMatchObject({ stage: "rejected", workspaceId: null, error: expect.stringMatching(/provider 当前不可用.*尚未创建工作区/) });
    await call(launchRpc, launchInput(itemId, { launchId: "launch-bad-worktree", projectId: "prj_dir" }));
    expect(await settle(call, "launch-bad-worktree")).toMatchObject({ stage: "rejected", error: expect.stringMatching(/不支持 Git worktree/) });
    await call(launchRpc, launchInput(itemId, { launchId: "launch-bad-profile", profileId: "profile-1" }));
    expect(await settle(call, "launch-bad-profile")).toMatchObject({ stage: "rejected", error: expect.stringMatching(/Profile 已变化/) });
    expect(paseo.log.workspaces).toHaveLength(0);
    paseo.workspaces.create.mockImplementationOnce(async () => ({ id: "wks_ffffffffffffffff", agents: { create: vi.fn(async () => { throw new Error("provider 启动失败"); }) } }) as never);
    await call(launchRpc, launchInput(itemId, { launchId: "launch-agent-fails" }));
    expect(await settle(call, "launch-agent-fails")).toMatchObject({ stage: "uncertain", workspaceId: "wks_ffffffffffffffff", agentId: null, error: expect.stringMatching(/provider 启动失败.*可能已经创建/) });
  });

  it("caps provider and launch errors before they reach the app", async () => {
    const paseo = fakePaseo();
    paseo.catalog = { entries: [{ ...ready("claude"), error: "供应商错误".repeat(1_000) }] } as never;
    const { call } = host(paseo);
    const options = await call(launchOptionsRpc, { projectId: "prj_git" });
    expect(Array.from(options.providers[0]!.error!)).toHaveLength(500);
    expect(options.providers[0]!.error).toMatch(/^(供应商错误)+供应商错…$/);
    const itemId = await seed(call);
    paseo.workspaces.create.mockImplementationOnce(async () => { throw new Error("工作区失败".repeat(1_000)); });
    await call(launchRpc, launchInput(itemId, { launchId: "launch-long-error" }));
    const receipt = await settle(call, "launch-long-error");
    expect(receipt.error).toMatch(/^(工作区失败)+工作区失…。工作区或会话可能已经创建，请先检查，不会自动重复启动。$/);
    expect(Array.from(receipt.error!).length).toBeLessThan(560);
    // A journal from an older version with an uncapped error is capped on the way out too.
    const launches = join(home, "plugin-data", "project-notes", "launches");
    await writeFile(join(launches, "launch-old-error.json"), JSON.stringify({ launchId: "launch-old-error", inputHash: "x", stage: "uncertain", workspaceId: null, agentId: null, error: "旧".repeat(5_000) }));
    expect(Array.from((await call(launchStatusRpc, { launchId: "launch-old-error" }))!.error!).length).toBeLessThanOrEqual(600);
  });

  it("passes the profile's feature values when the profile matches", async () => {
    const paseo = fakePaseo();
    const { call } = host(paseo);
    const itemId = await seed(call);
    await call(launchRpc, launchInput(itemId, { launchId: "launch-profile-ok", profileId: "profile-1", modeId: "plan" }));
    await settle(call, "launch-profile-ok");
    expect(paseo.log.agents[0]!.config).toEqual({ provider: "claude/m1", modeId: "plan", thinkingOptionId: "high", featureValues: { fast: true } });
  });

  it("reports an interrupted launch as uncertain and looks up, never creates, what already exists", async () => {
    const paseo = fakePaseo();
    const launches = join(home, "plugin-data", "project-notes", "launches");
    await (await import("node:fs/promises")).mkdir(launches, { recursive: true });
    await writeFile(join(launches, "launch-interrupted.json"), JSON.stringify({ launchId: "launch-interrupted", inputHash: "x", stage: "creating_agent", workspaceId: "wks_0000000000000009", agentId: null, error: null }));
    paseo.agents.list.mockResolvedValueOnce({ requestId: "r", entries: [{ agent: { id: "agent-9", workspaceId: "wks_0000000000000009", labels: { "project-notes.launch-id": "launch-interrupted" } } }], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } });
    const { call } = host(paseo); // a fresh plugin process
    const status = await call(launchStatusRpc, { launchId: "launch-interrupted" });
    expect(status).toMatchObject({ stage: "uncertain", workspaceId: "wks_0000000000000009", agentId: "agent-9", replayed: true, error: expect.stringMatching(/启动流程已中断/) });
    expect(paseo.agents.list).toHaveBeenCalledWith(expect.objectContaining({ filter: { labels: { "project-notes.launch-id": "launch-interrupted" }, includeArchived: true } }));
    expect(paseo.workspaces.create).not.toHaveBeenCalled();
    // A failing lookup still answers.
    await writeFile(join(launches, "launch-interrupted-2.json"), JSON.stringify({ launchId: "launch-interrupted-2", inputHash: "x", stage: "creating_workspace", workspaceId: null, agentId: null, error: null }));
    paseo.agents.list.mockRejectedValueOnce(new Error("offline"));
    expect(await call(launchStatusRpc, { launchId: "launch-interrupted-2" })).toMatchObject({ stage: "uncertain", workspaceId: null, agentId: null });
    expect(await call(launchStatusRpc, { launchId: "launch-unknown-1" })).toBeNull();
  });

  it("stops an active launch when the plugin unloads", async () => {
    const paseo = fakePaseo();
    let release!: () => void;
    paseo.workspaces.create.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ id: "wks_1111111111111111", agents: { create: vi.fn() } } as never); }));
    const { call, cleanup } = host(paseo);
    const itemId = await seed(call);
    await call(launchRpc, launchInput(itemId, { launchId: "launch-unload-1" }));
    await vi.waitFor(() => expect(paseo.workspaces.create).toHaveBeenCalled());
    cleanup();
    release();
    const receipt = await settle(call, "launch-unload-1");
    expect(receipt).toMatchObject({ stage: "uncertain", workspaceId: "wks_1111111111111111", error: expect.stringMatching(/插件正在重载/) });
  });
});
