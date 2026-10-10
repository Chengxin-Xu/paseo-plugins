/**
 * 待回复: does an Agent's final reply hand the next step to the user? Used by the server when a turn ends and by its
 * backfill for turns the hooks missed. Only the resulting boolean is stored, never the reply text.
 */
import { string, type TimelineItem, type TimelineRow } from "./timeline";

/** Items a turn can close with after its final message without changing what that message says. */
const TRAILING = new Set(["reasoning", "todo", "notification", "compaction", "plugin"]);

/** The turn's closing assistant message (consecutive chunks joined), or null when it ended on a tool call, an error or nothing. */
export function finalReplyText(items: readonly TimelineItem[]): string | null {
  let index = items.length - 1;
  while (index >= 0 && TRAILING.has(items[index].type)) index--;
  const parts: string[] = [];
  for (; index >= 0 && items[index].type === "assistant_message"; index--) parts.unshift(string(items[index].text));
  return parts.join("").trim() || null;
}

/** The final reply in a projected timeline tail, if it answers the user message sent at `userAt` (epoch ms). */
export function finalReplyAfter(rows: readonly TimelineRow[], userAt: number): { at: string; text: string } | null {
  let index = rows.length - 1;
  while (index >= 0 && TRAILING.has(rows[index].item.type)) index--;
  const last = rows[index];
  if (!last || last.item.type !== "assistant_message") return null;
  const parts: string[] = [];
  for (; index >= 0 && rows[index].item.type === "assistant_message"; index--) parts.unshift(string(rows[index].item.text));
  const at = Date.parse(last.timestamp), text = parts.join("").trim();
  return text && Number.isFinite(at) && at >= userAt ? { at: new Date(at).toISOString(), text } : null;
}

// An explicit request for something only the user can give: a decision, a confirmation, output, credentials, a go-ahead.
const REQUEST = /(请你?|麻烦你?|烦请|劳烦)(再|先|帮忙)?(确认|选择|选一下|决定|回复|提供|告诉我|发给我|贴给我|批准|审批|授权|登录|看一下|看看)|(告诉|通知|发给|贴给|回复|转给)我|等你(的|来|先)?(确认|决定|回复|拍板|提供|消息|反馈|同意|指示|批准|选择)|由你(来)?(决定|定|选择|拍板)|你(来|自己)?(决定|定夺|拍板)|需要你(先|来|去|帮忙)?(确认|决定|提供|选择|处理|批准|审批|登录|操作|授权|回复|补充|拍板)|\b(send me|let me know|tell me|please (confirm|choose|decide|provide|reply|share|approve|review))\b|\byour call\b|\bup to you\b/i;
// A question addressed to the user or offering the next step (rhetorical questions answered in place do not count).
const ASK = /要不要|需不需要|用不用|是否|要我|需要我|我(来|可以|先|再|就|直接|帮你)|可以吗|行吗|好吗|对吗|同意吗|怎么(处理|办|选|定)|如何(处理|选择)|哪(个|种|一|些|边)|还是|你|您|\b(should|shall|would|do|does|can|could|will|want|which|whether)\b/i;

/** The prose the reply closes with: its last paragraph, plus the one before when the last is only a link line or a sign-off. */
function closingText(text: string): string {
  const body = text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    .replace(/`[^`\n]*`/g, "代码")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/「[^」\n]*」|“[^”\n]*”|"[^"\n]*"/g, "引文");
  const blocks = body.split(/\n\s*\n/)
    .map(block => block.split("\n").filter(line => line.trim() && !/^\s*(#{1,6}\s|\||[-*_]{3,}\s*$)/.test(line)).join("\n").trim())
    .filter(Boolean);
  let tail = blocks.at(-1) ?? "";
  if (blocks.length > 1 && tail.replace(/[\s\p{P}\p{S}]/gu, "").length < 30) tail = `${blocks.at(-2)}\n${tail}`;
  return tail.slice(-800);
}

export function replyAsksUser(text: string): boolean {
  const tail = closingText(text);
  if (!tail) return false;
  if (REQUEST.test(tail)) return true;
  const sentences = tail.split(/(?<=[。！!？?；;])|\n/).map(sentence => sentence.trim()).filter(Boolean);
  const questions = sentences.filter(sentence => /[？?][)）」"”]*$/.test(sentence));
  if (!questions.length) return false;
  return questions.includes(sentences.at(-1)!) || questions.some(question => ASK.test(question));
}
