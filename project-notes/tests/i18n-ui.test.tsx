import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider, environmentManager, notifyManager } from "@tanstack/react-query";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { BoardItem } from "../shared/board";
import { bindTranslator, createTranslator } from "../shared/i18n";
import { BUILTIN_CATALOGS } from "../server/locales";
import { noteContext, notesDeferred } from "../shared/composer";
import { notePromptKey, promptKey } from "../client/deferred-state";
import { serverCheck } from "../client/composer-send";
import type { DeferredView } from "../shared/deferred-rpc";

// Use the real views and RPC schemas; only the Paseo host primitives and transport are replaced.
const host = vi.hoisted(() => ({
  handlers: new Map<string, (input: any) => Promise<unknown>>(),
  calls: [] as { method: string; input: any }[], copies: [] as string[], toasts: [] as string[], refresh: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", Platform: { OS: "web" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  useWindowDimensions: () => ({ width: 1120, height: 760 }),
}));
vi.mock("@getpaseo/plugin/client", () => {
  const cache = new Map<string, unknown>();
  return {
    useWorkspace: () => null,
    usePaseo: () => ({ agents: { ref: () => ({ refresh: host.refresh }) } }),
    useRpc: (contract: PluginRpcContract) => {
      if (!cache.has(contract.name)) cache.set(contract.name, async (input: unknown) => {
        const parsed = await contract.input.parseAsync(input);
        host.calls.push({ method: contract.name, input: parsed });
        const handler = host.handlers.get(contract.name);
        if (!handler) throw new Error(`Unexpected RPC ${contract.name}`);
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
  return { Icon: "Icon", Modal, FlatList, ScrollView: "ScrollView", TextInput: "TextInput", copyText: async (text: string) => { host.copies.push(text); }, useToast: () => ({ show: (message: string) => host.toasts.push(message) }) };
});
vi.mock("../client/web", () => ({ findComposerDraft: () => null }));
vi.mock("../client/motion", () => ({ Breathe: ({ children }: { children: unknown }) => children, Flash: () => null, useChangeCount: () => 0 }));

// These imports deliberately happen before beforeEach binds English, catching frozen translated constants.
const { NotesSurface } = await import("../client/board");
const { PromptPicker } = await import("../client/composer");
const { LaunchDialog } = await import("../client/launch");
const theme = { colors: Object.fromEntries(["surface0", "surface1", "surface2", "border", "foreground", "foregroundMuted", "accent", "accentForeground", "statusSuccess", "statusWarning", "statusDanger"].map(key => [key, "#222222"])) } as never;
const props = { theme, host: { id: "i18n-host", label: "English host" }, layout: { compact: false, platform: "web" as const } };
const project = { id: "prj_i18n", name: "用户项目", path: "/repo/i18n", kind: "git" };
const note: BoardItem = { id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", projectId: project.id, revision: 1, kind: "task", title: "用户原始标题", body: "用户原始正文", status: "todo", priority: "normal", pinned: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", deletedAt: null };
const prompt = { ...note, kind: "prompt" as const, title: "Review plan", body: "请检查 {{项目}} 的实现", projectName: project.name };
let renderer: ReactTestRenderer | undefined, client: QueryClient;
const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const texts = () => renderer!.root.findAll(node => is(node, "Text")).flatMap(node => node.children).filter((child): child is string => typeof child === "string");
const buttons = () => renderer!.root.findAll(node => is(node, "Pressable")).map(node => node.props.accessibilityLabel);
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const press = (label: string) => act(async () => renderer!.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === label).props.onPress());
const fill = (label: string, value: string) => act(async () => renderer!.root.find(node => is(node, "TextInput") && node.props.accessibilityLabel === label).props.onChangeText(value));
async function mount(element: ReactNode) {
  client = new QueryClient();
  await act(async () => { renderer = create(createElement(QueryClientProvider, { client }, element)); });
  await advance();
}

environmentManager.setIsServer(() => false);
notifyManager.setScheduler(queueMicrotask);
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
  vi.useFakeTimers();
  bindTranslator(createTranslator("en", BUILTIN_CATALOGS.en));
  host.handlers.clear(); host.calls.length = 0; host.copies.length = 0; host.toasts.length = 0;
  host.refresh.mockResolvedValue({ agent: { id: "agent-i18n", provider: "example-provider", status: "running", activeTurn: { turnId: "turn-i18n" }, pendingPermissions: [], archivedAt: null } });
  host.handlers.set("project-notes.dashboard", async () => ({ projects: [project], boards: [{ projectId: project.id, revision: 1, items: [note] }] }));
  host.handlers.set("project-notes.composer.search", async () => ({ items: [prompt], unavailable: 0, truncated: false }));
  host.handlers.set("project-notes.composer.capabilities", async () => ({ steerableProviders: [], slashSteerableProviders: [] }));
  host.handlers.set("project-notes.deferred.list", async () => []);
  host.handlers.set("project-notes.launch-options", async () => ({ projects: [project], project, providers: [{ id: "claude", label: "Claude", status: "ready", error: null, models: [{ id: "default", label: "Default model", isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null }], modes: [], defaultModeId: null }], profiles: [] }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined; client?.clear();
  bindTranslator(createTranslator("zh-CN", BUILTIN_CATALOGS["zh-CN"]));
  vi.useRealTimers();
});

describe("English views", () => {
  it("renders board actions and editor labels in English while preserving user content", async () => {
    await mount(createElement(NotesSurface, props));
    expect(buttons()).toEqual(expect.arrayContaining(["New task", "Filter project: All projects", "用户原始标题: Move to In progress"]));
    expect(texts()).toContain("用户原始标题");
    expect(texts()).toContain("To do");
    await press("New task");
    expect(buttons()).toContain("Save");
    expect(texts()).toEqual(expect.arrayContaining(["Title", "Body"]));
    expect(renderer!.root.find(node => is(node, "Modal")).props.title).toBe("New task");
  });

  it("selects an English prompt action and copies user-written variables verbatim", async () => {
    await mount(createElement(PromptPicker, props));
    expect(texts()).toContain("Prompt library");
    expect(texts()).toContain("用户项目 · 1 variable");
    await press("Choose prompt: Review plan");
    expect(texts()).toContain("Preview prompt");
    const copy = () => renderer!.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "Copy to clipboard");
    expect(copy().props.disabled).toBe(true);
    await fill("Variable: 项目", "示例应用");
    expect(copy().props.disabled).toBe(false);
    await press("Copy to clipboard");
    expect(host.copies).toEqual(["请检查 示例应用 的实现"]);
    expect(host.toasts).toEqual(["Copied. Paste into the composer to keep editing."]);
  });

  it("explains interruption and the wait option in English before any prompt is sent", async () => {
    await mount(createElement(PromptPicker, { ...props, agentId: "agent-i18n" }));
    await press("Choose prompt: Review plan");
    await fill("Variable: 项目", "示例应用");
    await press("Send to current agent");
    expect(buttons()).toEqual(expect.arrayContaining(["Interrupt and send", "Send when this turn ends", "Cancel send"]));
    expect(texts().join("\n")).toContain("interrupt");
    expect(host.calls.some(call => call.method === "project-notes.deferred.send")).toBe(false);
    // The kit takes translated message nouns up to SEND_NOUN_LIMIT (80) code units.
    const input = { agentId: "agent-i18n", text: "Prompt", messageId: "message-i18n", what: "prompt" };
    expect(notesDeferred.send.input.safeParse(input).success).toBe(true);
    expect(notesDeferred.send.input.safeParse({ ...input, what: "Eingabeaufforderung" }).success).toBe(true);
    const tooLong = notesDeferred.send.input.safeParse({ ...input, what: "x".repeat(81) });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) expect(tooLong.error.issues.map(issue => issue.path)).toEqual([["what"]]);
  });

  it("renders launch progress in the language bound after the module loaded", async () => {
    const receipt = { launchId: "", stage: "prepared", workspaceId: null, agentId: null, error: null, replayed: false };
    host.handlers.set("project-notes.launch", async input => ({ ...receipt, launchId: input.launchId }));
    host.handlers.set("project-notes.launch-status", async input => ({ ...receipt, launchId: input.launchId }));
    await mount(createElement(LaunchDialog, { ...props, item: note, open: true, onOpenChange: vi.fn() }));
    expect(renderer!.root.find(node => is(node, "Modal")).props.title).toBe("Start task");
    expect(texts()).toEqual(expect.arrayContaining(["Workspace title", "Initial task"]));
    await press("Create workspace and start");
    await advance();
    expect(texts()).toContain("Launch request confirmed");
    expect(buttons()).toEqual(expect.arrayContaining(["Check status", "Copy IDs"]));
    expect(host.calls.find(call => call.method === "project-notes.launch")!.input).toMatchObject({ title: note.title, prompt: `${note.title}\n\n${note.body}` });
  });

  it("sends a custom language with a long prompt noun as the confirmation's message name", async () => {
    const translator = createTranslator("de", [{ composer: { prompt: "Eingabeaufforderung" }, kitSend: { message: "Nachricht" } }, ...BUILTIN_CATALOGS.en]);
    bindTranslator(translator);
    host.refresh.mockResolvedValue({ agent: { id: "agent-i18n", provider: "example-provider", status: "idle", pendingPermissions: [], archivedAt: null } });
    host.handlers.set("project-notes.deferred.send", async input => ({ status: "sent", view: { messageId: input.messageId, agentId: input.agentId, key: input.key, source: input.source, preview: input.text, createdAt: Date.now(), at: Date.now(), state: "sent", note: "" } }));
    await mount(createElement(PromptPicker, { ...props, agentId: "agent-i18n" }));
    await press("Choose prompt: Review plan");
    await fill("Variable: 项目", "示例应用");
    await press("Send to current agent");
    await advance();
    const sends = host.calls.filter(call => call.method === "project-notes.deferred.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.input).toHaveProperty("what", "Eingabeaufforderung");
    expect(translator.t("composer.prompt")).toBe("Eingabeaufforderung");
    expect(host.toasts).toContain("Prompt sent");
    expect(texts()).toContain("Prompt sent.");
  });

  it("keeps a queued prompt locked across Chinese, English and a reordered custom provenance message", async () => {
    const body = "请检查 示例应用 的实现";
    bindTranslator(createTranslator("zh-CN", BUILTIN_CATALOGS["zh-CN"]));
    const legacyKey = promptKey(noteContext(prompt, body));
    expect(notePromptKey(prompt, body)).toBe(legacyKey);
    const queued: DeferredView[] = [];
    host.handlers.set("project-notes.deferred.list", async () => queued);
    host.handlers.set("project-notes.deferred.enqueue", async input => {
      const view: DeferredView = { messageId: input.messageId, agentId: input.agentId, key: input.key, source: input.source, preview: input.text, createdAt: Date.now(), at: Date.now(), state: "queued", note: "" };
      queued.push(view);
      return view;
    });
    await mount(createElement(PromptPicker, { ...props, agentId: "agent-i18n" }));
    await press("选择提示词：Review plan");
    await fill("变量：项目", "示例应用");
    await press("发送给当前 Agent");
    await press("等这一轮结束再发");
    await advance();
    expect(queued[0]!.key).toBe(legacyKey);
    await act(async () => renderer?.unmount()); renderer = undefined; client.clear();

    for (const language of ["en", "ko"]) {
      const layers = language === "ko" ? [{ composer: { noteContext: "{body}\n{title}\n출처 #{id}" } }, ...BUILTIN_CATALOGS.en] : BUILTIN_CATALOGS.en;
      bindTranslator(createTranslator(language, layers));
      expect(promptKey(noteContext(prompt, body))).not.toBe(legacyKey);
      expect(notePromptKey(prompt, body)).toBe(legacyKey);
      await mount(createElement(PromptPicker, { ...props, agentId: "agent-i18n" }));
      await press("Choose prompt: Review plan");
      await fill("Variable: 项目", "示例应用");
      expect(buttons()).toContain("Queued");
      expect(buttons()).not.toContain("Send to current agent");
      await act(async () => renderer?.unmount()); renderer = undefined; client.clear();
    }
    expect(host.calls.filter(call => call.method === "project-notes.deferred.enqueue")).toHaveLength(1);
    const confirmed = serverCheck({ text: "Original sent text", messageId: "message-i18n", key: legacyKey }, { status: "confirm", plan: { label: "Send anyway", note: "Needs approval", confirm: "Send?" }, consent: { interrupt: false, approvals: [] } });
    expect(confirmed).toMatchObject({ key: legacyKey, text: "Original sent text", messageId: "message-i18n" });
  });
});
