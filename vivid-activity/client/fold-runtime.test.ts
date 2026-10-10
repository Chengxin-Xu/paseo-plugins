import { describe, expect, it } from "vitest";
import { SHOW, type FoldRole } from "../shared/fold";
import type { FoldIndexInput, FoldIndexOutput, WireRow } from "../shared/fold-index";
import { createFoldRuntime, FOLD_TIMING } from "./fold-runtime";

/** Injected clock: every timer of the runtime runs here, never on the real one. */
function fakeClock() {
  let time = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const settle = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  };
  return {
    now: () => time,
    setTimer: (run: () => void, ms: number) => {
      const handle = ++next;
      timers.set(handle, { at: time + ms, run });
      return handle;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    async advance(ms: number) {
      const end = time + ms;
      await settle();
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].run();
        await settle();
      }
      time = end;
      await settle();
    },
    pending: () => timers.size,
  };
}

/** A projected timeline as the plugin server reports it: rows keep their start seq, updates bump a revision seq. */
function fakeTimeline(epoch = "e1") {
  let seq = 0;
  const rows: Array<{ row: WireRow; revision: number }> = [];
  let running: boolean | null = true;
  let reset = false;
  const page = (subset: typeof rows, extra: Partial<FoldIndexOutput> = {}): FoldIndexOutput => ({
    status: "ok",
    epoch,
    rows: subset.map((entry) => entry.row),
    startCursor: rows.length ? { epoch, seq: rows[0]!.row.s } : null,
    endCursor: { epoch, seq },
    hasOlder: false,
    hasNewer: false,
    reset: false,
    running,
    ...extra,
  });
  return {
    calls: [] as FoldIndexInput[],
    append(row: Omit<WireRow, "s" | "at">) {
      const s = ++seq;
      rows.push({ row: { s, at: s * 1000, ...row } as WireRow, revision: s });
      return s;
    },
    update(s: number, patch: Partial<WireRow>) {
      const entry = rows.find((candidate) => candidate.row.s === s)!;
      entry.row = { ...entry.row, ...patch };
      entry.revision = ++seq;
    },
    setRunning(value: boolean | null) {
      running = value;
    },
    resetNext() {
      reset = true;
    },
    async rpc(this: { calls: FoldIndexInput[] }, input: FoldIndexInput): Promise<FoldIndexOutput> {
      this.calls.push(input);
      if (input.direction === "tail") return page(rows);
      if (reset) {
        reset = false;
        return page([], { reset: true });
      }
      const after = input.cursor?.seq ?? 0;
      return page(rows.filter((entry) => entry.revision > after));
    },
  };
}

const user = { k: "b", w: "user_message" } as const;
const text = { k: "b", w: "assistant_message" } as const;
const shell = (callId: string, st: WireRow["st"] = "completed") => ({ k: "t", key: `t:${callId}`, st, look: "shell" }) as const;

function setup() {
  const clock = fakeClock();
  const timeline = fakeTimeline();
  let nudges = 0;
  const runtime = createFoldRuntime();
  runtime.configure({ rpc: (input) => timeline.rpc(input), nudge: () => void nudges++, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  /** What Paseo does while projecting: ask every drawn row for its role. */
  const project = (...keys: string[]) => {
    const roles: Record<string, FoldRole["kind"]> = {};
    for (const key of keys) {
      const role = runtime.roleFor(key);
      runtime.markProjected(key, role);
      roles[key] = role.kind;
    }
    return roles;
  };
  return { clock, timeline, runtime, project, nudges: () => nudges };
}

describe("fold runtime timings", () => {
  it("estimates when each row ran, keeps unchanged timings stable, and runs on the daemon's clock", async () => {
    const { clock, timeline, runtime } = setup();
    const original = timeline.rpc.bind(timeline);
    timeline.rpc = async (input) => ({ ...(await original(input)), now: clock.now() + 7_000 });
    timeline.append(user); // s1 at 1000
    timeline.append({ k: "r", key: "r:think" }); // s2 at 2000
    const bash = timeline.append(shell("a", "running")); // s3 at 3000
    let heard = 0;
    const unsubscribe = runtime.subscribeTimings("agent-1", () => void heard++);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(runtime.timing("agent-1", "r:think")).toEqual({ start: 1000, end: 2000, running: false, witnessed: false });
    const running = runtime.timing("agent-1", "t:a");
    expect(running).toEqual({ start: 2000, end: 3000, running: true, witnessed: true });
    expect(heard).toBe(1);
    expect(runtime.serverNow() - clock.now()).toBe(7_000);
    // The next live row starts where the last finished entry ended (the running call is not finished).
    expect(runtime.tailStart("agent-1")).toBe(2000);
    // Text arrives: the running call keeps its timing object; only the tail estimate moves.
    timeline.append(text);
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.timing("agent-1", "t:a")).toBe(running);
    expect(runtime.tailStart("agent-1")).toBe(4000);
    expect(heard).toBe(2);
    timeline.update(bash, { st: "completed", at: 9000 });
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.timing("agent-1", "t:a")).toEqual({ start: 2000, end: 9000, running: false, witnessed: true });
    expect(heard).toBe(3);
    unsubscribe();
  });
});

