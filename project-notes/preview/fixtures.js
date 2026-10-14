// In-memory stand-in for the plugin server: realistic synthetic notes and the same RPC semantics as
// server/store.ts, server/dashboard.ts and server/launch.ts (revisions, expectedRevision, request replay,
// launch stages). `?scenario=` switches failure and timing modes. Every call is logged to __notesCalls.
export const NOW = Date.parse("2026-09-23T15:00:00Z");
const minutes = value => new Date(NOW - value * 60_000).toISOString();
const hours = value => minutes(value * 60);
const days = value => minutes(value * 1440);
const scenario = new URLSearchParams(location.search).get("scenario") ?? "";
globalThis.__notesCalls = [];

const projects = [
  { id: "__inbox__", name: "随手记", path: "暂不归入项目的想法" },
  { id: "prj_web", name: "web-app", path: "/home/user/projects/web-app", kind: "git" },
  { id: "prj_checkout", name: "checkout-service", path: "/home/user/projects/checkout-service", kind: "git" },
  { id: "prj_release", name: "release-pipeline", path: "/home/user/projects/release-pipeline", kind: "git" },
  { id: "prj_monitor", name: "infra-monitor", path: "/home/user/infra-monitor", kind: "directory" },
  { id: "prj_docs", name: "design-docs", path: "/home/user/projects/design-docs", kind: "git" },
  { id: "prj_retired_7f3a9c21", name: "历史项目 · 7f3a9c21", path: "项目已移除，手记仍保留" },
];

let sequence = 0;
const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
function note(projectId, kind, title, body, { status = "todo", high = false, pinned = false, updated = hours(1), created, deleted = null } = {}) {
  return { id: id(), projectId, revision: 1, kind, title, body, status, priority: high ? "high" : "normal", pinned, createdAt: created ?? updated, updatedAt: updated, deletedAt: deleted };
}

