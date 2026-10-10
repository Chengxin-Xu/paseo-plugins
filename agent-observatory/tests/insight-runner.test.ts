import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi, PaseoAgent, PaseoAgentHandle, PaseoAgentRunResult, PaseoAgentCreateOptions } from "@getpaseo/client";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { listInsightModels, listInsightRunners } from "../shared/insights";
import { extractInsightJson } from "../server/insight-analysis";
import { BUILTIN_INSIGHT_RUNNER, INSIGHT_PERMISSION_MESSAGE, InsightRunnerRegistry, NO_RUNNER_ERROR, cleanupInsightAgents, filterInsightFeatures, insightAnalysisMode, isInsightAgent, runPaseoStructured, type InsightRunnerPlan, type PaseoStructuredRunOptions } from "../server/insight-runner";

const mode = (id: string, extra: Record<string, unknown> = {}): AgentMode => ({ id, label: id, ...extra });
const entry = (provider: string, extra: Record<string, unknown> = {}) => ({ provider, label: provider, status: "ready", enabled: true, modes: [mode("ask")], models: [], ...extra });
function catalogFixture(entries: unknown[], profiles: unknown[] = [], extra: Record<string, unknown> = {}, configProviders: Record<string, unknown> = {}) {
  let now = 0, configs = 0, snapshots = 0, binaries = 0;
  const argumentsSeen: unknown[][] = [];
  const paseo = { config: { get: async () => { configs++; return { config: { providers: configProviders, agentProfiles: profiles } }; } }, providers: { snapshot: async (...args: unknown[]) => { snapshots++; argumentsSeen.push(args); return { entries, ...extra }; } } } as unknown as PaseoApi;
  const registry = new InsightRunnerRegistry(paseo, { now: () => now, cacheMs: 1, findBinary: async () => { binaries++; return "/fake/grok"; } });
  return { registry, argumentsSeen, tick(value: number) { now = value; }, counts: () => ({ configs, snapshots, binaries }) };
}

test("runner mode selection excludes plan, unattended and dangerous modes", () => {
  const cases: Array<[AgentMode[], string | null, string]> = [
    [[], null, "ask"], [[mode("plan")], "plan", "read"], [[mode("ask")], "ask", "read"], [[mode("default")], "default", "ask"],
    [[mode("default"), mode("ask")], "ask", "read"], [[mode("ask", { isUnattended: true }), mode("default")], "default", "ask"],
    [[mode("ask", { colorTier: "dangerous" }), mode("plan")], "plan", "read"], [[mode("agent"), mode("plan")], "agent", "ask"],
  ];
  for (const [modes, modeId, access] of cases) assert.deepEqual(insightAnalysisMode(modes), { modeId, access });
  // Codex: create_agent rejects its unlisted read-only preset, so the default mode runs in a read-only sandbox without approvals.
  assert.deepEqual(insightAnalysisMode([mode("auto"), mode("auto-review"), mode("full-access", { colorTier: "dangerous" })]),
    { modeId: "auto", access: "read", providerOptions: { sandbox_mode: "read-only", approval_policy: "never" } });
  // Only unattended modes listed: refuse rather than let create_agent inherit or map an unattended mode.
  assert.deepEqual(insightAnalysisMode([mode("yolo", { isUnattended: true })]), { modeId: null, access: "ask", unsafe: true });
});

test("runner feature filter preserves ordinary profile settings and drops access bypass keys", () => {
  assert.deepEqual(filterInsightFeatures({ fast_mode: true, reasoning: "high", autoAccept: true, auto_accept: false, YOLO: true, bypassPermissions: true, fullAccess: true, full_access: true, dangerMode: true }), { fast_mode: true, reasoning: "high" });
  assert.deepEqual(filterInsightFeatures(), {});
});

