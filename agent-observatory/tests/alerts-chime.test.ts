import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type { AttentionState } from "../shared/attention-rpc";
import { alertSettingsSchema, chimeKindOf, defaultAlertSettings, type ChimeEvent } from "../shared/alerts";
import { chimeEvents } from "../server/attention";
import { normalizeAgent, type AgentRecord } from "../shared/model";
import type { AttentionPhase } from "../shared/attention";

// 提示音 (2.17): the resident chime (client/chime.ts) reads AppState from react-native, which node cannot load: stub it.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const stubs: Record<string, unknown> = { "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } } };
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };

const state = (events: ChimeEvent[] | null, quiet: { from: string; to: string } | null = null): AttentionState => ({
  count: events?.length ?? 0, truncated: false, blocking: 0, loud: 0, entries: [], scheduleFailures: null, ready: true, failed: false, revision: "r",
  chime: events ? { quiet, events } : null,
});
const event = (agent: string, tail: string, kind: ChimeEvent["kind"], turn = "t1"): ChimeEvent => ({ id: `${agent}|${tail}`, kind, turn });

test("each sound is a small valid 16-bit mono WAV the host's playAudio accepts, and the kinds sound different", async () => {
  const { chimeWav } = await import("../client/chime");
  const kinds = ["question", "approval", "quota", "error", "done"] as const, seen = new Set<string>();
  for (const kind of kinds) {
    const base64 = chimeWav(kind);
    // The host's own checks (Paseo 0.11.1 createPlayAudio): base64 only, padded to a multiple of 4.
    assert.match(base64, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(base64.length % 4, 0);
    const bytes = Buffer.from(base64, "base64");
    assert.equal(Buffer.from(bytes).toString("base64"), base64, "our encoder matches Node's");
    assert.equal(bytes.toString("latin1", 0, 4), "RIFF"); assert.equal(bytes.toString("latin1", 8, 16), "WAVEfmt "); assert.equal(bytes.toString("latin1", 36, 40), "data");
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
    assert.deepEqual([bytes.readUInt16LE(20), bytes.readUInt16LE(22), bytes.readUInt32LE(24), bytes.readUInt32LE(28), bytes.readUInt16LE(32), bytes.readUInt16LE(34)], [1, 1, 16_000, 32_000, 2, 16]);
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
    const samples = (bytes.length - 44) / 2;
    assert.ok(samples > 3_000 && samples < 12_000, `${kind}: ${samples} samples (a short sound)`);
    let peak = 0;
    for (let index = 0; index < samples; index++) peak = Math.max(peak, Math.abs(bytes.readInt16LE(44 + index * 2)));
    assert.ok(peak > 8_000 && peak < 32_767, `${kind}: audible, never clipped (${peak})`);
    assert.ok(base64.length < 32_000, "a few kilobytes");
    seen.add(base64);
  }
  assert.equal(seen.size, kinds.length);
});

test("quiet hours on the device's clock, overnight included", async () => {
  const { inQuietHours } = await import("../client/chime");
  const at = (hours: number, minutes = 0) => new Date(2026, 9, 15, hours, minutes);
  assert.equal(inQuietHours(null, at(3)), false);
  assert.equal(inQuietHours({ from: "22:00", to: "08:00" }, at(23, 30)), true);
  assert.equal(inQuietHours({ from: "22:00", to: "08:00" }, at(7, 59)), true);
  assert.equal(inQuietHours({ from: "22:00", to: "08:00" }, at(8, 0)), false, "the end is not quiet any more");
  assert.equal(inQuietHours({ from: "22:00", to: "08:00" }, at(12)), false);
  assert.equal(inQuietHours({ from: "12:30", to: "14:00" }, at(12, 30)), true);
  assert.equal(inQuietHours({ from: "12:30", to: "14:00" }, at(14, 0)), false);
  assert.equal(inQuietHours({ from: "09:00", to: "09:00" }, at(9)), false, "the same time twice is no quiet hours");
});

function harness(options: { muted?: boolean; active?: boolean } = {}) {
  let clock = Date.parse("2026-10-15T12:00:00Z");
  const played: string[] = [];
  const flags = { muted: options.muted ?? false, active: options.active ?? true };
  const play = async (source: { base64: string; mimeType: string }) => { played.push(source.mimeType); };
  return { played, flags, play, now: () => clock, tick: (ms: number) => { clock += ms; } };
}
const kindsPlayed = async (h: ReturnType<typeof harness>, chime: { onRead(hostId: string, state: AttentionState): void }, host: string, value: AttentionState) => { const before = h.played.length; chime.onRead(host, value); return h.played.length - before; };

test("what is there when the chime starts listening never sounds; each new event sounds once per device", async () => {
  const { createChime } = await import("../client/chime");
  const h = harness(), chime = createChime(h.play, { now: h.now, active: () => h.flags.active, muted: () => h.flags.muted });
  const host = `host-${Math.random()}`;
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p1", "approval")])), 0, "the baseline");
  h.tick(30_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p1", "approval"), event("b", "error|2026", "error", "t9")])), 1, "a new one sounds");
  h.tick(30_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p1", "approval"), event("b", "error|2026", "error", "t9")])), 0, "never twice");
  // A reconnect makes a new chime: the same app session remembers what sounded.
  const again = createChime(h.play, { now: h.now, active: () => true, muted: () => false });
  assert.equal(await kindsPlayed(h, again, host, state([event("a", "request|p1", "approval"), event("b", "error|2026", "error", "t9")])), 0);
  assert.equal(h.played[0], "audio/wav");
});

test("one turn sounds at most once in 15 seconds; another turn or Agent sounds at once", async () => {
  const { createChime } = await import("../client/chime");
  const h = harness(), chime = createChime(h.play, { now: h.now, active: () => true, muted: () => false }), host = `host-${Math.random()}`;
  chime.onRead(host, state([]));
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p1", "approval", "turn-1")])), 1);
  h.tick(5_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p1", "approval", "turn-1"), event("a", "request|p2", "approval", "turn-1")])), 0, "the same turn 5 s later");
  h.tick(1_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p3", "question", "turn-1"), event("b", "request|q1", "question", "turn-7")])), 1, "another Agent's turn");
  h.tick(15_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "request|p4", "approval", "turn-1")])), 1, "15 s after its last sound the turn may sound again");
});

test("muted, in the background or in quiet hours: nothing sounds, and those events do not sound later", async () => {
  const { createChime } = await import("../client/chime");
  const h = harness(), chime = createChime(h.play, { now: h.now, active: () => h.flags.active, muted: () => h.flags.muted }), host = `host-${Math.random()}`;
  chime.onRead(host, state([]));
  h.flags.muted = true;
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "x|1", "error")])), 0);
  h.flags.muted = false; h.flags.active = false; h.tick(20_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "x|1", "error"), event("b", "x|2", "error", "t2")])), 0);
  h.flags.active = true; h.tick(20_000);
  const hour = new Date(h.now()).getHours(), quiet = { from: `${String(hour).padStart(2, "0")}:00`, to: `${String((hour + 1) % 24).padStart(2, "0")}:00` };
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "x|1", "error"), event("b", "x|2", "error", "t2"), event("c", "x|3", "quota", "t3")], quiet)), 0, "quiet hours");
  h.tick(20_000);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "x|1", "error"), event("b", "x|2", "error", "t2"), event("c", "x|3", "quota", "t3")])), 0, "nothing sounds late");
});

