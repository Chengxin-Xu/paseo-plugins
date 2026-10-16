import { t } from "../shared/text";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { INBOX_PROJECT_ID, type BoardItem } from "../shared/board";
import { noteContext, templateVariables } from "../shared/composer";
import { SEND_NOUN_LIMIT } from "../shared/deferred-rpc";
import { promptSource } from "../shared/prompt-source";
import type { QuickSendResult } from "../shared/quick-send";
import { boardProjects, type ProjectDirectory } from "./dashboard";
import type { DeferredSend } from "./deferred-send";
import { contentKey } from "./send-plan";
import type { BoardStore } from "./store";

type Paseo = PluginHandlerContext["paseo"];
type QuickSendInput = { agentId: string; projectId: string; itemId: string; messageId: string; consent?: { interrupt: boolean; approvals: string[]; turn?: string | null } | null; wait?: boolean };

/**
 * The ledger key of a prompt's text, the same as the prompt picker's (`notePromptKey` in client/deferred-state.ts): a
 * pill and a picker sending the same prompt to the same agent are one message on its way.
 */
export function notePromptKey(note: Pick<BoardItem, "id" | "title">, body: string): string {
  // i18n-ignore: Legacy persisted-key encoding, never displayed or sent; changing it would bypass duplicate protection.
  return contentKey(["notes", `来源：手记 #${note.id}\n${note.title}${body ? `\n\n${body}` : ""}`]);
}

/**
 * Quick prompts (一键发送) on the server: reads the note a pill names and sends it through the shared send ledger, like
 * 「发送给当前 Agent」 in the picker. The text, key and source line are the picker's, so the ledger keeps one copy of a
 * prompt on its way whichever sent it. Nothing here interrupts on its own: the ledger asks (`confirm`) unless the
 * consent the user gave covers what sending would do now.
 */
export class QuickPrompts {
  constructor(private readonly store: BoardStore, private readonly ledger: Pick<DeferredSend, "send" | "enqueue">, private readonly projects?: ProjectDirectory) {}

  /** The prompt as it is now; null once it is gone, in the trash or no longer a prompt. */
  async prompt(projectId: string, itemId: string): Promise<BoardItem | null> {
    const board = await this.store.read(projectId);
    return board.items.find(item => item.id === itemId && item.deletedAt === null && item.kind === "prompt") ?? null;
  }

  /** The prompt for a template pill's fill form, with its project's name. */
  async note(paseo: Paseo, projectId: string, itemId: string) {
    const item = await this.prompt(projectId, itemId);
    if (!item) return null;
    let projectName = projectId === INBOX_PROJECT_ID ? t("serverLaunch.inbox") : t("serverComposer.historicalProject");
    if (this.projects && projectId !== INBOX_PROJECT_ID) {
      try { projectName = boardProjects(await this.projects.list(paseo)).find(project => project.id === projectId)?.name ?? projectName; }
      catch { /* The name is decoration; the prompt still opens. */ }
    }
    return { ...item, projectName };
  }

  /** Sends (or queues) the prompt and says what happened in the plugin's language. */
  async send(input: QuickSendInput, paseo: Paseo): Promise<QuickSendResult> {
    const item = await this.prompt(input.projectId, input.itemId);
    if (!item) return { status: "missing", message: t("serverQuick.missing") };
    const template = item.body || item.title, title = item.title;
    if (templateVariables(template).length) return { status: "template", message: t("serverQuick.template", { title }) };
    const text = noteContext(item, template), key = notePromptKey(item, template), source = promptSource(title);
    if (input.wait) {
      const view = await this.ledger.enqueue({ agentId: input.agentId, text, messageId: input.messageId, key, source }, paseo);
      // Content already on its way answers under its own id; an agent that was free got it at once.
      if (view.messageId !== input.messageId) return { status: "existing", message: t("serverQuick.onItsWay", { title }) };
      if (view.state === "sent") return { status: "sent", message: t("serverQuick.sent", { title }) };
      if (view.state === "sending") return { status: "sending", message: t("serverQuick.sending", { title }) };
      if (view.state === "held") return { status: "held", message: t("serverQuick.held", { title }) };
      return { status: "queued", message: t("serverQuick.queued", { title }) };
    }
    const what = t("composer.prompt");
    const result = await this.ledger.send({ agentId: input.agentId, text, messageId: input.messageId, key, source, ...(what.length <= SEND_NOUN_LIMIT ? { what } : {}), consent: input.consent ?? null }, paseo);
    switch (result.status) {
      case "sent": return { status: "sent", message: t("serverQuick.sent", { title }) };
      case "sending": return { status: "sending", message: t("serverQuick.sending", { title }) };
      case "existing": return { status: "existing", message: t("serverQuick.onItsWay", { title }) };
      case "held": return { status: "held", message: t("serverQuick.held", { title }) };
      // Nothing went out: the app asks the user, then sends again with this consent.
      case "confirm": return { status: "confirm", message: t("serverQuick.askNext", { title }), consent: result.consent };
      default: return { status: result.status, message: result.message };
    }
  }
}
