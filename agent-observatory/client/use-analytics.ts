import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAnalytics, mergeAnalytics, type AnalyticsState } from "../shared/analytics";
import { useForeground } from "./use-foreground";

/** Loaded only while its view is visible; unchanged polls cost a few bytes and advance coverage. */
export function useAnalytics(hostId: string, visible = true, projectId?: string) {
  const rpc = useRpc(getAnalytics), cache = useQueryClient(), active = useForeground();
  const queryKey = ["agent-observatory", hostId, "analytics", projectId ?? "all"];
  const enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<AnalyticsState>(queryKey);
    return mergeAnalytics(previous, await rpc({ ...(projectId ? { projectId } : {}), ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: enabled ? 15_000 : false, staleTime: 5000, retry: 1 });
}
