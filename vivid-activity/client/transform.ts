import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { HIDE, reasoningKey, SHOW, toolKey, type FoldRole } from "../shared/fold";
import { claimsToolCall } from "../shared/fold-index";
import { isForegroundNotice, readTaskNotice } from "../shared/notice";
import {
  createReasoningData,
  createToolCallData,
  FOLD_RENDERER_KIND,
  FOLD_RENDERER_VERSION,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
} from "../shared/timeline";
import { extractApplyPatchEdits, isApplyPatchTool } from "../shared/presentation";
import { foldRuntime } from "./fold-runtime";

type ReasoningTransformer = PluginTimelineTransformerContribution<"reasoning">["transform"];
type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];
type ToolCallItem = Extract<ToolCallTimelineItem, { type: "tool_call" }>;

// 本地补丁：不再注册 todo 转换器，任务清单交还 Paseo。0.11 把 Claude Code 的 TodoWrite 变成
// 「已创建/已添加/已完成」一行一事件的原生任务行；上游 HEAD 返回空数组会把它们整条吞掉，审核版则每次重复整张清单。

/**
 * 本地补丁：折叠。Paseo 每次重新投影都会把每一行再交给转换器；已结束的行内容不会再变，按内容指纹缓存转换结果，
 * 长对话重投影时省掉一半时间（实测 464 行 17 → 8.5 ms）。运行中的行不缓存。
 */
const MEMO_LIMIT = 1500;
const memo = new Map<string, PluginTimelineTransformResult>();
function remember(key: string, build: () => PluginTimelineTransformResult): PluginTimelineTransformResult {
  const cached = memo.get(key);
  if (cached) return cached;
  const value = build();
  memo.set(key, value);
  if (memo.size > MEMO_LIMIT) {
    let drop = MEMO_LIMIT / 2;
    for (const old of memo.keys()) {
      if (drop-- <= 0) break;
      memo.delete(old);
    }
  }
  return value;
}

/** Cheap content fingerprint (two levels, strings by length and edges): tells two finished rows with one call id apart. */
export function fingerprint(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "_";
  if (typeof value === "string") return `${value.length}:${value.slice(0, 24)}${value.length > 32 ? value.slice(-8) : ""}`;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return depth >= 2 ? `a${value.length}` : `[${value.map((entry) => fingerprint(entry, depth + 1)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= 2) return `o${entries.length}`;
  return `{${entries.map(([key, entry]) => `${key}=${fingerprint(entry, depth + 1)}`).join(";")}}`;
}

/** Applies the row's fold role: hidden rows vanish (no host spacing either), a segment's first row becomes its summary. */
function withRole(key: string, live: boolean, normal: () => PluginTimelineTransformResult): PluginTimelineTransformResult {
  // Live rows are never folded away, whatever an index that lags behind says.
  const role: FoldRole = live ? SHOW : foldRuntime.roleFor(key);
  foldRuntime.markProjected(key, role);
  if (role.kind === "hide") return { items: [] };
  if (role.kind === "fold") {
    const fold = { type: "plugin" as const, kind: FOLD_RENDERER_KIND, version: FOLD_RENDERER_VERSION, data: { ...role.summary } };
    return { items: role.summary.expanded ? [fold, ...normal().items] : [fold] };
  }
  return normal();
}

export const transformReasoning: ReasoningTransformer = ({ item, phase }) => {
  const build = () => ({
    items: [
      {
        type: "plugin" as const,
        kind: REASONING_RENDERER_KIND,
        version: REASONING_RENDERER_VERSION,
        data: createReasoningData(item, phase),
      },
    ],
  });
  const key = reasoningKey(item.text);
  return withRole(key, phase === "streaming", () => (phase === "streaming" ? build() : remember(`r|${key}|${item.text.slice(0, 64)}`, build)));
};

function transformApplyPatch(item: ToolCallItem) {
  const edits = extractApplyPatchEdits(
    item.detail,
    item.detail.type === "unknown" ? item.detail.output : undefined,
    item.metadata,
  );
  if (edits.length === 0) return undefined;

  return {
    items: edits.map((edit, index) => {
      const data = createToolCallData({
        ...item,
        name: "apply_patch",
        detail: {
          type: "edit",
          filePath: edit.filePath,
          unifiedDiff: edit.unifiedDiff,
        },
      });
      const label = edit.operation === "add" ? "Add" : edit.operation === "delete" ? "Delete" : "Edit";
      return {
        type: "plugin" as const,
        id: `${item.callId}:apply-patch:${index}`,
        kind: TOOL_CALL_RENDERER_KIND,
        version: TOOL_CALL_RENDERER_VERSION,
        data: {
          ...data,
          presentation: { ...data.presentation, label },
        },
      };
    }),
  };
}

function toolRows(item: ToolCallItem): PluginTimelineTransformResult {
  if (isApplyPatchTool(item.name)) {
    const transformed = transformApplyPatch(item);
    if (transformed) return transformed;
  }
  return {
    items: [
      {
        type: "plugin",
        kind: TOOL_CALL_RENDERER_KIND,
        version: TOOL_CALL_RENDERER_VERSION,
        data: createToolCallData(item),
      },
    ],
  };
}

export const transformToolCall: ToolCallTransformer = ({ item }) => {
  // 本地补丁：计划（Claude ExitPlanMode / plan_approval 等 detail.type === "plan"）交给 Paseo 的
  // 审批卡和「已批准/已拒绝的计划」卡。接管会在审批时重复显示一份原始 Markdown，批准后丢掉结果标记。
  // Paseo renders the `speak` shape as a SpeakMessage, not an ordinary tool card.
  if (!claimsToolCall(item)) return undefined;
  const key = toolKey(item.callId);
  // 本地补丁：前台 Bash 的任务通知只是把上一行命令重复一遍，折进那一行。
  const notice = readTaskNotice(item);
  if (isForegroundNotice(notice) && foldRuntime.hasSeen(toolKey(notice.ref))) {
    foldRuntime.markProjected(key, HIDE);
    return { items: [] };
  }
  const running = item.status === "running";
  return withRole(key, running, () =>
    running
      ? toolRows(item)
      : remember(`t|${key}|${item.status}|${item.name}|${fingerprint(item.detail)}|${fingerprint(item.error)}|${fingerprint(item.metadata)}`, () => toolRows(item)),
  );
};

/**
 * 本地补丁：观察 Agent 文字、用户消息、任务行等「段的边界」。不接管（返回 undefined），只提醒折叠索引读一次增量：
 * 一段工具行后面来了文字，这段就结束了，可以折叠。
 */
export function observeBoundary(): undefined {
  foldRuntime.poke();
  return undefined;
}

/** Item types Paseo 0.11.1 lets a transformer watch besides ours (it rejects "notification" and "plugin"). */
export const BOUNDARY_ITEM_TYPES = ["assistant_message", "user_message", "todo", "error", "compaction"] as const;
