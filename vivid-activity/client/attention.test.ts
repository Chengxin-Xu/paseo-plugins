import { describe, expect, it } from "vitest";
import { createAttentionStores } from "./attention";
import { FOLD_TIMING } from "./fold-runtime";

function fakeTimers() {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => {
      const handle = ++next;
      timers.set(handle, { at: time + ms, run });
      return handle;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].run();
      }
      time = end;
    },
    pending: () => timers.size,
  };
}

describe("pending permission stores", () => {
  it("shares one subscription per Agent and drops the Agent's store once no row has used it for forgetMs (0.4.1)", () => {
    const timers = fakeTimers();
    const stores = createAttentionStores(timers);
    let subscribed = 0;
    let unsubscribed = 0;
    const subscribe = () => {
      subscribed += 1;
      return () => void (unsubscribed += 1);
    };
    const first = stores.acquire("agent-1", subscribe);
    const second = stores.acquire("agent-1", subscribe);
    expect(second).toBe(first);
    expect(subscribed).toBe(1);
    let heard = 0;
    const stop = stores.listen("agent-1", () => void (heard += 1));
    stores.publish(first, [{ metadata: { toolUseId: "toolu_1" } }]);
    expect(heard).toBe(1);
    expect([...stores.snapshot("agent-1")!.ids]).toEqual(["toolu_1"]);
    expect(stores.snapshot("agent-1")!.any).toBe(true);

    stores.release("agent-1", first);
    expect(unsubscribed).toBe(0);
    stores.release("agent-1", second);
    expect(unsubscribed).toBe(1);
    stop();
    timers.advance(FOLD_TIMING.forgetMs - 1);
    expect(stores.size()).toBe(1);
    timers.advance(1);
    expect(stores.size()).toBe(0);
    expect(stores.snapshot("agent-1")).toBeUndefined();
    expect(timers.pending()).toBe(0);
    // A late answer for the dropped store does not bring it back.
    stores.publish(first, []);
    expect(stores.size()).toBe(0);
  });

  it("keeps a store that is used again in time, and one that still has a listener (0.4.1)", () => {
    const timers = fakeTimers();
    const stores = createAttentionStores(timers);
    const subscribe = () => () => undefined;
    const store = stores.acquire("agent-1", subscribe);
    stores.release("agent-1", store);
    timers.advance(FOLD_TIMING.forgetMs / 2);
    const again = stores.acquire("agent-1", subscribe);
    expect(again).toBe(store);
    stores.release("agent-1", again);
    const stop = stores.listen("agent-1", () => undefined);
    timers.advance(FOLD_TIMING.forgetMs * 2);
    expect(stores.size()).toBe(1);
    stop();
    timers.advance(FOLD_TIMING.forgetMs);
    expect(stores.size()).toBe(0);
  });
});
