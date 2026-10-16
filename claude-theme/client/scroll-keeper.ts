import { useEffect, useRef } from "react";

/**
 * Keeps the settings page where the user left it when applying the custom theme rebuilds the page. Paseo's web app
 * re-creates its views when the selected theme's colours change, so the page would jump back to the top after every
 * slider release. Web only: react-native-web hands host components their DOM element, which leads to the page's
 * scroller; elsewhere there is no such element and nothing happens.
 */
interface ScrollNode {
  readonly parentElement: ScrollNode | null;
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener?(type: "scroll", listener: () => void, options?: { passive: boolean }): void;
  removeEventListener?(type: "scroll", listener: () => void): void;
}
type ComputedStyle = (node: ScrollNode) => { readonly overflowY: string };

/** Survives the rebuild: the screen that mounts next restores this offset. */
let pending: { top: number; until: number } | null = null;
const KEEP_MS = 4000;

function scrollerOf(node: unknown): ScrollNode | null {
  const computed = (globalThis as { getComputedStyle?: ComputedStyle }).getComputedStyle;
  if (typeof computed !== "function" || typeof node !== "object" || node === null) return null;
  let current = (node as Partial<ScrollNode>).parentElement ?? null;
  while (current) {
    if (current.scrollHeight > current.clientHeight + 1 && /(auto|scroll)/.test(computed(current).overflowY)) return current;
    current = current.parentElement;
  }
  return null;
}

export function useScrollKeeper(): { ref: { current: unknown }; remember(): void } {
  const ref = useRef<unknown>(null);
  useEffect(() => {
    const scroller = scrollerOf(ref.current);
    if (!scroller) return undefined;
    const restore = pending && Date.now() < pending.until ? pending.top : null;
    pending = null;
    if (restore !== null) {
      // The host may still be laying the page out: set it again on the next frame and a little later.
      scroller.scrollTop = restore;
      (globalThis as { requestAnimationFrame?: (callback: () => void) => unknown }).requestAnimationFrame?.(() => {
        scroller.scrollTop = restore;
      });
      const late = setTimeout(() => {
        scroller.scrollTop = restore;
      }, 120);
      const stop = follow(scroller);
      return () => {
        clearTimeout(late);
        stop();
      };
    }
    return follow(scroller);
  }, []);
  return {
    ref,
    remember() {
      const scroller = scrollerOf(ref.current);
      if (scroller) pending = { top: scroller.scrollTop, until: Date.now() + KEEP_MS };
    },
  };
}

/** Until the rebuild happens the user may scroll on; keep the latest offset. */
function follow(scroller: ScrollNode): () => void {
  const onScroll = () => {
    if (pending) pending.top = scroller.scrollTop;
  };
  scroller.addEventListener?.("scroll", onScroll, { passive: true });
  return () => scroller.removeEventListener?.("scroll", onScroll);
}
