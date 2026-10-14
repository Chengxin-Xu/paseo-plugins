import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { weekdayNames } from "./stats-view";

/**
 * 额度 (2.13): the host's provider usage windows (5-hour, weekly …) with history, pace markers and exhaustion forecasts.
 *
 * The values come from `paseo.providers.listUsage()`, the same source as the app's own Usage panel: the daemon reads
 * each provider's login and caches every account for 5 minutes; the plugin never reads credentials or calls a provider
 * itself. While a page reads it the server samples every 10 minutes (server/quota.ts) into a bounded history. Pure
 * helpers here are shared by that recorder, the Token page card and the 看板 chip.
 */
export const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
/**
 * A reading counts as current for this long (codex-F8). Pages read every 5 minutes and the daemon caches an account for
 * 5, so a watched account is at most about 10 minutes old; anything older is a reading kept from before a failure, a
 * listing the latest answer left out, or a cache the app brought back from the background.
 */
export const QUOTA_FRESH_MS = 15 * 60_000;
/** A wire budget: a phone gets at most this many accounts, windows per account and history points per window. */
export const QUOTA_LIMITS = { accounts: 8, windows: 8, points: 36 } as const;
export const QUOTA_TONES = ["ok", "warning", "danger", "neutral"] as const;
export type QuotaTone = typeof QUOTA_TONES[number];
const iso = z.iso.datetime();
const pct = z.number().finite().min(0).max(1000);
const epoch = z.number().int().nonnegative();

export const quotaForecastSchema = z.discriminatedUnion("kind", [
  /**
   * Runs out before the window resets: at the rate of the last 30 minutes or more ("rate", windows up to a day) or at this
   * window's average pace so far ("pace", longer windows). `at` has passed when the reading is that old.
   */
  z.object({ kind: z.literal("exhaust"), at: iso, method: z.enum(["rate", "pace"]) }),
  /** Where use ends up at the reset at that rate / pace (below 100). */
  z.object({ kind: z.literal("projected"), pct, method: z.enum(["rate", "pace"]) }),
  /** Nothing used over the last 30 minutes (rate windows). */
  z.object({ kind: z.literal("idle") }),
  /** At 100 % already. */
  z.object({ kind: z.literal("exhausted") }),
]);
export type QuotaForecast = z.infer<typeof quotaForecastSchema>;

export const quotaWindowSchema = z.object({
  id: z.string().min(1).max(160),
  /** Chinese name: 5 小时 / 每周 / 每周 · Opus / Code review · 5 小时 … */
  label: z.string().max(80),
  /** The provider marks the windows its summary shows (Claude's 5-hour and weekly); the others fold on phones. */
  summary: z.boolean(),
  usedPct: pct.nullable(),
  resetsAt: iso.nullable(),
  /** Length from the window id (five_hour, weekly / weekly_*, `<n>s`); null when unknown: no pace marker, no pace forecast. */
  durationMs: z.number().int().positive().nullable(),
  /** Share of the window elapsed at `generatedAt` (0–1): where use would stand if it were spread evenly. */
  pace: z.number().min(0).max(1).nullable(),
  /** Use is ahead of that pace (by more than a point). */
  ahead: z.boolean(),
  /** "reset": the reset time has passed and no reading of the new window has come in yet. */
  state: z.enum(["live", "reset"]),
  forecast: quotaForecastSchema.nullable(),
  /** Below 70 % ok, from 70 % warning, above 90 % danger; neutral without a value or after the reset. */
  tone: z.enum(QUOTA_TONES),
  /** Out already, or forecast to run out before the reset. */
  alarm: z.boolean(),
  /** This window's readings so far, oldest first: [epoch ms, used %, first reading after a gap of over 15 minutes]. */
  history: z.array(z.tuple([epoch, pct, z.boolean()])).max(QUOTA_LIMITS.points),
  /** Chart span in epoch ms: the window's start (or first reading) to its reset (or now). */
  span: z.tuple([epoch, epoch]),
});
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;

