import { Platform } from 'react-native';

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
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean };
  preventDefault(): void; stopPropagation(): void;
};
type KeyboardFrameElement = {
  addEventListener(name: string, callback: (event: KeyEventShape) => void): void;
  removeEventListener(name: string, callback: (event: KeyEventShape) => void): void;
  focus?(options?: { preventScroll: boolean }): void;
};
export type ViewportKeyboardAction = { kind: 'text'; text: string } | { kind: 'key'; key: 'Enter' | 'Tab' | 'Backspace' | 'Escape' | 'Control+A' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' };

export function bindFrameKeyboard(node: unknown, onInput: (action: ViewportKeyboardAction) => void): () => void {
  if (Platform.OS !== 'web' || !node || typeof (node as KeyboardFrameElement).addEventListener !== 'function') return () => {};
  const element = node as KeyboardFrameElement;
  const handler = (event: KeyEventShape) => {
    if (event.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable || event.altKey) return;
    let action: ViewportKeyboardAction | null = null;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'a') action = { kind: 'key', key: 'Control+A' };
      else return;
    } else if (['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      if (event.shiftKey && event.key === 'Tab') return;
      action = { kind: 'key', key: event.key as Extract<ViewportKeyboardAction, { kind: 'key' }>['key'] };
    } else if (Array.from(event.key).length === 1) action = { kind: 'text', text: event.key };
    if (!action) return;
    event.preventDefault(); event.stopPropagation(); onInput(action);
  };
  const paste = (event: KeyEventShape) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
    const text = (event as KeyEventShape & { clipboardData?: { getData(format: string): string } }).clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault(); event.stopPropagation();
    for (let offset = 0; offset < text.length; offset += 10_000) onInput({ kind: 'text', text: text.slice(offset, offset + 10_000) });
  };
  element.addEventListener('keydown', handler);
  element.addEventListener('paste', paste);
  return () => { element.removeEventListener('keydown', handler); element.removeEventListener('paste', paste); };
}

export function focusFrame(node: unknown): void {
  if (Platform.OS !== 'web' || !node) return;
  (node as KeyboardFrameElement).focus?.({ preventScroll: true });
}
