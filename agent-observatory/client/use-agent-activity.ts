import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";

/**
 * Debounced directory activity. Paseo 0.9 feeds `agents.subscribe` only from observations owned by
 * this surface's API (the dashboard's directory store), so this adds no server demand of its own.
 */
export function useAgentActivity(onActivity: () => void, delayMs = 1500) {
  const paseo = usePaseo(), callback = useRef(onActivity);
  callback.current = onActivity;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = paseo.agents.subscribe(() => { if (timer) return; timer = setTimeout(() => { timer = undefined; callback.current(); }, delayMs); });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [paseo, delayMs]);
}
