import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelInsightSuggestions, getInsightOverview, getInsightSuggestions, mergeOverview, setActionFeedback, startInsightSuggestions,
  type ActionFeedback, type OverviewDays, type OverviewState, type SuggestionJob } from "../shared/insight-overview";
import { listInsightModels, listInsightRunners, updateInsightSettings, type InsightRunner } from "../shared/insights";
import { useForeground } from "./use-foreground";
import { localTimeZone, localUtcOffset } from "./use-stats";

export const insightsQueryPrefix = ["agent-observatory", "insights"] as const;
/** The device's clock for the 7 / 30-day windows (grok-F3): its offset now and, when the runtime can tell, its IANA zone. */
export function deviceClock(): { utcOffsetMinutes: number; timeZone?: string } {
  const timeZone = localTimeZone();
  return { utcOffsetMinutes: localUtcOffset(), ...(timeZone ? { timeZone } : {}) };
}

const busyJob: readonly string[] = ["queued", "collecting", "analyzing"];
/** 总览 polls only while shown with the app in the foreground (the host's bare QueryClient cannot tell on native); fast only while a suggestion job runs. */
export const overviewPollMs = (enabled: boolean, status: string | undefined): number | false => !enabled ? false : busyJob.includes(status ?? "") ? 3000 : 60_000;

/** 总览: revisioned roll-up in the device's local days; returning to the foreground reads it again once it is stale. */
export function useInsightOverview(days: OverviewDays, visible: boolean) {
  const read = useRpc(getInsightOverview), cache = useQueryClient(), enabled = useForeground() && visible, clock = deviceClock();
  // A changed zone (travel, a device setting) is another query: its days are other days.
  const queryKey = [...insightsQueryPrefix, "overview", days, clock.utcOffsetMinutes, clock.timeZone ?? ""];
  return useQuery({
    queryKey, enabled, placeholderData: keepPreviousData, staleTime: 5000, refetchOnWindowFocus: false, retry: 1,
    queryFn: async () => {
      const cached = cache.getQueryData<OverviewState>(queryKey);
      return mergeOverview(cached, await read({ days, ...deviceClock(), ...(cached ? { revision: cached.revision } : {}) }));
    },
    refetchInterval: query => overviewPollMs(enabled, query.state.data?.data.suggestionJob?.status),
  });
}

/** One suggestion job in full (default: the latest completed one) and the history. */
export function useInsightSuggestions(jobId: string | undefined, enabled: boolean) {
  const read = useRpc(getInsightSuggestions);
  return useQuery({ queryKey: [...insightsQueryPrefix, "suggestions", jobId ?? "latest"], enabled, staleTime: 30_000, refetchOnWindowFocus: false, retry: 1, placeholderData: keepPreviousData,
    queryFn: () => read(jobId ? { jobId } : {}) });
}

export function useSuggestionActions() {
  const start = useRpc(startInsightSuggestions), cancel = useRpc(cancelInsightSuggestions), feedback = useRpc(setActionFeedback), cache = useQueryClient();
  const refresh = () => { void cache.invalidateQueries({ queryKey: [...insightsQueryPrefix, "overview"] }); void cache.invalidateQueries({ queryKey: [...insightsQueryPrefix, "suggestions"] }); };
  const store = (job: SuggestionJob) => {
    cache.setQueryData([...insightsQueryPrefix, "suggestions", job.id], (old: { history: unknown[] } | undefined) => ({ history: old?.history ?? [], job }));
    refresh();
  };
  return {
    // The window's days are the device's local days, like the overview the user is looking at.
    suggest: useMutation({ mutationFn: (input: { days: OverviewDays; runner?: InsightRunner }) => start({ ...input, ...deviceClock() }), onSuccess: refresh }),
    cancel: useMutation({ mutationFn: (jobId: string) => cancel({ jobId }), onSuccess: refresh }),
    feedback: useMutation({ mutationFn: (input: { jobId: string; actionId: string; status: ActionFeedback["status"] }) => feedback(input), onSuccess: store }),
  };
}

/** Runner catalogue for the settings sheet; fetched only while it is open. */
export function useInsightRunners(open: boolean) {
  const read = useRpc(listInsightRunners);
  return useQuery({ queryKey: [...insightsQueryPrefix, "runners"], enabled: open, staleTime: 60_000, refetchOnWindowFocus: false, retry: 1, queryFn: () => read({}) });
}
export function useInsightModels(provider: string | null) {
  const read = useRpc(listInsightModels);
  return useQuery({ queryKey: [...insightsQueryPrefix, "models", provider], enabled: !!provider, staleTime: 60_000, refetchOnWindowFocus: false, retry: 1, queryFn: () => read({ provider: provider! }) });
}
export function useConfigureInsights() {
  const configure = useRpc(updateInsightSettings), cache = useQueryClient();
  return useMutation({ mutationFn: (input: { autoEnabled?: boolean; runner?: InsightRunner }) => configure(input),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: insightsQueryPrefix }); } });
}
