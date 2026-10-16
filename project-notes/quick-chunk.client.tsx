import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ChunkExtras } from "./client/lazy-chunk";
import { followText } from "./shared/i18n";
import { createQuickSender, type QuickActions } from "./client/quick-send";
import { quickSendRpc } from "./shared/quick-send";
import { INBOX_PROJECT_ID, writeBoardRpc } from "./shared/board";
import { quickNoteFields } from "./shared/quick-note";

/**
 * The one-tap send and the `/notes <text>` capture in a small chunk of their own (0.12.0): the resident stub registers
 * the pills and the command, and loads this with the first press or capture (the host spins the pill meanwhile). It
 * carries the contracts and schemas the stub would otherwise download on every connection, and speaks the stub's boot
 * text without waiting for the full catalog.
 */
// Paseo freezes exports before running the module body; keep the default hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }

let captures = 0;
function createSurfaces(client: PluginClientContext, extras?: ChunkExtras): QuickActions {
  followText(extras?.text);
  return {
    quickSend: createQuickSender(input => client.rpc(quickSendRpc, input)),
    captureNote: text => client.rpc(writeBoardRpc, { projectId: INBOX_PROJECT_ID, requestId: `quick-${Date.now().toString(36)}-${++captures}-${Math.random().toString(36).slice(2)}`, operation: { type: "create", fields: quickNoteFields(text) } }),
  };
}
