import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import { getUiChunk } from "./server/ui-chunk";
import { getClientChunk } from "./shared/ui-chunk";
import { handleChildSummary } from "./server/child-summary";
import { childSummaryRpc } from "./shared/child-summary";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { forgetAgentTurns, handleFoldIndex, noteTurnStarted } from "./server/fold-index.js";
import { handleReadImage } from "./server/read-image.js";
import { handleTurnPrompt } from "./server/turn-prompt.js";
import { foldIndexRpc } from "./shared/fold-index.js";
import { turnPromptRpc } from "./shared/prompt-pin.js";
import { readImageRpc } from "./shared/read-image.js";
import { activitySettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const locales = createLocaleService(server, { pluginId: "vivid-activity", builtins: BUILTIN_CATALOGS });
  server.handle(getClientChunk, getUiChunk);
  server.registerSettings(activitySettings);
  server.handle(childSummaryRpc, handleChildSummary);
  server.handle(readImageRpc, (input, context) => handleReadImage(input, context));
  // 本地补丁：折叠用的时间线索引（只回传位置、种类、状态和类别）。
  server.handle(foldIndexRpc, (input, context) => handleFoldIndex(input, context));
  // 0.6.0：钉在最新一段活动上方的提问（只回传那条用户消息的文字）。
  server.handle(turnPromptRpc, (input, context) => handleTurnPrompt(input, context));
  // 本地补丁（0.3.0-local.3）：记下每一轮的开始，计时不再跨轮（自主轮没有用户消息可作开始）。
  const stopTurns = server.on("agent.turn_started", (event) => noteTurnStarted(event.agent.id, event.turnId));
  // 0.5.0：Agent 关闭（归档、删除、从归档恢复、daemon 停止）后丢掉它的轮次开始时间（Paseo 0.11 的 `agent.closed`）。
  const stopClosed = server.on("agent.closed", (event) => forgetAgentTurns(event.agent.id));
  return () => {
    locales.dispose();
    stopTurns();
    stopClosed();
  };
}
