/**
 * 本地补丁：Claude Code 的后台任务通知。
 *
 * Paseo 0.11.1 把 Claude Code 的 `system/task_notification` 变成一条合成的工具行：`name: "task_notification"`，
 * `detail: { type: "plain_text", label: <summary>, icon: "wrench" }`，`metadata: { synthetic, source: "claude_task_notification",
 * taskId, toolUseId, status, outputFile }`。两种来源：
 * - 带 `timeout` 的前台 Bash（Claude Code 2.1 把它登记成任务，以便中途转到后台）：命令跑完立刻再来一条通知，summary 就是命令的
 *   description。它和上一行命令完全重复，这里叫「前台」通知，折叠进那一行（不再单独显示）。
 * - `run_in_background` 的命令：summary 形如 `Background command "构建" completed (exit code 0)`，可能隔很久、在别的行之后才到。
 *   它单独成行，显示成中文的「后台任务」。
 */
export interface TaskNotice {
  /** The tool call the task belongs to (`metadata.toolUseId`). */
  ref: string | null;
  taskId: string | null;
  status: "completed" | "failed" | "canceled";
  /** Provider summary as sent (English for background commands). */
  summary: string;
  /** A `run_in_background` task: its summary names the command ("Background command …"). */
  background: boolean;
  outputFile: string | null;
}

type NoticeSource = {
  name: string;
  status?: string;
  detail?: unknown;
  metadata?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const TASK_NOTICE_TOOL = "task_notification";

/** Reads Paseo's synthetic task-notification row; null for every other tool call. */
export function readTaskNotice(item: NoticeSource): TaskNotice | null {
  if (item.name !== TASK_NOTICE_TOOL) return null;
  const meta = record(item.metadata);
  if (meta.source !== undefined && meta.source !== "claude_task_notification") return null;
  const detail = record(item.detail);
  const summary = text(detail.label) ?? text(detail.text) ?? "";
  const status = item.status === "failed" ? "failed" : item.status === "canceled" ? "canceled" : "completed";
  return {
    ref: text(meta.toolUseId),
    taskId: text(meta.taskId),
    status,
    summary,
    background: /^background\b/i.test(summary),
    outputFile: text(meta.outputFile),
  };
}

/** A notice that only repeats its own (foreground) tool row; it folds into that row when the row is known. */
export function isForegroundNotice(notice: TaskNotice | null): notice is TaskNotice & { ref: string } {
  return notice !== null && !notice.background && notice.ref !== null;
}

const STATUS_WORDS: Record<TaskNotice["status"], string> = { completed: "已完成", failed: "失败", canceled: "已停止" };

/** The state words of a notice summary's tail, e.g. `completed (exit code 0)` → 已完成（退出码 0）. */
function tailZh(tail: string, status: TaskNotice["status"]): string {
  const code = /exit code (-?\d+)/i.exec(tail)?.[1];
  let words: string;
  if (/\b(fail|failed|error)\b/i.test(tail)) words = "失败";
  else if (/\b(stopp?ed|killed|cancell?ed|interrupted|timed out)\b/i.test(tail)) words = /timed out/i.test(tail) ? "超时" : "已停止";
  else if (/\bcompleted?\b|\bfinished\b|\bsucceeded\b|\bdone\b/i.test(tail)) words = "已完成";
  else words = STATUS_WORDS[status];
  return code !== undefined ? `${words}（退出码 ${code}）` : words;
}

/**
 * The notice's one-line Chinese text: 后台命令「构建」已完成（退出码 0）. A foreground notice keeps the command's own
 * description; Paseo's fallbacks ("Background task completed", "Background task notification") get fixed words.
 */
export function noticeTextZh(notice: Pick<TaskNotice, "summary" | "status" | "background">): string {
  const summary = notice.summary.trim();
  const quoted = /^Background (command|task|agent|job)\s+["“](.+?)["”]\s*(.*)$/is.exec(summary);
  if (quoted) {
    const noun = quoted[1]!.toLowerCase() === "command" ? "后台命令" : quoted[1]!.toLowerCase() === "agent" ? "后台 Agent" : "后台任务";
    return `${noun}「${quoted[2]}」${tailZh(quoted[3] ?? "", notice.status)}`;
  }
  if (/^Background task notification$/i.test(summary)) return "后台任务通知";
  if (/^Background (task|command)\b/i.test(summary)) return `后台任务${tailZh(summary, notice.status)}`;
  if (!summary) return `后台任务${STATUS_WORDS[notice.status]}`;
  return summary;
}
