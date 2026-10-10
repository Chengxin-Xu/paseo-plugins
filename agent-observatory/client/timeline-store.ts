import { normalizeTimelinePage, object, reconcileTimelinePage, type TimelineCursor, type TimelinePage } from "../shared/timeline";

export interface TimelineViewState { scrollOffset: number; filter: "all" | "tools" | "messages" | "errors"; followTail: boolean }
export interface TimelineState {
  page: TimelinePage | null; error: string | null; loading: boolean; refreshing: boolean; loadingOlder: boolean;
  lastSyncedAt: string | null; live: boolean; snapshot: Record<string, unknown> | null; viewState: TimelineViewState;
}
export interface TimelineTransport {
  fetch(input: { direction: "tail" | "before" | "after"; cursor?: TimelineCursor; limit: number }): Promise<unknown>;
  subscribe?(handler: (update: unknown) => void): (() => void) & { ready?: Promise<void> };
}
export interface TimelineClock { now(): number; setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(id: ReturnType<typeof setTimeout>): void }
const systemClock: TimelineClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

const RESUBSCRIBE_DELAYS = [2_000, 5_000, 15_000, 30_000];
/**
 * Enabled consumers share one subscription; pausing retains pages and view state. Paseo 0.9 subscriptions
 * deliver live events only: after a reconnect (`subscription_restored`) the tail is re-read, and an `error`
 * releases the observation, so a new one is established with backoff while the view stays open.
 */
