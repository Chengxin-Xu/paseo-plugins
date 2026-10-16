import assert from "node:assert/strict";
import test from "node:test";
import { aiReply, mergeRecaps, recapLook, type RecapView } from "../shared/recap";
import { QUICK_REPLIES, quickReplyText } from "../shared/reply";
import { answering, isSendRefused, outgoingMessage, sameRound, sendChecked, type AgentState, type SendHooks } from "../client/send-check";
import { quickReplyGroup, quickReplyGuard, quickReplyKey } from "../client/deferred-state";
import { BUILTIN_SEND } from "../shared/steer";
import { ledgerHost } from "./ledger-host";

const START = "2026-10-15T01:00:00.000Z", END = "2026-10-15T01:05:00.000Z";
const view = (patch: Partial<RecapView> = {}): RecapView => ({ agentId: "a", summary: "拆分存储层：已拆出并通过测试", next: "改调用方", reply: "继续改调用方", at: "2026-10-15T01:06:00.000Z",
  roundAt: START, endedAt: END, stale: false, state: "idle", runner: "Grok 4.7 · low", ...patch });

test("a recap is fresh only for the turn a screen shows; otherwise it is out of date and offers no reply", () => {
  const turn = { startedAt: START, endedAt: END, running: false };
  assert.deepEqual(recapLook(view(), turn), { summary: "拆分存储层：已拆出并通过测试", next: "改调用方", reply: "继续改调用方", at: "2026-10-15T01:06:00.000Z", runner: "Grok 4.7 · low", state: "fresh" });
  // Instants, not spellings: the same moment in another zone is the same turn.
  assert.equal(recapLook(view({ roundAt: "2026-10-15T09:00:00+08:00" }), turn)?.state, "fresh");
  for (const [label, look] of [
    ["the server saw a turn start since", recapLook(view({ stale: true, reply: null }), turn)],
    ["another turn is shown", recapLook(view(), { ...turn, startedAt: "2026-10-15T02:00:00.000Z" })],
    ["the shown turn ended later (a heartbeat round)", recapLook(view(), { ...turn, endedAt: "2026-10-15T02:10:00.000Z" })],
    ["a turn runs now", recapLook(view(), { ...turn, running: true })],
  ] as const) assert.deepEqual([look?.state, look?.reply], ["stale", null], label);
  // A new one is being written: the old text stays, marked updating, without its reply.
  assert.deepEqual([recapLook(view({ state: "generating" }), turn)?.state, recapLook(view({ state: "pending" }), turn)?.reply], ["updating", null]);
  // The first one, still being written; nothing at all otherwise.
  assert.deepEqual(recapLook(view({ summary: null, next: null, reply: null, at: null, state: "pending" }), turn), { summary: null, next: null, reply: null, at: null, runner: "Grok 4.7 · low", state: "updating" });
  assert.equal(recapLook(view({ summary: null, state: "idle" }), turn), null);
  assert.equal(recapLook(undefined, turn), null);
  // The badge's popover knows when the turn started, not when it ended.
  assert.equal(recapLook(view(), { startedAt: START })?.state, "fresh");
  // Neither side knows the turn (no record): the same unknown turn.
  assert.equal(recapLook(view({ roundAt: null, endedAt: null }), { startedAt: null, endedAt: null })?.state, "fresh");
  assert.equal(recapLook(view({ roundAt: null }), { startedAt: START })?.state, "stale", "unsure is not the same turn");
});

test("an unchanged list keeps every recap object, so rows that did not change do not draw again", () => {
  const first = mergeRecaps(undefined, { mode: "full", revision: "r1", enabled: true, suggestions: true, recaps: [view(), view({ agentId: "b" })] });
  assert.equal(first.busy, false);
  const unchanged = mergeRecaps(first, { mode: "unchanged", revision: "r1" });
  assert.equal(unchanged.byAgent, first.byAgent);
  const next = mergeRecaps(first, { mode: "full", revision: "r2", enabled: true, suggestions: true, recaps: [view(), view({ agentId: "b", state: "generating" })] });
  assert.equal(next.byAgent.get("a"), first.byAgent.get("a"), "a did not change");
  assert.notEqual(next.byAgent.get("b"), first.byAgent.get("b"));
  assert.equal(next.busy, true, "one is being written: read sooner");
});

