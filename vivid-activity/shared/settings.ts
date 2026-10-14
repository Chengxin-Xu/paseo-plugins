import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const paletteModeSchema = z.enum(["vivid", "soft", "high_contrast", "theme"]);
export type PaletteMode = z.output<typeof paletteModeSchema>;

export const expansionModeSchema = z.enum(["always", "latest", "never"]);
export type ExpansionMode = z.output<typeof expansionModeSchema>;

/**
 * 本地补丁：接管范围。全部 = 思考行和工具行都由本插件绘制；仅思考行 = 工具行交还 Paseo；
 * 关闭 = 两者都交还 Paseo（插件保持安装，可随时打开）。计划卡、任务行、审批卡始终由 Paseo 显示。
 */
export const takeoverScopeSchema = z.enum(["all", "reasoning", "off"]);
export type TakeoverScope = z.output<typeof takeoverScopeSchema>;
export const DEFAULT_TAKEOVER: TakeoverScope = "all";

/**
 * One expansion knob per collapsible row renderer. 本地默认：读取、编辑、写入、命令和提问默认收起，
 * 其余只展开最新一行。`hidden` 的项仍在存储结构里，但对应的行已交还 Paseo，设置页不再列出。
 */
export const EXPANSION_TARGETS = [
  { key: "thinking", label: "思考", default: "latest" },
  { key: "read", label: "读取文件", default: "never" },
  { key: "edit", label: "编辑文件", default: "never" },
  { key: "write", label: "写入文件", default: "never" },
  { key: "shell", label: "命令", default: "never" },
  { key: "search", label: "搜索", default: "latest" },
  { key: "fetch", label: "抓取网页", default: "latest" },
  { key: "worktree_setup", label: "工作树准备", default: "latest" },
  { key: "sub_agent", label: "子 Agent", default: "latest" },
  { key: "plain_text", label: "纯文本结果", default: "latest" },
  { key: "plan", label: "计划", default: "latest", hidden: true },
  { key: "ask", label: "提问", default: "never" },
  { key: "speak", label: "朗读", default: "latest" },
  { key: "todo", label: "任务清单工具", default: "latest" },
  { key: "unknown", label: "其他工具", default: "latest" },
] as const satisfies readonly { key: string; label: string; default: ExpansionMode; hidden?: boolean }[];

export type ExpansionTarget = (typeof EXPANSION_TARGETS)[number]["key"];

export const DEFAULT_EXPANSION = Object.fromEntries(
  EXPANSION_TARGETS.map((target) => [target.key, target.default]),
) as Record<ExpansionTarget, ExpansionMode>;

/** Targets the settings screen lists; thinking only when tool rows are not taken over. */
export function visibleExpansionTargets(scope: TakeoverScope) {
  return EXPANSION_TARGETS.filter(
    (target) => !("hidden" in target && target.hidden) && (scope === "all" || target.key === "thinking"),
  );
}

const expansionSettingsSchema = z.object(
  Object.fromEntries(
    EXPANSION_TARGETS.map((target) => [target.key, expansionModeSchema.default(target.default)]),
  ) as Record<ExpansionTarget, z.ZodDefault<typeof expansionModeSchema>>,
);

/**
 * 本地补丁：行密度。紧凑 = 行更矮、上下留白更少，并用负外边距抵掉 Paseo 给每条插件行加的 16px 间距（行间只剩 4px）；
 * 标准 = 0.3.0-local.1 的行高和间距。
 */
export const densitySchema = z.enum(["compact", "standard"]);
export type Density = z.output<typeof densitySchema>;
export const DEFAULT_DENSITY: Density = "compact";
export const DEFAULT_FOLD = true;
/** 0.6.0: 「钉住本轮提问」 (shared/prompt-pin.ts). */
export const DEFAULT_PIN_PROMPT = true;

export const activitySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    takeover: takeoverScopeSchema.default(DEFAULT_TAKEOVER),
    palette: paletteModeSchema.default("vivid"),
    expansion: expansionSettingsSchema.default(DEFAULT_EXPANSION),
    // 本地补丁：「完成后折叠连续的思考与工具行」。旧设置没有这两项，读出来取默认值，所以版本号不变。
    fold: z.boolean().default(DEFAULT_FOLD),
    density: densitySchema.default(DEFAULT_DENSITY),
    // 0.6.0：同上，旧设置没有这一项，读出来取默认值。
    pinPrompt: z.boolean().default(DEFAULT_PIN_PROMPT),
  }),
});

export const DEFAULT_PALETTE_MODE: PaletteMode = "vivid";

/** The stored takeover scope, or null when the stored values do not parse. */
export function takeoverFromValues(values: unknown): TakeoverScope | null {
  const parsed = activitySettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data.takeover : null;
}

/** The stored folding switch and takeover scope, or null when the stored values do not parse. */
export function foldFromValues(values: unknown): { enabled: boolean; scope: TakeoverScope } | null {
  const parsed = activitySettings.schema.safeParse(values ?? {});
  return parsed.success ? { enabled: parsed.data.fold, scope: parsed.data.takeover } : null;
}
