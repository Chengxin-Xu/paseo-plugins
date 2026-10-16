import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// These behavioral suites bind Chinese in setup; locale I/O and settings are covered by i18n.test.ts.
vi.mock("../server/i18n-server", () => ({ createLocaleService: () => ({ dispose() {}, ready: Promise.resolve() }) }));

import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginRpcContract } from "@getpaseo/plugin";
const host = vi.hoisted(() => ({ copies: [] as string[], toasts: [] as string[], send: vi.fn(async (..._args: unknown[]) => {}), refresh: vi.fn(), rpc: new Map<string, (input: any) => Promise<any>>(), draft: null as null | { read(): string | null; fill(text: string, previous: string, mode: string): unknown } }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", Platform: { OS: "web" }, StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390, height: 844 }), AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => ({ agents: { ref: () => ({ refresh: host.refresh, send: host.send }) } }), useRpc: (rpc: PluginRpcContract) => host.rpc.get(rpc.name) }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon", ScrollView: "ScrollView", Modal: "Modal", TextInput: "TextInput", copyText: async (text: string) => { host.copies.push(text); }, useToast: () => ({ show: (message: string) => host.toasts.push(message) }) }));
vi.mock("../client/web", () => ({ findComposerDraft: () => host.draft }));
// The queue rows' breathing and flash (kit motion) are drawn by Animated; here only what they wrap matters.
vi.mock("../client/motion", () => ({ Breathe: ({ children }: { children: unknown }) => children, Flash: () => null, useChangeCount: () => 0 }));
import { PromptPicker, PromptPopover, PromptScreen } from "../client/composer";
import { promptKey } from "../client/deferred-state";
import { noteContext } from "../shared/composer";

const theme = { colors: Object.fromEntries(["surface0", "surface1", "surface2", "border", "foreground", "foregroundMuted", "accent", "accentForeground"].map(key => [key, "#222222"])) } as never;
const note = { id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", projectId: "example", projectName: "示例项目", revision: 1, kind: "prompt", title: "评审方案", body: "请检查 {{项目}} 的实现", status: "todo", priority: "normal", pinned: false, createdAt: "2026-10-01", updatedAt: "2026-10-01", deletedAt: null };
let renderer: ReactTestRenderer;
const is = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
async function press(label: string) { await act(async () => renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === label).props.onPress()); }
async function fill(label: string, text: string) { await act(async () => renderer.root.find(node => is(node, "TextInput") && node.props.accessibilityLabel === label).props.onChangeText(text)); }
async function mount(presentation: "screen" | "popover" = "screen") {
  await act(async () => { renderer = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PromptPicker, { theme, host: { id: "host-1", label: "示例主机" }, layout: { compact: true, platform: "web" }, agentId: "agent-1", presentation }))); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
