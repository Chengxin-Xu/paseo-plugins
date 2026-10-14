import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { dashboardUpdateSchema, noteVersionSchema, projectSchema, snapshotSchema, writeBoardInputSchema } from "./schema";

export * from "./schema";

export const projectsRpc = defineRpc({
  name: "project-notes.projects",
  input: z.object({}),
  output: z.object({ projects: z.array(projectSchema) }),
});
export const readBoardRpc = defineRpc({
  name: "project-notes.read",
  input: z.object({ projectId: z.string().min(1).max(512) }),
  output: snapshotSchema,
});
export const readDashboardRpc = defineRpc({
  name: "project-notes.dashboard",
  input: z.object({ revision: z.string().max(128).optional(), refreshProjectIds: z.array(z.string().min(1).max(512)).max(4000).optional() }),
  output: dashboardUpdateSchema,
});
export const writeBoardRpc = defineRpc({
  name: "project-notes.write",
  input: writeBoardInputSchema,
  output: z.object({ board: snapshotSchema, itemId: z.string(), replayed: z.boolean() }),
});

/** Full historical bodies are requested only when the detail view opens them. */
export const readHistoryRpc = defineRpc({
  name: "project-notes.history",
  input: z.object({ projectId: z.string().min(1).max(512), itemId: z.string().uuid() }),
  output: z.object({ versions: z.array(noteVersionSchema), missing: z.boolean().default(false), missingCount: z.number().int().nonnegative().default(0), itemRevision: z.number().int().positive() }),
});
