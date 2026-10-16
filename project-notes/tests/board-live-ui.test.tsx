import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider, environmentManager, notifyManager } from "@tanstack/react-query";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { BoardItem, BoardSnapshot, DashboardUpdate } from "../shared/board";
import type { QuickEntry } from "../shared/quick";
import { liteAgent, type AgentDirectory, type AgentLite } from "../client/agent-directory";
import type { QuickStore } from "../client/quick-store";

// The board with the resident plugin's live copies: task cards show what the agents their notes started are doing (from
// the agent directory, never a timeline), the detail lists every launch, and prompts can be made one-tap pills.

const host = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const appState = { currentState: "active" as string, addEventListener(_type: string, listener: (state: string) => void) { listeners.add(listener); return { remove: () => listeners.delete(listener) }; }, set(state: string) { appState.currentState = state; for (const listener of listeners) listener(state); } };
  const toasts: string[] = [];
  return { appState, handlers: new Map<string, (input: any) => Promise<unknown>>(), calls: [] as { method: string; input: any }[], toasts, toast: { show: (message: string) => { toasts.push(message); }, error: (message: string) => { toasts.push(message); } } };
});
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", Platform: { OS: "web" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }, AppState: host.appState,
}));
vi.mock("../client/motion", () => ({ Ping: () => null, Breathe: ({ children }: { children: unknown }) => children, Flash: () => null, useChangeCount: () => 0 }));
vi.mock("@getpaseo/plugin/client", () => {
  const cache = new Map<string, unknown>();
  return {
    useWorkspace: () => null,
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
  const FlatList = ({ data, renderItem, ListEmptyComponent, ...props }: any) => h("FlatList", props, data.length ? data.map((item: any, index: number) => h("Row", { key: index }, renderItem({ item, index }))) : ListEmptyComponent);
  return { Icon: "Icon", Modal, FlatList, ScrollView: "ScrollView", TextInput: "TextInput", copyText: async () => {}, useToast: () => host.toast };
});

const { NotesSurface } = await import("../client/board");
const theme = { colors: Object.fromEntries(["surface0", "surface1", "surface2", "border", "foreground", "foregroundMuted", "accent", "accentForeground"].map(key => [key, "#000000"])) } as never;
const now = "2026-10-15T08:00:00.000Z";
const taskId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", promptId = "7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", otherId = "8b1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const note = (patch: Partial<BoardItem>): BoardItem => ({ id: taskId, projectId: "prj_git", revision: 1, kind: "task", title: "修复登录超时", body: "", status: "doing", priority: "normal", pinned: false, createdAt: now, updatedAt: now, deletedAt: null, ...patch });
let serverBoard: BoardSnapshot;
const projects = [{ id: "__inbox__", name: "随手记", path: "暂不归入项目的想法" }, { id: "prj_git", name: "示例项目", path: "/repo/git" }];
function dashboard(input: { revision?: string }): DashboardUpdate {
  const revision = `rev-${serverBoard.revision}`;
  return input.revision === revision ? { unchanged: true, revision } : { revision, projects, boards: [serverBoard] };
}

/** The resident's live agent directory, driven by the test. */
function fakeDirectory(initial: AgentLite[]) {
  const agents = new Map(initial.map(agent => [agent.id, agent])), listeners = new Set<(changed: ReadonlySet<string> | null) => void>();
  let version = 0;
  const directory: AgentDirectory = {
    ready: () => true, get: id => agents.get(id), list: () => [...agents.values()], version: () => version, dispose() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const change = (agent: AgentLite | { remove: string }) => act(async () => {
    if ("remove" in agent) agents.delete(agent.remove); else agents.set(agent.id, agent);
    version++;
    for (const listener of [...listeners]) listener(new Set(["remove" in agent ? agent.remove : agent.id]));
  });
  return { directory, change };
}
/** The resident's one-tap list; saves come back through `adopt` like the real store. */
function fakeQuick(initial: QuickEntry[]) {
  let entries = initial, revision = "rev-q1", version = 0;
  const listeners = new Set<() => void>();
  const store: QuickStore = {
    entries: () => entries, revision: () => revision, ready: () => true, version: () => version, refresh: async () => {}, dispose() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    adopt(values, next) { entries = (values as { prompts: QuickEntry[] }).prompts; revision = next; version++; for (const listener of [...listeners]) listener(); },
  };
  return store;
}
const lite = (patch: Record<string, unknown>) => liteAgent({ id: "agent-1", workspaceId: "ws-1", provider: "example", status: "running", pendingPermissions: [], title: "修复登录超时", createdAt: now, updatedAt: "2026-10-15T08:30:00.000Z",
  labels: { "project-notes.item-id": taskId, "project-notes.launch-id": "launch-0001" }, ...patch } as never)!;

let renderer: ReactTestRenderer;
const navigation = { openAgent: vi.fn(), openWorkspace: vi.fn() };
const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const texts = (root: ReactTestInstance) => root.findAll(node => is(node, "Text")).flatMap(node => node.children).filter((child): child is string => typeof child === "string");
const labels = (root: ReactTestInstance) => root.findAll(node => is(node, "Pressable") && typeof node.props.accessibilityLabel === "string").map(node => node.props.accessibilityLabel as string);
const press = (root: ReactTestInstance, label: string | RegExp) => act(async () => {
  root.find(node => is(node, "Pressable") && (typeof label === "string" ? node.props.accessibilityLabel === label : label.test(node.props.accessibilityLabel ?? ""))).props.onPress();
});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const calls = (method: string) => host.calls.filter(call => call.method === method).map(call => call.input);
async function mount(services: { directory: AgentDirectory; quick: QuickStore }, params: Record<string, string> = {}) {
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NotesSurface, { theme, host: { id: "srv-1", label: "测试主机" }, layout: { compact: false, platform: "web" }, navigation, services, params } as never)), { unstable_isConcurrent: true } as never);
  });
  await advance(0);
  return renderer.root;
}

