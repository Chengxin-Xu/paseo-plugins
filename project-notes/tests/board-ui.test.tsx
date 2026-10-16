import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, act, createElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider, environmentManager, notifyManager } from "@tanstack/react-query";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { BoardSnapshot, DashboardUpdate, WriteBoardInput } from "../shared/board";
import type { LaunchReceipt } from "../shared/launch";

// Host modules exist only inside the Paseo app; these stand-ins keep the real components and React Query.
const host = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState: "active" as string,
    addEventListener(_type: string, listener: (state: string) => void) { listeners.add(listener); return { remove: () => listeners.delete(listener) }; },
    set(state: string) { appState.currentState = state; for (const listener of listeners) listener(state); },
  };
  const toasts: string[] = [], copies: string[] = [];
  return { appState, handlers: new Map<string, (input: any) => Promise<unknown>>(), calls: [] as { method: string; input: any }[], toasts, copies, toast: { show: (message: string) => { toasts.push(message); }, error: (message: string) => { toasts.push(message); } } };
});
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", Platform: { OS: "web" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }, AppState: host.appState,
}));
// Launch status dots animate with the kit's motion (Animated); here only what the marks wrap matters.
vi.mock("../client/motion", () => ({ Ping: () => null, Breathe: ({ children }: { children: unknown }) => children, Flash: () => null, useChangeCount: () => 0 }));
vi.mock("@getpaseo/plugin/client", () => {
  const cache = new Map<string, unknown>();
  return {
    useWorkspace: () => null,
    // Like the SDK: validate input, call the host, validate output. Stable per contract.
    useRpc: (contract: PluginRpcContract) => {
      if (!cache.has(contract.name)) cache.set(contract.name, async (input: unknown) => {
        const parsed = await contract.input.parseAsync(input);
        host.calls.push({ method: contract.name, input: parsed });
        const handler = host.handlers.get(contract.name); if (!handler) throw new Error(`unexpected ${contract.name}`);
        return contract.output.parseAsync(await handler(parsed));
      });
      return cache.get(contract.name);
    },
  };
});
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const { createElement: h } = await import("react");
  const Modal = Object.assign(({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open ? h("Modal", { title }, children) : null, { Content: ({ children }: { children: ReactNode }) => children });
  const FlatList = ({ data, renderItem, ListEmptyComponent, ...props }: any) => h("FlatList", props, data.length ? data.slice(0, props.initialNumToRender ?? data.length).map((item: any, index: number) => h("Row", { key: index }, renderItem({ item, index }))) : ListEmptyComponent);
  return { Icon: "Icon", Modal, FlatList, ScrollView: "ScrollView", TextInput: "TextInput", copyText: async (text: string) => { host.copies.push(text); }, useToast: () => host.toast };
});

const { NotesSurface } = await import("../client/board");
const { KIND_TONES, MARK_HUES, STATUS_TONES, statusColor } = await import("../client/ui");
const { hue } = await import("../client/kit");

const theme = { colors: Object.fromEntries(["surface0", "surface1", "surface2", "border", "foreground", "foregroundMuted", "accent", "accentForeground", "statusSuccess", "statusWarning", "statusDanger"].map(key => [key, "#000"])) } as never;
const now = "2026-09-22T00:00:00.000Z";
const itemId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const board = (revision: number, title = "上线检查"): BoardSnapshot => ({ projectId: "prj_git", revision, items: [{ id: itemId, projectId: "prj_git", revision, kind: "task", title, body: "", status: "todo", priority: "normal", pinned: false, createdAt: now, updatedAt: now, deletedAt: null }] });
const projects = [{ id: "__inbox__", name: "随手记", path: "暂不归入项目的想法" }, { id: "prj_git", name: "Git 项目", path: "/repo/git" }];

