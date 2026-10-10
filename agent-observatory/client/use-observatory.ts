import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createAgentDirectory } from "../shared/directory-store";
import { isForeground } from "./use-foreground";

/** Host changes create an isolated store; disposed host requests cannot leak data. */
export function useObservatory({ includeArchived }: { includeArchived: boolean }) {
  const paseo = usePaseo();
  const directory = useMemo(() => createAgentDirectory({
    list: options => paseo.agents.list(options),
    // Paseo 0.9 routes directory events only to observations this surface's API owns.
    observe: options => paseo.agents.list({ ...options, subscribe: {} }).then(result => result.subscription),
  }, { includeArchived }), [paseo, includeArchived]);
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);

  useEffect(() => {
    directory.start(isForeground(AppState.currentState));
    const subscription = AppState.addEventListener("change", (nextState) => {
      directory.setActive(isForeground(nextState));
    });
    return () => {
      subscription.remove();
      directory.stop();
    };
  }, [directory]);

  return useMemo(() => ({ ...state, refresh: directory.refresh }), [state, directory]);
}