const seed = [
  note("prj_web", "task", "弱网时给购物车加上重试提示", "手机网络差时提交偶尔 30 秒超时，界面只显示「同步中断」。\n\n- 超时后保留购物车内容\n- 顶部一行提示 + 重试\n- 不要自动重复提交", { high: true, pinned: true, updated: hours(2) }),
  note("prj_web", "task", "整理 2.0 迁移后的发布清单", "列出各个包的版本号、CHANGELOG，以及需要在真机上核对的流程。", { updated: days(1) }),
  note("prj_checkout", "task", "复核 checkout-service 压测报告", "对比 9 月 18 日与 9 月 20 日两次压测的 P99，确认连接池调整是否生效。", { high: true, updated: days(3) }),
  note("__inbox__", "task", "从随手记里挑三条想法转成任务", "", { updated: days(2) }),
  note("prj_release", "task", "排查 release-pipeline 夜间构建偶发失败", "失败都发生在拉取镜像阶段，怀疑是镜像仓库限流。先补日志，再看重试策略。", { status: "doing", updated: minutes(40) }),
  note("prj_monitor", "task", "重写 infra-monitor 的告警分级", "P0 直接电话，P1 发到值班群，P2 只进日报。", { status: "doing", pinned: true, updated: hours(5) }),
  note("prj_release", "task", "v2.4 发版与回滚演练", "", { status: "done", updated: days(4) }),
  note("prj_web", "task", "修复商品网格在 iPad 横屏下的列宽", "三列在 1024 px 宽时被挤压，商品标题只剩一行。", { status: "done", updated: days(6) }),
  note("prj_web", "task", "补齐 CLI 的 --json 输出文档", "", { status: "done", updated: days(8) }),
  note("__inbox__", "prompt", "代码评审：只看正确性", "请只评审这次改动的正确性问题：\n1. 找出会导致错误结果、崩溃或数据丢失的具体场景；\n2. 每条给出触发输入、实际结果与期望结果；\n3. 不要提风格、命名或可读性建议；\n4. 没有把握的问题标注「待确认」。", { pinned: true, updated: days(5) }),
  note("prj_web", "prompt", "写一条 CHANGELOG", "根据下面的 diff 写一条面向用户的中文 CHANGELOG：先说用户能感受到的变化，再说兼容性影响；不超过 3 行，不要出现内部函数名。", { updated: days(1) }),
  note("prj_monitor", "prompt", "排查线上告警", "你是值班工程师。先确认影响面（哪些服务、多少请求、从何时开始），再给出最可能的三个原因和各自的验证命令。只做只读操作，不要改配置。", { high: true, updated: hours(3) }),
  note("__inbox__", "prompt", "把会议纪要整理成待办", "把下面的纪要整理成待办清单：每条以动词开头，写明负责人和截止日期；无法确定的负责人写「待定」。", { updated: days(9) }),
  note("prj_checkout", "prompt", "生成 k6 压测脚本", "用 k6 写一个压测脚本：阶梯加压到 800 RPS，持续 10 分钟，记录 P50 / P95 / P99 与错误率，结果输出为 JSON。", { updated: days(12) }),
  note("prj_web", "idea", "购物车支持拖拽排序", "桌面端拖拽调整顺序；手机端长按进入排序模式。", { high: true, updated: hours(6) }),
  note("__inbox__", "idea", "提示词支持变量占位", "例如 {{diff}}、{{branch}}，复制时弹出一个小表单填值。", { updated: days(1) }),
  note("__inbox__", "idea", "每周五自动汇总已完成任务", "生成一段周报草稿，按项目分组，附上对应的 Agent 会话链接。", { updated: days(3) }),
  note("prj_monitor", "idea", "告警与任务联动", "P0 告警自动在 infra-monitor 下建一条待办，恢复后自动完成。", { updated: days(7) }),
  note("prj_retired_7f3a9c21", "idea", "旧仓库的迁移备忘", "迁移前导出 issue 标签与里程碑。", { updated: days(40) }),
  note("prj_web", "task", "旧版购物车的拖拽实验", "用 PanResponder 做的原型，手机上和滚动手势冲突，先放弃。", { updated: days(10), deleted: days(2) }),
  note("__inbox__", "idea", "给每个项目配一张封面图", "", { updated: days(5), deleted: days(1) }),
  note("prj_docs", "prompt", "英文周报模板", "Summarize this week's progress in three bullet points…", { updated: days(20), deleted: days(7) }),
];

const boards = new Map();
function board(projectId) {
  let value = boards.get(projectId);
  if (!value) { value = { projectId, revision: 0, items: [] }; boards.set(projectId, value); }
  return value;
}
if (scenario !== "empty") for (const item of seed) { const target = board(item.projectId); target.items.push(item); target.revision = Math.max(target.revision, 1); }
if (scenario === "many") {
  const kinds = ["task", "prompt", "idea"], statuses = ["todo", "doing", "done"];
  for (let index = 0; index < 180; index++) {
    const project = projects[1 + (index % 5)].id, kind = kinds[index % 3];
    board(project).items.push(note(project, kind, `批量条目 ${index + 1}：${kind === "task" ? "检查一个较长的任务标题在两行内如何截断，并确认卡片高度保持一致" : kind === "prompt" ? "常用提示词" : "一个想法"}`, "正文第一行，说明背景。\n第二行补充细节，用来确认摘要只显示一到两行。", { status: statuses[Math.floor(index / 3) % 3], updated: minutes(index * 37) }));
  }
}

let revisionCounter = 1;
const snapshot = value => structuredClone({ projectId: value.projectId, revision: value.revision, items: value.items });
const receipts = new Map();
const histories = new Map();
const launches = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let dashboardCount = 0;