let serverBoard = board(1), serverRevision = "rev-1";
function dashboardHandler(input: { revision?: string; refreshProjectIds?: string[] }): DashboardUpdate {
  if (input.revision === serverRevision && !input.refreshProjectIds?.length) return { unchanged: true, revision: serverRevision };
  return { revision: serverRevision, ...(input.revision ? {} : { projects }), boards: [serverBoard] };
}
/** Host components are mocked as plain strings ("View", "Text", "Pressable"). */
const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const dashboardCalls = () => host.calls.filter(call => call.method === "project-notes.dashboard");
const texts = (root: ReactTestInstance) => root.findAll(node => is(node, "Text")).flatMap(node => node.children).filter((child): child is string => typeof child === "string");
const press = (root: ReactTestInstance, label: string) => act(async () => { root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === label).props.onPress(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const pressables = (root: ReactTestInstance, label: string) => root.findAll(node => is(node, "Pressable") && node.props.accessibilityLabel === label);
const writes = () => host.calls.filter(call => call.method === "project-notes.write");
/** A write handler that applies the operation to `serverBoard` like the store does. */
function applyWrites() {
  host.handlers.set("project-notes.write", async (input: WriteBoardInput) => {
    const operation = input.operation, now = "2026-09-22T01:00:00.000Z";
    let items = serverBoard.items, id = itemId;
    if (operation.type === "create") { id = "7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"; items = [{ ...operation.fields, id, projectId: input.projectId, revision: 1, createdAt: now, updatedAt: now, deletedAt: null }, ...items]; }
    else if (operation.type === "emptyTrash") items = items.filter(item => item.deletedAt === null);
    else if (operation.type === "purge") items = items.filter(item => item.id !== operation.id);
    else items = items.map(item => item.id !== operation.id ? item : { ...item, ...(operation.type === "update" ? operation.fields : { deletedAt: operation.type === "delete" ? now : null }), revision: item.revision + 1, updatedAt: now });
    serverBoard = { ...serverBoard, projectId: input.projectId, revision: serverBoard.revision + 1, items }; serverRevision = `rev-${serverBoard.revision}`;
    return { board: serverBoard, itemId: id, replayed: false };
  });
}

let renderer: ReactTestRenderer, navigation: { openAgent: ReturnType<typeof vi.fn>; openWorkspace: ReturnType<typeof vi.fn> }, commits = 0;
async function mount() {
  const client = new QueryClient();
  navigation = { openAgent: vi.fn(), openWorkspace: vi.fn() };
  await act(async () => {
    const surface = createElement(NotesSurface, { theme, host: { id: "srv-1", label: "测试主机" }, layout: { compact: false, platform: "web" }, navigation } as never);
    renderer = create(createElement(QueryClientProvider, { client }, createElement(Profiler, { id: "notes", onRender: () => { commits++; } }, surface)), { unstable_isConcurrent: true } as never);
  });
  await advance(0);
  return renderer.root;
}

// Node has no `window`, so React Query would otherwise behave as on a server (no refetch intervals).
environmentManager.setIsServer(() => false);
// Deliver React Query notifications on microtasks instead of setTimeout(0), which fake timers would hold back.
notifyManager.setScheduler(queueMicrotask);
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
  vi.useFakeTimers();
  host.appState.currentState = "active"; host.calls.length = 0; host.handlers.clear(); host.toasts.length = 0; host.copies.length = 0; commits = 0;
  serverBoard = board(1); serverRevision = "rev-1";
  host.handlers.set("project-notes.dashboard", async input => dashboardHandler(input));
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.useRealTimers(); });

