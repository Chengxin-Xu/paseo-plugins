import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Three display rows, with bounded text; tool outputs and Agent records stay on the daemon. */
export const childSummaryRowSchema = z.object({
  k: z.string().max(40),
  i: z.string().max(40),
  t: z.string().max(36),
  x: z.string().max(72).optional(),
  c: z.enum(["shell", "file", "search", "agent", "plan", "communication", "unknown", "reasoning", "failed"]),
  s: z.string().max(20).optional(),
});
export type ChildSummaryRow = z.output<typeof childSummaryRowSchema>;
export const childSummaryRpc = defineRpc({
  name: "child-summary",
  input: z.object({
    agentId: z.string().min(1).max(256),
    /** Explicit user action may load a closed child's history, as in 0.5.0. */
    manual: z.boolean().optional(),
    statusOnly: z.boolean().optional(),
  }),
  output: z.object({
    /** 0.6.0: unconfirmed: the daemon's status check failed, so whether the child is loaded is unknown and nothing was read. */
    status: z.enum(["ok", "missing", "closed", "unconfirmed"]),
    agent: z.object({ status: z.string().max(30) }).nullable(),
    rows: z.array(childSummaryRowSchema).max(3),
  }),
});
export type ChildSummaryInput = z.input<typeof childSummaryRpc.input>;
export type ChildSummaryOutput = z.output<typeof childSummaryRpc.output>;
