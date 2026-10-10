import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 定时运行: every run of every Paseo schedule on this host, joined with the Agent and workspace it produced.
 * Pure helpers here are shared by the server index and the native/web client.
 */
export const RUN_STATUSES = ["running", "succeeded", "failed", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const runStatusSchema = z.enum(RUN_STATUSES);
/** `schedule`: the live schedule file · `ledger`: kept by the observatory after the file was deleted · `agent`: rebuilt from Agent labels only. */
export const runSourceSchema = z.enum(["schedule", "ledger", "agent"]);
export type RunSource = z.infer<typeof runSourceSchema>;

export const runLinkSchema = z.object({ url: z.string().max(2000), label: z.string().max(24), kind: z.enum(["mr", "pr"]), state: z.enum(["open", "merged", "closed"]).nullable() });
export type RunLink = z.infer<typeof runLinkSchema>;

export const scheduleRunRowSchema = z.object({
  id: z.string().max(120), scheduleId: z.string().max(80), scheduleName: z.string().max(200),
  kind: z.enum(["new-agent", "heartbeat"]), status: runStatusSchema, source: runSourceSchema,
  scheduledFor: z.string().nullable(), startedAt: z.string(), endedAt: z.string().nullable(),
  /** First lines of the recorded final reply, Markdown stripped; the full text is read on demand. */
  preview: z.string().max(400).nullable(), hasOutput: z.boolean(), error: z.string().max(2000).nullable(),
  agent: z.object({ id: z.string().max(256), title: z.string().max(240).nullable(), status: z.string().max(40).nullable(), archivedAt: z.string().nullable(), known: z.boolean(),
    /** false: only Paseo's record still has it — its project was removed, so the host no longer lists it nor opens its session or workspace. */
    listed: z.boolean().optional() }).nullable(),
  workspace: z.object({ id: z.string().max(256), name: z.string().max(240).nullable(), branch: z.string().max(240).nullable(), archivedAt: z.string().nullable() }).nullable(),
  projectName: z.string().max(240).nullable(), link: runLinkSchema.nullable(),
});
export type ScheduleRunRow = z.infer<typeof scheduleRunRowSchema>;

export const scheduleSummarySchema = z.object({
  id: z.string().max(80), name: z.string().max(200), kind: z.enum(["new-agent", "heartbeat"]),
  status: z.enum(["active", "paused", "completed", "deleted"]), cadence: z.string().max(160),
  /** IANA zone a cron cadence runs in (Paseo's default is UTC); null for intervals and unknown schedules. */
  timezone: z.string().max(80).nullable(),
  /** What it runs against: the heartbeat's Agent title, or the working directory's name. */
  target: z.string().max(240).nullable(),
  nextRunAt: z.string().nullable(), lastRunAt: z.string().nullable(), provider: z.string().max(120).nullable(),
  /** Up to the last 10 run statuses, oldest first: the health strip. */
  recent: z.array(runStatusSchema).max(10), total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
});
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;

/** 「最近」: the last 30 days, at most 200 runs plus 100 heartbeat runs (a phone's first load stays small). 「全部」: up to 500 + 250. */
export const RUN_WINDOWS = { recent: { days: 30, runs: 200, heartbeats: 100 }, all: { days: null, runs: 500, heartbeats: 250 } } as const;
export type RunWindow = keyof typeof RUN_WINDOWS;
const revision = z.string().min(1).max(80);
export const listScheduleRuns = defineRpc({
  name: "observatory.schedules.list",
  input: z.object({ revision: revision.optional(), window: z.enum(["recent", "all"]).optional() }),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("full"), unchanged: z.literal(false), revision, generatedAt: z.string(), window: z.enum(["recent", "all"]),
      schedules: z.array(scheduleSummarySchema).max(400), runs: z.array(scheduleRunRowSchema).max(800),
      /** Runs left out by the window or the cap; 「加载更早」 asks for the 「全部」 window. */
      older: z.number().int().nonnegative(), olderHeartbeats: z.number().int().nonnegative(), truncated: z.boolean(),
      /** The last 7 days over every run (not just the window), split so the 心跳 switch can include heartbeats. */
      week: z.object({ runs: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), heartbeats: z.number().int().nonnegative(), heartbeatsFailed: z.number().int().nonnegative() }),
      /** Runs whose schedule file is gone and that only Agent labels still describe. */
      reconstructed: z.number().int().nonnegative(),
      /** The schedules directory could not be read. */ error: z.string().max(500).nullable(),
      /** Ledger trouble worth a quiet banner (reset after corruption, could not save). */ notice: z.string().max(500).nullable() }),
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
  ]),
});
export type ScheduleRunsResponse = z.infer<typeof listScheduleRuns.output>;
export type ScheduleRunsState = Extract<ScheduleRunsResponse, { mode: "full" }>;
export function mergeScheduleRuns(previous: ScheduleRunsState | undefined, response: ScheduleRunsResponse): ScheduleRunsState {
  if (response.mode === "full") return response;
  if (!previous) throw new Error("本地定时运行缓存已失效，正在重新读取。");
  return previous;
}

