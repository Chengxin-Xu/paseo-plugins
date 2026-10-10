import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenIngester } from "../server/tokens/ingester";
import { LocalTokenCallSource } from "../server/tokens/source";
import { iso, type LogRoot } from "../server/tokens/types";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const line = (value: unknown) => JSON.stringify(value) + "\n";
const user = (sessionId: string, at = NOW - 10_000, parent?: string) => ({ type: "user", sessionId, cwd: "/repo", timestamp: iso(at),
  ...(parent ? { forkedFrom: { sessionId: parent, messageUuid: "copied-user" } } : {}), message: { content: "PRIVATE_PROMPT" } });
const assistant = (sessionId: string, id: string, at = NOW, output = 100, parent?: string) => ({ type: "assistant", sessionId, cwd: "/repo", timestamp: iso(at), requestId: `req-${id}`,
  ...(parent ? { forkedFrom: { sessionId: parent, messageUuid: `copied-${id}` } } : {}),
  message: { id, model: "claude-opus-5", content: "PRIVATE_OUTPUT", usage: { input_tokens: 11, cache_creation_input_tokens: 22, cache_read_input_tokens: 33, output_tokens: output } } });

async function fixture(run: (root: string, ingester: TokenIngester, source: LocalTokenCallSource) => Promise<void>, roots?: (root: string) => LogRoot[]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-source-"));
  const ingester = new TokenIngester({ roots: roots?.(root) ?? [{ source: "claude", path: root }], now: () => NOW, onCall: () => {} });
  try { await run(root, ingester, new LocalTokenCallSource(ingester)); }
  finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("call source distinguishes unknown sessions from known empty logs and awaits initialization", async () => fixture(async (root, ingester, source) => {
  await writeFile(join(root, "empty.jsonl"), line(user("empty")));
  let initialized!: () => void;
  const initializedPromise = new Promise<void>(resolve => { initialized = resolve; });
  const waiting = new LocalTokenCallSource(ingester, initializedPromise).callsForSessions(["empty"]);
  await ingester.scan(); initialized();
  assert.deepEqual(await waiting, { source: "claude", calls: [] });
  assert.equal(await source.callsForSessions(["unknown"]), null);
  assert.equal(await source.callsForSessions([]), null);
}));

test("call source resolves fork ancestors and descendants, includes parent subagents and prefers original usage", async () => fixture(async (root, ingester, source) => {
  await mkdir(join(root, "child", "subagents"), { recursive: true });
  await writeFile(join(root, "root.jsonl"), line(user("root", NOW - 40_000)) + line(assistant("root", "root-call", NOW - 30_000, 100)));
  await writeFile(join(root, "child.jsonl"), line(user("child", NOW - 40_000, "root")) + line(assistant("child", "root-call", NOW + 5000, 999, "root")) + line(assistant("child", "child-call", NOW - 20_000, 200)));
  await writeFile(join(root, "grandchild.jsonl"), line(user("grandchild", NOW - 40_000, "child")) + line(assistant("grandchild", "child-call", NOW + 5000, 999, "child")) + line(assistant("grandchild", "grandchild-call", NOW - 10_000, 400)));
  await writeFile(join(root, "child", "subagents", "agent-x.jsonl"), line(user("agent-x", NOW - 17_000)) + line(assistant("agent-x", "subagent-call", NOW - 15_000, 300)));
  await writeFile(join(root, "unrelated.jsonl"), line(assistant("unrelated", "unrelated-call", NOW, 500)));
  await utimes(join(root, "child.jsonl"), new Date(NOW - 100_000), new Date(NOW - 100_000));
  await ingester.backfillAll();
  const result = await source.callsForSessions(["grandchild"]);
  assert.deepEqual(result?.calls.map(call => [call.at, call.output, call.subagent]), [
    [NOW - 30_000, 100, false], [NOW - 20_000, 200, false], [NOW - 15_000, 300, true], [NOW - 10_000, 400, false],
  ]);
  assert.deepEqual(await source.callsForSessions(["root"]), result);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.deepEqual(Object.keys(result!.calls[0]).sort(), ["at", "cacheRead", "cacheWrite", "input", "model", "output", "reasoning", "start", "subagent"].sort());
}));

test("on-demand parsing discovers ancestor links before background ingestion has parsed them", async () => fixture(async (root, ingester, source) => {
  await writeFile(join(root, "root.jsonl"), line(assistant("root", "a", NOW - 2000)));
  await writeFile(join(root, "child.jsonl"), line(user("child", NOW - 1000, "root")) + line(assistant("child", "b")));
  await ingester.scan();
  assert.equal((await source.callsForSessions(["child"]))?.calls.length, 2);
  assert.ok([...ingester.files.values()].every(file => file.offset === 0));
}));

test("cached reads extend partial tails, preserve output corrections and serialize concurrent callers", async () => fixture(async (root, ingester, source) => {
  const path = join(root, "s.jsonl"), first = line(user("s")) + line(assistant("s", "a", NOW - 2000, 8));
  await writeFile(path, first); await ingester.scan();
  const initial = await source.callsForSessions(["s"]);
  assert.equal(initial?.calls[0].output, 8);
  initial!.calls[0].output = 9999;
  const correction = line(assistant("s", "a", NOW - 1000, 158));
  await appendFile(path, correction.slice(0, -5));
  assert.equal((await source.callsForSessions(["s"]))?.calls[0].output, 8);
  await appendFile(path, correction.slice(-5) + line(assistant("s", "b", NOW, 200)));
  const results = await Promise.all([source.callsForSessions(["s"]), source.callsForSessions(["s"])]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0]?.calls.map(call => [call.output, call.at, call.start]), [[158, NOW - 1000, NOW - 10_000], [200, NOW, NOW - 10_000]]);
}));

