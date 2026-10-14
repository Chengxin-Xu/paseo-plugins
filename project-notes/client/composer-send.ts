import type { PaseoApi } from "./paseo-types";
import { deferOffer, type DeferredSendResult } from "../shared/deferred-rpc";
import { confirmOffer } from "./deferred-state";
import { consentFor, newMessageId, sendPlan, usableTarget, type Consent, type SendPlan } from "./send-plan";

/**
 * One send of a prompt and what its confirmation agreed to. The plugin server sends (server/deferred-send.ts): it plans
 * again from the agent as it is and sends only while `consent` covers what that would do, else it asks again. Saying
 * yes repeats the same text and `messageId`. `offer`: 「等这一轮结束再发」 next to a confirmation.
 */
export type SendCheck = {
  plan: Pick<SendPlan, "kind" | "label" | "note" | "confirm">;
  consent: Consent | null;
  offer: { label: string; note: string } | null;
  text: string;
  messageId: string;
};
export type PromptCapabilities = { steerableProviders: readonly string[]; slashSteerableProviders?: readonly string[]; bases?: Readonly<Record<string, string>> };

/**
 * Read only this explicitly selected agent; never load timelines or inspect other agents. `messageId`: the id of this
 * send (the picker reuses one whose reply was lost). A confirmation agrees to what the plan does to the turn running
 * now, and to no turn that starts after it (review r3-F1).
 */
export async function checkPromptSend(paseo: PaseoApi, agentId: string, text: string, capabilities: PromptCapabilities, messageId = newMessageId()): Promise<SendCheck> {
  const response = await paseo.agents.ref(agentId).refresh();
  const agent = response?.agent;
  const target = usableTarget(agent) ? { ...agent, pendingPermissions: agent.pendingPermissions?.length ?? 0 } : null;
  const plan = sendPlan(target, {
    what: "提示词", text, steerable: capabilities.steerableProviders, slashSteerable: capabilities.slashSteerableProviders, bases: capabilities.bases,
  });
  const pendingIds = agent?.pendingPermissions?.map(permission => permission.id) ?? [];
  return { plan, consent: consentFor(plan, pendingIds, agent?.activeTurn), offer: deferOffer(target, plan), text, messageId };
}

/** The server's confirmation of a send: the same message again, with the consent it names. */
export function serverCheck(check: Pick<SendCheck, "text" | "messageId">, result: Extract<DeferredSendResult, { status: "confirm" }>): SendCheck {
  return { plan: { kind: "confirm", ...result.plan }, consent: result.consent, offer: confirmOffer(result.consent), text: check.text, messageId: check.messageId };
}

/** How the queue names a prompt: by its title, well inside the queue's 200-character limit. */
export function promptSource(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, " ").trim());
  if (!chars.length) return "提示词";
  return `提示词「${chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : chars.join("")}」`;
}
