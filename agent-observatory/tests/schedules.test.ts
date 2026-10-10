import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduleIndex, type ScheduleDirectory } from "../server/schedules";
import type { StatsDirectoryAgent } from "../server/stats-types";
import { EMPTY_RUN_FILTER, cadenceLabel, cadenceText, describeRunError, filterRuns, findChangeRequest, groupRunsByDay, knownRunError, zoneLabel, type ScheduleRunRow, type ScheduleRunsState } from "../shared/schedules";

const NOW = Date.parse("2026-10-09T06:00:00.000Z");
const REPLY = "## 巡检结论\n\n- 3 个集群健康\n\n修复 MR：https://gitlab.example.com/acme/web-app/-/merge_requests/12";
const iso = (ms: number) => new Date(ms).toISOString();
function agent(id: string, patch: Partial<StatsDirectoryAgent> = {}): StatsDirectoryAgent {
  return { id, createdAt: "2026-10-01T22:00:01.000Z", provider: "codex", model: null, parentAgentId: null, projectKey: "p", projectName: "ops-runbook", status: "closed", archivedAt: "2026-10-01T22:06:55.000Z",
    title: "每 6 小时巡检线上服务", requiresAttention: true, attentionReason: "finished", pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null, sessionId: null, ...patch };
}
function run(id: string, startedAt: number, patch: Record<string, unknown> = {}) {
  return { id, scheduledFor: iso(startedAt), startedAt: iso(startedAt), endedAt: iso(startedAt + 3000), status: "succeeded", agentId: null, workspaceId: null, output: "完成", error: null, ...patch };
}
function schedule(id: string, patch: Record<string, unknown> = {}) {
  return { id, name: "服务巡检", prompt: "[mr] 巡检", cadence: { type: "cron", expression: "0 */6 * * *", timezone: "America/New_York" },
    target: { type: "new-agent", config: { provider: "codex", cwd: "/work/ops-runbook" } }, status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: "2026-10-09T10:00:00.000Z", lastRunAt: "2026-10-01T22:06:55.000Z", pausedAt: null, expiresAt: null, maxRuns: null,
    runs: [run("run-ok", Date.parse("2026-10-01T22:00:00.000Z"), { agentId: "a-ok", workspaceId: "wks_ok", output: `\n\n---\n\n${REPLY}` })], ...patch };
}
/** A record as Paseo 0.11 stores it in `$PASEO_HOME/agents/<folder>/<id>.json` (the keys a 0.11.1 daemon writes). */
function storedAgent(id: string, patch: Record<string, unknown> = {}) {
  return { id, provider: "codex", cwd: "/home/user/ops-runbook", workspaceId: "wks_ok", createdAt: "2026-09-24T22:00:01.735Z", updatedAt: "2026-09-24T22:06:45.630Z",
    lastActivityAt: "2026-09-24T22:06:45.630Z", lastUserMessageAt: "2026-09-24T22:00:01.831Z", title: "每 6 小时巡检线上服务 `orders-api.health`（第 2 次",
    labels: { "paseo.schedule-id": "75b70160", "paseo.schedule-run": `run-${id}` }, lastStatus: "closed", lastModeId: null,
    config: { model: "gpt-5-codex", thinkingOptionId: "high", featureValues: {} }, runtimeInfo: { provider: "codex", sessionId: `session-${id}`, model: "gpt-5-codex", thinkingOptionId: "high", modeId: null, extra: {} },
    features: [], persistence: { provider: "codex", sessionId: `session-${id}`, nativeHandle: `session-${id}`, metadata: {} },
    requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-09-24T22:06:45.606Z", internal: false, archivedAt: "2026-09-24T22:06:45.630Z", ...patch };
}
async function fixture(agents: StatsDirectoryAgent[], options: { workspaces?: boolean; maxFileBytes?: number; maxLedgerBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "observatory-schedules-"));
  const home = join(root, "home"), data = join(root, "data");
  await mkdir(join(home, "schedules"), { recursive: true }); await mkdir(join(home, "projects"), { recursive: true }); await mkdir(data, { recursive: true });
  if (options.workspaces !== false) await writeFile(join(home, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_ok", displayName: "ops-runbook", title: "巡检", branch: null, archivedAt: "2026-10-01T22:06:56.000Z", autoArchivedChangeRequestUrl: null }]));
  const directory: ScheduleDirectory = { agents, digest: "d1", async refresh() {} };
  let now = NOW;
  const made: ScheduleIndex[] = [], warnings: string[] = [];
  const make = (writeDelayMs = 0) => { const index = new ScheduleIndex({ home, dataDirectory: data, directory, writeDelayMs, now: () => now, maxFileBytes: options.maxFileBytes, maxLedgerBytes: options.maxLedgerBytes,
    log: message => warnings.push(message) }); made.push(index); return index; };
  // Every index saves what is pending and stops writing before the temporary tree goes away.
  const close = async () => { await chmod(data, 0o700).catch(() => {}); for (const index of made) await index.close(); await rm(root, { recursive: true, force: true }); };
  const record = async (folder: string, body: { id: string }) => { await mkdir(join(home, "agents", folder), { recursive: true }); await writeFile(join(home, "agents", folder, `${body.id}.json`), JSON.stringify(body)); };
  return { root, home, data, directory, make, close, warnings, record, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; },
    write: (id: string, body: unknown) => writeFile(join(home, "schedules", `${id}.json`), JSON.stringify(body)) };
}
const full = (value: unknown) => { assert.equal((value as { mode: string }).mode, "full"); return value as ScheduleRunsState; };

test("live schedule runs carry status, an MR link and a Markdown-free preview; unchanged polls are tiny", async () => {
  const f = await fixture([agent("a-ok", { workspaceId: "wks_ok", scheduleId: "s1", scheduleRunId: "run-ok" })]);
  try {
    await f.write("s1", schedule("s1"));
    const index = f.make();
    const first = full(await index.list(null, { window: "all" }));
    assert.equal(first.runs.length, 1);
    const [row] = first.runs;
    assert.equal(row!.status, "succeeded"); assert.equal(row!.source, "schedule"); assert.equal(row!.link?.label, "!12"); assert.equal(row!.link?.kind, "mr");
    assert.equal(row!.preview?.startsWith("巡检结论 3 个集群健康"), true);
    assert.equal(row!.workspace?.name, "巡检"); assert.equal(row!.agent?.known, true);
    assert.equal(first.schedules[0]!.cadence, "每 6 小时"); assert.equal(first.schedules[0]!.timezone, "America/New_York"); assert.equal(first.schedules[0]!.target, "ops-runbook");
    assert.deepEqual(await index.list(null, { revision: first.revision, window: "all" }), { mode: "unchanged", unchanged: true, revision: first.revision });
    const detail = await index.run(null, "run-ok");
    assert.equal(detail.output?.startsWith("## 巡检结论"), true); assert.equal(detail.prompt, "[mr] 巡检");
    assert.equal(detail.row?.scheduleName, "服务巡检"); assert.equal(detail.schedule?.id, "s1");
  } finally { await f.close(); }
});

test("a run's detail can be read before any list call, and an unknown run says so", async () => {
  const f = await fixture([]);
  try {
    await f.write("s1", schedule("s1"));
    const detail = await f.make().run(null, "run-ok");
    assert.equal(detail.row?.id, "run-ok"); assert.equal(detail.output?.includes("巡检结论"), true);
    const missing = await f.make().run(null, "nope");
    assert.equal(missing.row, null); assert.equal(missing.output, null); assert.match(missing.note ?? "", /读取会话记录/);
  } finally { await f.close(); }
});

test("a failed heartbeat run is joined to the schedule's target Agent; heartbeats stay hidden until asked for", async () => {
  const f = await fixture([agent("a-hb", { archivedAt: null, status: "idle", title: "值班助手" })]);
  try {
    await f.write("hb", schedule("hb", { name: "配置检查心跳", cadence: { type: "cron", expression: "0 * * * *" }, target: { type: "agent", agentId: "a-hb" },
      runs: [run("run-hb", NOW - 3600_000, { status: "failed", output: null, error: "Scheduled agent a-hb is waiting for permission" })] }));
    const result = full(await f.make().list(null));
    const [row] = result.runs;
    assert.equal(row!.kind, "heartbeat"); assert.equal(row!.agent?.id, "a-hb"); assert.equal(row!.agent?.title, "值班助手");
    assert.equal(result.schedules[0]!.target, "值班助手"); assert.equal(result.schedules[0]!.timezone, "UTC", "a zone-less cron runs in UTC");
    assert.equal(filterRuns(result.runs, EMPTY_RUN_FILTER).length, 0, "heartbeats are hidden by default");
    assert.equal(filterRuns(result.runs, { ...EMPTY_RUN_FILTER, heartbeats: true }).length, 1);
    assert.equal(filterRuns(result.runs, { ...EMPTY_RUN_FILTER, scheduleId: "hb" }).length, 1, "picking the heartbeat schedule shows its runs");
  } finally { await f.close(); }
});

test("the recent window keeps 30 days (running runs always) and counts what it leaves out; its edge moves in 10-minute steps", async () => {
  const f = await fixture([]);
  try {
    const runs = [run("today", NOW - 3600_000), run("week", NOW - 6 * 86_400_000), run("edge", NOW - 30 * 86_400_000 + 300_000), run("old", NOW - 45 * 86_400_000),
      run("stuck", NOW - 40 * 86_400_000, { status: "running", endedAt: null, output: null })];
    await f.write("s1", schedule("s1", { runs }));
    const index = f.make();
    const recent = full(await index.list(null));
    assert.equal(recent.window, "recent");
    assert.deepEqual(recent.runs.map(row => row.id), ["today", "week", "edge", "stuck"]);
    assert.equal(recent.older, 1); assert.equal(recent.olderHeartbeats, 0); assert.equal(recent.schedules[0]!.total, 5, "summaries always count every run");
    assert.deepEqual(recent.week, { runs: 2, failed: 0, heartbeats: 0, heartbeatsFailed: 0 }, "today and six days ago");
    const all = full(await index.list(null, { window: "all" }));
    assert.equal(all.runs.length, 5); assert.equal(all.older, 0);
    f.setNow(NOW + 4 * 60_000);
    assert.equal((await index.list(null, { revision: recent.revision })).mode, "unchanged", "the edge did not move yet");
    f.setNow(NOW + 20 * 60_000);
    const moved = full(await index.list(null, { revision: recent.revision }));
    assert.deepEqual(moved.runs.map(row => row.id), ["today", "week", "stuck"]); assert.equal(moved.older, 2);
  } finally { await f.close(); }
});

test("the recent window caps runs and heartbeat runs separately", async () => {
  const f = await fixture([agent("a-hb", { archivedAt: null })]);
  try {
    await f.write("s1", schedule("s1", { runs: Array.from({ length: 230 }, (_, index) => run(`r${index}`, NOW - index * 60_000)) }));
    await f.write("hb", schedule("hb", { target: { type: "agent", agentId: "a-hb" }, runs: Array.from({ length: 120 }, (_, index) => run(`h${index}`, NOW - index * 60_000)) }));
    const recent = full(await f.make().list(null));
    assert.equal(recent.runs.filter(row => row.kind === "new-agent").length, 200);
    assert.equal(recent.runs.filter(row => row.kind === "heartbeat").length, 100);
    assert.equal(recent.older, 30, "scheduled runs left out"); assert.equal(recent.olderHeartbeats, 20, "heartbeat runs left out, counted apart"); assert.equal(recent.truncated, true);
    assert.deepEqual(recent.week, { runs: 230, failed: 0, heartbeats: 120, heartbeatsFailed: 0 }, "the week counts every run, not just the window");
  } finally { await f.close(); }
});

test("runs survive their schedule's deletion through the ledger, which stores no reply text", async () => {
  const f = await fixture([agent("a-ok", { workspaceId: "wks_ok", scheduleId: "s1", scheduleRunId: "run-ok" })]);
  try {
    await f.write("s1", schedule("s1"));
    const index = f.make();
    full(await index.list(null, { window: "all" }));
    await index.flush();
    const saved = await readFile(join(f.data, "schedule-ledger.json"), "utf8");
    assert.equal(saved.includes("巡检结论"), false, "the ledger keeps metadata only");
    assert.equal(saved.includes("[mr] 巡检"), false, "and no prompt");
    assert.equal(saved.includes("merge_requests/12"), true, "but keeps the MR link");
    await rm(join(f.home, "schedules", "s1.json"));
    const fresh = f.make();
    const after = full(await fresh.list(null, { window: "all" }));
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0]!.source, "ledger"); assert.equal(after.runs[0]!.scheduleName, "服务巡检"); assert.equal(after.runs[0]!.link?.label, "!12");
    assert.equal(after.schedules[0]!.status, "deleted"); assert.equal(after.schedules[0]!.timezone, "America/New_York");
    const detail = await fresh.run(null, "run-ok");
    assert.equal(detail.output, null); assert.match(detail.note ?? "", /已被删除/);
  } finally { await f.close(); }
});

