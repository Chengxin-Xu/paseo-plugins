import type { BrowserAction, BrowserFrameResult, BrowserSession, BrowserTarget } from '../shared/browser';
export type InputRequest = { action: BrowserAction; target?: BrowserTarget };
type Frame = NonNullable<BrowserFrameResult['frame']>;
export function requiresTarget(action: BrowserAction): boolean {
  return !['mode', 'stop', 'restart', 'settings', 'cleanup', 'handleDialog'].includes(action.kind);
}
/** The exact picture of the current page: what a click needs. Every input spends it until the next picture arrives. */
export function frameMatchesSession(frame: Frame | null, session: BrowserSession | null): boolean {
  return !!frame && session?.status === 'running' && frame.tabId === session.activeTabId && frame.viewRevision === session.viewRevision && frame.width === session.width && frame.height === session.height;
}
/**
 * The picture still shows the current page context (tab, document, viewport, control): keep showing it and keep taking
 * keys, text and scrolling; only a click waits for a newer picture. A server without input scopes needs the exact picture.
 */
export function frameInScope(frame: Frame | null, session: BrowserSession | null): boolean {
  if (!frame || session?.status !== 'running' || frame.tabId !== session.activeTabId || frame.width !== session.width || frame.height !== session.height) return false;
  return frame.inputScope ? frame.inputScope === session.inputScope : frame.viewRevision === session.viewRevision;
}
/** Same page context: same tab and input scope (or, without scopes, the same picture). */
export function sameTarget(left: BrowserTarget | null | undefined, right: BrowserTarget | null | undefined): boolean {
  return !!left && !!right && left.tabId === right.tabId && (left.inputScope || right.inputScope ? left.inputScope === right.inputScope : left.viewRevision === right.viewRevision);
}
/**
 * Whether input made on `target` may still go to the page `session` shows: the same tab and page context, a running browser
 * under manual control and no dialog. An input method composition started on `target` is dropped once this is false.
 */
export function contextHolds(target: BrowserTarget | null | undefined, session: BrowserSession | null | undefined): boolean {
  if (!target || !session || session.status !== 'running' || session.mode !== 'manual' || session.dialog || session.activeTabId !== target.tabId) return false;
  return target.inputScope ? target.inputScope === session.inputScope : target.viewRevision === session.viewRevision;
}
/** A target riding along with a sent batch: carried on to its continuation, kept while an Agent read finishes, or ended (null). */
export function followBatch(target: BrowserTarget, sent: BrowserTarget, result: { status: string; continuation: string | null }): BrowserTarget | null {
  if (!sameTarget(target, sent) || result.status === 'busy') return target;
  return result.status === 'applied' && result.continuation ? { ...target, inputScope: result.continuation } : null;
}
export function bindInput(action: BrowserAction, displayed: BrowserTarget | null): InputRequest | null {
  if (!requiresTarget(action)) return { action };
  return displayed ? { action, target: { ...displayed } } : null;
}


export type BoundDraft = { dirty: boolean; target: BrowserTarget | null };
export function emptyDraft(): BoundDraft { return { dirty: false, target: null }; }
/** A blur, refocus or later keystroke never reassigns an existing draft to another page. */
export function editDraft(previous: BoundDraft, value: string, displayed: BrowserTarget | null): BoundDraft {
  if (!value) return emptyDraft();
  if (previous.dirty) return previous;
  return { dirty: true, target: displayed ? { ...displayed } : null };
}
