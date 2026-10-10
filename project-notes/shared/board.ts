import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { dashboardUpdateSchema, projectSchema, snapshotSchema, writeBoardInputSchema } from "./schema";

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
  input: z.object({ revision: z.string().max(128).optional() }),
  output: dashboardUpdateSchema,
});
export const writeBoardRpc = defineRpc({
  name: "project-notes.write",
  input: writeBoardInputSchema,
  output: z.object({ board: snapshotSchema, itemId: z.string(), replayed: z.boolean() }),
});