export function createTimelineStore(transport: TimelineTransport, options: { clock?: TimelineClock; minRefetchMs?: number; fallbackMs?: number; onChange?: () => void } = {}) {
  const clock = options.clock ?? systemClock, minimum = Math.max(2_000, options.minRefetchMs ?? 2_000), fallback = Math.max(minimum, options.fallbackMs ?? 30_000);
  let state: TimelineState = { page: null, error: null, loading: true, refreshing: false, loadingOlder: false, lastSyncedAt: null, live: false, snapshot: null,
    viewState: { scrollOffset: 0, filter: "all", followTail: true } };
  const listeners = new Set<() => void>();
  let owners = 0, revision = 0, lastFetch = -Infinity, dirty = false, disposed = false;
  let cachedBytes = 0;
  let subscriptionVersion = 0;
  let fetching: Promise<void> | null = null, unsubscribe: (() => void) | null = null;
  let dirtyTimer: ReturnType<typeof setTimeout> | null = null, pollTimer: ReturnType<typeof setTimeout> | null = null;
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null, resubscribes = 0;
  function publish(patch: Partial<TimelineState>) { if (disposed) return; state = { ...state, ...patch }; if ("page" in patch) cachedBytes = state.page ? JSON.stringify(state.page).length * 2 : 0; for (const listener of listeners) listener(); options.onChange?.(); }
  function clearTimers() { if (dirtyTimer !== null) clock.clearTimeout(dirtyTimer); if (pollTimer !== null) clock.clearTimeout(pollTimer); if (resubscribeTimer !== null) clock.clearTimeout(resubscribeTimer); dirtyTimer = pollTimer = resubscribeTimer = null; }
  function schedulePoll() { if (pollTimer !== null) clock.clearTimeout(pollTimer); if (!owners || disposed) return; pollTimer = clock.setTimeout(() => { pollTimer = null; dirty = true; scheduleDirty(); }, fallback); }
  function scheduleDirty() {
    if (!owners || disposed || !dirty || dirtyTimer !== null || fetching) return;
    dirtyTimer = clock.setTimeout(() => { dirtyTimer = null; void fetchPage("tail"); }, Math.max(0, minimum - (clock.now() - lastFetch)));
  }
  function boundPage(page: TimelinePage, direction: "tail" | "before" = "tail"): TimelinePage {
    let clipped = false;
    const rows = page.rows.map(row => {
      if (JSON.stringify(row).length < 256_000) return row;
      clipped = true;
      let budget = 128_000;
      const bounded = (value: unknown, depth = 0): unknown => {
        if (depth > 10 || budget <= 0) return "[…缓存内容已截断]";
        if (typeof value === "string") { const limit = Math.min(30_000, budget); budget -= Math.min(value.length, limit); return value.length > limit ? `${value.slice(0, limit)}\n[…缓存内容已截断]` : value; }
        if (Array.isArray(value)) return value.slice(0, 300).map(item => bounded(item, depth + 1));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 150).map(([key, item]) => [key, bounded(item, depth + 1)]));
        return value;
      };
      return { ...row, item: bounded(row.item) as typeof row.item };
    });
    page = { ...page, rows, truncated: page.truncated || clipped };
    if (direction === "before") {
      let size = 0, end = 0;
      for (const row of page.rows) { const bytes = JSON.stringify(row).length * 2; if (size + bytes > 4 * 1024 * 1024 && end > 0) break; size += bytes; end++; }
      return end < page.rows.length ? { ...page, rows: page.rows.slice(0, end), endCursor: { epoch: page.epoch, seq: page.rows[end - 1].seqEnd }, hasNewer: true, truncated: true } : page;
    }
    let size = 0, start = page.rows.length;
    for (let index = page.rows.length - 1; index >= 0; index--) {
      const bytes = JSON.stringify(page.rows[index]).length * 2;
      if (size + bytes > 4 * 1024 * 1024 && start < page.rows.length) break;
      size += bytes; start = index;
    }
    return start ? { ...page, rows: page.rows.slice(start), startCursor: page.rows[start] ? { epoch: page.epoch, seq: page.rows[start].seqStart } : page.startCursor, hasOlder: true, truncated: true } : page;
  }
  function fetchPage(direction: "tail" | "before"): Promise<void> {
    if (disposed || !owners) return Promise.resolve();
    if (fetching) { if (direction === "tail") dirty = true; return fetching; }
    const cursor = direction === "before" ? state.page?.startCursor : undefined;
    if (direction === "before" && (!cursor || !state.page?.hasOlder)) return Promise.resolve();
    if (direction === "tail" && clock.now() - lastFetch < minimum) { dirty = true; scheduleDirty(); return Promise.resolve(); }
    if (dirtyTimer !== null) clock.clearTimeout(dirtyTimer); dirtyTimer = null;
    lastFetch = clock.now(); dirty = false;
    const requestRevision = revision;
    publish({ refreshing: direction === "tail", loadingOlder: direction === "before" });
    fetching = Promise.resolve().then(async () => {
      const payload = await transport.fetch({ direction, ...(cursor ? { cursor } : {}), limit: 100 });
      if (disposed) return;
      if (requestRevision !== revision) { dirty = true; return; }
      const raw = object(payload);
      if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
      const incoming = normalizeTimelinePage(payload);
      const changedEpoch = !!state.page && (incoming.epoch !== state.page.epoch || incoming.reset);
      // A tail that starts after the cached end (e.g. many rows missed while disconnected) must not be
      // stitched onto the old rows with a silent hole; it replaces them and older rows stay loadable.
      const detached = direction === "tail" && !!state.page && !changedEpoch && incoming.hasOlder && !!state.page.endCursor && !!incoming.startCursor
        && incoming.startCursor.seq > state.page.endCursor.seq + 1;
      const page = boundPage(reconcileTimelinePage(detached ? null : state.page, incoming, direction), direction);
      publish({ page, loading: false, error: null, lastSyncedAt: new Date(clock.now()).toISOString(),
        ...(raw.agent ? { snapshot: object(raw.agent) } : {}), ...(changedEpoch ? { viewState: { ...state.viewState, scrollOffset: 0 } } : {}) });
    }).catch(error => { publish({ loading: false, error: error instanceof Error ? error.message : "执行记录读取失败" }); })
      .finally(() => { fetching = null; publish({ refreshing: false, loadingOlder: false }); schedulePoll(); scheduleDirty(); });
    return fetching;
  }
  function subscribeLive() {
    if (!transport.subscribe || !owners || disposed) return;
    const currentSubscription = ++subscriptionVersion;
    const failed = (error: unknown) => {
      if (!owners || disposed || currentSubscription !== subscriptionVersion) return;
      publish({ live: false, error: error instanceof Error ? error.message : typeof error === "string" ? error : "实时连接不可用" });
      scheduleResubscribe();
    };
    try {
      const sub = transport.subscribe(update => { if (currentSubscription === subscriptionVersion) handleEvent(update, failed); });
      unsubscribe = sub;
      Promise.resolve(sub.ready).then(() => { if (owners && !disposed && currentSubscription === subscriptionVersion) { resubscribes = 0; publish({ live: true }); } }).catch(failed);
    } catch (error) { failed(error); }
  }
  function scheduleResubscribe() {
    if (resubscribeTimer !== null || !owners || disposed) return;
    unsubscribe?.(); unsubscribe = null;
    const delay = RESUBSCRIBE_DELAYS[Math.min(resubscribes, RESUBSCRIBE_DELAYS.length - 1)];
    resubscribes += 1;
    resubscribeTimer = clock.setTimeout(() => { resubscribeTimer = null; subscribeLive(); dirty = true; scheduleDirty(); }, delay);
  }
  function handleEvent(update: unknown, failed: (error: unknown) => void) {
    const payload = object(update), event = object(payload.event);
    // The SDK has released this observation; establish a new one and keep polling meanwhile.
    if (event.type === "error") { failed(typeof event.error === "string" ? event.error : "实时连接中断"); dirty = true; scheduleDirty(); return; }
    // Live delivery resumed after a reconnect; events in between were not replayed.
    if (event.type === "subscription_restored") { publish({ live: true, error: null }); dirty = true; scheduleDirty(); return; }
    if (event.type === "replacement") { revision++; publish({ page: null, loading: true, viewState: { ...state.viewState, scrollOffset: 0 } }); }
    // Cursor-bearing pages are safe to merge. Unidentified text deltas only mark
    // the cache dirty, avoiding duplicate text on the next authoritative read.
    if (typeof payload.epoch === "string" && Array.isArray(payload.entries) && payload.entries.length) {
      const incoming = normalizeTimelinePage(payload);
      if (!state.page || state.page.epoch === incoming.epoch) publish({ page: boundPage(reconcileTimelinePage(state.page, incoming)), lastSyncedAt: new Date(clock.now()).toISOString() });
    }
    dirty = true; scheduleDirty();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquire() {
      if (disposed) throw new Error("Timeline cache has been disposed");
      owners++;
      if (owners === 1) {
        resubscribes = 0;
        subscribeLive();
        if (!state.page || clock.now() - lastFetch >= minimum) void fetchPage("tail"); else schedulePoll();
      }
      let released = false;
      return () => { if (released) return; released = true; owners--; if (!owners) { subscriptionVersion++; clearTimers(); unsubscribe?.(); unsubscribe = null; publish({ live: false }); } };
    },
    refresh: () => { dirty = true; return fetchPage("tail"); },
    loadOlder: () => fetchPage("before"),
    setViewState(patch: Partial<TimelineViewState>) {
      const scrollOffset = patch.scrollOffset === undefined ? state.viewState.scrollOffset : Math.max(0, Number.isFinite(patch.scrollOffset) ? patch.scrollOffset : 0);
      if (scrollOffset === state.viewState.scrollOffset && (patch.filter === undefined || patch.filter === state.viewState.filter) && (patch.followTail === undefined || patch.followTail === state.viewState.followTail)) return;
      publish({ viewState: { ...state.viewState, ...patch, scrollOffset } });
    },
    get active() { return owners > 0; },
    get bytes() { return cachedBytes; },
    dispose() { if (owners || listeners.size) return false; disposed = true; clearTimers(); unsubscribe?.(); listeners.clear(); state.page = null; cachedBytes = 0; return true; },
  };
}
export type TimelineStore = ReturnType<typeof createTimelineStore>;
export function createTimelineCache(options: { limit?: number; maxBytes?: number } = {}) {
  const entries = new Map<string, TimelineStore>();
  const limit = options.limit ?? 12, maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  const prune = (protectedKey: string) => {
    let bytes = [...entries.values()].reduce((sum, store) => sum + store.bytes, 0);
    for (const [key, store] of entries) {
      if (entries.size <= limit && bytes <= maxBytes) break;
      if (key === protectedKey || store.active) continue;
      const size = store.bytes;
      if (store.dispose()) { entries.delete(key); bytes -= size; }
    }
  };
  return { get(key: string, create: (onChange: () => void) => TimelineStore) {
    let store = entries.get(key);
    if (store) entries.delete(key); else store = create(() => prune(key));
    entries.set(key, store); prune(key); return store;
  }, get size() { return entries.size; } };
}
