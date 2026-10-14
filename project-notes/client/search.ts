import type { BoardItem } from "../shared/schema";

// Immutable query snapshots keep unchanged item references. Weak keys do not retain removed boards.
const texts = new WeakMap<BoardItem, string>();
export function searchText(item: BoardItem): string {
  let text = texts.get(item);
  if (text === undefined) { text = `${item.title}\n${item.body}`.toLowerCase(); texts.set(item, text); }
  return text;
}
