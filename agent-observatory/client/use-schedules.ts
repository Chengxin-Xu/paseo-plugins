import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getScheduleRun, listScheduleRuns, mergeScheduleRuns, type RunWindow, type ScheduleRunsState } from "../shared/schedules";
import { useForeground } from "./use-foreground";

export const scheduleRunsQueryKey = (hostId: string, window: RunWindow) => ["agent-observatory", hostId, "schedules", window] as const;

/**
 * 定时运行 feed, read only while the page is on screen and the app in the foreground. Unchanged polls cost a few bytes
 * (revisioned like 事件 / 看板); while a run is going it polls every 10 s so it flips to 成功 / 失败 promptly, otherwise every 45 s.
 */
export function useScheduleRuns(hostId: string, window: RunWindow, visible = true) {
  const rpc = useRpc(listScheduleRuns), cache = useQueryClient(), foreground = useForeground();
  const queryKey = scheduleRunsQueryKey(hostId, window), enabled = foreground && visible;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<ScheduleRunsState>(queryKey);
      return mergeScheduleRuns(previous, await rpc({ window, ...(previous?.revision ? { revision: previous.revision } : {}) }));
    },
    enabled, retry: 1, staleTime: 5000, refetchOnWindowFocus: false,
    // 「加载更早」 keeps the recent list on screen until the longer one arrives (never another host's list).
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === hostId ? previous : undefined,
    refetchInterval: query => !enabled ? false : query.state.data?.runs.some(run => run.status === "running") ? 10_000 : 45_000,
  });
}

/** One run's recorded reply, prompt and feed row. A finished run never changes, so it is kept for the session. */
export function useScheduleRun(runId: string | null, running: boolean) {
  const rpc = useRpc(getScheduleRun), foreground = useForeground();
  return useQuery({ queryKey: ["agent-observatory", "schedule-run", runId], queryFn: () => rpc({ runId: runId! }), enabled: !!runId && foreground,
    staleTime: running ? 5000 : Infinity, refetchInterval: running && foreground ? 10_000 : false, refetchOnWindowFocus: false, retry: 1 });
}
