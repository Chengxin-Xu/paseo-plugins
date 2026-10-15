import { t } from "../shared/text";
import { deferOffer, isOnItsWay, type DeferredView } from "../shared/deferred-rpc";
import type { ComposerNote } from "../shared/composer";
import { contentKey, newMessageId, type Consent } from "./send-plan";

/**
 * 「等这一轮结束再发」 and sending now, on the client. The server's ledger (server/deferred-send.ts, kit) owns every
 * message to the agent and sends it; this decides what the picker draws and when it asks again.
 */

/** While a message is on its way and the app is in front, the list is read again this often; otherwise never. */
export const DEFERRED_POLL_MS = 5_000;
export function deferredPollInterval(views: readonly Pick<DeferredView, "state">[] | undefined, foreground: boolean): number | false {
  return foreground && !!views?.some(isOnItsWay) ? DEFERRED_POLL_MS : false;
}

/** How long an outcome stays after this app first saw it: 已送达 / 已取消 briefly, the ones to look at longer. */
export const OUTCOME_SHOWN_MS: Record<Exclude<DeferredView["state"], "queued" | "held" | "sending">, number> = { sent: 12_000, canceled: 6_000, "maybe-sent": 45_000, discarded: 45_000, expired: 45_000 };

const SEEN_LIMIT = 400;
/** When this app first saw each message in each outcome (`id:state`), shared by every picker. */
const firstSeen = new Map<string, number>();

/** Messages on their way, and outcomes for a while after this app first saw them; `until` is when the next one goes. */
export function visibleDeferred(views: readonly DeferredView[], now = Date.now(), seen: Map<string, number> = firstSeen): { views: DeferredView[]; until: number | null } {
  const shown: DeferredView[] = [];
  let until: number | null = null;
  for (const view of views) {
    if (view.state === "queued" || view.state === "held" || view.state === "sending") { shown.push(view); continue; }
    const key = `${view.messageId}:${view.state}`;
    let first = seen.get(key);
    if (first === undefined) {
      first = now; seen.set(key, now);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value!);
    }
    const end = first + OUTCOME_SHOWN_MS[view.state];
    if (end > now) { shown.push(view); until = until === null ? end : Math.min(until, end); }
  }
  return { views: shown, until };
}

/** The key of a prompt's text (its source line names the note, so another note's prompt differs). */
export function promptKey(text: string): string { return contentKey(["notes", text]); }

/** Stable identity across display languages, compatible with keys already written by Chinese-only versions. */
export function notePromptKey(note: Pick<ComposerNote, "id" | "title">, body: string): string {
  // i18n-ignore: Legacy persisted-key encoding, never displayed or sent; changing it would bypass duplicate protection.
  const identity = `来源：手记 #${note.id}\n${note.title}${body ? `\n\n${body}` : ""}`;
  return promptKey(identity);
}

const UNANSWERED_LIMIT = 200;
/** Sends and queueings of a prompt whose reply never came back, by agent and prompt key, with their id. */
const unanswered = new Map<string, string>();
const requestSlot = (agentId: string, key: string) => `${agentId}\n${key}`;

/**
 * The id of this prompt's send or queueing whose reply never came back, if there is one (review r3-F5, r4-F2). It may
 * have reached the server, so every next try (send or wait, from any picker, or a confirmation shown before it) asks
 * for that id, and the ledger answers with what became of it instead of sending a second copy. The request is settled
 * by a reply, or by the picker taking its record from the server's list (`settleRequest`).
 */
export function unansweredId(agentId: string, key: string): string | null {
  return unanswered.get(requestSlot(agentId, key)) ?? null;
}
/** The id of a send or queueing of this prompt: the unanswered one's, else a new one. */
export function requestId(agentId: string, key: string): string {
  return unansweredId(agentId, key) ?? newMessageId();
}
/** A request's reply was lost: the next try of the same prompt asks for its id. */
export function rememberUnanswered(agentId: string, key: string, messageId: string): void {
  const slot = requestSlot(agentId, key);
  unanswered.delete(slot);
  unanswered.set(slot, messageId);
  if (unanswered.size > UNANSWERED_LIMIT) unanswered.delete(unanswered.keys().next().value!);
}
/** The server replied: its reply is the record from now on, and another send is a new request. */
export function settleRequest(agentId: string, key: string): void {
  unanswered.delete(requestSlot(agentId, key));
}

/** This prompt's newest record for the agent: one on its way first, else the newest outcome; null when there is none. */
export function promptRecord(views: readonly DeferredView[] | undefined, agentId: string, key: string): DeferredView | null {
  let newest: DeferredView | null = null;
  for (const view of views ?? []) {
    if (view.agentId !== agentId || view.key !== key) continue;
    if (isOnItsWay(view)) return view;
    if (!newest || view.at > newest.at) newest = view;
  }
  return newest;
}

/** 「等这一轮结束再发」 next to the server's confirmation, which lists the approvals a send would cancel. */
export function confirmOffer(consent: Pick<Consent, "approvals">): { label: string; note: string } | null {
  return deferOffer({ pendingPermissions: consent.approvals.length }, { kind: "confirm" });
}

/** How a copy of this prompt already on its way (or sent moments ago) is named in a toast. */
export function onItsWayLabel(view: Pick<DeferredView, "state">): string {
  if (view.state === "held") return t("deferred.heldState");
  if (view.state === "sending") return t("deferred.sendingState");
  if (isOnItsWay(view)) return t("deferred.queuedState");
  return view.state === "maybe-sent" ? t("deferred.maybeSentState") : t("deferred.sentState");
}
