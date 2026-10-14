import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSummaryOutput } from "../shared/child-summary";

/** Runs the production hook with persistent React hook slots and commit-phase cleanup/effect ordering. */
const harness = vi.hoisted(() => {
  const state = {
    slots: [] as any[], cursor: 0, dirty: false,
    effects: [] as Array<{ index: number; run: () => unknown; previous?: () => void }>,
    agents: new Map<string, any>(),
    requests: [] as Array<{ input: any; resolve(value: ChildSummaryOutput): void }>,
  };
  return {
    state,
    rpc(input: any) { return new Promise<ChildSummaryOutput>((resolve) => state.requests.push({ input, resolve })); },
    useState(initial: any) {
      const index = state.cursor++;
      if (!state.slots[index]) state.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [state.slots[index].value, (update: any) => {
        const next = typeof update === "function" ? update(state.slots[index].value) : update;
        if (!Object.is(next, state.slots[index].value)) { state.slots[index].value = next; state.dirty = true; }
      }];
    },
    useRef(initial: any) {
      const index = state.cursor++;
      return state.slots[index] ?? (state.slots[index] = { current: initial });
    },
    useEffect(run: () => unknown, deps: unknown[]) {
      const index = state.cursor++;
      const previous = state.slots[index];
      if (!previous || deps.some((value, key) => !Object.is(value, previous.deps[key]))) {
        state.effects.push({ index, run, previous: previous?.cleanup });
        state.slots[index] = { deps };
      }
    },
  };
});
vi.mock("react", () => ({ useState: harness.useState, useRef: harness.useRef, useEffect: harness.useEffect, useCallback: (callback: unknown) => callback }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => harness.rpc, useAgent: (id: string, selector: (value: any) => unknown) => harness.state.agents.has(id) ? selector(harness.state.agents.get(id)) : null }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("./kit", () => ({ Button: "Button", StatusDot: "StatusDot" }));
vi.mock("./motion", () => ({ Breathe: "Breathe" }));
vi.mock("./visibility", () => ({ useCardVisibility: () => "visible" }));
vi.mock("./use-foreground", () => ({ useForeground: () => true }));
import { useChildFeed } from "./child-agent";

const { state } = harness;
let input: Parameters<typeof useChildFeed>;
let view: ReturnType<typeof useChildFeed>;
function render() {
  for (let pass = 0; pass < 20; pass++) {
    state.cursor = 0; state.dirty = false;
    view = useChildFeed(...input);
    const effects = state.effects; state.effects = [];
    for (const effect of effects) effect.previous?.();
    for (const effect of effects) state.slots[effect.index].cleanup = effect.run();
    if (!state.dirty) return view;
  }
  throw new Error("Hook render did not settle");
}
function unmount() { for (const slot of state.slots) slot?.cleanup?.(); }
const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); render(); };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); render(); };
function agent(id: string, status: string, stamp: number) { state.agents.set(id, { status, updatedAt: stamp, lastActivityAt: stamp }); }
const response = (status = "running", text = "summary"): ChildSummaryOutput => ({ status: status === "closed" ? "closed" : "ok", agent: { status }, rows: [{ k: "1", i: "MessageSquare", t: "Agent", x: text, c: "communication" }] });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  state.slots = []; state.effects = []; state.requests = []; state.agents.clear(); state.dirty = false;
  input = ["child", true, "visible"]; agent("child", "running", 1);
});
afterEach(() => { unmount(); vi.useRealTimers(); });

describe("child feed lifecycle", () => {
  it.each([response("closed"), { status: "missing", agent: null, rows: [] } as ChildSummaryOutput])("does not let a stale terminal answer block the refresh queued by a newer host update (%j)", async (terminal) => {
    render(); await advance(0);
    agent("child", "idle", 2); render();
    state.requests[0]!.resolve(terminal); await settle();
    expect(view.hold).toBeNull();
    await advance(0);
    expect(state.requests).toHaveLength(2);
    state.requests[1]!.resolve(response("idle", "current summary")); await settle();
    expect(view.status).toBe("idle");
    expect(view.view.entries[0]!.x).toBe("current summary");
  });

  it("rechecks a previously closed child on a running update, then reads its summary", async () => {
    render(); await advance(0);
    state.requests[0]!.resolve(response("closed")); await settle();
    expect(view.hold).toBe("closed");
    agent("child", "running", 2); render(); await advance(5000);
    expect(state.requests[1]!.input.statusOnly).toBe(true);
    state.requests[1]!.resolve(response("running")); await settle(); await advance(0);
    expect(state.requests[2]!.input.statusOnly).toBe(false);
    state.requests[2]!.resolve(response("running", "reopened")); await settle();
    expect(view.view.entries[0]!.x).toBe("reopened");
  });

  it("drops the old agent's in-flight response after agentId changes and cancels the new read on unmount", async () => {
    render(); await advance(0);
    input = ["other", true, "visible"]; agent("other", "running", 1); render(); await advance(0);
    expect(state.requests.map((request) => request.input.agentId)).toEqual(["child", "other"]);
    state.requests[0]!.resolve(response("closed", "wrong child")); await settle();
    expect(view.hold).toBeNull();
    expect(view.view.entries).toEqual([]);
    unmount();
    state.requests[1]!.resolve(response("running", "unmounted"));
    state.dirty = false;
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(state.dirty).toBe(false);
  });

  it("keeps a missed update dirty while backgrounded and makes one catch-up on return", async () => {
    render(); await advance(0);
    state.requests[0]!.resolve(response()); await settle();
    agent("child", "running", 2); render();
    input = ["child", false, "visible"]; render();
    await advance(10_000);
    expect(state.requests).toHaveLength(1);
    input = ["child", true, "visible"]; render(); await advance(0);
    expect(state.requests).toHaveLength(2);
    state.requests[1]!.resolve(response("running", "caught up")); await settle();
    // (Ten quiet seconds would read a running child once more: see below.)
    await advance(9_000);
    expect(state.requests).toHaveLength(2);
  });

  it("says when the daemon could not confirm the child is loaded, reads nothing, and asks again on the next update (0.6.0)", async () => {
    render(); await advance(0);
    state.requests[0]!.resolve({ status: "unconfirmed", agent: null, rows: [] }); await settle();
    expect(view.view).toMatchObject({ unconfirmed: true, entries: [], loading: false, error: null });
    expect(view.hold).toBeNull();
    agent("child", "running", 2); render(); await advance(5000);
    expect(state.requests).toHaveLength(2);
    state.requests[1]!.resolve(response("running", "confirmed")); await settle();
    expect(view.view).toMatchObject({ unconfirmed: false });
    expect(view.view.entries[0]!.x).toBe("confirmed");
  });

  it("still presents a successful preview while newer stream updates wait for the trailing refresh", async () => {
    render(); await advance(0);
    agent("child", "running", 2); render();
    state.requests[0]!.resolve(response("running", "useful partial preview")); await settle();
    expect(view.view.entries[0]!.x).toBe("useful partial preview");
    await advance(4999); expect(state.requests).toHaveLength(1);
    await advance(1); expect(state.requests).toHaveLength(2);
  });
});

