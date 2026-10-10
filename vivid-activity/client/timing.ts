import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { Platform } from "react-native";
import { rowTimeText } from "../shared/timing";
import { foldRuntime, type RowTiming } from "./fold-runtime";
import { useForeground } from "./use-foreground";

/**
 * 本地补丁：计时显示。数据见 shared/timing.ts；每行的估算值由折叠索引按 Agent 统一算好，行组件只订阅自己那一条。
 * 运行中的行每秒走一次表：全部运行中的行共用一个 1 秒定时器，没有订阅者就停；App 在后台或行不在屏幕上（网页用
 * IntersectionObserver；原生由列表虚拟化卸载屏外的行）时不订阅。
 */
export function useRowTiming(agentId: string, key: string | undefined, live = false): RowTiming | null {
  const subscribe = useCallback((listener: () => void) => foldRuntime.subscribeTimings(agentId, listener), [agentId]);
  const read = useCallback(() => (key ? foldRuntime.timing(agentId, key) : null), [agentId, key]);
  const readTail = useCallback(() => (live ? foldRuntime.tailStart(agentId) : null), [agentId, live]);
  const timing = useSyncExternalStore(subscribe, read, read);
  const tailStart = useSyncExternalStore(subscribe, readTail, readTail);
  // A live row the index has not caught up with: same estimate as it will get (the last finished entry's end).
  return useMemo(() => timing ?? (live && tailStart !== null ? { start: tailStart, end: 0, running: true, witnessed: true } : null), [live, tailStart, timing]);
}

const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tick = 0;
function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickTimer === null) {
    tickTimer = setInterval(() => {
      tick += 1;
      for (const each of tickListeners) each();
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
const idle = () => () => {};
const readTick = () => tick;
const readIdle = () => -1;

/** The daemon's "now", refreshed every second while `active` and the app is in the foreground; null otherwise. */
export function useLiveNow(active: boolean): number | null {
  const foreground = useForeground();
  const on = active && foreground;
  useSyncExternalStore(on ? subscribeTick : idle, on ? readTick : readIdle, readIdle);
  return on ? foldRuntime.serverNow() : null;
}

type Observed = { observe(node: unknown): void; disconnect(): void };
declare const IntersectionObserver:
  | (new (callback: (entries: Array<{ isIntersecting: boolean }>) => void) => Observed)
  | undefined;

/**
 * Whether the row is on screen: web asks the browser (only while `watch`, i.e. for live rows); native lists unmount rows
 * far off screen, so mounted counts as visible.
 */
export function useOnScreen(ref: RefObject<unknown>, watch: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!watch) {
      setVisible(true);
      return;
    }
    if (Platform.OS !== "web" || typeof IntersectionObserver === "undefined" || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, watch]);
  return visible;
}

/** The words for a row's time (shared/timing.ts `rowTimeText`). */
export function timingText(timing: RowTiming | null, running: boolean, liveNow: number | null): string | null {
  return rowTimeText(timing, running, liveNow);
}