environmentManager.setIsServer(() => false);
notifyManager.setScheduler(queueMicrotask);
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
  vi.useFakeTimers({ now: Date.parse("2026-10-15T08:33:00.000Z") });
  host.appState.currentState = "active"; host.calls.length = 0; host.handlers.clear(); host.toasts.length = 0; navigation.openAgent.mockReset();
  serverBoard = { projectId: "prj_git", revision: 1, items: [note({})] };
  host.handlers.set("project-notes.dashboard", async input => dashboard(input));
  host.handlers.set("project-notes.launches", async input => input.itemId
    ? { revision: "r-item", records: [{ launchId: "launch-0001", itemId: taskId, stage: "started", workspaceId: "ws-1", agentId: "agent-1", error: null, at: now }], agents: [] }
    : input.revision === "r-1" ? { unchanged: true, revision: "r-1" } : { revision: "r-1", records: [{ launchId: "launch-0001", itemId: taskId, stage: "started", workspaceId: "ws-1", agentId: "agent-1", error: null, at: now }] });
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.useRealTimers(); });

describe("task cards follow the agents their notes started", () => {
  it("shows the live state with sub-agents and last activity, opens the agent, and turns grey once it is archived", async () => {
    const live = fakeDirectory([lite({}), lite({ id: "child-1", labels: { "paseo.parent-agent-id": "agent-1" } })]);
    const root = await mount({ directory: live.directory, quick: fakeQuick([]) });
    expect(texts(root)).toContain("运行中");
    expect(texts(root)).toContain("1 个子 Agent·3 分钟前");
    // One records read for the whole board; never a timeline or a per-agent read.
    expect(calls("project-notes.launches")).toEqual([{}]);
    expect(host.calls.map(call => call.method).filter(method => !["project-notes.dashboard", "project-notes.launches"].includes(method))).toEqual([]);
    await press(root, /^打开 Agent（运行中/);
    expect(navigation.openAgent).toHaveBeenCalledWith({ agentId: "agent-1", serverId: "srv-1" });
    // The agent waits for an approval: amber 等你处理.
    await live.change(lite({ pendingPermissions: [{ id: "perm-1" }] }));
    expect(texts(root)).toContain("等你处理");
    // Done but not looked at yet: green 完成未读.
    await live.change(lite({ status: "idle", requiresAttention: true, attentionReason: "finished" }));
    expect(texts(root)).toContain("完成未读");
    // Archived: the directory drops it, the record still names it.
    await live.change({ remove: "agent-1" });
    expect(texts(root)).toContain("已结束");
    expect(labels(root).some(label => label.startsWith("打开 Agent"))).toBe(false);
  });

  it("stops following the directory in the background", async () => {
    const live = fakeDirectory([lite({})]);
    const root = await mount({ directory: live.directory, quick: fakeQuick([]) });
    await act(async () => host.appState.set("background"));
    await live.change(lite({ status: "error" }));
    expect(texts(root)).not.toContain("出错");
    await act(async () => host.appState.set("active"));
    await advance(0);
    expect(texts(root)).toContain("出错");
  });

  it("lists every launch of the note in its detail", async () => {
    const live = fakeDirectory([lite({})]);
    const root = await mount({ directory: live.directory, quick: fakeQuick([]) });
    await press(root, "修复登录超时");
    await advance(0);
    expect(calls("project-notes.launches")).toContainEqual({ itemId: taskId });
    expect(texts(root)).toContain("启动记录 · 1");
    await press(root, "打开 Agent（运行中）");
    expect(navigation.openAgent).toHaveBeenCalledWith({ agentId: "agent-1", serverId: "srv-1" });
  });
});

