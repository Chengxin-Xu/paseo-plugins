import type { QuickSendResult } from "../shared/quick-send";
import type { QuickConsent } from "./quick-pills";

/** One press of a one-tap pill: which prompt to which agent, and what the user agreed to (「等…再发」 is `wait`). */
export type QuickRequest = { agentId: string; projectId: string; itemId: string; wait?: boolean; consent?: QuickConsent };
/**
 * What the pills do with the answer. `unconfirmed` words a send whose answer never came back: it may have gone out.
 * `notSent` words a press that never reached the server (the chunk did not load).
 */
export type QuickHooks = { notice(message: string): void; confirm(consent: QuickConsent): void; template(): void; unconfirmed(error: string): string; notSent(error: string): string };
export type QuickSend = (request: QuickRequest, hooks: QuickHooks) => Promise<void>;
/** What quick-chunk.client.tsx gives the resident stub once it is loaded. */
export type QuickActions = { quickSend: QuickSend; captureNote(text: string): Promise<unknown> };
type SendInput = { agentId: string; projectId: string; itemId: string; messageId: string; consent: QuickConsent | null; wait?: boolean };

const WENT = ["sent", "sending", "existing", "queued"];
const newMessageId = () => (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ?? `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * The send half of the one-tap pills, loaded with the first press (quick-chunk.client.tsx), so the resident stub keeps
 * only the registration. The plugin server sends through its ledger and answers in the plugin's language: a notice when
 * the prompt went (or is going) out, otherwise an error the host shows. A send whose answer never came back may have
 * gone out: the message says to check, and the next press asks about the same message ID instead of sending another.
 * That ID lives only as long as this connection (no persistence): after a reconnect a press sends anew once the
 * ledger's 10 s duplicate window has passed, which the message says too.
 */
export function createQuickSender(rpc: (input: SendInput) => Promise<QuickSendResult>): QuickSend {
  const unanswered = new Map<string, string>();
  // Promise chains rather than async: the host compiles async functions into a much longer generator form.
  return (request, hooks) => {
    const slot = `${request.agentId}\n${request.projectId}:${request.itemId}`, messageId = unanswered.get(slot) ?? newMessageId();
    return rpc({ agentId: request.agentId, projectId: request.projectId, itemId: request.itemId, messageId, consent: request.consent ?? null, ...(request.wait ? { wait: true } : {}) }).then(result => {
      unanswered.delete(slot);
      if (WENT.includes(result.status)) return hooks.notice(result.message);
      // Nothing went out: the prompt has variables now, or the agent became busy since the pill was drawn.
      if (result.status === "template") hooks.template();
      if (result.status === "confirm" && result.consent) hooks.confirm({ ...result.consent, turn: result.consent.turn ?? null });
      throw new Error(result.message);
    }, (error: unknown) => {
      unanswered.delete(slot); unanswered.set(slot, messageId);
      if (unanswered.size > 100) unanswered.delete(unanswered.keys().next().value!);
      throw new Error(hooks.unconfirmed(error instanceof Error ? error.message.slice(0, 300) : String(error)));
    });
  };
}
