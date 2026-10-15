import { t } from "./text";
import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";
import { deferredSendContracts } from "./deferred-rpc";
import { BODY_MAX_LENGTH, itemSchema } from "./schema";

export const composerSearchRpc = defineRpc({
  name: "project-notes.composer.search",
  input: z.object({ query: z.string().max(300), promptsOnly: z.boolean().default(true) }),
  output: z.object({ items: z.array(itemSchema.extend({ projectName: z.string() })), truncated: z.boolean(), unavailable: z.number() }),
});
export const composerAttachmentsRpc = defineRpc({
  name: "project-notes.composer.attachments",
  input: z.object({ query: z.string().max(300) }),
  output: PluginAttachmentSearchPayloadSchema,
});
export const composerCapabilitiesRpc = defineRpc({
  name: "project-notes.composer.capabilities", input: z.object({}),
  output: z.object({ steerableProviders: z.array(z.string()), slashSteerableProviders: z.array(z.string()), bases: z.record(z.string(), z.string()).optional() }),
});
/** 「等这一轮结束再发」: a prompt the agent cannot take now waits in this plugin's queue (server/deferred-send.ts, kit). */
export const notesDeferred = deferredSendContracts("project-notes");
export const notesAttachmentSource = () => defineAttachmentSource({
  id: "notes", title: t("boot.attachmentTitle"), icon: "NotebookPen", pickerTitle: t("boot.attachmentPickerTitle"), searchPlaceholder: t("boot.attachmentSearchPlaceholder"), search: composerAttachmentsRpc,
});
export type ComposerNote = z.infer<typeof composerSearchRpc.output>["items"][number];

/** Values are inserted once, literally; a value containing another placeholder is never reinterpreted. */
const variablePattern = /\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g;
export function templateVariables(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(variablePattern), match => match[1]!.trim()).filter(Boolean))];
}
export function interpolateTemplate(template: string, values: Readonly<Record<string, string>>) {
  const missing = templateVariables(template).filter(name => !Object.hasOwn(values, name) || !values[name]!.trim());
  const text = template.replace(variablePattern, (original, name: string) => Object.hasOwn(values, name.trim()) ? values[name.trim()]! : original);
  return { text, missing, tooLong: text.length > BODY_MAX_LENGTH };
}
export function noteContext(note: Pick<ComposerNote, "id" | "title" | "body">, body = note.body) {
  return t("composer.noteContext", { id: note.id, title: note.title, body: body ? `\n\n${body}` : "" });
}
export function quickNoteFields(text: string) {
  const body = text.trim();
  if (!body) throw new Error(t("boot.quickNoteEmpty"));
  if (body.length > BODY_MAX_LENGTH) throw new Error(t("boot.quickNoteTooLong", { count: BODY_MAX_LENGTH }));
  return { kind: "idea" as const, title: body.split(/\r?\n/)[0]!.slice(0, 160), body, status: "todo" as const, priority: "normal" as const, pinned: false };
}
