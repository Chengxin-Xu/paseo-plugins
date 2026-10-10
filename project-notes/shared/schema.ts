import { z } from "zod";

/**
 * Board data shapes, shared by the plugin, its RPC contracts (shared/board.ts) and the CLI (server/cli.ts).
 * Only zod: the CLI bundle is built on install with production dependencies, without the Paseo SDK.
 */
export const INBOX_PROJECT_ID = "__inbox__";
export const kindSchema = z.enum(["task", "prompt", "idea"]);
export const statusSchema = z.enum(["todo", "doing", "done"]);
export const fieldsSchema = z.object({
  kind: kindSchema,
  title: z.string().trim().min(1, "请填写标题").max(160),
  body: z.string().max(32000),
  status: statusSchema,
  priority: z.enum(["normal", "high"]),
  pinned: z.boolean(),
});
export const itemSchema = fieldsSchema.extend({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(512),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
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
export const dashboardSchema = z.object({
  projects: z.array(projectSchema),
  boards: z.array(snapshotSchema),
});
/**
 * `revision` is a content hash of the whole dashboard. Sending the last one back returns
 * `{ unchanged: true }` when nothing changed, or only the boards (and project list) that
 * changed since that revision. An unknown revision gets the full dashboard.
 */
export const dashboardUpdateSchema = z.union([
  z.object({ unchanged: z.literal(true), revision: z.string() }),
  dashboardSchema.partial({ projects: true }).extend({ unchanged: z.literal(false).optional(), revision: z.string().optional() }),
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
export type WriteBoardInput = z.infer<typeof writeBoardInputSchema>;
