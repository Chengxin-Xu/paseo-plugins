import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { createElement } from "react";
import { DEFERRED_POLL_MS, deferredPollInterval, scheduledPollInterval } from "../client/deferred-state";
import type { DeferredView } from "../shared/deferred-rpc";

// 定时发送 (2.17) on the device: picking a time on this device's clock, and reading the ledger slowly while only scheduled
// messages wait.

const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const web = require("react-native-web");
const stubs: Record<string, unknown> = {
  "react-native": web,
  "@getpaseo/plugin/client/react-native": { Icon: ({ name }: { name: string }) => createElement("i", { "data-icon": name }), useToast: () => ({ show() {}, error() {} }),
    Modal: Object.assign(() => null, { Content: () => null }), ScrollView: web.ScrollView, TextInput: web.TextInput, FlatList: web.FlatList, copyText: async () => {} },
  "@getpaseo/plugin/client": { usePaseo: () => ({}), useRpc: () => async () => ({}) },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };
const theme = { colors: { surface0: "#ffffff", surface1: "#f4f4f5", surface2: "#e4e4e7", foreground: "#18181b", foregroundMuted: "#71717a", border: "#d4d4d8", accent: "#2563eb", accentForeground: "#ffffff" } };

const view = (state: DeferredView["state"], patch: Partial<DeferredView> = {}): DeferredView =>
  ({ messageId: "m", agentId: "a", key: "k", source: "快捷回复「继续做完」", preview: "继续做完。", createdAt: 1, at: 1, state, note: "", ...patch });

test("a picked clock time is on this device's day; past times and more than a week ahead are refused", async () => {
  const { scheduleAt, scheduleProblem } = await import("../client/schedule-send");
  const now = new Date(2026, 9, 15, 21, 30);
  assert.equal(scheduleAt(1, "09:00", now), new Date(2026, 9, 16, 9, 0).getTime());
  assert.equal(scheduleAt(0, "9:05", now), new Date(2026, 9, 15, 9, 5).getTime());
  assert.equal(scheduleAt(0, "23：15", now), new Date(2026, 9, 15, 23, 15).getTime(), "a full-width colon too");
  for (const bad of ["24:00", "9", "09:60", "nine"]) assert.equal(scheduleAt(0, bad, now), null, bad);
  assert.equal(scheduleProblem(null, now.getTime()), "时间写成 时:分，例如 09:30");
  assert.equal(scheduleProblem(scheduleAt(0, "09:05", now), now.getTime()), "这个时间已经过了");
  assert.equal(scheduleProblem(now.getTime() + 8 * 86_400_000, now.getTime()), "最多排到 7 天以后");
  assert.equal(scheduleProblem(scheduleAt(1, "09:00", now), now.getTime()), null);
});

test("the list names the next time still ahead: one sent with 立即发送 (due from the tap) or already due is not 下一条", async () => {
  const { nextScheduled } = await import("../client/schedule-send");
  const now = 5_000_000;
  assert.equal(nextScheduled([view("queued", { notBefore: now + 3_600_000 }), view("queued", { notBefore: now + 600_000 })], now), now + 600_000);
  assert.equal(nextScheduled([view("queued", { notBefore: now }), view("queued", { notBefore: now + 3_600_000 })], now), now + 3_600_000, "sent early: waiting for the agent only");
  assert.equal(nextScheduled([view("queued", { notBefore: now - 1 })], now), null);
  assert.equal(nextScheduled([], now), null);
});

test("a typed time is on its next day: later today stays today, an earlier one is tomorrow's", async () => {
  const { nextDayFor } = await import("../client/schedule-send");
  const morning = new Date(2026, 9, 15, 10, 5);
  assert.equal(nextDayFor("14:30", morning), 0, "later today");
  assert.equal(nextDayFor("09:00", morning), 1, "already past: tomorrow");
  assert.equal(nextDayFor("10:06", morning), 1, "within the minute the ledger would refuse: tomorrow");
  assert.equal(nextDayFor("nine", morning), 1);
  assert.equal(nextDayFor("09:00", new Date(2026, 9, 15, 7, 0)), 0, "the default 09:00 before nine is today");
});

test("only scheduled messages waiting: the ledger is read once a minute and just after the next one's time; others as before", () => {
  const now = 1_000_000;
  assert.equal(deferredPollInterval([view("queued")], true, now), DEFERRED_POLL_MS, "a plain queued message: as before");
  assert.equal(deferredPollInterval([view("queued", { notBefore: now + 3_600_000 })], true, now), false, "a scheduled one alone does not poll fast");
  assert.equal(scheduledPollInterval([view("queued", { notBefore: now + 3_600_000 })], true, now), 60_000);
  assert.equal(scheduledPollInterval([view("queued", { notBefore: now + 10_000 })], true, now), 13_000, "just after its time");
  assert.equal(scheduledPollInterval([view("queued", { notBefore: now + 1_000 })], true, now), DEFERRED_POLL_MS, "never faster than the usual poll");
  assert.equal(scheduledPollInterval([view("queued", { notBefore: now + 10_000 })], false, now), false, "never in the background");
  assert.equal(scheduledPollInterval([view("sent")], true, now), false);
});

test("a scheduled row names its time in sky blue with 立即发送 beside 取消; the picker offers the presets and a day and time", async () => {
  const { DeferredRow } = await import("../client/deferred");
  const { SchedulePicker } = await import("../client/schedule-send");
  const at = Date.now() + 2 * 3_600_000;
  const row = renderToString(createElement(DeferredRow as never, { theme, view: view("queued", { notBefore: at, note: "定时发送：到点后，等 Agent 这一轮结束、没有待审批时自动发送" }), busy: false, compact: false,
    onCancel() {}, onResume() {}, onSendNow() {}, agentTitle: "整理发布说明" } as never));
  assert.match(row, /定时 /);
  assert.match(row, /data-icon="AlarmClock"/);
  assert.match(row, /立即发送/);
  assert.match(row, /取消排队/);
  assert.match(row, /整理发布说明 · 快捷回复「继续做完」/);
  assert.doesNotMatch(row, /仍然发送/);
  const due = renderToString(createElement(DeferredRow as never, { theme, view: view("queued", { notBefore: Date.now() - 1_000 }), busy: false, compact: false, onCancel() {}, onResume() {}, onSendNow() {} } as never));
  assert.match(due, /排队中/, "once its time came it is an ordinary queued message");
  const picker = renderToString(createElement(SchedulePicker as never, { theme, onPick() {}, onClose() {} } as never));
  for (const label of ["30 分钟后", "1 小时后", "3 小时后", "指定时间"]) assert.ok(picker.includes(label), label);
  // What it cannot promise, said where the time is picked (A6, A7).
  assert.ok(picker.includes("之后你再和它说话，到点会先问你。Paseo 重启后，要等有设备打开 Paseo 才会补发。"));
});
