import { describe, expect, it, vi } from "vitest";
import type { PluginButton, PluginButtonMenuEntry } from "@getpaseo/plugin/client";
import { createQuickPills, quickAsk, type QuickPillHost } from "../client/quick-pills";
import { liteAgent, type AgentLite } from "../client/agent-directory";
import { pillLabel, quickEntries, type QuickEntry } from "../shared/quick";
import type { QuickSendResult } from "../shared/quick-send";
import { createQuickSender } from "../client/quick-send";
import { createQuickStore } from "../client/quick-store";

// One-tap prompt pills: registration order and incremental updates, which prompts may go out at one tap, and how a
// press goes through the plugin's send ledger without ever interrupting a turn on its own.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = (n: number, patch: Partial<QuickEntry> = {}): QuickEntry => ({ projectId: "prj", itemId: uuid(n), label: `提示词 ${n}`, template: false, hidden: false, revision: 1, ...patch });
const agent = (patch: Partial<Parameters<typeof liteAgent>[0]> = {}): AgentLite => liteAgent({ id: "agent-1", workspaceId: "ws-1", provider: "example-acp", status: "idle", pendingPermissions: [], ...patch })!;

function harness(answers: ((input: any) => QuickSendResult | Promise<QuickSendResult>)[] = []) {
  const registrations: { id: string; agentId: string; button: PluginButton; update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; live: boolean }[] = [];
  const sends: any[] = [], notices: string[] = [];
  const host: QuickPillHost = {
    addComposerPill: vi.fn(({ id, agentId, button }) => {
      const registration = { id, agentId, button, live: true, update: vi.fn((patch: Partial<PluginButton>) => { registration.button = { ...registration.button, ...patch }; }), remove: vi.fn(() => { registration.live = false; }) };
      registrations.push(registration);
      return registration;
    }),
    // The real send half (the quick chunk's) over a fake server.
    send: vi.fn(createQuickSender(async (input): Promise<QuickSendResult> => { sends.push(input); const answer = answers.shift(); return answer ? answer(input) : { status: "sent", message: "已发送「提示词」" }; })),
    notice: message => { notices.push(message); },
    openManager: vi.fn(),
    fill: vi.fn(() => () => null),
    openFill: vi.fn(),
    icons: { send: "Zap", ask: "Hourglass", fill: "Braces" },
  };
  const pills = createQuickPills(host);
  const live = () => registrations.filter(registration => registration.live);
  const pill = (id: string) => live().find(registration => registration.id === id)!;
  const press = async (button: PluginButton, ...path: string[]) => {
    let behavior = button.behavior;
    for (const step of path) {
      if (behavior.kind !== "menu") throw new Error(`not a menu at ${step}`);
      const item = behavior.items.find((candidate): candidate is Extract<PluginButtonMenuEntry, { kind: "item" }> => candidate.kind === "item" && candidate.id === step);
      if (!item) throw new Error(`no item ${step}`);
      behavior = item.behavior;
    }
    if (behavior.kind !== "action") throw new Error(`not an action: ${behavior.kind}`);
    return behavior.onPress();
  };
  return { host, pills, registrations, live, pill, press, sends, notices };
}