describe("NotesSurface polling", () => {
  it("loads once, then polls with its revision and keeps the board on unchanged replies", async () => {
    const root = await mount();
    expect(dashboardCalls().map(call => call.input)).toEqual([{}]);
    expect(texts(root)).toContain("上线检查");
    const committed = commits;
    await advance(5_000);
    expect(dashboardCalls().map(call => call.input)).toEqual([{}, { revision: "rev-1" }]);
    expect(texts(root)).toContain("上线检查");
    // An unchanged poll keeps the same data object: React commits nothing.
    expect(commits).toBe(committed);
    // A change elsewhere (e.g. the CLI) arrives as a delta on the next poll.
    serverBoard = board(2, "命令行改过"); serverRevision = "rev-2";
    await advance(5_000);
    expect(texts(root)).toContain("命令行改过");
    expect(commits).toBeGreaterThan(committed);
    expect(dashboardCalls().at(-1)!.input).toEqual({ revision: "rev-1" });
  });

  it("stops polling in the background and inactive states and refreshes on return", async () => {
    await mount();
    await act(async () => host.appState.set("background"));
    await advance(30_000);
    expect(dashboardCalls()).toHaveLength(1);
    await act(async () => host.appState.set("active"));
    await advance(0);
    expect(dashboardCalls()).toHaveLength(2);
    await act(async () => host.appState.set("inactive"));
    await advance(30_000);
    expect(dashboardCalls()).toHaveLength(2);
  });

  it("stops polling while laid out at zero size (a retained, hidden tab)", async () => {
    const root = await mount();
    const layoutRoot = root.find(node => is(node, "View") && typeof node.props.onLayout === "function");
    await act(async () => layoutRoot.props.onLayout({ nativeEvent: { layout: { width: 0, height: 0, x: 0, y: 0 } } }));
    await advance(30_000);
    expect(dashboardCalls()).toHaveLength(1);
    await act(async () => layoutRoot.props.onLayout({ nativeEvent: { layout: { width: 900, height: 700, x: 0, y: 0 } } }));
    await advance(0);
    expect(dashboardCalls()).toHaveLength(2);
  });

  it("relaxes to the idle interval after a minute without changes", async () => {
    await mount();
    await advance(60_000);
    const beforeIdle = dashboardCalls().length;
    expect(beforeIdle).toBe(13); // initial load + 12 fast polls
    await advance(30_000);
    expect(dashboardCalls().length - beforeIdle).toBe(2); // every 15 s now
  });

  it("shows its own write immediately and returns to fast polling", async () => {
    const root = await mount();
    await advance(70_000); // idle
    host.handlers.set("project-notes.write", async (input: WriteBoardInput) => {
      if (input.operation.type !== "update") throw new Error("unexpected");
      serverBoard = { ...board(2), items: [{ ...board(2).items[0]!, status: input.operation.fields.status! }] }; serverRevision = "rev-2";
      return { board: serverBoard, itemId, replayed: false };
    });
    const callsBefore = dashboardCalls().length;
    await press(root, "上线检查：移到进行中");
    expect(host.calls.find(call => call.method === "project-notes.write")!.input).toMatchObject({ projectId: "prj_git", operation: { type: "update", id: itemId, expectedRevision: 1, fields: { status: "doing" } } });
    expect(dashboardCalls()).toHaveLength(callsBefore);
    // The card now shows 进行中: its status glyph offers the next step.
    expect(root.findAll(node => is(node, "Pressable") && node.props.accessibilityLabel === "上线检查：移到进行中")).toHaveLength(0);
    expect(root.findAll(node => is(node, "Pressable") && node.props.accessibilityLabel === "上线检查：移到已完成")).toHaveLength(1);
    await advance(5_000);
    expect(dashboardCalls()).toHaveLength(callsBefore + 1);
  });
});

describe("unavailable boards", () => {
  it("shows the other projects and says which board it could not show, instead of calling it empty", async () => {
    const big = { id: "prj_big", name: "大项目", path: "/repo/big" };
    host.handlers.set("project-notes.dashboard", async input => input.revision === "rev-big" ? { unchanged: true, revision: "rev-big" }
      : { revision: "rev-big", projects: [...projects, big], boards: [serverBoard], unavailable: [{ projectId: "prj_big", bytes: 40 * 1024 * 1024, reason: "file" }] });
    const root = await mount();
    expect(texts(root)).toContain("上线检查");
    expect(texts(root)).toContain("「大项目」的手记暂时无法显示：手记文件超过 32 MB。其余项目照常显示；请先备份，再精简这些手记。");
    await press(root, "筛选项目：全部项目");
    const row = root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "大项目");
    expect(texts(row)).toContain("不可用");
    await press(root, "大项目");
    expect(texts(root)).toContain("「大项目」的手记暂时无法显示");
    expect(texts(root).some(text => text.includes("还没有"))).toBe(false);
  });
});

