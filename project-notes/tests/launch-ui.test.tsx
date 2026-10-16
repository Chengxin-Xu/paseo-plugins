import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider, environmentManager, notifyManager } from "@tanstack/react-query";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { BoardItem } from "../shared/board";
import type { LaunchInput, LaunchReceipt } from "../shared/launch";

const host = vi.hoisted(() => ({ handlers: new Map<string, (input: any) => Promise<unknown>>(), calls: [] as { method: string; input: any }[] }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", Platform: { OS: "web" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
// Launch status dots animate with the kit's motion (Animated); here only what the marks wrap matters.
vi.mock("../client/motion", () => ({ Ping: () => null, Breathe: ({ children }: { children: unknown }) => children, Flash: () => null, useChangeCount: () => 0 }));
vi.mock("@getpaseo/plugin/client", () => {
  const cache = new Map<string, unknown>();
  return { useRpc: (contract: PluginRpcContract) => {
    if (!cache.has(contract.name)) cache.set(contract.name, async (input: unknown) => {
      const parsed = await contract.input.parseAsync(input);
      host.calls.push({ method: contract.name, input: parsed });
      const handler = host.handlers.get(contract.name); if (!handler) throw new Error(`unexpected ${contract.name}`);
      return contract.output.parseAsync(await handler(parsed));
    });
    return cache.get(contract.name);
  } };
});
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const { createElement: h } = await import("react");
  const Modal = Object.assign(({ open, children }: { open: boolean; children: ReactNode }) => open ? h("Modal", {}, children) : null, { Content: ({ children }: { children: ReactNode }) => children });
  return { Icon: "Icon", Modal, TextInput: "TextInput", copyText: vi.fn(), useToast: () => ({ show: vi.fn() }) };
});
const { LaunchDialog } = await import("../client/launch");
const theme = { colors: Object.fromEntries(["surface0", "surface1", "surface2", "border", "foreground", "foregroundMuted", "accent", "accentForeground", "statusSuccess", "statusWarning", "statusDanger"].map(key => [key, "#000"])) } as never;
const project = { id: "prj_demo", name: "示例项目", path: "/repo/demo", kind: "git" };
const now = "2026-10-12T00:00:00.000Z";
let sequence = 0, item: BoardItem, renderer: ReactTestRenderer, client: QueryClient;
const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const texts = () => renderer.root.findAll(node => is(node, "Text")).flatMap(node => node.children).filter((child): child is string => typeof child === "string");
const buttons = (label: string) => renderer.root.findAll(node => is(node, "Pressable") && node.props.accessibilityLabel === label);
const field = (label: string) => renderer.root.find(node => is(node, "TextInput") && node.props.accessibilityLabel === label);
const press = (label: string) => act(async () => { const button = buttons(label)[0]!; expect(button.props.disabled).not.toBe(true); button.props.onPress(); });
const change = (label: string, value: string) => act(async () => field(label).props.onChangeText(value));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const launches = () => host.calls.filter(call => call.method === "project-notes.launch");
const statuses = () => host.calls.filter(call => call.method === "project-notes.launch-status");
const receipt = (launchId: string, stage: LaunchReceipt["stage"] = "prepared"): LaunchReceipt => ({ launchId, stage, workspaceId: null, agentId: null, error: null, replayed: false });
const element = (open = true) => createElement(QueryClientProvider, { client }, createElement(LaunchDialog, { theme, host: { id: "test-host", label: "测试主机" }, layout: { compact: false, platform: "web" }, item, open, onOpenChange: vi.fn() } as never));
async function mount() { client = new QueryClient(); await act(async () => { renderer = create(element(), { unstable_isConcurrent: true } as never); }); await advance(0); }
async function update(open = true) { await act(async () => renderer.update(element(open))); await advance(0); }
async function remount() { await act(async () => renderer.unmount()); await mount(); }

environmentManager.setIsServer(() => false);
notifyManager.setScheduler(queueMicrotask);
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
  vi.useFakeTimers(); host.calls.length = 0; host.handlers.clear();
  item = { id: `00000000-0000-4000-8000-${(++sequence).toString().padStart(12, "0")}`, projectId: project.id, revision: 1, kind: "task", title: "原始标题", body: "原始任务", status: "todo", priority: "normal", pinned: false, createdAt: now, updatedAt: now, deletedAt: null };
  host.handlers.set("project-notes.launch-options", async () => ({ projects: [project], project, providers: [{ id: "claude", label: "Claude", status: "ready", error: null, models: [{ id: "default", label: "默认模型", isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null }], modes: [], defaultModeId: null }], profiles: [] }));
  host.handlers.set("project-notes.launch-status", async () => null);
});
afterEach(async () => { await act(async () => renderer?.unmount()); client?.clear(); vi.useRealTimers(); });