test("a damaged ledger is kept aside, reported once and replaced", async () => {
  const f = await fixture([]);
  try {
    await writeFile(join(f.data, "schedule-ledger.json"), "{not json");
    await f.write("s1", schedule("s1"));
    const index = f.make();
    const result = full(await index.list(null, { window: "all" }));
    assert.match(result.notice ?? "", /账本损坏，已另存为 schedule-ledger\.corrupt-/);
    assert.match(f.warnings.join("\n"), /^ledger unreadable: SyntaxError/);
    await index.flush();
    const files = await readdir(f.data);
    assert.equal(files.some(name => /^schedule-ledger\.corrupt-.*\.json$/.test(name)), true);
    assert.equal(JSON.parse(await readFile(join(f.data, "schedule-ledger.json"), "utf8")).runs["run-ok"].scheduleId, "s1");
  } finally { await f.close(); }
});

test("an oversized ledger counts as damaged; an unreadable one that cannot be moved is never overwritten", async () => {
  const f = await fixture([], { maxLedgerBytes: 64 });
  try {
    const big = JSON.stringify({ version: 1, schedules: {}, runs: {}, padding: "x".repeat(200) });
    await writeFile(join(f.data, "schedule-ledger.json"), big);
    await chmod(f.data, 0o500); // read-only directory: the rename fails
    await f.write("s1", schedule("s1"));
    const index = f.make();
    const result = full(await index.list(null, { window: "all" }));
    assert.match(result.notice ?? "", /不会改写它/);
    assert.match(f.warnings.join("\n"), /^ledger unreadable: Error: ledger too large/);
    await index.flush();
    await chmod(f.data, 0o700);
    assert.equal(await readFile(join(f.data, "schedule-ledger.json"), "utf8"), big);
  } finally { await f.close(); }
});

