import { Platform } from "react-native";

// Paseo 0.11 has no draft API. Keep the private DOM convention isolated and fail back to copying.
type ComposerInput = {
  value: string; disabled: boolean; readOnly: boolean; isConnected: boolean;
  getClientRects(): { length: number };
  dispatchEvent(event: unknown): boolean;
  ownerDocument: { defaultView?: { HTMLTextAreaElement?: { prototype: object }; Event?: new (name: string, options: { bubbles: boolean }) => unknown } | null };
};
export type ComposerDraft = { read(): string | null; fill(text: string, previous: string, mode: "replace" | "append"): ComposerUndo | null };
export type ComposerUndo = { undo(): boolean };

/** Only one visible input is safe: never guess which agent owns a split-pane composer. */
export function findComposerDraft(): ComposerDraft | null {
  if (Platform.OS !== "web") return null;
  const document = (globalThis as { document?: { querySelectorAll(selector: string): ArrayLike<ComposerInput> } }).document;
  if (!document) return null;
  const visible = () => Array.from(document.querySelectorAll("textarea[data-composer-input]")).filter(input => input.isConnected && !input.disabled && !input.readOnly && input.getClientRects().length > 0);
  const candidates = visible();
  if (candidates.length !== 1) return null;
  const input = candidates[0]!;
  const view = input.ownerDocument.defaultView;
  const setter = view?.HTMLTextAreaElement && Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter || !view?.Event) return null;
  const valid = () => Platform.OS === "web" && visible().length === 1 && visible()[0] === input;
  const write = (text: string) => { setter.call(input, text); input.dispatchEvent(new view.Event!("input", { bubbles: true })); };
  return {
    read: () => valid() ? input.value : null,
    fill(text, previous, mode) {
      if (!valid() || input.value !== previous) return null;
      const next = mode === "append" && previous ? `${previous}\n\n${text}` : text;
      try { write(next); } catch { return null; }
      let undone = false;
      return { undo() {
        // Never replace a newer user edit, a sent draft, or another agent's input.
        if (undone || !valid() || input.value !== next) return false;
        try { write(previous); undone = true; return true; } catch { return false; }
      } };
    },
  };
}
