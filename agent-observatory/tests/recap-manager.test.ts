import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecapManager, registerRecaps, type RecapManagerOptions } from "../server/recap";
import type { AgentTimelineItem, PaseoApi } from "../server/paseo-types";
import { RECAP_DEFAULTS, recapSettings, type RecapSettings } from "../shared/recap";
import { bindTranslator, createTranslator } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const ON: RecapSettings = { enabled: true, suggestions: true, runner: { kind: "grok" } };
const T1 = "2026-10-15T01:00:00.000Z", T2 = "2026-10-15T01:05:00.000Z";
const conversation: AgentTimelineItem[] = [{ type: "user_message", text: "把存储层拆出来" }, { type: "assistant_message", text: "已拆出 storage 包，测试通过。要我接着改调用方吗？" }];
const answer = (summary = "拆分存储层：已拆出并通过测试", next: string | null = "改调用方", reply: string | null = "继续改调用方") => JSON.stringify({ structured_output: { summary, next, reply } });
const agent = (id: string, extra: Partial<{ parentAgentId: string | null; title: string | null }> = {}) => ({ id, parentAgentId: null, title: `任务 ${id}`, ...extra });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(5); }
  assert.fail(`timed out waiting for ${what}`);
}

/** A manager over a scratch directory, a fake host (one snapshot per Agent) and a fake Grok CLI the test answers. */
async function fixture(options: Partial<RecapManagerOptions> & { binary?: string | null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-recap-"));
  const snapshots = new Map<string, Record<string, unknown>>();
  const snapshotOf = (id: string) => snapshots.get(id) ?? { id, status: "idle", archivedAt: null, labels: {}, pendingPermissions: [], cwd: "/work", workspaceId: "w1", title: `任务 ${id}` };
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: snapshotOf(id) }) }) } } as unknown as PaseoApi;
  const calls: Array<{ prompt: string; model?: string; effort?: string; settle: (output: string | Error) => void; signal: AbortSignal }> = [];
  let auto: string | Error | null = answer();
  const runGrok: RecapManagerOptions["runGrok"] = input => new Promise<string>((resolve, reject) => {
    const settle = (output: string | Error) => output instanceof Error ? reject(output) : resolve(output);
    calls.push({ prompt: input.prompt, model: input.model, effort: input.effort, settle, signal: input.signal });
    input.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
    if (auto !== null) settle(auto);
  });
  let turn: { startedAt: string | null; endedAt: string | null } | null = { startedAt: T1, endedAt: T2 };
  const create = () => new RecapManager({ directory, quietMs: 20, findBinary: async () => options.binary === undefined ? "/fake/grok" : options.binary, runGrok,
    observedTurn: async () => turn, ...options });
  const manager = create();
  return {
    directory, paseo, snapshots, calls, manager, create,
    /** Answer every run at once with this (null: the test settles each call itself). */ answerWith(output: string | Error | null) { auto = output; },
    observe(next: typeof turn) { turn = next; },
    end(id = "a", timeline = conversation, outcome = "completed", extra: Partial<{ parentAgentId: string | null; title: string | null }> = {}) { manager.turnEnded(paseo, agent(id, extra), outcome, timeline); },
    async list() { const list = await manager.list(); assert.equal(list.mode, "full"); return list as Extract<typeof list, { mode: "full" }>; },
    async close() { await manager.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("off on a new install: a turn's end writes nothing, the list is empty and no file is created", async () => {
  assert.deepEqual(recapSettings.schema.parse({}), RECAP_DEFAULTS);
  assert.deepEqual(RECAP_DEFAULTS, { enabled: false, suggestions: false, runner: { kind: "grok" } });
  const f = await fixture();
  try {
    await f.manager.configure(RECAP_DEFAULTS);
    f.end("a");
    await wait(80);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.list(), { mode: "full", revision: (await f.list()).revision, enabled: false, suggestions: false, recaps: [] });
    await f.manager.close();
    await assert.rejects(stat(join(f.directory, "recaps.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("a top-level Agent's normal turn gets one recap after the quiet time, at low effort, naming the turn it describes", async () => {
  const f = await fixture();
  try {
    await f.manager.configure(ON);
    f.answerWith(null);
    f.end("a");
    assert.equal((await f.list()).recaps[0]?.state, "pending", "更新中 from the turn's end");
    await until(() => f.calls.length === 1, "the run");
    assert.equal((await f.list()).recaps[0]?.state, "generating");
    assert.deepEqual([f.calls[0]!.model, f.calls[0]!.effort], ["grok-4.7", "low"]);
    assert.ok(f.calls[0]!.prompt.includes("User: 把存储层拆出来"));
    f.calls[0]!.settle(answer());
    await until(async () => (await f.list()).recaps[0]?.state === "idle", "the recap");
    const [recap] = (await f.list()).recaps;
    assert.deepEqual({ ...recap, at: null }, { agentId: "a", summary: "拆分存储层：已拆出并通过测试", next: "改调用方", reply: "继续改调用方", at: null, roundAt: T1, endedAt: T2, stale: false, state: "idle", runner: "Grok 4.7 · low" });
    // An unchanged list costs a few bytes.
    const again = await f.manager.list((await f.list()).revision);
    assert.equal(again.mode, "unchanged");
    await wait(60);
    assert.equal(f.calls.length, 1, "one try per turn");
  } finally { await f.close(); }
});

test("a new turn within the quiet time cancels the recap; a new turn marks the old one out of date and drops its reply", async () => {
  const f = await fixture();
  try {
    await f.manager.configure(ON);
    f.end("a");
    f.manager.turnStarted("a");
    await wait(80);
    assert.equal(f.calls.length, 0, "the quiet time was broken");
    f.end("a");
    await until(async () => (await f.list()).recaps[0]?.summary !== undefined && (await f.list()).recaps[0]?.state === "idle" && f.calls.length === 1, "the recap");
    f.manager.turnStarted("a");
    const [stale] = (await f.list()).recaps;
    assert.deepEqual([stale!.stale, stale!.reply, stale!.summary], [true, null, "拆分存储层：已拆出并通过测试"]);
  } finally { await f.close(); }
});

test("no recap for subagents, failed or cancelled turns, a turn that ended on a tool call, a compaction under way, or a request waiting", async () => {
  const f = await fixture();
  try {
    await f.manager.configure(ON);
    f.end("child", conversation, "completed", { parentAgentId: "a" });
    f.end("failed", conversation, "failed");
    f.end("canceled", conversation, "canceled");
    f.end("tool", [...conversation, { type: "tool_call", callId: "c", name: "shell", status: "completed", error: null, detail: { type: "shell", command: "ls" } } as unknown as AgentTimelineItem]);
    f.end("compacting", [...conversation, { type: "compaction", status: "loading" } as AgentTimelineItem]);
    f.end("asking");
    f.manager.permissionRequested("asking", "plan-1");
    // The host says it is running again, or waits on an approval, or is an analysis helper: checked just before the run.
    f.snapshots.set("busy", { id: "busy", status: "running", archivedAt: null, labels: {}, pendingPermissions: [] });
    f.snapshots.set("approval", { id: "approval", status: "idle", archivedAt: null, labels: {}, pendingPermissions: [{ id: "p" }] });
    f.snapshots.set("helper", { id: "helper", status: "idle", archivedAt: null, labels: { "observatory.role": "insight" }, pendingPermissions: [] });
    for (const id of ["busy", "approval", "helper"]) f.end(id);
    await wait(120);
    assert.equal(f.calls.length, 0);
    assert.deepEqual((await f.list()).recaps, []);
  } finally { await f.close(); }
});

test("at most two recaps run at once; the rest wait their turn (newest turn per Agent)", async () => {
  const f = await fixture();
  try {
    await f.manager.configure(ON);
    f.answerWith(null);
    for (const id of ["a", "b", "c"]) f.end(id);
    await until(() => f.calls.length === 2, "two runs");
    await wait(60);
    assert.equal(f.calls.length, 2, "the third waits");
    const states = new Map((await f.list()).recaps.map(view => [view.agentId, view.state]));
    assert.deepEqual([states.get("a"), states.get("b"), states.get("c")], ["generating", "generating", "pending"]);
    // Its Agent moves on while it waits: it never runs.
    f.manager.turnStarted("c");
    f.calls[0]!.settle(answer());
    await wait(60);
    assert.equal(f.calls.length, 2);
    f.end("c");
    await until(() => f.calls.length === 3, "c after a slot frees");
    f.calls[1]!.settle(answer()); f.calls[2]!.settle(answer());
    await until(async () => (await f.list()).recaps.every(view => view.state === "idle" && view.summary), "all written");
  } finally { await f.close(); }
});

test("a failure is not retried for that turn and pauses new recaps with a growing backoff; nothing is shown for it", async () => {
  let now = Date.parse("2026-10-15T02:00:00Z");
  const f = await fixture({ now: () => now });
  try {
    await f.manager.configure(ON);
    f.answerWith(new Error("Grok CLI exited"));
    f.end("a");
    await until(async () => (await f.manager.status(f.paseo)).lastOutcome === "failed", "the failure");
    assert.equal(f.calls.length, 1);
    const status = await f.manager.status(f.paseo);
    assert.deepEqual([status.problem, status.until], ["backoff", "2026-10-15T02:01:00.000Z"]);
    assert.deepEqual((await f.list()).recaps, [], "a failure shows nothing");
    f.end("b");
    await wait(80);
    assert.equal(f.calls.length, 1, "paused");
    now += 61_000;
    f.answerWith(new Error("again"));
    f.end("b");
    await until(() => f.calls.length === 2, "the next try after the pause");
    await until(async () => (await f.manager.status(f.paseo)).until === "2026-10-15T02:03:01.000Z", "a doubled pause");
    now += 121_000;
    f.answerWith(answer());
    f.end("c");
    await until(async () => (await f.list()).recaps.length === 1, "a written recap");
    assert.equal((await f.manager.status(f.paseo)).problem, null, "a success ends the pause");
  } finally { await f.close(); }
});

test("without the Grok CLI recaps wait quietly and the settings say why", async () => {
  const f = await fixture({ binary: null });
  try {
    await f.manager.configure(ON);
    f.end("a");
    await wait(80);
    assert.equal(f.calls.length, 0);
    assert.deepEqual((await f.list()).recaps, []);
    const status = await f.manager.status(f.paseo);
    assert.deepEqual([status.available, status.problem, status.runner], [false, "grok", "Grok 4.7 · low"]);
  } finally { await f.close(); }
});

test("a profile or provider runs as the analyses' temporary sub-agent of the Agent, titled as a summary", async () => {
  const runs: unknown[] = [];
  const f = await fixture({
    registry: () => ({ resolve: async runner => ({ info: { kind: "profile", label: "Fast Profile", provider: "my-provider", model: "small", thinkingOptionId: "low", modeId: "plan", sessionAgentId: null }, model: "small", effort: "low", access: "read", featureValues: {} } as never) }),
    runPaseo: (async (input: { parent: unknown; title?: string; prompt: string; parse: (text: string) => unknown; schema: unknown }) => {
      runs.push({ parent: input.parent, title: input.title });
      return { value: input.parse(JSON.stringify({ summary: "用 Profile 写的小结", next: null, reply: null })), usage: null, runner: {} };
    }) as unknown as RecapManagerOptions["runPaseo"],
  });
  try {
    await f.manager.configure({ ...ON, runner: { kind: "profile", profileId: "fast" } });
    f.end("a");
    await until(async () => (await f.list()).recaps[0]?.summary === "用 Profile 写的小结", "the recap");
    assert.deepEqual(runs, [{ parent: { id: "a", cwd: "/work", workspaceId: "w1", archived: false, title: "任务 a" }, title: "小结 · 任务 a" }]);
    assert.equal((await f.list()).recaps[0]!.runner, "Fast Profile");
    assert.equal(f.calls.length, 0, "the Grok CLI is not used");
  } finally { await f.close(); }
});

test("a profile or another model writes an Agent's recap at most once per cooldown, for its latest turn; the Grok CLI waits for nothing (A3)", async () => {
  const runs: Array<{ prompt: string; at: number }> = [];
  const f = await fixture({
    helperCooldownMs: 600,
    registry: () => ({ resolve: async () => ({ info: { kind: "profile", label: "Fast Profile", provider: "my-provider", model: "small", thinkingOptionId: "low", modeId: "plan", sessionAgentId: null }, model: "small", effort: "low", access: "read", featureValues: {} } as never) }),
    runPaseo: (async (input: { prompt: string; parse: (text: string) => unknown }) => {
      runs.push({ prompt: input.prompt, at: Date.now() });
      return { value: input.parse(JSON.stringify({ summary: `第 ${runs.length} 份小结`, next: null, reply: null })), usage: null, runner: {} };
    }) as unknown as RecapManagerOptions["runPaseo"],
  });
  const turn = (text: string): AgentTimelineItem[] => [{ type: "user_message", text }, { type: "assistant_message", text: `${text}已完成` }];
  try {
    await f.manager.configure({ ...ON, runner: { kind: "profile", profileId: "fast" } });
    f.end("a", turn("第一轮"));
    await until(async () => (await f.list()).recaps[0]?.summary === "第 1 份小结", "the first recap");
    // Two more turns within the cooldown: nothing runs, and the old recap shows as out of date, not as being written.
    for (const text of ["第二轮", "第三轮"]) { f.manager.turnStarted("a"); f.end("a", turn(text)); await wait(60); }
    assert.equal(runs.length, 1);
    const waiting = (await f.list()).recaps.find(view => view.agentId === "a")!;
    assert.equal(waiting.state, "idle");
    assert.equal(waiting.stale, true);
    // Once it is over: one run, for the latest turn.
    await until(() => runs.length === 2, "the run after the cooldown", 3000);
    assert.ok(runs[1]!.at - runs[0]!.at >= 590, `${runs[1]!.at - runs[0]!.at} ms apart`);
    assert.match(runs[1]!.prompt, /第三轮/);
    assert.doesNotMatch(runs[1]!.prompt, /第二轮/);
    await until(async () => (await f.list()).recaps[0]?.summary === "第 2 份小结", "the second recap");
    await wait(700);
    assert.equal(runs.length, 2, "nothing more without a new turn");
    // The Grok CLI leaves no sub-agent: every turn gets its recap.
    await f.manager.configure(ON);
    for (const [index, text] of ["第四轮", "第五轮"].entries()) {
      f.manager.turnStarted("a"); f.end("a", turn(text));
      await until(() => f.calls.length === index + 1, `the Grok run for ${text}`, 1000);
    }
    assert.equal(runs.length, 2);
  } finally { await f.close(); }
});

test("the recap is written in the plugin's language: English instructions ask for English and words", async () => {
  bindTranslator(createTranslator("en", [en, kitEn]));
  const f = await fixture();
  try {
    await f.manager.configure(ON);
    f.end("a");
    await until(() => f.calls.length === 1, "the run");
    assert.match(f.calls[0]!.prompt, /Write it in English, at most 20 words/);
  } finally { bindTranslator(createTranslator("zh-CN", [zh, kitZh])); await f.close(); }
  const chinese = await fixture();
  try {
    await chinese.manager.configure(ON);
    chinese.end("a");
    await until(() => chinese.calls.length === 1, "the run");
    assert.match(chinese.calls[0]!.prompt, /Write it in 简体中文, at most 25 characters/);
  } finally { await chinese.close(); }
});

test("suggestions off: no reply is kept or listed; turned off later, stored replies go", async () => {
  const f = await fixture();
  try {
    await f.manager.configure({ ...ON, suggestions: false });
    f.end("a");
    await until(async () => (await f.list()).recaps[0]?.summary !== undefined && (await f.list()).recaps[0]?.state === "idle", "the recap");
    assert.equal((await f.list()).recaps[0]!.reply, null);
    assert.match(f.calls[0]!.prompt, /reply: always null\./);
    await f.manager.configure(ON);
    f.end("b");
    await until(async () => (await f.list()).recaps.find(view => view.agentId === "b")?.reply === "继续改调用方", "b's reply");
    await f.manager.configure({ ...ON, suggestions: false });
    assert.equal((await f.list()).recaps.every(view => view.reply === null), true);
  } finally { await f.close(); }
});

test("recaps persist privately and come back after a reload; archiving, turning off and the host forgetting an Agent remove them", async () => {
  const f = await fixture();
  try {
    await f.manager.configure(ON);
    for (const id of ["a", "b", "c"]) f.end(id);
    await until(async () => (await f.list()).recaps.filter(view => view.summary).length === 3, "three recaps");
    await f.manager.close();
    const file = join(f.directory, "recaps.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    const reloaded = f.create();
    await reloaded.configure(ON);
    assert.equal(((await reloaded.list()) as { recaps: unknown[] }).recaps.length, 3);
    reloaded.archived("a");
    assert.deepEqual(((await reloaded.list()) as { recaps: Array<{ agentId: string }> }).recaps.map(view => view.agentId).sort(), ["b", "c"]);
    await reloaded.close();
    // The host's directory, read after they were written, no longer lists b: deleted.
    const pruned = new RecapManager({ directory: f.directory, directoryAgents: () => ({ loaded: true, truncated: false, refreshedAt: Date.now() + 1000, agents: [{ id: "c", archivedAt: null }] }) });
    await pruned.configure(ON);
    assert.deepEqual(((await pruned.list()) as { recaps: Array<{ agentId: string }> }).recaps.map(view => view.agentId), ["c"]);
    // Turning recaps off deletes them all, the file too.
    await pruned.configure({ ...ON, enabled: false });
    await pruned.close();
    await assert.rejects(stat(file), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a damaged recap file is set aside once and the store starts empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-recap-bad-"));
  try {
    await writeFile(join(directory, "recaps.json"), "{not json", { mode: 0o600 });
    const manager = new RecapManager({ directory });
    await manager.configure(ON);
    assert.deepEqual(((await manager.list()) as { recaps: unknown[] }).recaps, []);
    assert.equal(await readFile(join(directory, "recaps.json.backup"), "utf8"), "{not json");
    await manager.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const stored = (agentId: string, at: number) => ({ agentId, summary: `PRIVATE SUMMARY ${agentId}`, next: null, reply: null, at: new Date(at).toISOString(), roundAt: null, endedAt: null, stale: false, runner: "mock" });
const DAY = 86_400_000;

test("turning recaps off deletes the file and every copy of it, even when every recap in it had expired (B4)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-recap-off-"));
  const file = join(directory, "recaps.json"), now = Date.now();
  try {
    // Only expired recaps: memory holds nothing once loaded, the file still holds them.
    await writeFile(file, JSON.stringify({ version: 1, recaps: [stored("a", now - 45 * DAY)] }), { mode: 0o600 });
    const expired = new RecapManager({ directory, findBinary: async () => null });
    await expired.configure({ ...ON, enabled: false });
    await expired.close();
    assert.deepEqual(await readdir(directory), []);
    // A damaged file set aside as the backup, and the temporary file of a write a crash cut short.
    await writeFile(file, JSON.stringify({ version: 1, recaps: [stored("b", now - DAY)] }) + "broken", { mode: 0o600 });
    await writeFile(join(directory, `recaps.json.${randomUUID()}.tmp`), JSON.stringify({ version: 1, recaps: [stored("c", now)] }), { mode: 0o600 });
    const damaged = new RecapManager({ directory, findBinary: async () => null });
    await damaged.ready;
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".backup")), ["recaps.json.backup"]);
    await damaged.configure({ ...ON, enabled: false });
    assert.deepEqual(await readdir(directory), []);
    await damaged.close();
    assert.deepEqual(await readdir(directory), [], "nothing written back after the deletion");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recaps dropped when the file loads leave the disk at once; a file with nothing to drop is left alone (B4)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-recap-load-"));
  const file = join(directory, "recaps.json"), now = Date.now();
  try {
    await writeFile(file, JSON.stringify({ version: 1, recaps: [stored("fresh", now - DAY), stored("old", now - 31 * DAY), { agentId: "damaged" }] }), { mode: 0o600 });
    // The setting unread (recaps paused, nothing forgotten): the load alone rewrites the file.
    const manager = new RecapManager({ directory, findBinary: async () => null });
    await until(async () => JSON.parse(await readFile(file, "utf8")).recaps.length === 1, "the file rewritten without the dropped recaps");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).recaps.map((recap: { agentId: string }) => recap.agentId), ["fresh"]);
    assert.equal((await readFile(file, "utf8")).includes("PRIVATE SUMMARY old"), false);
    await manager.close();
    const before = await stat(file);
    const again = new RecapManager({ directory, findBinary: async () => null });
    await again.ready;
    await again.close();
    assert.equal((await stat(file)).ino, before.ino, "not rewritten");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a set-aside copy or a cut-short write older than 30 days goes when the store loads; newer ones stay while recaps are on (B4)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-recap-leftover-"));
  const backup = join(directory, "recaps.json.backup"), oldTemp = join(directory, `recaps.json.${randomUUID()}.tmp`), newTemp = join(directory, `recaps.json.${randomUUID()}.tmp`);
  try {
    for (const path of [backup, oldTemp, newTemp]) await writeFile(path, "PRIVATE SUMMARY", { mode: 0o600 });
    const old = new Date(Date.now() - 31 * DAY);
    for (const path of [backup, oldTemp]) await utimes(path, old, old);
    await writeFile(join(directory, "other.json"), "{}", { mode: 0o600 });
    const manager = new RecapManager({ directory, findBinary: async () => null });
    await manager.configure(ON);
    assert.deepEqual((await readdir(directory)).sort(), [newTemp.slice(directory.length + 1), "other.json"].sort());
    await writeFile(backup, "PRIVATE SUMMARY", { mode: 0o600 });
    await manager.configure({ ...ON, enabled: false });
    await manager.close();
    assert.deepEqual(await readdir(directory), ["other.json"], "turned off: every copy goes, other files stay");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("turning recaps off cancels a run under way; the setting reaches the manager through the host's settings", async () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>(), listeners = new Set<(state: unknown) => void>(), hooks = new Map<string, (input: unknown, context: unknown) => unknown>();
  let values: unknown = { enabled: true, suggestions: true, runner: { kind: "grok" } };
  const host = {
    registerSettings: (definition: { id: string }) => { assert.equal(definition.id, "recap"); return { read: async () => ({ status: "ready", revision: "1", values }), subscribe(listener: (state: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); } }; },
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => { handlers.set(contract.name, handler); },
    on: (name: string, handler: (input: unknown, context: unknown) => unknown) => { hooks.set(name, handler); return () => hooks.delete(name); },
  } as unknown as PluginServerContext;
  const f = await fixture();
  await f.manager.close();
  f.answerWith(null);
  const runs: AbortSignal[] = [];
  const registered = registerRecaps(host, { directory: f.directory, quietMs: 20, findBinary: async () => "/fake/grok", runGrok: input => { runs.push(input.signal); return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("canceled")))); } });
  try {
    assert.deepEqual([...handlers.keys()].sort(), ["observatory.recap.list", "observatory.recap.status"]);
    await until(async () => ((await handlers.get("observatory.recap.list")!({}, {})) as { enabled?: boolean }).enabled === true, "the setting read");
    await hooks.get("agent.turn_ended")!({ agent: { id: "a", parentAgentId: null, title: "t", workspaceId: null, provider: "p", cwd: "/" }, turnId: null, outcome: { kind: "completed" }, timeline: conversation }, { paseo: f.paseo });
    await until(() => runs.length === 1, "the run");
    values = { ...(values as object), enabled: false };
    for (const listener of listeners) listener({ status: "ready", revision: "2", values });
    await until(() => runs[0]!.aborted, "the run cancelled");
    assert.deepEqual(((await handlers.get("observatory.recap.list")!({}, {})) as { enabled: boolean; recaps: unknown[] }), { mode: "full", revision: ((await handlers.get("observatory.recap.list")!({}, {})) as { revision: string }).revision, enabled: false, suggestions: false, recaps: [] });
  } finally { await registered.close(); await rm(f.directory, { recursive: true, force: true }); }
});
