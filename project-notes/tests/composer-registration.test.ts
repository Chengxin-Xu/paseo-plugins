import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
vi.mock("../client/lazy-chunk", () => ({ lazySurfaces: () => () => () => null }));
vi.mock("../client/board", () => ({ NotesSurface: () => null, NotesWorkspacePanel: () => null }));
vi.mock("../client/composer", () => ({ PromptScreen: () => null, PromptPopover: () => null }));
vi.mock("../client/kit", () => ({ hue: () => "#8833dd" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, useToast: () => ({ show: vi.fn() }) }));
import contribute from "../index.client";
import { contributePromptPills } from "../client/composer-pills";
import { onComposerNotice } from "../client/composer-notice";

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
    addScreen: vi.fn(screen => { screens.push(screen); return removal(); }), addSurface: vi.fn(removal), addSidebarHeaderItem: vi.fn(removal), addSidebarItem: vi.fn(removal),
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
    expect(h.client.rpc).not.toHaveBeenCalled();
    const toast = vi.fn(), removeNotice = onComposerNotice(h.client.paseo, toast);
    await h.slashes.find(command => command.name === "notes").onSubmit({ ...context, args: "重做搜索体验\n保留筛选条件" });
    expect(h.client.rpc.mock.calls[0]![1]).toMatchObject({ projectId: "__inbox__", operation: { type: "create", fields: { kind: "idea", title: "重做搜索体验", body: "重做搜索体验\n保留筛选条件" } } });
    expect(context.openPanel).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("已记到随手记");
    await h.slashes.find(command => command.name === "notes").onSubmit({ ...context, args: "  " });
    expect(context.openPanel).toHaveBeenCalledWith("project-notes");
    removeNotice(); stop();
  });
  it("registers pills without reading notes or timelines and reconciles removals and workspace changes", async () => {
    const h = host(), stop = contributePromptPills(h.client as unknown as PluginClientContext, () => null);
    await Promise.resolve();
    expect(h.pills).toHaveLength(1);
    expect(h.pills[0].button.behavior.kind).toBe("popover");
    expect(h.client.rpc).not.toHaveBeenCalled();
    h.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "agent-1", workspaceId: "workspace-1" } } });
    expect(h.pills).toHaveLength(1);
    h.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "agent-1", workspaceId: "workspace-2" } } });
    expect(h.pills[0].registration.remove).toHaveBeenCalledTimes(1);
    expect(h.pills).toHaveLength(2);
    h.observer().snapshot({ entries: [] });
    expect(h.pills[1].registration.remove).toHaveBeenCalledTimes(1);
    stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("reads subsequent metadata pages and preserves an update that arrives during pagination", async () => {
    const h = host();
    let nextPage!: (value: unknown) => void;
    h.client.paseo.agents.list
      .mockResolvedValueOnce({ entries: [{ agent: { id: "agent-1", workspaceId: "workspace-1" } }], pageInfo: { hasMore: true, nextCursor: "page-2" }, subscription: h.subscription } as never)
      .mockReturnValueOnce(new Promise(resolve => { nextPage = resolve; }) as never);
    const stop = contributePromptPills(h.client as unknown as PluginClientContext, () => null);
    await Promise.resolve();
    h.observer().update({ type: "agent_update", payload: { kind: "remove", agentId: "agent-1" } });
    nextPage({ entries: [{ agent: { id: "agent-2", workspaceId: "workspace-2" } }], pageInfo: { hasMore: false } });
    await Promise.resolve(); await Promise.resolve();
    expect(h.pills.find(pill => pill.agentId === "agent-2")).toBeDefined();
    expect(h.pills.find(pill => pill.agentId === "agent-1")?.registration.remove).toHaveBeenCalledTimes(1);
    stop();
  });
});
