import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { InsightManager } from "../server/insights";
import { parseInsightText } from "../server/insight-analysis";
import { isInsightAgent, isKnownInsightAgent } from "../server/insight-runner-lifecycle";

const defaults = { autoEnabled: true, minTurns: 4, minTools: 5, cooldownHours: 7 };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "observatory-insights-server-"));
  const create = () => new InsightManager({ directory, findBinary: async () => null });
  return { directory, create, remove: () => rm(directory, { recursive: true, force: true }) };
}
test("settings v1 disables automation exactly once and writes v2 with the built-in runner", async () => {
  const f = await fixture(); let manager: InsightManager | undefined;
  try {
    await writeFile(join(f.directory, "insight-settings.json"), JSON.stringify({ version: 1, settings: defaults }));
    manager = f.create();
    assert.deepEqual((await manager.state()).settings, { ...defaults, autoEnabled: false, runner: { kind: "grok" } });
    assert.equal(JSON.parse(await readFile(join(f.directory, "insight-settings.json"), "utf8")).version, 2);
    await manager.configure({ autoEnabled: true, runner: { kind: "profile", profileId: "my-profile" } });
    await manager.close(); manager = f.create();
    assert.deepEqual((await manager.state()).settings, { ...defaults, runner: { kind: "profile", profileId: "my-profile" } });
  } finally { await manager?.close(); await f.remove(); }
});
test("a saved runner choice is kept as it is: an existing Grok setting stays Grok", async () => {
  const f = await fixture(); let manager: InsightManager | undefined;
  try {
    await writeFile(join(f.directory, "insight-settings.json"), JSON.stringify({ version: 2, settings: { ...defaults, autoEnabled: false, runner: { kind: "grok" } } }));
    manager = f.create();
    assert.deepEqual((await manager.state()).settings.runner, { kind: "grok" });
    await assert.rejects(manager.start({} as PaseoApi, "agent-1"), /未找到 Grok CLI/);
  } finally { await manager?.close(); await f.remove(); }
});
test("partial configuration keeps omitted fields and unchanged settings do not rewrite disk", async () => {
  const f = await fixture(), manager = f.create();
  try {
    await manager.configure({ autoEnabled: true });
    await manager.configure({ runner: { kind: "provider", provider: "test", model: null, thinkingOptionId: null } });
    assert.equal((await manager.state()).settings.autoEnabled, true);
    const before = (await stat(join(f.directory, "insight-settings.json"))).ino;
    await manager.configure({});
    assert.equal((await stat(join(f.directory, "insight-settings.json"))).ino, before);
    await manager.configure({ autoEnabled: false });
    assert.equal((await manager.state()).settings.runner.kind, "provider");
  } finally { await manager.close(); await f.remove(); }
});
test("list gives a stable configured label even when a profile is missing", async () => {
  const f = await fixture(), manager = f.create();
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, config: { get: async () => ({ config: { agentProfiles: [] } }) }, providers: { snapshot: async () => ({ entries: [] }) } } as unknown as PaseoApi;
  try {
    manager.attach(paseo);
    const fresh = await manager.list();
    assert.deepEqual(fresh.settings.runner, { kind: "auto" }, "a new install picks the runner automatically");
    assert.equal(fresh.runnerLabel, "自动选择（暂无可用执行器）"); assert.equal(fresh.available, false);
    await manager.configure({ runner: { kind: "profile", profileId: "missing-profile" } });
    const list = await manager.list();
    assert.equal(list.runnerLabel, "Profile missing-profile（不可用）"); assert.equal(list.available, false);
    assert.equal((await manager.list(undefined, list.revision)).unchanged, true);
  } finally { await manager.close(); await f.remove(); }
});
test("shared parser extracts plain, fenced and surrounding JSON with quoted braces", () => {
  const report = { summary: "验证通过 {example}", health: "healthy", confidence: "high", findings: [], strengths: ["已有测试结果"], nextActions: [], limitations: [] };
  const json = JSON.stringify(report);
  for (const output of [json, `\`\`\`json\n${json}\n\`\`\``, `准备说明 {}\n${json}\n分析结束`, JSON.stringify({ structured_output: json })]) {
    assert.equal(parseInsightText(output, new Set()).report.summary, report.summary);
  }
});
test("lifecycle resolves omitted labels once and excludes analysis helper activity", async () => {
  const f = await fixture(), manager = f.create(); let reads = 0;
  const paseo = { agents: { ref: () => ({ current: () => null, refresh: async () => { reads++; return { agent: { labels: { "observatory.role": "insight" } } }; } }) } } as unknown as PaseoApi;
  try {
    assert.deepEqual(await Promise.all([isInsightAgent(paseo, { id: "helper-filter" }), isInsightAgent(paseo, { id: "helper-filter" })]), [true, true]);
    assert.equal(reads, 1); assert.equal(isKnownInsightAgent("helper-filter"), true);
    await manager.state(); manager.turnStarted("helper-filter"); manager.turnEnded("helper-filter");
    await manager.configure({ autoEnabled: true });
    await manager.scheduleAuto(paseo, "helper-filter", 10, 10);
    assert.equal((await manager.list()).nextScheduledAt, null);
    const index = JSON.parse(await readFile(join(f.directory, "insight-index.json"), "utf8"));
    assert.equal(index.activity["helper-filter"], undefined);
  } finally { await manager.close(); await f.remove(); }
});
