import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatsRange } from "../shared/stats";
import { getTokenLive, getTokens, mergeTokens, type TokenState } from "../shared/tokens";
import { useForeground } from "./use-foreground";
import { localUtcOffset } from "./use-stats";

export const tokensQueryKey = (hostId: string, range: StatsRange) => ["agent-observatory", hostId, "tokens", range] as const;

/** Token ledger snapshot while the Token view is visible; polls faster while the first import of old logs runs. */
export function useTokens(hostId: string, range: StatsRange, visible = true) {
  const rpc = useRpc(getTokens), cache = useQueryClient(), active = useForeground();
  const queryKey = tokensQueryKey(hostId, range), enabled = active && visible;
  return useQuery({ queryKey, queryFn: async () => {
    const previous = cache.getQueryData<TokenState>(queryKey);
    return mergeTokens(previous, await rpc({ range, utcOffsetMinutes: localUtcOffset(), ...(previous?.revision ? { revision: previous.revision } : {}) }));
  }, enabled, refetchInterval: query => enabled ? query.state.data?.coverage.backfill.done === false ? 5000 : 30_000 : false, staleTime: 5000, retry: 1 });
}

/**
 * Live token speed. "full" (the Token view) polls every 5 s; "agents" (running rows elsewhere) every 10 s and carries
 * only the per-session rates. Replies are answered from the server's memory.
 */
export function useTokenLive(hostId: string, visible: boolean, detail: "full" | "agents" = "full", windowMinutes: 30 | 60 = 30) {
  const rpc = useRpc(getTokenLive), active = useForeground(), enabled = active && visible;
  return useQuery({ queryKey: ["agent-observatory", hostId, "tokens-live", detail, windowMinutes], queryFn: () => rpc({ windowMinutes, utcOffsetMinutes: localUtcOffset(), detail }),
    enabled, refetchInterval: enabled ? detail === "full" ? 5000 : 10_000 : false, staleTime: 2000, retry: 1, placeholderData: keepPreviousData });
}