export const quotaAccountSchema = z.object({
  /** Usage source id and a hash of the account's display name (never the name itself, which may be an e-mail address). */
  key: z.string().min(1).max(120),
  /** The usage source (claude, codex, grok …): not a Paseo agent provider id. */
  provider: z.string().min(1).max(80),
  /** The source's name, or 「Claude 账号 2」 when one source lists several accounts. */
  name: z.string().max(80),
  /** A masked account (a***@e***) when one source lists several; kept in memory only, so null until the first read after a restart. */
  hint: z.string().max(40).nullable(),
  plan: z.string().max(40).nullable(),
  status: z.enum(["available", "unavailable", "error"]),
  /** When the values shown were read from the provider (the daemon's fetch time). */
  readingAt: iso.nullable(),
  /** The values shown are not from the latest successful read (it failed, or did not list this account). */
  stale: z.boolean(),
  windows: z.array(quotaWindowSchema).max(QUOTA_LIMITS.windows),
});
export type QuotaAccount = z.infer<typeof quotaAccountSchema>;

export const QUOTA_ERRORS = ["disconnected", "timeout", "unsupported", "failed"] as const;
export const quotaSnapshotSchema = z.object({
  generatedAt: iso,
  /** The last time the host answered. */
  readAt: iso.nullable(),
  /**
   * The last read failed as a whole. "disconnected": the plugin's session with the host is gone (the SDK then claims
   * "Update the host to list provider usage", although the host supports it); "unsupported": the host has no usage API.
   */
  error: z.object({ kind: z.enum(QUOTA_ERRORS), at: iso }).nullable(),
  /** A read is in flight: ask again in a few seconds. */
  refreshing: z.boolean(),
  accounts: z.array(quotaAccountSchema).max(QUOTA_LIMITS.accounts),
});
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;

