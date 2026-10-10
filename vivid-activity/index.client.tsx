import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { ActivitySettings } from "./client/settings";
import { ColorfulReasoning, ColorfulToolCall } from "./client/activity";
import { FoldRow } from "./client/fold-row";
import { foldRuntime } from "./client/fold-runtime";
import { BOUNDARY_ITEM_TYPES, observeBoundary, transformReasoning, transformToolCall } from "./client/transform";
import { isSettingsChange, setLiveTakeover, startTakeover, type TakeoverPart } from "./client/takeover";
import { installColorfulFonts } from "./client/web";
import { foldIndexRpc } from "./shared/fold-index";
import { activitySettings, foldFromValues } from "./shared/settings";
import {
  FOLD_RENDERER_KIND,
  FOLD_RENDERER_VERSION,
  foldItemDataSchema,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
  reasoningItemDataSchema,
  toolCallItemDataSchema,
} from "./shared/timeline";

type EventObserver = (
  events: ["status.plugin_settings_changed"],
  options: { signal: AbortSignal },
) => {
  subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};

/** Follows settings changes made on any device; also fires after (re)connecting. */
function watchSettings(client: PluginClientContext, changed: () => void): () => void {
  const observe = (client.paseo as { observeEvents?: unknown }).observeEvents;
  if (typeof observe !== "function") return () => undefined;
  const lifetime = new AbortController();
  try {
    const observation = (observe as EventObserver).call(client.paseo, ["status.plugin_settings_changed"], {
      signal: lifetime.signal,
    });
    const unsubscribe = observation.subscribe({
      snapshot: changed,
      update: (message) => {
        if (isSettingsChange(message, activitySettings.id)) changed();
      },
      error: () => undefined,
    });
    return () => {
      unsubscribe();
      lifetime.abort();
      void observation.release().catch(() => undefined);
    };
  } catch {
    lifetime.abort();
    return () => undefined;
  }
}

const NudgeRow = () => null;

export default function contribute(client: PluginClientContext) {
  const removeFonts = installColorfulFonts();
  client.addSettingsScreen({
    id: "display",
    title: "彩色活动行",
    icon: "Palette",
    Component: ActivitySettings,
  });
  // 计划（ExitPlanMode / plan_approval）和任务清单（TodoWrite）不注册转换器，始终由 Paseo 显示。
  client.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ColorfulReasoning,
  });
  client.addTimelineRenderer({
    kind: TOOL_CALL_RENDERER_KIND,
    version: TOOL_CALL_RENDERER_VERSION,
    schema: toolCallItemDataSchema,
    Component: ColorfulToolCall,
  });
  // 本地补丁：折叠摘要行。
  client.addTimelineRenderer({
    kind: FOLD_RENDERER_KIND,
    version: FOLD_RENDERER_VERSION,
    schema: foldItemDataSchema,
    Component: FoldRow,
  });

  // 本地补丁：折叠需要 Paseo 重新投影时，增删一个空渲染器——Paseo 会换一个新的组合转换函数，投影缓存随之失效
  // （与切换接管范围用的是同一个机制）。
  let nudgeRegistration: (() => void) | null = null;
  const nudge = () => {
    if (nudgeRegistration) {
      nudgeRegistration();
      nudgeRegistration = null;
    } else {
      nudgeRegistration = client.addTimelineRenderer({ kind: "vivid-nudge", version: 1, schema: z.null(), Component: NudgeRow });
    }
  };
  foldRuntime.configure({ rpc: (input) => client.rpc(foldIndexRpc, input), nudge });

  const readSettings = settingsRpc(activitySettings.id).read;
  const register = (part: TakeoverPart) => {
    if (part === "tool-calls") {
      return client.addTimelineTransformer({ id: "tool-calls", query: { itemType: "tool_call" }, transform: transformToolCall });
    }
    // Reasoning is drawn in every scope but 「关闭」, so the boundary observers live with it.
    const removals = [
      client.addTimelineTransformer({ id: "reasoning", query: { itemType: "reasoning" }, transform: transformReasoning }),
      ...BOUNDARY_ITEM_TYPES.map((itemType) =>
        client.addTimelineTransformer({ id: `fold-${itemType.replace(/_/g, "-")}`, query: { itemType }, transform: observeBoundary } as Parameters<typeof client.addTimelineTransformer>[0]),
      ),
    ];
    return () => {
      for (const remove of removals) remove();
    };
  };
  const takeover = startTakeover({
    register,
    read: async () => {
      const result = await client.rpc(readSettings, {});
      if (result.status !== "ready") return null;
      const fold = foldFromValues(result.values);
      if (fold) foldRuntime.setSettings(fold);
      return fold?.scope ?? null;
    },
    watch: (changed) => watchSettings(client, changed),
  });
  setLiveTakeover(takeover);
  return () => {
    setLiveTakeover(null);
    takeover.stop();
    foldRuntime.configure(null);
    nudgeRegistration = null;
    removeFonts();
  };
}
