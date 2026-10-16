import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "../server/store";
import { DeferredSend } from "../server/deferred-send";
import { QuickPrompts, notePromptKey as serverKey } from "../server/quick";
import { notePromptKey as pickerKey } from "../client/deferred-state";
import { createQuickSender } from "../client/quick-send";
import { noteContext } from "../shared/composer";
import type { NoteFields } from "../shared/board";

// One-tap sends on the server: the note is read again, prompts with variables or gone ones never go out, and the text,
// key and source line are the picker's, through the same ledger that never interrupts without the user's OK.

let home: string, store: BoardStore, ledger: DeferredSend;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "notes-quick-"));
  store = new BoardStore(join(home, "boards"));
  ledger = new DeferredSend({ file: join(home, "deferred-send.json"), lockDirectory: join(home, "locks"), capabilities: () => ({ steerable: ["claude", "codex"], slashSteerable: ["claude"] }) });
});
afterEach(async () => { ledger.stop(); await rm(home, { recursive: true, force: true }); });

const fields = (patch: Partial<NoteFields> = {}): NoteFields => ({ kind: "prompt", title: "跑测试并修复", body: "运行全部测试，修好失败的用例。", status: "todo", priority: "normal", pinned: false, ...patch });
let request = 0;
async function create(patch: Partial<NoteFields> = {}) {
  const { itemId } = await store.write({ projectId: "prj", requestId: `quick-test-${++request}`, operation: { type: "create", fields: fields(patch) } });
  return itemId;
}
/** A daemon with one agent; records what arrives. */
function daemon(provider: string, status: string, permissions: { id: string }[] = []) {
  const agent = { id: "agent-1", provider, status, pendingPermissions: permissions, activeTurn: status === "running" ? { turnId: "turn-1", startedAt: "2026-10-15T08:00:00.000Z" } : null, archivedAt: null as string | null, lastUserMessageAt: null };
  const sent: unknown[][] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { ...agent } }), send: async (...args: unknown[]) => { sent.push(args); }, timeline: { refetch: async () => ({ entries: [] }) } }) } } as unknown as PaseoApi;
  return { agent, sent, paseo };
}
const input = (itemId: string, patch: Record<string, unknown> = {}) => ({ agentId: "agent-1", projectId: "prj", itemId, messageId: `message-${++request}-quick`, ...patch });

