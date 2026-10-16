import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { insightRunnerSchema } from "./insights";
import { quickReplyText, type QuickReply } from "./reply";
import { foldFind } from "./timeline-find";

/**
 * 每轮小结 (turn summary) and 建议回复 (a suggested reply): after a top-level Agent's turn ends normally and it rests for about
 * ten seconds, a model writes one line about the goal and the progress, the next step, and optionally the message the user
 * is most likely to send next (server/recap.ts). Off on a new install; the switches and the model are host settings.
 */

/** How long a recap may be: what the model is asked for (characters for Chinese, Japanese and Korean, words otherwise), and what is kept. */
export const RECAP_LIMITS = { summaryCharacters: 25, nextCharacters: 12, summaryWords: 20, nextWords: 8, summaryStored: 300, nextStored: 120, replyStored: 60 } as const;
/** A recap's own default effort for the built-in Grok CLI: quick rather than deep (an analysis defaults to xhigh). */
export const RECAP_GROK_EFFORT = "low";

/**
 * The host setting `recap` (`$PASEO_HOME/plugin-settings/agent-observatory/recap.json`). `enabled`: write recaps (sends
 * conversation text to the chosen model); `suggestions`: also ask for the next message, shown as an AI-suggested reply;
 * `runner`: who writes them, the built-in Grok CLI (low effort unless set) or a profile or provider (a temporary sub-agent
 * per recap). `auto` is not offered here and runs as the Grok CLI.
 */
export const recapSettings = defineSettings({
  id: "recap",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(false),
    suggestions: z.boolean().default(false),
    runner: insightRunnerSchema.default({ kind: "grok" }),
  }),
});
export type RecapSettings = z.output<typeof recapSettings.schema>;
export const RECAP_DEFAULTS: RecapSettings = { enabled: false, suggestions: false, runner: { kind: "grok" } };

const id = z.string().min(1).max(256), revision = z.string().min(1).max(80), instant = z.iso.datetime().nullable();
/**
 * One Agent's recap as the list sends it. `summary` is null while its first one is being written. `roundAt` / `endedAt`:
 * when the plugin saw the turn it describes start and end, so a client tells whether it is about the turn it shows. `stale`:
 * a turn started since. `state`: `pending` (the quiet wait or the queue) and `generating` (the model is writing); a failure
 * leaves it `idle` and says nothing. `reply` only while the recap is current and suggestions are on.
 */
export const recapViewSchema = z.object({
  agentId: id,
  summary: z.string().max(RECAP_LIMITS.summaryStored * 2).nullable(),
  next: z.string().max(RECAP_LIMITS.nextStored * 2).nullable(),
  reply: z.string().max(RECAP_LIMITS.replyStored * 2).nullable(),
  at: instant,
  roundAt: instant,
  endedAt: instant,
  stale: z.boolean(),
  state: z.enum(["idle", "pending", "generating"]),
  /** Who wrote it ("Grok 4.7 · low", a profile's name …). */
  runner: z.string().max(160).nullable(),
});
export type RecapView = z.infer<typeof recapViewSchema>;
export const getRecaps = defineRpc({
  name: "observatory.recap.list",
  input: z.object({ revision: revision.optional() }),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("full"), revision, enabled: z.boolean(), suggestions: z.boolean(), recaps: z.array(recapViewSchema).max(400) }),
    z.object({ mode: z.literal("unchanged"), revision }),
  ]),
});
export type RecapAnswer = z.infer<typeof getRecaps.output>;
export type RecapList = Extract<RecapAnswer, { mode: "full" }>;

/**
 * For the settings: who writes recaps and whether it can now. `problem`: `grok` (no Grok CLI found), `runner` (the chosen
 * profile or provider cannot run; `reason` says why), `backoff` (recent runs failed: recaps pause until `until`).
 */
