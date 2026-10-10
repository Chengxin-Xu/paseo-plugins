import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
export const readReceiptSchema = z.object({
  agentId: z.string().min(1).max(512), completionAt: timestamp,
  lastUserMessageAt: timestamp.nullable(), readAt: timestamp,
});
export type ReadReceipt = z.infer<typeof readReceiptSchema>;
export const archiveReadOriginSchema = z.object({
  agentId: z.string().min(1).max(512), archivedAt: timestamp, lastUserMessageAt: timestamp.nullable(),
});
export type ArchiveReadOrigin = z.infer<typeof archiveReadOriginSchema>;
export const markCompletionRead = defineRpc({
  name: "observatory.read-state.mark",
  input: z.object({ agentId: z.string().min(1).max(512), attentionTimestamp: timestamp, lastUserMessageAt: timestamp.nullable() }),
  output: z.object({ agentId: z.string(), status: z.enum(["read", "stale", "not_unread", "failed"]),
    receipt: readReceiptSchema.nullable(), message: z.string() }),
});
export type MarkCompletionReadInput = z.infer<typeof markCompletionRead.input>;
export type MarkCompletionReadResult = z.infer<typeof markCompletionRead.output>;
const revision = z.string().min(1).max(80);
const readReceiptsSnapshotSchema = z.object({ receipts: z.array(readReceiptSchema).max(2000), archiveOrigins: z.array(archiveReadOriginSchema).max(2000).default([]), error: z.string().nullable() });
/** A content revision; polling clients receive the receipts again only after they change. */
export const getReadReceipts = defineRpc({
  name: "observatory.read-state.list", input: z.object({ revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [
    readReceiptsSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
    z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
  ]),
});
export type ReadReceiptsSnapshot = z.infer<typeof readReceiptsSnapshotSchema>;
export type ReadReceiptsState = ReadReceiptsSnapshot & { revision?: string };
export type ReadReceiptsResponse = z.infer<typeof getReadReceipts.output>;
export function mergeReadReceipts(previous: ReadReceiptsState | undefined, response: ReadReceiptsResponse | ReadReceiptsSnapshot): ReadReceiptsState {
  if (!("mode" in response)) return response;
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return snapshot; }
  if (!previous) throw new Error("本地已读缓存已失效，正在重新读取。");
  return previous;
}