test("a ledger that cannot be saved raises a notice, which clears after the next good save", async () => {
  const f = await fixture([]);
  try {
    await f.write("s1", schedule("s1"));
    const index = f.make(60_000);
    full(await index.list(null));
    await chmod(f.data, 0o500); // the write fails
    await index.flush();
    assert.match(full(await index.list(null)).notice ?? "", /无法保存/);
    assert.match(f.warnings.join("\n"), /^could not save the ledger: Error: EACCES/m);
    await chmod(f.data, 0o700);
    await index.flush();
    assert.equal(full(await index.list(null)).notice, null);
  } finally { await f.close(); }
});

test("the ledger keeps the newest 3000 runs within 400 days", async () => {
  const f = await fixture([]);
  try {
    const runs = Array.from({ length: 3100 }, (_, index) => run(`r${index}`, NOW - index * 60_000));
    runs.push(run("ancient", NOW - 500 * 86_400_000));
    await f.write("s1", schedule("s1", { runs }));
    const index = f.make();
    full(await index.list(null));
    await index.flush();
    const ledger = JSON.parse(await readFile(join(f.data, "schedule-ledger.json"), "utf8"));
    assert.equal(Object.keys(ledger.runs).length, 3000);
    assert.equal(ledger.runs.r0 !== undefined && ledger.runs.r3050 === undefined && ledger.runs.ancient === undefined, true);
  } finally { await f.close(); }
});