describe("NotesSurface actions", () => {
  it("advances a task from its status glyph with one write, ignoring taps while that write is in flight", async () => {
    let release: () => void = () => {};
    applyWrites();
    const apply = host.handlers.get("project-notes.write")!;
    host.handlers.set("project-notes.write", input => new Promise(resolve => { release = () => resolve(apply(input)); }));
    const root = await mount();
    const toggle = pressables(root, "上线检查：移到进行中")[0]!;
    await act(async () => { toggle.props.onPress(); toggle.props.onPress(); });
    expect(writes()).toHaveLength(1);
    // The pending card's glyph is disabled until the write settles.
    expect(pressables(root, "上线检查：移到进行中")[0]!.props.disabled).toBe(true);
    await act(async () => { release(); });
    await advance(0);
    expect(writes()).toHaveLength(1);
    expect(pressables(root, "上线检查：移到已完成")).toHaveLength(1);
  });

  it("creates a note: 保存 stays disabled until there is a title, then writes once into the suggested project", async () => {
    applyWrites();
    const root = await mount();
    await press(root, "新建任务");
    const save = () => pressables(root, "保存")[0]!;
    expect(save().props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => { root.find(node => is(node, "TextInput") && node.props.accessibilityLabel === "标题").props.onChangeText("  写周报  "); });
    expect(save().props.accessibilityState).toMatchObject({ disabled: false });
    await act(async () => { save().props.onPress(); });
    await advance(0);
    expect(writes().map(call => call.input)).toEqual([expect.objectContaining({ projectId: "__inbox__", operation: { type: "create", fields: { kind: "task", status: "todo", title: "写周报", body: "", priority: "normal", pinned: false } } })]);
    expect(host.toasts).toEqual(["已保存到「随手记」"]);
    expect(texts(root)).toContain("写周报");
    expect(pressables(root, "保存")).toHaveLength(0); // the sheet closed
  });

  it("deletes from the detail sheet without a confirmation round-trip and restores from 回收站", async () => {
    applyWrites();
    const root = await mount();
    await press(root, "上线检查");
    await press(root, "删除");
    expect(writes().at(-1)!.input.operation).toEqual({ type: "delete", id: itemId, expectedRevision: 1 });
    expect(host.toasts).toEqual(["已移到回收站"]);
    expect(pressables(root, "删除")).toHaveLength(0);
    expect(pressables(root, "上线检查")).toHaveLength(0);
    await press(root, "更多操作");
    await press(root, "回收站");
    await press(root, "恢复：上线检查");
    expect(writes().at(-1)!.input.operation).toEqual({ type: "restore", id: itemId, expectedRevision: 2 });
    expect(writes()).toHaveLength(2);
    expect(host.toasts.at(-1)).toBe("已恢复到「任务」");
  });

  it("fetches history only on opening it, retries failures and restores the selected version", async () => {
    serverBoard.items[0]!.historyCount = 1;
    const history = { ...serverBoard.items[0]!, title: "以前的标题", body: "以前的正文", revision: 1 };
    serverBoard.items[0]!.revision = 2;
    let fail = true;
    host.handlers.set("project-notes.history", async () => { if (fail) throw new Error("快照读取失败"); return { versions: [history], missing: false, missingCount: 0, itemRevision: 2 }; });
    applyWrites();
    const root = await mount();
    await press(root, "上线检查");
    expect(host.calls.filter(call => call.method === "project-notes.history")).toHaveLength(0);
    await press(root, "修改快照 · 最近 1 版"); await advance(0);
    expect(texts(root)).toContain("快照读取失败"); fail = false;
    await press(root, "重试"); await advance(0);
    await press(root, "第 1 版");
    expect(texts(root)).toContain("以前的正文");
    await press(root, "恢复第 1 版");
    expect(writes().at(-1)!.input.operation).toEqual({ type: "restoreVersion", id: itemId, expectedRevision: 2, revision: 1 });
  });

  it("requires explicit confirmation for permanent deletion and clearing the recycle bin", async () => {
    applyWrites();
    const root = await mount();
    await press(root, "上线检查"); await press(root, "删除");
    await press(root, "更多操作"); await press(root, "回收站");
    await press(root, "上线检查"); await press(root, "彻底删除");
    expect(writes()).toHaveLength(1);
    const confirm = root.find(node => node.props.label === "确认彻底删除" && node.props.variant === "secondary");
    expect(confirm.props.tone).toBe("danger");
    expect(texts(root).some(text => text.includes("无法恢复"))).toBe(true);
    await press(root, "取消"); expect(writes()).toHaveLength(1);
    await press(root, "彻底删除"); await press(root, "确认彻底删除"); await advance(0);
    expect(writes().at(-1)!.input.operation).toEqual({ type: "purge", id: itemId, expectedRevision: 2 });
    expect(texts(root)).toContain("回收站是空的");
    serverBoard = { ...board(4), items: [{ ...board(4).items[0]!, deletedAt: now }] }; serverRevision = "rev-4";
    await advance(5_000);
    await press(root, "更多操作"); await press(root, "清空回收站");
    expect(writes()).toHaveLength(2);
    await press(root, "确认彻底删除"); await advance(0);
    expect(writes().at(-1)!.input.operation).toEqual({ type: "emptyTrash", expectedRevision: 4 });
    expect(texts(root)).toContain("回收站是空的");
  });

  it("states that emptying the recycle bin includes notes hidden by the search", async () => {
    const visible = { ...board(3).items[0]!, title: "匹配条目", deletedAt: now };
    serverBoard = { ...board(3), items: [visible, { ...visible, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "隐藏条目" }] };
    applyWrites(); const root = await mount();
    await press(root, "更多操作"); await press(root, "回收站");
    const search = root.find(node => is(node, "TextInput") && node.props.accessibilityLabel === "搜索回收站");
    await act(async () => search.props.onChangeText("匹配")); await advance(200);
    expect(texts(root)).not.toContain("隐藏条目");
    await press(root, "更多操作"); await press(root, "清空回收站");
    expect(texts(root).some(text => text.includes("全部 2 条手记（含搜索未显示的）"))).toBe(true);
    expect(writes()).toHaveLength(0);
    await press(root, "取消"); expect(serverBoard.items).toHaveLength(2);
    await press(root, "更多操作"); await press(root, "清空回收站"); await press(root, "确认彻底删除");
    expect(writes().at(-1)!.input.operation).toEqual({ type: "emptyTrash", expectedRevision: 3 });
    expect(serverBoard.items).toHaveLength(0);
  });

  it("requires confirmation before abandoning missing snapshots and binds it to the read revision", async () => {
    serverBoard.items[0] = { ...serverBoard.items[0]!, historyCount: 2, body: "保留当前正文", revision: 7 };
    const version = { ...serverBoard.items[0]!, revision: 5, body: "保留仍在的历史" };
    host.handlers.set("project-notes.history", async () => ({ versions: [version], missing: true, missingCount: 1, itemRevision: 7 }));
    host.handlers.set("project-notes.write", async (input: WriteBoardInput) => {
      expect(input.operation).toEqual({ type: "repairHistory", id: itemId, expectedRevision: 7 });
      serverBoard = { ...serverBoard, revision: serverBoard.revision + 1, items: [{ ...serverBoard.items[0]!, historyCount: 1, revision: 8 }] };
      host.handlers.set("project-notes.history", async () => ({ versions: [version], missing: false, missingCount: 0, itemRevision: 8 }));
      return { board: serverBoard, itemId, replayed: false };
    });
    const root = await mount(); await press(root, "上线检查"); await press(root, "修改快照 · 最近 2 版"); await advance(0);
    expect(texts(root).some(text => text.includes("有 1 个修改快照缺失"))).toBe(true);
    await press(root, "放弃缺失的快照并继续"); expect(writes()).toHaveLength(0);
    await press(root, "取消放弃"); expect(writes()).toHaveLength(0);
    await press(root, "放弃缺失的快照并继续"); await press(root, "确认放弃缺失快照"); await advance(0);
    expect(writes()).toHaveLength(1); expect(serverBoard.items[0]!.body).toBe("保留当前正文");
    await press(root, "第 5 版"); expect(texts(root)).toContain("保留仍在的历史");
    expect(texts(root).some(text => text.includes("有 1 个修改快照缺失"))).toBe(false);
  });

  it("retains the last server revision and requests only locally written projects on the next poll", async () => {
    applyWrites();
    const root = await mount();
    await press(root, "上线检查：移到进行中"); await advance(0);
    await press(root, "上线检查：移到已完成"); await advance(0);
    await advance(5_000);
    expect(dashboardCalls().at(-1)!.input).toEqual({ revision: "rev-1", refreshProjectIds: ["prj_git"] });
    await advance(5_000);
    expect(dashboardCalls().at(-1)!.input).toEqual({ revision: "rev-3" });
  });

  it("stops saving an edit that another device overtook until 载入最新 loads the newer version", async () => {
    const root = await mount();
    await press(root, "上线检查");
    await press(root, "编辑");
    const save = () => pressables(root, "保存")[0]!;
    const title = () => root.find(node => is(node, "TextInput") && node.props.accessibilityLabel === "标题");
    expect(save().props.accessibilityState).toMatchObject({ disabled: false });
    serverBoard = board(2, "别处改过"); serverRevision = "rev-2";
    await advance(5_000);
    expect(save().props.accessibilityState).toMatchObject({ disabled: true });
    expect(title().props.value).toBe("上线检查"); // the draft is kept
    await press(root, "载入最新");
    expect(title().props.value).toBe("别处改过");
    expect(save().props.accessibilityState).toMatchObject({ disabled: false });
    expect(writes()).toHaveLength(0);
  });

  it("copies a prompt from its row and opens sheets and menus without any RPC", async () => {
    serverBoard = { ...board(1), items: [...board(1).items, { ...board(1).items[0]!, id: "5b2c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", kind: "prompt", title: "评审提示词", body: "只看正确性" }] };
    const root = await mount();
    const before = host.calls.length;
    await press(root, "提示词 1");
    await press(root, "复制：评审提示词");
    expect(host.copies).toEqual(["只看正确性"]);
    expect(host.toasts).toEqual(["已复制"]);
    await press(root, "筛选项目：全部项目");
    await press(root, "更多操作");
    await press(root, "评审提示词");
    expect(host.calls.slice(before).map(call => call.method)).toEqual([]);
  });
});

