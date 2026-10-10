import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleFoldIndex, noteTurnStarted } from "./server/fold-index.js";
import { handleReadImage } from "./server/read-image.js";
import { foldIndexRpc } from "./shared/fold-index.js";
import { readImageRpc } from "./shared/read-image.js";
import { activitySettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(activitySettings);
  server.handle(readImageRpc, (input, context) => handleReadImage(input, context));
  // 本地补丁：折叠用的时间线索引（只回传位置、种类、状态和类别）。
  server.handle(foldIndexRpc, (input, context) => handleFoldIndex(input, context));
  // 本地补丁（0.3.0-local.3）：记下每一轮的开始，计时不再跨轮（自主轮没有用户消息可作开始）。
  const stopTurns = server.on("agent.turn_started", (event) => noteTurnStarted(event.agent.id, event.turnId));
  return () => {
    stopTurns();
  };
}