test("the AI suggestion is one more quick reply, sent word for word, unless it says what a rule button already sends", () => {
  const rules = QUICK_REPLIES["go-ahead"];
  const ai = aiReply("先跑测试再提交", rules)!;
  assert.deepEqual(ai, { key: "ai", text: "先跑测试再提交", tone: "fuchsia", icon: "Sparkles", rearm: true, ai: true });
  assert.equal(quickReplyText(ai), "先跑测试再提交", "no sentence mark added: the model wrote it the user's way");
  assert.equal(quickReplyText(rules[0]!), "继续，按你说的做。");
  // Normalized equality only: case, width, spaces and punctuation aside.
  for (const same of ["继续，按你说的做", "继续,按你说的做。", " 先别动！", "先 别 动"]) assert.equal(aiReply(same, rules), null, same);
  assert.equal(aiReply("Continue", QUICK_REPLIES["keep-going"])?.text, "Continue", "different words stay");
  assert.equal(aiReply("ＯＫ，继续做完", [{ key: "x", text: "ok 继续做完", tone: "green", icon: "Play", rearm: true }]), null, "full-width and case fold");
  assert.equal(aiReply(null, rules), null);
  assert.equal(aiReply("  ", rules), null);
  assert.equal(aiReply("。。。", []), null, "nothing but punctuation");
});

// The AI suggestion answers the same turn as the rule buttons: same group (one reply of the turn goes out, on any device) and
// the same guard, checked by the server under the Agent's lock right before it goes out.
const finished: AgentState = { provider: "my-acp", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-15T01:05:00.000Z",
  lastUserMessageAt: "2026-10-15T00:58:00.000Z", activeTurn: null, pendingPermissions: [] };
const PROMPT = finished.lastUserMessageAt!, ROUND = START, LATER = "2026-10-15T03:00:00.000Z";
const bound = (text: string) => outgoingMessage("a", text, { what: "回复", source: `AI 建议「${text}」`, key: quickReplyKey(text, PROMPT, ROUND), group: quickReplyGroup(PROMPT, ROUND), guard: quickReplyGuard(PROMPT, ROUND) });
const bindings = (): SendHooks => ({ expect: answering(PROMPT, "整理发布说明"), precheck: sameRound(async () => ROUND, ROUND, "整理发布说明") });

test("an AI suggestion shares its turn's group: tapped on two devices with a rule reply, one goes out and the other is answered with it", async () => {
  const fake = await ledgerHost(finished);
  fake.observe(ROUND);
  try {
    const opening = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { open, opened }; };
    const both = opening(), first = opening(), second = opening();
    let waiting = 0;
    // Both passed their checks on the turn they answer; their requests then wait in transit.
    const inTransit = (gate: ReturnType<typeof opening>): typeof fake.deliver => async input => { if (++waiting === 2) both.open(); await gate.opened; return fake.deliver(input); };
    const suggestion = bound(quickReplyText(aiReply("先跑测试再提交", [])!)), rule = bound(quickReplyText(QUICK_REPLIES["go-ahead"][0]!));
    const a = sendChecked(fake.client, suggestion, BUILTIN_SEND, inTransit(first), null, bindings());
    const b = sendChecked(fake.client, rule, BUILTIN_SEND, inTransit(second), null, bindings());
    await both.opened;
    first.open();
    const sent = await a;
    assert.ok("answered" in sent && sent.answered.status === "sent");
    second.open();
    const other = await b;
    assert.ok("answered" in other && other.answered.status === "existing", "the turn is answered already");
    assert.equal("answered" in other && other.answered.status === "existing" ? other.answered.view.messageId : null, suggestion.messageId, "named for the suggestion that went");
    assert.deepEqual(fake.delivered.map(item => item.text), ["先跑测试再提交"], "the rule reply never reached the new turn");
  } finally { await fake.close(); }
});

test("an AI suggestion for a turn the Agent has moved past is refused by the server, nothing sent", async () => {
  const fake = await ledgerHost(finished);
  fake.observe(ROUND);
  try {
    const suggestion = bound("先跑测试再提交");
    // A heartbeat round runs while the request is in transit: same prompt, a later round.
    const transit: typeof fake.deliver = async input => { fake.observe(LATER); return fake.deliver(input); };
    await assert.rejects(sendChecked(fake.client, suggestion, BUILTIN_SEND, transit, null, bindings()), isSendRefused);
    assert.deepEqual([fake.delivered, await fake.list()], [[], []]);
    // On the right turn it goes out as written.
    fake.observe(ROUND);
    const sent = await sendChecked(fake.client, bound("先跑测试再提交"), BUILTIN_SEND, fake.deliver, null, bindings());
    assert.ok("answered" in sent && sent.answered.status === "sent");
    assert.deepEqual(fake.delivered.map(item => item.text), ["先跑测试再提交"]);
  } finally { await fake.close(); }
});
