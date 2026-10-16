import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { deferredSendContracts } from "./deferred-rpc";
import { BODY_MAX_LENGTH, itemSchema } from "./schema";

export { composerAttachmentsRpc, composerCapabilitiesRpc, notesAttachmentSource } from "./composer-boot";
export { quickNoteFields } from "./quick-note";

export const composerSearchRpc = defineRpc({
  name: "project-notes.composer.search",
  input: z.object({ query: z.string().max(300), promptsOnly: z.boolean().default(true) }),
  output: z.object({ items: z.array(itemSchema.extend({ projectName: z.string() })), truncated: z.boolean(), unavailable: z.number() }),
});
/** 「等这一轮结束再发」: a prompt the agent cannot take now waits in this plugin's queue (server/deferred-send.ts, kit). */
export const notesDeferred = deferredSendContracts("project-notes");
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