test("truncation, replacement and same-size rewrites invalidate cached history", async () => fixture(async (root, ingester, source) => {
  const path = join(root, "s.jsonl");
  await writeFile(path, line(assistant("s", "a")) + line(assistant("s", "b"))); await ingester.scan();
  assert.equal((await source.callsForSessions(["s"]))?.calls.length, 2);
  await writeFile(path, line(assistant("s", "c")));
  assert.equal((await source.callsForSessions(["s"]))?.calls.length, 1);
  await writeFile(path + ".new", line(assistant("s", "d", NOW, 300))); await rename(path + ".new", path);
  assert.equal((await source.callsForSessions(["s"]))?.calls[0].output, 300);
  await writeFile(path, line(assistant("s", "e", NOW, 400))); await utimes(path, new Date(NOW + 10_000), new Date(NOW + 10_000));
  assert.equal((await source.callsForSessions(["s"]))?.calls[0].output, 400);
  await rm(path);
  assert.equal(await source.callsForSessions(["s"]), null);
}));

test("mixed-provider requests select the first requested known source and suppress paired Codex counts", async () => fixture(async (root, ingester, source) => {
  await mkdir(join(root, "claude")); await mkdir(join(root, "codex"));
  await writeFile(join(root, "claude", "c.jsonl"), line(assistant("c", "c-call")));
  const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
  await writeFile(join(root, "codex", "rollout-test.jsonl"), line({ type: "session_meta", payload: { id: "x" } }) +
    line({ type: "turn_context", payload: { model: "gpt-5" } }) + line({ type: "event_msg", timestamp: iso(NOW - 1000), payload: { type: "task_started" } }) +
    line({ type: "token_usage_record", timestamp: iso(NOW), payload: { thread_id: "x", response_id: "r", usage, thread_token_usage: usage } }) +
    line({ type: "event_msg", timestamp: iso(NOW + 10), payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } }));
  await ingester.backfillAll();
  assert.equal((await source.callsForSessions(["unknown", "c", "x"]))?.source, "claude");
  const result = await source.callsForSessions(["x", "c"]);
  assert.equal(result?.source, "codex"); assert.equal(result?.calls.length, 1);
  assert.deepEqual(result?.calls.map(call => [call.at, call.start, call.input, call.cacheWrite, call.cacheRead, call.output, call.reasoning]), [[NOW + 10, NOW - 1000, 50, 10, 40, 20, 5]]);
}, root => [{ source: "claude", path: join(root, "claude") }, { source: "codex", path: join(root, "codex") }]));

test("cache limits never truncate the history returned for large or many-file requests", async () => fixture(async (root, ingester, source) => {
  for (let index = 0; index < 9; index++) await writeFile(join(root, `s${index}.jsonl`), line(assistant(`s${index}`, `a${index}`)));
  await ingester.scan();
  const ids = Array.from({ length: 9 }, (_, index) => `s${index}`);
  assert.equal((await source.callsForSessions(ids))?.calls.length, 9);
  const cache = (source as unknown as { cache: Map<string, { calls: Map<string, unknown> }> }).cache;
  assert.ok(cache.size <= 8);
  await writeFile(join(root, "large.jsonl"), Array.from({ length: 20_001 }, (_, index) => line(assistant("large", `large-${index}`))).join(""));
  await ingester.scan();
  assert.equal((await source.callsForSessions(["large"]))?.calls.length, 20_001);
  assert.ok([...cache.values()].reduce((count, entry) => count + entry.calls.size, 0) <= 20_000);
  assert.ok(!cache.has(join(root, "large.jsonl")));
}));
