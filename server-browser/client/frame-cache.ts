/** Recent pictures are hints only; they never authorize input. Budgets count UTF-16 data URL storage. */
export type CachedFrame = { dataUrl: string; width: number; height: number; capturedAt: number };
type Entry = { hostId: string; workspaceId: string; frame: CachedFrame; bytes: number; accessedAt: number };
export function createFrameCache(maxEntries = 12, maxBytes = 8 * 1024 * 1024, ttlMs = 5 * 60_000, now = Date.now) {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  function key(hostId: string, workspaceId: string) { return JSON.stringify([hostId, workspaceId]); }
  function remove(entryKey: string) { const entry = entries.get(entryKey); if (entry) { bytes -= entry.bytes; entries.delete(entryKey); } }
  function expire() { const time = now(); for (const [entryKey, entry] of entries) if (time - entry.accessedAt >= ttlMs) remove(entryKey); }
  return {
    set(hostId: string, workspaceId: string, frame: CachedFrame) {
      expire(); const entryKey = key(hostId, workspaceId), frameBytes = frame.dataUrl.length * 2;
      remove(entryKey); if (frameBytes > maxBytes || maxEntries <= 0) return;
      entries.set(entryKey, { hostId, workspaceId, frame, bytes: frameBytes, accessedAt: now() }); bytes += frameBytes;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!);
    },
    get(hostId: string, workspaceId: string) {
      expire(); const entryKey = key(hostId, workspaceId), entry = entries.get(entryKey);
      if (!entry) return undefined;
      entries.delete(entryKey); entry.accessedAt = now(); entries.set(entryKey, entry); return entry.frame;
    },
    delete(hostId: string, workspaceId: string) { remove(key(hostId, workspaceId)); },
    retain(hostId: string, workspaceIds: ReadonlySet<string>) { for (const [entryKey, entry] of entries) if (entry.hostId === hostId && !workspaceIds.has(entry.workspaceId)) remove(entryKey); expire(); },
    clearHost(hostId: string) { for (const [entryKey, entry] of entries) if (entry.hostId === hostId) remove(entryKey); },
    clear() { entries.clear(); bytes = 0; },
    stats() { expire(); return { entries: entries.size, bytes }; },
  };
}
export const frameCache = createFrameCache();
const hostUsers = new Map<string, number>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
export function retainFrameHost(hostId: string) {
  hostUsers.set(hostId, (hostUsers.get(hostId) ?? 0) + 1);
  sweepTimer ??= setInterval(() => { frameCache.stats(); }, 30_000);
  return () => { const count = (hostUsers.get(hostId) ?? 1) - 1; if (count > 0) hostUsers.set(hostId, count); else { hostUsers.delete(hostId); frameCache.clearHost(hostId); } if (!hostUsers.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined; } };
}
export function clearFrameCache() { hostUsers.clear(); frameCache.clear(); if (sweepTimer) clearInterval(sweepTimer); sweepTimer = undefined; }
