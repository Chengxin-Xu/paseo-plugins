import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCacheClock, type CacheEntry } from "../shared/alerts";
import { t } from "../shared/text";
import { radius } from "./kit";
import { Breathe } from "./motion";
import { hueColor, tint, tintAlpha, type Hue } from "./status";
import { useForeground } from "./use-foreground";

/**
 * 提示缓存倒计时 (2.17, after cache-clock's idea): how long the prompt cache of each Claude-based session stays warm. The server
 * says when it goes cold (`observatory.cache.get`, every half minute while a view shows it, with a revision); the device counts
 * down on its own, so no read is needed per second. A session the server cannot tell about shows nothing.
 */
/** The clocks by Agent id, from the provider (exported for tests). */
export const CacheClockContext = createContext<ReadonlyMap<string, CacheEntry> | null>(null);
export const CACHE_POLL_MS = 30_000;
const cacheQueryKey = ["agent-observatory", "cache-clock"] as const;

/** Reads the clocks while a surface that shows them is open and the app is in front. */
export function CacheClockProvider({ children }: { children: ReactNode }) {
  const read = useRpc(getCacheClock), foreground = useForeground(), queryClient = useQueryClient();
  const query = useQuery({
    queryKey: cacheQueryKey, enabled: foreground, retry: false, staleTime: 10_000, refetchOnWindowFocus: false,
    refetchInterval: foreground ? CACHE_POLL_MS : false,
    queryFn: async () => {
      const previous = queryClient.getQueryData<{ revision: string; agents: CacheEntry[] }>(cacheQueryKey);
      const answer = await read(previous ? { revision: previous.revision } : {});
      if (answer.mode === "full") return { revision: answer.revision, agents: answer.agents };
      if (previous) return previous;
      const full = await read({});
      if (full.mode !== "full") throw new Error("cache clock unavailable");
      return { revision: full.revision, agents: full.agents };
    },
  });
  const map = useMemo(() => new Map((query.data?.agents ?? []).map(entry => [entry.agentId, entry] as const)), [query.data]);
  return <CacheClockContext.Provider value={map}>{children}</CacheClockContext.Provider>;
}

/** What a clock shows at `now`: warm with time left (amber near the end), or cold and why. */
export function cacheLook(entry: Pick<CacheEntry, "expiresAt" | "ttl" | "cold">, now: number): { state: "warm" | "ending" | "cold"; left: number; reason: "expired" | "compacted" | "model" | null } {
  if (entry.cold) return { state: "cold", left: 0, reason: entry.cold };
  const left = Date.parse(entry.expiresAt ?? "") - now;
  if (!Number.isFinite(left) || left <= 0) return { state: "cold", left: 0, reason: "expired" };
  // The last minute of a 5-minute cache, the last five of an hour's.
  return { state: left <= (entry.ttl === "1h" ? 5 : 1) * 60_000 ? "ending" : "warm", left, reason: null };
}
/** 「缓存 4 分钟」, 「缓存 35 秒」 in the last minute, 「缓存已冷」. */
export function cacheText(look: ReturnType<typeof cacheLook>): string {
  if (look.state === "cold") return t("alertsCache.cold");
  return look.left >= 60_000 ? t("alertsCache.minutes", { count: Math.ceil(look.left / 60_000) }) : t("alertsCache.seconds", { count: Math.max(1, Math.ceil(look.left / 1000)) });
}
/** When the shown text or colour changes next: each second in the last minute, else at the next minute or at the colour change. */
export function nextCacheChange(entry: Pick<CacheEntry, "expiresAt" | "ttl" | "cold">, now: number): number | null {
  const look = cacheLook(entry, now);
  if (look.state === "cold") return null;
  if (look.left <= 60_000) return (look.left % 1000) || 1000;
  const warn = (entry.ttl === "1h" ? 5 : 1) * 60_000, toMinute = (look.left % 60_000) || 60_000;
  return look.state === "warm" && look.left - warn < toMinute ? look.left - warn : toMinute;
}

/**
 * The clock pill: teal while warm, amber and breathing near the end, grey once cold. `showCold`: rows that do not need you hide
 * a cold cache (it matters when you are about to answer); the detail and the popover show it.
 */
export function CacheChip({ theme, agentId, showCold = true }: { theme: PluginTheme; agentId: string; showCold?: boolean }) {
  const entry = useContext(CacheClockContext)?.get(agentId) ?? null;
  const foreground = useForeground(), [now, setNow] = useState(() => Date.now());
  const wait = entry && foreground ? nextCacheChange(entry, now) : null;
  useEffect(() => {
    if (!entry || !foreground) return;
    setNow(Date.now());
  }, [entry?.expiresAt, entry?.cold, foreground]);
  useEffect(() => {
    if (wait === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(50, wait + 20));
    return () => clearTimeout(timer);
  }, [wait, now]);
  if (!entry) return null;
  const look = cacheLook(entry, now);
  if (look.state === "cold" && !showCold) return null;
  const hue: Hue = look.state === "cold" ? "muted" : look.state === "ending" ? "amber" : "teal", color = hueColor(theme, hue);
  const label = cacheText(look);
  const reason = look.reason === "compacted" ? t("alertsCache.coldCompacted") : look.reason === "model" ? t("alertsCache.coldModel") : look.reason === "expired" ? t("alertsCache.coldExpired") : t("alertsCache.warm", { ttl: entry.ttl === "1h" ? t("alertsCache.ttlHour") : t("alertsCache.ttlFiveMinutes") });
  const pill = <View testID="cache-chip" accessibilityLabel={`${label} · ${reason}`} style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 18, paddingHorizontal: 6, borderRadius: radius.full,
    backgroundColor: hue === "muted" ? theme.colors.surface2 : tint(color, tintAlpha(theme) + (look.state === "ending" ? 0.08 : 0)) }}>
    <Icon name={look.state === "cold" ? "Snowflake" : "Timer"} size={10} color={hue === "muted" ? theme.colors.foregroundMuted : color} />
    <Text numberOfLines={1} style={{ color: hue === "muted" ? theme.colors.foregroundMuted : hueColor(theme, hue, "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{label}</Text>
  </View>;
  return look.state === "ending" ? <Breathe>{pill}</Breathe> : pill;
}
