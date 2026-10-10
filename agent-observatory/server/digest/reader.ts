import type { PaseoAgentTimelineRefetchOptions } from "../paseo-types";
import { normalizeTimelinePage, object, type TimelineCursor } from "../../shared/timeline";
import { compactRow, createFold, foldRows, withTimeBounds } from "./fold";
import type { CompactRow, FoldState } from "./model";

export const MAX_ROWS = 8_000;
// The protocol has no finite page maximum. This is the bounded projected-entry budget.
export const PAGE_SIZE = MAX_ROWS;
export type TimelineFetch = (options: PaseoAgentTimelineRefetchOptions) => Promise<unknown>;
export interface History {
  state: FoldState; cursor: TimelineCursor | null; version: number;
  /** Authoritative compact entries by anchor. No raw tool bodies, reasoning, outputs or diffs. */
  facts: Map<number, CompactRow>;
}
class Replaced extends Error {}

function readPage(raw: unknown) {
  const value = object(raw);
  if (value.error) throw new Error("会话时间线读取失败，请稍后重试");
  const page = normalizeTimelinePage(raw);
  if (page.rows.length && (typeof value.epoch !== "string" || !value.epoch)) throw new Error("会话时间线缺少 epoch，请稍后重试");
  return { ...page, projected: value.projection === "projected" || page.rows.some(row => row.seqStart !== row.seqEnd) };
}

function replay(agentId: string, cwd: string, epoch: string, facts: Map<number, CompactRow>, truncated: boolean): FoldState {
  const ordered = withTimeBounds([...facts.values()]);
  const state = foldRows(createFold(agentId, cwd, ordered.length ? epoch : null), ordered);
  // Only canonical rows promise dense seqs; projected ranges interleave and may legitimately be sparse.
  if (ordered.every(row => !row.projected)) {
    truncated ||= ordered.some((row, index) => index > 0 && row.seq !== ordered[index - 1]!.lastSeq + 1);
  }
  state.truncated = truncated;
  return state;
}

function trim(facts: Map<number, CompactRow>): boolean {
  const overflow = facts.size - MAX_ROWS;
  if (overflow <= 0) return false;
  for (const seq of [...facts.keys()].sort((a, b) => a - b).slice(0, overflow)) facts.delete(seq);
  return true;
}

async function initial(fetch: TimelineFetch, agentId: string, cwd: string, version: number): Promise<History> {
  const facts = new Map<number, CompactRow>();
  let page = readPage(await fetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" }));
  const epoch = page.epoch, cursor = page.endCursor;
  let truncated = false;
  const visited = new Set<number>();
  while (true) {
    if (page.epoch !== epoch || page.reset) throw new Replaced();
    const count = page.rows.length;
    for (const row of page.rows) {
      const previous = facts.get(row.seqStart);
      if (!previous || row.seqEnd > previous.lastSeq) facts.set(row.seqStart, compactRow(row, cwd, page.projected));
    }
    truncated ||= page.truncated || page.gap;
    if (trim(facts)) truncated = true;
    page.rows.length = 0;
    if (!page.hasOlder) break;
    if (facts.size >= MAX_ROWS || !page.startCursor || visited.has(page.startCursor.seq) || !count) { truncated = true; break; }
    const before = page.startCursor; visited.add(before.seq);
    page = readPage(await fetch({ direction: "before", cursor: before, limit: MAX_ROWS - facts.size, projection: "projected" }));
  }
  return { state: replay(agentId, cwd, epoch, facts, truncated), cursor, facts, version };
}

/** Projected `after` may return anchors before the cursor. Replace those entries and replay the compact window. */
export async function fetchHistory(fetch: TimelineFetch, agentId: string, cwd: string, previous?: History): Promise<History> {
  if (previous?.cursor && previous.state.cwd === cwd) {
    let cursor = previous.cursor, facts: Map<number, CompactRow> | null = null, valid = true, changed = false;
    let truncated = previous.state.truncated;
    for (let pages = 0; ; pages++) {
      const page = readPage(await fetch({ direction: "after", cursor, limit: PAGE_SIZE, projection: "projected" }));
      if (page.epoch !== previous.state.epoch || page.reset || page.gap) { valid = false; break; }
      // One early-anchored tool can end beyond other, unreturned entries. Advancing to its end cursor
      // would skip them when an `after` page is limited; rebuild the bounded tail in that case.
      if (page.projected && page.hasNewer) { valid = false; break; }
      const rows = page.rows.sort((a, b) => a.seqStart - b.seqStart);
      if (!page.projected) {
        const fresh = rows.filter(row => row.seqEnd > cursor.seq);
        if (fresh.some((row, index) => row.seqStart !== (index ? fresh[index - 1]!.seqEnd : cursor.seq) + 1)) { valid = false; break; }
      }
      let nextSeq = Math.max(cursor.seq, page.endCursor?.seq ?? cursor.seq);
      for (const row of rows) {
        const compact = compactRow(row, cwd, page.projected), before = (facts ?? previous.facts).get(row.seqStart);
        nextSeq = Math.max(nextSeq, row.seqEnd);
        if (!before || JSON.stringify(compact) !== JSON.stringify(before)) {
          facts ??= new Map(previous.facts); facts.set(row.seqStart, compact); changed = true;
        }
      }
      if (facts && trim(facts)) truncated = true;
      truncated ||= page.truncated;
      page.rows.length = 0;
      if (!page.hasNewer) { cursor = { epoch: page.epoch, seq: nextSeq }; break; }
      if (nextSeq <= cursor.seq || pages >= 63) { valid = false; break; }
      cursor = { epoch: page.epoch, seq: nextSeq };
    }
    if (valid) {
      if (!changed && truncated === previous.state.truncated) return { ...previous, cursor };
      facts ??= previous.facts;
      return { state: replay(agentId, cwd, cursor.epoch, facts, truncated), cursor, facts, version: previous.version + 1 };
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const history = await initial(fetch, agentId, cwd, (previous?.version ?? 0) + 1);
      if (previous && !previous.state.rows && !history.state.rows) history.version = previous.version;
      return history;
    }
    catch (error) { if (!(error instanceof Replaced)) throw error; }
  }
  throw new Error("会话历史正在替换，请稍后刷新复盘");
}
