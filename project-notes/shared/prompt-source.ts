import { t } from "./text";

/**
 * How the send ledger names a prompt: by its title, well inside the ledger's 200-character limit. The picker (client)
 * and quick pills (server) name a prompt the same way.
 */
export function promptSource(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, " ").trim());
  if (!chars.length) return t("composer.prompt");
  return t("composer.source", { title: chars.length > 60 ? t("composer.truncatedTitle", { title: chars.slice(0, 60).join("") }) : chars.join("") });
}