describe("one-tap pill registration", () => {
  it("shows nothing before the list is read, then one pill per prompt in the list's order", () => {
    const h = harness();
    h.pills.setAgent(agent());
    expect(h.live()).toEqual([]);
    h.pills.setEntries([entry(1), entry(2)]);
    expect(h.live().map(pill => pill.id)).toEqual([`quick-${uuid(1)}`, `quick-${uuid(2)}`]);
    expect(h.live().map(pill => pill.button.label)).toEqual(["提示词 1", "提示词 2"]);
  });

  it("updates pills in place while the order holds and registers again only from the first change", () => {
    const h = harness();
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1), entry(2)]);
    const [first, second] = h.live();
    // Renaming the second keeps both registrations; only the second is updated.
    h.pills.setEntries([entry(1), entry(2, { label: "跑测试并修复" })]);
    expect(h.live()).toEqual([first, second]);
    expect(first!.update).not.toHaveBeenCalled();
    expect(second!.update).toHaveBeenCalledTimes(1);
    expect(second!.button.label).toBe("跑测试并修复");
    // Appending adds one pill and touches none before it.
    h.pills.setEntries([entry(1), entry(2, { label: "跑测试并修复" }), entry(3)]);
    expect(h.live().slice(0, 2)).toEqual([first, second]);
    expect(h.live()).toHaveLength(3);
    // Moving the third up: the first stays, the rest register again in the new order (order is display order).
    h.pills.setEntries([entry(1), entry(3), entry(2, { label: "跑测试并修复" })]);
    expect(h.live()[0]).toBe(first);
    expect(second!.remove).toHaveBeenCalledTimes(1);
    expect(h.live().map(pill => pill.id)).toEqual([`quick-${uuid(1)}`, `quick-${uuid(3)}`, `quick-${uuid(2)}`]);
    // Hidden entries (in the trash) show no pill.
    h.pills.setEntries([entry(1), entry(3, { hidden: true }), entry(2, { label: "跑测试并修复" })]);
    expect(h.live().map(pill => pill.id)).toEqual([`quick-${uuid(1)}`, `quick-${uuid(2)}`]);
  });

  it("folds more than three prompts into one menu pill that also opens the manager", async () => {
    const h = harness();
    h.pills.setAgent(agent());
    h.pills.setEntries([1, 2, 3, 4].map(n => entry(n)));
    expect(h.live().map(pill => pill.id)).toEqual(["quick-menu"]);
    const menu = h.pill("quick-menu").button;
    expect(menu.label).toBe("一键 4");
    if (menu.behavior.kind !== "menu") throw new Error("menu expected");
    expect(menu.behavior.items.map(item => item.kind === "item" ? item.title : "—")).toEqual(["提示词 1", "提示词 2", "提示词 3", "提示词 4", "—", "管理一键发送…"]);
    await h.press(menu, "manage");
    expect(h.host.openManager).toHaveBeenCalledTimes(1);
    await h.press(menu, "p2");
    expect(h.sends).toMatchObject([{ agentId: "agent-1", itemId: uuid(3), consent: null }]);
    // Back to three: three separate pills again.
    h.pills.setEntries([1, 2, 3].map(n => entry(n)));
    expect(h.live().map(pill => pill.id)).toEqual([1, 2, 3].map(n => `quick-${uuid(n)}`));
  });

  it("folds every prompt into the menu pill on a narrow window and unfolds on a wide one, in place of the separate pills", () => {
    const h = harness();
    h.pills.setNarrow(true);
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1), entry(2)]);
    // A phone: one pill for every one-tap prompt, so the other plugins' pills keep their labels.
    expect(h.live().map(pill => [pill.id, pill.button.label])).toEqual([["quick-menu", "一键 2"]]);
    expect(h.registrations).toHaveLength(1);
    // Turned sideways (or a wider window): separate pills again, at most three; folded again when it narrows.
    h.pills.setNarrow(false);
    expect(h.live().map(pill => pill.id)).toEqual([`quick-${uuid(1)}`, `quick-${uuid(2)}`]);
    const separate = h.live();
    h.pills.setNarrow(true);
    expect(h.live().map(pill => pill.id)).toEqual(["quick-menu"]);
    for (const pill of separate) expect(pill.remove).toHaveBeenCalledTimes(1);
    // The same width again changes nothing: no update, no new registration.
    const before = h.registrations.length, menu = h.pill("quick-menu");
    h.pills.setNarrow(true);
    expect([h.registrations.length, menu.update.mock.calls.length]).toEqual([before, 0]);
  });

  it("opens a prompt with variables from the menu pill on its own screen: an action, never a form inside the menu", async () => {
    const h = harness();
    h.pills.setNarrow(true);
    h.pills.setAgent(agent({ status: "running" }));
    h.pills.setEntries([entry(1), entry(2, { template: true })]);
    const menu = h.pill("quick-menu").button;
    if (menu.behavior.kind !== "menu") throw new Error("menu expected");
    const item = menu.behavior.items.find(candidate => candidate.kind === "item" && candidate.id === "p1");
    expect(item?.kind === "item" && [item.icon, item.behavior.kind]).toEqual(["Braces", "action"]);
    await h.press(menu, "p1");
    expect(h.host.openFill).toHaveBeenCalledWith("agent-1", expect.objectContaining({ itemId: uuid(2) }));
    expect(h.sends).toEqual([]);
    // The agent's state changes the menu (busy → idle), but the form is not in it: nothing the user has open closes.
    h.pills.setAgent(agent());
    expect(h.host.openFill).toHaveBeenCalledTimes(1);
  });

  it("redraws on a language change only when the pills' words change, so an open menu stays open", () => {
    const h = harness();
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1)]);
    const pill = h.live()[0]!;
    // The full catalog arrives with the same boot text: nothing to update (an update would close an open menu).
    h.pills.refreshText();
    expect(pill.update).not.toHaveBeenCalled();
  });

  it("follows the agent: its workspace, and its removal", () => {
    const h = harness();
    h.pills.setEntries([entry(1)]);
    h.pills.setAgent(agent({ workspaceId: undefined }));
    expect(h.live()).toEqual([]);
    h.pills.setAgent(agent());
    const first = h.live()[0]!;
    h.pills.setAgent(agent({ workspaceId: "ws-2" }));
    expect(first.remove).toHaveBeenCalledTimes(1);
    expect(h.live().map(pill => pill.agentId)).toEqual(["agent-1"]);
    h.pills.removeAgent("agent-1");
    expect(h.live()).toEqual([]);
  });

  it("opens the fill form for a prompt with variables and never sends it", () => {
    const h = harness();
    h.pills.setAgent(agent({ status: "running" }));
    h.pills.setEntries([entry(1, { template: true })]);
    const button = h.live()[0]!.button;
    expect(button.behavior.kind).toBe("popover");
    expect(button.icon).toBe("Braces");
    expect(h.host.fill).toHaveBeenCalledWith(expect.objectContaining({ itemId: uuid(1) }));
    expect(h.sends).toEqual([]);
  });

  it("cuts long titles to about ten wide or twenty narrow characters", () => {
    expect(pillLabel("跑测试并修复所有失败的用例然后提交")).toBe("跑测试并修复所有失…");
    expect(pillLabel("Run the tests and fix every failure")).toBe("Run the tests and f…");
    expect(pillLabel("  继续\n下一步 ")).toBe("继续 下一步");
  });

  it("reads saved lists defensively: unknown shapes are empty, repeated notes keep their first place", () => {
    expect(quickEntries(null)).toEqual([]);
    expect(quickEntries({ prompts: "x" })).toEqual([]);
    expect(quickEntries({ prompts: [entry(1), { itemId: 3 }, entry(1, { label: "again" }), entry(2)] }).map(item => item.label)).toEqual(["提示词 1", "提示词 2"]);
  });
});