describe("one-tap prompts on the board", () => {
  const prompt = (patch: Partial<BoardItem> = {}) => note({ id: promptId, kind: "prompt", title: "跑测试并修复", body: "运行全部测试，修好失败的用例。", ...patch });
  const entry = (patch: Partial<QuickEntry> = {}): QuickEntry => ({ projectId: "prj_git", itemId: promptId, label: "跑测试并修复", template: false, hidden: false, revision: 1, ...patch });
  const saving = () => host.handlers.set("settings.quick-prompts.write", async input => ({ status: "saved", revision: "rev-q2", values: input.values }));

  it("adds a prompt from its detail and shows the list above the prompts", async () => {
    serverBoard = { projectId: "prj_git", revision: 1, items: [prompt()] };
    saving();
    const root = await mount({ directory: fakeDirectory([]).directory, quick: fakeQuick([]) }, { view: "quick" });
    // Opened from the pill's 「管理一键发送…」: the prompts with the manager open.
    expect(texts(root)).toContain("还没有一键发送的提示词");
    await press(root, "管理一键发送，当前 0 条");
    await press(root, "跑测试并修复");
    await press(root, "一键发送");
    expect(calls("settings.quick-prompts.write")).toEqual([{ revision: "rev-q1", values: { prompts: [entry()] } }]);
    expect(host.toasts).toContain("已加入一键发送");
    expect(labels(root)).toContain("一键发送已开");
    expect(texts(root)).toContain("已显示在每个 Agent 的输入框上方，点按即发；会打断回合或取消审批时先问你。");
  });

  it("moves and removes entries in the manager, and asks to fill in a prompt with variables", async () => {
    serverBoard = { projectId: "prj_git", revision: 1, items: [prompt(), prompt({ id: otherId, title: "检查分支", body: "检查 {{分支}} 的改动" })] };
    saving();
    const quick = fakeQuick([entry(), entry({ itemId: otherId, label: "检查分支", template: true })]);
    const root = await mount({ directory: fakeDirectory([]).directory, quick }, { view: "quick" });
    expect(texts(root)).toContain("含变量：先填写再发");
    await press(root, "下移「跑测试并修复」");
    expect(calls("settings.quick-prompts.write").at(-1)!.values.prompts.map((item: QuickEntry) => item.label)).toEqual(["检查分支", "跑测试并修复"]);
    await press(root, "取消一键发送「检查分支」");
    expect(calls("settings.quick-prompts.write").at(-1)).toEqual({ revision: "rev-q2", values: { prompts: [entry()] } });
  });

  it("follows a renamed or trashed note, but only from a newer copy of it", async () => {
    serverBoard = { projectId: "prj_git", revision: 3, items: [prompt({ revision: 3, title: "跑全部测试并修复" })] };
    saving();
    await mount({ directory: fakeDirectory([]).directory, quick: fakeQuick([entry()]) });
    expect(calls("settings.quick-prompts.write")).toEqual([{ revision: "rev-q1", values: { prompts: [entry({ label: "跑全部测试并修复", revision: 3 })] } }]);
    await act(async () => renderer.unmount());
    host.calls.length = 0;
    // An entry newer than this board's copy (another app just saved it) is left alone.
    await mount({ directory: fakeDirectory([]).directory, quick: fakeQuick([entry({ label: "别处刚改的标题", revision: 9 })]) });
    expect(calls("settings.quick-prompts.write")).toEqual([]);
  });
});
