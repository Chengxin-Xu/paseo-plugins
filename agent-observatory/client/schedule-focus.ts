/**
 * 「查看全部运行」 hand-off: an Agent's 定时任务 card asks the 定时运行 page to show one schedule (and select one run).
 * Surfaces take no parameters on Paseo 0.9, so the request waits here until the page reads it.
 */
export interface ScheduleFocus { scheduleId: string; runId?: string }
let pending: ScheduleFocus | null = null;
const listeners = new Set<(focus: ScheduleFocus) => void>();

export function focusScheduleRuns(focus: ScheduleFocus): void {
  pending = focus;
  for (const listener of listeners) listener(focus);
}
/** The request a page opened right now should apply; it stays until `clearScheduleFocus` so a re-render cannot lose it. */
export const peekScheduleFocus = (): ScheduleFocus | null => pending;
export function clearScheduleFocus(focus: ScheduleFocus | null): void { if (focus && pending === focus) pending = null; }
export function onScheduleFocus(listener: (focus: ScheduleFocus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