describe("what a press does", () => {
  it("sends at once to an idle agent, and to a running one that takes messages mid-turn", async () => {
    expect(quickAsk(agent(), null)).toBeNull();
    expect(quickAsk(agent({ status: "closed" }), null)).toBeNull();
    expect(quickAsk(agent({ status: "error" }), null)).toBeNull();
    expect(quickAsk(agent({ status: "running", provider: "claude" }), null)).toBeNull();
    // A custom id is judged by what the server says its base can do, never by its name.
    expect(quickAsk(agent({ status: "running", provider: "custom-assistant" }), null)).not.toBeNull();
    expect(quickAsk(agent({ status: "running", provider: "custom-assistant" }), new Set(["custom-assistant"]))).toBeNull();
    const h = harness();
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1)]);
    const button = h.live()[0]!.button;
    expect(button.behavior.kind).toBe("action");
    await h.press(button);
    expect(h.sends).toEqual([{ agentId: "agent-1", projectId: "prj", itemId: uuid(1), messageId: expect.any(String), consent: null }]);
    // The server words the outcome (in the plugin's language); the pill shows it.
    expect(h.notices).toEqual(["已发送「提示词」"]);
  });

  it("asks before a send that would interrupt a turn: wait for the turn, or interrupt with the user's OK", async () => {
    const h = harness();
    h.pills.setAgent(agent({ status: "running", activeTurn: { turnId: "turn-7", startedAt: "2026-10-15T08:00:00Z" } }));
    h.pills.setEntries([entry(1)]);
    const button = h.live()[0]!.button;
    expect(button.behavior.kind).toBe("menu");
    if (button.behavior.kind !== "menu") return;
    expect(button.behavior.items.map(item => item.kind === "item" ? [item.title, !!item.disabled] : null)).toEqual([["Agent 正在运行，不能插话", true], ["等这一轮结束再发", false], ["中断并发送", false]]);
    // Opening the menu sends nothing; waiting queues it in the ledger.
    expect(h.sends).toEqual([]);
    await h.press(button, "wait");
    expect(h.sends.at(-1)).toMatchObject({ wait: true, consent: null });
    await h.press(button, "now");
    expect(h.sends.at(-1)).toMatchObject({ consent: { interrupt: true, approvals: [], turn: "turn-7@2026-10-15T08:00:00Z" } });
  });

  it("asks before a send that would cancel approvals, even into a turn that takes messages", async () => {
    const h = harness();
    h.pills.setAgent(agent({ status: "running", provider: "codex", pendingPermissions: [{ id: "perm-2" }, { id: "perm-1" }], activeTurn: { turnId: "t" } }));
    h.pills.setEntries([entry(1)]);
    const button = h.live()[0]!.button;
    if (button.behavior.kind !== "menu") throw new Error("menu expected");
    expect(button.behavior.items.map(item => item.kind === "item" ? item.title : null)).toEqual(["Agent 在等你审批，现在发送会取消审批", "等审批处理完再发", "仍然发送"]);
    await h.press(button, "now");
    expect(h.sends.at(-1)).toMatchObject({ consent: { interrupt: false, approvals: ["perm-1", "perm-2"], turn: "t" } });
  });

  it("switches as the agent's state changes, without re-registering", () => {
    const h = harness();
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1)]);
    const registration = h.live()[0]!;
    h.pills.setAgent(agent({ status: "running" }));
    expect(h.live()).toEqual([registration]);
    expect(registration.button.behavior.kind).toBe("menu");
    h.pills.setAgent(agent({ status: "idle" }));
    expect(registration.button.behavior.kind).toBe("action");
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("never interrupts when the server finds the agent busy: nothing goes out and the next press asks", async () => {
    const h = harness([() => ({ status: "confirm", message: "Agent 刚开始忙，「提示词 1」没有发出。", consent: { interrupt: true, approvals: [], turn: "turn-9" } })]);
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1)]);
    const registration = h.live()[0]!;
    await expect(h.press(registration.button)).rejects.toThrow("Agent 刚开始忙");
    expect(h.sends).toEqual([expect.objectContaining({ consent: null })]);
    expect(registration.button.behavior.kind).toBe("menu");
    await h.press(registration.button, "now");
    expect(h.sends.at(-1)).toMatchObject({ consent: { interrupt: true, approvals: [], turn: "turn-9" } });
    // Once the directory moves on, the pill follows it again.
    h.pills.setAgent(agent({ status: "running", activeTurn: { turnId: "turn-10" } }));
    h.pills.setAgent(agent());
    expect(registration.button.behavior.kind).toBe("action");
  });

  it("retries a press whose answer was lost under the same message id, and uses a new id after an answer", async () => {
    const h = harness([() => { throw new Error("connection lost"); }]);
    h.pills.setAgent(agent());
    h.pills.setEntries([entry(1)]);
    const button = h.live()[0]!.button;
    // The answer was lost, not the send: the message says it may have gone out and to check before pressing again.
    await expect(h.press(button)).rejects.toThrow(/「提示词 1」没有确认发送结果：connection lost。可能已经送达，请先在「提示词」胶囊的队列或会话里核对。这次连接内再点/);
    await h.press(button);
    expect(h.sends[1].messageId).toBe(h.sends[0].messageId);
    await h.press(button);
    expect(h.sends[2].messageId).not.toBe(h.sends[0].messageId);
  });

  it("keeps one send per prompt while the first press is still loading or waiting for the server", async () => {
    let arrive!: () => void;
    const loading = new Promise<void>(resolve => { arrive = resolve; });
    const h = harness();
    const send = h.host.send;
    // The send half arrives with the first press (the quick chunk); the host spins the pill until it settles.
    h.host.send = vi.fn((request, hooks) => loading.then(() => send(request, hooks)));
    const pills = createQuickPills(h.host);
    pills.setAgent(agent());
    pills.setEntries([entry(1), entry(2)]);
    const [first, second] = h.live().slice(-2);
    let settled = false;
    const one = h.press(first!.button).then(() => { settled = true; }), again = h.press(first!.button), other = h.press(second!.button);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.sends).toEqual([]);
    arrive();
    await Promise.all([one, again, other]);
    // The second press of the same prompt joined the first; another prompt goes on its own.
    expect(h.sends.map(input => input.itemId)).toEqual([uuid(1), uuid(2)]);
    expect(h.host.send).toHaveBeenCalledTimes(2);
    await h.press(first!.button);
    expect(h.sends.map(input => input.itemId)).toEqual([uuid(1), uuid(2), uuid(1)]);
  });

  it("shows the server's words: a toast for what went out or waits, an error for what did not", async () => {
    const h = harness([
      () => ({ status: "queued", message: "已排队" }),
      () => ({ status: "existing", message: "已在路上" }),
      () => ({ status: "missing", message: "这条提示词已删除" }),
      () => ({ status: "gone", message: "Agent 已归档" }),
      () => ({ status: "template", message: "含有变量，再点一次先填写" }),
    ]);
    h.pills.setAgent(agent({ status: "running" }));
    h.pills.setEntries([entry(1)]);
    const registration = h.live()[0]!;
    await h.press(registration.button, "wait");
    await h.press(registration.button, "wait");
    expect(h.notices).toEqual(["已排队", "已在路上"]);
    await expect(h.press(registration.button, "now")).rejects.toThrow("这条提示词已删除");
    await expect(h.press(registration.button, "now")).rejects.toThrow("Agent 已归档");
    // Variables found since the list was saved: from now on the pill opens the fill form.
    await expect(h.press(registration.button, "now")).rejects.toThrow("含有变量");
    expect(registration.button.behavior.kind).toBe("popover");
  });
});