describe("a running child whose host sends no updates (0.6.0-local.5)", () => {
  it("is read again after ten quiet seconds while the card may read", async () => {
    render(); await advance(0);
    state.requests[0]!.resolve(response("running", "first")); await settle();
    await advance(9_999); expect(state.requests).toHaveLength(1);
    // The quiet spell queues a refresh at once (fake timers start a timer set inside another one a millisecond later).
    await advance(2); expect(state.requests).toHaveLength(2);
    expect(state.requests[1]!.input).toMatchObject({ agentId: "child", manual: false, statusOnly: false });
    state.requests[1]!.resolve(response("running", "second")); await settle();
    expect(view.view.entries[0]!.x).toBe("second");
    await advance(10_000); expect(state.requests).toHaveLength(3);
  });

  it("starts the quiet spell again on every host update, so a child that reports reads no more than before", async () => {
    render(); await advance(0);
    state.requests[0]!.resolve(response()); await settle();
    // A host update every nine seconds: one read for each, none in between.
    for (let n = 1; n <= 4; n++) {
      await advance(9_000); expect(state.requests).toHaveLength(n);
      agent("child", "running", n + 1); render(); await advance(0);
      expect(state.requests).toHaveLength(n + 1);
      state.requests[n]!.resolve(response()); await settle();
    }
  });

  it("does not read an idle child, nor a running one while the card may not read", async () => {
    agent("child", "idle", 1); render(); await advance(0);
    state.requests[0]!.resolve(response("idle")); await settle();
    await advance(60_000); expect(state.requests).toHaveLength(1);
    input = ["child", false, "visible"]; agent("child", "running", 2); render();
    await advance(60_000); expect(state.requests).toHaveLength(1);
  });
});

describe("an answer slower than the quiet spell (0.6.0-local.5, codex-vivid-merge-F1)", () => {
  // The quiet spell is no news about the child, so an answer still on its way when it falls due stays current. Only a
  // real host update makes a terminal answer stale (see 「does not let a stale terminal answer block…」 above).
  it.each([
    ["closed", response("closed"), "closed", "closed"],
    ["missing", { status: "missing", agent: null, rows: [] } as ChildSummaryOutput, null, "unknown"],
  ] as const)("takes a %s answer that comes back after 11 seconds, and reads no more", async (_name, answer, status, hold) => {
    render(); await advance(0);
    await advance(11_000);
    expect(state.requests).toHaveLength(1);
    state.requests[0]!.resolve(answer); await settle(); await advance(0);
    expect(view.status).toBe(status);
    expect(view.hold).toBe(hold);
    expect(view.view.loading).toBe(false);
    await advance(60_000);
    expect(state.requests).toHaveLength(1);
  });

  it("takes an unconfirmed answer that comes back after 11 seconds, and asks again at the next quiet spell", async () => {
    render(); await advance(0);
    await advance(11_000);
    state.requests[0]!.resolve({ status: "unconfirmed", agent: null, rows: [] }); await settle(); await advance(0);
    expect(view.view).toMatchObject({ unconfirmed: true, loading: false, entries: [] });
    expect(view.hold).toBeNull();
    // The quiet spell that fell due while the read was on its way queued nothing: no second read right after the answer.
    expect(state.requests).toHaveLength(1);
    await advance(9_002); expect(state.requests).toHaveLength(2);
  });

  it("shows a slow summary and does not read again right after it lands", async () => {
    render(); await advance(0);
    await advance(11_000);
    state.requests[0]!.resolve(response("running", "slow summary")); await settle(); await advance(0);
    expect(view.view.entries[0]!.x).toBe("slow summary");
    expect(state.requests).toHaveLength(1);
    await advance(9_002); expect(state.requests).toHaveLength(2);
  });
});
