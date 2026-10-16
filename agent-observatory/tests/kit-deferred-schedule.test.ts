import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredSend, MAX_SCHEDULE_MS, type DeferredAgentSnapshot, type DeferredGuard, type DeferredPaseo } from "../server/deferred-send";
import { DeferredViewSchema, deferredSendContracts, isScheduled } from "../shared/deferred-rpc";

// The shared kit/deferred-send.ts, scheduled messages (`notBefore`, 定时发送): queued for a time, not delivered before it, then
// like any queued message. Messages without one behave as kit-deferred-send.test.ts has it.

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// A fake daemon as in kit-deferred-send.test.ts: snapshots, sends that start a turn and record the user message with our id.
function host(agents: Record<string, DeferredAgentSnapshot>) {
  let clock = Date.parse("2026-10-12T10:00:00Z");
  const sent: { agentId: string; text: string; options: { activeTurnBehavior: string; messageId: string } }[] = [];
  const timelines: Record<string, { item: { type: string; text: string; clientMessageId?: string }; timestamp: string }[]> = {};
  let others = 0;
  const record = (id: string, text: string, clientMessageId: string) => {
    (timelines[id] ??= []).push({ item: { type: "user_message", text, clientMessageId }, timestamp: new Date(clock).toISOString() });
    const agent = agents[id];
    if (agent) agent.lastUserMessageAt = new Date(clock).toISOString();
  };
  const paseo: DeferredPaseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => (agents[id] ? { agent: { ...agents[id] } } : null),
        send: async (text, options) => {
          sent.push({ agentId: id, text, options });
          record(id, text, options.messageId);
          const agent = agents[id];
          if (agent) Object.assign(agent, { status: "running", activeTurn: { turnId: `turn-${sent.length}` } });
        },
        timeline: { refetch: async () => ({ entries: [...(timelines[id] ?? [])] }) },
      }),
    },
  };
  const say = (id: string) => record(id, "someone else", `external-${++others}`);
  const rest = (id: string) => { Object.assign(agents[id]!, { status: "idle", activeTurn: null }); };
  return { agents, sent, paseo, say, rest, now: () => clock, tick: (ms: number) => { clock += ms; } };
}
type Host = ReturnType<typeof host>;

async function ledger(h: Host, options: Partial<ConstructorParameters<typeof DeferredSend>[0]> = {}, file?: string) {
  const at = file ?? join(await mkdtemp(join(tmpdir(), "kit-deferred-schedule-")), "plugin", "deferred-send.json");
  return { deferred: new DeferredSend({ file: at, pollMs: 3_600_000, now: h.now, log: () => undefined, ...options }), file: at };
}
const idle = (extra: Partial<DeferredAgentSnapshot> = {}): DeferredAgentSnapshot => ({ provider: "codex", status: "idle", lastUserMessageAt: "2026-10-12T09:00:00.000Z", ...extra });
const running = (extra: Partial<DeferredAgentSnapshot> = {}): DeferredAgentSnapshot => ({ ...idle(), status: "running", activeTurn: { turnId: "t1" }, ...extra });

test("the queue call takes an optional time and resume an optional now; views carry the time only when there is one", () => {
  const contracts = deferredSendContracts("demo");
  const input = { agentId: "a", text: "continue", messageId: "msg-sched-0", key: "k" };
  assert.deepEqual(contracts.enqueue.input.parse(input), input, "no time: the input is as before");
  assert.equal(contracts.enqueue.input.parse({ ...input, notBefore: 1_800_000_000_000 }).notBefore, 1_800_000_000_000);
  assert.throws(() => contracts.enqueue.input.parse({ ...input, notBefore: -5 }));
  assert.throws(() => contracts.enqueue.input.parse({ ...input, notBefore: 1.5 }));
  assert.deepEqual(contracts.resume.input.parse({ messageId: "m" }), { messageId: "m" });
  assert.deepEqual(contracts.resume.input.parse({ messageId: "m", now: true }), { messageId: "m", now: true });
  const view = { messageId: "m", agentId: "a", key: "k", source: "", preview: "x", createdAt: 1, at: 1, state: "queued" as const, note: "" };
  assert.deepEqual(DeferredViewSchema.parse(view), view);
  assert.equal(isScheduled(view, 0), false);
  assert.equal(isScheduled({ ...view, notBefore: 10 }, 5), true);
  assert.equal(isScheduled({ ...view, notBefore: 10 }, 10), false, "due at its time");
  assert.equal(isScheduled({ ...view, state: "held", notBefore: 10 }, 5), false, "held is not scheduled");
});