test("an oversized schedule file is skipped and a missing workspace registry only loses names", async () => {
  const f = await fixture([], { workspaces: false, maxFileBytes: 2000 });
  try {
    await f.write("small", schedule("small", { runs: [run("r1", NOW - 1000, { workspaceId: "wks_x" })] }));
    await f.write("huge", schedule("huge", { prompt: "x".repeat(5000), runs: [run("r2", NOW - 2000)] }));
    const result = full(await f.make().list(null));
    assert.deepEqual(result.runs.map(row => row.id), ["r1"]);
    assert.deepEqual(result.runs[0]!.workspace, { id: "wks_x", name: null, branch: null, archivedAt: null });
    assert.match(f.warnings.join("\n"), /^could not read huge\.json: Error: huge\.json is larger than 2000 bytes/);
  } finally { await f.close(); }
});

test("Agents a deleted schedule created are rebuilt from their labels", async () => {
  const agents = Array.from({ length: 3 }, (_, index) => agent(`a-${index}`, { scheduleId: "75b70160", scheduleRunId: `run-${index}`, createdAt: `2026-09-1${index}T10:00:00.000Z` }));
  agents.push(agent("a-err", { scheduleId: "75b70160", scheduleRunId: "run-err", status: "error", attentionReason: "error", createdAt: "2026-09-20T10:00:00.000Z" }));
  const f = await fixture(agents);
  try {
    const result = full(await f.make().list(null, { window: "all" }));
    assert.equal(result.reconstructed, 4);
    assert.deepEqual(result.runs.map(row => row.status), ["failed", "succeeded", "succeeded", "succeeded"]);
    assert.equal(result.runs.every(row => row.source === "agent" && row.scheduleName === "每 6 小时巡检线上服务"), true);
    assert.equal(result.schedules[0]!.status, "deleted"); assert.deepEqual(result.schedules[0]!.recent, ["succeeded", "succeeded", "succeeded", "failed"]);
    assert.equal(result.schedules[0]!.target, "ops-runbook");
  } finally { await f.close(); }
});

