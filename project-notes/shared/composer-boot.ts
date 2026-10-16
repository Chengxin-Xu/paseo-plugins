import { t } from "./text";
import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

// The composer contracts the resident stub registers with: the attachment source and the providers' capabilities. The
// rest (search, the send ledger, the note schemas) is in composer.ts, which only lazy views and the server import.
export const composerAttachmentsRpc = defineRpc({
  name: "project-notes.composer.attachments",
  input: z.object({ query: z.string().max(300) }),
  output: PluginAttachmentSearchPayloadSchema,
});
export const composerCapabilitiesRpc = defineRpc({
  name: "project-notes.composer.capabilities", input: z.object({}),
  output: z.object({ steerableProviders: z.array(z.string()), slashSteerableProviders: z.array(z.string()), bases: z.record(z.string(), z.string()).optional() }),
});
export const notesAttachmentSource = () => defineAttachmentSource({
  id: "notes", title: t("boot.attachmentTitle"), icon: "NotebookPen", pickerTitle: t("boot.attachmentPickerTitle"), searchPlaceholder: t("boot.attachmentSearchPlaceholder"), search: composerAttachmentsRpc,
});