describe("the shared one-tap list", () => {
  it("reads it after each connect and whenever any app changes it, never polling; a save is used at once", async () => {
    let observer: { snapshot(): void; update(message: unknown): void } | undefined;
    const release = vi.fn(async () => {});
    let values: unknown = { prompts: [entry(1)] }, revision = "rev-1";
    const rpc = vi.fn(async () => ({ status: "ready", values, revision }));
    const store = createQuickStore({ rpc, paseo: { observeEvents: vi.fn(() => ({ subscribe: (value: typeof observer) => { observer = value; return () => {}; }, release })) } } as never);
    const changes = vi.fn();
    store.subscribe(changes);
    expect(store.ready()).toBe(false);
    observer!.snapshot();
    await vi.waitFor(() => expect(store.ready()).toBe(true));
    expect(store.entries().map(item => item.label)).toEqual(["提示词 1"]);
    // Another plugin's setting, or another setting of this one: nothing to read.
    observer!.update({ type: "status", payload: { status: "plugin_settings_changed", settingsId: "language" } });
    expect(rpc).toHaveBeenCalledTimes(1);
    values = { prompts: [entry(1), entry(2)] }; revision = "rev-2";
    observer!.update({ type: "status", payload: { status: "plugin_settings_changed", settingsId: "quick-prompts" } });
    await vi.waitFor(() => expect(store.revision()).toBe("rev-2"));
    expect(changes).toHaveBeenCalledTimes(2);
    // A save's answer wins over a read that started before it.
    let finish!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    void store.refresh();
    store.adopt({ prompts: [entry(3)] }, "rev-3");
    finish({ status: "ready", values: { prompts: [] }, revision: "rev-2" });
    await Promise.resolve(); await Promise.resolve();
    expect([store.revision(), store.entries().map(item => item.itemId)]).toEqual(["rev-3", [uuid(3)]]);
    store.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
