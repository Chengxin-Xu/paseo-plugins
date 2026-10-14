import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { childSummaryRpc } from "../shared/child-summary";
import { childSummaryRow, handleChildSummary } from "./child-summary";

// fetch_agent records Paseo 0.11.1 itself builds: live (loaded, with `activeTurn`) and stored (not loaded).
const records = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/child-records-0.11.1.json"), "utf8")) as Record<string, Record<string, unknown>>;

/** A child whose record is live (loaded) unless `stored`; `fail` makes the status check throw. */
function fake(status: string | null = "running", archivedAt: string | null = null, options: { stored?: boolean; fail?: string } = {}) {
  const calls: unknown[] = [];
  const context = { paseo: { agents: { ref: (agentId: string) => {
    calls.push(agentId);
    return {
      refresh: async () => {
        if (options.fail) throw new Error(options.fail);
        return { agent: status ? { status, archivedAt, ...(options.stored ? {} : { activeTurn: null }) } : null };
      },
      timeline: { refetch: async (input: unknown) => {
        calls.push(input);
        return { agent: { status: "running" }, entries: Array.from({ length: 8 }, (_, n) => ({ seqStart: n, seqEnd: n, item: { type: "assistant_message", text: "运行中的摘要与较长输出 😀 ".repeat(2000) } })) };
      } },
    };
  } } } } as unknown as PluginHandlerContext;
  return { context, calls };
}

describe("compact child summaries", () => {
  it("returns only the three newest previews, with UTF-8 byte caps instead of full output or agent records", async () => {
    const { context, calls } = fake();
    const output = await handleChildSummary({ agentId: "child" }, context);
    expect(childSummaryRpc.output.parse(output)).toEqual(output);
    expect(output.rows.map((row) => row.k)).toEqual(["5", "6", "7"]);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(550);
    for (const row of output.rows) expect(Buffer.byteLength(row.x!)).toBeLessThanOrEqual(72);
    expect(calls).toEqual(["child", { direction: "tail", limit: 8, projection: "projected" }]);
  });

  it("caps a response containing three long tool summaries as a whole", async () => {
    const context = { paseo: { agents: { ref: () => ({
      refresh: async () => ({ agent: { status: "running", activeTurn: null } }),
      timeline: { refetch: async () => ({ entries: Array.from({ length: 3 }, (_, n) => ({
        seqStart: Number.MAX_SAFE_INTEGER - n, seqEnd: Number.MAX_SAFE_INTEGER,
        item: { type: "tool_call", callId: `long-${n}`, name: "Bash", status: "running", detail: { type: "shell", command: "命令和工具参数😀".repeat(100), output: "x".repeat(100_000) } },
      })) }) },
    }) } } } as unknown as PluginHandlerContext;
    const output = await handleChildSummary({ agentId: "child" }, context);
    expect(output.rows).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(500);
    expect(output.rows.every((row) => row.s === "running" && row.i && row.t)).toBe(true);
  });

  it("does not load closed, archived, missing or provider children automatically", async () => {
    for (const [status, archive] of [["closed", null], ["running", "2026-01-01"], [null, null]] as const) {
      const { context, calls } = fake(status, archive);
      const output = await handleChildSummary({ agentId: "child" }, context);
      expect(output.status).toBe(status === null ? "missing" : "closed");
      expect(calls).toEqual(["child"]);
    }
    const { context, calls } = fake();
    expect((await handleChildSummary({ agentId: "provider:parent:child", manual: true }, context)).status).toBe("missing");
    expect(calls).toEqual([]);
  });

  it("reads only a child whose record shows it loaded, whatever status a stored record kept (0.6.0, codex-F18)", async () => {
    // A daemon that went down leaves its Agents stored as running or idle: those are not loaded, and reading would load them.
    for (const name of ["storedRunning", "storedIdle", "storedClosed"]) {
      const record = records[name]!;
      const { context, calls } = fake(record.status as string, null, { stored: true });
      const output = await handleChildSummary({ agentId: "child" }, context);
      expect(output, name).toMatchObject({ status: "closed", agent: { status: "closed" }, rows: [] });
      expect(calls, name).toEqual(["child"]);
      expect((await handleChildSummary({ agentId: "child", statusOnly: true }, fake(record.status as string, null, { stored: true }).context)).agent, name).toEqual({ status: "closed" });
    }
    for (const name of ["liveRunning", "liveIdle"]) {
      const record = records[name]!;
      expect("activeTurn" in record).toBe(true);
      const { context, calls } = fake(record.status as string);
      expect((await handleChildSummary({ agentId: "child" }, context)).status, name).toBe("ok");
      expect(calls, name).toHaveLength(2);
    }
  });

  it("reads nothing by itself when the status check fails, and says so; the user's own read still goes ahead (0.6.0, grok-F9, pi-F2)", async () => {
    const failing = fake("running", null, { fail: "socket closed" });
    expect(await handleChildSummary({ agentId: "child" }, failing.context)).toEqual({ status: "unconfirmed", agent: null, rows: [] });
    expect(await handleChildSummary({ agentId: "child", statusOnly: true }, failing.context)).toEqual({ status: "unconfirmed", agent: null, rows: [] });
    expect(failing.calls).toEqual(["child", "child"]);
    const asked = fake("running", null, { fail: "socket closed" });
    expect((await handleChildSummary({ agentId: "child", manual: true }, asked.context)).rows).toHaveLength(3);
    expect(asked.calls).toHaveLength(2);
    // An Agent the daemon does not know is gone, not unconfirmed.
    expect((await handleChildSummary({ agentId: "child" }, fake("running", null, { fail: "Agent not found" }).context)).status).toBe("missing");
  });

  it("keeps the existing explicit read of a closed child and supports status-only checks", async () => {
    const closed = fake("closed");
    expect((await handleChildSummary({ agentId: "child", manual: true }, closed.context)).rows).toHaveLength(3);
    expect(closed.calls).toHaveLength(2);
    const active = fake();
    expect((await handleChildSummary({ agentId: "child", statusOnly: true }, active.context)).rows).toEqual([]);
    expect(active.calls).toHaveLength(1);
  });

  it("preserves the presentation for tools, tasks and notices without sending their bodies", () => {
    const items: AgentTimelineItem[] = [
      { type: "tool_call", callId: "a", name: "Bash", status: "running", detail: { type: "shell", command: "ls src", output: "x".repeat(20_000) } },
      { type: "todo", items: [{ text: "one", completed: true }] },
      { type: "error", message: "problem" },
      { type: "notification", level: "error", message: "failed" },
    ] as AgentTimelineItem[];
    const rows = items.map((item, n) => childSummaryRow({ seqStart: n, seqEnd: n, item }));
    for (const row of rows) expect(childSummaryRpc.output.shape.rows.element.safeParse(row).success).toBe(true);
    expect(rows[0]).toMatchObject({ s: "running", c: "shell" });
    expect(rows[1]).toMatchObject({ t: "任务", x: "已完成 1/1 项" });
    expect(rows[2]).toMatchObject({ c: "failed" });
    expect(rows[3]).toMatchObject({ c: "failed" });
    expect(JSON.stringify(rows)).not.toContain("x".repeat(100));
  });
});