describe("one-tap sends on the server", () => {
  it("sends the picker's text under the picker's key to an idle agent", async () => {
    const id = await create(), quick = new QuickPrompts(store, ledger), a = daemon("example-acp", "idle");
    const note = (await store.read("prj")).items[0]!;
    expect(serverKey(note, note.body)).toBe(pickerKey(note, note.body));
    expect(await quick.send(input(id), a.paseo)).toEqual({ status: "sent", message: "已发送「跑测试并修复」" });
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]![0]).toBe(noteContext(note, note.body));
  });

  it("never interrupts a turn on its own: it asks, and goes out once the user's OK covers it", async () => {
    const id = await create(), quick = new QuickPrompts(store, ledger), a = daemon("example-acp", "running");
    const asked = await quick.send(input(id, { messageId: "message-0001-quick" }), a.paseo);
    expect(asked).toMatchObject({ status: "confirm", message: expect.stringContaining("没有发出"), consent: { interrupt: true, approvals: [], turn: "turn-1@2026-10-15T08:00:00.000Z" } });
    expect(a.sent).toEqual([]);
    const consent = (asked as { consent: unknown }).consent;
    expect(await quick.send(input(id, { messageId: "message-0001-quick", consent }), a.paseo)).toMatchObject({ status: "sent" });
    expect(a.sent).toEqual([[expect.any(String), { activeTurnBehavior: "interrupt", messageId: "message-0001-quick" }]]);
  });

  it("steers into a turn that takes messages, but asks before cancelling an approval", async () => {
    const quick = new QuickPrompts(store, ledger);
    const steering = daemon("codex", "running");
    expect(await quick.send(input(await create()), steering.paseo)).toMatchObject({ status: "sent" });
    expect(steering.sent[0]![1]).toMatchObject({ activeTurnBehavior: "steer" });
    const waiting = daemon("codex", "running", [{ id: "perm-1" }]);
    expect(await quick.send(input(await create({ title: "提交并开 MR" })), waiting.paseo)).toMatchObject({ status: "confirm", consent: { interrupt: false, approvals: ["perm-1"] } });
    expect(waiting.sent).toEqual([]);
  });

  it("queues for 「等这一轮结束再发」 and finds the copy already on its way", async () => {
    const id = await create(), quick = new QuickPrompts(store, ledger), a = daemon("example-acp", "running");
    expect(await quick.send(input(id, { wait: true }), a.paseo)).toEqual({ status: "queued", message: "已排队：「跑测试并修复」将在这一轮结束、没有待审批时发出" });
    expect(await ledger.list({ agentId: "agent-1" })).toMatchObject([{ state: "queued", source: "提示词「跑测试并修复」" }]);
    // The same prompt again (from a pill or the picker) answers with that copy instead of a second one.
    expect(await quick.send(input(id, { consent: { interrupt: true, approvals: [] } }), a.paseo)).toMatchObject({ status: "existing" });
    expect(await quick.send(input(id, { wait: true }), a.paseo)).toMatchObject({ status: "existing" });
    expect(a.sent).toEqual([]);
  });

  it("refuses prompts with variables and notes that are gone, in the trash or no longer prompts", async () => {
    const quick = new QuickPrompts(store, ledger), a = daemon("example-acp", "idle");
    expect(await quick.send(input(await create({ body: "检查 {{分支}} 的改动" })), a.paseo)).toMatchObject({ status: "template" });
    expect(await quick.send(input(await create({ kind: "idea" })), a.paseo)).toMatchObject({ status: "missing" });
    const trashed = await create(), board = await store.read("prj");
    await store.write({ projectId: "prj", requestId: "quick-trash", operation: { type: "delete", id: trashed, expectedRevision: board.items.find(item => item.id === trashed)!.revision } });
    expect(await quick.send(input(trashed), a.paseo)).toMatchObject({ status: "missing", message: expect.stringContaining("不能一键发送") });
    expect(await quick.send(input("00000000-0000-4000-8000-00000000abcd"), a.paseo)).toMatchObject({ status: "missing" });
    expect(a.sent).toEqual([]);
  });

  it("gives the fill form the prompt with its project's name, and nothing once it is gone", async () => {
    const id = await create({ body: "检查 {{分支}}" });
    const projects = { list: vi.fn(async () => [{ projectId: "prj", projectDisplayName: "示例项目", projectRootPath: "/repo", projectKind: "git" }]) };
    const quick = new QuickPrompts(store, ledger, projects as never);
    expect(await quick.note({} as never, "prj", id)).toMatchObject({ id, projectName: "示例项目", body: "检查 {{分支}}" });
    expect(await quick.note({} as never, "prj", "00000000-0000-4000-8000-00000000abcd")).toBeNull();
  });

  it("a lost answer is asked about under the same ID only within one connection: the words promise no more", async () => {
    // From the security review (B8): the first send reached the daemon but its answer was lost. The same sender (this
    // connection) asks about the same message ID; a new one (after a reconnect) sends anew once the 10 s window passed.
    let clock = Date.now();
    const timed = new DeferredSend({ file: join(home, "timed.json"), lockDirectory: join(home, "timed-locks"), now: () => clock, capabilities: () => ({ steerable: [], slashSteerable: [] }) });
    try {
      const id = await create(), quick = new QuickPrompts(store, timed), a = daemon("example-acp", "idle"), ids: string[] = [];
      let drop = true;
      const rpc = async (input: Parameters<QuickPrompts["send"]>[0]) => { ids.push(input.messageId); const result = await quick.send(input, a.paseo); if (drop) { drop = false; throw new Error("lost response"); } return result; };
      const hooks = { notice: () => undefined, confirm: () => undefined, template: () => undefined, unconfirmed: (error: string) => `unconfirmed: ${error}`, notSent: (error: string) => `not sent: ${error}` };
      const press = { agentId: "agent-1", projectId: "prj", itemId: id }, connection = createQuickSender(rpc);
      await expect(connection(press, hooks)).rejects.toThrow("unconfirmed: lost response");
      expect(a.sent).toHaveLength(1);
      clock += 11_000;
      await connection(press, hooks);
      expect([ids[1] === ids[0], a.sent.length]).toEqual([true, 1]);
      await createQuickSender(rpc)(press, hooks);
      expect([ids[2] === ids[0], a.sent.length]).toEqual([false, 2]);
    } finally { timed.stop(); }
  });
});