// The plugin server's ledger, faked: what it lists, and what it answers a send or a queueing with. The picker never
// calls the agent's own send (`host.send`): the server sends.
type View = { messageId: string; agentId: string; key: string; source: string; preview: string; createdAt: number; at: number; state: string; note: string };
let queue: View[] = [];
const calls: { name: string; input: any }[] = [];
/** Answers for the next sends, in order; by default a send goes out. */
let answers: ((input: any) => unknown)[] = [];
const record = (input: any, state: string, note = state): View => ({ messageId: input.messageId, agentId: input.agentId, key: input.key, source: input.source ?? "", preview: input.text.slice(0, 160), createdAt: Date.now(), at: Date.now(), state, note });
const keep = (view: View) => { queue = [view, ...queue.filter(entry => entry.messageId !== view.messageId)]; return view; };
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
  host.copies.length = 0; host.toasts.length = 0; host.send.mockReset(); host.rpc.clear(); host.draft = null;
  queue = []; calls.length = 0; answers = [];
  host.refresh.mockResolvedValue({ agent: { id: "agent-1", provider: "codex", status: "idle", pendingPermissions: [], archivedAt: null } });
  host.rpc.set("project-notes.composer.search", async () => ({ items: [note], unavailable: 0, truncated: false }));
  host.rpc.set("project-notes.composer.capabilities", async () => ({ steerableProviders: ["codex"], slashSteerableProviders: [] }));
  host.rpc.set("project-notes.deferred.list", async input => { calls.push({ name: "list", input }); return queue; });
  host.rpc.set("project-notes.deferred.send", async input => {
    calls.push({ name: "send", input });
    const answer = (answers.shift() ?? (() => ({ status: "sent", view: record(input, "sent", "已送达") })))(input) as { status: string; view?: View };
    if (answer instanceof Error) throw answer;
    if (answer.view) keep(answer.view);
    return answer;
  });
  host.rpc.set("project-notes.deferred.enqueue", async input => {
    calls.push({ name: "enqueue", input });
    const existing = queue.find(view => view.key === input.key && ["queued", "held", "sending"].includes(view.state));
    return existing ?? keep(record(input, "queued", "已排队，等 Agent 这一轮结束、没有待审批时自动发送"));
  });
  host.rpc.set("project-notes.deferred.cancel", async input => { calls.push({ name: "cancel", input }); return keep({ ...queue.find(view => view.messageId === input.messageId)!, state: "canceled", note: "已取消，没有发送" }); });
  host.rpc.set("project-notes.deferred.resume", async input => { calls.push({ name: "resume", input }); return keep({ ...queue.find(view => view.messageId === input.messageId)!, state: "queued" }); });
});
const sends = () => calls.filter(call => call.name === "send").map(call => call.input);
afterEach(async () => { await act(async () => renderer?.unmount()); });
describe("prompt picker", () => {
  const labels = () => renderer.root.findAll(node => is(node, "Pressable") && typeof node.props.accessibilityLabel === "string").map(node => node.props.accessibilityLabel as string);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  // The real server writes its ledger and takes a SQLite lock: under a loaded full run that can take more than one
  // short settle. Wait for what should happen (performance.now, since some tests freeze Date.now).
  const until = async (check: () => boolean, ms = 3_000) => { const end = performance.now() + ms; while (!check() && performance.now() < end) await settle(); };
  const json = () => JSON.stringify(renderer.toJSON());
  const reread = async () => { await act(async () => { await renderer.root.findByType(QueryClientProvider as never).props.client.invalidateQueries(); }); await settle(); };
  const running = { agent: { id: "agent-1", provider: "example-provider", status: "running", pendingPermissions: [], archivedAt: null } };
  async function ready(presentation: "screen" | "popover" = "screen") { await mount(presentation); await press("选择提示词：评审方案"); await fill("变量：项目", "示例应用"); }
  async function confirm() { await ready(); await press("发送给当前 Agent"); }

  it("selects and previews without sending, requires variables, and copies resolved text", async () => {
    await mount(); await press("选择提示词：评审方案");
    expect(sends()).toEqual([]);
    const copy = renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "复制到剪贴板");
    expect(copy.props.disabled).toBe(true);
    await fill("变量：项目", "示例应用");
    await press("复制到剪贴板");
    expect(host.copies).toEqual(["请检查 示例应用 的实现"]);
    expect(sends()).toEqual([]);
  });
  it("sends through the server with the prompt's key and source, and no consent where nothing needs one", async () => {
    await ready();
    await press("发送给当前 Agent"); await settle();
    expect(sends()).toEqual([{ agentId: "agent-1", text: expect.stringContaining(`来源：手记 #${note.id}`), messageId: expect.stringMatching(/^[0-9a-f-]{36}$/), key: promptKey(noteContext(note as never, "请检查 示例应用 的实现")), source: "提示词「评审方案」", what: "提示词", consent: null }]);
    expect(host.send).not.toHaveBeenCalled();
    expect(host.toasts).toContain("提示词已发送");
    expect(json()).toContain("提示词已发送。");
    expect(renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "发送给当前 Agent").props.disabled).toBe(true);
  });
  it("asks before interrupting an active provider and sends the confirmation's consent", async () => {
    host.refresh.mockResolvedValue(running);
    await confirm();
    expect(sends()).toEqual([]);
    await press("中断并发送"); await settle();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ text: expect.stringContaining(`来源：手记 #${note.id}`), consent: { interrupt: true, approvals: [] } });
  });
  it("serializes repeated sends while status is being read", async () => {
    let resolve!: (value: unknown) => void;
    host.refresh.mockReturnValue(new Promise(value => { resolve = value; }));
    await ready();
    const button = renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "发送给当前 Agent");
    await act(async () => { button.props.onPress(); button.props.onPress(); });
    expect(sends()).toEqual([]);
    await act(async () => resolve({ agent: { id: "agent-1", provider: "codex", status: "running", pendingPermissions: [], archivedAt: null } }));
    await settle();
    expect(sends()).toHaveLength(1);
    expect(sends()[0].consent).toBeNull();
  });
  // Recheck R1: the server plans again at the last moment; what the picker saw may be out of date.
  it("shows the server's confirmation when the agent changed after the picker looked; yes repeats the same id with its consent", async () => {
    await ready();
    answers.push(() => ({ status: "confirm", plan: { label: "仍然发送", note: "Agent 正在等你审批，发送会取消这次审批", confirm: "Agent 正在等你审批。发送后这条提示词会插进当前回合，同时取消这次审批请求。仍然发送吗？" }, consent: { interrupt: false, approvals: ["permission-7"] } }));
    await press("发送给当前 Agent"); await settle();
    expect(json()).toContain("同时取消这次审批请求");
    expect(labels()).toEqual(expect.arrayContaining(["仍然发送", "等审批处理完再发", "取消发送"]));
    await press("仍然发送"); await settle();
    const [first, second] = sends();
    expect(second.messageId).toBe(first.messageId);
    expect(first.consent).toBeNull();
    expect(second.consent).toEqual({ interrupt: false, approvals: ["permission-7"] });
    expect(json()).toContain("提示词已发送。");
  });
  it("a send without an answer points at the ledger's list instead of retrying, and the list then decides", async () => {
    await ready();
    // The server took it and holds it (the agent never answered), but its answer to the picker was lost.
    answers.push(input => { keep(record(input, "held", "没收到发送结果，可能已经送达。点「仍然发送」会先查会话记录：已经有这条就不再发，没有才重发；也可以取消。")); return new Error("请求超时"); });
    await press("发送给当前 Agent"); await settle();
    expect(json()).toContain("没有收到发送结果");
    expect(json()).toContain("可能已经送达");
    expect(labels()).toContain("待确认");
    expect(labels()).not.toContain("发送给当前 Agent");
    expect(sends()).toHaveLength(1);
  });
  it("a held send stays held and locked when the picker opens again; 仍然发送 resumes that id", async () => {
    const key = promptKey(noteContext(note as never, "请检查 示例应用 的实现"));
    queue = [{ messageId: "held-1", agentId: "agent-1", key, source: "提示词「评审方案」", preview: "来源：手记", createdAt: Date.now(), at: Date.now(), state: "held", note: "没收到发送结果，可能已经送达。" }];
    await ready(); await settle();
    expect(labels()).toContain("待确认");
    expect(labels()).not.toContain("发送给当前 Agent");
    expect(json()).toContain("需要你确认");
    await press("仍然发送"); await settle();
    expect(calls.find(call => call.name === "resume")!.input).toEqual({ messageId: "held-1" });
    expect(sends()).toEqual([]);
  });
  it("existing: a prompt another picker has on its way answers the send, and locks this one", async () => {
    await ready();
    answers.push(input => ({ status: "existing", view: keep({ ...record(input, "queued", "已排队"), messageId: "elsewhere-1" }) }));
    await press("发送给当前 Agent"); await settle();
    expect(host.toasts).toContain("这条提示词已在排队");
    expect(labels()).toContain("已排队");
    expect(labels()).not.toContain("发送给当前 Agent");
    expect(json()).not.toContain("提示词已发送。");
  });
  it("says busy and gone as they are", async () => {
    await ready();
    answers.push(() => ({ status: "gone", message: "这个 Agent 已归档或不存在，没有发送。" }));
    await press("发送给当前 Agent"); await settle();
    expect(json()).toContain("已归档或不存在");
    expect(labels()).toContain("发送给当前 Agent");
  });
  it("offers replace or append for an existing draft and supports guarded undo", async () => {
    let text = "原草稿";
    const undo = vi.fn(() => { text = "原草稿"; return true; });
    const write = vi.fn((value: string, previous: string, mode: string) => { text = mode === "append" ? `${previous}\n\n${value}` : value; return { undo }; });
    host.draft = { read: () => text, fill: write };
    await ready("popover");
    await press("填入输入框");
    expect(write).not.toHaveBeenCalled();
    await press("追加到末尾");
    expect(text).toBe("原草稿\n\n请检查 示例应用 的实现");
    expect(sends()).toEqual([]);
    await press("撤销填入");
    expect(text).toBe("原草稿");
    await press("填入输入框"); await press("替换草稿");
    expect(write).toHaveBeenLastCalledWith("请检查 示例应用 的实现", "原草稿", "replace");
  });
  describe("等这一轮结束再发", () => {
    beforeEach(() => { host.refresh.mockResolvedValue(running); });

    it("offers waiting as the second of three choices, only where sending would interrupt", async () => {
      await confirm();
      expect(labels().filter(label => ["中断并发送", "等这一轮结束再发", "取消发送"].includes(label))).toEqual(["中断并发送", "等这一轮结束再发", "取消发送"]);
      expect(json()).toContain("不打断当前回合");
      await act(async () => renderer.unmount());
      host.refresh.mockResolvedValue({ agent: { id: "agent-1", provider: "example-provider", status: "idle", pendingPermissions: [], archivedAt: null } });
      await confirm(); await settle();
      expect(sends()).toHaveLength(1);
      expect(labels()).not.toContain("等这一轮结束再发");
    });

    it("names the approval when one waits", async () => {
      host.refresh.mockResolvedValue({ agent: { id: "agent-1", provider: "codex", status: "running", pendingPermissions: [{ id: "permission-1" }], archivedAt: null } });
      await confirm();
      expect(labels()).toEqual(expect.arrayContaining(["仍然发送", "等审批处理完再发", "取消发送"]));
    });

    it("queues the prompt with its source and key under a new id, then shows it as queued and blocks a second send", async () => {
      await confirm();
      await press("等这一轮结束再发"); await settle();
      expect(sends()).toEqual([]);
      const enqueue = calls.find(call => call.name === "enqueue")!.input;
      expect(enqueue).toMatchObject({ agentId: "agent-1", source: "提示词「评审方案」", key: promptKey(noteContext(note as never, "请检查 示例应用 的实现")) });
      expect(enqueue.text).toContain(`来源：手记 #${note.id}`);
      expect(enqueue.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(host.toasts).toContain("已排队，这一轮结束后自动发送");
      expect(json()).toContain("已排队，等 Agent 这一轮结束");
      expect(json()).toContain("排队中");
      const queued = renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "已排队");
      expect(queued.props.disabled).toBe(true);
      expect(labels()).not.toContain("发送给当前 Agent");
    });

    it("取消排队 cancels that id and lets the preview be sent again", async () => {
      await confirm();
      await press("等这一轮结束再发"); await settle();
      const id = calls.find(call => call.name === "enqueue")!.input.messageId;
      await press("取消排队：提示词「评审方案」"); await settle();
      expect(calls.find(call => call.name === "cancel")!.input).toEqual({ messageId: id });
      expect(json()).toContain("已取消");
      expect(labels()).toContain("发送给当前 Agent");
    });

    // Review F4: the ledger's list is the record, not this picker's memory.
    it("keeps a queued prompt locked after 重新选择, reopening, or the agent going idle", async () => {
      await confirm();
      await press("等这一轮结束再发"); await settle();
      const id = calls.find(call => call.name === "enqueue")!.input.messageId;
      await press("重新选择"); await press("选择提示词：评审方案"); await fill("变量：项目", "示例应用"); await settle();
      expect(labels()).toContain("已排队");
      expect(labels()).not.toContain("发送给当前 Agent");
      // Reopened, and the agent idle now: still the queued copy, still no second delivery.
      await act(async () => renderer.unmount());
      host.refresh.mockResolvedValue({ agent: { id: "agent-1", provider: "example-provider", status: "idle", pendingPermissions: [], archivedAt: null } });
      await ready(); await settle();
      expect(labels()).toContain("已排队");
      expect(labels()).not.toContain("发送给当前 Agent");
      expect(sends()).toEqual([]);
      expect(calls.filter(call => call.name === "enqueue").map(call => call.input.messageId)).toEqual([id]);
      // Other parameters make another prompt, which is free.
      await fill("变量：项目", "其他应用"); await settle();
      expect(labels()).toContain("发送给当前 Agent");
    });

    it("a queueing without an answer: the list read again shows it queued, and nothing is queued twice", async () => {
      let lost = true;
      host.rpc.set("project-notes.deferred.enqueue", async input => {
        calls.push({ name: "enqueue", input });
        const existing = queue.find(view => view.key === input.key && ["queued", "held", "sending"].includes(view.state));
        const view = existing ?? keep(record(input, "queued", "已排队"));
        if (lost) { lost = false; throw new Error("请求超时"); }
        return view;
      });
      await confirm();
      await press("等这一轮结束再发"); await settle();
      expect(json()).toContain("未能排队");
      expect(labels()).toContain("已排队");
      expect(labels()).not.toContain("中断并发送");
      expect(labels()).not.toContain("发送给当前 Agent");
      expect(queue.filter(view => view.state === "queued")).toHaveLength(1);
    });

    // Recheck R8: what went out is the text that was queued; a preview edited since is another prompt.
    it("does not mark a prompt edited after queueing as sent when the old one goes out", async () => {
      await confirm();
      await press("等这一轮结束再发"); await settle();
      await fill("变量：项目", "其他应用"); await settle();
      queue = queue.map(view => ({ ...view, state: "sent", note: "已送达" }));
      await reread();
      expect(json()).toContain("请检查 其他应用 的实现");
      expect(json()).not.toContain("提示词已发送。");
      // The old message's outcome shows on its row only; the edited prompt can be sent.
      expect(json()).toContain("已送达");
      const send = renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "发送给当前 Agent");
      expect(send.props.disabled).toBe(false);
      expect(sends()).toEqual([]);
    });

    it("shows a delivered prompt as sent, and an uncertain one as maybe delivered without locking it", async () => {
      await confirm();
      await press("等这一轮结束再发"); await settle();
      queue = queue.map(view => ({ ...view, state: "sent", note: "已送达" }));
      await reread();
      expect(json()).toContain("提示词已发送。");
      expect(json()).toContain("已送达");
      await act(async () => renderer.unmount());
      queue = queue.map(view => ({ ...view, state: "maybe-sent", note: "已取消，没有再发；之前那一次可能已经送达" }));
      await ready(); await settle();
      expect(json()).toContain("上次的发送结果不确定");
      expect(labels()).toContain("发送给当前 Agent");
    });

    it("a prompt being sent right now locks the picker as 发送中", async () => {
      host.refresh.mockResolvedValue({ agent: { id: "agent-1", provider: "codex", status: "idle", pendingPermissions: [], archivedAt: null } });
      await ready();
      answers.push(input => ({ status: "sending", view: record(input, "sending", "正在发送") }));
      await press("发送给当前 Agent"); await settle();
      expect(labels()).toContain("发送中");
      expect(json()).toContain("发送中");
      expect(labels()).not.toContain("取消排队：提示词「评审方案」");
    });
  });
  // Review r3: the picker against the plugin's real server and its ledger (index.server.ts); only the agent's daemon,
  // a lost reply and an unreadable list are faked.
  describe("with the plugin's real server", () => {
    let stopServer: (() => Promise<void>) | null = null;
    afterEach(async () => { await stopServer?.(); stopServer = null; });
    async function realServer(agent: Record<string, unknown>) {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { default: contribute } = await import("../index.server");
      const home = await mkdtemp(join(tmpdir(), "notes-r3-"));
      const savedHome = process.env.PASEO_HOME;
      process.env.PASEO_HOME = home;
      const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
      const cleanup = contribute({ handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => Promise<unknown>) => handlers.set(contract.name, handler) } as never);
      const delivered: { text: string; messageId: string }[] = [];
      const paseo = { agents: { ref: () => ({
        refresh: async () => ({ agent: { ...agent } }),
        send: async (text: string, options: { messageId: string }) => { delivered.push({ text, ...options }); },
        timeline: { refetch: async () => ({ entries: delivered.map(value => ({ item: { type: "user_message", clientMessageId: value.messageId } })) }) },
      }) } };
      const server = { delivered, lost: new Set<string>(), listDown: false, answered: [] as string[] };
      for (const name of ["send", "enqueue", "list", "cancel", "resume"]) host.rpc.set(`project-notes.deferred.${name}`, async input => {
        calls.push({ name, input });
        if (name === "list" && server.listDown) throw new Error("列表暂时读不到");
        const result = await handlers.get(`project-notes.deferred.${name}`)!(input, { paseo });
        server.answered.push(name);
        // The server did its work; only its reply to the picker gets lost.
        if (server.lost.delete(name)) throw new Error("回复在服务端成功后丢失");
        return result;
      });
      host.refresh.mockImplementation(async () => ({ agent: { ...agent } }));
      stopServer = async () => {
        await (cleanup as unknown as () => Promise<void> | void)();
        if (savedHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = savedHome;
        await rm(home, { recursive: true, force: true });
      };
      return server;
    }
    const idleAgent = () => ({ id: "agent-1", provider: "codex", status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [], lastUserMessageAt: null });
    const busyAgent = () => ({ id: "agent-1", provider: "example-provider", status: "running", archivedAt: null, activeTurn: { turnId: "t1", startedAt: "2026-10-12T10:00:00.000Z" }, pendingPermissions: [], lastUserMessageAt: null });

    it("one OK per turn: confirming once sends it, bound to the turn the picker read (r3-F1)", async () => {
      const server = await realServer(busyAgent());
      await ready(); await press("发送给当前 Agent");
      expect(labels()).toContain("中断并发送");
      await press("中断并发送"); await settle();
      await until(() => server.delivered.length === 1);
      expect(server.delivered).toHaveLength(1);
      expect(sends()).toHaveLength(1);
      expect(sends()[0].consent).toEqual({ interrupt: true, approvals: [], turn: "t1@2026-10-12T10:00:00.000Z" });
    });

    it("an OK given in one turn does not interrupt the next: the server asks again, then sends once (r3-F1)", async () => {
      const agent = busyAgent();
      const server = await realServer(agent);
      await ready(); await press("发送给当前 Agent");
      // The turn the user agreed to interrupt ended, and another began, before the tap that says yes.
      Object.assign(agent, { activeTurn: { turnId: "t2", startedAt: "2026-10-12T10:03:00.000Z" } });
      await press("中断并发送"); await settle();
      // The server's answer (ask again) must be back before the second tap, however slow a loaded run is.
      await until(() => server.answered.includes("send"));
      await settle();
      expect(server.delivered).toHaveLength(0);
      expect(labels()).toContain("中断并发送");
      await press("中断并发送"); await settle();
      await until(() => server.delivered.length === 1);
      expect(server.delivered).toHaveLength(1);
      expect(sends().map(input => input.messageId)).toEqual([sends()[0].messageId, sends()[0].messageId]);
      expect(sends().map(input => input.consent.turn)).toEqual(["t1@2026-10-12T10:00:00.000Z", "t2@2026-10-12T10:03:00.000Z"]);
    });

    it("a send whose reply was lost is tried again under its id: the agent gets it once, even past the 10 s window (r3-F5)", async () => {
      // The clock goes in before the ledger is made: it keeps the Date.now it was built with.
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const server = await realServer(idleAgent());
        server.lost.add("send"); server.listDown = true;
        await ready(); await press("发送给当前 Agent"); await settle();
        await until(() => server.delivered.length === 1);
        expect(server.delivered).toHaveLength(1);
        await until(() => json().includes("没有收到发送结果"));
        expect(json()).toContain("没有收到发送结果");
        now += 11_000;
        await press("发送给当前 Agent"); await settle();
        expect(sends().map(input => input.messageId)).toEqual([sends()[0].messageId, sends()[0].messageId]);
        expect(server.delivered).toHaveLength(1);
        await until(() => host.toasts.includes("提示词已发送"));
        expect(host.toasts).toContain("提示词已发送");
      } finally { clock.mockRestore(); }
    });

    it("a queueing whose reply was lost is tried again under its id (r3-F5)", async () => {
      const agent = busyAgent();
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const server = await realServer(agent);
        await ready(); await press("发送给当前 Agent");
        // The turn ends before the queueing reaches the server: it goes out at once, and its reply is lost.
        Object.assign(agent, { status: "idle", activeTurn: null });
        server.lost.add("enqueue"); server.listDown = true;
        await press("等这一轮结束再发");
        for (let i = 0; i < 80 && !json().includes("未能排队"); i++) await settle();
        await until(() => server.delivered.length === 1);
        expect(server.delivered).toHaveLength(1);
        now += 11_000;
        await press("等这一轮结束再发"); await settle();
        const attempts = calls.filter(call => call.name === "enqueue").map(call => call.input.messageId);
        expect(attempts).toEqual([attempts[0], attempts[0]]);
        expect(server.delivered).toHaveLength(1);
      } finally { clock.mockRestore(); }
    });

    // Review r4-F2: every try after a lost reply asks about that message, whichever way the user tries again, and its
    // record settles the preview once the list shows it. The clock goes in before the ledger is made, so 11 s and 13 s
    // really are past the ledger's 10 s window for the same content.
    it("a queueing whose reply was lost: the confirmation shown before it asks about that message, never sends under its own id (r4-F2)", async () => {
      const agent = busyAgent();
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const server = await realServer(agent);
        await ready(); await press("发送给当前 Agent");
        // The turn ends before the queueing reaches the server: it goes out at once, and its reply is lost.
        Object.assign(agent, { status: "idle", activeTurn: null });
        server.lost.add("enqueue"); server.listDown = true;
        await press("等这一轮结束再发"); await until(() => json().includes("未能排队"));
        expect(server.delivered).toHaveLength(1);
        expect(labels()).toContain("中断并发送");
        const queued = calls.find(call => call.name === "enqueue")!.input;
        now += 11_000;
        await press("中断并发送"); await until(() => host.toasts.includes("提示词已发送"));
        expect(sends().map(input => input.messageId)).toEqual([queued.messageId]);
        expect(server.delivered).toHaveLength(1);
        expect(json()).toContain("提示词已发送。");
      } finally { clock.mockRestore(); }
    });

    it("a lost send that the list shows as sent settles the preview: delivered, its notice gone, and no second send (r4-F2)", async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const server = await realServer(idleAgent());
        server.lost.add("send");
        await ready(); await press("发送给当前 Agent"); await until(() => json().includes("没有收到发送结果"));
        expect(server.delivered).toHaveLength(1);
        // The list is read again and has that message, sent.
        await reread(); await until(() => json().includes("提示词已发送。"));
        expect(json()).not.toContain("没有收到发送结果");
        // Long after its 已送达 row went, the preview still is the one that went out: the button sends nothing.
        now += 13_000;
        await reread();
        expect(json()).toContain("提示词已发送。");
        expect(renderer.root.find(node => is(node, "Pressable") && node.props.accessibilityLabel === "发送给当前 Agent").props.disabled).toBe(true);
        await press("发送给当前 Agent"); await settle();
        expect(sends()).toHaveLength(1);
        expect(server.delivered).toHaveLength(1);
      } finally { clock.mockRestore(); }
    });

    it("a lost send tried again from a reopened picker, or as a queueing, asks about the same message (r4-F2)", async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const server = await realServer(busyAgent());
        server.lost.add("send"); server.listDown = true;
        await ready(); await press("发送给当前 Agent"); await press("中断并发送"); await until(() => json().includes("没有收到发送结果"));
        expect(server.delivered).toHaveLength(1);
        // The picker closes and opens again; the user now chooses to wait instead.
        await act(async () => renderer.unmount());
        now += 11_000;
        await ready(); await press("发送给当前 Agent"); await press("等这一轮结束再发");
        await until(() => calls.some(call => call.name === "enqueue") && json().includes("提示词已发送。"));
        expect(calls.find(call => call.name === "enqueue")!.input.messageId).toBe(sends()[0].messageId);
        expect(server.delivered).toHaveLength(1);
      } finally { clock.mockRestore(); }
    });
  });
  it("falls back to copying if the captured composer disappears, and hides insert without a target", async () => {
    host.draft = { read: () => null, fill: vi.fn() };
    await ready("popover");
    await press("填入输入框");
    expect(host.copies).toEqual(["请检查 示例应用 的实现"]);
    expect(renderer.root.findAll(node => is(node, "Pressable") && node.props.accessibilityLabel === "填入输入框")).toHaveLength(0);
    expect(sends()).toEqual([]);
  });
});

