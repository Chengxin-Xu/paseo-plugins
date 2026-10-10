import { describe, expect, it } from "vitest";
import {
  foldAccessibilityLabel,
  foldCountParts,
  foldTitle,
  formatFoldDuration,
  hashText,
  planFolds,
  reasoningKey,
  roleSignature,
  toolKey,
  type FoldOptions,
  type FoldRole,
  type IndexRow,
  type StepStatus,
} from "./fold";
import type { LookKey } from "./vivid-model";

const boundary = (seq: number, what = "assistant_message", at = seq * 1000): IndexRow => ({ seq, at, kind: "boundary", what });
const think = (seq: number, text = `思考 ${seq}`, at = seq * 1000): IndexRow => ({ seq, at, kind: "reasoning", key: reasoningKey(text) });
const tool = (seq: number, status: StepStatus = "completed", look: LookKey = "shell", extra: Partial<IndexRow> = {}): IndexRow => ({
  seq,
  at: seq * 1000,
  kind: "tool",
  key: toolKey(`call-${seq}`),
  status,
  look,
  ...extra,
});
const options = (overrides: Partial<FoldOptions> = {}): FoldOptions => ({ scope: "all", enabled: true, agentRunning: false, ...overrides });
const kinds = (roles: Map<string, FoldRole>, rows: IndexRow[]) => rows.map((row) => (row.key ? (roles.get(row.key)?.kind ?? "-") : "|"));
const summaryOf = (roles: Map<string, FoldRole>, row: IndexRow) => {
  const role = roles.get(row.key!);
  if (role?.kind !== "fold") throw new Error(`no summary on ${row.key}`);
  return role.summary;
};

describe("fold keys", () => {
  it("hashes text deterministically and keys reasoning by length and hash", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(reasoningKey("先读文件")).toBe(`r:4:${hashText("先读文件")}`);
    expect(reasoningKey("a")).not.toBe(reasoningKey("b"));
    expect(toolKey("toolu_1")).toBe("t:toolu_1");
  });

  it("signs roles so a changed summary needs drawing again", () => {
    expect(roleSignature({ kind: "show" })).toBe("s");
    expect(roleSignature({ kind: "hide" })).toBe("h");
    const summary = { segment: "4", mode: "done" as const, expanded: false, steps: 3, hidden: 3, counts: [["shell", 2], ["read", 1]] as Array<[LookKey, number]>, failed: 0, canceled: 0, durationMs: 4000 };
    expect(roleSignature({ kind: "fold", summary })).toBe(roleSignature({ kind: "fold", summary: { ...summary } }));
    expect(roleSignature({ kind: "fold", summary })).not.toBe(roleSignature({ kind: "fold", summary: { ...summary, expanded: true } }));
    expect(roleSignature({ kind: "fold", summary })).not.toBe(roleSignature({ kind: "fold", summary: { ...summary, steps: 4, hidden: 4 } }));
  });
});

