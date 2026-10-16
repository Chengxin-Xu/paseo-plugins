import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { MAX_CACHE_WINDOW, cacheEntryOf, cacheStateOf, createCacheReader, modelChanged, registerCacheClock } from "../server/cache-clock";
import type { StatsDirectoryAgent } from "../server/stats-types";
import type { CacheEntry } from "../shared/alerts";

// 提示缓存倒计时 (2.17): the server reads a Claude session's own log for when its prompt cache goes cold; the device counts down.

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const user = (uuid: string, parentUuid: string | null, at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid, parentUuid, timestamp: iso(at), message: { role: "user", content: "hi" }, ...extra });
const request = (uuid: string, parentUuid: string, at: number, requestId: string, cache: { five?: number; hour?: number } | null, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", uuid, parentUuid, timestamp: iso(at), requestId,
  message: { model: (extra.model as string) ?? "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5, ...(cache ? { cache_creation: { ephemeral_5m_input_tokens: cache.five ?? 0, ephemeral_1h_input_tokens: cache.hour ?? 0 } } : {}) } },
  ...extra,
});

test("the TTL is the one the last request wrote with, from the message it answered; mixed writes count as the shorter", () => {
  const five = cacheStateOf([user("u1", null, 0), request("a1", "u1", 4, "r1", { five: 900 })], true);
  assert.deepEqual(five, { touchedAt: iso(0), ttlMs: 300_000, model: "claude-opus-4-7" });
  const hour = cacheStateOf([user("u1", null, 0), request("a1", "u1", 4, "r1", { hour: 900 })], true);
  assert.deepEqual(hour, { touchedAt: iso(0), ttlMs: 3_600_000, model: "claude-opus-4-7" });
  assert.equal((cacheStateOf([user("u1", null, 0), request("a1", "u1", 4, "r1", { five: 5, hour: 900 })], true) as { ttlMs: number }).ttlMs, 300_000);
});

test("a request that only read the cache keeps the TTL it was written with; the start is the earlier request, never the answer's end", () => {
  const lines = [user("u1", null, 0), request("a1", "u1", 5, "r1", { hour: 900 }), user("u2", "a1", 60, { toolUseResult: {} }), request("a2", "u2", 65, "r2", null)];
  assert.deepEqual(cacheStateOf(lines, true), { touchedAt: iso(60), ttlMs: 3_600_000, model: "claude-opus-4-7" });
  // One request logged as several entries (thinking, text, tool use) shares its request id: its own entries are not the start.
  const split = [user("u1", null, 0), request("a1", "u1", 5, "r1", { five: 9 }), request("a1b", "a1", 6, "r1", { five: 9 }), request("a1c", "a1b", 7, "r1", { five: 9 })];
  assert.deepEqual(cacheStateOf(split, true), { touchedAt: iso(0), ttlMs: 300_000, model: "claude-opus-4-7" });
});

test("a compaction after the last request makes it cold; sidechains and other branches never mix in", () => {
  const compacted = [user("u1", null, 0), request("a1", "u1", 5, "r1", { five: 9 }), JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: "a1", timestamp: iso(90) })];
  assert.equal(cacheStateOf(compacted, true), "compacted");
  const noisy = [user("u1", null, 0), request("a1", "u1", 5, "r1", { hour: 9 }),
    request("s1", "a1", 50, "rs", { five: 9 }, { isSidechain: true }), user("b1", "zz", 55), request("b2", "b1", 56, "rb", { five: 9 }, { uuid: "b2" })];
  // The newest request is on another branch (b2): its chain is its own, and its start is its own user message.
  assert.deepEqual(cacheStateOf(noisy, true), { touchedAt: iso(55), ttlMs: 300_000, model: "claude-opus-4-7" });
  assert.deepEqual(cacheStateOf([user("u1", null, 0), request("a1", "u1", 5, "r1", { hour: 9 }), request("s1", "a1", 50, "rs", { five: 9 }, { isSidechain: true })], true), { touchedAt: iso(0), ttlMs: 3_600_000, model: "claude-opus-4-7" });
  assert.equal(cacheStateOf([user("u1", null, 0)], true), null, "no request: nothing to tell");
  assert.equal(cacheStateOf([request("a1", "u0", 5, "r1", { five: 9 })], false), undefined, "the start is before the window: read more");
  assert.equal(cacheStateOf(["{not json", request("a1", "u1", 5, "r1", null), user("u1", null, 0)].reverse(), true), null, "no TTL written anywhere");
});