test("runner registry resolves profiles and defaults and shares a minimum sixty-second cache without cwd probes", async () => {
  const f = catalogFixture([entry("custom", { label: "Codex", modes: [mode("auto"), mode("full-access")], models: [{ provider: "custom", id: "m", label: "Model M", isDefault: true, thinkingOptions: [{ id: "high", label: "High", isDefault: true }] }] })],
    [{ id: "p", name: "Reviewer", provider: "custom", modeId: "full-access", notes: "a".repeat(500), featureValues: { fast_mode: true, yolo: true } }]);
  assert.deepEqual((await f.registry.resolve({ kind: "grok" })).info, BUILTIN_INSIGHT_RUNNER); assert.deepEqual(f.counts(), { configs: 0, snapshots: 0, binaries: 0 });
  const [profile, direct, runners, models] = await Promise.all([f.registry.resolve({ kind: "profile", profileId: "p" }), f.registry.resolve({ kind: "provider", provider: "custom", model: null, thinkingOptionId: null }), f.registry.runners(), f.registry.models("custom")]);
  assert.equal(profile.info.label, "Reviewer"); assert.equal(profile.info.modeId, "auto"); assert.deepEqual(profile.providerOptions, { sandbox_mode: "read-only", approval_policy: "never" }); assert.equal(profile.model, "m"); assert.equal(profile.effort, "high"); assert.deepEqual(profile.featureValues, { fast_mode: true });
  assert.equal(direct.info.label, "Codex · custom · Model M · High"); assert.equal(runners.profiles[0].detail?.length, 400); assert.equal(runners.profiles[0].thinkingLabel, "High");
  assert.ok(listInsightRunners.output.safeParse(runners).success); assert.ok(listInsightModels.output.safeParse(models).success);
  assert.deepEqual(f.counts(), { configs: 1, snapshots: 1, binaries: 1 }); assert.deepEqual(f.argumentsSeen, [[]]);
  f.tick(59_999); await f.registry.runners(); assert.deepEqual(f.counts(), { configs: 1, snapshots: 1, binaries: 1 });
  f.tick(60_000); await f.registry.runners(); assert.deepEqual(f.counts(), { configs: 2, snapshots: 2, binaries: 2 });
});

test("auto runs the Grok CLI when it is installed, otherwise Claude Code, Codex, then providers that extend them", async () => {
  const withGrok = catalogFixture([entry("claude", { label: "Claude Code", modes: [mode("default")] })]);
  assert.deepEqual((await withGrok.registry.resolve({ kind: "auto" })).info, BUILTIN_INSIGHT_RUNNER);
  const grokRunners = await withGrok.registry.runners();
  assert.deepEqual([grokRunners.auto.runner, grokRunners.auto.available, grokRunners.auto.providerLabel, grokRunners.auto.access], [{ kind: "auto" }, true, "现在：Grok 4.7 · xhigh", "none"]);
  assert.ok(listInsightRunners.output.safeParse(grokRunners).success);
  const providers = (entries: unknown[], config: Record<string, unknown> = {}) => {
    const paseo = { config: { get: async () => ({ config: { providers: config, agentProfiles: [] } }) }, providers: { snapshot: async () => ({ entries }) } } as unknown as PaseoApi;
    return new InsightRunnerRegistry(paseo, { findBinary: async () => null });
  };
  const models = [{ provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, thinkingOptions: [{ id: "high", label: "high", isDefault: true }] }];
  const claude = await providers([entry("opencode", { modes: [mode("plan")] }), entry("codex", { label: "Codex", modes: [mode("auto"), mode("full-access")] }),
    entry("claude", { label: "Claude Code", modes: [mode("default")], models })]).resolve({ kind: "auto" });
  assert.deepEqual([claude.info.kind, claude.info.provider, claude.model, claude.effort, claude.access], ["provider", "claude", "claude-opus-5-5", "high", "ask"]);
  const codex = await providers([entry("opencode", { modes: [mode("plan")] }), entry("codex", { label: "Codex", modes: [mode("auto"), mode("full-access")] }),
    entry("claude", { status: "unavailable" })]).resolve({ kind: "auto" });
  assert.deepEqual([codex.info.provider, codex.info.modeId, codex.providerOptions], ["codex", "auto", { sandbox_mode: "read-only", approval_policy: "never" }]);
  // The built-ins are off; custom providers that extend them are used, Claude-based first. Other providers never are.
  const extended = await providers([entry("acp-reader", { modes: [mode("plan")] }), entry("codex-team", { modes: [mode("auto"), mode("full-access")] }), entry("claude-team", { modes: [mode("default")] }), entry("claude"), entry("codex")],
    { claude: { enabled: false }, codex: { enabled: false }, "claude-team": { extends: "claude" }, "codex-team": { extends: "codex" }, "acp-reader": { extends: "acp" } }).resolve({ kind: "auto" });
  assert.equal(extended.info.provider, "claude-team");
  const none = providers([entry("acp-reader", { modes: [mode("plan")] }), entry("off", { enabled: false })], { "acp-reader": { extends: "acp" } });
  await assert.rejects(none.resolve({ kind: "auto" }), error => error instanceof Error && error.message === NO_RUNNER_ERROR);
  const empty = await none.runners();
  assert.deepEqual([empty.auto.available, empty.auto.reason], [false, NO_RUNNER_ERROR]);
});