test("a scheduled message waits for its time even with the agent idle, then goes out with its id and steer options", async () => {
  const h = host({ a: idle() });
  const { deferred, file } = await ledger(h);
  const at = h.now() + 30 * MINUTE;
  const view = await deferred.enqueue({ agentId: "a", text: "继续", messageId: "msg-sched-1", notBefore: at }, h.paseo);
  assert.deepEqual([view.state, view.notBefore, isScheduled(view, h.now())], ["queued", at, true]);
  assert.match(view.note, /定时发送/);
  assert.equal(h.sent.length, 0, "an idle agent does not get it early");
  h.tick(29 * MINUTE);
  await deferred.flush();
  deferred.notify("a", h.paseo);
  await deferred.flush("a");
  assert.equal(h.sent.length, 0, "a minute before its time it still waits");
  const stored = JSON.parse(await readFile(file, "utf8")) as { messages: Array<{ notBefore?: number }> };
  assert.equal(stored.messages[0]?.notBefore, at, "the time is kept in the ledger file");
  h.tick(MINUTE);
  await deferred.flush();
  assert.deepEqual(h.sent, [{ agentId: "a", text: "继续", options: { activeTurnBehavior: "steer", messageId: "msg-sched-1" } }]);
  const [done] = await deferred.list({ agentId: "a" });
  assert.equal(done?.state, "sent");
});

test("at its time a scheduled message still waits for the turn to end and for approvals to be handled", async () => {
  const h = host({ a: running() });
  const { deferred } = await ledger(h);
  await deferred.enqueue({ agentId: "a", text: "跑全量测试", messageId: "msg-sched-2", notBefore: h.now() + HOUR }, h.paseo);
  h.tick(HOUR + MINUTE);
  await deferred.flush();
  assert.equal(h.sent.length, 0, "never into a running turn");
  Object.assign(h.agents.a!, { status: "idle", activeTurn: null, pendingPermissions: [{ id: "p1" }] });
  await deferred.flush();
  assert.equal(h.sent.length, 0, "never past a pending approval");
  h.agents.a!.pendingPermissions = [];
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["跑全量测试"]);
});

test("a schedule survives a restart: a new ledger on the same file keeps waiting, then sends", async () => {
  const h = host({ a: idle() });
  const { deferred, file } = await ledger(h);
  const at = h.now() + 3 * HOUR;
  await deferred.enqueue({ agentId: "a", text: "早上好，继续", messageId: "msg-sched-3", notBefore: at }, h.paseo);
  deferred.stop();
  const restarted = (await ledger(h, {}, file)).deferred;
  restarted.use(h.paseo);
  h.tick(2 * HOUR);
  await restarted.flush();
  assert.equal(h.sent.length, 0);
  const [waitingView] = await restarted.list();
  assert.deepEqual([waitingView?.state, waitingView?.notBefore], ["queued", at]);
  h.tick(HOUR);
  await restarted.flush();
  assert.deepEqual(h.sent.map((entry) => entry.options.messageId), ["msg-sched-3"]);
  restarted.stop();
});

