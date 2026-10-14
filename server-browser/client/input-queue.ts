import type { BrowserInputEvent, BrowserInputResult, BrowserTarget } from '../shared/browser';
import { sameTarget } from './input-target';

/** One piece of live input and the page context it was made on. `done` hears whether it reached the page. */
export type QueuedInput = { event: BrowserInputEvent; target: BrowserTarget; done?: (delivered: boolean) => void };
const MAX_BATCH = 64, MAX_TEXT = 10_000, MAX_SCROLL = 3000;
const clamp = (value: number) => Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, value));

/**
 * Long text in pieces the server takes (at most 10,000 UTF-16 units each), never splitting a character: an emoji or other
 * character outside the BMP is a surrogate pair, and its halves sent apart would arrive as two replacement characters.
 */
export function splitText(value: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + max);
    const high = value.charCodeAt(end - 1), low = value.charCodeAt(end);
    if (end < value.length && end - start > 1 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end--;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * The number of this viewer's next live input batch: above its own last one, and above inputSeqFloor, the highest batch of
 * viewers the server no longer remembers. A viewer it forgot (or a new one) is then still taken; its old batches are not.
 */
export function nextInputSeq(previous: number, session: { inputSeqFloor?: number } | null | undefined): number {
  return Math.max(previous, session?.inputSeqFloor ?? 0) + 1;
}

/** Append, folding typed text into the text before it and a wheel step into the scroll before it when both belong to the same page context. */
export function enqueueInput(queue: QueuedInput[], entry: QueuedInput): void {
  const tail = queue[queue.length - 1];
  if (tail && !tail.done && !entry.done && sameTarget(tail.target, entry.target)) {
    if (tail.event.kind === 'text' && entry.event.kind === 'text' && tail.event.text.length + entry.event.text.length <= MAX_TEXT) { tail.event = { kind: 'text', text: tail.event.text + entry.event.text }; return; }
    if (tail.event.kind === 'scroll' && entry.event.kind === 'scroll') { tail.event = { kind: 'scroll', deltaX: clamp(tail.event.deltaX + entry.event.deltaX), deltaY: clamp(tail.event.deltaY + entry.event.deltaY) }; return; }
  }
  queue.push(entry);
}

/** The next batch: the head and what follows it on the same page context, up to 64 events. A click only leads a batch: it needs its own picture. */
export function takeBatch(queue: QueuedInput[]): QueuedInput[] {
  if (!queue.length) return [];
  const head = queue[0];
  let count = 1;
  while (count < queue.length && count < MAX_BATCH && queue[count].event.kind !== 'click' && sameTarget(queue[count].target, head.target)) count++;
  return queue.splice(0, count);
}

/**
 * Apply the server's answer to a sent batch and to the input still waiting. A continuation carries the stream on to the
 * page context the server now reports; when the context ended, what was made for it is dropped, never moved to the new page.
 * `retry`: an Agent read was finishing; the batch is back at the front unchanged.
 */
export function settleBatch(queue: QueuedInput[], batch: QueuedInput[], result: Pick<BrowserInputResult, 'status' | 'applied' | 'continuation' | 'pending'>): { retry: boolean; dropped: QueuedInput[] } {
  if (!batch.length) return { retry: false, dropped: [] };
  if (result.status === 'busy') { queue.unshift(...batch); return { retry: true, dropped: [] }; }
  // A dialog that one of these events opened holds that event (pending): it reached the page and finishes once the dialog is
  // answered. Nothing after it runs, and a dialog that was already open stopped the batch before anything ran.
  const ran = Math.min(batch.length, result.applied + (result.status === 'blocked' && result.pending ? 1 : 0));
  for (const entry of batch.slice(0, ran)) entry.done?.(true);
  const sent = batch[0].target, dropped = batch.slice(ran);
  const continuation = result.status === 'applied' ? result.continuation : null;
  for (let index = 0; index < queue.length;) {
    const entry = queue[index];
    if (!sameTarget(entry.target, sent)) { index++; continue; }
    if (continuation) { entry.target = { ...entry.target, inputScope: continuation }; index++; }
    else dropped.push(...queue.splice(index, 1));
  }
  for (const entry of dropped) entry.done?.(false);
  return { retry: false, dropped };
}

/** Everything still waiting is dropped (the outcome of a request is unknown, or the panel closes): nothing is replayed. */
export function dropAll(queue: QueuedInput[]): QueuedInput[] {
  const dropped = queue.splice(0, queue.length);
  for (const entry of dropped) entry.done?.(false);
  return dropped;
}

/** What to tell the viewer about input that did not reach the page (`dialog`: a page dialog stopped it); scrolling is dropped quietly. */
export function droppedMessage(dropped: readonly QueuedInput[], cause: 'page' | 'dialog' = 'page'): string | null {
  const typed = dropped.reduce((total, entry) => total + (entry.event.kind === 'text' ? Array.from(entry.event.text).length : entry.event.kind === 'key' ? 1 : 0), 0);
  if (cause === 'dialog') {
    if (typed) return `网页弹出了对话框，刚才的 ${typed} 个字或按键没有发送。请先处理对话框，再看清页面后输入。`;
    return dropped.some((entry) => entry.event.kind === 'click') ? '网页弹出了对话框，这次点击没有执行。请先处理对话框。' : null;
  }
  if (dropped.some((entry) => entry.event.kind === 'click')) return '画面已经变化，这次点击没有执行。请在新画面上再点一次。';
  return typed ? `页面已经变化，刚才的 ${typed} 个字或按键没有发送。请看清当前页面后再输入。` : null;
}
