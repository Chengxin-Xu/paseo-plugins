import { createHash } from "node:crypto";
import { statsRangeDays, vendorOf, type StatsRange } from "../../shared/stats";
import { addTokenCounts, emptyTokenCounts, tokenSourceNames, tokenTotal, type TokenCounts, type TokenRow, type TokenSession, type TokenSnapshot } from "../../shared/tokens";
import type { StatsDirectory } from "../stats-directory";
import type { StatsDirectoryAgent } from "../stats-types";
import { binSpeed, projectName, sessionKey, type CallRecord, type TokenData } from "./data";
import { DAY, dayOf, dayText, iso } from "./types";

/** Byte limits also keep multibyte titles within the relay payload budget. IDs remain usable for navigation. */
function text(value: string, bytes = 96): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = "";
  for (const char of value) { if (Buffer.byteLength(result + char) > bytes - 3) break; result += char; }
  return result + "…";
}
const nullableText = (value: string | null): string | null => value === null ? null : text(value);
function wireKey(value: string): string {
  return Buffer.byteLength(value) <= 160 ? value : `${text(value, 135)}:${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}
interface Breakdown extends TokenCounts { key: string; label: string; vendor: string | null; ids: Set<string>; lastAt: number }
interface Session extends TokenCounts { sessionId: string; source: TokenSession["source"]; cwd: string; firstAt: number; lastAt: number; subagentCalls: number; models: Map<string | null, number> }
function getRow(rows: Map<string, Breakdown>, key: string, label: string, vendor: string | null): Breakdown {
  let row = rows.get(key);
  if (!row) { row = { key, label, vendor, ids: new Set(), lastAt: -Infinity, ...emptyTokenCounts() }; rows.set(key, row); }
  return row;
}
function sortedRows(rows: Map<string, Breakdown>): Breakdown[] {
  return [...rows.values()].sort((a, b) => tokenTotal(b) - tokenTotal(a) || a.key.localeCompare(b.key));
}
function projectFor(cwd: string, projects: Map<string, StatsDirectoryAgent>): { key: string; label: string } {
  const agent = projects.get(cwd);
  return { key: agent?.projectKey || cwd || "unknown", label: agent?.projectName || projectName(cwd) };
}
function projectRows(rows: Breakdown[], limit: number): TokenRow[] {
  const selected = rows.length <= limit ? rows : rows.slice(0, limit - 1);
  if (rows.length > limit) {
    const other: Breakdown = { key: "__other__", label: "其他", vendor: null, ids: new Set(), lastAt: -Infinity, ...emptyTokenCounts() };
    for (const row of rows.slice(limit - 1)) {
      addTokenCounts(other, row); for (const id of row.ids) other.ids.add(id); other.lastAt = Math.max(other.lastAt, row.lastAt);
    }
    selected.push(other);
  }
  return selected.map(row => ({ ...emptyTokenCounts(), ...Object.fromEntries(Object.keys(emptyTokenCounts()).map(key => [key, row[key as keyof TokenCounts]])),
    key: wireKey(row.key), label: text(row.label), vendor: row.vendor, sessions: row.ids.size, lastAt: Number.isFinite(row.lastAt) ? iso(row.lastAt) : null }));
}
function percentile(speeds: Map<number, number>, quantile: number): number | null {
  let total = 0; for (const n of speeds.values()) total += n;
  if (!total) return null;
  const target = Math.ceil(total * quantile); let count = 0;
  for (const [bin, n] of [...speeds].sort((a, b) => a[0] - b[0])) { count += n; if (count >= target) return binSpeed(bin); }
  return null;
}

/** Projection only: all log reads, retention and directory refresh happen outside an RPC build. */
export function buildTokenSnapshot(data: TokenData, input: { range: StatsRange; utcOffsetMinutes: number }, now: number,
  directory: StatsDirectory, coverage: TokenSnapshot["coverage"]): TokenSnapshot {
  const offset = input.utcOffsetMinutes * 60_000, today = dayOf(now + offset), length = statsRangeDays[input.range];
  const from = today - (length - 1) * DAY, previousFrom = from - length * DAY, oldest = dayOf(now) - 399 * DAY;
  const totals = emptyTokenCounts(), previous = emptyTokenCounts(), allTime = emptyTokenCounts();
  const daily = Array.from({ length }, (_, index) => ({ day: dayText(from + index * DAY), ...emptyTokenCounts() }));
  const hours = Array<number>(24).fill(0), models = new Map<string, Breakdown>(), sources = new Map<string, Breakdown>(), projects = new Map<string, Breakdown>();
  const agents = new Map<string, StatsDirectoryAgent>(), cwdAgents = new Map<string, StatsDirectoryAgent>();
  for (const agent of [...directory.agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))) {
    if (agent.sessionId && !agents.has(agent.sessionId)) agents.set(agent.sessionId, agent);
    if (agent.cwd && !cwdAgents.has(agent.cwd)) cwdAgents.set(agent.cwd, agent);
  }
  const inRange = (at: number): boolean => at <= now && dayOf(at + offset) >= from && dayOf(at + offset) <= today;
  for (const map of [data.hours, data.days]) for (const bucket of map.values()) {
    if (bucket.at > now || bucket.at < oldest) continue;
    addTokenCounts(allTime, bucket);
    const day = dayOf(bucket.at + offset);
    if (day >= previousFrom && day < from) addTokenCounts(previous, bucket);
    if (day < from || day > today) continue;
    addTokenCounts(totals, bucket); addTokenCounts(daily[Math.round((day - from) / DAY)], bucket);
    hours[new Date(bucket.at + offset).getUTCHours()] += tokenTotal(bucket);
    const model = getRow(models, bucket.model ?? "unknown", bucket.model ?? "未知", vendorOf(bucket.model, null));
    const source = getRow(sources, bucket.source, tokenSourceNames[bucket.source], null);
    for (const row of [model, source]) { addTokenCounts(row, bucket); row.lastAt = Math.max(row.lastAt, bucket.lastAt); }
  }
  for (const bucket of data.projectHours.values()) {
    if (!inRange(bucket.at)) continue;
    const project = projectFor(bucket.cwd, cwdAgents), row = getRow(projects, project.key, project.label, null);
    addTokenCounts(row, bucket); row.lastAt = Math.max(row.lastAt, bucket.lastAt);
  }
  const sessions = new Map<string, Session>();
  for (const bucket of data.sessionHours.values()) {
    if (!inRange(bucket.at)) continue;
    const id = sessionKey(bucket.source, bucket.sessionId), project = projectFor(bucket.cwd, cwdAgents);
    models.get(bucket.model ?? "unknown")?.ids.add(id); sources.get(bucket.source)?.ids.add(id); projects.get(project.key)?.ids.add(id);
    let row = sessions.get(id);
    if (!row) { row = { sessionId: bucket.sessionId, source: bucket.source, cwd: bucket.cwd, firstAt: bucket.firstAt, lastAt: bucket.lastAt,
      subagentCalls: 0, models: new Map(), ...emptyTokenCounts() }; sessions.set(id, row); }
    addTokenCounts(row, bucket); row.firstAt = Math.min(row.firstAt, bucket.firstAt);
    if (bucket.lastAt >= row.lastAt) { row.cwd = bucket.cwd; row.lastAt = bucket.lastAt; }
    row.subagentCalls += bucket.subagentCalls; row.models.set(bucket.model, (row.models.get(bucket.model) ?? 0) + bucket.calls);
  }
  let paseoTokens = 0;
  for (const row of sessions.values()) if (agents.has(row.sessionId)) paseoTokens += tokenTotal(row);
  const sessionRows: TokenSession[] = [...sessions.values()].sort((a, b) => tokenTotal(b) - tokenTotal(a) || a.sessionId.localeCompare(b.sessionId)).slice(0, 20).map(row => {
    const agent = agents.get(row.sessionId), model = [...row.models].sort((a, b) => b[1] - a[1] || (a[0] ?? "").localeCompare(b[0] ?? ""))[0]?.[0] ?? null;
    return { ...addTokenCounts(emptyTokenCounts(), row), sessionId: row.sessionId.slice(0, 256), source: row.source, model: nullableText(model),
      project: text(projectFor(row.cwd || data.sessions.get(sessionKey(row.source, row.sessionId))?.cwd || "", cwdAgents).label),
      agentId: agent?.id.slice(0, 256) ?? null, title: nullableText(agent?.title ?? null), firstAt: iso(row.firstAt), lastAt: iso(row.lastAt), subagentCalls: row.subagentCalls };
  });
  let fastest: CallRecord | null = null, biggest: CallRecord | null = null;
  const speeds = new Map<number, number>();
  for (const row of data.recordHours.values()) {
    if (!inRange(row.at)) continue;
    for (const [bin, n] of Object.entries(row.speeds)) speeds.set(Number(bin), (speeds.get(Number(bin)) ?? 0) + n);
    for (const item of row.fastest) if (item.at <= now && (!fastest || item.tps > fastest.tps || item.tps === fastest.tps && item.at < fastest.at)) fastest = item;
    for (const item of row.biggest) if (item.at <= now && (!biggest || item.output > biggest.output || item.output === biggest.output && item.at < biggest.at)) biggest = item;
  }
  const peakDay = daily.reduce<TokenSnapshot["records"]["peakDay"]>((peak, row) => tokenTotal(row) > (peak?.total ?? 0) ? { day: row.day, total: tokenTotal(row) } : peak, null);
  const modelRows = sortedRows(models), projectBreakdown = sortedRows(projects);
  const result: TokenSnapshot = { generatedAt: iso(now), ...input, from: dayText(from), to: dayText(today), totals, previous, allTime, daily, hours,
    models: projectRows(modelRows, 24), sources: projectRows(sortedRows(sources), 2), projects: projectRows(projectBreakdown, 24), sessions: sessionRows,
    records: { peakDay, fastest: fastest ? { tps: fastest.tps, model: nullableText(fastest.model), at: iso(fastest.at), output: fastest.output } : null,
      biggest: biggest ? { output: biggest.output, model: nullableText(biggest.model), at: iso(biggest.at) } : null },
    speed: { p50: percentile(speeds, 0.5), p90: percentile(speeds, 0.9) }, paseoShare: tokenTotal(totals) ? Math.min(1, paseoTokens / tokenTotal(totals)) : null,
    coverage: { ...coverage, backfill: { ...coverage.backfill }, roots: coverage.roots.slice(0, 8).map(root => ({ ...root, path: text(root.path, 512), error: root.error === null ? null : text(root.error, 160) })) } };
  // Large valid identifiers cannot be shortened without breaking navigation. Reduce low-ranked rows only if needed.
  let modelLimit = 24, projectLimit = 24;
  while (Buffer.byteLength(JSON.stringify(result)) >= 59_000) {
    if (result.sessions.length > 5) result.sessions.pop();
    else if (result.models.length > 2 && modelLimit >= projectLimit) result.models = projectRows(modelRows, --modelLimit);
    else if (result.projects.length > 2) result.projects = projectRows(projectBreakdown, --projectLimit);
    else if (result.models.length > 2) result.models = projectRows(modelRows, --modelLimit);
    else break;
  }
  return result;
}