describe("launch request recovery", () => {
  it.each(["请求发送前断线", "写入启动记录前失败"])("replays the sealed input after %s, including after remount", async failure => {
    host.handlers.set("project-notes.launch", async () => { throw new Error(failure); });
    await mount();
    await change("工作区标题", "我的标题草稿"); await change("初始任务", "请先跑检查，再开始修改");
    await press("创建工作区并开始"); await advance(0);
    const original = launches()[0]!.input;
    expect(texts()).toContain("尚未查到启动记录");
    expect(buttons("重试这次请求")).toHaveLength(1);
    expect(buttons("修改选项重试")).toHaveLength(0);
    await advance(90_000);
    const bounded = statuses().length;
    expect(bounded).toBeLessThanOrEqual(5);
    await advance(90_000); expect(statuses()).toHaveLength(bounded);
    item = { ...item, revision: 2, title: "别处改过的标题", body: "别处改过的任务" };
    await remount();
    host.handlers.set("project-notes.launch", async input => receipt(input.launchId));
    await press("重试这次请求"); await advance(0);
    expect(launches()).toHaveLength(2);
    expect(launches()[1]!.input).toEqual(original);
    expect(texts()).toContain("启动请求已确认");
  });

  it("uses the same request even when the response and first status query are lost after acceptance", async () => {
    let accepted: LaunchReceipt | null = null, resources = 0;
    host.handlers.set("project-notes.launch", async (input: LaunchInput) => {
      if (!accepted) { accepted = { ...receipt(input.launchId, "started"), workspaceId: "wks_demo", agentId: "agent-demo" }; resources++; throw new Error("启动回包途中断线"); }
      expect(input).toEqual(launches()[0]!.input);
      return { ...accepted, replayed: true };
    });
    host.handlers.set("project-notes.launch-status", async () => { throw new Error("连接尚未恢复"); });
    await mount(); await press("创建工作区并开始"); await advance(0);
    expect(buttons("重试这次请求")).toHaveLength(1);
    await press("重试这次请求"); await advance(0);
    expect(resources).toBe(1); expect(launches()).toHaveLength(2);
    expect(texts()).toContain("任务已开始");
    expect(buttons("重试这次请求")).toHaveLength(0);
  });

  it("allows a new launch ID only after rejection without resource IDs", async () => {
    host.handlers.set("project-notes.launch", async input => ({ ...receipt(input.launchId, "rejected"), error: "本次启动未完成" }));
    await mount(); await press("创建工作区并开始"); await advance(0);
    const original = launches()[0]!.input;
    await remount();
    await press("修改选项重试"); await advance(0);
    await change("初始任务", "修改后的任务");
    await press("创建工作区并开始");
    expect(launches()[1]!.input.launchId).not.toBe(original.launchId);
    expect(launches()[1]!.input.prompt).toBe("修改后的任务");
  });

  it.each([{}, { workspaceId: "wks_demo" }, { agentId: "agent-demo" }])("keeps uncertain launches with $workspaceId$agentId in the check-existing-result flow", async identifiers => {
    host.handlers.set("project-notes.launch", async input => ({ ...receipt(input.launchId, "uncertain"), ...identifiers, error: "启动中断，请核对已有工作区" }));
    await mount(); await press("创建工作区并开始"); await advance(0);
    expect(buttons("重试这次请求")).toHaveLength(0);
    expect(buttons("修改选项重试")).toHaveLength(0);
    expect(buttons("查询状态")).toHaveLength(1);
    if (!Object.keys(identifiers).length) expect(texts()).toContain("尚未找回工作区或会话标识。请查询状态并核对侧栏；为避免重复创建，本次启动不能修改选项重试。");
    await remount();
    expect(buttons("修改选项重试")).toHaveLength(0);
  });

  it("keeps one launch ID while a status query recovers an uncertain workspace", async () => {
    host.handlers.set("project-notes.launch", async input => receipt(input.launchId, "uncertain"));
    await mount(); await press("创建工作区并开始"); await advance(0);
    expect(buttons("修改选项重试")).toHaveLength(0);
    host.handlers.set("project-notes.launch-status", async input => ({ ...receipt(input.launchId, "uncertain"), workspaceId: "wks_found" }));
    await press("查询状态"); await advance(0);
    expect(buttons("修改选项重试")).toHaveLength(0);
    expect(buttons("创建工作区并开始")).toHaveLength(0);
    expect(texts().join("\n")).toContain("wks_found");
    expect(launches()).toHaveLength(1);
  });

  it("explains which metadata accompanies the edited initial task", async () => {
    await mount();
    expect(texts()).toContain("确认后在 测试主机 新建工作区，发送下方任务，并附手记的项目、状态、重点、标识和标题。原手记不变。");
  });
});

describe("launch source draft protection", () => {
  it("preserves title and prompt drafts when another device changes only metadata", async () => {
    await mount(); await change("工作区标题", "本地标题"); await change("初始任务", "本地补充要求");
    item = { ...item, revision: 2, pinned: true, status: "doing", priority: "high" }; await update();
    expect(field("工作区标题").props.value).toBe("本地标题"); expect(field("初始任务").props.value).toBe("本地补充要求");
    expect(buttons("载入最新手记")).toHaveLength(0);
  });

  it("keeps local drafts across remote body changes and close/reopen until explicitly loaded", async () => {
    await mount(); await change("工作区标题", "保留这个标题"); await change("初始任务", "保留这个任务");
    item = { ...item, revision: 2, title: "远端标题", body: "远端任务" }; await update();
    expect(texts()).toContain("手记已更新，当前标题和任务草稿已保留。载入最新会替换这两项。");
    expect(field("工作区标题").props.value).toBe("保留这个标题"); expect(field("初始任务").props.value).toBe("保留这个任务");
    await update(false); await update(true);
    expect(field("初始任务").props.value).toBe("保留这个任务");
    await remount();
    expect(field("工作区标题").props.value).toBe("保留这个标题"); expect(field("初始任务").props.value).toBe("保留这个任务");
    await press("载入最新手记");
    expect(field("工作区标题").props.value).toBe("远端标题"); expect(field("初始任务").props.value).toBe("远端标题\n\n远端任务");
    expect(buttons("载入最新手记")).toHaveLength(0);
  });
});
