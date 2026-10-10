import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getDigest, mergeDigest, type DigestState } from "../shared/digest";
import { useForeground } from "./use-foreground";

/** An agent's execution digest (复盘) while its tab is open; running agents refresh every 10 s (unchanged replies are tiny). */
export function useDigest(agentId: string, visible: boolean, running: boolean) {
  const rpc = useRpc(getDigest), cache = useQueryClient(), active = useForeground();
  const queryKey = ["agent-observatory", "digest", agentId], enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<DigestState>(queryKey);
    return mergeDigest(previous, await rpc({ agentId, ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: enabled ? running ? 10_000 : 60_000 : false, staleTime: 5000, retry: 1 });
}
