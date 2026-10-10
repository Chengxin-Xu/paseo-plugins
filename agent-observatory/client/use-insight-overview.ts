import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelInsightSuggestions, getInsightOverview, getInsightSuggestions, mergeOverview, setActionFeedback, startInsightSuggestions,
  type ActionFeedback, type OverviewDays, type OverviewState, type SuggestionJob } from "../shared/insight-overview";
import { listInsightModels, listInsightRunners, updateInsightSettings, type InsightRunner } from "../shared/insights";

export const insightsQueryPrefix = ["agent-observatory", "insights"] as const;
const offset = () => -new Date().getTimezoneOffset();

/** 总览: revisioned roll-up; polls fast only while a suggestion job runs. */
export function useInsightOverview(days: OverviewDays, visible: boolean) {
  const read = useRpc(getInsightOverview), cache = useQueryClient();
  const queryKey = [...insightsQueryPrefix, "overview", days, offset()];
  return useQuery({
    queryKey, enabled: visible, placeholderData: keepPreviousData, staleTime: 5000, retry: 1,
    queryFn: async () => {
      const cached = cache.getQueryData<OverviewState>(queryKey);
      return mergeOverview(cached, await read({ days, utcOffsetMinutes: offset(), ...(cached ? { revision: cached.revision } : {}) }));
    },
    refetchInterval: query => !visible ? false : ["queued", "collecting", "analyzing"].includes(query.state.data?.data.suggestionJob?.status ?? "") ? 3000 : 60_000,
  });
}

/** One suggestion job in full (default: the latest completed one) and the history. */
export function useInsightSuggestions(jobId: string | undefined, enabled: boolean) {
  const read = useRpc(getInsightSuggestions);
  return useQuery({ queryKey: [...insightsQueryPrefix, "suggestions", jobId ?? "latest"], enabled, staleTime: 30_000, retry: 1, placeholderData: keepPreviousData,
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
    suggest: useMutation({ mutationFn: (input: { days: OverviewDays; runner?: InsightRunner }) => start(input), onSuccess: refresh }),
    cancel: useMutation({ mutationFn: (jobId: string) => cancel({ jobId }), onSuccess: refresh }),
    feedback: useMutation({ mutationFn: (input: { jobId: string; actionId: string; status: ActionFeedback["status"] }) => feedback(input), onSuccess: store }),
  };
}

/** Runner catalogue for the settings sheet; fetched only while it is open. */
export function useInsightRunners(open: boolean) {
  const read = useRpc(listInsightRunners);
  return useQuery({ queryKey: [...insightsQueryPrefix, "runners"], enabled: open, staleTime: 60_000, retry: 1, queryFn: () => read({}) });
}
export function useInsightModels(provider: string | null) {
  const read = useRpc(listInsightModels);
  return useQuery({ queryKey: [...insightsQueryPrefix, "models", provider], enabled: !!provider, staleTime: 60_000, retry: 1, queryFn: () => read({ provider: provider! }) });
}
export function useConfigureInsights() {
  const configure = useRpc(updateInsightSettings), cache = useQueryClient();
  return useMutation({ mutationFn: (input: { autoEnabled?: boolean; runner?: InsightRunner }) => configure(input),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: insightsQueryPrefix }); } });
}