const providers = [
  { id: "claude", label: "Claude Code", status: "ready", error: null, defaultModeId: "default",
    models: [{ id: "opus-5.5", label: "Opus 5.5", isDefault: true, thinkingOptions: [{ id: "low", label: "低" }, { id: "medium", label: "中" }, { id: "high", label: "高" }], defaultThinkingOptionId: "medium" },
      { id: "sonnet-5", label: "Sonnet 5", isDefault: false, thinkingOptions: [], defaultThinkingOptionId: null }],
    modes: [{ id: "default", label: "默认" }, { id: "acceptEdits", label: "自动接受编辑" }, { id: "plan", label: "计划模式" }] },
  { id: "codex", label: "Codex", status: "ready", error: null, defaultModeId: "auto",
    models: [{ id: "gpt-5.5", label: "GPT-5.5", isDefault: true, thinkingOptions: [{ id: "medium", label: "中" }, { id: "high", label: "高" }], defaultThinkingOptionId: "medium" }],
    modes: [{ id: "auto", label: "自动" }, { id: "read-only", label: "只读" }] },
  { id: "opencode", label: "OpenCode", status: "unavailable", error: "找不到 opencode 命令，请先在这台主机上安装。", models: [], modes: [], defaultModeId: null },
];
const profiles = [
  { id: "review", name: "代码评审", provider: "claude", model: "opus-5.5", modeId: "default", thinkingOptionId: "high" },
  { id: "quick-fix", name: "快速修复", provider: "codex", model: "gpt-5.5", modeId: null, thinkingOptionId: null },
];
function progress(launch) {
  const stages = scenario === "launch-hold" ? ["creating_workspace", "workspace_ready", "creating_agent"] : ["creating_workspace", "workspace_ready", "creating_agent", "agent_ready", "sending", "started"];
  let index = 0;
  const step = () => {
    if (scenario === "launch-reject") { Object.assign(launch, { stage: "rejected", error: "所选 provider 当前不可用，请刷新模型列表。尚未创建工作区或代理，可以修改选项后重试。" }); return; }
    const stage = stages[index++];
    if (!stage) return;
    launch.stage = stage;
    if (stage === "workspace_ready") launch.workspaceId = "wks_5d2f8a41c7e9";
    if (stage === "agent_ready") launch.agentId = "agent_0f41c9d2";
    setTimeout(step, 450);
  };
  setTimeout(step, 450);
}

