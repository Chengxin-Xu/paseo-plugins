import { describe, expect, it } from "vitest";
import { reasoningKey } from "./fold";
import {
  claimsToolCall,
  exceedsTextBudget,
  foldIndexRpc,
  hostToolDisposition,
  indexRowFromWire,
  MAX_CLASSIFY_CHARS,
  toolLook,
  wirePageFromEntries,
  wireRowFromEntry,
} from "./fold-index";

const entry = (seqStart: number, item: Record<string, unknown>, provider = "claude", timestamp = "2026-10-09T10:00:00.000Z") => ({
  provider,
  item,
  timestamp,
  seqStart,
  seqEnd: seqStart,
  sourceSeqRanges: [],
  collapsed: [],
});
const call = (name: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "tool_call",
  callId: `toolu_${name}`,
  name,
  status: "completed",
  error: null,
  detail,
  ...extra,
});
const at = Date.parse("2026-10-09T10:00:00.000Z");

describe("fold index rows", () => {
  it("reduces messages and cards to boundaries and keys reasoning by its text", () => {
    expect(wireRowFromEntry(entry(1, { type: "user_message", text: "hi" }))).toEqual({ s: 1, at, k: "b", w: "user_message" });
    expect(wireRowFromEntry(entry(2, { type: "reasoning", text: "先读文件" }))).toEqual({ s: 2, at, k: "r", key: reasoningKey("先读文件") });
    expect(wireRowFromEntry(entry(3, { type: "plugin", pluginId: "paseo-bots", kind: "proposal" }))).toMatchObject({ k: "b", w: "plugin" });
    expect(wireRowFromEntry(entry(4, { type: "todo", items: [] }))).toMatchObject({ k: "b", w: "todo" });
    expect(wireRowFromEntry({ item: { type: "assistant_message" } })).toBeNull();
    expect(wireRowFromEntry(entry(5, { type: "assistant_message", text: "x" }, "claude", "bogus"))).toMatchObject({ at: 0 });
  });

  it("keeps the tool look, status and call id, and leaves plans and spoken messages to Paseo", () => {
    expect(wireRowFromEntry(entry(6, call("Bash", { type: "shell", command: "npm test" }, { status: "failed" })))).toEqual({
      s: 6, at, k: "t", key: "t:toolu_Bash", st: "failed", look: "shell",
    });
    expect(wireRowFromEntry(entry(7, call("Read", { type: "read", filePath: "src/a.ts" })))).toMatchObject({ look: "read" });
    expect(wireRowFromEntry(entry(8, call("ExitPlanMode", { type: "plan", text: "## plan" })))).toMatchObject({ k: "b", w: "plan" });
    expect(wireRowFromEntry(entry(9, call("speak", { type: "unknown", input: "你好" })))).toMatchObject({ k: "b", w: "speak" });
    expect(claimsToolCall({ name: "speak", detail: { type: "unknown", input: "  " } })).toBe(true);
  });

  it("mirrors how Paseo turns task-list tools into task rows or drops them", () => {
    const todos = { type: "unknown", input: { todos: [{ content: "补测试", status: "pending" }] } };
    expect(hostToolDisposition("claude", { name: "TodoWrite", detail: todos })).toBe("task");
    expect(hostToolDisposition("claude", { name: "TodoWrite", detail: { type: "unknown", input: {} } })).toBe("skip");
    expect(hostToolDisposition("codex", { name: "TodoWrite", detail: { type: "unknown", input: {} } })).toBeNull();
    expect(hostToolDisposition("claude", { name: "TaskUpdate", detail: { type: "unknown", input: {} } })).toBe("skip");
    expect(hostToolDisposition("codex", { name: "update_plan", detail: { type: "unknown", input: { plan: [{ step: "a", status: "pending" }] } } })).toBe("task");
    expect(hostToolDisposition("claude", { name: "Bash", detail: { type: "shell" } })).toBeNull();
    // Paseo compares the literal built-in id: a custom provider extending claude keeps these as ordinary tool rows.
    expect(hostToolDisposition("my-claude", { name: "TaskUpdate", detail: { type: "unknown", input: {} } })).toBeNull();
    expect(hostToolDisposition("my-claude", { name: "TodoWrite", detail: todos })).toBe("task");
    expect(wireRowFromEntry(entry(10, call("TodoWrite", todos)))).toMatchObject({ k: "b", w: "task" });
    expect(wireRowFromEntry(entry(11, call("TaskCreate", { type: "unknown", input: {} })))).toMatchObject({ k: "x" });
  });

  it("marks task notices: a foreground repeat of its command, or a background command", () => {
    const fg = call("task_notification", { type: "plain_text", label: "列出项目依赖", icon: "wrench" }, {
      callId: "task_notification_1",
      metadata: { synthetic: true, source: "claude_task_notification", toolUseId: "toolu_Bash" },
    });
    expect(wireRowFromEntry(entry(12, fg))).toEqual({ s: 12, at, k: "t", key: "t:task_notification_1", st: "completed", look: "shell", ref: "toolu_Bash", fg: true });
    const bg = { ...fg, detail: { type: "plain_text", label: 'Background command "构建" completed (exit code 0)' } };
    expect(wireRowFromEntry(entry(13, bg))).toMatchObject({ fg: false, ref: "toolu_Bash" });
  });

  it("draws apply_patch as edits", () => {
    const patch = "*** Begin Patch\n*** Add File: docs/a.md\n+# a\n*** End Patch";
    expect(toolLook({ name: "apply_patch", detail: { type: "unknown", input: { patch }, output: null } } as never)).toBe("write");
  });

  it("counts a tool call too big to classify as other, without parsing it (0.4.1)", () => {
    const over = "x".repeat(MAX_CLASSIFY_CHARS);
    const mcp = (input: unknown) => call("mcp__github__search_code", { type: "unknown", input, output: null });
    const small = wireRowFromEntry(entry(30, mcp(JSON.stringify({ query: "TODO" }))));
    expect(small).toMatchObject({ k: "t", key: "t:toolu_mcp__github__search_code" });
    expect(small?.look).not.toBe("other");
    expect(wireRowFromEntry(entry(31, mcp(JSON.stringify({ query: over }))))).toMatchObject({ k: "t", key: "t:toolu_mcp__github__search_code", look: "other" });
    // Text in the output and in the metadata counts too.
    expect(wireRowFromEntry(entry(32, call("Bash", { type: "shell", command: "ls", output: over })))).toMatchObject({ look: "other" });
    expect(wireRowFromEntry(entry(33, call("Bash", { type: "shell", command: "ls" }, { metadata: { log: over } })))).toMatchObject({ look: "other" });
    // Ordinary large calls are far below it: a 300 000-character read stays a read.
    expect(wireRowFromEntry(entry(34, call("Read", { type: "read", filePath: "src/big.ts", content: "y".repeat(300_000) })))).toMatchObject({ look: "read" });
    // Task rows and dropped rows are still told apart however big the call is.
    expect(wireRowFromEntry(entry(35, call("TaskCreate", { type: "unknown", input: { subject: over } })))).toMatchObject({ k: "x" });
  });

  it("measures text with a budget and stops as soon as it is spent", () => {
    expect(exceedsTextBudget("abc", 4)).toBe(false);
    expect(exceedsTextBudget("abc", 3)).toBe(true);
    expect(exceedsTextBudget({ a: [1, null, "xy"] }, 10)).toBe(false);
    expect(exceedsTextBudget({ a: [1, null, "xy"] }, 6)).toBe(true);
    expect(exceedsTextBudget(undefined, 0)).toBe(true);
    const values = Array.from({ length: 2_000_000 }, () => 0);
    const started = performance.now();
    expect(exceedsTextBudget(values, 1_000)).toBe(true);
    expect(exceedsTextBudget({ huge: "z".repeat(10_000_000) }, 1_000)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("keeps seqEnd only when the entry was updated after it began", () => {
    expect(wireRowFromEntry({ ...entry(20, call("Bash", { type: "shell", command: "ls" })), seqEnd: 23 })).toMatchObject({ s: 20, e: 23 });
    expect(indexRowFromWire({ s: 20, e: 23, at: 1, k: "b", w: "x" })).toMatchObject({ seq: 20, seqEnd: 23 });
    expect(indexRowFromWire({ s: 20, at: 1, k: "b", w: "x" }).seqEnd).toBeUndefined();
  });

  it("tells each row's turn through a small table, with the starts the server knows", () => {
    const turned = (seq: number, item: Record<string, unknown>, turnId?: string) => ({ ...entry(seq, item), ...(turnId ? { turnId } : {}) });
    const { rows, turns } = wirePageFromEntries(
      [
        turned(1, { type: "user_message", text: "hi" }, "foreground-turn-1"),
        turned(2, { type: "reasoning", text: "a" }, "foreground-turn-1"),
        turned(3, { type: "reasoning", text: "b" }, "autonomous-turn-2"),
        turned(4, { type: "assistant_message", text: "c" }),
        { bogus: true },
      ],
      (turnId) => (turnId === "autonomous-turn-2" ? 5_000 : null),
    );
    expect(turns).toEqual([{ id: "foreground-turn-1", at: null }, { id: "autonomous-turn-2", at: 5_000 }]);
    expect(rows.map((row) => row.u)).toEqual([0, 0, 1, undefined]);
    expect(rows.map((row) => indexRowFromWire(row, turns).turn)).toEqual(["foreground-turn-1", "foreground-turn-1", "autonomous-turn-2", undefined]);
    const parsed = foldIndexRpc.output.parse({ status: "missing", epoch: "", rows: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, reset: false, running: null, turns, active: { id: "autonomous-turn-2", at: null } });
    expect(parsed.active).toEqual({ id: "autonomous-turn-2", at: null });
  });

  it("round-trips through the RPC schema", () => {
    const rows = [
      wireRowFromEntry(entry(1, { type: "user_message", text: "hi" }))!,
      wireRowFromEntry(entry(2, call("Bash", { type: "shell", command: "ls" })))!,
    ];
    const parsed = foldIndexRpc.output.parse({ status: "ok", epoch: "e1", rows, startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: 3 }, hasOlder: false, hasNewer: false, reset: false, running: true });
    expect(parsed.rows.map((row) => indexRowFromWire(row))).toEqual([
      { seq: 1, at, kind: "boundary", what: "user_message" },
      { seq: 2, at, kind: "tool", key: "t:toolu_Bash", status: "completed", look: "shell" },
    ]);
    expect(indexRowFromWire({ s: 3, at: 0, k: "t", key: "t:n", st: "completed", look: "shell", ref: "r", fg: true }).notice).toEqual({ ref: "r", foreground: true });
    expect(indexRowFromWire({ s: 4, at: 0, k: "x", w: "hidden-tool" }).kind).toBe("skip");
  });
});
