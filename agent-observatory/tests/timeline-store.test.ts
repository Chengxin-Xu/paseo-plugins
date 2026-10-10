import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineCache, createTimelineStore, type TimelineClock, type TimelineTransport } from "../client/timeline-store";
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const value: TimelineClock = { now: () => now, setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clearTimeout(id) { timers.delete(id as unknown as number); } };
  return { value, async advance(ms: number) { const end = now + ms; for (;;) { const timer = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!timer) break; now = timer[1].at; timers.delete(timer[0]); timer[1].fn(); await settle(); } now = end; await settle(); }, get timers() { return timers.size; } };
}
const page = (seq: number[], epoch = "one") => ({ epoch, rows: seq.map(n => ({ seqStart: n, seqEnd: n, timestamp: "2026-09-17T00:00:00Z", item: { type: "assistant_message", text: `message-${n}` } })), hasOlder: seq[0] > 1, hasNewer: false });
test("40 deltas across four seconds cause at most three authoritative reads", async () => {
  const time = clock(); let calls = 0, emit!: (event: unknown) => void;
  const store = createTimelineStore({ fetch: async () => { calls++; return page([10, 11]); }, subscribe(listener) { emit = listener; return Object.assign(() => {}, { ready: Promise.resolve() }); } }, { clock: time.value });
  const release = store.acquire(); await settle();
  for (let i = 0; i < 40; i++) { emit({ event: { type: "timeline", item: { type: "assistant_message", text: "delta" } } }); await time.advance(100); }
  assert.equal(calls, 3); assert.equal(store.getSnapshot().page?.rows.length, 2);
  release(); assert.equal(time.timers, 0);
});
test("shared subscribers pause independently and retain history and scroll state", async () => {
  const time = clock(); let subscriptions = 0, unsubscriptions = 0, calls = 0;
  const transport: TimelineTransport = { fetch: async input => { calls++; return input.direction === "before" ? page([1, 2]) : page([10, 11]); }, subscribe() { subscriptions++; return () => { unsubscriptions++; }; } };
  const store = createTimelineStore(transport, { clock: time.value });
  const release1 = store.acquire(), release2 = store.acquire(); await settle();
  assert.equal(subscriptions, 1);
  await store.loadOlder(); store.setViewState({ scrollOffset: 880, filter: "tools", followTail: false });
  release1(); assert.equal(unsubscriptions, 0); release2(); assert.equal(unsubscriptions, 1);
  assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [1, 2, 10, 11]);
  await time.advance(60_000); assert.equal(calls, 2);
  const release3 = store.acquire(); await settle();
  assert.equal(subscriptions, 2); assert.equal(store.getSnapshot().viewState.scrollOffset, 880);
  assert.equal(store.getSnapshot().viewState.filter, "tools"); assert.equal(store.getSnapshot().page?.hasOlder, false);
  release3();
});
test("epoch replacement discards old page response and resets only epoch-bound scroll", async () => {
  const time = clock(); let emit!: (event: unknown) => void, resolve!: (page: unknown) => void;
  let calls = 0;
  const store = createTimelineStore({ fetch: () => ++calls === 1 ? new Promise(yes => { resolve = yes; }) : Promise.resolve(page([1], "two")), subscribe(fn) { emit = fn; return () => {}; } }, { clock: time.value });
  const release = store.acquire(); await settle(); store.setViewState({ scrollOffset: 90, filter: "errors" });
  emit({ event: { type: "replacement", epoch: "two" } }); resolve(page([10], "one")); await settle();
  assert.equal(store.getSnapshot().page, null); await time.advance(2000);
  assert.equal(store.getSnapshot().page?.epoch, "two"); assert.equal(store.getSnapshot().viewState.scrollOffset, 0); assert.equal(store.getSnapshot().viewState.filter, "errors"); release();
});
test("errors retain last successful page and periodic fallback recovers", async () => {
  const time = clock(); let fail = false;
  const store = createTimelineStore({ fetch: async () => { if (fail) throw new Error("offline"); return page([1]); } }, { clock: time.value });
  const release = store.acquire(); await settle(); fail = true; await time.advance(30_000);
  assert.equal(store.getSnapshot().error, "offline"); assert.equal(store.getSnapshot().page?.rows.length, 1);
  fail = false; await time.advance(30_000); assert.equal(store.getSnapshot().error, null); release();
});
test("LRU evicts inactive histories but retains stores with mounted observers", () => {
  const cache = createTimelineCache({ limit: 2 });
  const create = (onChange: () => void) => createTimelineStore({ fetch: async () => page([]) }, { onChange });
  const one = cache.get("one", create), unsubscribe = one.subscribe(() => {});
  cache.get("two", create); cache.get("three", create);
  assert.equal(cache.size, 2); assert.equal(cache.get("one", create), one); unsubscribe();
});
test("oversized row content is bounded with explicit truncation", async () => {
  const time = clock();
  const store = createTimelineStore({ fetch: async () => ({ ...page([1]), rows: [{ seqStart: 1, seqEnd: 1, item: { type: "tool_call", name: "exec", detail: { output: "x".repeat(5_000_000) } } }] }) }, { clock: time.value });
  const release = store.acquire(); await settle(); assert.equal(store.getSnapshot().page?.truncated, true); assert.ok(store.bytes < 4 * 1024 * 1024); release();
});

