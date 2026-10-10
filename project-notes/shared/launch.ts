import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const optionSchema = z.object({ id: z.string(), label: z.string() });
const modelSchema = optionSchema.extend({
  isDefault: z.boolean(), thinkingOptions: z.array(optionSchema), defaultThinkingOptionId: z.string().nullable(),
});
const providerSchema = z.object({
  id: z.string(), label: z.string(), status: z.string(), error: z.string().nullable(),
  models: z.array(modelSchema), modes: z.array(optionSchema), defaultModeId: z.string().nullable(),
});
const launchProjectSchema = z.object({ id: z.string(), name: z.string(), path: z.string(), kind: z.string() });
const profileSchema = z.object({
  id: z.string(), name: z.string(), provider: z.string(), model: z.string().nullable(),
  modeId: z.string().nullable(), thinkingOptionId: z.string().nullable(),
});
export const launchOptionsRpc = defineRpc({
  name: "project-notes.launch-options",
  input: z.object({ projectId: z.string().max(512).optional() }),
  output: z.object({ projects: z.array(launchProjectSchema), project: launchProjectSchema.nullable(), providers: z.array(providerSchema), profiles: z.array(profileSchema) }),
});
export const launchInputSchema = z.object({
  launchId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
  sourceProjectId: z.string().min(1).max(512),
  itemId: z.string().uuid(),
  projectId: z.string().min(1).max(512),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(32500),
  isolation: z.enum(["local", "worktree"]),
  baseBranch: z.string().trim().max(200).optional(),
  profileId: z.string().max(512).nullable().optional(),
  provider: z.string().min(1).max(512),
  model: z.string().min(1).max(512),
  modeId: z.string().max(256).nullable().optional(),
  thinkingOptionId: z.string().max(256).nullable().optional(),
});
export const launchReceiptSchema = z.object({
  launchId: z.string(),
  stage: z.enum(["prepared", "creating_workspace", "workspace_ready", "creating_agent", "agent_ready", "sending", "started", "rejected", "uncertain"]),
  workspaceId: z.string().nullable(), agentId: z.string().nullable(),
  error: z.string().nullable(), replayed: z.boolean(),
});
export const launchRpc = defineRpc({ name: "project-notes.launch", input: launchInputSchema, output: launchReceiptSchema });
export const launchStatusRpc = defineRpc({
  name: "project-notes.launch-status", input: z.object({ launchId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/) }),
  output: launchReceiptSchema.nullable(),
});
export type LaunchOptions = z.infer<typeof launchOptionsRpc.output>;
export type LaunchInput = z.infer<typeof launchInputSchema>;
export type LaunchReceipt = z.infer<typeof launchReceiptSchema>;
