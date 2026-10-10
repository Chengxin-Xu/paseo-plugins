import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getStats, mergeStats, type StatsRange, type StatsState } from "../shared/stats";
import { useForeground } from "./use-foreground";

export const statsQueryKey = (hostId: string, range: StatsRange) => ["agent-observatory", hostId, "stats", range] as const;
/** Local offset from UTC in minutes (UTC+8 → 480), as the server buckets days and hours in it. */
export const localUtcOffset = () => -new Date().getTimezoneOffset();

/** Dashboard statistics, read only while a statistics view is visible; unchanged polls cost a few bytes. */
export function useStats(hostId: string, range: StatsRange, visible = true) {
  const rpc = useRpc(getStats), cache = useQueryClient(), active = useForeground();
  const queryKey = statsQueryKey(hostId, range);
  const enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<StatsState>(queryKey);
    return mergeStats(previous, await rpc({ range, utcOffsetMinutes: localUtcOffset(), ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: enabled ? 30_000 : false, staleTime: 10_000, retry: 1 });
}
