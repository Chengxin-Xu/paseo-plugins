import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import type { FoldIndexInput, FoldIndexOutput, WireRow } from "../shared/fold-index";
import { reasoningKey } from "../shared/fold";
import { foldRuntime } from "./fold-runtime";
import { fingerprint, observeBoundary, transformReasoning, transformToolCall } from "./transform";

let time = 5_000_000;
const timers = new Map<number, { at: number; run: () => void }>();
let handles = 0;
let nudges = 0;
const index: WireRow[] = [];
foldRuntime.configure({
  rpc: async (input: FoldIndexInput): Promise<FoldIndexOutput> => ({
    status: "ok",
    epoch: "e",
    rows: input.direction === "tail" ? index : [],
    startCursor: { epoch: "e", seq: 1 },
    endCursor: { epoch: "e", seq: 99 },
    hasOlder: false,
    hasNewer: false,
    reset: false,
    running: false,
  }),
  nudge: () => void nudges++,
  now: () => time,
  setTimer: (run, ms) => {
    timers.set(++handles, { at: time + ms, run });
    return handles;
  },
  clearTimer: (handle) => void timers.delete(handle as number),
});
async function advance(ms: number) {
  const end = time + ms;
  for (;;) {
    for (let step = 0; step < 8; step++) await Promise.resolve();
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    time = due[1].at;
    due[1].run();
  }
  time = end;
}

const call = (callId: string, detail: ToolCallDetail, status: "running" | "completed" | "failed" = "completed", extra: Record<string, unknown> = {}) => ({
  type: "tool_call" as const,
  callId,
  name: detail.type === "shell" ? "Bash" : "Read",
  detail,
  status,
  error: status === "failed" ? { message: "boom" } : null,
  ...extra,
}) as Parameters<typeof transformToolCall>[0]["item"];
const kindsOf = (result: ReturnType<typeof transformToolCall>) => result?.items.map((item) => item.kind);

describe("timeline transforms with folding", () => {
  it("hides folded rows entirely, puts the summary on the first row, and expands on request", async () => {
    const a = call("fold-a", { type: "shell", command: "npm test" });
    const b = call("fold-b", { type: "read", filePath: "src/a.ts" });
    const c = call("fold-c", { type: "shell", command: "npm run lint" });
    for (const item of [a, b, c]) expect(kindsOf(transformToolCall({ item, phase: "complete" }))).toEqual(["colorful-tool-call"]);
    index.push(
      { s: 1, at: 1000, k: "b", w: "user_message" },
      { s: 2, at: 2000, k: "t", key: "t:fold-a", st: "completed", look: "shell" },
      { s: 3, at: 3000, k: "t", key: "t:fold-b", st: "completed", look: "read" },
      { s: 4, at: 4000, k: "t", key: "t:fold-c", st: "completed", look: "shell" },
      { s: 5, at: 9000, k: "b", w: "assistant_message" },
    );
    foldRuntime.acquire("agent-fold");
    await advance(1_000);
    expect(nudges).toBe(1);
    const summary = transformToolCall({ item: a, phase: "complete" });
    expect(summary?.items).toEqual([
      {
        type: "plugin",
        kind: "vivid-fold",
        version: 1,
        data: { segment: "2", mode: "done", expanded: false, steps: 3, hidden: 3, counts: [["shell", 2], ["read", 1]], failed: 0, canceled: 0, durationMs: 3000 },
      },
    ]);
    expect(transformToolCall({ item: b, phase: "complete" })).toEqual({ items: [] });
    // A row that is still running never disappears, whatever a lagging index says.
    expect(kindsOf(transformToolCall({ item: { ...c, status: "running" } as typeof c, phase: "streaming" }))).toEqual(["colorful-tool-call"]);
    foldRuntime.toggle("agent-fold", "2", true);
    await advance(0);
    expect(nudges).toBe(2);
    expect(kindsOf(transformToolCall({ item: a, phase: "complete" }))).toEqual(["vivid-fold", "colorful-tool-call"]);
    expect(kindsOf(transformToolCall({ item: b, phase: "complete" }))).toEqual(["colorful-tool-call"]);
    foldRuntime.release("agent-fold");
  });

  it("folds a foreground task notice into its command and draws a background one as 后台任务", () => {
    const bash = call("note-bash", { type: "shell", command: "npm ls" });
    transformToolCall({ item: bash, phase: "complete" });
    const notice = (label: string, callId: string, ref = "note-bash") =>
      ({
        type: "tool_call",
        callId,
        name: "task_notification",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label, icon: "wrench", text: label },
        metadata: { synthetic: true, source: "claude_task_notification", toolUseId: ref, taskId: "b9", outputFile: "/tmp/b9.output" },
      }) as unknown as Parameters<typeof transformToolCall>[0]["item"];
    expect(transformToolCall({ item: notice("列出项目依赖", "task_notification_fg"), phase: "complete" })).toEqual({ items: [] });
    // The same foreground notice whose command Paseo never loaded stays visible.
    expect(kindsOf(transformToolCall({ item: notice("列出项目依赖", "task_notification_orphan", "unknown-call"), phase: "complete" }))).toEqual(["colorful-tool-call"]);
    const background = transformToolCall({ item: notice('Background command "构建" completed (exit code 0)', "task_notification_bg"), phase: "complete" });
    expect(background?.items[0]?.data).toMatchObject({
      name: "task_notification",
      notice: { text: "后台命令「构建」已完成（退出码 0）", background: true, taskId: "b9", outputFile: "/tmp/b9.output" },
      presentation: { category: "shell", icon: "SquareTerminal", label: "Background Task", summary: "后台命令「构建」已完成（退出码 0）" },
    });
  });

  it("reuses the transform of a finished row and redoes it when the row changes", () => {
    const item = call("memo-1", { type: "shell", command: "ls", output: "a\nb" });
    const first = transformToolCall({ item, phase: "complete" });
    expect(transformToolCall({ item: { ...item }, phase: "complete" })).toBe(first);
    const changed = transformToolCall({ item: { ...item, detail: { type: "shell", command: "ls", output: "a\nb\nc" } } as typeof item, phase: "complete" });
    expect(changed).not.toBe(first);
    expect(fingerprint({ a: "x".repeat(40), b: [1, 2], c: { d: { e: 1 } } })).toBe(`{a=40:${"x".repeat(24)}${"x".repeat(8)};b=[1,2];c={d=o1}}`);
    const reasoning = transformReasoning({ item: { type: "reasoning", text: "先读文件" }, phase: "complete" });
    expect(transformReasoning({ item: { type: "reasoning", text: "先读文件" }, phase: "complete" })).toBe(reasoning);
    expect(reasoning?.items[0]?.data).toMatchObject({ fold: reasoningKey("先读文件") });
  });

  it("only watches boundary items, never claims them", () => {
    expect(observeBoundary()).toBeUndefined();
  });
});
