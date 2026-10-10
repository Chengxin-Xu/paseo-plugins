import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useSyncExternalStore } from "react";
import { pendingCallIds } from "../shared/vivid-model";
import { FOLD_TIMING } from "./fold-runtime";

/**
 * 本地补丁：哪些工具调用正在等你批准。按 Agent 共享一个订阅（Paseo 客户端已有的 agent_update 流，
 * 不额外轮询），第一行出现时建立，最后一行卸载时释放。Claude 的权限请求带 metadata.toolUseId，
 * ACP 的带 metadata.toolCallId，二者都等于时间线里的 callId。
 * 0.4.1：没有行再用的 Agent，过 FOLD_TIMING.forgetMs 后连同记录一起删掉，长时间来回看很多 Agent 时不再越积越多。
 */
type Store = { ids: ReadonlySet<string>; any: boolean; listeners: Set<() => void>; refs: number; release: (() => void) | null; drop: unknown };
type Pending = Parameters<typeof pendingCallIds>[0];
const EMPTY: ReadonlySet<string> = new Set();

export interface AttentionTimers {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL_TIMERS: AttentionTimers = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The per-Agent stores (one per plugin evaluation); exported for tests. */
export function createAttentionStores(timers: AttentionTimers = REAL_TIMERS, forgetMs: number = FOLD_TIMING.forgetMs) {
  const stores = new Map<string, Store>();
  function storeFor(agentId: string): Store {
    let store = stores.get(agentId);
    if (!store) {
      store = { ids: EMPTY, any: false, listeners: new Set(), refs: 0, release: null, drop: null };
      stores.set(agentId, store);
    }
    if (store.drop !== null) {
      timers.clearTimer(store.drop);
      store.drop = null;
    }
    return store;
  }
  function dropLater(agentId: string, store: Store): void {
    if (store.refs > 0 || store.listeners.size > 0 || store.drop !== null) return;
    store.drop = timers.setTimer(() => {
      store.drop = null;
      if (store.refs === 0 && store.listeners.size === 0 && stores.get(agentId) === store) stores.delete(agentId);
    }, forgetMs);
  }
  return {
    /** A row of the Agent mounted; the first one subscribes (`subscribe` returns how to unsubscribe). */
    acquire(agentId: string, subscribe: (store: Store) => () => void): Store {
      const store = storeFor(agentId);
      store.refs += 1;
      if (store.refs === 1) store.release = subscribe(store);
      return store;
    },
    /** The row unmounted; the last one unsubscribes. */
    release(agentId: string, store: Store): void {
      if (store.refs === 0) return;
      store.refs -= 1;
      if (store.refs > 0) return;
      store.release?.();
      store.release = null;
      dropLater(agentId, store);
    },
    listen(agentId: string, listener: () => void): () => void {
      const store = storeFor(agentId);
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
        dropLater(agentId, store);
      };
    },
    snapshot(agentId: string): Store | undefined {
      return stores.get(agentId);
    },
    publish(store: Store, pending: Pending): void {
      const ids = pendingCallIds(pending);
      const any = (pending?.length ?? 0) > 0;
      if (any === store.any && ids.size === store.ids.size && [...ids].every((id) => store.ids.has(id))) return;
      store.ids = ids;
      store.any = any;
      for (const listener of store.listeners) listener();
    },
    size(): number {
      return stores.size;
    },
  };
}

const attention = createAttentionStores();

export function usePendingPermissions(agentId: string): { ids: ReadonlySet<string>; any: boolean } {
  const paseo = usePaseo();
  useEffect(() => {
    const store = attention.acquire(agentId, (subscribed) => {
      const handle = paseo.agents.ref(agentId);
      const unsubscribe = handle.subscribe((update) => {
        if (update.kind === "upsert" && update.agent.id === agentId) attention.publish(subscribed, update.agent.pendingPermissions);
      });
      void handle.refresh().then(() => attention.publish(subscribed, handle.pendingPermissions), () => {});
      return unsubscribe;
    });
    return () => attention.release(agentId, store);
  }, [agentId, paseo]);
  const ids = useSyncExternalStore(
    (listener) => attention.listen(agentId, listener),
    () => attention.snapshot(agentId)?.ids ?? EMPTY,
    () => EMPTY,
  );
  const any = useSyncExternalStore(
    (listener) => attention.listen(agentId, listener),
    () => attention.snapshot(agentId)?.any ?? false,
    () => false,
  );
  return { ids, any };
}