test("runner registry retains unavailable profiles and cautions providers without read-only access", async () => {
  const f = catalogFixture([entry("disabled"), entry("error", { status: "error", error: "登录失效" }), entry("unavailable", { status: "unavailable" }), entry("default", { modes: [mode("default")] })],
    [{ id: "disabled", name: "Disabled", provider: "disabled" }, { id: "missing", name: "Missing", provider: "missing" }, { id: "error", name: "Error", provider: "error" }], {}, { disabled: { enabled: false } });
  const runners = await f.registry.runners();
  assert.equal(runners.profiles.every(profile => !profile.available), true); assert.equal(runners.providers.some(provider => provider.provider === "disabled"), false);
  assert.equal(runners.providers.find(provider => provider.provider === "default")?.reason, "没有只读模式，工具请求会被自动拒绝");
  await assert.rejects(f.registry.resolve({ kind: "profile", profileId: "disabled" }), /停用/); await assert.rejects(f.registry.resolve({ kind: "profile", profileId: "unknown" }), /找不到/);
  await assert.rejects(f.registry.models("error"), /登录失效/); await assert.rejects(f.registry.models("unavailable"), /不可用/);
});

test("runner models resolve compact thinking sets and put defaults first within bounds", async () => {
  const compactModels = Array.from({ length: 160 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}`, isDefault: i === 159, thinkingSet: 0 }));
  const f = catalogFixture([], [], { compactSnapshot: { entries: [entry("compact", { models: compactModels })], thinkingSets: [{ options: [{ id: "high", label: "High" }], defaultOptionId: "high" }] } });
  const models = await f.registry.models("compact"); assert.equal(models.models.length, 150); assert.equal(models.models[0].id, "m159");
  assert.deepEqual(models.models[0].thinking, [{ id: "high", label: "High" }]); assert.equal(models.models[0].defaultThinkingOptionId, "high");
  const plan = await f.registry.resolve({ kind: "provider", provider: "compact", model: null, thinkingOptionId: null }); assert.equal(plan.model, "m159"); assert.equal(plan.effort, "high");
});

test("runner registry caches catalog failures and returns a Chinese error", async () => {
  let requests = 0, now = 0;
  const paseo = { config: { get: async () => { requests++; throw new Error("offline"); } }, providers: { snapshot: async () => ({ entries: [] }) } } as unknown as PaseoApi;
  const registry = new InsightRunnerRegistry(paseo, { now: () => now, findBinary: async () => null });
  await assert.rejects(registry.runners(), /无法读取分析执行器列表.*offline/); await assert.rejects(registry.models("a"), /无法读取分析执行器列表/); assert.equal(requests, 1);
  now = 60_000; await assert.rejects(registry.runners(), /无法读取分析执行器列表/); assert.equal(requests, 2);
});

test("full catalog models inherit missing thinking options from their compact counterpart", async () => {
  const f = catalogFixture([entry("mixed", { models: [{ provider: "mixed", id: "m", label: "Full label", isDefault: true }] })], [],
    { compactSnapshot: { entries: [entry("mixed", { models: [{ id: "m", label: "Compact label", thinkingSet: 0 }] })], thinkingSets: [{ options: [{ id: "max", label: "Maximum" }], defaultOptionId: "max" }] } });
  const models = await f.registry.models("mixed"); assert.equal(models.models[0].label, "Full label"); assert.deepEqual(models.models[0].thinking, [{ id: "max", label: "Maximum" }]); assert.equal(models.models[0].defaultThinkingOptionId, "max");
});

const outputSchema = z.object({ summary: z.string().min(1) });
const plan: InsightRunnerPlan = { info: { kind: "profile", label: "Reviewer", provider: "custom", model: "m", thinkingOptionId: "high", modeId: "auto", sessionAgentId: null }, model: "m", effort: "high", access: "read", featureValues: { fast_mode: true, yolo: true },
  providerOptions: { sandbox_mode: "read-only", approval_policy: "never" } };
function snapshot(extra: Record<string, unknown> = {}): PaseoAgent { return { id: "helper", labels: { "observatory.role": "insight" }, pendingPermissions: [], ...extra } as unknown as PaseoAgent; }
function result(status: PaseoAgentRunResult["status"] = "idle", extra: Partial<PaseoAgentRunResult> = {}): PaseoAgentRunResult { return { status, final: snapshot(), error: null, lastMessage: '{"summary":"有效观察"}', ...extra }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function runFixture(results: PaseoAgentRunResult[] = [result()]) {
  const created: PaseoAgentCreateOptions[] = [], workspaceCreated: unknown[] = [], denied: unknown[] = [], retry: string[] = [], waits: number[] = [];
  let archived = 0;
  const handle = { id: "helper", current: () => snapshot(), refresh: async () => ({ agent: snapshot(), project: null }), archive: async () => { archived++; return { archivedAt: "2026-09-23T00:00:00Z" }; },
    waitForFinish: async (timeout: number) => { waits.push(timeout); return results.shift() ?? result(); }, run: async (text: string) => { retry.push(text); return results.shift() ?? result(); }, respondToPermission: async (request: unknown) => { denied.push(request); } } as unknown as PaseoAgentHandle;
  const paseo = { agents: { create: async (options: PaseoAgentCreateOptions) => { created.push(options); return handle; } }, workspaces: { ref: (id: string) => ({ agents: { create: async (options: unknown) => { workspaceCreated.push({ id, options }); return handle; } } }) } } as unknown as PaseoApi;
  const options: PaseoStructuredRunOptions<z.infer<typeof outputSchema>> = { paseo, plan, parent: { id: "parent", cwd: "/repo", workspaceId: "workspace", archived: false, title: "Long title ".repeat(20) }, jobId: "job-1", prompt: "证据", systemPrompt: "只读数据", schema: outputSchema, parse: text => outputSchema.parse(extractInsightJson(text)), signal: new AbortController().signal, now: () => 0 };
  return { handle, paseo, options, created, workspaceCreated, denied, retry, waits, archived: () => archived };
}

test("Paseo runner creates one parent-scoped helper with labels, schema and safe settings, then archives it", async () => {
  const f = runFixture([result("idle", { final: snapshot({ lastUsage: { inputTokens: 11, outputTokens: 7, totalCostUsd: 0.02 } }) })]);
  const sessions: string[] = []; const output = await runPaseoStructured({ ...f.options, onSession: info => { sessions.push(info.sessionAgentId!); } });
  assert.equal(f.created.length, 1); const created = f.created[0];
  assert.equal(created.parent, "parent"); assert.equal(created.cwd, "/repo"); assert.equal(created.title?.length, 60); assert.equal(created.config.provider, "custom/m");
  assert.equal(created.config.modeId, "auto"); assert.deepEqual(created.config.options, { sandbox_mode: "read-only", approval_policy: "never" }); assert.equal(created.config.thinkingOptionId, "high"); assert.deepEqual(created.config.featureValues, { fast_mode: true });
  assert.deepEqual(created.labels, { "observatory.role": "insight", "observatory.job": "job-1" }); assert.equal("autoArchive" in created, false); assert.equal("worktree" in created, false); assert.deepEqual(created.outputSchema, z.toJSONSchema(outputSchema));
  assert.equal(output.value.summary, "有效观察"); assert.equal(output.runner.sessionAgentId, "helper"); assert.deepEqual(output.usage, { inputTokens: 11, outputTokens: 7, costUsd: 0.02 }); assert.deepEqual(sessions, ["helper"]); assert.equal(f.archived(), 1);
});

test("Paseo runner uses an archived parent's existing workspace and errors when it cannot", async () => {
  const f = runFixture(); await runPaseoStructured({ ...f.options, parent: { ...f.options.parent, archived: true }, title: "观测台建议 · 近 7 天" });
  assert.equal(f.created.length, 0); assert.equal(f.workspaceCreated.length, 1); assert.equal((f.workspaceCreated[0] as { id: string }).id, "workspace"); assert.equal(f.archived(), 1);
  await assert.rejects(runPaseoStructured({ ...f.options, parent: { ...f.options.parent, archived: true, workspaceId: null } }), /无法在该会话的工作区启动分析/);
});

test("Paseo runner denies all pending permissions and continues to the final report", async () => {
  const f = runFixture([result("permission", { final: snapshot({ pendingPermissions: [{ id: "p1" }, { id: "p2" }] }) }), result()]);
  await runPaseoStructured(f.options); assert.deepEqual(f.denied, ["p1", "p2"].map(requestId => ({ requestId, response: { behavior: "deny", message: INSIGHT_PERMISSION_MESSAGE } }))); assert.equal(f.waits.length, 2); assert.equal(f.archived(), 1);
});

test("Paseo runner refreshes missing permission snapshots and denies the discovered request", async () => {
  const f = runFixture([result("permission", { final: null }), result()]); let refreshed = 0;
  f.handle.refresh = async () => { refreshed++; return { agent: snapshot({ pendingPermissions: [{ id: "refreshed" }] }), project: null }; };
  await runPaseoStructured(f.options); assert.equal(refreshed, 1); assert.deepEqual(f.denied, [{ requestId: "refreshed", response: { behavior: "deny", message: INSIGHT_PERMISSION_MESSAGE } }]);
});

test("Paseo runner caps repeated permission requests and archives the helper", async () => {
  const f = runFixture(Array.from({ length: 9 }, (_, i) => result("permission", { final: snapshot({ pendingPermissions: [{ id: `p${i}` }] }) })));
  await assert.rejects(runPaseoStructured(f.options), /超过 8 次/); assert.equal(f.denied.length, 9); assert.equal(f.archived(), 1);
});

test("Paseo runner retries invalid JSON on the same handle and accepts fenced or surrounded JSON", async () => {
  for (const text of ['```json\n{"summary":"fenced"}\n```', '说明：{"summary":"surrounded"} 结束']) {
    const f = runFixture([result("idle", { lastMessage: "not JSON" }), result("idle", { lastMessage: text })]);
    let retries = 0; const output = await runPaseoStructured({ ...f.options, onRetry: () => { retries++; } });
    assert.ok(output.value.summary); assert.equal(f.created.length, 1); assert.equal(f.retry.length, 1); assert.match(f.retry[0], /只输出符合 schema 的 JSON/); assert.equal(retries, 1); assert.equal(f.archived(), 1);
  }
});

test("Paseo runner permits only one schema retry", async () => {
  const f = runFixture([result("idle", { lastMessage: "{}" }), result("idle", { lastMessage: "{}" })]);
  await assert.rejects(runPaseoStructured(f.options)); assert.equal(f.retry.length, 1); assert.equal(f.archived(), 1);
});

test("Paseo runner archives on provider error and provider timeout", async () => {
  for (const status of ["error", "timeout"] as const) { const f = runFixture([result(status, { error: "provider failed" })]); await assert.rejects(runPaseoStructured(f.options), status === "error" ? /Paseo 分析失败/ : /Paseo 分析超时/); assert.equal(f.retry.length, 0); assert.equal(f.archived(), 1); }
});

test("Paseo runner aborts a pending wait immediately and archives", async () => {
  const f = runFixture(), waiting = deferred<void>(), never = deferred<PaseoAgentRunResult>(), controller = new AbortController();
  f.handle.waitForFinish = async () => { waiting.resolve(); return never.promise; };
  const run = runPaseoStructured({ ...f.options, signal: controller.signal }); await waiting.promise; controller.abort();
  await assert.rejects(run, /分析已取消/); assert.equal(f.archived(), 1); never.resolve(result());
});

test("Paseo runner archives a helper whose creation resolves after cancellation", async () => {
  const f = runFixture(), creating = deferred<PaseoAgentHandle>(), controller = new AbortController(), archived = deferred<void>();
  f.paseo.agents.create = async () => creating.promise;
  const original = f.handle.archive; f.handle.archive = async () => { const output = await original(); archived.resolve(); return output; };
  const run = runPaseoStructured({ ...f.options, signal: controller.signal }); controller.abort(); await assert.rejects(run, /分析已取消/);
  creating.resolve(f.handle); await archived.promise; assert.equal(f.archived(), 1);
});

test("Paseo runner total deadline aborts a stalled wait using injected timers", async () => {
  const f = runFixture(), waiting = deferred<void>(), never = deferred<PaseoAgentRunResult>(); let timeout: (() => void) | undefined;
  f.handle.waitForFinish = async () => { waiting.resolve(); return never.promise; };
  const run = runPaseoStructured({ ...f.options, timers: { set(callback) { timeout = callback; return 1; }, clear() {} } });
  await waiting.promise; timeout!(); await assert.rejects(run, /Paseo 分析超时/); assert.equal(f.archived(), 1); never.resolve(result());
});

test("Paseo runner bounds a stalled archive and reports the cleanup failure", async () => {
  const f = runFixture(), archiveStarted = deferred<void>(), never = deferred<{ archivedAt: string }>(), timerReady = deferred<void>();
  let fireCleanup: (() => void) | undefined; const warnings: string[] = [];
  f.handle.archive = async () => { archiveStarted.resolve(); return never.promise; };
  const run = runPaseoStructured({ ...f.options, onCleanupError: error => { warnings.push(error.message); }, timers: { set(callback, delay) { if (delay === 5000) { fireCleanup = callback; timerReady.resolve(); } return callback; }, clear() {} } });
  await archiveStarted.promise; await timerReady.promise; fireCleanup!(); assert.equal((await run).value.summary, "有效观察"); assert.match(warnings[0], /归档失败.*超时/); never.resolve({ archivedAt: "2026-09-23" });
});

test("startup cleanup archives only unowned live insight agents after reading all pages", async () => {
  const calls: string[] = [], archived: string[] = [];
  const agent = (id: string, job: string, extra: Record<string, unknown> = {}) => ({ agent: { id, labels: { "observatory.role": "insight", "observatory.job": job }, ...extra } });
  const paseo = { agents: { list: async (options: { page: { cursor?: string }; filter: unknown }) => { calls.push(options.page.cursor ?? "first"); assert.deepEqual(options.filter, { includeArchived: false, labels: { "observatory.role": "insight" } });
    return options.page.cursor ? { entries: [agent("stale-2", "old"), agent("archived", "old", { archivedAt: "yesterday" }), agent("ordinary", "old", { labels: {} })], pageInfo: { hasMore: false, nextCursor: null } }
      : { entries: [agent("stale-1", "old"), agent("owned", "active")], pageInfo: { hasMore: true, nextCursor: "next" } }; }, ref: (id: string) => ({ archive: async () => { assert.deepEqual(calls, ["first", "next"]); archived.push(id); } }) } } as unknown as PaseoApi;
  assert.deepEqual(await cleanupInsightAgents(paseo, new Set(["active"])), { archived: 2, errors: [] }); assert.deepEqual(archived, ["stale-1", "stale-2"]);
  assert.equal(isInsightAgent({ labels: { "observatory.role": "insight" } }), true); assert.equal(isInsightAgent({ labels: {} }), false);
});

test("startup cleanup reports archive failures and tolerates a minimal fake API", async () => {
  assert.deepEqual(await cleanupInsightAgents({} as PaseoApi), { archived: 0, errors: [] });
  const paseo = { agents: { list: async () => ({ entries: [{ agent: snapshot({ labels: { "observatory.role": "insight", "observatory.job": "old" } }) }], pageInfo: { hasMore: false, nextCursor: null } }), ref: () => ({ archive: async () => { throw new Error("offline"); } }) } } as unknown as PaseoApi;
  const cleanup = await cleanupInsightAgents(paseo); assert.equal(cleanup.archived, 0); assert.match(cleanup.errors[0], /helper.*归档失败.*offline/);
});

test("startup cleanup bounds a stalled listing using injected timers", async () => {
  const never = deferred<never>(); let expire: (() => void) | undefined;
  const paseo = { agents: { list: async () => never.promise } } as unknown as PaseoApi;
  const cleanup = cleanupInsightAgents(paseo, new Set(), { now: () => 0, timers: { set(callback) { expire = callback; return 1; }, clear() {} } });
  expire!(); await assert.rejects(cleanup, /超时/);
});