test("a message not yet due does not hold up the agent's next message, nor is it held for the conversation moving on early", async () => {
  const h = host({ a: running() });
  const { deferred } = await ledger(h);
  await deferred.enqueue({ agentId: "a", text: "明早再做", messageId: "msg-sched-4a", notBefore: h.now() + 12 * HOUR }, h.paseo);
  h.tick(1_000);
  await deferred.enqueue({ agentId: "a", text: "这一轮之后", messageId: "msg-sched-4b" }, h.paseo);
  h.rest("a");
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["这一轮之后"], "the queued one goes; the scheduled one waits");
  // Someone else writes to the agent before the scheduled time: judged when it is due, not before.
  h.rest("a");
  h.say("a");
  h.tick(MINUTE);
  await deferred.flush();
  const early = (await deferred.list()).find((view) => view.messageId === "msg-sched-4a");
  assert.deepEqual([early?.state, isScheduled(early!, h.now())], ["queued", true]);
  h.tick(12 * HOUR);
  await deferred.flush();
  const due = (await deferred.list()).find((view) => view.messageId === "msg-sched-4a");
  assert.equal(due?.state, "held", "at its time the conversation has moved on: the user decides");
  assert.match(due?.note ?? "", /新消息/);
  assert.match(due?.note ?? "", /^这是定时消息：/, "the hold says it is the scheduled one (A7)");
  assert.equal(h.sent.length, 1);
});

test("held for the conversation moving on: a scheduled message's note says it is scheduled, a plain one's is as before (A7)", async () => {
  const h = host({ a: running() });
  const { deferred } = await ledger(h);
  await deferred.enqueue({ agentId: "a", text: "到点再发", messageId: "msg-sched-a7a", notBefore: h.now() + HOUR }, h.paseo);
  await deferred.enqueue({ agentId: "a", text: "这一轮之后再发", messageId: "msg-sched-a7b" }, h.paseo);
  h.rest("a");
  h.say("a");
  h.tick(HOUR);
  await deferred.flush();
  const views = Object.fromEntries((await deferred.list()).map((view) => [view.messageId, view]));
  assert.deepEqual([views["msg-sched-a7a"]?.state, views["msg-sched-a7b"]?.state], ["held", "held"]);
  assert.equal(views["msg-sched-a7a"]?.note, "这是定时消息：到点时发现排队之后会话里又有了新消息，还要发吗？");
  assert.equal(views["msg-sched-a7b"]?.note, "排队之后会话里又有了新消息，还要发吗？");
  assert.equal(h.sent.length, 0);
  deferred.stop();
});

test("a scheduled message has a day from its time, not from when it was queued; a plain one still a day from queueing", async () => {
  const h = host({ a: running(), b: running() });
  const { deferred } = await ledger(h);
  await deferred.enqueue({ agentId: "a", text: "三天后", messageId: "msg-sched-5a", notBefore: h.now() + 3 * DAY }, h.paseo);
  await deferred.enqueue({ agentId: "b", text: "这一轮之后", messageId: "msg-sched-5b" }, h.paseo);
  h.tick(DAY + MINUTE);
  await deferred.flush();
  const states = async () => Object.fromEntries((await deferred.list()).map((view) => [view.messageId, view.state]));
  assert.deepEqual(await states(), { "msg-sched-5a": "queued", "msg-sched-5b": "expired" });
  h.tick(2 * DAY + 23 * HOUR);
  await deferred.flush();
  assert.equal((await states())["msg-sched-5a"], "queued", "23 hours after its time it still waits for the busy agent");
  h.tick(2 * HOUR);
  await deferred.flush();
  const expired = (await deferred.list()).find((view) => view.messageId === "msg-sched-5a");
  assert.equal(expired?.state, "expired");
  assert.match(expired?.note ?? "", /到点后一天内/);
  assert.equal(h.sent.length, 0);
});

test("at most a week ahead; a time already past queues the message as usual, with no schedule", async () => {
  const h = host({ a: running() });
  const { deferred } = await ledger(h);
  assert.equal(MAX_SCHEDULE_MS, 7 * DAY);
  await assert.rejects(deferred.enqueue({ agentId: "a", text: "太远", messageId: "msg-sched-6a", notBefore: h.now() + 8 * DAY }, h.paseo), /7 天/);
  await assert.rejects(deferred.enqueue({ agentId: "a", text: "无效", messageId: "msg-sched-6c", notBefore: Number.NaN }, h.paseo), /无效/);
  const week = await deferred.enqueue({ agentId: "a", text: "一周", messageId: "msg-sched-6d", notBefore: h.now() + 7 * DAY }, h.paseo);
  assert.equal(week.state, "queued");
  const past = await deferred.enqueue({ agentId: "a", text: "刚过", messageId: "msg-sched-6b", notBefore: h.now() - MINUTE }, h.paseo);
  assert.equal(past.notBefore, undefined);
  assert.doesNotMatch(past.note, /定时/);
  h.rest("a");
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["刚过"]);
});

