import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
// Registration tests isolate catalog I/O; the i18n suite exercises the real locale store.
vi.mock("../client/i18n-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../client/i18n-client")>();
  const { translator } = await import("../shared/i18n");
  return { ...actual, createClientI18n: () => ({
    ready: async () => {}, isReady: () => true, translator, refresh: async () => {}, subscribe: () => () => {}, dispose() {},
    localized: (register: () => (() => void) | readonly (() => void)[]) => { const value = register(); return typeof value === "function" ? value : () => value.forEach(remove => remove()); },
  }) };
});
// The quick chunk (one-tap send, /notes capture) loads its real code with the first use; the views stay stubs.
const chunkLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../client/lazy-chunk", () => ({
  lazySurfaces: () => () => () => null,
  createChunkLoader: (client: unknown, options: { text?: unknown }) => ({ label: () => "", peek: () => undefined, load: async () => {
    chunkLoads.count++;
    return (await import("../quick-chunk.client")).default().createSurfaces(client as never, { text: options.text as never });
  } }),
}));
vi.mock("../client/board", () => ({ NotesSurface: () => null, NotesWorkspacePanel: () => null }));
vi.mock("../client/composer", () => ({ PromptScreen: () => null, PromptPopover: () => null }));
vi.mock("../client/kit", () => ({ hue: () => "#8833dd" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
// The window: wide unless a test turns it into a phone; `turn` stands for rotation or a resized window.
const screen = vi.hoisted(() => ({ width: 1280, listeners: new Set<() => void>(), turn(width: number) { screen.width = width; for (const listener of screen.listeners) listener(); } }));
vi.mock("react-native", () => ({ Dimensions: { get: () => ({ width: screen.width, height: 800 }), addEventListener: (_: string, listener: () => void) => { screen.listeners.add(listener); return { remove: () => screen.listeners.delete(listener) }; } } }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, useToast: () => ({ show: vi.fn() }) }));
import contribute from "../index.client";
import { contributePromptPills } from "../client/composer-pills";
import { onComposerNotice } from "../client/composer-notice";
import { createAgentDirectory } from "../client/agent-directory";
import { createQuickStore } from "../client/quick-store";
import { createQuickSender } from "../client/quick-send";

function host() {
  let observer: any;
  const unsubscribe = vi.fn(), release = vi.fn(async () => {});
  const subscription = { subscribe: vi.fn(value => { observer = value; return unsubscribe; }), release };
  const list = vi.fn(async () => ({ entries: [{ agent: { id: "agent-1", workspaceId: "workspace-1", status: "closed" } }], subscription }));
  const pills: any[] = [], slashes: any[] = [], screens: any[] = [];
  const removers: ReturnType<typeof vi.fn>[] = [];
  const removal = () => { const remove = vi.fn(); removers.push(remove); return remove; };
  const client = {
    paseo: { agents: { list } }, rpc: vi.fn(async (..._args: unknown[]) => ({})),
    addScreen: vi.fn(screen => { screens.push({ ...screen, title: typeof screen.title === "function" ? screen.title({}) : screen.title }); return removal(); }), addSurface: vi.fn(removal), addSidebarHeaderItem: vi.fn(removal), addSidebarItem: vi.fn(removal),
    addWorkspacePanel: vi.fn(removal), addCommandCenterItem: vi.fn(removal), addAttachmentSource: vi.fn(removal),
    addSlashCommand: vi.fn(command => { slashes.push(command); return removal(); }),
    addComposerPill: vi.fn(pill => { const registration = { update: vi.fn(), remove: vi.fn() }; pills.push({ ...pill, registration }); return registration; }),
  };
  return { client, pills, slashes, screens, removers, observer: () => observer, unsubscribe, release, subscription };
}
describe("composer contributions", () => {
  it("registers named screens and preserves the legacy registration path", async () => {
    const modern = host(); const stop = contribute(modern.client as unknown as PluginClientContext);
    await Promise.resolve();
    expect(modern.screens.map(screen => [screen.id, screen.title])).toEqual([["notes", "拾页 · 项目手记"], ["prompts", "拾页 · 提示词库"]]);
    expect(modern.client.addSurface).not.toHaveBeenCalled();
    expect(modern.client.addSidebarHeaderItem).toHaveBeenCalledTimes(1);
    expect(modern.client.addAttachmentSource).toHaveBeenCalledTimes(1);
    stop(); stop();
    expect(modern.removers).toHaveLength(9);
    for (const remove of modern.removers) expect(remove).toHaveBeenCalledTimes(1);
    const legacy = host();
    Object.assign(legacy.client, { addScreen: undefined, addSidebarHeaderItem: undefined, addAttachmentSource: undefined, addComposerPill: undefined });
    contribute(legacy.client as unknown as PluginClientContext)();
    expect(legacy.client.addSurface).toHaveBeenCalledTimes(2);
    expect(legacy.client.addSidebarItem).toHaveBeenCalledTimes(1);
    expect(legacy.removers).toHaveLength(8);
    for (const remove of legacy.removers) expect(remove).toHaveBeenCalledTimes(1);
  });
  it("releases the remaining registrations even if one remover throws", async () => {
    const h = host(), stop = contribute(h.client as unknown as PluginClientContext);
    await Promise.resolve();
    h.removers.at(-1)!.mockImplementation(() => { throw new Error("release failed"); });
    expect(stop).toThrow("卸载未完整完成");
    for (const remove of h.removers) expect(remove).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    stop();
  });
  it("opens /prompt without sending and saves /notes text as an inbox idea without navigation", async () => {
    const h = host(), stop = contribute(h.client as unknown as PluginClientContext);
    const context = { ...h.client, args: "评审", agent: { id: "agent-1" }, openScreen: vi.fn(), openPanel: vi.fn() };
    await h.slashes.find(command => command.name === "prompt").onSubmit(context);
    expect(context.openScreen).toHaveBeenCalledWith({ screenId: "prompts", params: { agentId: "agent-1", query: "评审" } });
    // Only the one-tap prompt list is read at start (no events in this host, so at once); /prompt itself calls nothing.
    expect(h.client.rpc.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["settings.quick-prompts.read"]);
    h.client.rpc.mockClear();
    const toast = vi.fn(), removeNotice = onComposerNotice(h.client.paseo, toast);
    // Registration loaded nothing; the capture brings the quick chunk (its contracts and schemas) with it.
    expect(chunkLoads.count).toBe(0);
    await h.slashes.find(command => command.name === "notes").onSubmit({ ...context, args: "重做搜索体验\n保留筛选条件" });
    expect(chunkLoads.count).toBe(1);
    expect(h.client.rpc.mock.calls[0]![1]).toMatchObject({ projectId: "__inbox__", operation: { type: "create", fields: { kind: "idea", title: "重做搜索体验", body: "重做搜索体验\n保留筛选条件" } } });
    expect(context.openPanel).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("已记到随手记");
    await h.slashes.find(command => command.name === "notes").onSubmit({ ...context, args: "  " });
    expect(context.openPanel).toHaveBeenCalledWith("project-notes");
    removeNotice(); stop();
  });
  const services = (h: ReturnType<typeof host>) => ({ directory: createAgentDirectory(h.client.paseo as never), quick: createQuickStore(h.client as never) });
  const noActions = () => Promise.reject(new Error("not loaded in this test"));
  it("registers pills without reading notes or timelines and reconciles removals and workspace changes", async () => {
    const h = host(), shared = services(h), stop = contributePromptPills(h.client as unknown as PluginClientContext, () => null, shared, noActions);
    await Promise.resolve();
    expect(h.pills).toHaveLength(1);
    expect(h.pills[0].button.behavior.kind).toBe("popover");
    // No notes and no timelines: only the (empty) one-tap list.
    expect(h.client.rpc.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["settings.quick-prompts.read"]);
    h.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "agent-1", workspaceId: "workspace-1" } } });
    expect(h.pills).toHaveLength(1);
    h.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "agent-1", workspaceId: "workspace-2" } } });
    expect(h.pills[0].registration.remove).toHaveBeenCalledTimes(1);
    expect(h.pills).toHaveLength(2);
    h.observer().snapshot({ entries: [] });
    await Promise.resolve();
    expect(h.pills[1].registration.remove).toHaveBeenCalledTimes(1);
    stop(); shared.directory.dispose(); shared.quick.dispose();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("reads subsequent metadata pages and preserves an update that arrives during pagination", async () => {
    const h = host();
    let nextPage!: (value: unknown) => void;
    h.client.paseo.agents.list
      .mockResolvedValueOnce({ entries: [{ agent: { id: "agent-1", workspaceId: "workspace-1" } }], pageInfo: { hasMore: true, nextCursor: "page-2" }, subscription: h.subscription } as never)
      .mockReturnValueOnce(new Promise(resolve => { nextPage = resolve; }) as never);
    const shared = services(h), stop = contributePromptPills(h.client as unknown as PluginClientContext, () => null, shared, noActions);
    await Promise.resolve();
    h.observer().update({ type: "agent_update", payload: { kind: "remove", agentId: "agent-1" } });
    nextPage({ entries: [{ agent: { id: "agent-2", workspaceId: "workspace-2" } }], pageInfo: { hasMore: false } });
    await Promise.resolve(); await Promise.resolve();
    expect(h.pills.find(pill => pill.agentId === "agent-2")).toBeDefined();
    // The removal is newer than the pages: agent-1 never gets a pill (no flash of a pill that goes at once).
    expect(h.pills.find(pill => pill.agentId === "agent-1")).toBeUndefined();
    stop(); shared.directory.dispose(); shared.quick.dispose();
  });
  it("loads the send with the first press, and says nothing went out when it cannot load", async () => {
    const h = host(), calls: string[] = [];
    h.client.rpc.mockImplementation(async (contract: unknown) => {
      const name = (contract as { name: string }).name;
      calls.push(name);
      if (name === "settings.quick-prompts.read") return { status: "ready", revision: "r1", values: { prompts: [{ projectId: "prj", itemId: "00000000-0000-4000-8000-000000000001", label: "继续", template: false, hidden: false, revision: 1 }] } };
      if (name === "project-notes.composer.capabilities") return { steerableProviders: [], slashSteerableProviders: [] };
      return { status: "sent", message: "已发送「继续」" };
    });
    let loads = 0, broken = true;
    const quickSend = createQuickSender(input => h.client.rpc({ name: "project-notes.quick.send" }, input) as never);
    const actions = async () => { loads++; await Promise.resolve(); if (broken) throw new Error("offline"); return { quickSend, captureNote: async () => undefined }; };
    const shared = services(h), stop = contributePromptPills(h.client as unknown as PluginClientContext, () => null, shared, actions);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const pill = h.pills.find(entry => entry.id === "quick-00000000-0000-4000-8000-000000000001");
    expect(pill?.button.behavior.kind).toBe("action");
    // Registering read the list and the capabilities only: the send half is not loaded yet.
    expect(loads).toBe(0);
    await expect(pill.button.behavior.onPress()).rejects.toThrow("「继续」没有发出：offline");
    expect(calls).not.toContain("project-notes.quick.send");
    broken = false;
    await pill.button.behavior.onPress();
    expect(loads).toBe(2);
    expect(calls.filter(name => name === "project-notes.quick.send")).toHaveLength(1);
    stop(); shared.directory.dispose(); shared.quick.dispose();
  });
  it("folds the one-tap pills into one menu pill on a phone-wide window and follows rotation, the library pill untouched", async () => {
    const h = host();
    h.client.rpc.mockImplementation(async (contract: unknown) => {
      const name = (contract as { name: string }).name;
      if (name === "settings.quick-prompts.read") return { status: "ready", revision: "r1", values: { prompts: [1, 2].map(n => ({ projectId: "prj", itemId: `00000000-0000-4000-8000-00000000000${n}`, label: `提示词 ${n}`, template: false, hidden: false, revision: 1 })) } };
      return { steerableProviders: [], slashSteerableProviders: [] };
    });
    screen.width = 390;
    const shared = services(h), stop = contributePromptPills(h.client as unknown as PluginClientContext, () => null, shared, noActions);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const live = () => h.pills.filter(pill => !pill.registration.remove.mock.calls.length).map(pill => pill.id);
    // Never two separate pills first: the width is known before the first registration.
    expect(h.pills.map(pill => pill.id)).toEqual(["note-prompts", "quick-menu"]);
    // A 900 px window with the sidebar leaves the composer about 550 px: still folded. 1280 px: separate pills.
    screen.turn(900);
    expect(live()).toEqual(["note-prompts", "quick-menu"]);
    screen.turn(1280);
    expect(live()).toEqual(["note-prompts", "quick-00000000-0000-4000-8000-000000000001", "quick-00000000-0000-4000-8000-000000000002"]);
    screen.turn(390);
    expect(live()).toEqual(["note-prompts", "quick-menu"]);
    expect(h.pills[0].registration.remove).not.toHaveBeenCalled();
    stop(); shared.directory.dispose(); shared.quick.dispose();
    expect(screen.listeners.size).toBe(0);
    screen.width = 1280;
  });
});
