import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ConsentSchema } from "./deferred-rpc";

/**
 * Send a one-tap prompt through the plugin's send ledger. The server reads the note again and sends its text like the
 * prompt picker: steered into a turn that takes it, sent to an idle agent, otherwise answered "confirm" (with the
 * consent it would need) until `consent` covers what the send would do; `wait` queues it for 「等这一轮结束再发」. A prompt
 * with variables ("template") or one that is gone ("missing") never goes out. `message` says what happened, in the
 * plugin's language: a notice for sent, sending, existing and queued, otherwise why nothing went out.
 */
export const quickSendRpc = defineRpc({
  name: "project-notes.quick.send",
  input: z.object({ agentId: z.string().min(1).max(200), projectId: z.string().min(1).max(512), itemId: z.string().uuid(), messageId: z.string().min(8).max(100), consent: ConsentSchema.nullable().optional(), wait: z.boolean().optional() }),
  output: z.object({
    status: z.enum(["sent", "sending", "existing", "queued", "held", "confirm", "template", "missing", "busy", "gone", "refused"]),
    message: z.string(),
    consent: ConsentSchema.optional(),
  }),
});
export type QuickSendResult = z.infer<typeof quickSendRpc.output>;