describe("one-tap prompt with variables", () => {
  const mountPopover = async () => {
    await act(async () => { renderer = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PromptPopover, { theme, host: { id: "host-1", label: "示例主机" }, layout: { compact: true, platform: "web" }, context: "agent", workspaceId: "ws-1", agentId: "agent-1", close: () => {}, quick: { projectId: note.projectId, itemId: note.id } } as never))); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  };
  it("opens the picker on that prompt, ready to fill in, and sends nothing on its own", async () => {
    host.rpc.set("project-notes.quick.note", async input => { calls.push({ name: "note", input }); return note; });
    await mountPopover();
    // The prompt, then the picker's usual read of this agent's queue.
    expect(calls.map(call => call.name)).toEqual(["note", "list"]);
    expect(calls[0]!.input).toEqual({ projectId: note.projectId, itemId: note.id });
    expect(renderer.root.findAll(node => is(node, "TextInput") && node.props.accessibilityLabel === "变量：项目")).toHaveLength(1);
    expect(sends()).toEqual([]);
    await fill("变量：项目", "示例应用");
    await press("发送给当前 Agent");
    expect(sends()).toMatchObject([{ agentId: "agent-1", text: noteContext(note, "请检查 示例应用 的实现"), consent: null }]);
  });
  it("opens the same form on the prompts screen when the 「一键 N」 menu asks for it", async () => {
    host.rpc.set("project-notes.quick.note", async input => { calls.push({ name: "note", input }); return note; });
    await act(async () => { renderer = create(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PromptScreen, { theme, host: { id: "host-1", label: "示例主机" }, layout: { compact: true, platform: "web" }, params: { agentId: "agent-1", projectId: note.projectId, itemId: note.id } } as never))); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(calls[0]).toEqual({ name: "note", input: { projectId: note.projectId, itemId: note.id } });
    await fill("变量：项目", "示例应用");
    await press("发送给当前 Agent");
    expect(sends()).toMatchObject([{ agentId: "agent-1", text: noteContext(note, "请检查 示例应用 的实现"), consent: null }]);
  });
  it("says so when the prompt is gone", async () => {
    host.rpc.set("project-notes.quick.note", async () => null);
    await mountPopover();
    expect(JSON.stringify(renderer.toJSON())).toContain("这条提示词已删除、在回收站里，或已不是提示词。");
  });
});
