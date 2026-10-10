import assert from "node:assert/strict";
import test from "node:test";
import { finalReplyAfter, finalReplyText, replyAsksUser } from "../shared/reply";
import type { TimelineRow } from "../shared/timeline";

test("replies that hand the next step to the user are 待回复", () => {
  for (const text of [
    "issue 已经提了，状态 todo。\n\n代码还没改。要不要接着在文档仓库提修复 MR？上次悬着的规则也可以一起改，再跟 !56 一起发布。",
    "**Two ways to find which process it is; either works:**\n\n1. Quickest: stop the local server, then reload the page.\n2. Right after the error appears, run this in a terminal. Send me the output:\n   ```\n   ps -axo pid=,command=\n   ```",
    "**这件事到此结束了。**\n\n- 1.0.54 在两个环境都跑着。\n\n等预发布环境的两个凭据下来告诉我，我合 !59 再发 1.0.55。",
    "Migration done and verified.\n\nShould I also drop the old tables?",
    "改好了，两个环境都验过。\n\n先发预发布环境吧？",
    "测试都过了。发版前需要你确认一下窗口，我再继续。",
    "方案 A 更稳，方案 B 更快。你来决定用哪个。",
  ]) assert.equal(replyAsksUser(text), true, text);
});

test("finished reports, monitoring notes and rhetorical questions are not 待回复", () => {
  for (const text of [
    "两个环境都已经在跑 1.0.39。\n\n**需要知道的**\n- 新指标只对发布后的运行有。\n- 本地预览服务已经关掉。\n\nMR：[!52](https://code.example/mr/52) · [!53](https://code.example/mr/53)",
    "两个看板都部署好了。\n\n- **如果你打不开**：多半是网络问题，不是部署有问题。\n\n链接和更新方法已经写进 README 了。",
    "12:12 检查，两台都正常。\n\n下次大约 13:05 看。那时调度程序会自动接上，我到时确认一下。",
    "为什么会超时？因为上游接口限流，重试后已经恢复。",
    "修好了：\n```\nconst ok = ready ? \"是否继续？\" : null;\n```",
    "用户问「为什么要重启？」，原因是配置变了，已经处理。",
    "My recommendation: release on 10.9. It's your call.\n\nI only read the chat, the screenshot and the policy, and saved these findings to memory.",
    "服务已经重启。不需要回填的话可以在 .env 里加 BACKFILL=false 后再重启。",
    "",
  ]) assert.equal(replyAsksUser(text), false, text);
});

test("the final reply is the closing assistant message of the turn, after the latest user message", () => {
  assert.equal(finalReplyText([{ type: "user_message", text: "修一下" }, { type: "tool_call", name: "Edit" }, { type: "assistant_message", text: "改好了，" },
    { type: "assistant_message", text: "要不要发版？" }, { type: "reasoning", text: "done" }]), "改好了，要不要发版？");
  assert.equal(finalReplyText([{ type: "assistant_message", text: "先看看" }, { type: "tool_call", name: "Bash" }]), null);
  assert.equal(finalReplyText([]), null);
  const row = (seq: number, item: TimelineRow["item"], timestamp: string): TimelineRow => ({ key: String(seq), epoch: "e", seqStart: seq, seqEnd: seq, timestamp, item });
  const rows = [row(1, { type: "user_message", text: "继续" }, "2026-09-23T10:00:00Z"), row(2, { type: "tool_call", name: "Bash" }, "2026-09-23T10:01:00Z"),
    row(3, { type: "assistant_message", text: "发完了。" }, "2026-09-23T10:05:00Z"), row(4, { type: "notification", message: "x" }, "2026-09-23T10:05:01Z")];
  assert.deepEqual(finalReplyAfter(rows, Date.parse("2026-09-23T10:00:00Z")), { at: "2026-09-23T10:05:00.000Z", text: "发完了。" });
  assert.equal(finalReplyAfter(rows, Date.parse("2026-09-23T10:06:00Z")), null, "a reply older than the latest message answers an earlier turn");
  assert.equal(finalReplyAfter(rows.slice(0, 2), 0), null, "a turn that ended on a tool call has no final reply");
});
