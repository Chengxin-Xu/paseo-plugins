import { Platform } from 'react-native';
import { splitText } from './input-queue';

// Keep browser-only APIs behind this module; native hosts return a no-op.
type WheelEventShape = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  preventDefault(): void;
  stopPropagation(): void;
};
type FrameElement = {
  addEventListener(name: string, callback: (event: WheelEventShape) => void, options?: { passive: boolean }): void;
  removeEventListener(name: string, callback: (event: WheelEventShape) => void): void;
  style?: { touchAction: string };
};

export function bindFrameWheel(node: unknown, onWheel: (deltaX: number, deltaY: number) => void): () => void {
  if (Platform.OS !== 'web' || !node || typeof (node as FrameElement).addEventListener !== 'function') return () => {};
  const element = node as FrameElement;
  const previousTouchAction = element.style?.touchAction;
  if (element.style) element.style.touchAction = 'none';
  const handler = (event: WheelEventShape) => {
    if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1;
    onWheel(event.deltaX * unit, event.deltaY * unit);
  };
  element.addEventListener('wheel', handler, { passive: false });
  return () => {
    element.removeEventListener('wheel', handler);
    if (element.style && previousTouchAction !== undefined) element.style.touchAction = previousTouchAction;
  };
}

type KeyEventShape = {
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number;
  target?: unknown; data?: string | null; inputType?: string; pointerType?: string;
  clipboardData?: { getData(format: string): string } | null;
  preventDefault(): void; stopPropagation(): void;
};
type Listener = (event: KeyEventShape) => void;
type DomElement = {
  tagName?: string; value: string; disabled?: boolean; style: Record<string, string>;
  addEventListener(name: string, callback: Listener): void;
  removeEventListener(name: string, callback: Listener): void;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElement): void;
  contains?(other: unknown): boolean;
  focus?(options?: { preventScroll: boolean }): void;
  blur?(): void;
  ownerDocument?: { activeElement: unknown; createElement(tag: 'textarea'): DomElement; addEventListener(name: string, callback: Listener, options?: { capture: boolean }): void; removeEventListener(name: string, callback: Listener, options?: { capture: boolean }): void };
};
export type ViewportKeyboardAction = { kind: 'text'; text: string } | { kind: 'key'; key: 'Enter' | 'Tab' | 'Backspace' | 'Escape' | 'Control+A' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' };
const SPECIAL_KEYS = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/**
 * Each frame node carries one invisible 1 px textarea: the keyboard and IME target while you type on the picture, so
 * Pinyin and other input methods compose there and their result is sent in one piece. It stays as long as the node
 * does, so rebinding never drops keyboard focus. `touch`: the last press came from a finger (no soft keyboard then).
 * `pressing`: a pointer is down on the frame; moving focus then would end React Native Web's press, so it waits.
 * `composition`: the composition in progress and the binding it started under. Only that binding may commit it: one that
 * was discarded (the page it was typed for went away) or that started under an earlier binding is never sent.
 */
type Composition = { owner: object; text: string; discarded: boolean; report?: (text: string | null) => void };
type Slot = { sink: DomElement; touch: boolean; pressing: boolean; composition: Composition | null };
const slots = new WeakMap<object, Slot>();
function slotFor(node: DomElement): Slot | null {
  const existing = slots.get(node);
  if (existing) return existing;
  const document = node.ownerDocument;
  if (!document || typeof node.appendChild !== 'function') return null;
  const sink = document.createElement('textarea');
  for (const [name, value] of [['aria-label', '在网页画面中输入'], ['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['tabindex', '-1'], ['data-testid', 'server-browser-ime']]) sink.setAttribute(name, value);
  Object.assign(sink.style, { position: 'absolute', left: '0px', top: '0px', width: '1px', height: '1px', padding: '0', border: '0', margin: '0', opacity: '0', resize: 'none', overflow: 'hidden', pointerEvents: 'none', caretColor: 'transparent', zIndex: '-1' });
  node.appendChild(sink);
  const slot: Slot = { sink, touch: !!(globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia?.('(hover: none) and (pointer: coarse)').matches, pressing: false, composition: null };
  // A finger press must not pop up the soft keyboard: phones type through the input tray instead.
  node.addEventListener('pointerdown', (event) => {
    slot.touch = event.pointerType === 'touch'; slot.pressing = true;
    const released = () => { slot.pressing = false; document.removeEventListener('pointerup', released, { capture: true }); document.removeEventListener('pointercancel', released, { capture: true }); };
    document.addEventListener('pointerup', released, { capture: true }); document.addEventListener('pointercancel', released, { capture: true });
  });
  slots.set(node, slot);
  return slot;
}

export type FrameKeyboardOptions = {
  /** What an open composition holds so far ('' at its start); null once it is committed or dropped. */
  onComposing?: (text: string | null) => void;
  /** A finished composition, for the page it was started on (without this, it goes to onInput as text). */
  onComposed?: (text: string) => void;
  /** A composition was dropped unsent because this binding ended (control or a dialog changed) while it was open. */
  onCompositionDropped?: () => void;
};

/**
 * Keys typed on the frame: printable characters as text, a few special keys, Ctrl/⌘+A, plain-text paste and finished IME
 * compositions. Characters an input method is still composing are left to it. A composition belongs to the binding it
 * started under: it is committed only through that binding, and never by a later one.
 */
export function bindFrameKeyboard(node: unknown, onInput: (action: ViewportKeyboardAction) => void, options: FrameKeyboardOptions = {}): () => void {
  if (Platform.OS !== 'web' || !node || typeof (node as DomElement).addEventListener !== 'function') return () => {};
  const element = node as DomElement, slot = slotFor(element), sink = slot?.sink, owner = {};
  const ours = (target: unknown) => target === element || (!!sink && target === sink);
  // Any open composition holds the keys, ours or one an earlier binding left behind (it is discarded and never sent).
  const composing = () => !!slot?.composition;
  const own = () => { const current = slot?.composition; return current && current.owner === owner && !current.discarded ? current : null; };
  const text = (value: string) => { for (const part of splitText(value)) onInput({ kind: 'text', text: part }); };
  const keydown = (event: KeyEventShape) => {
    if (!ours(event.target)) return;
    // The input method owns this key (Pinyin letters, its Enter or Space); keep it away from the host and the page.
    if (composing() || event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Dead') { event.stopPropagation(); return; }
    if (event.altKey) return;
    let action: ViewportKeyboardAction | null = null;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'a') action = { kind: 'key', key: 'Control+A' };
      // Ctrl/⌘+V goes on to the paste event, which carries plain text; other shortcuts stay with the host.
      else { if (event.key.toLowerCase() === 'v') event.stopPropagation(); return; }
    } else if (SPECIAL_KEYS.includes(event.key)) {
      if (event.shiftKey && event.key === 'Tab') return;
      action = { kind: 'key', key: event.key as Extract<ViewportKeyboardAction, { kind: 'key' }>['key'] };
    } else if (Array.from(event.key).length === 1) action = { kind: 'text', text: event.key };
    if (!action) return;
    event.preventDefault(); event.stopPropagation(); onInput(action);
  };
  const paste = (event: KeyEventShape) => {
    if (!ours(event.target)) return;
    const value = event.clipboardData?.getData('text/plain');
    event.preventDefault(); event.stopPropagation();
    if (sink) sink.value = '';
    if (value) text(value);
  };
  const compositionStart = () => {
    if (!slot) return;
    slot.composition = { owner, text: '', discarded: false, report: options.onComposing };
    options.onComposing?.('');
  };
  const compositionUpdate = (event: KeyEventShape) => {
    const current = own(); if (!current) return;
    current.text = event.data ?? sink?.value ?? '';
    options.onComposing?.(current.text);
  };
  const compositionEnd = (event: KeyEventShape) => {
    const current = slot?.composition ?? null, value = event.data ?? sink?.value ?? '';
    if (slot) slot.composition = null;
    if (sink) sink.value = '';
    // Discarded (its page went away) or started under an earlier binding: the text goes nowhere.
    if (!current || current.discarded || current.owner !== owner) return;
    // Committed while the page it was typed for is still the one it is bound to; then the badge goes.
    if (value) { if (options.onComposed) options.onComposed(value); else text(value); }
    options.onComposing?.(null);
  };
  // Text that arrives without a key press: the emoji picker, dictation, autocorrect replacements. A released slot takes none.
  const input = (event: KeyEventShape) => {
    if (composing() || event.isComposing || !sink || sink.disabled) return;
    const value = event.data ?? sink.value;
    sink.value = '';
    if (value && (event.inputType === 'insertText' || event.inputType === 'insertReplacementText')) text(value);
  };
  // Keyboard focus on the frame (Tab) goes on to the slot, taking it back if it was released; a press focuses it itself once the press is over.
  const focus = (event: KeyEventShape) => { if (event.target === element && sink && slot && !slot.touch && !slot.pressing) { sink.disabled = false; sink.focus?.({ preventScroll: true }); } };
  // Leaving the slot ends a composition: the browser commits it first (compositionend), so this only tidies up.
  const blur = () => { const current = own(); if (current && slot) { slot.composition = null; options.onComposing?.(null); } if (sink) sink.value = ''; };
  element.addEventListener('keydown', keydown);
  element.addEventListener('paste', paste);
  element.addEventListener('focus', focus);
  sink?.addEventListener('compositionstart', compositionStart);
  sink?.addEventListener('compositionupdate', compositionUpdate);
  sink?.addEventListener('compositionend', compositionEnd);
  sink?.addEventListener('input', input);
  sink?.addEventListener('blur', blur);
  if (sink) sink.value = '';
  // Rebinding (a new page, a closed dialog) keeps typing where it was.
  if (sink && slot && !slot.touch && element.ownerDocument?.activeElement === element) sink.focus?.({ preventScroll: true });
  return () => {
    // A composition never outlives the binding it started under (control or a dialog changed): it is dropped, unsent.
    if (own() && cancelFrameComposition(element)) options.onCompositionDropped?.();
    element.removeEventListener('keydown', keydown);
    element.removeEventListener('paste', paste);
    element.removeEventListener('focus', focus);
    sink?.removeEventListener('compositionstart', compositionStart);
    sink?.removeEventListener('compositionupdate', compositionUpdate);
    sink?.removeEventListener('compositionend', compositionEnd);
    sink?.removeEventListener('input', input);
    sink?.removeEventListener('blur', blur);
  };
}

/**
 * Drop the composition in progress on this frame unsent: the page it was typed for has gone (another document or tab).
 * Moving focus out of the slot makes the input method end it, and the slot is released (disabled) so that nothing the
 * input method still commits lands in it; the next press on the picture (or Tab onto it) takes it back. Returns whether
 * there was one.
 */
export function cancelFrameComposition(node: unknown): boolean {
  if (Platform.OS !== 'web' || !node || typeof node !== 'object') return false;
  const slot = slots.get(node), current = slot?.composition;
  if (!slot || !current || current.discarded) return false;
  current.discarded = true;
  current.report?.(null);
  slot.sink.value = '';
  slot.sink.blur?.();
  slot.sink.disabled = true;
  slot.composition = null; slot.sink.value = '';
  return true;
}

/** Give the frame keyboard focus after a press: the IME slot, placed where you pressed so the candidate window opens there. */
export function focusFrame(node: unknown, at?: { x: number; y: number }): void {
  if (Platform.OS !== 'web' || !node) return;
  const element = node as DomElement, slot = typeof element.addEventListener === 'function' ? slotFor(element) : null;
  if (!slot || slot.touch) { element.focus?.({ preventScroll: true }); return; }
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) Object.assign(slot.sink.style, { left: `${Math.max(0, Math.round(at.x))}px`, top: `${Math.max(0, Math.round(at.y))}px` });
  // A press on the picture is the viewer choosing this page: a released slot takes keys again.
  slot.sink.disabled = false;
  slot.sink.focus?.({ preventScroll: true });
}

/** Whether keyboard focus is in the frame (its node or its IME slot). */
export function frameHasFocus(node: unknown): boolean {
  if (Platform.OS !== 'web' || !node) return false;
  const element = node as DomElement, active = element.ownerDocument?.activeElement;
  return !!active && (active === element || !!element.contains?.(active));
}