describe("planFolds: finished segments", () => {
  it("splits at text, messages and cards, and folds each finished run into its first row", () => {
    const rows = [boundary(1, "user_message"), think(2), tool(3, "completed", "read"), tool(4), boundary(5), tool(6), tool(7, "completed", "edit"), tool(8), boundary(9, "todo")];
    const { roles, segments } = planFolds(rows, options());
    expect(kinds(roles, rows)).toEqual(["|", "fold", "hide", "hide", "|", "fold", "hide", "hide", "|"]);
    expect(segments.map((segment) => [segment.id, segment.mode, segment.sealed])).toEqual([["2", "done", true], ["6", "done", true]]);
    expect(summaryOf(roles, rows[1]!)).toEqual({
      segment: "2", mode: "done", expanded: false, steps: 3, hidden: 3,
      counts: [["think", 1], ["read", 1], ["shell", 1]], failed: 0, canceled: 0, durationMs: 3000,
    });
    expect(summaryOf(roles, rows[5]!).counts).toEqual([["shell", 2], ["edit", 1]]);
  });

  it("leaves a single row alone", () => {
    const rows = [boundary(1), tool(2), boundary(3)];
    expect(planFolds(rows, options()).roles.size).toBe(0);
  });

  it("folds failed rows too and counts them in red", () => {
    const rows = [boundary(1), tool(2), tool(3, "failed"), tool(4, "canceled"), boundary(5)];
    const { roles } = planFolds(rows, options());
    expect(kinds(roles, rows)).toEqual(["|", "fold", "hide", "hide", "|"]);
    expect(summaryOf(roles, rows[1]!)).toMatchObject({ steps: 3, failed: 1, canceled: 1 });
  });

  it("seals the trailing run when the agent has stopped, keeps it open while it runs", () => {
    const rows = [boundary(1), tool(2), tool(3), tool(4)];
    expect(kinds(planFolds(rows, options({ agentRunning: false })).roles, rows)).toEqual(["|", "fold", "hide", "hide"]);
    const running = planFolds(rows, options({ agentRunning: true }));
    expect(running.segments[0]).toMatchObject({ sealed: false, running: true });
    // Three settled rows: two stay, one is too few for 「前面 N 步」.
    expect(running.roles.size).toBe(0);
  });

  it("expands on request and remembers it per segment id", () => {
    const rows = [boundary(1), tool(2), tool(3), tool(4), boundary(5)];
    const { roles } = planFolds(rows, options({ expanded: (segment) => (segment === "2" ? true : undefined) }));
    expect(kinds(roles, rows)).toEqual(["|", "fold", "show", "show", "|"]);
    expect(summaryOf(roles, rows[1]!).expanded).toBe(true);
  });

  it("measures from the content before the run to its last row", () => {
    const rows = [boundary(1, "user_message", 10_000), tool(2, "completed", "shell", { at: 12_000 }), tool(3, "completed", "shell", { at: 95_000 }), boundary(4, "assistant_message", 96_000)];
    expect(summaryOf(planFolds(rows, options()).roles, rows[1]!).durationMs).toBe(85_000);
    // Nothing known before the run (the index starts inside it): no start, no duration.
    const truncated = [tool(2, "completed", "shell", { at: 12_000 }), tool(3, "completed", "shell", { at: 95_000 }), boundary(4)];
    expect(summaryOf(planFolds(truncated, options()).roles, truncated[0]!).durationMs).toBeNull();
    // A parallel call still running when the next one starts does not count as finished before it.
    const parallel = [
      boundary(1, "user_message", 10_000),
      tool(2, "completed", "shell", { seqEnd: 9, at: 40_000 }),
      tool(3, "completed", "shell", { seqEnd: 4, at: 20_000 }),
      boundary(10, "assistant_message", 41_000),
    ];
    expect(summaryOf(planFolds(parallel, options()).roles, parallel[1]!).durationMs).toBe(30_000);
  });

  it("ignores entries Paseo never shows", () => {
    const rows = [boundary(1), tool(2), { seq: 3, at: 3000, kind: "skip", what: "hidden-tool" } as IndexRow, tool(4), boundary(5)];
    expect(kinds(planFolds(rows, options()).roles, rows)).toEqual(["|", "fold", "|", "hide", "|"]);
  });

  it("does nothing when folding is off", () => {
    const rows = [boundary(1), tool(2), tool(3), tool(4), boundary(5)];
    expect(planFolds(rows, options({ enabled: false })).roles.size).toBe(0);
  });
});

describe("planFolds: running segments", () => {
  const run = (count: number, last: StepStatus = "running") => [
    boundary(1, "user_message"),
    ...Array.from({ length: count }, (_, index) => tool(2 + index, index === count - 1 ? last : "completed", index % 2 ? "read" : "shell")),
  ];

  it("keeps the running row and the two latest settled rows, folds the rest into 「前面 N 步」", () => {
    const rows = run(8);
    const { roles, segments } = planFolds(rows, options({ agentRunning: true }));
    expect(kinds(roles, rows)).toEqual(["|", "fold", "hide", "hide", "hide", "hide", "-", "-", "-"]);
    expect(segments[0]).toMatchObject({ mode: "earlier", running: true, anchor: rows[1]!.key });
    expect(summaryOf(roles, rows[1]!)).toMatchObject({ mode: "earlier", hidden: 5, steps: 8, failed: 0, durationMs: null });
    expect(foldTitle(summaryOf(roles, rows[1]!))).toBe("前面 5 步");
  });

  it("treats a run with a running row as live even when text follows it (parallel tools)", () => {
    const rows = [...run(6), boundary(20)];
    rows[2] = tool(3, "running");
    const { roles, segments } = planFolds(rows, options({ agentRunning: false }));
    expect(segments[0]).toMatchObject({ sealed: true, running: true, mode: "earlier" });
    expect(roles.get(rows[2]!.key!)).toBeUndefined();
  });

  it("never hides rows waiting for approval or failed rows", () => {
    const rows = run(7, "completed");
    rows[3] = tool(4, "failed");
    rows[7] = tool(8, "running");
    const waiting = new Set(["call-8"]);
    const { roles } = planFolds(rows, options({ agentRunning: true, waiting }));
    expect(roles.get(rows[3]!.key!)).toBeUndefined();
    expect(roles.get(rows[7]!.key!)).toBeUndefined();
    expect(summaryOf(roles, rows[1]!)).toMatchObject({ hidden: 3, failed: 0 });
  });

  it("needs at least two earlier steps before folding them", () => {
    const rows = run(4);
    expect(planFolds(rows, options({ agentRunning: true })).roles.size).toBe(0);
    expect(planFolds(run(5), options({ agentRunning: true })).roles.size).toBe(2);
  });

  it("shows every row of an expanded live run under its header", () => {
    const rows = run(8);
    const { roles } = planFolds(rows, options({ agentRunning: true, expanded: () => true }));
    expect(kinds(roles, rows)).toEqual(["|", "fold", "show", "show", "show", "show", "-", "-", "-"]);
  });
});