test("Agents the host no longer lists (their project was removed) are read from Paseo's own agent records", async () => {
  // On Paseo 0.11, agents.list (fetch_agents) leaves out every Agent whose workspace's project is gone, so the
  // directory has none of a deleted schedule's Agents; their records are still on disk with the schedule's labels.
  const f = await fixture([agent("listed", { title: "日常会话" })]);
  try {
    const folder = "home-user-ops-runbook";
    for (let index = 0; index < 3; index++) await f.record(folder, storedAgent(`orphan-${index}`, { createdAt: `2026-09-2${index}T22:00:01.735Z` }));
    await f.record(folder, storedAgent("orphan-open", { createdAt: "2026-09-23T22:00:01.735Z", attentionReason: null, requiresAttention: false }));
    await f.record(folder, storedAgent("plain", { labels: {} }));
    await f.record(folder, storedAgent("helper", { internal: true }));
    await mkdir(join(f.home, "agents", "broken"), { recursive: true }); await writeFile(join(f.home, "agents", "broken", "half.json"), "{\"id\": ");
    const result = full(await f.make().list(null, { window: "all" }));
    assert.equal(result.reconstructed, 4); assert.equal(result.runs.length, 4);
    assert.deepEqual(result.runs.map(row => [row.id, row.status]), [["run-orphan-open", "unknown"], ["run-orphan-2", "succeeded"], ["run-orphan-1", "succeeded"], ["run-orphan-0", "succeeded"]]);
    const row = result.runs.find(candidate => candidate.id === "run-orphan-0")!;
    assert.deepEqual(row.agent, { id: "orphan-0", title: "每 6 小时巡检线上服务 `orders-api.health`（第 2 次", status: "closed", archivedAt: "2026-09-24T22:06:45.630Z", known: true, listed: false },
      "known (Paseo still has it) but not listed: the host can no longer open its session or workspace");
    assert.equal(row.source, "agent"); assert.equal(row.scheduleName, "每 6 小时巡检线上服务 orders-api.health（第 2 次");
    assert.equal(row.workspace?.name, "巡检"); assert.equal(row.projectName, "ops-runbook");
    assert.equal(result.schedules.length, 1); assert.equal(result.schedules[0]!.id, "75b70160"); assert.equal(result.schedules[0]!.status, "deleted");
    assert.deepEqual(f.warnings, [], "a half-written record is skipped quietly");
  } finally { await f.close(); }
});