export async function call(method, input) {
  globalThis.__notesCalls.push({ method, input: structuredClone(input) });
  await wait(scenario === "slow" && method === "project-notes.dashboard" ? 3_600_000 : scenario === "slow-write" && method === "project-notes.write" ? 1_500 : 60);
  switch (method) {
    case "project-notes.prompt.environment": return { languages: input.projectId === "__inbox__" ? [] : ["TypeScript"], testCommands: input.projectId === "__inbox__" ? [] : ["npm run test"], notices: [] };
    case "project-notes.history": return { versions: structuredClone(histories.get(input.itemId) ?? []), missing: false, missingCount: 0, itemRevision: board(input.projectId).items.find(item => item.id === input.itemId)?.revision ?? 1 };
    case "project-notes.dashboard": {
      dashboardCount++;
      if (scenario === "error") throw new Error("连接主机超时，请检查网络后重试。");
      if (scenario === "stale" && dashboardCount > 1) throw new Error("网络已断开");
      const revision = `rev-${revisionCounter}`;
      if (input.revision === revision && !input.refreshProjectIds?.length) return { unchanged: true, revision };
      return { ...(input.revision ? { mode: "delta", baseRevision: input.revision } : { mode: "full" }), revision, projects, boards: [...boards.values()].map(snapshot) };
    }
    case "project-notes.write": {
      if (scenario === "write-error") throw new Error("这条记录已在另一台设备更新。你的草稿仍保留，请刷新记录后重新编辑。");
      const target = board(input.projectId), operation = input.operation, hash = JSON.stringify(operation);
      const receipt = receipts.get(input.requestId);
      if (receipt) {
        if (receipt.hash !== hash) throw new Error("请求标识已用于另一项修改，请刷新后重试。");
        return { board: snapshot(target), itemId: receipt.itemId, replayed: true };
      }
      const now = new Date().toISOString();
      let itemId;
      if (operation.type === "create") {
        itemId = crypto.randomUUID();
        target.items.unshift({ ...operation.fields, id: itemId, projectId: input.projectId, revision: 1, createdAt: now, updatedAt: now, deletedAt: null });
      } else if (operation.type === "emptyTrash") {
        if (target.revision !== operation.expectedRevision) throw new Error("回收站已在另一台设备更新，请刷新后重新确认。");
        for (const item of target.items.filter(item => item.deletedAt)) histories.delete(item.id);
        target.items = target.items.filter(item => !item.deletedAt); itemId = "";
      } else {
        itemId = operation.id;
        const index = target.items.findIndex(item => item.id === operation.id);
        if (index < 0) throw new Error("这条记录已不存在，请刷新。");
        const existing = target.items[index];
        if (existing.revision !== operation.expectedRevision) throw new Error("这条记录已在另一台设备更新。你的草稿仍保留，请刷新记录后重新编辑。");
        if (operation.type !== "restore" && operation.type !== "purge" && existing.deletedAt) throw new Error("这条记录已在回收站，请先恢复。");
        if (operation.type === "restore" && !existing.deletedAt) throw new Error("这条记录已经恢复，请刷新。");
        if (operation.type === "purge") {
          if (!existing.deletedAt) throw new Error("请先把这条记录移入回收站。");
          target.items.splice(index, 1); histories.delete(existing.id);
        } else {
          const history = histories.get(existing.id) ?? [];
          const restored = operation.type === "restoreVersion" ? history.find(version => version.revision === operation.revision) : null;
          if (operation.type === "restoreVersion" && !restored) throw new Error("这个修改快照已不存在，请刷新。");
          const changes = operation.type === "update" ? operation.fields : operation.type === "repairHistory" ? {} : restored ? { kind: restored.kind, title: restored.title, body: restored.body, status: restored.status, priority: restored.priority, pinned: restored.pinned } : { deletedAt: operation.type === "delete" ? now : null };
          if (["title", "body", "kind"].some(key => key in changes && changes[key] !== existing[key])) {
            history.push({ kind: existing.kind, title: existing.title, body: existing.body, status: existing.status, priority: existing.priority, pinned: existing.pinned, revision: existing.revision, updatedAt: existing.updatedAt, deletedAt: existing.deletedAt });
            histories.set(existing.id, history.slice(-10));
          }
          target.items[index] = { ...existing, ...changes, historyCount: histories.get(existing.id)?.length ?? 0, revision: existing.revision + 1, updatedAt: now };
        }
      }
      target.revision++; revisionCounter++;
      receipts.set(input.requestId, { hash, itemId });
      return { board: snapshot(target), itemId, replayed: false };
    }
    case "project-notes.launch-options": {
      const launchable = projects.filter(project => project.kind).map(({ id: projectId, name, path, kind }) => ({ id: projectId, name, path, kind }));
      const project = launchable.find(value => value.id === input.projectId) ?? null;
      if (scenario === "options-error" && project) throw new Error("读取代理选项超时，请稍后重新读取。");
      return project ? { projects: launchable, project, providers, profiles } : { projects: launchable, project: null, providers: [], profiles: [] };
    }
    case "project-notes.launch": {
      const existing = launches.get(input.launchId);
      if (existing) return { ...existing, replayed: true };
      const launch = { launchId: input.launchId, stage: "prepared", workspaceId: null, agentId: null, error: null };
      launches.set(input.launchId, launch);
      progress(launch);
      return { ...launch, replayed: false };
    }
    case "project-notes.launch-status": {
      const launch = launches.get(input.launchId);
      return launch ? { ...launch, replayed: true } : null;
    }
    default: throw new Error(`未模拟的 RPC：${method}`);
  }
}