describe("LaunchDialog", () => {
  it("polls launch status only in the foreground and opens the agent on this host", async () => {
    let status: LaunchReceipt = { launchId: "x", stage: "creating_workspace", workspaceId: null, agentId: null, error: null, replayed: true };
    host.handlers.set("project-notes.launch-options", async () => ({
      projects: [{ id: "prj_git", name: "Git 项目", path: "/repo/git", kind: "git" }], project: { id: "prj_git", name: "Git 项目", path: "/repo/git", kind: "git" },
      providers: [{ id: "claude", label: "Claude", status: "ready", error: null, models: [{ id: "m1", label: "M1", isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null }], modes: [], defaultModeId: null }], profiles: [],
    }));
    host.handlers.set("project-notes.launch", async (input: { launchId: string }) => { status = { ...status, launchId: input.launchId }; return { ...status, stage: "prepared", replayed: false }; });
    host.handlers.set("project-notes.launch-status", async () => status);
    const root = await mount();
    await press(root, "上线检查"); // the card opens its detail sheet
    await press(root, "开始处理");
    await advance(0);
    await press(root, "创建工作区并开始");
    const launch = host.calls.find(call => call.method === "project-notes.launch")!.input;
    expect(launch).toMatchObject({ sourceProjectId: "prj_git", itemId, projectId: "prj_git", isolation: "worktree", provider: "claude", model: "m1" });
    const statusCalls = () => host.calls.filter(call => call.method === "project-notes.launch-status").length;
    await advance(2_000);
    const polled = statusCalls();
    expect(polled).toBeGreaterThan(0);
    await act(async () => host.appState.set("background"));
    await advance(20_000);
    expect(statusCalls()).toBe(polled);
    status = { ...status, stage: "started", workspaceId: "wks_0000000000000001", agentId: "agent-1" };
    await act(async () => host.appState.set("active"));
    await advance(2_000);
    expect(navigation.openAgent).toHaveBeenCalledWith({ agentId: "agent-1", serverId: "srv-1" });
    const settled = statusCalls();
    await advance(20_000);
    expect(statusCalls()).toBe(settled);
  });
});

