import { settingsRpc } from "@getpaseo/plugin";

/**
 * 一键发送 (one-tap prompts): prompts shown as their own pills above every agent's composer, in this list's order. The
 * list is a host setting (`quick-settings.ts` defines it), so every app follows a change at once without polling. Each
 * entry keeps the note's title and whether it has variables; the server reads the note itself when a pill sends it.
 * Only what the resident pills need lives here; the send contract (`quick-send.ts`) comes with the first press.
 */
export const QUICK_SETTINGS_ID = "quick-prompts";
export const QUICK_LIMIT = 12;
/** Up to this many show as separate pills; more fold into one menu pill. */
export const QUICK_PILL_LIMIT = 3;

// A type, not an interface: saved as JSON, it must fit the host's JSON value type.
export type QuickEntry = {
  projectId: string;
  itemId: string;
  /** The note's title when the list last saw it. */
  label: string;
  /** It has variables: a press opens the fill form instead of sending. */
  template: boolean;
  /** In the trash or no longer a prompt: kept (a restore brings it back) but not shown. */
  hidden: boolean;
  /** The note revision these fields describe (see `quickCorrections`). */
  revision: number;
};

export const quickSettingsRpc = settingsRpc(QUICK_SETTINGS_ID);
export const quickRef = (entry: Pick<QuickEntry, "projectId" | "itemId">) => `${entry.projectId}:${entry.itemId}`;

/** The saved list (the host already checked it against the setting's schema); repeated notes keep their first place. */
export function quickEntries(values: unknown): QuickEntry[] {
  const list = (values as { prompts?: unknown } | null)?.prompts, seen = new Set<string>();
  return (Array.isArray(list) ? list as QuickEntry[] : []).filter(entry => typeof entry?.projectId === "string" && typeof entry.itemId === "string" && !seen.has(quickRef(entry)) && !!seen.add(quickRef(entry)));
}

// Wide (CJK, full-width) characters count as two: a pill keeps about ten Chinese or twenty Latin characters.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
/** A pill's text: the title on one line, cut to `limit` columns with an ellipsis. */
export function pillLabel(title: string, limit = 20): string {
  const chars = Array.from(title.slice(0, 400).replace(/\s+/g, " ").trim());
  let width = 0, end = 0;
  for (; end < chars.length; end++) {
    width += WIDE.test(chars[end]!) ? 2 : 1;
    if (width > limit) break;
  }
  return end >= chars.length ? chars.join("") : `${chars.slice(0, Math.max(1, end - 1)).join("")}…`;
}