test("立即发送 drops the schedule and sends once the agent is free; resume without it keeps the time", async () => {
  const h = host({ a: idle(), b: running() });
  const { deferred } = await ledger(h);
  await deferred.enqueue({ agentId: "a", text: "现在就发", messageId: "msg-sched-7a", notBefore: h.now() + 2 * HOUR }, h.paseo);
  const kept = await deferred.resume("msg-sched-7a", h.paseo);
  assert.deepEqual([kept?.state, isScheduled(kept!, h.now())], ["queued", true], "a plain resume keeps the time");
  assert.equal(h.sent.length, 0);
  const now = await deferred.resume("msg-sched-7a", h.paseo, { now: true });
  assert.equal(now?.state, "sent");
  assert.equal(now?.notBefore, undefined, "a receipt carries no time");
  await deferred.enqueue({ agentId: "b", text: "等它空闲", messageId: "msg-sched-7b", notBefore: h.now() + 2 * HOUR }, h.paseo);
  const soon = await deferred.resume("msg-sched-7b", h.paseo, { now: true });
  assert.deepEqual([soon?.state, soon?.notBefore, isScheduled(soon!, h.now())], ["queued", h.now(), false], "due from the tap (still listed as scheduled), waiting for the turn");
  h.rest("b");
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => entry.text), ["现在就发", "等它空闲"]);
});

test("立即发送 on a message queued days ago waits a day from the tap, not from the queueing: busy agent, then sent once (B5)", async () => {
  const h = host({ a: running() });
  // The plugin's guard (a quick reply's turn) is checked at the send, as before the tap: the same guard, still holding.
  const checked: DeferredGuard[] = [];
  const check = ({ guard: value }: { agentId: string; guard: DeferredGuard; agent: DeferredAgentSnapshot }) => { checked.push(value); return null; };
  const { deferred, file } = await ledger(h, { guard: check });
  const guard = { prompt: "2026-10-12T09:00:00.000Z", round: "round-1" };
  await deferred.enqueue({ agentId: "a", text: "三天后再发", messageId: "msg-sched-b5", notBefore: h.now() + 3 * DAY, guard }, h.paseo);
  h.tick(2 * DAY);
  const tapped = h.now();
  const resumed = await deferred.resume("msg-sched-b5", h.paseo, { now: true });
  assert.deepEqual([resumed?.state, resumed?.notBefore], ["queued", tapped], "busy: queued, due from the tap");
  h.tick(20 * HOUR);
  await deferred.flush();
  assert.equal((await deferred.list({}))[0]?.state, "queued", "two days after queueing it still waits: its day started at the tap");
  h.rest("a");
  await deferred.flush();
  assert.deepEqual(h.sent.map((entry) => [entry.text, entry.options.messageId]), [["三天后再发", "msg-sched-b5"]], "sent once, under its own id");
  assert.deepEqual(checked.at(-1), guard, "its guard unchanged, checked right before the send");
  const stored = JSON.parse(await readFile(file, "utf8")) as { receipts: { messageId: string; state: string }[] };
  assert.equal(stored.receipts.find((receipt) => receipt.messageId === "msg-sched-b5")?.state, "sent");
  // Still busy a day after the tap: then it expires, as the note for scheduled messages says.
  const later = host({ b: running() });
  const second = await ledger(later, { guard: check });
  await second.deferred.enqueue({ agentId: "b", text: "也是三天后", messageId: "msg-sched-b5b", notBefore: later.now() + 3 * DAY, guard }, later.paseo);
  later.tick(2 * DAY);
  await second.deferred.resume("msg-sched-b5b", later.paseo, { now: true });
  later.tick(DAY + MINUTE);
  await second.deferred.flush();
  const expired = (await second.deferred.list({}))[0];
  assert.equal(expired?.state, "expired");
  assert.match(expired?.note ?? "", /定时发送/);
  assert.equal(later.sent.length, 0);
  // A message without a time: 立即发送 adds none, the same as a plain resume.
  const plain = host({ c: running() });
  const third = await ledger(plain);
  await third.deferred.enqueue({ agentId: "c", text: "普通排队", messageId: "msg-sched-b5c" }, plain.paseo);
  const view = await third.deferred.resume("msg-sched-b5c", plain.paseo, { now: true });
  assert.deepEqual([view?.state, view?.notBefore], ["queued", undefined]);
  for (const ledgerOf of [deferred, second.deferred, third.deferred]) ledgerOf.stop();
});