test("turning the chime off forgets the baseline; on again, what is there stays quiet; several at once sound the most urgent kind", async () => {
  const { createChime } = await import("../client/chime");
  const h = harness(), chime = createChime(h.play, { now: h.now, active: () => true, muted: () => false }), host = `host-${Math.random()}`;
  const holds: string[] = [];
  const store = { subscribe: () => { holds.push("on"); return () => holds.push("off"); } };
  chime.onRead(host, state([]), store);
  assert.deepEqual(holds, ["on"], "while it is on, the summary keeps polling without a badge on screen");
  chime.onRead(host, state(null), store);
  assert.deepEqual(holds, ["on", "off"]);
  chime.onRead(host, state([event("a", "x|1", "done")]), store);
  assert.equal(await kindsPlayed(h, chime, host, state([event("a", "x|1", "done")])), 0, "on again: a new baseline");
  const order: string[] = [];
  const recording = createChime(async source => { order.push(source.base64); }, { now: h.now, active: () => true, muted: () => false });
  const other = `host-${Math.random()}`;
  recording.onRead(other, state([]));
  recording.onRead(other, state([event("a", "x|9", "done", "t1"), event("b", "x|8", "quota", "t2"), event("c", "x|7", "approval", "t3")]));
  const { chimeWav } = await import("../client/chime");
  assert.deepEqual(order, [chimeWav("approval")], "one sound for the read: the most urgent");
  chime.dispose();
});

