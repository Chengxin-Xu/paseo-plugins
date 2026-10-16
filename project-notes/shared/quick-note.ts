import { t } from "./text";
import { BODY_MAX_LENGTH } from "./schema";

/** `/notes <text>`: an inbox idea titled by its first line. The quick chunk writes it (the resident stub has no schemas). */
export function quickNoteFields(text: string) {
  const body = text.trim();
  if (!body) throw new Error(t("boot.quickNoteEmpty"));
  if (body.length > BODY_MAX_LENGTH) throw new Error(t("boot.quickNoteTooLong", { count: BODY_MAX_LENGTH }));
  return { kind: "idea" as const, title: body.split(/\r?\n/)[0]!.slice(0, 160), body, status: "todo" as const, priority: "normal" as const, pinned: false };
}