test("a heartbeat whose target Agent the host no longer lists still names it from its record", async () => {
  const f = await fixture([]);
  try {
    await f.record("home-user-ops-runbook", storedAgent("duty", { title: "值班助手", labels: {}, archivedAt: null, lastStatus: "idle" }));
    await f.write("hb", schedule("hb", { name: "巡检心跳", target: { type: "agent", agentId: "duty" },
      runs: [run("hb-1", NOW - 60_000, { agentId: "duty" }), run("hb-2", NOW - 30_000, { status: "failed", agentId: null, output: null, error: "Agent duty already has an active run" })] }));
    const result = full(await f.make().list(null, { window: "all" }));
    assert.deepEqual(result.runs.map(row => [row.id, row.agent?.title, row.agent?.known, row.agent?.listed]), [["hb-2", "值班助手", true, false], ["hb-1", "值班助手", true, false]]);
    assert.equal(result.schedules[0]!.target, "值班助手"); assert.equal(result.reconstructed, 0, "an unlabelled Agent is never a run of its own");
  } finally { await f.close(); }
});

test("a listed Agent wins over its record, and records are read again at most once a minute, only when they change", async () => {
  const folder = "home-user-ops-runbook";
  const f = await fixture([agent("orphan-0", { status: "running", archivedAt: null, activeTurn: true, title: "主机里的标题", scheduleId: "75b70160", scheduleRunId: "run-orphan-0" })]);
  try {
    await f.record(folder, storedAgent("orphan-0"));
    await f.record(folder, storedAgent("orphan-1", { attentionReason: null, requiresAttention: false }));
    const index = f.make();
    const first = full(await index.list(null, { window: "all" }));
    // The host's entry (running, its own title and creation time) replaces the record of the same Agent.
    assert.deepEqual(first.runs.map(row => [row.id, row.status, row.agent?.title, row.agent?.listed]), [["run-orphan-0", "running", "主机里的标题", undefined], ["run-orphan-1", "unknown", "每 6 小时巡检线上服务 `orders-api.health`（第 2 次", false]]);
    await f.record(folder, storedAgent("orphan-1", { attentionReason: "finished", updatedAt: "2026-09-24T22:09:00.000Z" }));
    f.advance(30_000);
    assert.equal((await index.list(null, { window: "all", revision: first.revision })).mode, "unchanged", "the folder is not listed again within a minute");
    f.advance(31_000);
    const second = full(await index.list(null, { window: "all", revision: first.revision }));
    assert.equal(second.runs.find(row => row.id === "run-orphan-1")?.status, "succeeded");
  } finally { await f.close(); }
});

test("closing saves pending ledger changes once; indexes sharing a directory never collide, and nothing writes after close", async () => {
  const f = await fixture([]);
  try {
    await f.write("s1", schedule("s1"));
    const ledger = join(f.data, "schedule-ledger.json");
    const first = f.make(60_000), second = f.make(60_000);
    full(await first.list(null)); full(await second.list(null));
    await assert.rejects(readFile(ledger), /ENOENT/, "both writes are still waiting");
    await Promise.all([first.close(), second.close()]);
    assert.equal(JSON.parse(await readFile(ledger, "utf8")).runs["run-ok"].scheduleId, "s1");
    await rm(ledger);
    await f.write("s2", schedule("s2", { runs: [run("run-late", NOW - 1000)] }));
    assert.equal(full(await first.list(null)).runs.some(row => row.id === "run-late"), true, "a closed index still answers");
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(readFile(ledger), /ENOENT/, "but never writes again");
    assert.deepEqual((await readdir(f.data)).filter(name => name.endsWith(".tmp")), []);
    assert.deepEqual(f.warnings, []);
  } finally { await f.close(); }
});