const agent = (id: string, patch: Partial<AgentRecord> = {}): AgentRecord => ({ ...normalizeAgent({ id, status: "idle" }), ...patch });
const waiting = (record: AgentRecord, phase: AttentionPhase, since: string | null = "2026-10-15T10:00:00.000Z") => ({ agent: record, phase, rank: 0, since });

test("the server's events: one per pending request, else one per time an Agent started waiting; silenced kinds and subagents left out", () => {
  const settings = alertSettingsSchema.parse({ chime: true, quietFrom: "22:00", quietTo: "07:30" });
  const asking = agent("a", { pending: [{ kind: "question", title: "Merge?", detail: null, options: [], requestId: "req-1" }], pendingPermissionCount: 1, activeTurnStartedAt: null, observedTurnStartedAt: "2026-10-15T09:59:00.000Z" });
  const approving = agent("b", { pending: [{ kind: "tool", title: "Run", detail: "npm test", options: [], requestId: "req-2" }, { kind: "plan", title: "Plan", detail: null, options: [], requestId: "req-3" }], pendingPermissionCount: 2 });
  const failed = agent("c", { lastUserMessageAt: "2026-10-15T09:00:00.000Z" });
  const child = agent("d", { parentAgentId: "a" });
  const done = agent("e");
  const result = chimeEvents([waiting(asking, "question"), waiting(approving, "approval"), waiting(failed, "error", "2026-10-15T09:30:00.000Z"), waiting(child, "error"), waiting(done, "unread")], settings);
  assert.deepEqual(result.quiet, { from: "22:00", to: "07:30" });
  assert.deepEqual(result.events, [
    { id: "a|request|req-1", kind: "question", turn: "2026-10-15T09:59:00.000Z" },
    { id: "b|request|req-2", kind: "approval", turn: "" },
    { id: "b|request|req-3", kind: "approval", turn: "" },
    { id: "c|error|2026-10-15T09:30:00.000Z", kind: "error", turn: "2026-10-15T09:00:00.000Z" },
  ], "results (done) are off by default, subagents too");
  const all = chimeEvents([waiting(child, "error"), waiting(done, "unread")], { ...settings, chimeDone: true, chimeSubagents: true, chimeError: false, quietFrom: "", quietTo: "" });
  assert.deepEqual(all, { quiet: null, events: [{ id: "e|unread|2026-10-15T10:00:00.000Z", kind: "done", turn: "" }] });
  assert.equal(chimeEvents(Array.from({ length: 80 }, (_, index) => waiting(agent(`x${index}`), "error")), settings).events.length, 64, "bounded");
});

test("which sound a phase makes, and the settings a new install starts with (everything off)", () => {
  assert.deepEqual((["question", "approval", "plan", "error", "silent", "unfinished", "quota", "idle", "unread"] as const).map(chimeKindOf),
    ["question", "approval", "approval", "error", "error", "error", "quota", "done", "done"]);
  assert.equal(defaultAlertSettings.chime, false);
  assert.equal(defaultAlertSettings.sidebarLabels, false);
  assert.equal(defaultAlertSettings.sidebarPin, false);
  assert.throws(() => alertSettingsSchema.parse({ quietFrom: "25:00" }));
});