describe("fold runtime", () => {
  it("reads the tail when the first row mounts, folds finished runs and re-projects once", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(shell("c"));
    timeline.append(text);
    timeline.setRunning(false);
    expect(project("t:a", "t:b", "t:c")).toEqual({ "t:a": "show", "t:b": "show", "t:c": "show" });
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls).toEqual([{ agentId: "agent-1", direction: "tail", limit: FOLD_TIMING.tailLimit }]);
    expect(runtime.roleFor("t:a").kind).toBe("fold");
    expect(runtime.roleFor("t:b").kind).toBe("hide");
    expect(nudges()).toBe(0);
    await clock.advance(FOLD_TIMING.delay.soon);
    expect(nudges()).toBe(1);
    // Paseo projects again with the new roles; nothing changed since, so no further re-projection.
    expect(project("t:a", "t:b", "t:c")).toEqual({ "t:a": "fold", "t:b": "hide", "t:c": "hide" });
    await clock.advance(10_000);
    expect(nudges()).toBe(1);
  });

  it("reads only the increment after rows, messages or state changes; pokes coalesce", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    const a = timeline.append(shell("a", "running"));
    runtime.acquire("agent-1");
    await clock.advance(0);
    timeline.update(a, { st: "completed" });
    timeline.append(text);
    for (let index = 0; index < 5; index++) runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(timeline.calls.map((call) => call.direction)).toEqual(["tail", "after"]);
    expect(timeline.calls[1]!.cursor).toEqual({ epoch: "e1", seq: 2 });
    runtime.noteRow("agent-1", "t:a", "completed", 2000);
    runtime.noteRow("agent-1", "t:new", "running", 9000);
    await clock.advance(FOLD_TIMING.rowDelay);
    expect(timeline.calls.map((call) => call.direction)).toEqual(["tail", "after", "after"]);
  });

  it("re-projects a toggle at once and remembers it", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    const first = timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(text);
    timeline.setRunning(false);
    project("t:a", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    project("t:a", "t:b");
    const before = nudges();
    runtime.toggle("agent-1", String(first), true);
    await clock.advance(0);
    expect(nudges()).toBe(before + 1);
    expect(runtime.isExpanded("agent-1", String(first))).toBe(true);
    const role = runtime.roleFor("t:a");
    expect(role.kind === "fold" && role.summary.expanded).toBe(true);
    expect(runtime.roleFor("t:b")).toEqual(SHOW);
  });

  it("throttles background re-projections of a live run", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    for (const id of ["a", "b", "c", "d"]) timeline.append(shell(id));
    project("t:a", "t:b", "t:c", "t:d");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    expect(nudges()).toBe(1);
    project("t:a", "t:b", "t:c", "t:d");
    // A new row arrives: one more earlier step, a background re-projection, not before the 2.5 s gap.
    timeline.append(shell("e"));
    project("t:e");
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay + 100);
    expect(nudges()).toBe(1);
    await clock.advance(FOLD_TIMING.minGap.auto);
    expect(nudges()).toBe(2);
  });

  it("restores every row when folding is turned off, and folds nothing in 关闭", async () => {
    const { clock, timeline, runtime, project, nudges } = setup();
    timeline.append(user);
    timeline.append(shell("a"));
    timeline.append(shell("b"));
    timeline.append(text);
    timeline.setRunning(false);
    project("t:a", "t:b");
    runtime.acquire("agent-1");
    await clock.advance(1_000);
    project("t:a", "t:b");
    const before = nudges();
    runtime.setSettings({ enabled: false });
    await clock.advance(0);
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    expect(nudges()).toBe(before + 1);
    runtime.setSettings({ enabled: true, scope: "off" });
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    runtime.setSettings({ scope: "all" });
    expect(runtime.roleFor("t:a").kind).toBe("fold");
  });

  it("plans around a key two agents see differently, so neither loses its summary", async () => {
    const clock = fakeClock();
    const one = fakeTimeline("e1");
    const two = fakeTimeline("e2");
    const runtime = createFoldRuntime();
    runtime.configure({
      rpc: (input) => (input.agentId === "one" ? one.rpc(input) : two.rpc(input)),
      nudge: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const shared = { k: "r", key: "r:same" } as const;
    for (const timeline of [one, two]) {
      timeline.append(user);
      timeline.append(shared);
      timeline.setRunning(false);
    }
    one.append(shell("a"));
    one.append(text);
    two.append(shell("x"));
    two.append(shell("y"));
    two.append(text);
    for (const key of ["r:same", "t:a", "t:x", "t:y"]) runtime.markProjected(key, SHOW);
    runtime.acquire("one");
    runtime.acquire("two");
    await clock.advance(1_000);
    expect(runtime.roleFor("r:same")).toEqual(SHOW);
    expect(runtime.roleFor("t:a")).toEqual(SHOW);
    expect(runtime.roleFor("t:x").kind).toBe("fold");
    expect(runtime.roleFor("t:y").kind).toBe("hide");
  });

  it("retries a failed read (2 s, 5 s, 15 s) and re-reads the tail after a reset", async () => {
    const { clock, timeline, runtime } = setup();
    let fail = 2;
    const original = timeline.rpc.bind(timeline);
    timeline.rpc = async (input) => {
      if (fail-- > 0) {
        timeline.calls.push(input);
        throw new Error("offline");
      }
      return original(input);
    };
    timeline.append(user);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls.length).toBe(1);
    await clock.advance(1_999);
    expect(timeline.calls.length).toBe(1);
    await clock.advance(1);
    expect(timeline.calls.length).toBe(2);
    await clock.advance(5_000);
    expect(timeline.calls.length).toBe(3);
    expect(runtime.debugAgent("agent-1")?.loaded).toBe(true);
    timeline.resetNext();
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(timeline.calls.slice(-2).map((call) => call.direction)).toEqual(["after", "tail"]);
  });

  it("checks rows that mounted before the first read, and stops polling after the last row leaves", async () => {
    const { clock, timeline, runtime } = setup();
    timeline.append(user);
    runtime.acquire("agent-1");
    runtime.noteRow("agent-1", "t:later", "running", 5_000);
    await clock.advance(0);
    await clock.advance(FOLD_TIMING.rowDelay);
    expect(timeline.calls.map((call) => call.direction)).toEqual(["tail", "after"]);
    await clock.advance(FOLD_TIMING.pollMs);
    expect(timeline.calls.length).toBe(3);
    runtime.release("agent-1");
    await clock.advance(FOLD_TIMING.releaseGraceMs + FOLD_TIMING.pollMs * 2);
    const settled = timeline.calls.length;
    await clock.advance(FOLD_TIMING.pollMs * 4);
    expect(timeline.calls.length).toBe(settled);
    runtime.acquire("agent-1");
    await clock.advance(0);
    expect(timeline.calls.at(-1)?.direction).toBe("after");
  });

  it("starts a live row of an autonomous turn at that turn's start, not at the last turn's reply (0.3.0-local.3)", async () => {
    const { clock, runtime } = setup();
    const HOUR = 3_600_000;
    let active: FoldIndexOutput["active"] = null;
    let rows: WireRow[] = [
      { s: 1, at: 10_000, k: "b", w: "user_message", u: 0 },
      { s: 2, at: 12_000, k: "r", key: "r:a", u: 0 },
      { s: 3, at: 30_000, k: "b", w: "assistant_message", u: 0 },
    ];
    let turns: NonNullable<FoldIndexOutput["turns"]> = [{ id: "foreground-turn-31", at: null }];
    const calls: string[] = [];
    runtime.configure({
      rpc: async (input) => {
        calls.push(input.direction);
        return { status: "ok", epoch: "e1", rows, startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: rows.length }, hasOlder: false, hasNewer: false, reset: false, running: active !== null, now: clock.now(), turns, active };
      },
      nudge: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    runtime.acquire("agent-1");
    await clock.advance(0);
    // Idle: no running turn, so nothing to time a live row from.
    expect(runtime.tailStart("agent-1")).toBeNull();
    // An hour later Claude Code wakes up by itself: the read reports the running turn and its start.
    active = { id: "autonomous-turn-32", at: HOUR + 29_000 };
    runtime.setRunning("agent-1", true);
    await clock.advance(FOLD_TIMING.rowDelay);
    expect(runtime.tailStart("agent-1")).toBe(HOUR + 29_000);
    // Its first reasoning lands: the next row starts when that ended, and the reasoning starts at the turn's start.
    rows = [...rows, { s: 4, at: HOUR + 33_000, k: "r", key: "r:b", u: 1 }];
    turns = [{ id: "foreground-turn-31", at: null }, { id: "autonomous-turn-32", at: HOUR + 29_000 }];
    runtime.poke();
    await clock.advance(FOLD_TIMING.pokeDelay);
    expect(runtime.timing("agent-1", "r:b")).toMatchObject({ start: HOUR + 29_000, end: HOUR + 33_000 });
    expect(runtime.tailStart("agent-1")).toBe(HOUR + 33_000);
    expect(calls[0]).toBe("tail");
  });

  it("stops asking about an Agent the daemon does not have (a provider subagent's own view)", async () => {
    const { clock, runtime } = setup();
    const calls: string[] = [];
    runtime.configure({
      rpc: async (input) => {
        calls.push(input.direction);
        return { status: "missing", epoch: "", rows: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, reset: false, running: null };
      },
      nudge: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const subagent = "provider:6f1c2d3e:toolu_01";
    runtime.acquire(subagent);
    runtime.noteRow(subagent, "t:x", "running", 1_000);
    await clock.advance(0);
    await clock.advance(FOLD_TIMING.pollMs * 6);
    runtime.poke();
    runtime.setRunning(subagent, true);
    runtime.noteRow(subagent, "t:y", "completed", 2_000);
    await clock.advance(FOLD_TIMING.pollMs * 6);
    expect(calls).toEqual(["tail"]);
    expect(runtime.roleFor("t:x")).toBe(SHOW);
    expect(runtime.timing(subagent, "t:x")).toBeNull();
  });
});