test("a guarded scheduled message is checked at its time: one the agent moved past is dropped, not sent", async () => {
  const h = host({ a: idle() });
  const rounds: Record<string, string> = { a: "round-1" };
  const seen: string[] = [];
  const guard = ({ guard: value }: { agentId: string; guard: DeferredGuard; agent: DeferredAgentSnapshot }) => { seen.push(String(value.round)); return value.round === rounds.a ? null : "它已经开始新的一轮"; };
  const { deferred } = await ledger(h, { guard });
  await deferred.enqueue({ agentId: "a", text: "继续，按你说的做", messageId: "msg-sched-8", group: "round-1", guard: { round: "round-1" }, notBefore: h.now() + HOUR }, h.paseo);
  assert.deepEqual(seen, ["round-1"], "checked when queued");
  rounds.a = "round-2";
  h.tick(HOUR);
  await deferred.flush();
  const [view] = await deferred.list();
  assert.equal(view?.state, "discarded");
  assert.match(view?.note ?? "", /新的一轮/);
  assert.equal(h.sent.length, 0);
});

test("without a time nothing changes: the stored message and its view have no schedule, and it goes out at once", async () => {
  const h = host({ a: idle(), b: running() });
  const { deferred, file } = await ledger(h);
  const sent = await deferred.enqueue({ agentId: "a", text: "hello", messageId: "msg-plain-1" }, h.paseo);
  assert.equal(sent.state, "sent");
  assert.equal("notBefore" in sent, false);
  const queued = await deferred.enqueue({ agentId: "b", text: "later", messageId: "msg-plain-2" }, h.paseo);
  assert.deepEqual(Object.keys(queued).sort(), ["agentId", "at", "createdAt", "key", "messageId", "note", "preview", "source", "state"]);
  assert.equal(queued.note, "已排队，等 Agent 这一轮结束、没有待审批时自动发送");
  const stored = JSON.parse(await readFile(file, "utf8")) as { messages: Array<Record<string, unknown>> };
  assert.equal("notBefore" in stored.messages[0]!, false);
  // A resume with and without now behaves the same for it.
  const resumed = await deferred.resume("msg-plain-2", h.paseo, { now: true });
  assert.equal(resumed?.state, "queued");
  assert.equal("notBefore" in (JSON.parse(await readFile(file, "utf8")) as { messages: Array<Record<string, unknown>> }).messages[0]!, false);
});

test("the ledger wakes by itself at the scheduled time (real timers)", async () => {
  const h = host({ a: idle() });
  const directory = await mkdtemp(join(tmpdir(), "kit-deferred-schedule-timer-"));
  const deferred = new DeferredSend({ file: join(directory, "plugin", "deferred-send.json"), pollMs: 3_600_000, log: () => undefined });
  try {
    await deferred.enqueue({ agentId: "a", text: "到点", messageId: "msg-sched-9", notBefore: Date.now() + 400 }, h.paseo);
    assert.equal(h.sent.length, 0);
    for (let waited = 0; waited < 8_000 && !h.sent.length; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(h.sent.map((entry) => entry.text), ["到点"], "sent near its time without a flush or a hook");
  } finally { deferred.stop(); }
});
