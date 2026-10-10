import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const restoreSessionResultSchema = z.object({
  status: z.enum(["restored", "already_active", "needs_native", "failed"]),
  agentId: z.string(), workspaceId: z.string().nullable(), workspaceRestored: z.boolean(),
  workspaceAction: z.enum(["unarchive", "restore"]).nullable(), message: z.string(),
});
export type RestoreSessionResult = z.infer<typeof restoreSessionResultSchema>;
export const restoreSession = defineRpc({
  name: "observatory.history.restore", input: z.object({ agentId: z.string().min(1).max(512) }),
  output: restoreSessionResultSchema,
});
export const sessionEvidenceSchema = z.object({
  agentId: z.string(), turns: z.number(), tools: z.number(), toolFailures: z.number(), errors: z.number(),
  firstTimelineAt: z.string().nullable(), lastTimelineAt: z.string().nullable(), sampleSize: z.number(),
  complete: z.boolean(), hasOlder: z.boolean(), coverageReason: z.string().nullable(),
  completionEvidence: z.object({ kind: z.enum(["attention_finished", "none"]), at: z.string().nullable() }),
});
export type SessionEvidence = z.infer<typeof sessionEvidenceSchema>;
export const getSessionEvidence = defineRpc({
  name: "observatory.history.evidence", input: z.object({ agentId: z.string().min(1).max(512) }),
  output: sessionEvidenceSchema,
});
