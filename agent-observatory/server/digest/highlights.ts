import { CHECK_KINDS, type CheckKind, type Digest, type DigestCheck, type DigestHighlight, type DigestSegment, type DigestTurn } from "../../shared/digest";
import { tokenTotal } from "../../shared/tokens";
import { analyzeCommand } from "./commands";
import { excerpt, type FoldState, type ToolFact } from "./model";

const checkNames: Record<CheckKind, string> = { test: "测试", typecheck: "类型检查", lint: "代码检查", build: "构建", install: "依赖安装" };
const severityRank: Record<DigestHighlight["severity"], number> = { bad: 0, warn: 1, good: 2, info: 3 };
const reference = (seq: number | null | undefined) => seq !== null && seq !== undefined && seq >= 0 ? seq : null;

/** Build from the complete compact facts, before chart / turn / check payload thinning. */
export function buildHighlights(state: FoldState, turns: readonly DigestTurn[], segments: readonly DigestSegment[],
  checks: readonly DigestCheck[], tokens: Digest["tokens"]): DigestHighlight[] {
  const result: DigestHighlight[] = [];
  const add = (highlight: DigestHighlight) => result.push({ ...highlight, title: excerpt(highlight.title, 80),
    detail: excerpt(highlight.detail, 160), seq: reference(highlight.seq) });
  const tools = [...state.tools.values()].sort((a, b) => a.seq - b.seq || a.start - b.start);
  const toolsBySeq = new Map(tools.map(tool => [tool.seq, tool]));
  const factsByTurn = new Map(state.turns.map(turn => [turn.index, turn]));
  const segmentsBySeq = new Map(segments.filter(segment => segment.seq !== null && segment.lane !== "model" && segment.lane !== "wait")
    .map(segment => [segment.seq, segment]));
  const duration = (tool: ToolFact) => Math.max(0, (segmentsBySeq.get(tool.seq)?.end ?? tool.end) - tool.start);
  const toolAt = (tool: ToolFact) => Math.max(tool.start, segmentsBySeq.get(tool.seq)?.end ?? tool.end);
  const toolDetail = (tool: ToolFact) => tool.command || tool.path || tool.target || tool.name;

  for (const turn of turns) {
    const fact = factsByTurn.get(turn.index), at = turn.end ?? fact?.end ?? turn.start;
    if (turn.outcome === "failed") add({ kind: "turn_failed", severity: "bad", at, turn: turn.index,
      title: `第 ${turn.index} 轮失败`, detail: turn.reply || turn.prompt, value: null, seq: reference(fact?.lastRef ?? fact?.lastSeq) });
    if (turn.outcome === "canceled") add({ kind: "interrupted", severity: "warn", at, turn: turn.index,
      title: `第 ${turn.index} 轮已中断`, detail: turn.prompt, value: null, seq: reference(fact?.lastRef ?? fact?.lastSeq) });
    if (turn.files >= 8) add({ kind: "many_files", severity: "info", at, turn: turn.index,
      title: `第 ${turn.index} 轮改动 ${turn.files} 个文件`, detail: turn.prompt, value: turn.files, seq: reference(fact?.seq) });
  }

  // A repaired run replaces its old failure episode, so an eventual pass does not remain a bad signal.
  const orderedChecks = [...checks].sort((a, b) => a.start - b.start || (a.seq ?? 0) - (b.seq ?? 0));
  const failedGroups = new Map<string, DigestCheck[]>();
  const checksByKind = new Map<CheckKind, DigestCheck[]>();
  const checkHighlight = (kind: "check_failed" | "check_fixed", failures: readonly DigestCheck[], last: DigestCheck) => {
    add({ kind, severity: kind === "check_fixed" ? "good" : "bad", at: last.end ?? last.start, turn: last.turn,
      title: `${checkNames[last.kind]}失败 ${failures.length} 次${kind === "check_fixed" ? "后通过" : ""}`,
      detail: last.command, value: failures.length, seq: last.seq });
  };
  for (const check of orderedChecks) {
    const kindChecks = checksByKind.get(check.kind) ?? []; kindChecks.push(check); checksByKind.set(check.kind, kindChecks);
    const tool = check.seq === null ? undefined : toolsBySeq.get(check.seq);
    const key = `${check.kind}\0${tool?.program || analyzeCommand(check.command).program}`;
    const failures = failedGroups.get(key) ?? [];
    if (check.ok === false) { failures.push(check); failedGroups.set(key, failures); }
    else if (check.ok === true && failures.length) { checkHighlight("check_fixed", failures, check); failedGroups.delete(key); }
  }
  for (const failures of failedGroups.values()) checkHighlight("check_failed", failures, failures[failures.length - 1]!);
  for (const kind of CHECK_KINDS) {
    const runs = checksByKind.get(kind), last = runs?.at(-1);
    if (last?.ok && !runs!.some(check => check.ok === false)) add({ kind: "check_passed", severity: "good",
      at: last.end ?? last.start, turn: last.turn, title: `${checkNames[kind]}通过`, detail: last.command,
      value: runs!.filter(check => check.ok === true).length, seq: last.seq });
  }

  const streakOf = new Map<ToolFact, number>(), repeats = new Map<string, ToolFact[]>();
  let consecutive: ToolFact[] = [], streakIndex = 0;
  const flushStreak = () => {
    if (consecutive.length >= 3) {
      const last = consecutive[consecutive.length - 1]!;
      add({ kind: "fail_streak", severity: "bad", at: toolAt(last), turn: last.turn,
        title: `连续 ${consecutive.length} 次失败`, detail: toolDetail(last), value: consecutive.length, seq: last.seq });
      for (const tool of consecutive) streakOf.set(tool, streakIndex);
      streakIndex++;
    }
    consecutive = [];
  };
  for (const tool of tools) {
    if (tool.status === "failed") {
      consecutive.push(tool);
      if (tool.commandKey) { const list = repeats.get(tool.commandKey) ?? []; list.push(tool); repeats.set(tool.commandKey, list); }
    } else flushStreak();
  }
  flushStreak();
  for (const repeated of repeats.values()) if (repeated.length >= 3) {
    // An uninterrupted failed streak already conveys this retry episode.
    const firstStreak = streakOf.get(repeated[0]!);
    if (firstStreak !== undefined && repeated.every(tool => streakOf.get(tool) === firstStreak)) continue;
    const last = repeated[repeated.length - 1]!;
    add({ kind: "fail_streak", severity: "bad", at: toolAt(last), turn: last.turn,
      title: `同一命令失败 ${repeated.length} 次`, detail: toolDetail(last), value: repeated.length, seq: last.seq });
  }

  for (const event of state.events) add({ kind: event.type, severity: event.type === "error" ? "bad" : "info",
    at: event.at, turn: event.turn, title: event.type === "error" ? "执行报错" : "上下文压缩",
    detail: event.detail, value: null, seq: event.seq });

  for (const tool of tools.filter(tool => duration(tool) >= 60_000).sort((a, b) => duration(b) - duration(a) || b.seq - a.seq).slice(0, 3)) {
    add({ kind: "slow_tool", severity: "warn", at: toolAt(tool), turn: tool.turn,
      title: tool.lane === "shell" ? "耗时较长的命令" : tool.lane === "agent" ? "耗时较长的子任务" : "耗时较长的工具",
      detail: toolDetail(tool), value: duration(tool), seq: tool.seq });
  }
  for (const segment of segments) {
    const ms = segment.end - segment.start;
    if (segment.lane === "model" && ms >= 180_000) add({ kind: "long_think", severity: "info", at: segment.end,
      turn: segment.turn, title: "长时间思考", detail: "本段时间未运行工具，也未等待审批", value: ms, seq: segment.seq });
    if (segment.lane === "wait" && ms >= 60_000) add({ kind: "approval_wait", severity: "warn", at: segment.end,
      turn: segment.turn, title: segment.status === "running" ? "等待审批中" : "审批等待较久", detail: segment.label, value: ms, seq: segment.seq });
  }
  for (const tool of tools.filter(tool => tool.lane === "edit" && tool.added + tool.removed >= 80)
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || b.seq - a.seq).slice(0, 2)) {
    add({ kind: "big_edit", severity: "info", at: toolAt(tool), turn: tool.turn, title: "大改动",
      detail: `${tool.path || tool.target || tool.name} +${tool.added} −${tool.removed}`, value: tool.added + tool.removed, seq: tool.seq });
  }
  for (const tool of tools) {
    if (tool.git && tool.status === "ok") add({ kind: "git", severity: "good", at: toolAt(tool), turn: tool.turn,
      title: tool.git, detail: tool.command, value: null, seq: tool.seq });
    if (tool.lane === "agent") add({ kind: "subagent", severity: "info", at: toolAt(tool), turn: tool.turn,
      title: tool.status === "failed" ? "子任务失败" : tool.status === "canceled" ? "子任务已中断" : tool.status === "running" ? "子任务执行中" : "子任务完成",
      detail: tool.target || tool.name, value: duration(tool), seq: tool.seq });
  }

  if (tokens && turns.length >= 3 && tokenTotal(tokens.totals) > 0) {
    const heavy = [...turns].filter(turn => turn.tokens).sort((a, b) => tokenTotal(b.tokens!) - tokenTotal(a.tokens!) || b.start - a.start)[0];
    if (heavy) {
      const share = Math.min(1, tokenTotal(heavy.tokens!) / tokenTotal(tokens.totals));
      if (share >= 0.35) add({ kind: "token_heavy", severity: "warn", at: heavy.end ?? factsByTurn.get(heavy.index)?.end ?? heavy.start,
        turn: heavy.index, title: `第 ${heavy.index} 轮用掉 ${Math.round(share * 100)}% 的 Token`, detail: heavy.prompt,
        value: share, seq: reference(factsByTurn.get(heavy.index)?.seq) });
    }
  }
  return result.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.at - a.at || (b.seq ?? -1) - (a.seq ?? -1)).slice(0, 30);
}
