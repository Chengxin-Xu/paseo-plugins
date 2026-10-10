import { describe, expect, it } from "vitest";
import { isForegroundNotice, noticeTextZh, readTaskNotice } from "./notice";

const notice = (label: string, status = "completed", metadata: Record<string, unknown> = {}) => ({
  name: "task_notification",
  status,
  detail: { type: "plain_text", label, icon: "wrench", text: label },
  metadata: { synthetic: true, source: "claude_task_notification", taskId: "b1x", toolUseId: "toolu_1", status, outputFile: "/tmp/b1x.output", ...metadata },
});

describe("Claude Code task notices", () => {
  it("reads Paseo's synthetic task_notification rows only", () => {
    expect(readTaskNotice({ name: "Bash", status: "completed", detail: { type: "shell" } })).toBeNull();
    expect(readTaskNotice({ ...notice("x"), metadata: { source: "other" } })).toBeNull();
    expect(readTaskNotice(notice("Probe the live web UI's route format without clicking"))).toEqual({
      ref: "toolu_1",
      taskId: "b1x",
      status: "completed",
      summary: "Probe the live web UI's route format without clicking",
      background: false,
      outputFile: "/tmp/b1x.output",
    });
  });

  it("tells a foreground timeout notice (a repeat of its command) from a background command", () => {
    expect(isForegroundNotice(readTaskNotice(notice("列出项目依赖")))).toBe(true);
    expect(isForegroundNotice(readTaskNotice(notice('Background command "构建" completed (exit code 0)')))).toBe(false);
    expect(isForegroundNotice(readTaskNotice({ ...notice("列出项目依赖"), metadata: { source: "claude_task_notification" } }))).toBe(false);
    expect(readTaskNotice(notice("x", "failed"))?.status).toBe("failed");
    expect(readTaskNotice(notice("x", "canceled"))?.status).toBe("canceled");
  });

  it("says it in Chinese", () => {
    const zh = (summary: string, status: "completed" | "failed" | "canceled" = "completed") =>
      noticeTextZh({ summary, status, background: /^background/i.test(summary) });
    expect(zh('Background command "后台构建" completed (exit code 0)')).toBe("后台命令「后台构建」已完成（退出码 0）");
    expect(zh('Background command "lint" failed with exit code 1', "failed")).toBe("后台命令「lint」失败（退出码 1）");
    expect(zh('Background command "dev server" was stopped', "canceled")).toBe("后台命令「dev server」已停止");
    expect(zh('Background agent "review" completed')).toBe("后台 Agent「review」已完成");
    expect(zh("Background task completed")).toBe("后台任务已完成");
    expect(zh("Background task failed", "failed")).toBe("后台任务失败");
    expect(zh("Background task notification")).toBe("后台任务通知");
    expect(zh("列出项目依赖")).toBe("列出项目依赖");
    expect(zh("")).toBe("后台任务已完成");
  });
});
