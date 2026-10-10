import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import type { ExpansionMode } from "./settings";
import { reasoningKey, toolKey } from "./fold";
import { noticeTextZh, readTaskNotice } from "./notice";
import {
  formatError,
  formatReasoningText,
  normalizeToolCallDetail,
  resolveToolCallPresentation,
  toJsonValue,
  withMetadataEditDiff,
} from "./presentation";

export const REASONING_RENDERER_KIND = "colorful-reasoning";
export const TOOL_CALL_RENDERER_KIND = "colorful-tool-call";
export const REASONING_RENDERER_VERSION = 1;
export const TOOL_CALL_RENDERER_VERSION = 1;

export const reasoningItemDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
  // 本地补丁：折叠键（原文哈希，见 shared/fold.ts），行组件据此向折叠索引报到。
  fold: z.string().optional(),
});

export const diffStatsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const toolCallPresentationSchema = z.object({
  category: z.enum([
    "shell",
    "file",
    "search",
    "agent",
    "plan",
    "communication",
    "unknown",
  ]),
  icon: z.string(),
  label: z.string(),
  summary: z.string().optional(),
  filePath: z.string().optional(),
  fileIcon: z.string().optional(),
  language: z.string().optional(),
  diffStats: diffStatsSchema.optional(),
});

export const taskNoticeDataSchema = z.object({
  /** 中文的一行说明，例如 后台命令「构建」已完成（退出码 0）。 */
  text: z.string(),
  background: z.boolean(),
  taskId: z.string().optional(),
  outputFile: z.string().optional(),
});

export const toolCallItemDataSchema = z.object({
  // 本地补丁：带上 callId，行组件据此认出「等你批准」的那一行。
  callId: z.string().optional(),
  // 本地补丁：折叠键（`t:<callId>`）。
  fold: z.string().optional(),
  // 本地补丁：Claude Code 的后台任务通知（Paseo 合成的 task_notification 行）。
  notice: taskNoticeDataSchema.optional(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  detail: z.json(),
  errorText: z.string().optional(),
  presentation: toolCallPresentationSchema,
});

/** 本地补丁：折叠摘要行（「12 步 思考 2 · 命令 5…」或运行中的「前面 N 步」）。数据由转换器按折叠索引写入。 */
export const FOLD_RENDERER_KIND = "vivid-fold";
export const FOLD_RENDERER_VERSION = 1;
export const foldItemDataSchema = z.object({
  segment: z.string(),
  mode: z.enum(["done", "earlier"]),
  expanded: z.boolean(),
  steps: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
  counts: z.array(z.tuple([z.string(), z.number().int().nonnegative()])),
  failed: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().nullable(),
});
export type FoldItemData = z.output<typeof foldItemDataSchema>;

export type ReasoningItemData = z.output<typeof reasoningItemDataSchema>;
export type ToolCallItemData = z.output<typeof toolCallItemDataSchema>;

export function resolveExpansion(mode: ExpansionMode, isLatest: boolean, userExpanded: boolean | null): boolean {
  if (userExpanded !== null) return userExpanded;
  if (mode === "always") return true;
  if (mode === "never") return false;
  return isLatest;
}

export function isLatestTaskUpdate(timestamp: number, latestTimestamp: number): boolean {
  return latestTimestamp > 0 && timestamp >= latestTimestamp;
}

export interface TaskUpdateExpansionOverride {
  expanded: boolean;
  latestTimestamp: number;
}

export function resolveTaskUpdateExpansion(
  mode: ExpansionMode,
  isLatest: boolean,
  latestTimestamp: number,
  userOverride: TaskUpdateExpansionOverride | null,
): boolean {
  const userExpanded =
    mode !== "latest" || userOverride?.latestTimestamp === latestTimestamp
      ? userOverride?.expanded ?? null
      : null;
  return resolveExpansion(mode, isLatest, userExpanded);
}

export function createReasoningData(
  item: Extract<AgentTimelineItem, { type: "reasoning" }>,
  phase: ReasoningItemData["phase"],
): ReasoningItemData {
  return { text: formatReasoningText(item.text), phase, fold: reasoningKey(item.text) };
}

export function createToolCallData(
  source: Extract<AgentTimelineItem, { type: "tool_call" }>,
): ToolCallItemData {
  const item = withMetadataEditDiff(source);
  const detail = normalizeToolCallDetail(item.detail, item.name);
  const notice = readTaskNotice(item);
  const noticeText = notice ? noticeTextZh(notice) : null;
  // 本地补丁：Claude Code 的后台任务通知画成「后台任务」命令行（上游是灰色拼图 + 英文原文）。
  const presentation = notice
    ? { category: "shell" as const, icon: "SquareTerminal", label: "Background Task", summary: noticeText ?? undefined }
    : resolveToolCallPresentation({ name: item.name, detail });
  const errorText = formatError(item.error);
  return {
    ...(item.callId ? { callId: item.callId, fold: toolKey(item.callId) } : {}),
    ...(notice && noticeText
      ? {
          notice: {
            text: noticeText,
            background: notice.background,
            ...(notice.taskId ? { taskId: notice.taskId } : {}),
            ...(notice.outputFile ? { outputFile: notice.outputFile } : {}),
          },
        }
      : {}),
    name: item.name,
    status: item.status,
    detail: toJsonValue(detail),
    ...(errorText ? { errorText } : {}),
    presentation: {
      category: presentation.category,
      icon: presentation.icon,
      label: presentation.label,
      ...(presentation.summary ? { summary: presentation.summary } : {}),
      ...(presentation.filePath ? { filePath: presentation.filePath } : {}),
      ...(presentation.fileIcon ? { fileIcon: presentation.fileIcon } : {}),
      ...(presentation.language ? { language: presentation.language } : {}),
      ...(presentation.diffStats ? { diffStats: presentation.diffStats } : {}),
    },
  };
}
