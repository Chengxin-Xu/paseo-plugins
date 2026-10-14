// Compatibility fixture: original project-notes 0.9.0 source from e98ce93 (MIT).
import { z } from "zod";

/**
 * Board data shapes, shared by the plugin, its RPC contracts (shared/board.ts) and the CLI (server/cli.ts).
 * Only zod: the CLI bundle is built on install with production dependencies, without the Paseo SDK.
 */
export const INBOX_PROJECT_ID = "__inbox__";
/** The inbox has no folder. Where a project shows its path, the inbox shows this, in the RPCs, the dashboard and the CLI. */
export const INBOX_DESCRIPTION = "暂不归入项目的想法";
/** Longest note body, in UTF-16 code units (what `string.length` and zod count). */
export const BODY_MAX_LENGTH = 32000;
/** Largest board file. Writes beyond it are refused; a board file over it (edited by hand) is left out of the overview. */
export const BOARD_FILE_LIMIT_BYTES = 32 * 1024 * 1024;
/**
 * Most board bytes one overview reply carries. The reply is one WebSocket frame, about the size of the boards it carries;
 * over the relay it travels as base64 ciphertext (4/3 of that), and the host closes a client's socket once its outbound
 * queue would pass 64 MiB. 32 MiB of boards is about 43 MiB there, which leaves room for the rest of the traffic.
 */
export const OVERVIEW_LIMIT_BYTES = 32 * 1024 * 1024;
export const kindSchema = z.enum(["task", "prompt", "idea"]);
export const statusSchema = z.enum(["todo", "doing", "done"]);
export const fieldsSchema = z.object({
  kind: kindSchema,
  title: z.string().trim().min(1, "请填写标题").max(160),
  body: z.string().max(BODY_MAX_LENGTH),
  status: statusSchema,
  priority: z.enum(["normal", "high"]),
  pinned: z.boolean(),
});
export const noteVersionSchema = fieldsSchema.extend({
  revision: z.number().int().positive(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export const itemSchema = fieldsSchema.extend({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(512),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  history: z.array(noteVersionSchema).max(10).optional(),
});
export const snapshotSchema = z.object({
  projectId: z.string(),
  revision: z.number().int().nonnegative(),
  items: z.array(itemSchema),
});
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});
/**
 * A board the overview left out instead of failing: `file` when the board alone is over BOARD_FILE_LIMIT_BYTES, `total`
 * when it would push the reply past OVERVIEW_LIMIT_BYTES (it still reads and writes on its own). `projectId` is null when
 * the plugin cannot tell whose board it is (a removed project whose board it never read).
 */
export const unavailableBoardSchema = z.object({
  projectId: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  reason: z.enum(["file", "total"]),
});
export const dashboardSchema = z.object({
  projects: z.array(projectSchema),
  boards: z.array(snapshotSchema),
  unavailable: z.array(unavailableBoardSchema).optional(),
});
/**
 * `revision` is a content hash of the whole dashboard. Sending the last one back returns
 * `{ unchanged: true }` when nothing changed, or only the boards (and project list) that
 * changed since that revision. An unknown revision gets the full dashboard. Every reply
 * with data carries the full `unavailable` list; older servers leave it out.
 */
export const dashboardUpdateSchema = z.union([
  z.object({ unchanged: z.literal(true), revision: z.string() }),
  dashboardSchema.partial({ projects: true }).extend({
    unchanged: z.literal(false).optional(), revision: z.string().optional(),
    mode: z.enum(["full", "delta"]).optional(), baseRevision: z.string().optional(),
    removedProjectIds: z.array(z.string()).optional(),
  }),
]);
export const writeBoardInputSchema = z.object({
  projectId: z.string().min(1).max(512),
  requestId: z.string().min(8).max(160),
  operation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), fields: fieldsSchema }),
    z.object({
      type: z.literal("update"), id: z.string().uuid(), expectedRevision: z.number().int().positive(),
      fields: fieldsSchema.partial(),
    }),
    z.object({ type: z.literal("delete"), id: z.string().uuid(), expectedRevision: z.number().int().positive() }),
    z.object({ type: z.literal("restore"), id: z.string().uuid(), expectedRevision: z.number().int().positive() }),
    z.object({ type: z.literal("restoreVersion"), id: z.string().uuid(), expectedRevision: z.number().int().positive(), revision: z.number().int().positive() }),
  ]),
});
export type NoteKind = z.infer<typeof kindSchema>;
export type TaskStatus = z.infer<typeof statusSchema>;
export type NoteFields = z.infer<typeof fieldsSchema>;
export type BoardItem = z.infer<typeof itemSchema>;
export type BoardSnapshot = z.infer<typeof snapshotSchema>;
export type BoardProject = z.infer<typeof projectSchema>;
export type DashboardSnapshot = z.infer<typeof dashboardSchema>;
export type DashboardUpdate = z.infer<typeof dashboardUpdateSchema>;
export type UnavailableBoard = z.infer<typeof unavailableBoardSchema>;
export type WriteBoardInput = z.infer<typeof writeBoardInputSchema>;
