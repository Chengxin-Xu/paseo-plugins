import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRecapStatus, getRecaps, mergeRecaps, type RecapState } from "../shared/recap";
import { useForeground } from "./use-foreground";

export const recapsQueryKey = (hostId: string) => ["agent-observatory", hostId, "recaps"] as const;
export const recapStatusQueryKey = ["agent-observatory", "recap-status"] as const;
/**
 * Every Agent's 每轮小结, read only while a page or the badge's popover shows them and the app is in front: every 20 s, every
 * 5 s while one is being written, once a minute while recaps are off (to notice another device turning them on).
 */
export function useRecaps(hostId: string, enabled = true) {
  const rpc = useRpc(getRecaps), cache = useQueryClient(), foreground = useForeground();
  const queryKey = recapsQueryKey(hostId), on = enabled && foreground;
  return useQuery({ queryKey, enabled: on, staleTime: 3_000, retry: 1, refetchOnWindowFocus: false,
    queryFn: async () => {
      const previous = cache.getQueryData<RecapState>(queryKey);
      try { return mergeRecaps(previous, await rpc(previous?.revision ? { revision: previous.revision } : {})); }
      catch (error) { if (!previous) throw error; return mergeRecaps(undefined, await rpc({})); }
    },
    refetchInterval: query => !on ? false : !query.state.data?.enabled ? 60_000 : query.state.data.busy ? 5_000 : 20_000 });
}

/** Who writes recaps and whether it can, while the settings show it. */
export function useRecapStatus(open: boolean) {
  const rpc = useRpc(getRecapStatus);
  return useQuery({ queryKey: recapStatusQueryKey, enabled: open, staleTime: 15_000, retry: 1, refetchOnWindowFocus: false, queryFn: () => rpc({}) });
}