describe("planFolds: scope, notices, loaded rows and ambiguity", () => {
  it("in 仅思考行 folds only adjacent reasoning rows; Paseo's tool rows split them", () => {
    const rows = [boundary(1), think(2), tool(3), think(4), think(5), boundary(6)];
    const { roles } = planFolds(rows, options({ scope: "reasoning" }));
    expect(kinds(roles, rows)).toEqual(["|", "-", "-", "fold", "hide", "|"]);
  });

  it("folds a foreground task notice into its command, never counting it", () => {
    const rows = [boundary(1), tool(2), tool(3, "completed", "shell", { notice: { ref: "call-2", foreground: true } }), tool(4, "completed", "read"), boundary(5)];
    const { roles } = planFolds(rows, options({ enabled: false }));
    expect(kinds(roles, rows)).toEqual(["|", "-", "hide", "-", "|"]);
    const folded = planFolds(rows, options());
    expect(kinds(folded.roles, rows)).toEqual(["|", "fold", "hide", "hide", "|"]);
    expect(summaryOf(folded.roles, rows[1]!)).toMatchObject({ steps: 2, counts: [["shell", 1], ["read", 1]] });
  });

  it("keeps a background notice as its own row: folded with its run but not a step", () => {
    const rows = [boundary(1), tool(2), tool(3), tool(4, "completed", "shell", { notice: { ref: "call-0", foreground: false } }), boundary(5)];
    const { roles } = planFolds(rows, options());
    expect(kinds(roles, rows)).toEqual(["|", "fold", "hide", "hide", "|"]);
    expect(summaryOf(roles, rows[1]!).steps).toBe(2);
  });

  it("counts and anchors only rows Paseo has loaded", () => {
    const rows = [boundary(1), tool(2), tool(3), tool(4), tool(5), boundary(6)];
    const present = new Set([rows[3]!.key!, rows[4]!.key!]);
    const { roles } = planFolds(rows, options({ present: (key) => present.has(key) }));
    expect(kinds(roles, rows)).toEqual(["|", "hide", "hide", "fold", "hide", "|"]);
    expect(summaryOf(roles, rows[3]!).steps).toBe(2);
    present.delete(rows[4]!.key!);
    expect(planFolds(rows, options({ present: (key) => present.has(key) })).roles.get(rows[3]!.key!)?.kind).not.toBe("fold");
  });

  it("never hides or anchors on a key that appears twice or that another agent claims", () => {
    const rows = [boundary(1), think(2, "同一句"), tool(3), tool(4), think(5, "同一句"), boundary(6)];
    const { roles } = planFolds(rows, options());
    expect(kinds(roles, rows)).toEqual(["|", "-", "fold", "hide", "-", "|"]);
    expect(summaryOf(roles, rows[2]!).steps).toBe(2);
    const contested = planFolds([boundary(1), tool(2), tool(3), tool(4), boundary(5)], options({ contested: (key) => key === toolKey("call-2") }));
    expect(contested.roles.get(toolKey("call-2"))).toBeUndefined();
    expect(contested.roles.get(toolKey("call-3"))?.kind).toBe("fold");
  });
});