const revision = z.string().min(1).max(80);
export const quotaResponseSchema = z.discriminatedUnion("mode", [
  quotaSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type QuotaResponse = z.infer<typeof quotaResponseSchema>;
export const getQuota = defineRpc({
  name: "observatory.quota.get",
  input: z.object({ revision: revision.optional() }),
  output: quotaResponseSchema,
});
export type QuotaState = QuotaSnapshot & { revision?: string };
export function mergeQuota(previous: QuotaState | undefined, response: QuotaResponse): QuotaState {
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return { ...snapshot, revision: response.revision }; }
  if (!previous) throw new Error("本地额度缓存已失效，正在重新读取。");
  return previous;
}

/** A scoped window id (`code_review:five_hour`, `limit:<id>:weekly`) names its period after the last colon. */
const periodOf = (id: string): string => id.slice(id.lastIndexOf(":") + 1);
/** Window length from its id: five_hour, weekly / weekly_<scope>, `<n>s`; null for anything else (monthly, unknown_primary …). */
export function quotaWindowDuration(id: string): number | null {
  const period = periodOf(id), seconds = /^(\d{1,9})s$/.exec(period);
  if (period === "five_hour") return 5 * HOUR_MS;
  if (period === "weekly" || period.startsWith("weekly_")) return 7 * DAY_MS;
  return seconds && Number(seconds[1]) > 0 ? Number(seconds[1]) * 1000 : null;
}
function lengthName(seconds: number): string {
  for (const [size, unit] of [[86_400, "天"], [3600, "小时"], [60, "分钟"]] as const) if (seconds % size === 0) return `${seconds / size} ${unit}`;
  return `${seconds} 秒`;
}
/** Chinese window name from the id, keeping a scope or model name from the provider's label ("Weekly · Opus" → 每周 · Opus). */
export function quotaWindowLabel(id: string, label: string): string {
  const scoped = id.includes(":"), period = periodOf(id), parts = label.split(" · ").map(part => part.trim()).filter(Boolean);
  const scope = scoped && parts.length > 1 ? parts[0]! : null, detail = parts.length > 1 ? parts.slice(1).join(" · ") : null;
  const seconds = /^(\d{1,9})s$/.exec(period);
  const name = period === "five_hour" ? "5 小时" : period === "weekly" ? "每周"
    : period.startsWith("weekly_") ? `每周 · ${detail ?? period.slice(7).replace(/^(?:model|surface)_/, "")}`
    : period === "monthly" ? "每月" : period === "unknown_primary" ? "主要额度" : period === "unknown_secondary" ? "次要额度"
    : seconds && Number(seconds[1]) > 0 ? lengthName(Number(seconds[1])) : (scoped ? detail : label.trim()) || period;
  return (scope ? `${scope} · ${name}` : name).slice(0, 80);
}
/** The thresholds of Paseo's own Usage bars: below 70 % ok, from 70 % warning, above 90 % danger. */
export function quotaTone(usedPct: number | null): QuotaTone {
  if (usedPct === null) return "neutral";
  return usedPct > 90 ? "danger" : usedPct >= 70 ? "warning" : "ok";
}
/** Whether a window's reset time has passed by `now` (the card re-checks between polls). */
export const quotaWindowReset = (window: Pick<QuotaWindow, "state" | "resetsAt">, now: number): boolean =>
  window.state === "reset" || (window.resetsAt !== null && Date.parse(window.resetsAt) <= now);

/**
 * Whether an account's values are a current reading: read without error, listed by the latest answer and at most
 * QUOTA_FRESH_MS old at `now` (the client checks again between polls). Anything else is an older reading kept on screen.
 */
export function quotaAccountCurrent(account: Pick<QuotaAccount, "status" | "stale" | "readingAt">, now: number): boolean {
  const at = account.readingAt === null ? Number.NaN : Date.parse(account.readingAt);
  return account.status === "available" && !account.stale && Number.isFinite(at) && now - at <= QUOTA_FRESH_MS;
}

const severity: Record<QuotaTone, number> = { danger: 3, warning: 2, ok: 1, neutral: 0 };
export interface QuotaPick { account: QuotaAccount; window: QuotaWindow; /** Only older readings were left: no alarm, and the chip says when it was read. */ stale: boolean }
/**
 * The 看板 chip's window: the tightest one (out or forecast to run out first, then red, amber, green), shorter windows
 * first among equals, then the fuller one, taken from the accounts with a current reading (codex-F8). Only when none
 * has one does an older reading stand in, marked stale: its forecast was made from values that may since have changed,
 * so it ranks by its tone alone and never raises the alarm. Null without any value.
 */
export function tightestQuota(snapshot: Pick<QuotaSnapshot, "accounts"> | undefined, now = Date.now()): QuotaPick | null {
  const pick = (current: boolean): { account: QuotaAccount; window: QuotaWindow } | null => {
    let best: { account: QuotaAccount; window: QuotaWindow; score: [number, number, number] } | null = null;
    for (const account of snapshot?.accounts ?? []) {
      if (quotaAccountCurrent(account, now) !== current) continue;
      for (const window of account.windows) {
        if (window.usedPct === null || quotaWindowReset(window, now)) continue;
        const score: [number, number, number] = [current && window.alarm ? 4 : severity[window.tone], -(window.durationMs ?? Number.MAX_SAFE_INTEGER), window.usedPct];
        if (!best || score[0] > best.score[0] || score[0] === best.score[0] && (score[1] > best.score[1] || score[1] === best.score[1] && score[2] > best.score[2])) best = { account, window, score };
      }
    }
    return best;
  };
  const current = pick(true), chosen = current ?? pick(false);
  return chosen ? { account: chosen.account, window: chosen.window, stale: !current } : null;
}

const two = (value: number) => String(value).padStart(2, "0");
const clockText = (at: number) => { const date = new Date(at); return `${two(date.getHours())}:${two(date.getMinutes())}`; };
const dayStart = (at: number) => { const date = new Date(at); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
/** 14:20 · 明天 09:00 · 昨天 08:30 · 周四 14:20 · 10月20日 14:20 — in the device's time zone (this runs on the client). */
export function quotaWhen(at: number, now: number): string {
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY_MS), date = new Date(at), clock = clockText(at);
  if (days === 0) return clock;
  if (days === 1) return `明天 ${clock}`;
  if (days === -1) return `昨天 ${clock}`;
  if (days > 1 && days < 7) return `${weekdayNames[(date.getDay() + 6) % 7]} ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

export interface QuotaForecastLine { text: string; kind: "alarm" | "warning" | "calm" | "muted"; icon: string }
/** The reading a forecast was made from: its time, and whether it is still current (quotaAccountCurrent). */
export interface QuotaReading { at: number | null; current: boolean }
/**
 * The window's forecast in Chinese: 按当前速度 14:20 用完 / 按本周节奏，重置时约 78% / 已重置，等新读数 … A forecast made
 * from an older reading says which one and is never an alarm (codex-F8): 据 08:30 的读数推算，可能已经用完.
 */
export function quotaForecastText(window: QuotaWindow, now: number, reading: QuotaReading = { at: null, current: true }): QuotaForecastLine | null {
  if (quotaWindowReset(window, now)) return { text: "已重置，等新读数", kind: "muted", icon: "RotateCcw" };
  const forecast = window.forecast, period = window.durationMs === 7 * DAY_MS ? "本周" : "目前的";
  if (!forecast) return null;
  const old = !reading.current, source = reading.at === null ? "据过期的读数" : `据 ${quotaWhen(reading.at, now)} 的读数`;
  // An older reading still bounds the use from below (it only rises until the reset), so 已用完 stays true; a rate is a guess.
  const loud = (text: string, icon: string): QuotaForecastLine => old ? { text: `${source}，${text}`, kind: "warning", icon: "History" } : { text, kind: "alarm", icon };
  if (forecast.kind === "exhausted") return loud(window.resetsAt ? `已用完，${quotaWhen(Date.parse(window.resetsAt), now)} 重置` : "已用完", "BatteryWarning");
  if (forecast.kind === "idle") return { text: old ? `${source}，最近 30 分钟没有消耗` : "最近 30 分钟没有消耗", kind: "muted", icon: "Pause" };
  const how = forecast.method === "pace" ? `按${period}节奏` : "按当前速度";
  if (forecast.kind === "exhaust") { const at = Date.parse(forecast.at); return at > now ? loud(`${how} ${quotaWhen(at, now)} 用完`, "AlarmClock") : loud(old ? `${how}推算可能已经用完` : `${how}，可能已经用完`, "AlarmClock"); }
  const text = `${how}，重置时约 ${Math.round(forecast.pct)}%`;
  return old ? { text: `${source}，${text}`, kind: "muted", icon: "History" } : { text, kind: forecast.pct >= 90 ? "warning" : "calm", icon: "TrendingUp" };
}

/** The 看板 chip's content: what it says and how loud it is (client/quota-card.tsx draws it). */
export interface QuotaChipSummary {
  label: string; value: string;
  /** After the value: 14:20 用完 / 已用完 (alarm), or 读数 08:30 / 读数已过期 (stale). */
  tail: { text: string; kind: "alarm" | "stale" } | null;
  /** Red pulsing only for a current reading that is out or forecast to run out before the reset. */
  alarm: boolean;
  /** A stale reading drops to amber (it was high) or neutral, never red. */
  tone: QuotaTone;
  stale: boolean; accessibilityLabel: string;
}
export function quotaChipSummary(pick: QuotaPick, accounts: number, now: number): QuotaChipSummary {
  const { account, window, stale } = pick, readingAt = account.readingAt === null ? null : Date.parse(account.readingAt);
  const label = accounts > 1 ? `${account.name} · ${window.label}` : `额度 · ${window.label}`, value = `${Math.round(window.usedPct ?? 0)}%`;
  if (stale) {
    const tail = readingAt !== null && Number.isFinite(readingAt) ? `读数 ${quotaWhen(readingAt, now)}` : "读数已过期";
    return { label, value, tail: { text: tail, kind: "stale" }, alarm: false, tone: window.tone === "danger" || window.tone === "warning" ? "warning" : "neutral", stale,
      accessibilityLabel: `${label}已用 ${value}，${tail}，不是当前读数` };
  }
  const forecast = window.forecast, line = quotaForecastText(window, now, { at: readingAt, current: true });
  const tail = forecast?.kind === "exhaust" ? Date.parse(forecast.at) > now ? `${quotaWhen(Date.parse(forecast.at), now)} 用完` : "可能已用完" : forecast?.kind === "exhausted" ? "已用完" : null;
  return { label, value, tail: tail ? { text: tail, kind: "alarm" } : null, alarm: window.alarm, tone: window.tone, stale,
    accessibilityLabel: `${label}已用 ${value}${line && line.kind !== "muted" ? `，${line.text}` : ""}` };
}