test("the model changed only when two full Claude model names differ; an alias or nothing cannot tell", () => {
  assert.equal(modelChanged("claude-opus-4-7", "claude-sonnet-4-5"), true);
  assert.equal(modelChanged("claude-opus-4-7", "claude-opus-4-7[1m]"), false);
  assert.equal(modelChanged("claude-opus-4-1-20250805", "claude-opus-4-1"), false);
  assert.equal(modelChanged("claude-opus-4-7", "opus"), false);
  assert.equal(modelChanged("claude-opus-4-7", null), false);
  assert.equal(modelChanged("gemini-3-pro", "claude-opus-4-7"), false);
  const agent = { id: "a", model: "claude-sonnet-4-5" };
  assert.deepEqual(cacheEntryOf(agent, { touchedAt: iso(0), ttlMs: 300_000, model: "claude-opus-4-7" }), { agentId: "a", touchedAt: iso(0), expiresAt: iso(300), ttl: "5m", cold: "model" });
  assert.deepEqual(cacheEntryOf({ id: "a", model: null }, "compacted"), { agentId: "a", touchedAt: null, expiresAt: null, ttl: null, cold: "compacted" });
  assert.equal(cacheEntryOf(agent, null), null);
});

test("the reader reads more of a long log when the start is further back, never follows a symlink and reuses an unchanged log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obs-cache-"));
  const path = join(directory, "11111111-2222-3333-4444-555555555555.jsonl");
  const filler = Array.from({ length: 700 }, (_, index) => request(`s${index}`, "nowhere", 2, `rs${index}`, { five: 1 }, { isSidechain: true, padding: "x".repeat(500) }));
  await writeFile(path, [user("u1", null, 0), ...filler, request("a1", "u1", 5, "r1", { hour: 9 })].join("\n") + "\n");
  const read = createCacheReader();
  assert.deepEqual(await read(path), { touchedAt: iso(0), ttlMs: 3_600_000, model: "claude-opus-4-7" });
  assert.deepEqual(await read(path, "identity-1"), { touchedAt: iso(0), ttlMs: 3_600_000, model: "claude-opus-4-7" });
  const link = join(directory, "link.jsonl");
  await symlink(path, link);
  await assert.rejects(read(link), /ELOOP|symbolic|too many/i);
});

test("at most the last 4 MB of a log is read: a start further back is unknown (no clock), and a huge model name is cut before matching (A4)", async () => {
  assert.equal(MAX_CACHE_WINDOW, 4 * 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), "obs-cache-window-"));
  const path = join(directory, "11111111-2222-3333-4444-666666666666.jsonl");
  const padding = "x".repeat(2000);
  const filler = Array.from({ length: 2600 }, (_, index) => request(`s${index}`, "nowhere", 2, `rs${index}`, { five: 1 }, { isSidechain: true, padding }));
  await writeFile(path, [user("u1", null, 0), ...filler, request("a1", "u1", 5, "r1", { hour: 9 })].join("\n") + "\n");
  assert.equal(await createCacheReader()(path), null, "its start is more than 4 MB back: not shown");
  assert.deepEqual(await createCacheReader({ maxWindow: 16 * 1024 * 1024 })(path), { touchedAt: iso(0), ttlMs: 3_600_000, model: "claude-opus-4-7" }, "the window alone decides");
  const started = performance.now();
  assert.equal(modelChanged(`claude-${"[".repeat(200_000)}`, "claude-opus-4-7"), true);
  assert.equal(modelChanged(`claude-opus-4-7${"[".repeat(200_000)}`, "claude-opus-4-7[1m]"), false);
  assert.ok(performance.now() - started < 200, "no quadratic matching on a long name");
});

test("observatory.cache.get: recent Claude-based sessions by what their provider extends, with a revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obs-cache-rpc-"));
  const log = (id: string) => join(directory, `${id}.jsonl`);
  const now = T0 + 120_000;
  await writeFile(log("s-own"), [user("u1", null, 0), request("a1", "u1", 5, "r1", { five: 9 })].join("\n"));
  await writeFile(log("s-custom"), [user("u1", null, 30), request("a1", "u1", 35, "r1", { hour: 9 })].join("\n"));
  await writeFile(log("s-codex"), [user("u1", null, 0), request("a1", "u1", 5, "r1", { hour: 9 })].join("\n"));
  const agent = (id: string, provider: string, sessionId: string, patch: Partial<StatsDirectoryAgent> = {}): StatsDirectoryAgent => ({ id, provider, sessionId, createdAt: iso(-60), updatedAt: iso(40), model: "claude-opus-4-7",
    parentAgentId: null, projectKey: "p", projectName: "p", status: "idle", archivedAt: null, title: id, requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null, ...patch });
  const agents = [agent("own", "claude", "s-own"), agent("custom", "work-claude", "s-custom"), agent("codex", "work-codex", "s-codex"),
    agent("archived", "claude", "s-own", { archivedAt: iso(50) }), agent("old", "claude", "s-own", { createdAt: iso(-90_000), updatedAt: iso(-80_000) }), agent("nolog", "claude", "s-missing")];
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const discovered: unknown[] = [];
  registerCacheClock({ handle: ((contract: { name: string }, handler: (input: unknown, context: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler); }) as never }, {
    directory: { agents, refresh: async () => {} }, now: () => now,
    bases: async () => ({ "work-claude": "claude", "work-codex": "codex" }),
    transcript: sessionId => sessionId === "s-missing" ? null : { path: log(sessionId), identity: sessionId },
    discover: paseo => discovered.push(paseo),
  });
  const call = (input: unknown) => handlers.get("observatory.cache.get")!(input, { paseo: {} }) as Promise<{ mode: string; revision: string; agents?: CacheEntry[] }>;
  const first = await call({});
  assert.equal(discovered.length, 1, "each read looks for custom log roots (rate limited there): after a restart no hook may have run");
  assert.equal(first.mode, "full");
  assert.deepEqual(first.agents, [
    { agentId: "custom", touchedAt: iso(30), expiresAt: iso(3630), ttl: "1h", cold: null },
    { agentId: "own", touchedAt: iso(0), expiresAt: iso(300), ttl: "5m", cold: null },
  ]);
  assert.deepEqual(await call({ revision: first.revision }), { mode: "unchanged", revision: first.revision });
});