/** The full recorded reply of one run, read only when its detail opens. */
export const getScheduleRun = defineRpc({
  name: "observatory.schedules.run",
  input: z.object({ runId: z.string().min(1).max(120) }),
  output: z.object({ runId: z.string(), output: z.string().max(60_000).nullable(), outputTruncated: z.boolean(), prompt: z.string().max(8000).nullable(),
    /** Why the reply is not available (schedule deleted, still running…). */ note: z.string().max(300).nullable(),
    /** The run and its schedule as the feed shows them, for an Agent's 定时任务 card; null when nothing describes the run. */
    row: scheduleRunRowSchema.nullable(), schedule: scheduleSummarySchema.nullable() }),
});
export type ScheduleRunDetail = z.infer<typeof getScheduleRun.output>;

// ---------- pure helpers ----------

const PULL_REQUEST = /https?:\/\/[^\s<>()[\]"'`]+?\/(?:pull|pulls|merge_requests)\/(\d+)(?=[^\w/]|$)/;
/** First merge/pull request URL in a text: GitLab-style merge requests (`/merge_requests/12`) read `!12`, GitHub PRs `#34`. */
export function findChangeRequest(text: string | null | undefined): RunLink | null {
  if (!text) return null;
  const match = PULL_REQUEST.exec(text);
  if (!match) return null;
  const mr = /\/merge_requests\//.test(match[0]);
  return { url: match[0].slice(0, 2000), label: `${mr ? "!" : "#"}${match[1]}`, kind: mr ? "mr" : "pr", state: null };
}

/** Drop Markdown noise and the daemon's leading rule, collapse whitespace: one paragraph for a list row. */
export function previewOf(text: string | null | undefined, max = 280): string | null {
  if (!text) return null;
  const plain = text.replace(/^\s*---\s*\n/, "").replace(/```[^\n]*\n?/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").replace(/^\s{0,3}>\s?/gm, "").replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2").replace(/`([^`]*)`/g, "$1").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (value: number) => String(value).padStart(2, "0");
/** Common cron shapes in Chinese (每 6 小时 / 每天 09:30 / 工作日 09:00 / 每周五 18:00); anything else stays as written. */
export function cadenceLabel(cadence: { type: "cron"; expression: string; timezone?: string | null } | { type: "every"; everyMs: number }): string {
  if (cadence.type === "every") {
    const minutes = Math.round(cadence.everyMs / 60_000);
    return minutes % 1440 === 0 ? `每 ${minutes / 1440} 天` : minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  const fields = cadence.expression.trim().split(/\s+/);
  let text = cadence.expression.trim();
  if (fields.length === 5) {
    const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
    const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${pad(Number(hour))}:${pad(Number(minute))}` : null;
    const every = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
    if (day === "*" && month === "*" && weekday === "*") {
      if (every(minute) && hour === "*") text = `每 ${every(minute)} 分钟`;
      else if (/^\d+$/.test(minute) && every(hour)) text = `每 ${every(hour)} 小时`;
      else if (/^\d+$/.test(minute) && hour === "*") text = "每小时";
      else if (at) text = `每天 ${at}`;
    } else if (day === "*" && month === "*" && at) {
      if (weekday === "1-5") text = `工作日 ${at}`;
      else if (/^[0-7]$/.test(weekday)) text = `每${WEEKDAYS[Number(weekday) % 7]} ${at}`;
    }
  }
  return text;
}

const ZONE_NAMES: Record<string, string> = { UTC: "UTC", "Etc/UTC": "UTC", GMT: "UTC", "Asia/Shanghai": "北京时间", "Asia/Hong_Kong": "香港时间", "Asia/Taipei": "台北时间", "Asia/Tokyo": "东京时间",
  "America/Los_Angeles": "太平洋时间", "America/Denver": "山地时间", "America/Chicago": "中部时间", "America/New_York": "美东时间", "Europe/London": "伦敦时间", "Europe/Berlin": "柏林时间" };
const sameZone = (a: string, b: string) => (ZONE_NAMES[a] === "UTC" && ZONE_NAMES[b] === "UTC") || a === b;
/** The device's IANA zone, or null where the runtime cannot tell. */
export function deviceTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
/** 「北京时间」「UTC」「Los Angeles」. */
export function zoneLabel(zone: string): string { return ZONE_NAMES[zone] ?? zone.split("/").at(-1)!.replaceAll("_", " "); }
/** A cron cadence shows its zone when it differs from the device's (Paseo runs zone-less crons in UTC). */
export function cadenceText(schedule: { cadence: string; timezone: string | null }, device: string | null): string {
  if (!schedule.cadence || !schedule.timezone || (device && sameZone(schedule.timezone, device))) return schedule.cadence;
  return `${schedule.cadence}（${zoneLabel(schedule.timezone)}）`;
}

export function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface RunGroup { key: string; label: string; runs: ScheduleRunRow[] }
const DAY = 86_400_000;
const startOfDay = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
const startOfWeek = (ms: number) => { const date = new Date(startOfDay(ms)); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date.getTime(); };
const monthDay = (ms: number) => { const date = new Date(ms); return `${date.getMonth() + 1}月${date.getDate()}日`; };
/**
 * 今天 / 昨天 / 10月6日 周二 for the past week, one group per week (周一起) for the month before, then per month, then per year.
 * Runs arrive newest first and keep their order inside a group.
 */
export function groupRunsByDay(runs: readonly ScheduleRunRow[], now: number): RunGroup[] {
  const today = startOfDay(now), dayFloor = today - 6 * DAY, weekFloor = startOfWeek(dayFloor - 30 * DAY);
  const groups = new Map<string, RunGroup & { start: number }>();
  for (const run of runs) {
    const time = parseTime(run.startedAt) || parseTime(run.scheduledFor);
    let key: string, label: string, start: number;
    if (!time) { key = "undated"; label = "时间未知"; start = 0; }
    else if (time >= dayFloor) {
      start = Math.min(startOfDay(time), today); key = `d${start}`;
      const date = new Date(start);
      label = start === today ? "今天" : start === today - DAY || start === startOfDay(today - DAY) ? "昨天" : `${monthDay(start)} ${WEEKDAYS[date.getDay()]}`;
    } else if (time >= weekFloor) {
      start = startOfWeek(time); key = `w${start}`;
      const end = Math.min(start + 6 * DAY, dayFloor - DAY);
      label = end <= start ? monthDay(start) : `${monthDay(start)} – ${monthDay(end)}`;
    } else {
      const date = new Date(time), thisYear = new Date(now).getFullYear();
      if (time >= new Date(thisYear - 1, new Date(now).getMonth(), 1).getTime()) {
        start = new Date(date.getFullYear(), date.getMonth(), 1).getTime(); key = `m${start}`;
        label = date.getFullYear() === thisYear ? `${date.getMonth() + 1}月` : `${date.getFullYear()}年${date.getMonth() + 1}月`;
      } else { start = new Date(date.getFullYear(), 0, 1).getTime(); key = `y${start}`; label = `${date.getFullYear()}年`; }
    }
    const group = groups.get(key);
    if (group) group.runs.push(run); else groups.set(key, { key, label, runs: [run], start });
  }
  return [...groups.values()].sort((a, b) => b.start - a.start).map(({ key, label, runs: items }) => ({ key, label, runs: items }));
}

export interface RunFilter { status: RunStatus | "all"; scheduleId: string | "all"; heartbeats: boolean; query: string }
export const EMPTY_RUN_FILTER: RunFilter = { status: "all", scheduleId: "all", heartbeats: false, query: "" };
/** Every word must appear in the schedule name, Agent title, workspace, branch, preview, error or link. */
export function filterRuns(runs: readonly ScheduleRunRow[], filter: RunFilter): ScheduleRunRow[] {
  const words = filter.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter(run => {
    if (!filter.heartbeats && run.kind === "heartbeat" && filter.scheduleId !== run.scheduleId) return false;
    if (filter.scheduleId !== "all" && run.scheduleId !== filter.scheduleId) return false;
    if (filter.status !== "all" && run.status !== filter.status) return false;
    if (!words.length) return true;
    const haystack = [run.scheduleName, run.agent?.title, run.workspace?.name, run.workspace?.branch, run.preview, run.error, run.link?.label, run.link?.url, run.projectName]
      .filter(Boolean).join("\n").toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

/**
 * Paseo's run errors are English and ACP ones repeat themselves ("Internal error: … code: -32603 Internal error: … | data=…").
 * Known causes get a short Chinese summary; the cleaned original stays available for the detail view.
 */
export function describeRunError(error: string | null | undefined): { summary: string; detail: string; known: boolean } | null {
  if (!error?.trim()) return null;
  const detail = error.replace(/^Internal error:\s*/i, "").split(/\n\s*\n|\s+\|\s+code=/)[0]!.replace(/\s*code:\s*-?\d+\s*$/i, "").trim() || error.trim();
  const known: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    [/Working directory (.+) (?:no longer exists|is not a directory)/, match => `工作目录已不存在：${match[1]}（任务已自动结束）`],
    [/is waiting for permission/, () => "Agent 在等你审批，这次没能跑完"],
    [/Daemon restarted before the scheduled run completed/, () => "daemon 重启，打断了这次运行"],
    [/Timed out refreshing (.+?) after \d+ms/, match => `Provider「${match[1]}」启动超时`],
    [/already has an active run/, () => "Agent 正在忙，这次心跳被跳过"],
    [/does not support ACP session resume/, () => "会话无法恢复：这个 ACP Agent 不支持重新载入"],
    [/was canceled/, () => "运行被取消"],
    [/Agent \S+ (?:no longer exists|is archived)/, () => "目标 Agent 已归档或删除，任务已自动结束"],
  ];
  for (const [pattern, summarize] of known) { const match = pattern.exec(detail); if (match) return { summary: summarize(match), detail, known: true }; }
  return { summary: detail.split("\n")[0]!.slice(0, 200), detail, known: false };
}
/** The Chinese summary of a known Paseo / ACP error, or null (other errors are shown as they are). */
export function knownRunError(error: string | null | undefined): string | null {
  const described = describeRunError(error);
  return described?.known ? described.summary : null;
}
