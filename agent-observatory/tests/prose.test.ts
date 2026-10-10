import assert from "node:assert/strict";
import test from "node:test";
import { proseBlocks, proseTokens } from "../shared/prose";

test("replies split into headings, paragraphs, nested lists and quotes", () => {
  const blocks = proseBlocks("## 巡检结论\n\n- 服务健康\n  - P99 182 ms\n  继续观察\n1. 跑测试\n2) 提 MR\n\n> 来自定时任务\n\n普通段落\n第二行");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 2, text: "巡检结论" },
    { kind: "list", items: [{ marker: "•", depth: 0, text: "服务健康" }, { marker: "•", depth: 1, text: "P99 182 ms\n继续观察" }, { marker: "1.", depth: 0, text: "跑测试" }, { marker: "2.", depth: 0, text: "提 MR" }] },
    { kind: "quote", text: "来自定时任务" },
    { kind: "paragraph", text: "普通段落\n第二行" },
  ]);
});

test("inline code, bold and links; Chinese punctuation stays outside a bare link; only http(s) becomes a link", () => {
  assert.deepEqual(proseTokens("修复 MR：https://gitlab.example.com/a/b/-/merge_requests/12。另见 [PR](https://github.com/o/r/pull/34)，`npm test` **通过**，javascript:alert(1)"), [
    { kind: "text", text: "修复 MR：" }, { kind: "link", text: "https://gitlab.example.com/a/b/-/merge_requests/12", url: "https://gitlab.example.com/a/b/-/merge_requests/12" },
    { kind: "text", text: "。另见 " }, { kind: "link", text: "PR", url: "https://github.com/o/r/pull/34" }, { kind: "text", text: "，" },
    { kind: "code", text: "npm test" }, { kind: "text", text: " " }, { kind: "bold", text: "通过" }, { kind: "text", text: "，javascript:alert(1)" },
  ]);
  assert.deepEqual(proseTokens("plain"), [{ kind: "text", text: "plain" }]);
});