test("Chinese cadences, zones, change-request labels and day groups", () => {
  assert.equal(cadenceLabel({ type: "cron", expression: "*/30 * * * *" }), "每 30 分钟");
  assert.equal(cadenceLabel({ type: "cron", expression: "30 9 * * *" }), "每天 09:30");
  assert.equal(cadenceLabel({ type: "cron", expression: "0 9 * * 1-5" }), "工作日 09:00");
  assert.equal(cadenceLabel({ type: "cron", expression: "0 18 * * 5" }), "每周五 18:00");
  assert.equal(cadenceLabel({ type: "cron", expression: "5 4 1 * *" }), "5 4 1 * *");
  assert.equal(cadenceLabel({ type: "every", everyMs: 3_600_000 }), "每 1 小时");
  assert.equal(cadenceText({ cadence: "每天 09:30", timezone: "UTC" }, "America/New_York"), "每天 09:30（UTC）");
  assert.equal(cadenceText({ cadence: "每天 09:30", timezone: "Etc/UTC" }, "UTC"), "每天 09:30", "same zone, no suffix");
  assert.equal(cadenceText({ cadence: "每天 09:30", timezone: "Asia/Tokyo" }, null), "每天 09:30（东京时间）", "unknown device zone keeps the suffix");
  assert.equal(cadenceText({ cadence: "每 6 小时", timezone: null }, "UTC"), "每 6 小时");
  assert.equal(zoneLabel("Europe/Paris"), "Paris");
  assert.equal(findChangeRequest("PR：https://github.com/o/r/pull/34")?.label, "#34");
  assert.equal(findChangeRequest("no link"), null);
  const now = new Date(2026, 9, 8, 23, 30).getTime();
  const row = (startedAt: string): ScheduleRunRow => ({ id: startedAt, scheduleId: "s", scheduleName: "s", kind: "new-agent", status: "succeeded", source: "schedule", scheduledFor: null, startedAt,
    endedAt: null, preview: null, hasOutput: false, error: null, agent: null, workspace: null, projectName: null, link: null });
  const groups = groupRunsByDay([row(new Date(2026, 9, 8, 9).toISOString()), row(new Date(2026, 9, 7, 9).toISOString()), row(new Date(2026, 9, 4, 9).toISOString()), row(new Date(2026, 8, 25, 9).toISOString()), row(new Date(2026, 7, 2, 9).toISOString())], now);
  assert.deepEqual(groups.map(group => group.label), ["今天", "昨天", "10月4日 周日", "9月21日 – 9月27日", "8月"]);
});

test("run errors get short Chinese summaries and lose ACP repetition", () => {
  assert.equal(describeRunError("Working directory /tmp/x no longer exists")?.summary, "工作目录已不存在：/tmp/x（任务已自动结束）");
  assert.equal(describeRunError("Scheduled agent ec9f is waiting for permission")?.summary, "Agent 在等你审批，这次没能跑完");
  assert.equal(describeRunError("Timed out refreshing Kimi (broken) after 120000ms; pending: initialize")?.summary, "Provider「Kimi (broken)」启动超时");
  assert.equal(describeRunError("Daemon restarted before the scheduled run completed")?.summary, "daemon 重启，打断了这次运行");
  const acp = describeRunError("Internal error: npm test 失败：3 个用例超时\n\ncode: -32603\n\nInternal error: npm test 失败：3 个用例超时 | code=-32603 | data={}");
  assert.equal(acp?.summary, "npm test 失败：3 个用例超时"); assert.equal(acp?.known, false); assert.equal(describeRunError(null), null);
  // Agent 详情 translates only errors it recognises; anything else is shown as it is.
  assert.equal(knownRunError("Request failed: acp does not support ACP session resume requestType=plugin.rpc.invoke.request code=handler_error"), "会话无法恢复：这个 ACP Agent 不支持重新载入");
  assert.equal(knownRunError("模拟连接中断，请稍后重试"), null); assert.equal(knownRunError(undefined), null);
});