// The device side: the countdown, its colours and when it changes next, drawn through react-native-web as the web host does.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const web = require("react-native-web");
const stubs: Record<string, unknown> = {
  "react-native": web,
  "@getpaseo/plugin/client/react-native": { Icon: ({ name }: { name: string }) => createElement("i", { "data-icon": name }) },
  "@getpaseo/plugin/client": { useRpc: () => async () => ({}) },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };
const { renderToString } = require("react-dom/server") as { renderToString(element: ReturnType<typeof createElement>): string };
const theme = { colors: { surface0: "#ffffff", surface1: "#f4f4f5", surface2: "#e4e4e7", foreground: "#18181b", foregroundMuted: "#71717a", border: "#d4d4d8", accent: "#2563eb", accentForeground: "#ffffff" } };

test("the device counts down: minutes, the last minute in seconds, amber near the end, then cold", async () => {
  const { cacheLook, cacheText, nextCacheChange } = await import("../client/cache-clock");
  const five = { expiresAt: new Date(T0 + 300_000).toISOString(), ttl: "5m" as const, cold: null };
  assert.deepEqual([cacheLook(five, T0).state, cacheText(cacheLook(five, T0))], ["warm", "缓存 5 分钟"]);
  assert.deepEqual([cacheLook(five, T0 + 250_000).state, cacheText(cacheLook(five, T0 + 250_000))], ["ending", "缓存 50 秒"]);
  assert.deepEqual([cacheLook(five, T0 + 300_000).state, cacheText(cacheLook(five, T0 + 300_000))], ["cold", "缓存已冷"]);
  const hour = { expiresAt: new Date(T0 + 3_600_000).toISOString(), ttl: "1h" as const, cold: null };
  assert.equal(cacheLook(hour, T0 + 3_200_000).state, "warm");
  assert.equal(cacheLook(hour, T0 + 3_400_000).state, "ending", "the last five minutes of an hour's cache");
  assert.equal(cacheLook({ ...hour, cold: "model" as const }, T0).state, "cold");
  assert.equal(nextCacheChange(five, T0 + 30_000), 30_000, "at the next whole minute");
  assert.equal(nextCacheChange(five, T0 + 241_000), 1_000, "each second in the last minute");
  assert.equal(nextCacheChange(hour, T0 + 3_250_000), 50_000, "at the colour change when that comes first");
  assert.equal(nextCacheChange({ ...five, cold: "compacted" as const }, T0), null, "a cold clock does not tick");
});

test("the chip: teal while warm, cold only where asked, nothing without a clock", async () => {
  const { CacheChip, CacheClockContext } = await import("../client/cache-clock");
  const now = Date.now(), entries = new Map<string, CacheEntry>([
    ["warm", { agentId: "warm", touchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240_000).toISOString(), ttl: "5m", cold: null }],
    ["cold", { agentId: "cold", touchedAt: null, expiresAt: null, ttl: null, cold: "compacted" }],
  ]);
  const draw = (agentId: string, showCold = true) => renderToString(createElement(CacheClockContext.Provider, { value: entries }, createElement(CacheChip as never, { theme, agentId, showCold } as never)));
  assert.match(draw("warm"), /缓存 4 分钟/);
  assert.match(draw("warm"), /data-icon="Timer"/);
  assert.match(draw("cold"), /缓存已冷/);
  assert.match(draw("cold"), /对话压缩过/);
  assert.equal(draw("cold", false), "");
  assert.equal(draw("nobody"), "");
});
