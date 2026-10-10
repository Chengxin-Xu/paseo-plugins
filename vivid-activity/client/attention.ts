import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useSyncExternalStore } from "react";
import { pendingCallIds } from "../shared/vivid-model";

/**
 * 本地补丁：哪些工具调用正在等你批准。按 Agent 共享一个订阅（Paseo 客户端已有的 agent_update 流，
 * 不额外轮询），第一行出现时建立，最后一行卸载时释放。Claude 的权限请求带 metadata.toolUseId，
 * ACP 的带 metadata.toolCallId，二者都等于时间线里的 callId。
 */
type Store = { ids: ReadonlySet<string>; any: boolean; listeners: Set<() => void>; refs: number; release: (() => void) | null };
const stores = new Map<string, Store>();
const EMPTY: ReadonlySet<string> = new Set();


function storeFor(agentId: string): Store {
  let store = stores.get(agentId);
  if (!store) { store = { ids: EMPTY, any: false, listeners: new Set(), refs: 0, release: null }; stores.set(agentId, store); }
  return store;
}
function publish(store: Store, pending: Parameters<typeof pendingCallIds>[0]) {
  const ids = pendingCallIds(pending);
  const any = (pending?.length ?? 0) > 0;
  if (any === store.any && ids.size === store.ids.size && [...ids].every((id) => store.ids.has(id))) return;
  store.ids = ids; store.any = any;
  for (const listener of store.listeners) listener();
}

export function usePendingPermissions(agentId: string): { ids: ReadonlySet<string>; any: boolean } {
  const paseo = usePaseo();
  useEffect(() => {
    const store = storeFor(agentId);
    store.refs += 1;
    if (store.refs === 1) {
      const handle = paseo.agents.ref(agentId);
      const unsubscribe = handle.subscribe((update) => {
        if (update.kind === "upsert" && update.agent.id === agentId) publish(store, update.agent.pendingPermissions);
      });
      void handle.refresh().then(() => publish(store, handle.pendingPermissions), () => {});
      store.release = unsubscribe;
    }
    return () => {
      store.refs -= 1;
      if (store.refs === 0) { store.release?.(); store.release = null; }
    };
  }, [agentId, paseo]);
  const ids = useSyncExternalStore(
    (listener) => { const store = storeFor(agentId); store.listeners.add(listener); return () => store.listeners.delete(listener); },
    () => stores.get(agentId)?.ids ?? EMPTY,
    () => EMPTY,
  );
  const any = useSyncExternalStore(
    (listener) => { const store = storeFor(agentId); store.listeners.add(listener); return () => store.listeners.delete(listener); },
    () => stores.get(agentId)?.any ?? false,
    () => false,
  );
  return { ids, any };
}