describe("colour semantics", () => {
  it("keeps kinds, statuses and marks on their fixed colours", () => {
    expect(KIND_TONES).toEqual({ task: "blue", prompt: "violet", idea: "amber" });
    expect(STATUS_TONES).toEqual({ todo: "neutral", doing: "info", done: "success" });
    // 重点 and 置顶 use the attention colours the kit keeps out of project marks; red is not 删除's here.
    expect(MARK_HUES).toEqual({ high: "red", pinned: "amber" });
    expect(statusColor(theme, "doing")).toBe(hue(theme, "blue"));
    expect(statusColor(theme, "done")).toBe(hue(theme, "green"));
  });

  it("draws an in-progress card's status glyph in blue", async () => {
    serverBoard = { ...board(1), items: [{ ...board(1).items[0]!, status: "doing" }] };
    const root = await mount();
    const toggle = pressables(root, "上线检查：移到已完成")[0]!;
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
    const ring = toggle.findAll(node => is(node, "View") && flat(node.props.style).borderWidth !== undefined)[0]!;
    expect(flat(ring.props.style).borderColor).toBe(hue(theme, "blue"));
  });
});


describe("large-board search", () => {
  it("uses bounded virtual rows and waits for settled input before filtering 4000 notes", async () => {
    const seed = board(1).items[0]!;
    serverBoard = { ...board(1), items: Array.from({ length: 4000 }, (_, index) => ({ ...seed, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: `任务 ${index}`, body: index === 3999 ? "目标内容" : "普通内容".repeat(500) })) };
    const root = await mount();
    const list = () => root.findAll(node => is(node, "FlatList"))[0]!;
    expect(list().props.windowSize).toBe(5);
    expect(texts(root).filter(text => /^任务 \d+$/.test(text)).length).toBeLessThanOrEqual(12);
    const input = root.find(node => is(node, "TextInput") && node.props.placeholder === "搜索任务");
    await act(async () => input.props.onChangeText("目标内容"));
    expect(texts(root)).not.toContain("任务 3999");
    await advance(160);
    expect(texts(root)).toContain("任务 3999");
    expect(texts(root)).not.toContain("任务 0");
  });
});