export const getRecapStatus = defineRpc({
  name: "observatory.recap.status",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(), suggestions: z.boolean(), runner: z.string().max(160), available: z.boolean(),
    problem: z.enum(["grok", "runner", "backoff"]).nullable(), reason: z.string().max(300).nullable(), until: instant,
    active: z.number().int().nonnegative(), queued: z.number().int().nonnegative(),
    lastAt: instant, lastOutcome: z.enum(["written", "failed", "skipped"]).nullable(),
  }),
});
export type RecapStatus = z.infer<typeof getRecapStatus.output>;

const time = (value: string | null | undefined) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
/** Two instants, either possibly missing: the same when both are missing or both name the same millisecond. */
export const sameInstant = (a: string | null | undefined, b: string | null | undefined) => time(a) === time(b);

/** What a screen draws for an Agent's recap: `fresh` (about the turn it shows), `stale` (a turn since) or `updating`. */
export interface RecapLook { summary: string | null; next: string | null; reply: string | null; at: string | null; runner: string | null; state: "fresh" | "stale" | "updating" }
/**
 * An Agent's recap against the turn a screen shows: when the plugin saw it start and end (`endedAt` left out where the screen
 * does not know it, the badge's popover) and whether a turn runs now. Only a fresh recap offers its suggested reply. Null:
 * nothing to draw.
 */
export function recapLook(view: RecapView | null | undefined, turn: { startedAt?: string | null; endedAt?: string | null; running?: boolean }): RecapLook | null {
  if (!view) return null;
  const updating = view.state !== "idle";
  if (!view.summary) return updating ? { summary: null, next: null, reply: null, at: null, runner: view.runner, state: "updating" } : null;
  const same = sameInstant(view.roundAt, turn.startedAt) && (turn.endedAt === undefined || sameInstant(view.endedAt, turn.endedAt));
  const fresh = !updating && !view.stale && same && !turn.running;
  return { summary: view.summary, next: view.next, reply: fresh ? view.reply : null, at: view.at, runner: view.runner, state: updating ? "updating" : fresh ? "fresh" : "stale" };
}

/** Text compared for sameness: case and width folded, spaces and punctuation set aside. */
const plainText = (text: string) => foldFind(text).replace(/[\s.,!?;:'"`~()[\]{}<>_-]+|[。，、！？；：…“”‘’「」『』（）【】《》]+/g, "");
/**
 * A recap's suggested reply as one more quick reply (AI 建议), sent word for word; null when there is none or it says what one
 * of the rule buttons already sends (compared as plain text, case, width, spaces and punctuation aside).
 */
export function aiReply(suggestion: string | null | undefined, rules: readonly QuickReply[]): QuickReply | null {
  const text = suggestion?.trim(), plain = text ? plainText(text) : "";
  if (!text || !plain || rules.some(rule => plainText(rule.text) === plain || plainText(quickReplyText(rule)) === plain)) return null;
  return { key: "ai", text, tone: "fuchsia", icon: "Sparkles", rearm: true, ai: true };
}

/** The host's recaps by Agent; `revision` is the server's, sent back so an unchanged list costs a few bytes. */
export interface RecapState { enabled: boolean; suggestions: boolean; revision: string; byAgent: ReadonlyMap<string, RecapView>; busy: boolean }

/** A full answer replaces the list, an unchanged one keeps it; an Agent whose recap did not change keeps the same object. */
export function mergeRecaps(previous: RecapState | undefined, answer: RecapAnswer): RecapState {
  if (answer.mode === "unchanged") return previous ? { ...previous, revision: answer.revision } : { enabled: false, suggestions: false, revision: answer.revision, byAgent: new Map(), busy: false };
  const byAgent = new Map<string, RecapView>();
  for (const view of answer.recaps) {
    const before = previous?.byAgent.get(view.agentId);
    byAgent.set(view.agentId, before && JSON.stringify(before) === JSON.stringify(view) ? before : view);
  }
  return { enabled: answer.enabled, suggestions: answer.suggestions, revision: answer.revision, byAgent, busy: answer.recaps.some(view => view.state !== "idle") };
}
