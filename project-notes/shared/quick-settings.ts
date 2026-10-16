import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { QUICK_LIMIT, QUICK_SETTINGS_ID, type QuickEntry } from "./quick";
import { itemSchema } from "./schema";

/** The one-tap prompt list as a host setting: what the host checks every save against. */
export const quickEntrySchema = z.object({
  projectId: z.string().min(1).max(512),
  itemId: z.string().uuid(),
  label: z.string().max(160).default(""),
  template: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /**
   * The note revision these fields describe. An app updates an entry from its own copy of the board only when that copy
   * is newer, so two apps with boards read at different moments never undo each other's change.
   */
  revision: z.number().int().nonnegative().default(0),
}) satisfies z.ZodType<QuickEntry, unknown>;

export const quickSettings = defineSettings({
  id: QUICK_SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: z.object({ prompts: z.array(quickEntrySchema).max(QUICK_LIMIT).default([]) }),
});

/** One prompt for the fill form a template pill opens; null once it is gone or no longer a prompt. */
export const quickNoteRpc = defineRpc({
  name: "project-notes.quick.note",
  input: z.object({ projectId: z.string().min(1).max(512), itemId: z.string().uuid() }),
  output: itemSchema.extend({ projectName: z.string() }).nullable(),
});