test("an old subscription readiness failure cannot overwrite a newly resumed connection", async () => {
  const time = clock(); let rejectOld!: (error: Error) => void, subscriptions = 0;
  const store = createTimelineStore({ fetch: async () => page([1]), subscribe() {
    subscriptions++;
    return Object.assign(() => {}, { ready: subscriptions === 1 ? new Promise<void>((_, reject) => { rejectOld = reject; }) : Promise.resolve() });
  } }, { clock: time.value });
  const release = store.acquire(); await settle(); release();
  const releaseNext = store.acquire(); await settle();
  assert.equal(store.getSnapshot().live, true);
  rejectOld(new Error("Old connection closed")); await settle();
  assert.equal(store.getSnapshot().live, true); assert.equal(store.getSnapshot().error, null);
  releaseNext();
});

test("subscription_restored re-reads the tail because 0.9 does not replay missed events", async () => {
  const time = clock(); let calls = 0, emit!: (event: unknown) => void;
  const store = createTimelineStore({ fetch: async () => { calls++; return page([10, 11]); }, subscribe(listener) { emit = listener; return Object.assign(() => {}, { ready: Promise.resolve() }); } }, { clock: time.value });
  const release = store.acquire(); await settle();
  assert.equal(calls, 1); assert.equal(store.getSnapshot().live, true);
  emit({ agentId: "a", event: { type: "error", error: "stream closed" } }); await settle();
  assert.equal(store.getSnapshot().live, false);
  emit({ agentId: "a", subscriptionId: "s2", event: { type: "subscription_restored" } }); await time.advance(2_000);
  assert.equal(store.getSnapshot().live, true); assert.ok(calls >= 2);
  release();
});

test("an observation error releases it; a new subscription is established with backoff while open", async () => {
  const time = clock(); let subscriptions = 0, emit!: (event: unknown) => void, unsubscribed = 0;
  const store = createTimelineStore({ fetch: async () => page([1]), subscribe(listener) {
    subscriptions++; emit = listener;
    return Object.assign(() => { unsubscribed++; }, { ready: subscriptions === 2 ? Promise.reject(new Error("still offline")) : Promise.resolve() });
  } }, { clock: time.value });
  const release = store.acquire(); await settle();
  emit({ agentId: "a", event: { type: "error", error: "Timeline observation failed" } }); await settle();
  assert.equal(store.getSnapshot().live, false); assert.equal(store.getSnapshot().error, "Timeline observation failed");
  await time.advance(2_000); assert.equal(subscriptions, 2); assert.equal(store.getSnapshot().live, false);
  await time.advance(5_000); assert.equal(subscriptions, 3); assert.equal(store.getSnapshot().live, true);
  release(); assert.equal(time.timers, 0); assert.ok(unsubscribed >= 2);
});

test("a tail that starts beyond the cached end replaces it instead of leaving a silent gap", async () => {
  const time = clock(); let tail = page([1, 2, 3]);
  const store = createTimelineStore({ fetch: async () => tail }, { clock: time.value });
  const release = store.acquire(); await settle();
  tail = { ...page([400, 401]), hasOlder: true }; await store.refresh(); await time.advance(2_000);
  assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [400, 401]);
  assert.equal(store.getSnapshot().page?.hasOlder, true);
  tail = { ...page([401, 402]), hasOlder: true }; await time.advance(30_000);
  assert.deepEqual(store.getSnapshot().page?.rows.map(row => row.seqStart), [400, 401, 402], "overlapping tails still merge");
  release();
});