describe("planFolds: turns (0.3.0-local.3)", () => {
  const HOUR = 3_600_000;
  const inTurn = (row: IndexRow, turn: string, at = row.at): IndexRow => ({ ...row, turn, at });

  it("measures an autonomous turn from its own start, never from the previous turn's last reply", () => {
    // Turn 31 replied at 30 s; Claude Code woke up by itself an hour later with no user message.
    const rows = [
      inTurn(boundary(1, "user_message"), "foreground-turn-31", 10_000),
      inTurn(think(2), "foreground-turn-31", 12_000),
      inTurn(boundary(3), "foreground-turn-31", 30_000),
      inTurn(think(4), "autonomous-turn-32", HOUR + 33_000),
      inTurn(tool(5), "autonomous-turn-32", HOUR + 37_000),
      inTurn(boundary(6), "autonomous-turn-32", HOUR + 40_000),
    ];
    expect(summaryOf(planFolds(rows, options()).roles, rows[3]!).durationMs).toBeNull();
    const known = planFolds(rows, options({ turnStart: (turn) => (turn === "autonomous-turn-32" ? HOUR + 31_000 : null) }));
    expect(summaryOf(known.roles, rows[3]!).durationMs).toBe(6_000);
  });

  it("starts a new segment when a new turn begins without text in between", () => {
    // Turn 1 ended on a tool call (interrupted); turn 2 opened by itself much later.
    const rows = [
      inTurn(boundary(1, "user_message"), "foreground-turn-1", 1_000),
      inTurn(tool(2), "foreground-turn-1", 2_000),
      inTurn(tool(3), "foreground-turn-1", 3_000),
      inTurn(tool(4), "autonomous-turn-2", HOUR),
      inTurn(think(5), "autonomous-turn-2", HOUR + 1_000),
      inTurn(boundary(6), "autonomous-turn-2", HOUR + 2_000),
    ];
    const plan = planFolds(rows, options({ turnStart: () => HOUR - 500 }));
    expect(kinds(plan.roles, rows)).toEqual(["|", "fold", "hide", "fold", "hide", "|"]);
    expect(summaryOf(plan.roles, rows[1]!)).toMatchObject({ steps: 2, durationMs: 2_000 });
    expect(summaryOf(plan.roles, rows[3]!)).toMatchObject({ steps: 2, durationMs: 1_500 });
    expect(plan.segments.map((segment) => segment.sealed)).toEqual([true, true]);
  });

  it("without turn ids, hides a total over 30 minutes unless a row was seen running", () => {
    const rows = [boundary(1, "assistant_message", 1_000), tool(2, "completed", "shell", { at: HOUR }), tool(3, "completed", "shell", { at: HOUR + 1_000 }), boundary(4, "assistant_message", HOUR + 2_000)];
    expect(summaryOf(planFolds(rows, options()).roles, rows[1]!).durationMs).toBeNull();
    const seen = planFolds(rows, options({ witnessed: (key) => key === rows[1]!.key }));
    expect(summaryOf(seen.roles, rows[1]!).durationMs).toBe(HOUR);
  });
});

describe("fold texts", () => {
  it("formats durations in Chinese and drops sub-second ones", () => {
    expect(formatFoldDuration(null)).toBeNull();
    expect(formatFoldDuration(400)).toBeNull();
    expect(formatFoldDuration(12_400)).toBe("12 秒");
    expect(formatFoldDuration(80_000)).toBe("1 分 20 秒");
    expect(formatFoldDuration(120_000)).toBe("2 分");
    expect(formatFoldDuration(3_900_000)).toBe("1 小时 5 分");
    expect(formatFoldDuration(7_200_000)).toBe("2 小时");
    expect(formatFoldDuration(4_200)).toBe("4.2 秒");
  });

  it("names counts like the row titles and reads well to screen readers", () => {
    expect(foldCountParts([["think", 2], ["shell", 5], ["read", 3], ["bogus", 1], ["edit", 0]])).toEqual([
      { look: "think", text: "思考 2" },
      { look: "shell", text: "命令 5" },
      { look: "read", text: "读取 3" },
      { look: "other", text: "其他 1" },
    ]);
    const summary = { mode: "done" as const, steps: 12, hidden: 12, expanded: false, counts: [["think", 2], ["shell", 5]] as Array<[string, number]>, failed: 1, canceled: 0, durationMs: 80_000 };
    expect(foldAccessibilityLabel(summary)).toBe("展开 12 步：思考 2、命令 5，失败 1，用时 1 分 20 秒");
    expect(foldAccessibilityLabel({ ...summary, mode: "earlier", hidden: 7, expanded: true, failed: 0 })).toBe("收起 前面 7 步：思考 2、命令 5");
  });
});
